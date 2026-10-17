#!/usr/bin/env node
// Claim the airdrop ON BEHALF of everyone who is owed one, paying
// their gas. The one-time "welcome" sweep: tokens appear in people's wallets
// without them knowing the airdrop exists or holding any ETH.
//
//   node scripts/sweep-airdrop.js                                     # plan, every loaded recipient
//   node scripts/sweep-airdrop.js batch.json [batch2.json ...]        # plan, just these files
//   SWEEP=1 node scripts/sweep-airdrop.js [...]                       # send it
//
// With no files, the recipients are every `AirdropAllocated` log since the
// book's `deploymentBlock` (or START_BLOCK), scanned in CHUNK_BLOCKS ranges
// because both Base RPCs cap eth_getLogs at 2000 blocks. With files, it takes
// the same files load-airdrop.js took; amounts are ignored, only addresses matter.
//
// Standalone node rather than a hardhat task, matching load-airdrop.js and
// publish-root.js: this spends real ETH and should not need a dev toolchain to
// run or to audit.
//
// ── WHY THIS IS SAFE TO RUN, AND SAFE TO RE-RUN ────────────────────────────
// `claimAirdropFor` mints to the ADDRESS NAMED, never to the caller. There is
// no recipient argument to point somewhere else, so the worst a hostile caller
// achieves is paying gas to give someone else their own tokens. That is why the
// function is permissionless and why THIS SCRIPT NEEDS NO ADMIN KEY — any
// funded wallet can run it.
//
// `claimAirdropForMany` SKIPS anyone with nothing claimable instead of
// reverting, so one already-claimed address cannot fail a batch of a thousand,
// and an interrupted run is resumed by simply running it again.
//
// ── WHEN IT CAN RUN ────────────────────────────────────────────────────────
// Claims open CLAIM_DELAY (one day) after `finalizeAirdropLoading`, and each
// claim then pays the whole allocation (docs/issues/airdrop-claim-after-a-day.md).
// Before that every claim reverts ClaimsNotOpen, so the plan stops early.
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
  'function claimAirdropFor(address user)',
  'function claimAirdropForMany(address[] users) returns (uint256)',
  'function claimableAirdrop(address) view returns (uint256)',
  'function airdropAllocation(address) view returns (uint256)',
  'function airdropClaimedTotal() view returns (uint256)',
  'function claimsOpenAt() view returns (uint64)',
  'function AIRDROP_TOTAL_SUPPLY() view returns (uint256)',
  'event AirdropAllocated(address indexed recipient, uint256 amount)',
];

// Recipients per transaction. Each one is a storage read, a storage write and a
// mint, so the ceiling is the block gas limit rather than calldata. 200 is
// deliberately conservative: the plan step MEASURES the real cost with
// estimateGas before anything is sent, so a bad guess here is caught rather
// than discovered halfway through a run.
const CHUNK = Number(process.env.CHUNK || 200);

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
  const files = process.argv.slice(2);

  // ---- gather the recipient set from the load files ----------------------
  const addresses = [];
  const seen = new Set();
  const problems = [];
  for (const file of files) {
    let raw;
    try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (e) { problems.push(`unreadable ${file}: ${e.message}`); continue; }
    for (const addr of Object.keys(raw)) {
      if (!ethers.isAddress(addr)) { problems.push(`not an address in ${file}: ${addr}`); continue; }
      const key = addr.toLowerCase();
      // Across several load files a duplicate is expected rather than an error:
      // loading rejected it, so it exists once on chain. Just don't sweep twice.
      if (seen.has(key)) continue;
      seen.add(key);
      addresses.push(ethers.getAddress(addr));
    }
  }
  if (problems.length) {
    console.error('\n  PROBLEMS:');
    for (const p of problems) console.error(`    - ${p}`);
    console.error('\n  refusing to continue\n');
    process.exit(1);
  }

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

  if (!files.length) {
    const from = Number(process.env.START_BLOCK ?? book.deploymentBlock ?? 0);
    const head = await retry(() => provider.getBlockNumber());
    const step = Number(process.env.CHUNK_BLOCKS || 1900);
    process.stdout.write(`\n  scanning AirdropAllocated, blocks ${from}..${head}`);
    for (let lo = from; lo <= head; lo += step) {
      const hi = Math.min(lo + step - 1, head);
      const logs = await retry(() => airdrop.queryFilter(airdrop.filters.AirdropAllocated(), lo, hi));
      // A recipient is loaded once (DuplicateRecipient), so each address appears once.
      for (const l of logs) addresses.push(ethers.getAddress(l.args.recipient));
      if (((lo - from) / step) % 200 === 199) process.stdout.write('.');
    }
    console.log('');
  }

  const [opensAt, cap, claimedTotal, block] = await Promise.all([
    retry(() => airdrop.claimsOpenAt()),
    retry(() => airdrop.AIRDROP_TOTAL_SUPPLY()),
    retry(() => airdrop.airdropClaimedTotal()),
    retry(() => provider.getBlock('latest')),
  ]);

  console.log(`\n  airdrop        ${airdropAddr}`);
  console.log(`  recipients     ${addresses.length} unique, from ${files.length ? `${files.length} file(s)` : 'AirdropAllocated logs'}`);
  console.log(`  cap            ${ethers.formatEther(cap)} SATORI`);
  console.log(`  claimed so far ${ethers.formatEther(claimedTotal)} SATORI`);
  if (opensAt === 0n) {
    console.log('\n  loading is not finalized, so nothing is claimable yet.\n');
    return;
  }
  console.log(`  claims open    ${new Date(Number(opensAt) * 1000).toISOString()}\n`);
  if (BigInt(block.timestamp) < opensAt) {
    console.log('  claims are not open yet; run this again after that moment.\n');
    return;
  }

  // ---- who is actually owed something ------------------------------------
  // Filtering here is what makes a re-run cheap AND makes the plan honest: the
  // contract would skip these anyway, but we would have paid to find out.
  process.stdout.write('  checking claimable amounts');
  const owed = [];
  let owedTotal = 0n;
  let unallocated = 0;
  for (let i = 0; i < addresses.length; i++) {
    const a = addresses[i];
    const amount = await retry(() => airdrop.claimableAirdrop(a));
    if (amount > 0n) { owed.push(a); owedTotal += amount; }
    else {
      const alloc = await retry(() => airdrop.airdropAllocation(a));
      if (alloc === 0n) unallocated++;
    }
    if (i % 25 === 24) process.stdout.write('.');
  }
  console.log('\n');

  if (unallocated) {
    // Not fatal, but it means the load and the sweep disagree about who exists.
    console.log(`  ⚠ ${unallocated} address(es) have NO allocation on chain. Either the`);
    console.log(`    load never ran for them, or these files are not the ones loaded.\n`);
  }

  console.log(`  owed now       ${owed.length} address(es), ${ethers.formatEther(owedTotal)} SATORI total`);
  if (owed.length === 0) {
    console.log('\n  nothing to sweep — everyone is up to date.\n');
    return;
  }
  const chunks = [];
  for (let i = 0; i < owed.length; i += CHUNK) chunks.push(owed.slice(i, i + CHUNK));
  console.log(`  transactions   ${chunks.length} (${CHUNK} recipients per tx)\n`);

  // ---- price the run before spending anything ----------------------------
  // This is the whole point of the plan step: it is OUR ETH, not the Safe's,
  // and the number should be on screen before the decision rather than after.
  const key = process.env.SIGNER_KEY;
  const wallet = key ? new ethers.Wallet(key, provider) : null;
  const fee = await retry(() => provider.getFeeData());
  const gasPrice = fee.maxFeePerGas ?? fee.gasPrice ?? 0n;

  let totalGas = 0n;
  const from = wallet ? wallet.address : ethers.ZeroAddress;
  for (const chunk of chunks) {
    const est = await retry(() => airdrop.claimAirdropForMany.estimateGas(chunk, { from }));
    totalGas += est;
  }
  const costWei = totalGas * gasPrice;
  console.log(`  estimated gas  ${totalGas.toString()} units`);
  console.log(`  gas price      ${ethers.formatUnits(gasPrice, 'gwei')} gwei`);
  console.log(`  ESTIMATED COST ${ethers.formatEther(costWei)} ETH\n`);

  if (!wallet) {
    console.log('  SIGNER_KEY not set — plan only. Set it (and SWEEP=1) to send.\n');
    return;
  }
  const balance = await retry(() => provider.getBalance(wallet.address));
  console.log(`  sweeper        ${wallet.address}`);
  console.log(`  balance        ${ethers.formatEther(balance)} ETH`);
  if (balance < costWei) {
    console.error(`\n  INSUFFICIENT BALANCE — needs ~${ethers.formatEther(costWei)} ETH\n`);
    process.exit(1);
  }

  if (process.env.SWEEP !== '1') {
    console.log('\n  plan only. Re-run with SWEEP=1 to send.\n');
    return;
  }

  // ---- send ---------------------------------------------------------------
  const signer = airdrop.connect(wallet);
  let failed = 0;
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    process.stdout.write(`  tx ${i + 1}/${chunks.length} (${chunk.length} recipients) ... `);
    try {
      const tx = await signer.claimAirdropForMany(chunk);
      const rc = await tx.wait();
      console.log(`ok  ${rc.hash}  gas ${rc.gasUsed.toString()}`);
    } catch (e) {
      failed++;
      // One failed chunk must not abandon the rest: the others are independent,
      // and a re-run resumes anyway because paid addresses are skipped.
      console.log(`FAILED: ${String(e?.shortMessage ?? e?.message ?? e).slice(0, 120)}`);
    }
  }

  // Report the delta from the CHAIN rather than from what we think we sent.
  // `airdropClaimedTotal` is the contract's own counter, so it cannot flatter
  // the run: if a chunk silently paid less than planned, this shows it.
  const after = await retry(() => airdrop.airdropClaimedTotal());
  console.log(`\n  claimed total  ${ethers.formatEther(claimedTotal)} -> ${ethers.formatEther(after)} SATORI`);
  console.log(`  swept          ${ethers.formatEther(after - claimedTotal)} SATORI`);
  if (failed) {
    console.log(`\n  ⚠ ${failed} transaction(s) failed. Re-run to retry them — already-paid`);
    console.log(`    addresses are skipped, so a re-run costs only what is still owed.`);
  }
  console.log('');
}

main().catch((e) => { console.error(e); process.exit(1); });
