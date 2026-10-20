// Deploy a REMOTE, bridge-only SatoriToken — the same bytecode at the same
// address as the home token, on a chain where it can never emit.
//
// This is NOT scripts/deploy.js. That one builds the full playable stack and
// only makes sense on the home chain. This one deploys the token and nothing
// else: no children, no engine, no hub, no adapters, no default stream. There is
// no game on a remote chain and there is not meant to be one.
//
// What makes such a deployment safe is mostly the bytecode. The token's
// HOME_CHAIN_ID gate closes the constructor's genesis mint, `setController`
// (and with it rewardMint / airdropMint / setLock / markParticipated) and
// `mintDevFee`. So supply can enter a remote deployment only through
// `crosschainMint`: from the SuperchainTokenBridge predeploy, or from a tier-2
// bridge the copy's root approves with setBridgeAuthority. That root is the home
// token's constructor root on every chain, whoever deploys the copy: on Base
// mainnet the association's Safe (M02). This script proves the gates landed and
// that the root Safe exists here, or prints how to create it.
//
// Config:
//   HOME_BOOK   path to the home address book   [default: ./deployments/base.json]
//   OUT         path to write this chain's book  [default: ./deployments/<network>.json]
//
// Everything else — governor, platform fee recipient, home chain id — is read
// FROM the home book, deliberately. Those three values are constructor args, so
// they are inside initCode, so they are inside the CREATE2 address. Re-entering
// them by hand is how you get a token at a different address that the bridge will
// never recognise, discovered long after the fact, on an immutable contract. The
// address is computed and compared against the home token BEFORE any gas is spent.
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

const ethers = hre.ethers;
const { runChecks, waitForHead, readPolicy } = require("./live-reads-lib");
const { ensureFactory, deployDeterministic, predictAddress, buildInitCode } = require("./create2-lib");

/// The OP Stack SuperchainTokenBridge predeploy the token hardcodes.
const SUPERCHAIN_BRIDGE = "0x4200000000000000000000000000000000000028";
const IERC7802_ID = "0x33331994";

/// Dig the 4-byte revert selector out of an error.
///
/// Every client nests this differently — the hardhat provider returns an OBJECT
/// at `e.data` with the hex one level further down, ethers wraps live-RPC errors
/// at `e.error.data`, some nodes put it under `e.info`. Checking only the first
/// shape silently yields "did not revert as expected" on a contract that
/// reverted perfectly, which is exactly the false alarm a deploy script must not
/// raise. Cost a debugging round on the first run of this script.
function revertSelector(e) {
  const candidates = [
    e?.data, e?.data?.data, e?.error?.data, e?.error?.data?.data,
    e?.info?.error?.data, e?.cause?.data,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.startsWith("0x") && c.length >= 10) return c.slice(0, 10);
  }
  return null;
}

/// A probe that passes when `fn` reverts with `errName`. Used to prove the
/// home-chain gates are LIVE on this chain, rather than inferring it from the
/// bytecode matching — the gates read block.chainid at call time, so the only
/// honest check is to call them.
///
/// Compares SELECTORS rather than parsing, so it cannot be defeated by a client
/// that hands back undecodable data.
function revertsWith(fn, errSignature) {
  const want = ethers.id(errSignature).slice(0, 10);
  return async () => {
    try { await fn(); return false; }        // did not revert at all — the gate is open
    catch (e) { return revertSelector(e) === want; }
  };
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const net = hre.network.name;
  const chainId = Number((await ethers.provider.getNetwork()).chainId);

  // --- 1. the home book is the single source of the constructor args ---
  const bookPath = process.env.HOME_BOOK || path.join(__dirname, "..", "deployments", "base.json");
  if (!fs.existsSync(bookPath)) {
    throw new Error(
      `No home address book at ${bookPath}.\n` +
      `A remote token must be built from the EXACT constructor args the home token used, or it\n` +
      `lands at a different address and the bridge will never recognise it. Deploy the home\n` +
      `stack first, or point HOME_BOOK at its deployments/<network>.json.`
    );
  }
  let book;
  try { book = JSON.parse(fs.readFileSync(bookPath, "utf8")); }
  catch (e) { throw new Error(`${bookPath} is unreadable: ${e.message}`); }

  // constructorArgs is what the home token's address is made of; older books
  // only have the same values under their deploy-time names.
  const args = book.constructorArgs ?? { root: book.governor, devRecipient: book.platformFeeRecipient, homeChainId: book.chainId };
  const homeChainId = Number(args.homeChainId);
  const governor = ethers.getAddress(args.root);
  const platformFeeRecipient = ethers.getAddress(args.devRecipient);
  const homeToken = ethers.getAddress(book.addresses.token);
  for (const [k, v] of Object.entries({ homeChainId, governor, platformFeeRecipient, homeToken })) {
    if (!v) throw new Error(`${bookPath} is missing ${k} — cannot reproduce the home token's address`);
  }

  // --- 2. refuse to run on the home chain ---
  // There the constructor WOULD mint genesis and every gate would be open, so
  // the post-conditions below would fail after the money was spent. Fail first.
  if (chainId === homeChainId) {
    throw new Error(
      `'${net}' IS the home chain (${chainId}). This script deploys a bridge-only token and\n` +
      `every one of its post-conditions assumes off-home behaviour. Use scripts/deploy.js.`
    );
  }

  console.log(`Deploying REMOTE SatoriToken to '${net}' (chainId ${chainId}) as ${deployer.address}`);
  console.log(`  home book: ${bookPath}  (home chain ${homeChainId})`);
  console.log(`  governor=${governor}`);
  console.log(`  platformFeeRecipient=${platformFeeRecipient}  (inert here — mintDevFee is home-gated)`);

  // --- 3. prove the address matches BEFORE spending anything ---
  const ctorArgs = [governor, platformFeeRecipient, homeChainId];
  const initCode = await buildInitCode(hre, "SatoriToken", ctorArgs);
  const predicted = predictAddress(ethers, initCode);
  if (predicted.toLowerCase() !== homeToken.toLowerCase()) {
    throw new Error(
      `ADDRESS MISMATCH — refusing to deploy.\n` +
      `  home token: ${homeToken}\n` +
      `  would get:  ${predicted}\n` +
      `SuperchainERC20 requires the SAME address on every chain; a mismatch means this token\n` +
      `could never receive a bridged transfer. The cause is always an input differing from the\n` +
      `home deploy (governor, platform fee recipient, home chain id, or the token bytecode\n` +
      `itself having changed since). Nothing has been spent. Reconcile before retrying.\n` +
      `Note: if the home token predates the CREATE2 change it was deployed with plain CREATE\n` +
      `and its address is nonce-derived — it can never be reproduced, and the home stack has\n` +
      `to be redeployed before any remote deployment is possible.`
    );
  }
  console.log(`  address check OK — ${predicted} matches the home token`);

  // --- 4. deploy ---
  await ensureFactory(hre, { log: console.log });
  const { address, alreadyDeployed } = await deployDeterministic(hre, "SatoriToken", ctorArgs, { log: console.log });
  if (alreadyDeployed) console.log("  (already present — verifying it rather than redeploying)");
  const token = await ethers.getContractAt("SatoriToken", address);

  // --- 5. is the bridge actually here yet? ---
  // Superchain interop had not shipped to mainnet as of 2026-08, so a dormant
  // lane is the EXPECTED state for a while. Report it plainly rather than
  // failing: the deployment is still correct, it just cannot move tokens yet.
  const bridgeCode = await ethers.provider.getCode(SUPERCHAIN_BRIDGE);
  console.log(bridgeCode === "0x"
    ? `  NOTE: no code at ${SUPERCHAIN_BRIDGE} — interop is not live on this chain yet, so the\n` +
      `        lane is DORMANT. The deployment is correct; it simply cannot receive until the\n` +
      `        interop upgrade lands. Nothing to fix.`
    : `  SuperchainTokenBridge present at ${SUPERCHAIN_BRIDGE} — the lane is live`);

  // --- 6. post-conditions: prove it is genuinely bridge-only ---
  console.log("Verifying post-conditions...");
  const eq = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
  const checks = [
    ["address matches the home token", async () => eq(address, homeToken)],
    ["HOME_CHAIN_ID points at the home chain", async () => Number(await token.HOME_CHAIN_ID()) === homeChainId],
    ["no genesis mint — total supply is zero", async () => (await token.totalSupply()) === 0n],
    ["no reward supply", async () => (await token.totalRewardsMinted()) === 0n],
    ["no dev fee minted", async () => (await token.devFeeMinted()) === 0n],
    ["no airdrop minted", async () => (await token.airdropMinted()) === 0n],
    ["controller unset", async () => eq(await token.controller(), ethers.ZeroAddress)],
    ["hook unset", async () => eq(await token.hook(), ethers.ZeroAddress)],
    ["governor matches home", async () => eq(await token.rootAuthority(), governor)],
    ["PLATFORM_FEE_RECIPIENT matches home", async () => eq(await token.PLATFORM_FEE_RECIPIENT(), platformFeeRecipient)],
    ["emission ceiling reads zero", async () => (await token.rewardCeiling()) === 0n],
    ["dev fee ceiling reads zero", async () => (await token.devFeeCeiling()) === 0n],
    ["advertises IERC7802", async () => await token.supportsInterface(IERC7802_ID)],
    // The two that matter most: the gates are read at call time, so calling them
    // is the only honest proof they are closed on THIS chain.
    ["setController is gated (NotHomeChain)",
      // Through the provider: the root is a Safe, not this signer, and ethers
      // refuses a `from` that is not its signer before anything is sent.
      revertsWith(() => token.connect(ethers.provider).setController.staticCall(deployer.address, { from: governor }), "NotHomeChain()")],
    ["mintDevFee is gated (NotHomeChain)",
      revertsWith(() => token.mintDevFee.staticCall(), "NotHomeChain()")],
  ];

  const policy = readPolicy(net);
  if (!policy.local && !alreadyDeployed) {
    await waitForHead(ethers.provider, await ethers.provider.getBlockNumber(), { log: console.log });
  }
  const { failed, lastError } = await runChecks(checks, { ...policy, log: console.log });
  if (failed.length) {
    for (const [name] of failed) {
      const why = lastError.get(name);
      console.error("  FAILED:", name + (why ? `  (${why})` : ""));
    }
    throw new Error(
      `${failed.length} post-condition(s) failed — this deployment is NOT safe to treat as ` +
      `canonical SATORI on '${net}'. Do not publish the address.`
    );
  }
  console.log(`  all ${checks.length} post-conditions passed`);

  // --- 6b. the root on this chain ---
  // The copy's root is the home root's address. Until a Safe exists at it here,
  // nobody can use the copy's slots: tier 2 stays closed, which is safe.
  const rootHere = (await ethers.provider.getCode(governor)) !== "0x";
  if (rootHere) {
    console.log(`  root ${governor} exists on this chain`);
  } else if (book.rootSafe) {
    console.log(`  root ${governor} does not exist on this chain yet. Create the same Safe here with:\n` +
      `    SAFE_OWNERS=${book.rootSafe.owners.join(",")} SAFE_THRESHOLD=${book.rootSafe.threshold} ` +
      `SAFE_SALT_NONCE=${book.rootSafe.saltNonce} npx hardhat run scripts/deploy-safe.js --network ${net}`);
  } else {
    console.log(`  root ${governor} has no code here, and the home book records no Safe setup to recreate it.`);
  }
  console.log(`  tier 2 here: no bridge authority until the root sets one. To close it on this chain for good\n` +
    `  (PATH_TO_LIVE 7.1), the root sends: to ${address} data ${token.interface.encodeFunctionData("freezeBridgeAuthority", [])}`);

  // --- 7. address book ---
  const out = process.env.OUT || path.join(__dirname, "..", "deployments", `${net}.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({
    network: net,
    chainId,
    kind: "remote-token",            // NOT a home stack — there is no game here
    homeChainId,
    homeBook: path.basename(bookPath),
    constructorArgs: { root: governor, devRecipient: platformFeeRecipient, homeChainId: String(homeChainId) },
    governor,
    platformFeeRecipient,
    rootSafePresent: rootHere,
    bridgeLive: bridgeCode !== "0x",
    addresses: { token: address },
  }, null, 2));
  console.log(`\nDeployed remote SATORI at ${address}`);
  console.log(`Address book -> ${out}`);
  return address;
}

main().catch((e) => { console.error(e); process.exit(1); });
