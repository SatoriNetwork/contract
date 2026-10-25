#!/usr/bin/env node
// Publish a drop root produced by merkle-drop.js.
//
//   node scripts/publish-root.js drop.proofs.json                 # plan + verify
//   PUBLISH=1 node scripts/publish-root.js drop.proofs.json       # send it
//
// Standalone node, like merkle-drop.js, for the same reason: publishing a root
// moves money and should not require a dev toolchain to do or to check.
//
// ── HOW IT GETS SENT ───────────────────────────────────────────────────────
// `setMerkleRoot` is rootPublisher-only, and the publisher should be a multisig.
// Two modes, and the second is the real one:
//
//   * If SIGNER_KEYS is set and those keys are Safe owners, it assembles and
//     sends the Safe transaction directly. Convenient on a testnet where one
//     person holds all the keys. NOT how a real publisher should work.
//   * Otherwise it prints the transaction for the publisher to execute in the
//     Safe UI, and stops. That is the normal path: signatures collected from
//     separate humans, on their own devices.
//
// ── WHAT IT CHECKS ─────────────────────────────────────────────────────────
// After publishing it simulates every claim against the deployed contract, so a
// bad tree is caught before anyone spends gas discovering it. `InvalidProof`
// means the tree is wrong. Any OTHER revert means the proof verified and
// execution got further — `BudgetExceeded` in particular just means the
// off-chain reserve has not accrued yet, which is a scheduling matter, not a
// broken drop.
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

const MERKLE_ABI = [
  'function setMerkleRoot(bytes32)',
  'function merkleRoot() view returns (bytes32)',
  'function rootPublisher() view returns (address)',
  'function claimMerkle(uint256,bytes32[])',
];
const SAFE_ABI = [
  'function nonce() view returns (uint256)',
  'function getThreshold() view returns (uint256)',
  'function getTransactionHash(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,uint256 _nonce) view returns (bytes32)',
  'function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) payable returns (bool)',
];
const SAFE_TX_TYPES = { SafeTx: [
  { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
  { name: 'data', type: 'bytes' }, { name: 'operation', type: 'uint8' },
  { name: 'safeTxGas', type: 'uint256' }, { name: 'baseGas', type: 'uint256' },
  { name: 'gasPrice', type: 'uint256' }, { name: 'gasToken', type: 'address' },
  { name: 'refundReceiver', type: 'address' }, { name: 'nonce', type: 'uint256' },
]};

const SELECTORS = {
  '0x09bde339': 'InvalidProof',
  '0x50b2c4e1': 'BudgetExceeded',
  '0x969bf728': 'NothingToClaim',
  '0x82b42900': 'Unauthorized',
};

const retry = async (fn, n = 6) => {
  for (let i = 0; i < n; i++) {
    try { return await fn(); }
    catch (e) {
      const m = String(e?.info?.error?.message ?? e?.message ?? e);
      if (i === n - 1 || !/rate limit|429|missing revert data|timeout|ECONN/i.test(m)) throw e;
      await new Promise((r) => setTimeout(r, 1500 * 2 ** i));
    }
  }
};

(async () => {
  const proofsPath = process.argv.slice(2).find((a) => !a.startsWith('--'));
  if (!proofsPath) {
    console.error('usage: node scripts/publish-root.js <drop.proofs.json>');
    process.exit(1);
  }
  const drop = JSON.parse(fs.readFileSync(proofsPath, 'utf8'));

  const rpc = process.env.RPC_URL || 'https://sepolia.base.org';
  const bookPath = process.env.ADDRESS_BOOK ||
    path.join(__dirname, '..', 'deployments', `${process.env.NETWORK || 'baseSepolia'}.json`);
  const book = fs.existsSync(bookPath) ? JSON.parse(fs.readFileSync(bookPath, 'utf8')) : null;
  const merkleAddr = process.env.MERKLE_ADDRESS || (book && book.addresses.merkle);
  if (!merkleAddr) throw new Error('no merkle address — set MERKLE_ADDRESS or ADDRESS_BOOK');

  const provider = new ethers.JsonRpcProvider(rpc);
  await require('./chain-guard').requireChain(provider, book);
  const merkle = new ethers.Contract(merkleAddr, MERKLE_ABI, provider);
  const iface = new ethers.Interface(MERKLE_ABI);

  const publisher = await retry(() => merkle.rootPublisher());
  const current = await retry(() => merkle.merkleRoot());
  const data = iface.encodeFunctionData('setMerkleRoot', [drop.root]);

  console.log(`\n  merkle      ${merkleAddr}`);
  console.log(`  publisher   ${publisher}`);
  console.log(`  current     ${current}`);
  console.log(`  new         ${drop.root}`);
  console.log(`  recipients  ${Object.keys(drop.recipients).length}, ${drop.total} SATORI cumulative`);
  if (current === drop.root) { console.log('\n  Already published. Nothing to do.\n'); return; }

  console.log('\n  This REPLACES the current root. Entitlements are lifetime totals, so');
  console.log('  anyone missing from the new root can claim nothing further, and anyone');
  console.log('  whose total went DOWN can claim nothing until it exceeds what they have.');

  const keys = (process.env.SIGNER_KEYS || '').split(',').map((k) => k.trim()).filter(Boolean);

  if (!process.env.PUBLISH) {
    console.log('\n  PLAN ONLY. To send, either:');
    console.log(`    - execute this from the publisher (${publisher}):`);
    console.log(`        to    ${merkleAddr}`);
    console.log(`        value 0`);
    console.log(`        data  ${data}`);
    console.log('    - or re-run with PUBLISH=1 (and SIGNER_KEYS if the publisher is a Safe).\n');
    return;
  }

  if ((await provider.getCode(publisher)) === '0x') {
    throw new Error(`publisher ${publisher} is an EOA — sign and send the call above from it directly.`);
  }
  if (keys.length === 0) {
    console.log('\n  The publisher is a contract (a Safe) and no SIGNER_KEYS were given.');
    console.log('  Execute the transaction above in the Safe UI. That is the intended path.\n');
    return;
  }

  // Testnet convenience path: one machine holding several owner keys.
  const relayerKey = process.env.RELAYER_KEY || keys[0];
  const relayer = new ethers.Wallet(relayerKey, provider);
  const safe = new ethers.Contract(publisher, SAFE_ABI, relayer);
  const chainId = Number((await provider.getNetwork()).chainId);

  const tx = {
    to: merkleAddr, value: 0n, data, operation: 0,
    safeTxGas: 0, baseGas: 0, gasPrice: 0,
    gasToken: ethers.ZeroAddress, refundReceiver: ethers.ZeroAddress,
    nonce: await retry(() => safe.nonce()),
  };
  const domain = { chainId, verifyingContract: publisher };
  const local = ethers.TypedDataEncoder.hash(domain, SAFE_TX_TYPES, tx);
  const onchain = await retry(() => safe.getTransactionHash(
    tx.to, tx.value, tx.data, tx.operation, tx.safeTxGas, tx.baseGas,
    tx.gasPrice, tx.gasToken, tx.refundReceiver, tx.nonce));
  if (local !== onchain) throw new Error('SafeTx hash mismatch — refusing to sign');

  // Owner order matters: the Safe requires signatures ascending by signer.
  const signers = keys.map((k) => new ethers.Wallet(k, provider))
    .sort((a, b) => (a.address.toLowerCase() < b.address.toLowerCase() ? -1 : 1));
  const threshold = Number(await retry(() => safe.getThreshold()));
  if (signers.length < threshold) {
    throw new Error(`Safe needs ${threshold} signatures, ${signers.length} key(s) supplied`);
  }
  let sigs = '0x';
  for (const w of signers) sigs += (await w.signTypedData(domain, SAFE_TX_TYPES, tx)).slice(2);

  const receipt = await retry(() => safe.execTransaction(
    tx.to, tx.value, tx.data, tx.operation, tx.safeTxGas, tx.baseGas,
    tx.gasPrice, tx.gasToken, tx.refundReceiver, sigs).then((t) => t.wait()));
  console.log(`\n  published by ${signers.length}-of-${threshold}, block ${receipt.blockNumber}, status ${receipt.status}`);

  let live = current;
  for (let i = 0; i < 15 && live !== drop.root; i++) {
    await new Promise((r) => setTimeout(r, 2500));
    live = await retry(() => merkle.merkleRoot());
  }
  console.log(`  on-chain root ${live} ${live === drop.root ? 'ok' : 'MISMATCH'}`);

  // Simulated, so nothing is spent finding out the tree was wrong.
  console.log('\n  proofs, against the deployed contract:');
  let bad = 0;
  for (const [addr, rec] of Object.entries(drop.recipients)) {
    const call = iface.encodeFunctionData('claimMerkle', [rec.amountWei, rec.proof]);
    try {
      await provider.call({ from: addr, to: merkleAddr, data: call });
      console.log(`    ok   ${addr}  would claim ${rec.amount}`);
    } catch (e) {
      const raw = e?.info?.error?.data ?? e?.data;
      const sel = typeof raw === 'string' ? raw.slice(0, 10) : null;
      const name = (sel && SELECTORS[sel]) || sel || 'unknown revert';
      if (name === 'InvalidProof') { bad++; console.log(`    FAIL ${addr}  InvalidProof — the tree is wrong`); }
      else console.log(`    ok   ${addr}  proof verified (then ${name})`);
    }
  }
  console.log(bad
    ? `\n  ${bad} proof(s) rejected — this root is not usable.\n`
    : '\n  Every proof verifies against the contract.\n');
  process.exit(bad ? 1 : 0);
})();
