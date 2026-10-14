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
// mints real supply and should not need a dev toolchain to run or to audit.
//
// ── WHY THIS IS NOT A ONE-WAY DOOR, AND WHERE IT IS ────────────────────────
// `loadAirdropBatch` REVERTS on a duplicate recipient (`DuplicateRecipient`), so
// an address can be allocated exactly once, ever. A wrong AMOUNT cannot be
// corrected and a wrong ADDRESS cannot be reclaimed — the allocation simply
// exists and vests to whoever holds that key. So the plan step below prints
// every entry and refuses to proceed on anything it can check: bad addresses,
// zero amounts, duplicates within the file, addresses already allocated on
// chain, and a total that would exceed the cap.
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
// ── VESTING, SO THE NUMBERS ARE NOT A SURPRISE ────────────────────────────
// A SIXTH of every allocation is claimable at once. The rest vests LINEARLY
// from `airdropStart` (the SatoriAirdrop deploy timestamp, an immutable) over
// AIRDROP_VEST = 1825 days (5 years). Loading does not mint anything: it
// records an entitlement whose drip has been running since deployment, so a
// batch loaded on day 100 is immediately a sixth plus ~2.7% of the rest. That
// is intended, the clock is genesis and not the load, but it surprises people,
// so it is printed.
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
  'function airdropClaimedTotal() view returns (uint256)',
  'function airdropStart() view returns (uint256)',
  'function AIRDROP_TOTAL_SUPPLY() view returns (uint256)',
  'function airdropAuthority() view returns (address)',
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

const VEST_SECONDS = 1825n * 24n * 3600n;
// One sixth of every allocation is claimable at once; the rest drips
// (docs/issues/airdrop-upfront-sixth.md). Mirrors SatoriAirdrop.airdropVested.
const vestedOf = (wei, elapsed) => {
  if (elapsed >= VEST_SECONDS) return wei;
  const upfront = wei / 6n;
  return upfront + ((wei - upfront) * elapsed) / VEST_SECONDS;
};

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

  const [admin, start, cap, claimedTotal] = await Promise.all([
    retry(() => airdrop.airdropAuthority()),
    retry(() => airdrop.airdropStart()),
    retry(() => airdrop.AIRDROP_TOTAL_SUPPLY()),
    retry(() => airdrop.airdropClaimedTotal()),
  ]);

  // Already allocated on chain? loadAirdropBatch reverts the WHOLE batch on the
  // first duplicate, so one stale entry wastes the run. Cheaper to say so here.
  for (const e of entries) {
    const existing = await retry(() => airdrop.airdropAllocation(e.addr));
    if (existing > 0n) {
      problems.push(`already allocated ${ethers.formatEther(existing)} SATORI: ${e.addr}`);
    }
  }

  const total = entries.reduce((a, e) => a + e.wei, 0n);
  const now = BigInt((await retry(() => provider.getBlock('latest'))).timestamp);
  const elapsed = now - BigInt(start);
  const vestedPct = elapsed >= VEST_SECONDS ? 1 : Number(elapsed) / Number(VEST_SECONDS);

  console.log(`\n  airdrop        ${airdropAddr}`);
  console.log(`  loader         ${admin}`);
  console.log(`  cap            ${ethers.formatEther(cap)} SATORI`);
  console.log(`  claimed so far ${ethers.formatEther(claimedTotal)} SATORI`);
  console.log(`  vest clock     ${(Number(elapsed) / 86400).toFixed(2)} of 1825 days ` +
              `(a sixth of any allocation, plus ${(vestedPct * 100).toFixed(4)}% of the rest, is claimable immediately)\n`);

  console.log(`  batch: ${entries.length} recipient(s), ${ethers.formatEther(total)} SATORI total`);
  for (const e of entries) {
    const immediate = vestedOf(e.wei, elapsed);
    console.log(`    ${e.addr}  ${ethers.formatEther(e.wei)}  ` +
                `(~${ethers.formatEther(immediate)} claimable at once)`);
  }

  if (total + claimedTotal > cap) {
    problems.push(`batch total exceeds the remaining cap ` +
      `(${ethers.formatEther(total)} + ${ethers.formatEther(claimedTotal)} > ${ethers.formatEther(cap)})`);
  }

  if (problems.length) {
    console.error(`\n  REFUSING TO PROCEED — ${problems.length} problem(s):`);
    for (const p of problems) console.error(`    - ${p}`);
    process.exit(1);
  }
  console.log('\n  checks passed: addresses valid, no duplicates, none already allocated, cap respected.');

  const iface = new ethers.Interface(AIRDROP_ABI);
  const data = iface.encodeFunctionData('loadAirdropBatch',
    [entries.map((e) => e.addr), entries.map((e) => e.wei)]);

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
    ? '\n  all allocations present.'
    : `\n  ${bad} still absent after 90s — the inner call reverted (check the Safe's ExecutionSuccess vs the revert selector).`);
  if (bad) process.exit(1);
}

main().catch((e) => { console.error('\n  ERR:', e.shortMessage ?? e.message); process.exit(1); });
