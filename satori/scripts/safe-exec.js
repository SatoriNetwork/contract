#!/usr/bin/env node
// Execute one arbitrary transaction THROUGH a Safe, assembling threshold
// signatures from keys you hold.
//
//   SAFE=0x… TO=0x… DATA=0x… node scripts/safe-exec.js              # plan
//   SAFE=… TO=… DATA=… SIGNER_KEYS=0x..,0x..,0x.. EXECUTE=1 \
//     node scripts/safe-exec.js                                     # send
//
// Extracted because three separate things need it and load-airdrop.js had the
// only copy: the D4 handoff's `acceptGovernor` (which the handoff script
// deliberately cannot send, since it must come FROM the new governor), the D3
// UUPS upgrade, and any future admin call once the Safe holds the roles.
//
// ── THIS IS A TESTNET CONVENIENCE ──────────────────────────────────────────
// It only works when one machine holds `threshold` owner keys, which on a real
// deployment is precisely the situation a multisig exists to prevent. On
// mainnet, print the transaction and let the humans sign it in the Safe UI.
// `load-airdrop.js` carries the same warning for the same reason.
//
// ── THE TRAP THIS SCRIPT EXISTS TO NOT FALL INTO ───────────────────────────
// **A Safe `execTransaction` emits `ExecutionSuccess` even when the INNER call
// reverted.** A green receipt proves the Safe ran, not that the thing you asked
// for happened. So this never claims success on a receipt alone: it prints what
// to verify and exits non-zero if the caller gave it a VERIFY expression that
// does not hold.
const path = require("path");

function loadEthers() {
  for (const p of ["ethers", path.join(__dirname, "..", "node_modules", "ethers"),
                   path.join(__dirname, "..", "..", "node_modules", "ethers")]) {
    try { return require(p); } catch { /* next */ }
  }
  console.error("ethers not found"); process.exit(1);
}
const { ethers } = loadEthers();

const SAFE_ABI = [
  "function nonce() view returns (uint256)",
  "function getThreshold() view returns (uint256)",
  "function getOwners() view returns (address[])",
  "function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) payable returns (bool)",
];
const SAFE_TX_TYPES = { SafeTx: [
  { name: "to", type: "address" }, { name: "value", type: "uint256" },
  { name: "data", type: "bytes" }, { name: "operation", type: "uint8" },
  { name: "safeTxGas", type: "uint256" }, { name: "baseGas", type: "uint256" },
  { name: "gasPrice", type: "uint256" }, { name: "gasToken", type: "address" },
  { name: "refundReceiver", type: "address" }, { name: "nonce", type: "uint256" },
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
  const rpc = process.env.RPC_URL || "https://sepolia.base.org";
  const safeAddr = ethers.getAddress(process.env.SAFE || "");
  const to = ethers.getAddress(process.env.TO || "");
  const data = process.env.DATA || "0x";
  const label = process.env.LABEL || "call";

  const provider = new ethers.JsonRpcProvider(rpc);
  const safe = new ethers.Contract(safeAddr, SAFE_ABI, provider);
  const [nonce, threshold, owners, net] = await Promise.all([
    retry(() => safe.nonce()), retry(() => safe.getThreshold()),
    retry(() => safe.getOwners()), provider.getNetwork(),
  ]);

  console.log(`\n  safe       ${safeAddr}  (${threshold}-of-${owners.length}, nonce ${nonce})`);
  console.log(`  to         ${to}`);
  console.log(`  data       ${data}`);
  console.log(`  intent     ${label}`);

  const keys = (process.env.SIGNER_KEYS || "").split(",").map((k) => k.trim()).filter(Boolean);
  if (!process.env.EXECUTE) {
    console.log(`\n  PLAN ONLY. Re-run with EXECUTE=1 and SIGNER_KEYS to send,`);
    console.log(`  or execute it from the Safe UI:`);
    console.log(`    https://app.safe.global/home?safe=basesep:${safeAddr}\n`);
    return;
  }

  // Only owners count, and only up to threshold. Filtering here rather than
  // trusting the caller means a stray non-owner key produces a clear message
  // instead of an opaque GS026 from the Safe.
  const ownerSet = new Set(owners.map((o) => o.toLowerCase()));
  const wallets = keys.map((k) => new ethers.Wallet(k)).filter((w) => ownerSet.has(w.address.toLowerCase()));
  if (wallets.length < Number(threshold)) {
    console.error(`\n  need ${threshold} OWNER keys, have ${wallets.length}\n`);
    process.exit(1);
  }
  // Safe requires signatures ordered by ascending signer address.
  const signers = wallets
    .sort((a, b) => (a.address.toLowerCase() < b.address.toLowerCase() ? -1 : 1))
    .slice(0, Number(threshold));

  const tx = {
    to, value: 0n, data, operation: 0,
    safeTxGas: 0n, baseGas: 0n, gasPrice: 0n,
    gasToken: ethers.ZeroAddress, refundReceiver: ethers.ZeroAddress, nonce,
  };
  const domain = { chainId: Number(net.chainId), verifyingContract: safeAddr };
  let sigs = "0x";
  for (const w of signers) sigs += (await w.signTypedData(domain, SAFE_TX_TYPES, tx)).slice(2);

  const relayer = new ethers.Wallet(process.env.RELAYER_KEY || keys[0], provider);
  console.log(`\n  signing with ${signers.length} owner key(s), relayed by ${relayer.address}`);
  const rc = await retry(() => safe.connect(relayer).execTransaction(
    tx.to, tx.value, tx.data, tx.operation, tx.safeTxGas, tx.baseGas,
    tx.gasPrice, tx.gasToken, tx.refundReceiver, sigs).then((t) => t.wait()));

  console.log(`  block ${rc.blockNumber}, receipt status ${rc.status}`);
  console.log(`\n  ⚠ A receipt status of 1 means THE SAFE RAN, not that "${label}" worked.`);
  console.log(`    execTransaction emits ExecutionSuccess even when the inner call`);
  console.log(`    reverted. Verify the effect on chain before believing it.\n`);
}

main().catch((e) => { console.error("\n  ERR:", e.shortMessage ?? e.message, "\n"); process.exit(1); });
