// The GOVERNOR / REWARDS_ADMIN multisig — a 3-of-5 Safe.
//
//   npx hardhat run scripts/deploy-safe.js --network baseSepolia          (deploys)
//   SAFE_DRY_RUN=1 npx hardhat run scripts/deploy-safe.js --network baseSepolia
//
// Why this runs BEFORE the protocol deploy: `GOVERNOR` is the most powerful slot
// in the system (ADDRESS_ROSTER §8) — it redirects the sole minter via
// `SatoriToken.setController`, authorizes every UUPS upgrade, and RECEIVES THE
// GENESIS SUPPLY (about 719.63 SATORI). Recorded intent is a 3-of-5 Safe. The Safe must
// exist before it can be named, and checklist D3 (one UUPS upgrade executed
// through the Safe) cannot be rehearsed until it does.
//
// NOTHING IS DEPLOYED FROM THIS REPO. Every Safe contract is already on chain at
// a canonical address, byte-identical on Base Sepolia and Base mainnet (verified
// on-chain 2026-07-28, re-verified here at run time). This script only calls the
// factory. That is the whole point of the rehearsal: same factory, same
// singleton, same addresses, same app.safe.global flow, so the testnet run and
// the mainnet run differ in exactly one thing — the owner set.
//
// WHY SafeL2 AND NOT Safe
// Two singletons exist at 1.4.1. `Safe` (0x41675C09) is the L1 build; `SafeL2`
// (0x29fcB43b) additionally emits SafeMultiSigTransaction / SafeModuleTransaction
// events on every execution. L2s historically lacked trace support, so the Safe
// transaction service indexes L2 chains off those events — and app.safe.global
// deploys SafeL2 on Base. Picking the L1 build here would produce a Safe the
// official UI cannot follow properly, which would silently break the D3
// rehearsal it exists to enable. Base gets SafeL2.
//
// THE DEPLOYER HAS NO RESIDUAL POWER
// Whoever sends this transaction is not an owner and holds nothing afterwards —
// ownership is set inside `setup()`, in the same transaction. A throwaway hot key
// is therefore a legitimate deployer even for the mainnet Safe. The script still
// asserts the deployer is NOT among the owners, because on mainnet the deployer
// is a hot key by design (LAUNCH_CHECKLIST C5) and must not silently become a
// third of the quorum guarding the genesis treasury.
//
// ADDRESS DETERMINISM, AND WHY IT IS CHECKED TWICE
// `createProxyWithNonce` is CREATE2:
//   salt = keccak256(keccak256(initializer) ++ saltNonce)
//   addr = CREATE2(factory, salt, keccak256(proxyCreationCode ++ singleton))
// so the address is fixed by (owners, threshold, handler, saltNonce) before any
// transaction is sent. The script derives it locally AND simulates the factory
// call with eth_call, then requires the two to agree. Two independent derivations
// agreeing is what makes SAFE_DRY_RUN=1 a real preflight rather than a guess —
// on mainnet, run the dry run first and read the address back before signing.
const { ethers, network } = require("hardhat");
// A read issued right after a write can land on a node that has not applied the
// block yet, so `getCode` returns "0x" for a contract that demonstrably exists.
// Treating that as a failed deployment would invite a duplicate redeploy.
const { waitForCode } = require("./live-reads-lib");

// Safe 1.4.1 deployments — identical addresses on Base Sepolia (84532) and Base (8453).
const FACTORY   = "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67"; // SafeProxyFactory
const SINGLETON = "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762"; // SafeL2  <- see header
const FALLBACK  = "0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99"; // CompatibilityFallbackHandler

// Expected runtime code sizes, from the 2026-07-28 on-chain verification. Cheap
// insurance that we are talking to the contracts we think we are.
const EXPECTED_SIZE = { [FACTORY]: 3054, [SINGLETON]: 24421, [FALLBACK]: 5637 };

// Safe stores the fallback handler outside the normal layout, at
// keccak256("fallback_manager.handler.address"). The singleton is slot 0.
const FALLBACK_SLOT = "0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5";
const SENTINEL = "0x0000000000000000000000000000000000000001";

const SAFE_ABI = [
  "function setup(address[] _owners, uint256 _threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver)",
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
  "function isOwner(address) view returns (bool)",
  "function nonce() view returns (uint256)",
  "function VERSION() view returns (string)",
  "function domainSeparator() view returns (bytes32)",
  "function getModulesPaginated(address start, uint256 pageSize) view returns (address[] array, address next)",
];
const FACTORY_ABI = [
  "function createProxyWithNonce(address _singleton, bytes initializer, uint256 saltNonce) returns (address)",
  "function proxyCreationCode() pure returns (bytes)",
];

function requireAddr(name, value) {
  const v = (value ?? "").trim();
  if (!v) throw new Error(`${name} is required. See .env.example.`);
  let a;
  try { a = ethers.getAddress(v); }
  catch { throw new Error(`${name} is not a valid address: ${v}`); }
  if (a === ethers.ZeroAddress) throw new Error(`${name} must not be the zero address`);
  return a;
}

// Verifies a FINISHED Safe by reading it back, independent of how it got there —
// so it works both right after a deploy and on a re-run against an existing Safe.
// `expectFresh` asserts nonce == 0. That is only correct immediately after a
// deploy — on the re-run path a Safe that has legitimately executed transactions
// would false-fail, so the caller opts in.
async function verifySafe(safeAddr, owners, threshold, chainId, deployerAddr, expectFresh = false) {
  console.log(`\n== verifying on-chain ==`);
  const safe = new ethers.Contract(safeAddr, SAFE_ABI, ethers.provider);
  const checks = [];
  const check = (ok, msg) => checks.push([ok, msg]);

  const onChainOwners = await safe.getOwners();
  const gotSet = new Set(onChainOwners.map((o) => ethers.getAddress(o)));
  check(onChainOwners.length === owners.length,
    `owner count is ${owners.length} (got ${onChainOwners.length})`);
  for (const o of owners) {
    check(gotSet.has(o), `${o} is an owner`);
    check(await safe.isOwner(o), `isOwner(${o}) is true`);
  }
  check(!(await safe.isOwner(deployerAddr)), `the deployer is NOT an owner`);
  check(BigInt(await safe.getThreshold()) === threshold, `threshold is ${threshold}`);
  const version = await safe.VERSION();
  check(version === "1.4.1", `VERSION is 1.4.1 (got ${version})`);
  if (expectFresh) {
    check(BigInt(await safe.nonce()) === 0n, `nonce is 0 — nothing has executed`);
  }

  const slot0 = await ethers.provider.getStorage(safeAddr, 0);
  check(ethers.getAddress("0x" + slot0.slice(-40)) === SINGLETON,
    `singleton is SafeL2 ${SINGLETON}`);
  const handlerSlot = await ethers.provider.getStorage(safeAddr, FALLBACK_SLOT);
  check(ethers.getAddress("0x" + handlerSlot.slice(-40)) === FALLBACK,
    `fallback handler is ${FALLBACK}`);

  const [modules] = await safe.getModulesPaginated(SENTINEL, 10);
  check(modules.length === 0, `no modules installed (got ${modules.length})`);

  // The domain separator binds signatures to this address AND this chain, so a
  // signed Safe transaction cannot be replayed onto the mainnet Safe later.
  const expectedSep = ethers.TypedDataEncoder.hashDomain({ chainId, verifyingContract: safeAddr });
  check((await safe.domainSeparator()) === expectedSep,
    `domain separator binds chainId ${chainId} + this address`);

  let failed = 0;
  for (const [ok, msg] of checks) {
    console.log(`  ${ok ? "ok  " : "FAIL"} ${msg}`);
    if (!ok) failed++;
  }
  return failed;
}

// app.safe.global's chain prefixes, for the link; a chain not listed gets none.
const SAFE_APP_PREFIX = { 8453: "base", 84532: "basesep", 10: "oeth" };

function report(safeAddr, chainId, threshold, ownerCount) {
  console.log(`\n== SAFE VERIFIED — ${threshold}-of-${ownerCount} ==\n`);
  console.log(`    ${safeAddr}\n`);
  if (SAFE_APP_PREFIX[chainId]) {
    console.log(`  Open it at:  https://app.safe.global/home?safe=${SAFE_APP_PREFIX[chainId]}:${safeAddr}\n`);
  }
  if (chainId === 8453 || chainId === 84532 || chainId === 31337) {
    console.log(`  For deploy.js, as the token's root (the same Safe can be created at this`);
    console.log(`  address on any chain with these owners, threshold and salt nonce):\n`);
    console.log(`    GOVERNOR=${safeAddr}`);
    console.log(`    SAFE_SALT_NONCE=<the nonce used here>\n`);
    console.log(`  deploy.js stops after creating the token until this Safe executes the one`);
    console.log(`  transaction it prints, then is run again. handoff.js moves the admin.\n`);
  } else {
    console.log(`  If this is the token's root, the copy of SATORI on this chain now has its`);
    console.log(`  owner. Never run deploy.js here; deploy-remote-token.js is the token script.\n`);
  }
}

async function main() {
  const net = await ethers.provider.getNetwork();
  const chainId = Number(net.chainId);
  const dryRun = !!(process.env.SAFE_DRY_RUN || "").trim();
  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("No signer — set PRIVATE_KEY in .env");

  console.log(`\n  network   ${network.name} (chainId ${chainId})`);
  console.log(`  deployer  ${deployer.address}`);
  console.log(`  mode      ${dryRun ? "DRY RUN — simulate only, no transaction" : "LIVE — will send a transaction"}`);
  if (chainId === 8453) {
    console.log(`\n  !! BASE MAINNET. This Safe is intended to become the token's root: it`);
    console.log(`     receives the genesis supply and is root of every copy on every chain.`);
    console.log(`     Owners and threshold are set in this one transaction. Dry-run`);
    console.log(`     first and read the owner list back before signing.\n`);
  }

  // ---- inputs ----
  const owners = (process.env.SAFE_OWNERS || "")
    .split(",").map((s) => s.trim()).filter(Boolean)
    .map((a, i) => requireAddr(`SAFE_OWNERS[${i}]`, a));
  if (owners.length === 0) throw new Error("SAFE_OWNERS is required (comma-separated addresses).");

  const threshold = BigInt((process.env.SAFE_THRESHOLD || "").trim() || "0");
  if (threshold < 1n) throw new Error("SAFE_THRESHOLD is required and must be >= 1.");
  if (threshold > BigInt(owners.length)) {
    throw new Error(`SAFE_THRESHOLD ${threshold} exceeds owner count ${owners.length}.`);
  }
  const saltNonce = BigInt((process.env.SAFE_SALT_NONCE || "0").trim());

  const dupes = owners.filter((o, i) => owners.indexOf(o) !== i);
  if (dupes.length) throw new Error(`duplicate owner(s): ${[...new Set(dupes)].join(", ")}`);
  if (owners.some((o) => o === SENTINEL)) throw new Error("the sentinel address cannot be an owner");
  if (owners.map((o) => o.toLowerCase()).includes(deployer.address.toLowerCase())) {
    throw new Error(
      `the deployer ${deployer.address} is in SAFE_OWNERS. The deployer is a throwaway ` +
      `hot key (LAUNCH_CHECKLIST C5) and must not hold a share of the quorum.`
    );
  }

  console.log(`\n  threshold  ${threshold}-of-${owners.length}`);
  owners.forEach((o, i) => console.log(`  owner ${i + 1}    ${o}`));
  console.log(`  saltNonce  ${saltNonce}`);

  // ---- the Safe contracts must be the canonical ones ----
  console.log(`\n== canonical Safe 1.4.1 deployments ==`);
  for (const [label, addr] of [["SafeProxyFactory", FACTORY], ["SafeL2 (singleton)", SINGLETON], ["CompatibilityFallbackHandler", FALLBACK]]) {
    const size = ((await ethers.provider.getCode(addr)).length - 2) / 2;
    if (size === 0) throw new Error(`${label} has no code at ${addr} on chainId ${chainId}`);
    if (size !== EXPECTED_SIZE[addr]) {
      throw new Error(`${label} at ${addr} is ${size} bytes, expected ${EXPECTED_SIZE[addr]}`);
    }
    console.log(`  ok   ${label}  ${addr}  ${size} bytes`);
  }

  // ---- build the initializer ----
  const safeIface = new ethers.Interface(SAFE_ABI);
  const factory = new ethers.Contract(FACTORY, FACTORY_ABI, deployer);
  const initializer = safeIface.encodeFunctionData("setup", [
    owners,
    threshold,
    ethers.ZeroAddress, // to        — no delegatecall on setup
    "0x",               // data      — ditto
    FALLBACK,
    ethers.ZeroAddress, // paymentToken
    0,                  // payment
    ethers.ZeroAddress, // paymentReceiver
  ]);

  // ---- derive the address locally, then have the chain derive it too ----
  console.log(`\n== predicting the address ==`);
  const salt = ethers.solidityPackedKeccak256(
    ["bytes32", "uint256"], [ethers.keccak256(initializer), saltNonce]);
  const deploymentData = ethers.solidityPacked(
    ["bytes", "uint256"], [await factory.proxyCreationCode(), BigInt(SINGLETON)]);
  const predicted = ethers.getCreate2Address(FACTORY, salt, ethers.keccak256(deploymentData));
  console.log(`  local CREATE2 derivation   ${predicted}`);

  // Idempotent: CREATE2 makes the address a pure function of (owners, threshold,
  // handler, saltNonce), so a re-run with the same inputs lands on the same Safe.
  // Verify it rather than erroring — re-running this script is then a legitimate
  // way to re-confirm a Safe before naming it GOVERNOR. Bump SAFE_SALT_NONCE for
  // a genuinely separate Safe with the same owner set.
  if ((await ethers.provider.getCode(predicted)) !== "0x") {
    console.log(`\n  A Safe already exists at this address with these exact inputs.`);
    console.log(`  Verifying it instead of deploying; bump SAFE_SALT_NONCE for another.`);
    const failed = await verifySafe(predicted, owners, threshold, chainId, deployer.address);
    if (failed > 0) {
      console.error(`\n  ${failed} CHECK(S) FAILED — do NOT use this Safe.\n`);
      process.exit(1);
    }
    report(predicted, chainId, threshold, owners.length);
    return;
  }

  const simulated = ethers.getAddress("0x" + (await ethers.provider.call({
    from: deployer.address, to: FACTORY,
    data: factory.interface.encodeFunctionData("createProxyWithNonce", [SINGLETON, initializer, saltNonce]),
  })).slice(-40));
  console.log(`  chain eth_call simulation  ${simulated}`);
  if (simulated !== predicted) {
    throw new Error(`address derivations disagree: local ${predicted} vs simulated ${simulated}`);
  }
  console.log(`  ok   both derivations agree — setup() executes without reverting`);

  // ---- cost ----
  const gas = await factory.createProxyWithNonce.estimateGas(SINGLETON, initializer, saltNonce);
  const fee = await ethers.provider.getFeeData();
  const bal = await ethers.provider.getBalance(deployer.address);
  const cost = gas * (fee.maxFeePerGas ?? fee.gasPrice);
  console.log(`\n  gas ${gas}  @  ${ethers.formatUnits(fee.maxFeePerGas ?? fee.gasPrice, "gwei")} gwei`);
  console.log(`  cost ~${ethers.formatEther(cost)} ETH   deployer holds ${ethers.formatEther(bal)} ETH`);
  if (bal < cost) throw new Error(`deployer is short by ${ethers.formatEther(cost - bal)} ETH`);

  if (dryRun) {
    console.log(`\n== DRY RUN COMPLETE — nothing was sent ==`);
    console.log(`\n  Re-run without SAFE_DRY_RUN to deploy this Safe at:\n`);
    console.log(`    ${predicted}\n`);
    return;
  }

  // ---- deploy ----
  console.log(`\n== deploying ==`);
  const tx = await factory.createProxyWithNonce(SINGLETON, initializer, saltNonce);
  console.log(`  tx  ${tx.hash}`);
  const rcpt = await tx.wait();
  console.log(`  mined in block ${rcpt.blockNumber}, gas used ${rcpt.gasUsed}`);
  if (rcpt.status !== 1) throw new Error(`transaction reverted: ${tx.hash}`);

  // The receipt's ProxyCreation event is the authoritative address — the local
  // CREATE2 derivation is a prediction, and a prediction that silently diverged
  // would otherwise send us on to verify the wrong contract. Requiring the two to
  // agree is the third independent confirmation, after the local derivation and
  // the eth_call simulation.
  const proxyIface = new ethers.Interface([
    "event ProxyCreation(address indexed proxy, address singleton)",
  ]);
  let safeAddr = null;
  for (const log of rcpt.logs) {
    try {
      const p = proxyIface.parseLog(log);
      if (p?.name === "ProxyCreation") safeAddr = ethers.getAddress(p.args.proxy);
    } catch { /* not a ProxyCreation log */ }
  }
  if (!safeAddr) throw new Error(`no ProxyCreation event in receipt for ${tx.hash}`);
  console.log(`  ProxyCreation -> ${safeAddr}`);
  if (safeAddr !== predicted) {
    throw new Error(`deployed address ${safeAddr} != predicted ${predicted}`);
  }

  const size = await waitForCode(ethers.provider, safeAddr, { log: console.log });
  if (size === 0) {
    throw new Error(
      `no code at ${safeAddr} after polling, though tx ${tx.hash} succeeded and ` +
      `emitted ProxyCreation. Check the address on a block explorer before redeploying.`
    );
  }
  console.log(`  code at ${safeAddr}: ${size} bytes`);

  // ---- verify the FINISHED Safe on-chain, not the calls we just made ----
  const failed = await verifySafe(safeAddr, owners, threshold, chainId, deployer.address, true);
  if (failed > 0) {
    console.error(`\n  ${failed} CHECK(S) FAILED — do NOT use this Safe. Nothing points at`);
    console.error(`  it yet; fix the inputs and redeploy with a fresh SAFE_SALT_NONCE.\n`);
    process.exit(1);
  }
  report(safeAddr, chainId, threshold, owners.length);
}

main().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
