#!/usr/bin/env node
// Load a batch of airdrop allocations, through the airdrop loader
// (`SatoriAirdrop.airdropAuthority`).
//
//   node scripts/load-airdrop.js batch.json [more.json …]    # plan + check
//   LOAD=1 node scripts/load-airdrop.js batch.json [more.json …]   # send them, in order
//   LOAD=1 HAND_BACK_TO=<safe> node scripts/load-airdrop.js …  # then hand the loader to the Safe
//
// A file whose every row is already on chain with the same amount is skipped, so
// an interrupted multi-file run is resumed by running it again.
//
// batch.json is the same shape merkle-drop.js takes:
//
//   { "0xabc…": "1000", "0xdef…": "250.5" }        amounts in SATORI, not wei
//
// Standalone node rather than a hardhat task, matching publish-root.js: this
// writes allocations that become real supply once claimed, and should not need
// a dev toolchain to run or to audit.
//
// ── WHY THIS IS NOT A ONE-WAY DOOR, AND WHERE IT IS ────────────────────────
// `loadAirdropBatch` REVERTS on a duplicate recipient (`DuplicateRecipient`), so
// an address can be allocated exactly once, ever. A wrong AMOUNT cannot be
// corrected and a wrong ADDRESS cannot be reclaimed in this contract — the
// allocation simply exists and pays whoever holds that key. The only way back is
// a corrected SatoriAirdrop and `token.setAirdrop`, and an allocation is
// claimable the block it lands, so it may already be paid by then. So the plan
// step prints every entry and refuses to proceed on anything it can check: bad
// addresses, zero amounts, duplicates within the file, addresses already
// allocated on chain, a total that would take the loaded table past the cap
// (the contract refuses it too), a finalized table, and a contract the token
// does not point at.
//
// ── HOW IT GETS SENT ──────────────────────────────────────────────────────
// `loadAirdropBatch` is loader-only and after handoff the loader is a Safe. Two
// modes, the second being the real one:
//
//   * SIGNER_KEYS set and those keys are Safe owners: assembles and sends the
//     Safe transaction directly. Convenient on a testnet where one person holds
//     every key. NOT how a real load should work.
//   * Otherwise it prints the transaction for the owners to execute in the Safe
//     UI, and stops.
//
// ── WHO LOADS ─────────────────────────────────────────────────────────────
// One batch per Safe signing round is too many for a snapshot (55 batches), so
// the loader is a single key while loading: the deployer from deploy.js until
// handoff.js moves it to the Safe, or, for a later load, a key the Safe appoints
// with `setAirdropAuthority(key)`, handed back with HAND_BACK_TO.
//
// ── WHEN IT PAYS ───────────────────────────────────────────────────────────
// At once: every allocation is claimable in full from the block its batch lands
// in. Load batches whenever addresses arrive. `finalizeAirdropLoading()` (the
// loader) closes loading for good, once the last batch is in
// (docs/issues/airdrop-claim-at-finalize.md).
const fs = require('fs');
const path = require('path');

function loadEthers() {
  for (const p of ['ethers', path.join(__dirname, '..', 'node_modules', 'ethers'),
                   path.join(__dirname, '..', '..', 'node_modules', 'ethers')]) {
    try { return require(p); } catch { /* next */ }
  }
  console.error('ethers not found'); process.exit(1);
}
const { ethers } = loadEthers();

const AIRDROP_ABI = [
  'function loadAirdropBatch(address[] recipients, uint256[] amounts)',
  'function airdropAllocation(address) view returns (uint256)',
  'function claimableAirdrop(address) view returns (uint256)',
  'function airdropLoadedTotal() view returns (uint256)',
  'function airdropLoadingFinalized() view returns (bool)',
  'function AIRDROP_TOTAL_SUPPLY() view returns (uint256)',
  'function airdropAuthority() view returns (address)',
  'function token() view returns (address)',
  'function setAirdropAuthority(address who)',
];
const TOKEN_ABI = [
  'function airdrop() view returns (address)',
];
const SAFE_ABI = [
  'function nonce() view returns (uint256)',
  'function getThreshold() view returns (uint256)',
  'function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) payable returns (bool)',
];
const SAFE_TX_TYPES = { SafeTx: [
  { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
  { name: 'data', type: 'bytes' }, { name: 'operation', type: 'uint8' },
  { name: 'safeTxGas', type: 'uint256' }, { name: 'baseGas', type: 'uint256' },
  { name: 'gasPrice', type: 'uint256' }, { name: 'gasToken', type: 'address' },
  { name: 'refundReceiver', type: 'address' }, { name: 'nonce', type: 'uint256' },
]};

const retry = async (fn, n = 6) => {
  for (let i = 0; i < n; i++) {
    try { return await fn(); }
    catch (e) {
      const m = String(e?.message ?? e);
      const transient = /rate limit|request limit|could not coalesce|429|too many requests|timeout|ETIMEDOUT|ECONNRESET|SERVER_ERROR|missing revert data/i.test(m);
      if (!transient || i === n - 1) throw e;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
    }
  }
};

// Bounded parallel reads: a snapshot is ~27,000 allocation reads.
async function mapLimit(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]); }
  }));
  return out;
}

async function main() {
  const files = process.argv.slice(2);
  if (!files.length) { console.error('usage: load-airdrop.js <batch.json> [more.json …]'); process.exit(1); }

  const rpc = process.env.RPC_URL || 'https://sepolia.base.org';
  const bookPath = process.env.ADDRESS_BOOK ||
    path.join(__dirname, '..', 'deployments', `${process.env.NETWORK || 'baseSepolia'}.json`);
  const book = JSON.parse(fs.readFileSync(bookPath, 'utf8'));
  const airdropAddr = process.env.AIRDROP_ADDRESS || book.addresses.airdrop;
  if (!airdropAddr) {
    console.error('  no `airdrop` address in the book — this stack predates SatoriAirdrop'); process.exit(1);
  }
  const handBackTo = process.env.HAND_BACK_TO ? ethers.getAddress(process.env.HAND_BACK_TO) : null;

  const provider = new ethers.JsonRpcProvider(rpc);
  await require('./chain-guard').requireChain(provider, book);
  const airdrop = new ethers.Contract(airdropAddr, AIRDROP_ABI, provider);

  const [admin, cap, tokenAddr] = await Promise.all([
    retry(() => airdrop.airdropAuthority()),
    retry(() => airdrop.AIRDROP_TOTAL_SUPPLY()),
    retry(() => airdrop.token()),
  ]);
  const token = new ethers.Contract(tokenAddr, TOKEN_ABI, provider);
  const [door, finalized] = await Promise.all([
    retry(() => token.airdrop()), retry(() => airdrop.airdropLoadingFinalized()),
  ]);
  if (finalized) {
    console.error('\n  REFUSING: loading is finalized, which closed the table for good; ' +
      'loadAirdropBatch reverts AirdropLoadingClosed.\n');
    process.exit(1);
  }
  // The token mints only through its `airdrop` pointer, so a table loaded into
  // any other contract (an abandoned one, say) can never be claimed.
  if (door.toLowerCase() !== airdropAddr.toLowerCase()) {
    console.error(`\n  REFUSING: token.airdrop is ${door}, not this contract; nothing loaded here can be claimed.\n`);
    process.exit(1);
  }

  console.log(`\n  airdrop        ${airdropAddr}`);
  console.log(`  loader         ${admin}`);
  console.log(`  cap            ${ethers.formatEther(cap)} SATORI`);
  console.log(`  files          ${files.length}`);

  const keys = (process.env.SIGNER_KEYS || '').split(',').map((k) => k.trim()).filter(Boolean);
  const adminIsContract = (await retry(() => provider.getCode(admin))) !== '0x';
  if (process.env.LOAD && !adminIsContract) {
    const w = keys[0] && new ethers.Wallet(keys[0]);
    if (!w || w.address.toLowerCase() !== admin.toLowerCase()) {
      console.error(`\n  SIGNER_KEYS[0] is ${w ? w.address : '(unset)'}, loader is ${admin}`); process.exit(1);
    }
  }
  if (handBackTo && adminIsContract) {
    console.error(`\n  HAND_BACK_TO is for a single-key loader; the loader ${admin} is a contract.`); process.exit(1);
  }

  for (const [i, file] of files.entries()) {
    console.log(`\n  ── ${i + 1}/${files.length}  ${file}`);
    const done = await loadFile(file, { provider, airdrop, airdropAddr, admin, cap, keys, adminIsContract });
    if (done === 'stop') return;
  }

  if (!handBackTo) return;
  if (!process.env.LOAD) {
    console.log(`\n  then: hand the loader to ${handBackTo} (setAirdropAuthority).\n`);
    return;
  }
  const w = new ethers.Wallet(keys[0], provider);
  await retry(() => airdrop.connect(w).setAirdropAuthority(handBackTo).then((t) => t.wait()));
  // Polled: a lagging node reads the old loader.
  const until = Date.now() + 90_000;
  let now = admin;
  while (Date.now() < until) {
    now = await retry(() => airdrop.airdropAuthority());
    if (now.toLowerCase() === handBackTo.toLowerCase()) break;
    await new Promise((r) => setTimeout(r, 3000));
  }
  if (now.toLowerCase() !== handBackTo.toLowerCase()) {
    console.error(`\n  the loader still reads ${now}, not ${handBackTo}.`); process.exit(1);
  }
  console.log(`\n  loader handed back to ${handBackTo}.\n`);
}

async function loadFile(file, { provider, airdrop, airdropAddr, admin, cap, keys, adminIsContract }) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));

  // ---- validate the file before touching the chain -----------------------
  const entries = [];
  const seen = new Set();
  const problems = [];
  for (const [addr, amt] of Object.entries(raw)) {
    if (!ethers.isAddress(addr)) { problems.push(`not an address: ${addr}`); continue; }
    const key = addr.toLowerCase();
    if (seen.has(key)) { problems.push(`listed twice in the file: ${addr}`); continue; }
    seen.add(key);
    let wei;
    try { wei = ethers.parseEther(String(amt)); }
    catch { problems.push(`unparseable amount for ${addr}: ${amt}`); continue; }
    if (wei <= 0n) { problems.push(`non-positive amount for ${addr}: ${amt}`); continue; }
    entries.push({ addr: ethers.getAddress(addr), wei });
  }

  // Already allocated on chain? loadAirdropBatch reverts the WHOLE batch on the
  // first duplicate, so one stale entry wastes the run. Cheaper to say so here.
  // A batch is atomic, so a file that is fully on chain with the same amounts is
  // one an earlier run loaded; anything in between is refused.
  const existing = await mapLimit(entries, 4, (e) => retry(() => airdrop.airdropAllocation(e.addr)));
  const already = entries.filter((e, j) => existing[j] > 0n);
  if (entries.length && already.length === entries.length &&
      entries.every((e, j) => existing[j] === e.wei) && !problems.length) {
    console.log(`  already loaded: ${entries.length} recipient(s), skipping.`);
    return 'skipped';
  }
  for (const e of already) {
    problems.push(`already allocated ${ethers.formatEther(existing[entries.indexOf(e)])} SATORI: ${e.addr}`);
  }

  const loadedTotal = await retry(() => airdrop.airdropLoadedTotal());
  const total = entries.reduce((a, e) => a + e.wei, 0n);

  console.log(`  loaded so far  ${ethers.formatEther(loadedTotal)} SATORI`);
  console.log(`  batch: ${entries.length} recipient(s), ${ethers.formatEther(total)} SATORI total`);
  if (process.env.VERBOSE || !process.env.LOAD) {
    for (const e of entries) console.log(`    ${e.addr}  ${ethers.formatEther(e.wei)}`);
  }

  if (total + loadedTotal > cap) {
    problems.push(`batch would take the table past the cap, and loadAirdropBatch would refuse it ` +
      `(${ethers.formatEther(total)} + ${ethers.formatEther(loadedTotal)} loaded > ${ethers.formatEther(cap)})`);
  }

  if (problems.length) {
    console.error(`\n  REFUSING TO PROCEED — ${problems.length} problem(s):`);
    for (const p of problems) console.error(`    - ${p}`);
    process.exit(1);
  }

  if (entries.length === 0) {
    console.log('  No rows: nothing to load.');
    return 'empty';
  }
  console.log('  checks passed: addresses valid, no duplicates, none already allocated, cap respected, ' +
    'token points here.');

  const iface = new ethers.Interface(AIRDROP_ABI);
  const data = iface.encodeFunctionData('loadAirdropBatch',
    [entries.map((e) => e.addr), entries.map((e) => e.wei)]);

  if (!process.env.LOAD) {
    console.log('  PLAN ONLY. To send:');
    console.log(`    to   ${airdropAddr}`);
    console.log(`    data ${data}`);
    console.log('    - execute that from the loader in the Safe UI,');
    console.log('    - or re-run with LOAD=1 (and SIGNER_KEYS if the loader is a Safe).');
    return 'planned';
  }

  if (adminIsContract && keys.length === 0) {
    console.log('\n  The loader is a contract (a Safe) and no SIGNER_KEYS were given.');
    console.log('  Execute the transaction above from the Safe UI.\n');
    return 'stop';
  }

  let receipt;
  if (!adminIsContract) {
    const w = new ethers.Wallet(keys[0], provider);
    receipt = await retry(() => w.sendTransaction({ to: airdropAddr, data }).then((t) => t.wait()));
    console.log(`  sent, block ${receipt.blockNumber}, gas ${receipt.gasUsed}, status ${receipt.status}`);
  } else {
    const safe = new ethers.Contract(admin, SAFE_ABI, provider);
    const [nonce, threshold, net] = await Promise.all([
      retry(() => safe.nonce()), retry(() => safe.getThreshold()), provider.getNetwork(),
    ]);
    const tx = {
      to: airdropAddr, value: 0n, data, operation: 0,
      safeTxGas: 0n, baseGas: 0n, gasPrice: 0n,
      gasToken: ethers.ZeroAddress, refundReceiver: ethers.ZeroAddress, nonce,
    };
    const domain = { chainId: Number(net.chainId), verifyingContract: admin };
    // Safe requires signatures ordered by ascending signer address.
    const signers = keys.map((k) => new ethers.Wallet(k))
      .sort((a, b) => (a.address.toLowerCase() < b.address.toLowerCase() ? -1 : 1))
      .slice(0, Number(threshold));
    if (signers.length < Number(threshold)) {
      console.error(`\n  need ${threshold} signer keys, got ${signers.length}`); process.exit(1);
    }
    let sigs = '0x';
    for (const w of signers) sigs += (await w.signTypedData(domain, SAFE_TX_TYPES, tx)).slice(2);

    const relayer = new ethers.Wallet(process.env.RELAYER_KEY || keys[0], provider);
    const safeRw = safe.connect(relayer);
    receipt = await retry(() => safeRw.execTransaction(
      tx.to, tx.value, tx.data, tx.operation, tx.safeTxGas, tx.baseGas,
      tx.gasPrice, tx.gasToken, tx.refundReceiver, sigs).then((t) => t.wait()));
    console.log(`  sent by ${signers.length}-of-${threshold}, block ${receipt.blockNumber}, status ${receipt.status}`);
  }

  // Read it back. A Safe execTransaction emits ExecutionSuccess even when the
  // INNER call reverted, so a green receipt is not evidence the load happened.
  //
  // POLLED, not read once. A public RPC will serve a read from a node that has
  // not yet applied the block just mined, and a stale answer here is `0` — which
  // is indistinguishable from "the inner call reverted" and is exactly how the
  // first run of this script reported two FAILs on a load that had in fact
  // succeeded. `retry` cannot help: a stale read is not an error, it is a wrong
  // answer delivered successfully. Same lesson as scripts/live-reads-lib.js.
  const deadline = Date.now() + 90_000;
  let pending = entries;
  while (pending.length && Date.now() < deadline) {
    const got = await mapLimit(pending, 4, (e) => retry(() => airdrop.airdropAllocation(e.addr)));
    pending = pending.filter((e, j) => got[j] !== e.wei);
    if (pending.length) await new Promise((r) => setTimeout(r, 3000));
  }
  if (pending.length) {
    for (const e of pending) console.log(`    FAIL ${e.addr}`);
    console.log(`\n  ${pending.length} still absent after 90s — the inner call reverted ` +
      '(check the Safe\'s ExecutionSuccess vs the revert selector).');
    process.exit(1);
  }
  console.log(`  read back: all ${entries.length} allocations present and claimable now.`);

  // Polled, like the allocations above: a lagging node reads the old total.
  // `>=`, not `==`: a concurrent load can only add to it.
  const want = loadedTotal + total;
  let loadedNow = 0n;
  const until = Date.now() + 90_000;
  while (Date.now() < until) {
    loadedNow = await retry(() => airdrop.airdropLoadedTotal());
    if (loadedNow >= want) break;
    await new Promise((r) => setTimeout(r, 3000));
  }
  if (loadedNow < want) {
    console.log(`\n  the loaded total still reads ${loadedNow}, below ${want}.`);
  } else if (loadedNow > want) {
    console.log(`\n  WARNING: the loaded total is ${loadedNow}, more than this batch accounts for (${want}):` +
      ' something else changed the table. Check it.');
  }
  return 'loaded';
}

main().catch((e) => { console.error('\n  ERR:', e.shortMessage ?? e.message); process.exit(1); });
