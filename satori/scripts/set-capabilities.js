#!/usr/bin/env node
// Read or change the capability policy.
//
//   node scripts/set-capabilities.js                      # show what is on
//   node scripts/set-capabilities.js +createStream        # plan the change
//   SET=1 node scripts/set-capabilities.js +createStream  # send it
//   SET=1 node scripts/set-capabilities.js -bounty +createGame
//
// Capabilities ship OFF (launch checklist E1) so the protocol opens with only
// delegation on (voting included is OFF), and each surface is turned on deliberately. That makes
// this the tool for the whole progressive rollout, not a one-off.
//
// ── WHY THE READ-MODIFY-WRITE MATTERS ─────────────────────────────────────
// `setCapabilities` takes the WHOLE bitmap and overwrites it. Sending a bare
// mask for the one capability you meant to enable silently DISABLES every other
// one. So this reads the live bitmap first, applies +/- deltas to it, and prints
// both before and after — there is no way to express "just this bit" against
// that setter without reading first, and nothing on chain will stop a mistake.
//
// ── HOW IT GETS SENT ──────────────────────────────────────────────────────
// Admin-only, and after handoff the admin is a Safe. Same two modes as
// load-airdrop.js: SIGNER_KEYS assembles the Safe transaction directly (fine on
// a testnet where one person holds the keys), otherwise it prints the
// transaction for the owners to execute in the Safe UI.
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

// Ids are defined in SatoriHub (private constants), mirrored here because there
// is no getter for them. SatoriHub.sol.
const CAPS = {
  createStream:          0,
  authorGame:            1,   // custom game types on an existing stream
  registerStreamAdapter: 2,
  registerGameAdapter:   3,
  bounty:                4,
  delegatePrediction:    5,
  delegateClaim:         6,
  // CORRECTED 2026-08-24: this table said 7 was a retired hole and put `vote` at
  // 8. The contract did the opposite — removing the off-chain-game-adapter
  // capability COMPACTED the ids, so SatoriHub.CAP_VOTE is 7 and there is no
  // hole (SatoriHub.sol, "voting moved 8 -> 7").
  //
  // The old value was silently wrong in the worst way: `capabilityAllowed` is a
  // bare `(bits >> capId) & 1`, so bit 8 sets, reads back, and gates NOTHING.
  // `+vote` therefore flipped a dead bit, this script's read-back confirmed
  // "policy matches", and every non-admin vote() kept reverting
  // CapabilityDisabled with the operator believing voting was live.
  vote:                  7,
};

const REWARDS_ABI = [
  'function setCapabilities(uint256 bitmap)',
  'function capabilityAllowed(uint8 capId, address caller) view returns (bool)',
  'function admin() view returns (address)',
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
      if (!/rate limit|429|timeout|ETIMEDOUT|ECONNRESET|SERVER_ERROR|missing revert data/i.test(m) || i === n - 1) throw e;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
    }
  }
};

async function main() {
  const rpc = process.env.RPC_URL || 'https://sepolia.base.org';
  const book = JSON.parse(fs.readFileSync(process.env.ADDRESS_BOOK ||
    path.join(__dirname, '..', 'deployments', `${process.env.NETWORK || 'baseSepolia'}.json`), 'utf8'));
  const rewardsAddr = process.env.REWARDS_ADDRESS || book.addresses.rewards;

  const provider = new ethers.JsonRpcProvider(rpc);
  await require('./chain-guard').requireChain(provider, book);
  const rewards = new ethers.Contract(rewardsAddr, REWARDS_ABI, provider);
  const admin = await retry(() => rewards.admin());

  // There is no getter for the raw bitmap — it lives in an unstructured slot —
  // so reconstruct it by probing each capability against a NON-admin address.
  // Probing as the admin would read back all-true: capabilityAllowed returns
  // true for the admin regardless of the flags, which is a real behaviour worth
  // remembering (the admin can always use a disabled surface).
  const probe = '0x000000000000000000000000000000000000dEaD';
  const current = {};
  let bitmap = 0n;
  for (const [name, id] of Object.entries(CAPS)) {
    const on = await retry(() => rewards.capabilityAllowed(id, probe));
    current[name] = on;
    if (on) bitmap |= (1n << BigInt(id));
  }

  console.log(`\n  rewards ${rewardsAddr}`);
  console.log(`  admin   ${admin}`);
  console.log(`\n  current policy (bitmap ${bitmap}):`);
  for (const [name, id] of Object.entries(CAPS)) {
    console.log(`    ${current[name] ? 'ON  ' : 'off '} ${String(id).padStart(2)}  ${name}`);
  }

  const deltas = process.argv.slice(2);
  if (deltas.length === 0) {
    console.log('\n  No changes requested. Pass +name / -name to change one.\n');
    return;
  }

  let next = bitmap;
  const changes = [];
  for (const d of deltas) {
    const sign = d[0];
    const key = d.slice(1);
    if ((sign !== '+' && sign !== '-') || !(key in CAPS)) {
      console.error(`\n  bad argument "${d}". Use +name or -name, one of: ${Object.keys(CAPS).join(', ')}\n`);
      process.exit(1);
    }
    const bit = 1n << BigInt(CAPS[key]);
    const was = (next & bit) !== 0n;
    if (sign === '+') next |= bit; else next &= ~bit;
    const now = (next & bit) !== 0n;
    if (was !== now) changes.push(`${key}: ${was ? 'ON' : 'off'} -> ${now ? 'ON' : 'off'}`);
  }

  if (next === bitmap) {
    console.log('\n  Nothing to do — the policy already matches.\n');
    return;
  }
  console.log(`\n  changes:`);
  for (const c of changes) console.log(`    ${c}`);
  console.log(`\n  bitmap ${bitmap} -> ${next}`);

  const data = new ethers.Interface(REWARDS_ABI).encodeFunctionData('setCapabilities', [next]);

  if (!process.env.SET) {
    console.log('\n  PLAN ONLY. To send:');
    console.log(`    to   ${rewardsAddr}`);
    console.log(`    data ${data}`);
    console.log('    - execute that from the admin in the Safe UI,');
    console.log('    - or re-run with SET=1 (and SIGNER_KEYS if the admin is a Safe).\n');
    return;
  }

  const keys = (process.env.SIGNER_KEYS || '').split(',').map((k) => k.trim()).filter(Boolean);
  const adminIsContract = (await retry(() => provider.getCode(admin))) !== '0x';
  if (adminIsContract && keys.length === 0) {
    console.log('\n  The admin is a Safe and no SIGNER_KEYS were given. Execute the above in the Safe UI.\n');
    return;
  }

  if (!adminIsContract) {
    const w = new ethers.Wallet(keys[0], provider);
    await retry(() => w.sendTransaction({ to: rewardsAddr, data }).then((t) => t.wait()));
  } else {
    const safe = new ethers.Contract(admin, SAFE_ABI, provider);
    const [nonce, threshold, net] = await Promise.all([
      retry(() => safe.nonce()), retry(() => safe.getThreshold()), provider.getNetwork(),
    ]);
    const tx = {
      to: rewardsAddr, value: 0n, data, operation: 0,
      safeTxGas: 0n, baseGas: 0n, gasPrice: 0n,
      gasToken: ethers.ZeroAddress, refundReceiver: ethers.ZeroAddress, nonce,
    };
    const domain = { chainId: Number(net.chainId), verifyingContract: admin };
    const signers = keys.map((k) => new ethers.Wallet(k))
      .sort((a, b) => (a.address.toLowerCase() < b.address.toLowerCase() ? -1 : 1))
      .slice(0, Number(threshold));
    if (signers.length < Number(threshold)) {
      console.error(`\n  need ${threshold} signer keys, got ${signers.length}\n`); process.exit(1);
    }
    let sigs = '0x';
    for (const w of signers) sigs += (await w.signTypedData(domain, SAFE_TX_TYPES, tx)).slice(2);
    const relayer = new ethers.Wallet(process.env.RELAYER_KEY || keys[0], provider);
    const rc = await retry(() => safe.connect(relayer).execTransaction(
      tx.to, tx.value, tx.data, tx.operation, tx.safeTxGas, tx.baseGas,
      tx.gasPrice, tx.gasToken, tx.refundReceiver, sigs).then((t) => t.wait()));
    console.log(`\n  sent by ${signers.length}-of-${threshold}, block ${rc.blockNumber}, status ${rc.status}`);
  }

  // Read back, polled. A Safe emits ExecutionSuccess even when the inner call
  // reverted, and a public RPC may answer from a node one block behind — a stale
  // read here looks exactly like a policy that did not change.
  console.log('\n  reading the policy back:');
  const deadline = Date.now() + 90_000;
  let ok = false;
  while (Date.now() < deadline && !ok) {
    let live = 0n;
    for (const [, id] of Object.entries(CAPS)) {
      if (await retry(() => rewards.capabilityAllowed(id, probe))) live |= (1n << BigInt(id));
    }
    ok = live === next;
    if (!ok) await new Promise((r) => setTimeout(r, 3000));
  }
  for (const [name, id] of Object.entries(CAPS)) {
    const on = await retry(() => rewards.capabilityAllowed(id, probe));
    console.log(`    ${on ? 'ON  ' : 'off '} ${String(id).padStart(2)}  ${name}`);
  }
  console.log(ok ? '\n  policy matches.' : '\n  MISMATCH after 90s — the inner call reverted.');
  if (!ok) process.exit(1);
}

main().catch((e) => { console.error('\n  ERR:', e.shortMessage ?? e.message); process.exit(1); });
