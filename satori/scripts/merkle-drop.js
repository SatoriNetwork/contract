#!/usr/bin/env node
// Build a Merkle root (and the proofs to claim against it) for SatoriMerkle.
//
//   node scripts/merkle-drop.js drop.json [--out proofs.json] [--verify]
//
// Standalone: plain node and ethers, no hardhat. It can run on a machine that
// has never seen this repo's toolchain, which matters because publishing a root
// is a treasury operation and should not require a dev environment.
//
// ── THE ONE THING TO GET RIGHT ─────────────────────────────────────────────
// AMOUNTS ARE CUMULATIVE LIFETIME TOTALS, NOT INCREMENTS.
//
// `claimMerkle(E, proof)` mints `E − alreadyMintedTo[user]`. So a root says
// "this address is owed E in total, ever" — not "pay them E now". Publishing a
// new root REPLACES the old one outright.
//
//   round 1:  alice 10   -> alice claims 10
//   round 2:  alice 25   -> alice claims 15   (the difference)
//   round 2:  alice 15   -> alice claims 0    (already had more than that)
//
// Writing increments instead of totals underpays everyone silently: the second
// root would offer alice 15 when she has already had 10, and she would receive
// 5. Nothing reverts, nothing warns, the numbers are simply wrong. Carry every
// prior total forward into every new root.
//
// ── INPUT ──────────────────────────────────────────────────────────────────
//   { "0xabc…": "1", "0xdef…": "2.5" }              amounts in whole SATORI
//   { "recipients": { "0xabc…": "1" } }             also accepted
//
// ── OUTPUT ─────────────────────────────────────────────────────────────────
// The root, one proof per address, and the exact calldata for `setMerkleRoot`
// so a multisig can publish it without anyone retyping a 32-byte hash.
const fs = require('fs');
const path = require('path');

function loadEthers() {
  for (const p of ['ethers', path.join(__dirname, '..', 'node_modules', 'ethers'),
                   path.join(__dirname, '..', '..', 'node_modules', 'ethers')]) {
    try { return require(p); } catch { /* try the next */ }
  }
  console.error('ethers not found — run this from a checkout with node_modules installed');
  process.exit(1);
}
const { ethers } = loadEthers();

// ── the tree ───────────────────────────────────────────────────────────────
// Must match SatoriMerkle.claimMerkle exactly:
//   leaf = keccak256(bytes.concat(keccak256(abi.encode(account, amount))))
// The double hash is OpenZeppelin's StandardMerkleTree convention. It exists so
// that a leaf preimage can never be confused with an internal node — without it,
// a 64-byte "leaf" could be presented as a pair of hashes and forge a proof.
const leafOf = (addr, amount) => ethers.keccak256(ethers.keccak256(
  ethers.AbiCoder.defaultAbiCoder().encode(['address', 'uint256'], [addr, amount])));

// OpenZeppelin's MerkleProof hashes pairs COMMUTATIVELY (sorted), so a proof
// carries no left/right information and the tree shape need only be consistent
// with itself.
const hashPair = (a, b) => ethers.keccak256(
  ethers.concat(a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a]));

/// Returns { root, layers }. An odd node at any level is promoted unchanged,
/// which is the standard construction and keeps proofs one element shorter.
function buildTree(leaves) {
  if (leaves.length === 0) throw new Error('no recipients — nothing to build');
  const layers = [leaves.slice()];
  while (layers[layers.length - 1].length > 1) {
    const prev = layers[layers.length - 1];
    const next = [];
    for (let i = 0; i < prev.length; i += 2) {
      next.push(i + 1 < prev.length ? hashPair(prev[i], prev[i + 1]) : prev[i]);
    }
    layers.push(next);
  }
  return { root: layers[layers.length - 1][0], layers };
}

function proofFor(layers, index) {
  const proof = [];
  let idx = index;
  for (let l = 0; l < layers.length - 1; l++) {
    const layer = layers[l];
    const pairIdx = idx ^ 1;                 // sibling
    if (pairIdx < layer.length) proof.push(layer[pairIdx]);
    idx = Math.floor(idx / 2);
  }
  return proof;
}

/// Independent re-implementation of OpenZeppelin's MerkleProof.verify. Used to
/// check every proof this script emits before it is trusted — building a tree
/// and generating proofs from the same code is not evidence that either is
/// right, only that they agree.
const verifyProof = (proof, root, leaf) =>
  proof.reduce((computed, p) => hashPair(computed, p), leaf) === root;

// ── main ───────────────────────────────────────────────────────────────────
function main() {
  const args = process.argv.slice(2);
  const inputPath = args.find((a) => !a.startsWith('--'));
  if (!inputPath) {
    console.error('usage: node scripts/merkle-drop.js <drop.json> [--out proofs.json]');
    process.exit(1);
  }
  const outPath = args.includes('--out')
    ? args[args.indexOf('--out') + 1]
    : inputPath.replace(/\.json$/, '') + '.proofs.json';

  const raw = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  const recipients = raw.recipients ?? raw;

  const entries = Object.entries(recipients).map(([addr, amount]) => {
    let a;
    try { a = ethers.getAddress(addr.trim()); }
    catch { throw new Error(`not a valid address: ${addr}`); }
    const wei = ethers.parseEther(String(amount).trim());
    if (wei <= 0n) throw new Error(`${a}: amount must be positive (got ${amount})`);
    return { address: a, amount: String(amount).trim(), wei };
  });

  // A duplicate address would produce two leaves for one account, of which only
  // one is reachable — the other silently never pays.
  const seen = new Set();
  for (const e of entries) {
    const k = e.address.toLowerCase();
    if (seen.has(k)) throw new Error(`${e.address} appears more than once — totals must be combined into one entry`);
    seen.add(k);
  }

  const leaves = entries.map((e) => leafOf(e.address, e.wei));
  const { root, layers } = buildTree(leaves);

  const out = { root, generated: new Date().toISOString(), recipients: {} };
  let total = 0n;
  let bad = 0;
  console.log(`\nrecipients: ${entries.length}`);
  entries.forEach((e, i) => {
    const proof = proofFor(layers, i);
    const ok = verifyProof(proof, root, leaves[i]);
    if (!ok) bad++;
    total += e.wei;
    out.recipients[e.address] = { amount: e.amount, amountWei: e.wei.toString(), proof };
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${e.address}  ${e.amount} SATORI  (proof ${proof.length} node${proof.length === 1 ? '' : 's'})`);
  });

  if (bad) {
    console.error(`\n${bad} proof(s) did not verify — refusing to write output.`);
    process.exit(1);
  }

  out.totalWei = total.toString();
  out.total = ethers.formatEther(total);
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n');

  const iface = new ethers.Interface(['function setMerkleRoot(bytes32 newRoot)']);
  console.log(`\nroot          ${root}`);
  console.log(`cumulative    ${out.total} SATORI across ${entries.length} address(es)`);
  console.log(`proofs        ${outPath}`);
  console.log(`\npublish by calling setMerkleRoot on the merkle contract, as rootPublisher:`);
  console.log(`  data  ${iface.encodeFunctionData('setMerkleRoot', [root])}`);
  console.log(`\nREMEMBER: these are LIFETIME totals. This root replaces the previous one`);
  console.log(`entirely, and anyone omitted from it can no longer claim anything new.\n`);
}

main();
