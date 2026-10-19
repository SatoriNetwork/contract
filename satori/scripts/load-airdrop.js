#!/usr/bin/env node
// Load a batch of airdrop allocations, through the airdrop loader
// (`SatoriAirdrop.airdropAuthority`).
//
//   node scripts/load-airdrop.js batch.json                  # plan + check
//   LOAD=1 node scripts/load-airdrop.js batch.json           # send it
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
// a corrected SatoriAirdrop and `token.setAirdrop`, which works until
// `freezeAirdrop`; the abandoned contract cannot finalize while the token points
// elsewhere, and never can once the door is frozen on the corrected one. So the
// plan step prints every entry and refuses to proceed on anything it can check:
// bad addresses, zero amounts, duplicates within the file, addresses already
// allocated on chain, a total that would take the loaded table past the cap, a
// table the freeze has closed, and a contract the token does not point at.
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
// ── WHEN IT PAYS ───────────────────────────────────────────────────────────
// Loading mints nothing and opens nothing. The sequence is:
//   1. load every batch (this script, as the loader);
//   2. check the table on chain, for as long as that takes;
//   3. `token.freezeAirdrop(airdrop, loadedTotal)` (the freeze authority, with
//      the address and total it checked) closes the table and pins the door
//      here, both for good. The token refuses it if either has moved since, or
//      if the total is over the cap. Run this script with an empty batch `{}`
//      to print that call and its calldata for the table as it stands;
//   4. `finalizeAirdropLoading()` (the loader) opens claims.
// From that block every recipient can claim their whole allocation. Finalize
// reverts AirdropNotFrozen until step 3 is done, so the order cannot be
// swapped. Freeze only after the LAST batch is loaded and checked: from then
// on no entry can be added or fixed, and since the door can never be re-pointed
// after a freeze, a freeze before loading leaves this airdrop empty for good
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
  'function AIRDROP_TOTAL_SUPPLY() view returns (uint256)',
  'function airdropAuthority() view returns (address)',
  'function token() view returns (address)',
];
const TOKEN_ABI = [
  'function airdrop() view returns (address)',
  'function airdropFrozen() view returns (bool)',
  'function freezeAirdrop(address expectedAirdrop, uint256 expectedLoadedTotal)',
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
      const transient = /rate limit|429|too many requests|timeout|ETIMEDOUT|ECONNRESET|SERVER_ERROR|missing revert data/i.test(m);
      if (!transient || i === n - 1) throw e;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
    }
  }
};

async function main() {
  const file = process.argv[2];
  if (!file) { console.error('usage: load-airdrop.js <batch.json>'); process.exit(1); }
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));

  const rpc = process.env.RPC_URL || 'https://sepolia.base.org';
  const bookPath = process.env.ADDRESS_BOOK ||
    path.join(__dirname, '..', 'deployments', `${process.env.NETWORK || 'baseSepolia'}.json`);
  const book = JSON.parse(fs.readFileSync(bookPath, 'utf8'));
  const airdropAddr = process.env.AIRDROP_ADDRESS || book.addresses.airdrop;
  if (!airdropAddr) {
    console.error('  no `airdrop` address in the book — this stack predates SatoriAirdrop'); process.exit(1);
  }

  const provider = new ethers.JsonRpcProvider(rpc);
  const airdrop = new ethers.Contract(airdropAddr, AIRDROP_ABI, provider);

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

  const [admin, cap, loadedTotal, tokenAddr] = await Promise.all([
    retry(() => airdrop.airdropAuthority()),
    retry(() => airdrop.AIRDROP_TOTAL_SUPPLY()),
    retry(() => airdrop.airdropLoadedTotal()),
    retry(() => airdrop.token()),
  ]);
  const token = new ethers.Contract(tokenAddr, TOKEN_ABI, provider);
  const [door, frozen] = await Promise.all([
    retry(() => token.airdrop()), retry(() => token.airdropFrozen()),
  ]);
  // Finalize implies the freeze, so this one check also covers a finalized table.
  if (frozen) {
    console.error(`\n  REFUSING: the token's airdrop door is frozen (on ${door}), which closed the ` +
      'table for good. Nothing can be loaded into this or any other airdrop now; ' +
      'loadAirdropBatch reverts AirdropLoadingClosed.\n');
    process.exit(1);
  }
  // Finalize needs the token's door frozen on THIS contract, so a table loaded
  // into any other (an abandoned one, say) can never be claimed.
  if (door.toLowerCase() !== airdropAddr.toLowerCase()) {
    problems.push(`token.airdrop is ${door}, not this contract; finalize refuses until the token points here`);
  }

  // Already allocated on chain? loadAirdropBatch reverts the WHOLE batch on the
  // first duplicate, so one stale entry wastes the run. Cheaper to say so here.
  for (const e of entries) {
    const existing = await retry(() => airdrop.airdropAllocation(e.addr));
    if (existing > 0n) {
      problems.push(`already allocated ${ethers.formatEther(existing)} SATORI: ${e.addr}`);
    }
  }

  const total = entries.reduce((a, e) => a + e.wei, 0n);

  console.log(`\n  airdrop        ${airdropAddr}`);
  console.log(`  loader         ${admin}`);
  console.log(`  cap            ${ethers.formatEther(cap)} SATORI`);
  console.log(`  loaded so far  ${ethers.formatEther(loadedTotal)} SATORI\n`);

  console.log(`  batch: ${entries.length} recipient(s), ${ethers.formatEther(total)} SATORI total`);
  for (const e of entries) console.log(`    ${e.addr}  ${ethers.formatEther(e.wei)}`);

  if (total + loadedTotal > cap) {
    problems.push(`batch would take the table past the cap, and the freeze would refuse it ` +
      `(${ethers.formatEther(total)} + ${ethers.formatEther(loadedTotal)} loaded > ${ethers.formatEther(cap)})`);
  }

  if (problems.length) {
    console.error(`\n  REFUSING TO PROCEED — ${problems.length} problem(s):`);
    for (const p of problems) console.error(`    - ${p}`);
    process.exit(1);
  }

  const printFreeze = (t) => {
    console.log(`    token.freezeAirdrop(${airdropAddr}, ${t})   (${ethers.formatEther(t)} SATORI)`);
    console.log(`    to   ${tokenAddr}`);
    console.log(`    data ${token.interface.encodeFunctionData('freezeAirdrop', [airdropAddr, t])}`);
  };
  if (entries.length === 0) {
    console.log('\n  No rows: the freeze call for the table as it stands now. Check the table first;');
    console.log('  the freeze authority sends this, and the token refuses it if the table moves.');
    printFreeze(loadedTotal);
    console.log('');
    return;
  }
  console.log('\n  checks passed: addresses valid, no duplicates, none already allocated, cap respected, ' +
    'token points here.');

  const iface = new ethers.Interface(AIRDROP_ABI);
  const data = iface.encodeFunctionData('loadAirdropBatch',
    [entries.map((e) => e.addr), entries.map((e) => e.wei)]);

  console.log('\n  If this is the last batch, the freeze call once it lands is:');
  printFreeze(loadedTotal + total);

  if (!process.env.LOAD) {
    console.log('\n  PLAN ONLY. To send:');
    console.log(`    to   ${airdropAddr}`);
    console.log(`    data ${data}`);
    console.log('    - execute that from the loader in the Safe UI,');
    console.log('    - or re-run with LOAD=1 (and SIGNER_KEYS if the loader is a Safe).\n');
    return;
  }

  const keys = (process.env.SIGNER_KEYS || '').split(',').map((k) => k.trim()).filter(Boolean);
  const adminCode = await retry(() => provider.getCode(admin));
  const adminIsContract = adminCode !== '0x';

  if (adminIsContract && keys.length === 0) {
    console.log('\n  The loader is a contract (a Safe) and no SIGNER_KEYS were given.');
    console.log('  Execute the transaction above from the Safe UI.\n');
    return;
  }

  let receipt;
  if (!adminIsContract) {
    const w = new ethers.Wallet(keys[0], provider);
    if (w.address.toLowerCase() !== admin.toLowerCase()) {
      console.error(`\n  SIGNER_KEYS[0] is ${w.address}, loader is ${admin}`); process.exit(1);
    }
    receipt = await retry(() => w.sendTransaction({ to: airdropAddr, data }).then((t) => t.wait()));
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
    console.log(`\n  sent by ${signers.length}-of-${threshold}, block ${receipt.blockNumber}, status ${receipt.status}`);
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
  console.log('\n  reading allocations back:');
  const deadline = Date.now() + 90_000;
  const pending = new Map(entries.map((e) => [e.addr, e.wei]));
  const seenOk = new Set();
  while (pending.size > seenOk.size && Date.now() < deadline) {
    for (const [addr, want] of pending) {
      if (seenOk.has(addr)) continue;
      const got = await retry(() => airdrop.airdropAllocation(addr));
      if (got === want) seenOk.add(addr);
    }
    if (seenOk.size < pending.size) await new Promise((r) => setTimeout(r, 3000));
  }
  let bad = 0;
  for (const e of entries) {
    const ok = seenOk.has(e.addr);
    if (!ok) bad++;
    const got = await retry(() => airdrop.airdropAllocation(e.addr));
    console.log(`    ${ok ? 'ok  ' : 'FAIL'} ${e.addr}  ${ethers.formatEther(got)}`);
  }
  console.log(bad === 0
    ? '\n  all allocations present. Once the LAST batch is in and the whole table checks out, ' +
      'freeze (closes the table for good), then finalizeAirdropLoading.'
    : `\n  ${bad} still absent after 90s — the inner call reverted (check the Safe's ExecutionSuccess vs the revert selector).`);
  if (bad) process.exit(1);

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
    console.log(`\n  the loaded total still reads ${loadedNow}, below ${want}; run again with {} for the freeze call.`);
  } else {
    if (loadedNow > want) {
      console.log(`\n  WARNING: the loaded total is ${loadedNow}, more than this batch accounts for (${want}):` +
        ' something else changed the table. Check it again before the freeze.');
    }
    console.log('\n  freeze call for the table as it stands now:');
    printFreeze(loadedNow);
  }
}

main().catch((e) => { console.error('\n  ERR:', e.shortMessage ?? e.message); process.exit(1); });
