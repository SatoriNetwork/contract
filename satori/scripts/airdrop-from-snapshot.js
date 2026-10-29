#!/usr/bin/env node
// Turn a SATORIEVR snapshot into airdrop batch files for load-airdrop.js.
//
//   node scripts/airdrop-from-snapshot.js <satorievr_snapshot_pubkeys.csv> <out-dir>
//
// Each Evrmore key's secret is also its Base key (docs: satori/docs/design/base.md,
// "Keys on Base"), so a holder's Base address is computeAddress(public key). One
// SATORIEVR is one SATORI. Rows with no public key (never spent, burn, multisig)
// get no Base address; they go to unmapped.csv and can be loaded later, once a
// key is revealed, until finalizeAirdropLoading.
//
// Writes to <out-dir>:
//   batch-0001.json …   { "0x…": "amount" }, BATCH recipients each (default 500)
//   mapping.csv         evrmore_address,base_address,amount
//   unmapped.csv        evrmore_address,amount,status
//
// BATCH: loadAirdropBatch costs ~24,800 gas per recipient (measured on hardhat),
// so 500 is ~12.4M gas, under the 16,777,216 per-transaction cap.
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

const EVRMORE_P2PKH = 33;
const AMOUNT = /^\d+(\.\d{1,8})?$/;

// The key is re-checked against the address here, not trusted from the file: a
// loaded allocation cannot be edited, so a wrong key would pay a stranger.
function evrmoreHash160(address) {
  const raw = ethers.getBytes(ethers.toBeHex(ethers.decodeBase58(address), 25));
  const check = ethers.getBytes(ethers.sha256(ethers.sha256(raw.slice(0, 21)))).slice(0, 4);
  if (!check.every((b, i) => b === raw[21 + i])) throw new Error(`bad checksum: ${address}`);
  return { version: raw[0], hash: ethers.hexlify(raw.slice(1, 21)) };
}

function convert(rows, batchSize = 500) {
  const mapped = [];
  const unmapped = [];
  const byBase = new Map();
  for (const r of rows) {
    if (!AMOUNT.test(r.balance) || ethers.parseUnits(r.balance, 8) === 0n) {
      throw new Error(`bad balance for ${r.address}: ${r.balance}`);
    }
    if (!r.public_key) { unmapped.push(r); continue; }
    const pk = '0x' + r.public_key;
    const { version, hash } = evrmoreHash160(r.address);
    if (version !== EVRMORE_P2PKH) throw new Error(`not a P2PKH address but has a key: ${r.address}`);
    if (ethers.ripemd160(ethers.sha256(pk)) !== hash) {
      throw new Error(`public key does not hash to its address: ${r.address}`);
    }
    const base = ethers.computeAddress(pk);
    if (byBase.has(base)) throw new Error(`${r.address} and ${byBase.get(base)} map to ${base}`);
    byBase.set(base, r.address);
    mapped.push({ evrmore: r.address, base, amount: r.balance });
  }
  const batches = [];
  for (let i = 0; i < mapped.length; i += batchSize) {
    batches.push(Object.fromEntries(mapped.slice(i, i + batchSize).map((m) => [m.base, m.amount])));
  }
  return { mapped, unmapped, batches };
}

function readCsv(file) {
  const [head, ...lines] = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/);
  const cols = head.split(',');
  return lines.map((l) => Object.fromEntries(l.split(',').map((v, i) => [cols[i], v])));
}

const sum = (xs) => ethers.formatUnits(xs.reduce((a, x) => a + ethers.parseUnits(x, 8), 0n), 8);

function main() {
  const [file, out] = process.argv.slice(2);
  if (!file || !out) {
    console.error('usage: airdrop-from-snapshot.js <satorievr_snapshot_pubkeys.csv> <out-dir>');
    process.exit(1);
  }
  const rows = readCsv(file);
  const { mapped, unmapped, batches } = convert(rows, Number(process.env.BATCH || 500));

  fs.mkdirSync(out, { recursive: true });
  batches.forEach((b, i) => fs.writeFileSync(
    path.join(out, `batch-${String(i + 1).padStart(4, '0')}.json`), JSON.stringify(b, null, 1) + '\n'));
  fs.writeFileSync(path.join(out, 'mapping.csv'), 'evrmore_address,base_address,amount\n' +
    mapped.map((m) => `${m.evrmore},${m.base},${m.amount}`).join('\n') + '\n');
  fs.writeFileSync(path.join(out, 'unmapped.csv'), 'evrmore_address,amount,status\n' +
    unmapped.map((r) => `${r.address},${r.balance},${r.status}`).join('\n') + '\n');

  console.log(`\n  snapshot   ${rows.length} rows, ${sum(rows.map((r) => r.balance))}`);
  console.log(`  mapped     ${mapped.length} Base addresses, ${sum(mapped.map((m) => m.amount))} SATORI`);
  console.log(`  unmapped   ${unmapped.length} rows, ${sum(unmapped.map((r) => r.balance))} (no public key)`);
  console.log(`  batches    ${batches.length} files in ${out}\n`);
}

if (require.main === module) main();
module.exports = { convert, evrmoreHash160 };
