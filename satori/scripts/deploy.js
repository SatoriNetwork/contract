// Deploys the Satori restructured stack — immutable SatoriToken + UUPS
// SatoriEngine + SatoriHub + all five children EACH behind a SatoriProxy
// (phase 2: upgrade-with-state everywhere except the token) — and verifies
// every wiring post-condition before returning. Mirrors test/next/splitFixture.js as the single source of
// truth for the deploy sequence.
//
// Config via env (all addresses must be real — the SatoriRewards constructor
// rejects the old 0xdEaD/0xbEEF placeholders):
//   GOVERNOR            the token's root: seeds ALL SIX token authority slots
//                       (root, fee, upgrade, wiring, appoint, freeze). It is a
//                       constructor argument, so it is in the token's CREATE2
//                       address and is root of every copy anyone deploys on any
//                       chain. On Base it must be the association's Safe (M02):
//                       the run stops after creating the token until the Safe
//                       lends the deployer wiring and appoint, then is rerun.
//                       handoff.js takes them back.                [default: deployer; refused on Base]
//   SAFE_SALT_NONCE     the salt nonce GOVERNOR was created with (deploy-safe.js),
//                       to prove the Safe can be created at the same address on
//                       other chains                                         [default: 0]
//   SIGNER_KEYS         testnet convenience: Safe owner keys to execute the
//                       Safe's transaction from here instead of the Safe UI
//   REWARDS_ADMIN       must be the deployer while it runs (it registers the
//                       adapters); the SatoriRewards admin and the SatoriAirdrop
//                       loader start there and handoff.js moves them  [default: deployer]
//   PLATFORM_FEE_RECIPIENT   splitter A from deploy-splitters.js; read from its
//                       splitters-<network>.json when unset. Off local chains
//                       the tree is checked on chain before the token exists (M05).
//   MARKETING_FEE_RECIPIENT  marketing wallet for un-referred referral cut   [REQUIRED; Base: per chain in deploy-lib]
//   OFFICIAL_RELAYER    rewards.officialRelayer (the gasless relayer)  [default: per chain in deploy-lib, else unset]
//   ROOT_PUBLISHER      SatoriMerkle root publisher      [default: per chain in deploy-lib, else deployer]
//                       NOT a switch: the merkle channel is ALWAYS deployed.
//   ACTIVATION_WINDOW_BLOCKS  proof governor activation window              [default: 256]
//   VOTING_PERIOD_SECONDS     proof governor voting period                  [default: 604800 (7d)]
//                       Both voting paths ALWAYS deploy; the lock governor's
//                       proposer starts as GOVERNOR.
//   COINED_ADDRESS      the Coined contract named streams coin their names on,
//                       and the one CoinedAdapter reads prices from.
//                       REQUIRED on every real network (Coined launches on Base
//                       Sepolia before Satori); hardhat/localhost default to a
//                       MockCoined deployed here.
//   OUT                 path to write the address book JSON                  [default: ./deployments/<network>.json]
//                       written once the post-conditions pass; until then
//                       progress is in <OUT minus .json>.partial.json, which a
//                       rerun reads to adopt or verify what an earlier run built
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");
const { checkCoined } = require("./coined-probe");

const ethers = hre.ethers;
const PLACEHOLDER_PLATFORM = "0x000000000000000000000000000000000000dEaD";
const PLACEHOLDER_MARKETING = "0x000000000000000000000000000000000000bEEF";

function requireAddr(name, val, forbidden) {
  if (!val || !ethers.isAddress(val)) throw new Error(`${name} must be a valid address (got ${val})`);
  if (forbidden && val.toLowerCase() === forbidden.toLowerCase()) {
    throw new Error(`${name} is the forbidden placeholder ${forbidden} — set a real address`);
  }
  return ethers.getAddress(val);
}

async function deploy(factory, ...args) {
  const c = await (await ethers.getContractFactory(factory)).deploy(...args);
  await c.waitForDeployment();
  return c;
}

// SatoriHub.STREAM_BURN: the one fee the deploy pays (the Custom adapter's
// registration). A Safe root lends exactly this; a post-condition re-reads it.
const ADAPTER_FEE = ethers.parseEther("0.001");

// rewards.offchainShareBps at launch: the off-chain share of each round's residual.
const OFFCHAIN_SHARE_BPS = 5000;

// On a live network every read that follows a write is eventually consistent — a
// receipt is not a read barrier. Without this, a perfectly wired deploy can be
// declared NOT safe by a lagging node, after the money is spent, with "redeploy"
// as the obvious and completely wrong response. See live-reads-lib.js for the full
// reasoning and docs/issues/closed/rpc-read-after-write-lag-on-live-networks.md.
const { runChecks, waitForHead, readPolicy } = require("./live-reads-lib");
const { ensureFactory, deployDeterministic, predictAddress, buildInitCode } = require("./create2-lib");
const {
  SAFE, predictSafe, rootPolicy, adoption, delegationCalls, delegated, encodeMultiSend, txBuilderBatch, validateInputs,
  checkFeeTree, UNISWAP_V3_FACTORY, SEQUENCER_UPTIME_FEED, OFFICIAL_RELAYER, ROOT_PUBLISHER, MARKETING_FEE_RECIPIENT, requireDeployer, presetOr, ROOT_SAFE, COINED,
} = require("./deploy-lib");
const { execViaSafe } = require("./safe-exec");
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

/// Owners, threshold and whether createProxyWithNonce reproduces the address,
/// or null when `addr` is not a Safe.
async function readSafe(addr, saltNonce) {
  if ((await ethers.provider.getCode(addr)) === "0x") return null;
  const safe = new ethers.Contract(addr, [
    "function getOwners() view returns (address[])", "function getThreshold() view returns (uint256)"], ethers.provider);
  let owners, threshold;
  try { [owners, threshold] = await Promise.all([safe.getOwners(), safe.getThreshold()]); }
  catch { return null; }
  // A module can act as the Safe with no signatures; the singleton is what the
  // Safe runs (slot 0).
  let modules = [];
  try {
    [modules] = await new ethers.Contract(addr, ["function getModulesPaginated(address,uint256) view returns (address[],address)"],
      ethers.provider).getModulesPaginated("0x0000000000000000000000000000000000000001", 10);
  } catch { modules = ["(unreadable)"]; }
  const singleton = ethers.getAddress("0x" + (await ethers.provider.getStorage(addr, 0)).slice(26));
  let reproducible = false;
  try {
    const factory = new ethers.Contract(SAFE.factory, ["function proxyCreationCode() pure returns (bytes)"], ethers.provider);
    reproducible = same(predictSafe({ owners, threshold, saltNonce, proxyCreationCode: await factory.proxyCreationCode() }), addr);
  } catch { /* no factory on this chain */ }
  return { owners, threshold, reproducible, modules, singleton };
}

async function main() {
  const [deployer] = await ethers.getSigners();
  await requireDeployer(ethers.provider, deployer);
  const net = hre.network.name;

  const governor = ethers.getAddress(presetOr("GOVERNOR", ROOT_SAFE[Number((await ethers.provider.getNetwork()).chainId)]?.address) || deployer.address);
  // The deploy registers the adapters as the admin, so a run with another
  // admin could not finish; handoff.js moves the admin afterwards.
  if (process.env.REWARDS_ADMIN && !same(process.env.REWARDS_ADMIN, deployer.address)) {
    throw new Error(`REWARDS_ADMIN must be the deployer while deploy.js runs (it registers the adapters). ` +
      `Leave it unset and move the admin with handoff.js (NEW_ADMIN).`);
  }
  const rewardsAdmin = deployer.address;
  const { holderWindow, holderPeriod, rootPublisher: publisherEnv } = validateInputs(process.env);
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const rootPublisher = ROOT_PUBLISHER[chainId] ? ethers.getAddress(presetOr("ROOT_PUBLISHER", ROOT_PUBLISHER[chainId])) : publisherEnv;
  const delegating = !same(governor, deployer.address);

  // PLATFORM_FEE_RECIPIENT is splitter A, and it becomes an `immutable` on a token
  // with no upgrade path — the one value in this system that can never be
  // corrected. Phase 1 writes it to a file precisely so nobody has to retype it.
  //
  // If it is ALSO set in the environment the two must agree, and disagreeing is a
  // hard stop rather than a precedence rule: one of them is a typo, and picking a
  // winner would mean guessing which. This is the check the manual copy never had.
  const phase1Path = path.join(__dirname, "..", "deployments", `splitters-${net}.json`);
  let fromFile = null;
  let splittersFile = null;
  if (fs.existsSync(phase1Path)) {
    try {
      splittersFile = JSON.parse(fs.readFileSync(phase1Path, "utf8"));
      fromFile = ethers.getAddress(splittersFile.platformFeeRecipient);
    } catch (e) { throw new Error(`${phase1Path} exists but is unreadable: ${e.message}`); }
  }
  const fromEnv = (process.env.PLATFORM_FEE_RECIPIENT || "").trim()
    ? requireAddr("PLATFORM_FEE_RECIPIENT", process.env.PLATFORM_FEE_RECIPIENT, PLACEHOLDER_PLATFORM)
    : null;
  if (fromFile && fromEnv && fromFile !== fromEnv) {
    throw new Error(
      `PLATFORM_FEE_RECIPIENT disagrees with Phase 1 and this value is permanent:\n` +
      `  env  ${fromEnv}\n  file ${fromFile}  (${phase1Path})\n` +
      `Resolve it deliberately — unset the env var to use the deployed tree, or\n` +
      `delete/replace the file if you mean to point at a different splitter.`
    );
  }
  const platformFeeRecipient = fromEnv || fromFile;
  if (!platformFeeRecipient) {
    throw new Error(
      `PLATFORM_FEE_RECIPIENT is required. Run scripts/deploy-splitters.js first ` +
      `(it writes ${phase1Path}), or set it explicitly. See .env.example.`
    );
  }
  const marketingFeeRecipient = requireAddr("MARKETING_FEE_RECIPIENT",
    presetOr("MARKETING_FEE_RECIPIENT", MARKETING_FEE_RECIPIENT[chainId]), PLACEHOLDER_MARKETING);
  if (marketingFeeRecipient === ethers.ZeroAddress) throw new Error("MARKETING_FEE_RECIPIENT must not be the zero address");
  // The recipient takes its 5% by calling hub.claim itself, so a contract that cannot
  // send a transaction (a splitter, say) would strand the cut. A wallet or a Safe can.
  if ((await ethers.provider.getCode(marketingFeeRecipient)) !== "0x") {
    const safeLike = await new ethers.Contract(
      marketingFeeRecipient, ["function getThreshold() view returns (uint256)"], ethers.provider,
    ).getThreshold().then(() => true, () => false);
    if (!safeLike) {
      throw new Error(`MARKETING_FEE_RECIPIENT ${marketingFeeRecipient} is a contract that is not a Safe. ` +
        `It must be able to call hub.claim, or the 5% cut is stranded.`);
    }
  }
  const localChain = net === "hardhat" || net === "localhost";

  // The home chain is the chain this runs on: this script builds the playable
  // stack. A bridge-only copy elsewhere is deploy-remote-token.js.
  const homeChainId = BigInt(chainId);
  const ctorArgs = [governor, platformFeeRecipient, homeChainId];
  const tokenPredicted = predictAddress(ethers, await buildInitCode(hre, "SatoriToken", ctorArgs));
  const tokenExists = (await ethers.provider.getCode(tokenPredicted)) !== "0x";

  // The fee recipient becomes an immutable in the token: check on chain that it
  // is the tree deploy-splitters.js built, matching its file and the operator's
  // own PAYEE_* and SPLITTER_AUTHORITY_* inputs, running this repo's splitter
  // code (M05). Re-read on a live network so a lagging node is not taken for a
  // wrong tree; once the token exists its recipient is fixed, so it only warns.
  // Local stacks pay a plain address.
  if (!localChain) {
    const fromEnvOrNull = (n) => ((process.env[n] || "").trim() ? requireAddr(n, process.env[n]) : null);
    const expect = {
      payees: [1, 2, 3, 4].map((i) => fromEnvOrNull(`PAYEE_${i}`)),
      authorities: { C: fromEnvOrNull("SPLITTER_AUTHORITY_C"), B: fromEnvOrNull("SPLITTER_AUTHORITY_B") },
    };
    const Splitter = await ethers.getContractFactory("SatoriSplitterImmutable");
    const runtimeFor = async (threshold) => ethers.provider.call({
      data: (await Splitter.getDeployTransaction(deployer.address, ["0x0000000000000000000000000000000000000001",
        "0x0000000000000000000000000000000000000002"], [5000n, 5000n], threshold)).data });
    const pol = readPolicy(net);
    let tree;
    for (let attempt = 1; ; attempt++) {
      tree = await checkFeeTree(ethers.provider, platformFeeRecipient, splittersFile, chainId, { expect, runtimeFor });
      if (!tree.problems.length || attempt >= pol.attempts) break;
      await new Promise((r) => setTimeout(r, pol.delayMs));
    }
    if (splittersFile?.rejected) tree.problems.push(`deploy-splitters.js rejected this tree: ${splittersFile.rejected.join("; ")}`);
    else if (splittersFile && splittersFile.verified !== true) {
      console.warn("  WARNING: deploy-splitters.js did not confirm this tree (a read lagged); it is checked here instead.");
    }
    if (tree.problems.length && !tokenExists) {
      throw new Error(`PLATFORM_FEE_RECIPIENT ${platformFeeRecipient} is not the fee tree:\n  - ${tree.problems.join("\n  - ")}`);
    }
    for (const prob of tree.problems) console.warn(`  WARNING (the token's fee recipient is already fixed): ${prob}`);
    if (!tree.problems.length) {
      console.log("  fee tree checked: " +
        Object.entries(tree.split).map(([a, bps]) => `${a} ${Number(bps) / 100}%`).join(", ") + "; " +
        Object.entries(tree.branches).map(([l, b]) => `${l} authority ${b.authority}, threshold ${b.threshold} bps`).join("; "));
    }
  }

  const saltNonce = BigInt(presetOr("SAFE_SALT_NONCE", ROOT_SAFE[chainId]?.saltNonce) || "0");
  const safeInfo = await readSafe(governor, saltNonce);
  const rootRule = rootPolicy({ chainId, governor, deployer: deployer.address, safe: safeInfo, local: localChain });
  // Once the token exists its root is fixed, so the rule only warns: a Safe
  // owner change while the signatures were collected must not block finishing.
  for (const w of tokenExists ? [...rootRule.errors, ...rootRule.warnings] : rootRule.warnings) console.warn(`  WARNING: ${w}`);
  if (!tokenExists && rootRule.errors.length) throw new Error(`refusing to deploy:\n  - ${rootRule.errors.join("\n  - ")}`);
  if (delegating && !safeInfo) {
    throw new Error(`GOVERNOR ${governor} is neither the deployer nor a Safe; deploy.js cannot get the setup rights it needs.`);
  }
  const coinedEnv = (presetOr("COINED_ADDRESS", COINED[chainId]) || "").trim();
  if (!localChain && !coinedEnv) {
    throw new Error(
      `COINED_ADDRESS is required on '${net}': named streams coin their names on Coined, ` +
      `and the adapter is immutable. Deploy Coined first and set its address.`
    );
  }
  const coinedAddress = coinedEnv ? requireAddr("COINED_ADDRESS", coinedEnv) : null;
  // ChainlinkV3Adapter is immutable and its sequencer feed with it, so a wrong
  // value is a new adapter id: prove the feed answers before the first chain write.
  const factoryEnv = presetOr("UNISWAP_V3_FACTORY", UNISWAP_V3_FACTORY[chainId]);
  if (!localChain && !factoryEnv) {
    throw new Error(
      `UNISWAP_V3_FACTORY is required on '${net}': UniswapV3Adapter accepts only pools this factory created, ` +
      `and the adapter is immutable. Set the factory's address, or 'none' on a chain without Uniswap V3.`
    );
  }
  const uniswapFactory = factoryEnv && factoryEnv.toLowerCase() !== "none"
    ? requireAddr("UNISWAP_V3_FACTORY", factoryEnv) : ethers.ZeroAddress;
  if (uniswapFactory !== ethers.ZeroAddress && (await ethers.provider.getCode(uniswapFactory)) === "0x") {
    throw new Error(`UNISWAP_V3_FACTORY ${uniswapFactory} has no code on '${net}'.`);
  }
  const relayerEnv = presetOr("OFFICIAL_RELAYER", OFFICIAL_RELAYER[chainId]);
  const officialRelayer = relayerEnv ? requireAddr("OFFICIAL_RELAYER", relayerEnv) : ethers.ZeroAddress;
  const sequencerEnv = presetOr("SEQUENCER_UPTIME_FEED", SEQUENCER_UPTIME_FEED[chainId]);
  if (!localChain && !sequencerEnv) {
    throw new Error(
      `SEQUENCER_UPTIME_FEED is required on '${net}': Chainlink reads must stop while the ` +
      `L2 sequencer is down. Set Chainlink's uptime feed for this chain, or 'none' on a chain without a sequencer.`
    );
  }
  const sequencerFeed = sequencerEnv && sequencerEnv.toLowerCase() !== "none"
    ? requireAddr("SEQUENCER_UPTIME_FEED", sequencerEnv) : ethers.ZeroAddress;
  if (sequencerFeed !== ethers.ZeroAddress) {
    const probe = new ethers.Contract(sequencerFeed, ["function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)"], ethers.provider);
    const [, down, startedAt] = await probe.latestRoundData().catch(() => {
      throw new Error(`SEQUENCER_UPTIME_FEED ${sequencerFeed} does not answer latestRoundData() on '${net}'.`);
    });
    if (startedAt === 0n) throw new Error(`SEQUENCER_UPTIME_FEED ${sequencerFeed} has no round on '${net}'.`);
    if (down !== 0n) throw new Error(`SEQUENCER_UPTIME_FEED ${sequencerFeed} reports the sequencer down.`);
  }
  // The adapter's `coined` is immutable, so a wrong address is a redeploy:
  // prove there is code there before the first chain write.
  if (coinedAddress && (await ethers.provider.getCode(coinedAddress)) === "0x") {
    throw new Error(`COINED_ADDRESS ${coinedAddress} has no code on '${net}' — deploy Coined first.`);
  }
  if (coinedAddress) await checkCoined(ethers.provider, coinedAddress);

  console.log(`Deploying Satori (split) to '${net}' as ${deployer.address}`);
  console.log(`  governor=${governor} rewardsAdmin=${rewardsAdmin}`);
  console.log(`  platformFee=${platformFeeRecipient} marketingFee=${marketingFeeRecipient}`);
  console.log(`  platformFee came from: ${fromFile && fromEnv ? "env AND Phase 1 file — they agree"
    : fromFile ? `Phase 1 file (${path.basename(phase1Path)})` : "env only — no Phase 1 file on this network"}`);

  // Deploy `name` behind a SatoriProxy (phase 2, PHASE2-PROXY-ALL.md): the
  // implementation bakes any immutables + locks its raw instance; the proxy
  // initializes atomically. The PROXY address is the contract address.
  const impls = {};
  const NAMED_ADAPTER_ID = 5;
  const CAP_DELEGATE_PREDICTION = 5;
  async function deployProxied(name, key, ctorArgs, initArgs) {
    const F = await ethers.getContractFactory(name);
    const impl = await F.deploy(...ctorArgs);
    await impl.waitForDeployment();
    impls[key] = await impl.getAddress();
    const initData = F.interface.encodeFunctionData("initialize", initArgs);
    const proxy = await deploy("SatoriProxy", impls[key], initData);
    return F.attach(await proxy.getAddress());
  }

  // 1. immutable token FIRST (the children's initializers take it). The token's
  //    2nd arg is the immutable PLATFORM_FEE_RECIPIENT — the senior dev-fee sink;
  //    the 3rd is HOME_CHAIN_ID, the one chain allowed to emit.
  console.log(`  homeChainId=${homeChainId} (this chain)`);

  // CREATE2, not plain CREATE: SuperchainERC20 requirement 4 is that the token
  // sits at the same address on every chain, and a nonce-derived address cannot
  // be reproduced elsewhere. Only the TOKEN needs this — the children exist on
  // the home chain alone, so they stay on plain CREATE and their addresses are
  // unchanged. See scripts/create2-lib.js and docs/design/superchain-native-token.md.
  await ensureFactory(hre, { log: console.log });
  const { address: tokenAddr, alreadyDeployed } = await deployDeterministic(
    hre, "SatoriToken", ctorArgs, { log: console.log });
  const token = await ethers.getContractAt("SatoriToken", tokenAddr);
  // The token is created first, so a run that fails later leaves it behind; a
  // rerun takes it over and builds a fresh set of children (M06). Progress goes
  // to <book>.partial.json and the book is written only once the post-conditions
  // pass, so a failed run cannot overwrite an earlier book.
  const out = process.env.OUT || path.join(__dirname, "..", "deployments", `${net}.json`);
  const partial = out.replace(/\.json$/, "") + ".partial.json";
  let prior = fs.existsSync(partial) ? JSON.parse(fs.readFileSync(partial, "utf8")) : null;
  if (prior && !(Number(prior.chainId) === chainId && same(prior.addresses?.token, tokenAddr))) prior = null;

  let verifyOnly = false;
  if (alreadyDeployed) {
    const controller = await token.controller();
    // Fails closed: a controller with code that does not answer like a hub
    // stops the run rather than counting as unfinished.
    const controllerFinished = controller !== ethers.ZeroAddress
      && (await ethers.provider.getCode(controller)) !== "0x"
      && await (await ethers.getContractAt("SatoriHub", controller)).defaultStreamInitialized();
    const frozen = [];
    for (const [k, f] of [["controller", "controllerFrozen"], ["hook", "hookFrozen"]]) {
      if (await token[f]()) frozen.push(k);
    }
    if (controllerFinished && prior?.lastWriteBlock && same(prior.addresses.hub, controller)) {
      // The run that built this stack made its last write and then died: verify it.
      verifyOnly = true;
      console.log(`  the stack in ${path.basename(partial)} made its last write; verifying it instead of building`);
    } else {
      const d = adoption({ controller, controllerFinished, frozen });
      if (d.error) {
        throw new Error(`A SatoriToken already exists at ${tokenAddr} with these exact constructor args, and ${d.error}\n` +
          `To deploy a remote bridge-only token, use scripts/deploy-remote-token.js.`);
      }
      console.log(`  adopting the token at ${tokenAddr} from a run that did not finish; children it built, if any, ` +
        `are abandoned and the token is wired to new ones`);
    }
  }

  const A = verifyOnly ? { ...prior.addresses } : { token: tokenAddr };
  // The Safe's setup as the run that created the token found it; its owners may
  // have changed since, and copies elsewhere are recreated from this one.
  const rootSafe = prior?.rootSafe ?? (safeInfo?.reproducible
    ? { owners: safeInfo.owners, threshold: String(safeInfo.threshold), saltNonce: String(saltNonce) } : null);
  const publisher = verifyOnly ? prior.rootPublisher : (rootPublisher ?? deployer.address);
  let lastWriteBlock = verifyOnly ? prior.lastWriteBlock : null;
  function saveBook(extra = {}, file = partial) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      network: net, chainId, complete: false,
      // What the token's CREATE2 address is made of; deploy-remote-token.js
      // rebuilds copies from these, not from whoever holds a slot today.
      constructorArgs: { root: governor, devRecipient: platformFeeRecipient, homeChainId: String(homeChainId) },
      // How to create the root Safe at the same address on another chain.
      rootSafe, rootPublisher: publisher, lastWriteBlock,
      governor, rewardsAdmin, platformFeeRecipient, marketingFeeRecipient,
      addresses: A, ...extra,
    }, null, 2));
  }
  if (!verifyOnly) saveBook();

  // A Safe root lends the deployer the two slots the wiring needs and the one
  // fee, in one Safe transaction, sent only now that the token exists (signed
  // earlier, it could execute against an empty address and spend its nonce).
  if (delegating && !verifyOnly) {
    const readState = async () => ({
      wiring: await token.wiringAuthority(), appoint: await token.appointAuthority(),
      balance: await token.balanceOf(deployer.address),
    });
    if (!delegated(await readState(), deployer.address, ADAPTER_FEE)) {
      const calls = delegationCalls(token.interface, tokenAddr, deployer.address, ADAPTER_FEE);
      const data = encodeMultiSend(calls);
      const batchPath = out.replace(/\.json$/, "") + ".safe-delegation.json";
      fs.writeFileSync(batchPath, JSON.stringify(txBuilderBatch({
        chainId, safe: governor, name: "Satori deploy: lend setup rights to the deployer", calls }), null, 2));
      const keys = (process.env.SIGNER_KEYS || "").split(",").map((k) => k.trim()).filter(Boolean);
      if (!keys.length) {
        console.log(`\n  THE SAFE MUST NOW ACT. The token exists; the deploy needs the root Safe ${governor}`);
        console.log(`  to lend the deployer wiring and appoint, and send it ${ethers.formatEther(ADAPTER_FEE)} SATORI:`);
        for (const c of calls) console.log(`    ${c.label}`);
        console.log(`  As one Safe transaction (Transaction Builder batch: ${batchPath}), or raw:`);
        console.log(`    to        ${SAFE.multiSendCallOnly}  (MultiSendCallOnly 1.4.1)`);
        console.log(`    operation 1 (delegatecall)\n    data      ${data}`);
        console.log(`\n  Then run deploy.js again with the same inputs; it adopts this token and carries on.\n`);
        return A;
      }
      if (!hre.network.config.url) throw new Error("SIGNER_KEYS needs a network with a URL");
      console.log("  executing the Safe's delegation with SIGNER_KEYS (testnet convenience)...");
      await execViaSafe({ provider: new ethers.JsonRpcProvider(hre.network.config.url), safe: governor,
        to: SAFE.multiSendCallOnly, data, operation: 1, keys, relayerKey: process.env.RELAYER_KEY, log: console.log });
      const ok = await runChecks([["the Safe lent wiring, appoint and the fee",
        async () => delegated(await readState(), deployer.address, ADAPTER_FEE)]], { ...readPolicy(net), log: console.log });
      if (ok.failed.length) throw new Error("the Safe transaction ran but the deployer does not hold wiring, appoint and the fee");
    }
  }

  if (!verifyOnly) {
    // 1b. the airdrop — a plain contract, no proxy, no upgrade path, no table at
    //     deploy. The token's `airdrop` pointer (wired in step 5) is the only door
    //     through which airdrop SATORI can be minted. After deploy: load batches;
    //     each allocation is claimable the block it lands; finalizeAirdropLoading
    //     closes loading for good (docs/issues/airdrop-claim-at-finalize.md).
    //     The loader starts on REWARDS_ADMIN; handoff.js moves it.
    //     See docs/issues/airdrop-own-contract.md.
    const airdrop = await deploy("SatoriAirdrop", tokenAddr, rewardsAdmin);

    // 2. children — each behind its own proxy (upgrade-with-state). Rewards no
    //    longer holds the platform fee (moved to the immutable token): it keeps
    //    only the marketing recipient.
    const voting = await deployProxied("SatoriVoting", "voting", [], [tokenAddr]);
    // The marketing recipient is passed TWICE on purpose: the ctor arg initializes
    // the raw implementation (which the ctor also locks), and the initialize arg
    // sets the PROXY's storage — the copy that is actually read, and the one the
    // recipient can later rotate via transferMarketingFeeRecipient.
    const rewards = await deployProxied("SatoriRewards", "rewards",
      [await voting.getAddress(), rewardsAdmin, marketingFeeRecipient],
      [await voting.getAddress(), rewardsAdmin, tokenAddr, marketingFeeRecipient]);
    const registry = await deployProxied("SatoriRegistry", "registry", [], [tokenAddr]);
    const games = await deployProxied("SatoriGames", "games", [], [tokenAddr]);
    const bounties = await deployProxied("SatoriBounties", "bounties", [], [tokenAddr]);

    // 3. engine impl + proxy (initialized without hub; hub set after)
    const EngineFactory = await ethers.getContractFactory("SatoriEngine");
    const engineImpl = await EngineFactory.deploy();
    await engineImpl.waitForDeployment();
    const initData = EngineFactory.interface.encodeFunctionData("initialize", [
      tokenAddr, await voting.getAddress(), await rewards.getAddress(),
      await registry.getAddress(), await games.getAddress(), await bounties.getAddress(),
    ]);
    const proxy = await deploy("SatoriProxy", await engineImpl.getAddress(), initData);
    const engine = EngineFactory.attach(await proxy.getAddress());

    // 4. hub behind a proxy (implementation carries token/engine immutables)
    const hub = await deployProxied("SatoriHub", "hub",
      [tokenAddr, await engine.getAddress(),
       await voting.getAddress(), await rewards.getAddress(), await registry.getAddress(),
       await games.getAddress(), await bounties.getAddress()],
      [await voting.getAddress(), await rewards.getAddress(), await registry.getAddress(),
       await games.getAddress(), await bounties.getAddress()]);

    for (const [k, c] of Object.entries({ token, airdrop, engine: proxy, engineImpl, hub, voting, rewards, registry, games, bounties })) {
      A[k] = await c.getAddress();
    }
    for (const [k, v] of Object.entries(impls)) A[`${k}Impl`] = v;
    saveBook();
    // The fee a Safe root lent above, checked before the first wiring write, so
    // a mismatch is fixed by editing ADAPTER_FEE and rerunning (the token is adopted).
    if ((await hub.STREAM_BURN()) !== ADAPTER_FEE) {
      throw new Error(`SatoriHub.STREAM_BURN is ${await hub.STREAM_BURN()}, not deploy.js's ADAPTER_FEE ${ADAPTER_FEE}; update ADAPTER_FEE`);
    }

    // 5. wiring (the deployer holds the children's one-shot setters, and the
    //    token's wiring and appoint slots: as root, or lent by the Safe above)
    console.log("Wiring...");
    await (await engine.setHub(A.hub)).wait();
    await (await token.setController(A.hub)).wait();
    await (await token.setHook(A.hub)).wait();
    await (await token.setAirdrop(A.airdrop)).wait();
    await (await voting.setSatoriCore(A.hub)).wait();
    await (await voting.setSatoriEngine(A.engine)).wait();
    // (voting.satoriToken set by the proxy initializer)
    await (await rewards.setSatoriCore(A.hub)).wait();
    await (await rewards.setSatoriEngine(A.engine)).wait();
    await (await rewards.setSatoriBounties(A.bounties)).wait();
    await (await registry.setSatoriCore(A.hub)).wait();
    await (await registry.setSatoriEngine(A.engine)).wait();
    await (await games.setSatoriCore(A.hub)).wait();
    await (await bounties.setSatoriCore(A.hub)).wait();
    await (await bounties.setSatoriEngine(A.engine)).wait();
    await (await bounties.setSatoriRewards(A.rewards)).wait();
    // (bounties.satoriToken set by the proxy initializer)

    // 6. adapters at canonical ids 1..5. Order of the register calls fixes the
    //    ids, so keep it (Chainlink=1, Uniswap=2, Custom=3, Coined=4, Named=5).
    //    Chainlink / Uniswap / Coined are first-party code, so they register as
    //    OFFICIAL (registerAdapter, admin-only, no fee). That vouches for the code,
    //    not the source. Before approving a game, check the feed or pool a
    //    Chainlink or Uniswap stream names, and that a Coined term is deep enough
    //    that holding a move into the next block costs more than the game pays.
    //    Only Custom takes a community-SUPPLIED source, so it registers via the
    //    permissionless community path (registerCommunityAdapter, which charges
    //    streamBurn — hence the approve below) and is flagged isCommunity=true.
    console.log("Registering adapters...");
    const chainlink = await deploy("ChainlinkV3Adapter", sequencerFeed);
    const uniswap = await deploy("UniswapV3Adapter", uniswapFactory);
    const custom = await deploy("CustomAdapter");
    A.coined = coinedAddress ?? await (await deploy("MockCoined")).getAddress();
    const coinedAdapter = await deploy("CoinedAdapter", A.coined);
    const named = await deploy("NamedStreamAdapter", A.engine, A.registry, A.coined);
    await (await token.approve(A.hub, ADAPTER_FEE)).wait();
    await (await hub.registerAdapter(await chainlink.getAddress(), "Chainlink V3")).wait();
    await (await hub.registerAdapter(await uniswap.getAddress(), "Uniswap V3")).wait();
    await (await hub.registerCommunityAdapter(await custom.getAddress(), "Custom")).wait();
    await (await token.approve(A.hub, 0)).wait();
    await (await hub.registerAdapter(await coinedAdapter.getAddress(), "Coined price")).wait();
    await (await hub.registerAdapter(await named.getAddress(), "Sentiment")).wait();
    // Must precede initializeDefaultStream: setNamedAdapterId requires nextStreamId == 1.
    await (await registry.setNamedAdapterId(NAMED_ADAPTER_ID)).wait();
    // 6a. bootstrap the default prediction stream (id 1), straight after
    //     `setNamedAdapterId`: `initializeDefaultStream` is open to anyone from the
    //     moment the stack is wired, and a call before the named adapter is set
    //     would block Sentiment streams. Nothing later in the deploy needs it to
    //     wait.
    //
    // F8 fail-fast: the default stream MUST be the FIRST stream (initializeDefaultStream
    // reverts DefaultStreamNotFirst otherwise). A stream existing here means someone
    // front-ran createSimpleDataStream and grabbed id 1 — abort with a clear message
    // rather than a downstream revert. In practice unreachable: createSimpleDataStream
    // charges a SATORI burn and no third party holds SATORI before distribution, and
    // this whole deploy runs pre-distribution. See docs/issues/closed/default-stream-bootstrap-f8.md.
    //
    // Under burn voting the default game casts NO standing vote and the deploy no
    // longer pre-funds one: its weight is DERIVED (a fixed 1% share of the
    // round, DEFAULT_SHARE_BPS = 100, floored so genesis is non-zero) and `vote()` rejects it
    // outright with CannotVoteDefault.
    if (await registry.streamExists(1)) {
      throw new Error("F8: a stream already exists at id 1 before bootstrap — default-stream front-run detected; do NOT continue this deploy");
    }
    console.log("Bootstrapping default stream...");
    await (await hub.initializeDefaultStream()).wait();
    A.chainlinkAdapter = await chainlink.getAddress();
    A.uniswapAdapter = await uniswap.getAddress();
    A.customAdapter = await custom.getAddress();
    A.coinedAdapter = await coinedAdapter.getAddress();
    A.namedAdapter = await named.getAddress();
    saveBook();

    // 6.5. read-only lens (computed views for the dapp/indexers, incl.
    // getTotalClaimableRewards — moved off SatoriRewards, review #12).
    const lens = await deploy("SatoriRewardsLens", A.hub, A.rewards);
    A.lens = await lens.getAddress();
    console.log(`  lens=${A.lens}`);
    saveBook();

    // 7. merkle — ALWAYS deployed, behind its own proxy since 2026-08-01
    //    (docs/issues/closed/merkle-behind-a-proxy-decision.md). The PROXY is the channel
    //    address: it is what the write-once `setSatoriMerkle` binds to and what
    //    users claim against forever, so it is what goes in the address book.
    //    There is no direct-deploy path — `SatoriMerkle`'s constructor only locks
    //    the implementation; `initialize` sets the publisher and the upgrade anchor.
    //
    //    This used to be conditional on ROOT_PUBLISHER and was SKIPPED when unset,
    //    which produced a stack with no off-chain claim channel at all — and
    //    `setSatoriMerkle` is write-once, so it could not be added later without
    //    redeploying the whole stack. A rehearsal missing a piece of the system is
    //    not a rehearsal of the system. It is unconditional now (owner, 2026-09-03).
    //
    //    ROOT_PUBLISHER is therefore a choice of PUBLISHER, never a switch for
    //    whether the channel exists. Unset, it starts on the deployer exactly like
    //    the governor does, and handoff.js nominates it away with everything else.
    {
      const merkle = await deployProxied("SatoriMerkle", "merkle", [],
        [publisher, tokenAddr]);
      await (await merkle.setSatoriCore(A.hub)).wait();
      await (await hub.setSatoriMerkle(await merkle.getAddress())).wait();
      A.merkle = await merkle.getAddress();
      A.merkleImpl = impls.merkle; // the impl map was snapshotted into A before this step
      console.log(`  merkle=${A.merkle} impl=${A.merkleImpl} (publisher=${publisher}` +
        `${rootPublisher ? "" : " — DEPLOYER, unset ROOT_PUBLISHER; handoff.js moves it"})`);
    }
    saveBook();

    // 7.5. capability policy at launch: delegatePrediction ON, everything else OFF.
    //
    // Every capability still ships off EXCEPT this one, because delegation is no
    // longer only "hand your power to an expert" — it is how a user delegates to
    // THEIR OWN device-local key (the dapp's Game Wallet) and then plays without a
    // wallet popup every round. That setup is meant to be available from the first
    // block, so shipping the flag off would make the dapp's promoted onboarding
    // path dead on arrival and require a separate admin transaction before anyone
    // could use it.
    //
    // Scope: this grants delegation and NOTHING else. Stream/game creation,
    // adapters, bounties, claim delegation and voting all stay off for the public
    // and open later via scripts/set-capabilities.js per the rollout.
    //
    // setCapabilities is admin-only and takes the WHOLE bitmap; the deployer is
    // the admin until handoff.js.
    const launchBitmap = 1n << BigInt(CAP_DELEGATE_PREDICTION);
    console.log("Enabling launch capabilities (delegatePrediction)...");
    await (await rewards.setCapabilities(launchBitmap)).wait();

    // 7.6. reward split at launch: half of each round's predictor emission goes
    // to the off-chain Merkle channel, half stays on chain (owner, 2026-10-26).
    // Merkle is wired in step 7, which E2 requires before the share goes above 0.
    // emissionSplitAuthority is unset, so it falls to the admin, the deployer.
    console.log(`Setting the reward split: ${OFFCHAIN_SHARE_BPS / 100}% off chain...`);
    await (await rewards.setOffchainShareBps(OFFCHAIN_SHARE_BPS)).wait();
    if (officialRelayer !== ethers.ZeroAddress) {
      console.log(`Setting the official relayer: ${officialRelayer}...`);
      await (await rewards.setOfficialRelayer(officialRelayer)).wait();
    }

    // 8a. GOVERNANCE INSTRUMENTS — both holder-voting paths, deployed as part
    // of the stack so no chain ships without them (owner, 2026-09-15). Neither
    // holds authority over anything (docs/design/authority-map.md 10b); the
    // lock governor's one door is the hub's lane-B passthrough, wired here
    // while the deployer still holds the wiring slot. The lock governor's
    // proposer starts as `governor` (the root Safe on Base).
    //
    //   ACTIVATION_WINDOW_BLOCKS  [default 256]     proof governor, ~8.5 min on Base
    //   VOTING_PERIOD_SECONDS     [default 604800]  proof governor, 7 days
    console.log("Deploying governance instruments...");
    const holderGov = await deploy("HistoricalBalanceGovernor", A.token, holderWindow, holderPeriod);
    const lockGov = await deploy("LockVoteGovernor", A.token, A.hub, governor);
    A.holderGovernor = await holderGov.getAddress();
    A.lockVoteGovernor = await lockGov.getAddress();
    // Last state-changing write of the deploy, so its block is the read barrier the
    // post-conditions wait for: everything they verify was written at or before it.
    const lastWrite = await (await hub.setVoteLockGovernor(A.lockVoteGovernor)).wait();
    lastWriteBlock = lastWrite.blockNumber;
    console.log(`  holderGovernor=${A.holderGovernor} (window=${holderWindow} blocks, period=${holderPeriod}s)`);
    console.log(`  lockVoteGovernor=${A.lockVoteGovernor} (proposer=${governor})`);
    saveBook();
  }

  // 8b. local-dev only: the dapp hardcodes Multicall3 at its canonical
  // 0xcA11... address (universally deployed on real chains, absent on a
  // fresh hardhat chain). Deploy the minimal mock and hardhat_setCode its
  // runtime bytecode there so dapp batch reads resolve. Kept LAST among
  // deploys so the deterministic child addresses above stay stable.
  if (net === "localhost" || net === "hardhat") {
    console.log("Wiring Multicall3 mock at canonical address...");
    const MULTICALL3_ADDR = "0xcA11bde05977b3631167028862bE2a173976CA11";
    const mc3 = await deploy("Multicall3Mock");
    const mc3Code = await hre.network.provider.send("eth_getCode", [await mc3.getAddress(), "latest"]);
    await hre.network.provider.send("hardhat_setCode", [MULTICALL3_ADDR, mc3Code]);
    console.log(`  Multicall3Mock bytecode installed at ${MULTICALL3_ADDR}`);
  }

  // 9. POST-CONDITIONS — fail loudly if any wiring is wrong. Read through the
  //    recorded addresses, so a rerun can verify a stack an earlier run built.
  const at = (name, key) => ethers.getContractAt(name, A[key]);
  const [airdrop, engine, hub, voting, rewards, registry, games, bounties, lens, named, coinedAdapter, holderGov, lockGov] =
    await Promise.all([
      at("SatoriAirdrop", "airdrop"), at("SatoriEngine", "engine"), at("SatoriHub", "hub"), at("SatoriVoting", "voting"),
      at("SatoriRewards", "rewards"), at("SatoriRegistry", "registry"), at("SatoriGames", "games"),
      at("SatoriBounties", "bounties"), at("SatoriRewardsLens", "lens"), at("NamedStreamAdapter", "namedAdapter"),
      at("CoinedAdapter", "coinedAdapter"), at("HistoricalBalanceGovernor", "holderGovernor"),
      at("LockVoteGovernor", "lockVoteGovernor"),
    ]);
  console.log("Verifying post-conditions...");
  const eq = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
  // Progressive rollout: exactly ONE capability ships on — delegatePrediction,
  // which the dapp's Game Wallet onboarding needs from block one (see 7.5).
  // Every other flag must be OFF. capabilityAllowed(c, ZeroAddress) ==
  // enabled(c), since the admin is never the zero address. The admin opens the
  // rest later via rewards.setCapabilities(bitmap) per the roadmap.
  // Each check is a PROBE, not a pre-computed boolean, so a check that fails can
  // be re-read on its own. See runChecks() for why that matters on a live network.
  //
  // Probing 0..8 rather than 0..7 on purpose: 8 is past the last real capability
  // (CAP_VOTE == 7), and `capabilityAllowed` is a bare bit shift, so a stray high
  // bit would set and read back happily while gating nothing. Asserting it is
  // clear catches a mis-encoded bitmap that would otherwise look correct.
  const checks = [
    ["launch capability policy: ONLY delegatePrediction on", async () => {
      for (let c = 0; c <= 8; c++) {
        const on = await rewards.capabilityAllowed(c, ethers.ZeroAddress);
        if (on !== (c === CAP_DELEGATE_PREDICTION)) return false;
      }
      return true;
    }],
    ["offchainShareBps == 50% split", async () => (await rewards.offchainShareBps()) === BigInt(OFFCHAIN_SHARE_BPS)],
    ["officialRelayer == OFFICIAL_RELAYER", async () => eq(await rewards.officialRelayer(), officialRelayer)],
    ["token.controller == hub", async () => eq(await token.controller(), A.hub)],
    ["token.hook == hub", async () => eq(await token.hook(), A.hub)],
    // The airdrop lane: the token's pointer is the ONLY door, the contract
    // points back, the loader is where REWARDS_ADMIN said, and loading is open.
    ["token.airdrop == airdrop", async () => eq(await token.airdrop(), A.airdrop)],
    ["airdrop.token == token", async () => eq(await airdrop.token(), A.token)],
    ["airdrop.airdropAuthority == rewardsAdmin", async () => eq(await airdrop.airdropAuthority(), rewardsAdmin)],
    ["airdrop loading not finalized at deploy", async () => (await airdrop.airdropLoadingFinalized()) === false],
    // The constructor seeds EVERY slot with the root; a Safe root has lent
    // wiring and appoint to the deployer, and handoff.js pulls them all apart.
    // Checking only `root` here would pass a token whose other four slots were
    // somehow wrong, which is exactly the failure the split makes possible.
    [`token root, upgrade, freeze == governor; wiring, appoint == ${delegating ? "deployer (lent)" : "governor"}`, async () =>
      eq(await token.rootAuthority(), governor) &&
      eq(await token.upgradeAuthority(), governor) &&
      eq(await token.wiringAuthority(), delegating ? deployer.address : governor) &&
      eq(await token.appointAuthority(), delegating ? deployer.address : governor) &&
      eq(await token.freezeAuthority(), governor)],
    ["no root handoff pending at deploy", async () =>
      eq(await token.pendingRootAuthority(), ethers.ZeroAddress)],
    ["engine impl == deployed impl", async () => eq(await engine.implementation(), A.engineImpl)],
    ["voting.satoriCore == hub", async () => eq(await voting.satoriCore(), A.hub)],
    ["voting.satoriEngine == engine", async () => eq(await voting.satoriEngine(), A.engine)],
    ["voting.satoriToken == token", async () => eq(await voting.satoriToken(), A.token)],
    ["rewards.satoriCore == hub", async () => eq(await rewards.satoriCore(), A.hub)],
    ["rewards.satoriEngine == engine", async () => eq(await rewards.satoriEngine(), A.engine)],
    ["token.PLATFORM_FEE_RECIPIENT set", async () => eq(await token.PLATFORM_FEE_RECIPIENT(), platformFeeRecipient)],
    // The genesis dev seed is the REMAINDER after the general share is floored
    // onto its cap: `INITIAL_MINT - floor(INITIAL_MINT * 85%)`. DERIVED from the
    // token, never written out. History: this check has broken deploys twice by
    // lagging a rate change (86.4 -> 144 -> 288, and now a flat 15% of a
    // decaying emission), which is exactly what a literal here buys you.
    ["token dev fee genesis-seeded", async () => {
      const initial = await token.INITIAL_MINT();
      const bps = await token.devFeeBps();
      const general = (initial * (10000n - bps)) / 10000n;
      return (await token.devFeeMinted()) === initial - general;
    }],
    // Genesis is booked and minted in the same breath (M03): the token's
    // accrued counters equal its minted ones, and the hub's on-chain allowance
    // starts at the general share it may pay.
    ["token genesis accrued == minted", async () =>
      (await token.generalAccrued()) === (await token.generalMinted())
      && (await token.devFeeAccrued()) === (await token.devFeeMinted())],
    // initializeDefaultStream's first value priced the current round, so the
    // allowance already sits above the genesis share by that round's gross.
    ["hub lanes seeded from the token", async () =>
      (await hub.onChainMinted()) === (await token.generalMinted())
      && (await hub.onChainAllowance()) >= (await token.generalAccrued()) - (await hub.merkleReserveCumulative())],
    ["registry.satoriCore == hub", async () => eq(await registry.satoriCore(), A.hub)],
    ["registry.satoriEngine == engine", async () => eq(await registry.satoriEngine(), A.engine)],
    ["registry.namedAdapterId == 5 → NamedStreamAdapter", async () =>
      Number(await registry.namedAdapterId()) === NAMED_ADAPTER_ID
      && eq(await registry.adapter(NAMED_ADAPTER_ID), A.namedAdapter)],
    ["registry.adapter(4) == CoinedAdapter, reading COINED_ADDRESS", async () =>
      eq(await registry.adapter(4), A.coinedAdapter) && eq(await coinedAdapter.coined(), A.coined)],
    // Behavioural: the wired address answers like Coined (idOf is its id rule,
    // bytes left-aligned for names up to 32 bytes), not merely the one passed in.
    ["namedAdapter.coined answers like Coined", async () => {
      const probe = new ethers.Contract(await named.coined(), ["function idOf(string) view returns (bytes32)"], ethers.provider);
      return eq(await named.coined(), A.coined)
        && (await probe.idOf("Satori")) === ethers.zeroPadBytes(ethers.toUtf8Bytes("Satori"), 32);
    }],
    ["bounties.satoriToken == token", async () => eq(await bounties.satoriToken(), A.token)],
    ["hub.satoriRewards == rewards", async () => eq(await hub.satoriRewards(), A.rewards)],
    // phase-2 proxy plumbing: every proxied contract points at its deployed
    // implementation, upgrades start un-renounced, and the upgrade gate's
    // token pointer is wired.
    ["voting impl wired", async () => eq(await voting.implementation(), A.votingImpl)],
    ["rewards impl wired", async () => eq(await rewards.implementation(), A.rewardsImpl)],
    ["registry impl wired", async () => eq(await registry.implementation(), A.registryImpl)],
    ["games impl wired", async () => eq(await games.implementation(), A.gamesImpl)],
    ["bounties impl wired", async () => eq(await bounties.implementation(), A.bountiesImpl)],
    ["hub impl wired", async () => eq(await hub.implementation(), A.hubImpl)],
    ["no proxy pre-renounced (incl. engine)", async () => !(await engine.upgradesRenounced()) && !(await voting.upgradesRenounced()) && !(await rewards.upgradesRenounced()) && !(await registry.upgradesRenounced()) && !(await games.upgradesRenounced()) && !(await bounties.upgradesRenounced()) && !(await hub.upgradesRenounced()) ],
    ["rewards.satoriToken == token", async () => eq(await rewards.satoriToken(), A.token)],
    ["hub.satoriToken == token", async () => eq(await hub.satoriToken(), A.token)],
    ["registry.satoriToken == token", async () => eq(await registry.satoriToken(), A.token)],
    ["games.satoriToken == token", async () => eq(await games.satoriToken(), A.token)],
    ["default stream (id 1) exists", async () => await registry.streamExists(1)],
    ["default stream initialized on the hub", async () => await hub.defaultStreamInitialized()],
    ["default stream (id 1) is the Coined stream", async () => await registry.isNamedStream(1)],
    ["lens.satoriCore == hub", async () => eq(await lens.satoriCore(), A.hub)],
    ["lens.rewards == rewards", async () => eq(await lens.rewards(), A.rewards)],
    // F69: assert EVERY one-shot back-pointer wired in step 5 is non-zero and
    // correct. Each child's wiring setter is deployer-only and one-shot; a
    // correctly wired stack permanently spends every setter (they revert
    // AlreadySet). If a future edit dropped a wiring call, the pointer would
    // silently stay at address(0) with the deployer's one-shot authority still
    // live — these post-conditions make that fail the deploy instead (audit F69).
    ["engine.hub == hub", async () => eq(await engine.hub(), A.hub)],
    ["hub.engine == engine", async () => eq(await hub.engine(), A.engine)],
    ["engine.token == token", async () => eq(await engine.token(), A.token)],
    ["engine children are the deployed ones", async () =>
      eq(await engine.satoriVoting(), A.voting) && eq(await engine.satoriRewards(), A.rewards)
      && eq(await engine.satoriRegistry(), A.registry) && eq(await engine.satoriGames(), A.games)
      && eq(await engine.satoriBounties(), A.bounties)],
    ["namedAdapter.engine/registry are the deployed ones", async () =>
      eq(await named.engine(), A.engine) && eq(await named.registry(), A.registry)],
    ["registry.adapter(1..3) are Chainlink, Uniswap, Custom", async () =>
      eq(await registry.adapter(1), A.chainlinkAdapter) && eq(await registry.adapter(2), A.uniswapAdapter)
      && eq(await registry.adapter(3), A.customAdapter)],
    ["rewards.satoriBounties == bounties", async () => eq(await rewards.satoriBounties(), A.bounties)],
    ["games.satoriCore == hub", async () => eq(await games.satoriCore(), A.hub)],
    ["bounties.satoriCore == hub", async () => eq(await bounties.satoriCore(), A.hub)],
    ["bounties.satoriEngine == engine", async () => eq(await bounties.satoriEngine(), A.engine)],
    ["bounties.satoriRewards == rewards", async () => eq(await bounties.satoriRewards(), A.rewards)],
    // Unconditional: the channel is always deployed now, so a missing merkle is
    // a failure rather than a configuration. `A.merkle ? ... : []` here would
    // silently pass the exact deployment this change exists to prevent.
    ...[
      ["hub.merkle == merkle", async () => eq(await hub.merkle(), A.merkle)],
      ["merkle.satoriCore == hub", async () => eq(await (await ethers.getContractAt("SatoriMerkle", A.merkle)).satoriCore(), A.hub)],
      // The channel is now a proxy: hold it to what every other proxy is held
      // to, plus the publisher. A wrong `satoriToken` here is invisible until
      // the first attempted upgrade, by which time real entitlements exist.
      ["merkle impl wired", async () => eq(await (await ethers.getContractAt("SatoriMerkle", A.merkle)).implementation(), A.merkleImpl)],
      ["merkle.satoriToken == token", async () => eq(await (await ethers.getContractAt("SatoriMerkle", A.merkle)).satoriToken(), A.token)],
      ["merkle not pre-renounced", async () => !(await (await ethers.getContractAt("SatoriMerkle", A.merkle)).upgradesRenounced())],
      ["merkle.rootPublisher == publisher", async () => eq(await (await ethers.getContractAt("SatoriMerkle", A.merkle)).rootPublisher(), publisher)],
      ["merkle deployed at all", async () => !!A.merkle && (await ethers.provider.getCode(A.merkle)) !== "0x"],
    ],
  ];

  // Local runs keep exactly their old behaviour: one attempt, no barrier, no sleeps.
  const policy = readPolicy(net);
  if (!policy.local) {
    await waitForHead(ethers.provider, lastWriteBlock, { log: console.log });
  }
  // Governance instruments: read back what the chain believes about both
  // voting paths and the hub's one door. Probes, like everything above.
  checks.push(
    ["holderGovernor.TOKEN == token", async () =>
      eq(await holderGov.TOKEN(), A.token)],
    ["holderGovernor activation window as configured", async () =>
      Number(await holderGov.ACTIVATION_WINDOW()) === holderWindow],
    ["holderGovernor voting period as configured", async () =>
      Number(await holderGov.VOTING_PERIOD()) === holderPeriod],
    ["lockVoteGovernor.TOKEN == token", async () =>
      eq(await lockGov.TOKEN(), A.token)],
    ["lockVoteGovernor.HUB == hub", async () =>
      eq(await lockGov.HUB(), A.hub)],
    ["lockVoteGovernor.proposer == governor", async () =>
      eq(await lockGov.proposer(), governor)],
    ["hub.voteLockGovernor == lockVoteGovernor (the one lane-B door)", async () =>
      eq(await hub.voteLockGovernor(), A.lockVoteGovernor)],
  );

  const { passedOn, failed, lastError } = await runChecks(checks, { ...policy, log: console.log });
  if (failed.length) {
    for (const [name] of failed) {
      const why = lastError.get(name);
      console.error("  FAILED:", name + (why ? `  (${why})` : ""));
    }
    // Word this precisely. After ATTEMPTS re-reads spread over RETRY_MS each, a
    // still-failing check is a wiring fault, not a node that is behind — and the
    // operator needs to know which, because the responses are opposite: fix and
    // redeploy, versus wait and re-verify. Redeploying over lag costs a second
    // full stack (and on mainnet a second immutable PLATFORM_FEE_RECIPIENT).
    throw new Error(
      `${failed.length} post-condition(s) failed — deploy is NOT safe.` +
      (policy.attempts > 1
        ? ` Each was re-read ${policy.attempts}x over ~${(policy.attempts - 1) * policy.delayMs / 1000}s` +
          ` after the chain head reached block ${lastWriteBlock}, so this is a wiring` +
          ` fault, not RPC lag.`
        : "") +
      `\nOnce fixed, run deploy.js again with the same inputs: it verifies this stack rather than building another.`
    );
  }
  const lagged = [...passedOn.values()].filter((a) => a > 1).length;
  console.log(`  all ${checks.length} post-conditions passed` +
    (lagged ? `  (${lagged} confirmed only on a re-read — RPC lag, not a wiring fault)` : ""));
  console.log(
    `\nCapabilities: delegatePrediction (bit ${CAP_DELEGATE_PREDICTION}) ON; everything else OFF.\n` +
    "  Delegation ships on because the dapp's Game Wallet onboarding is built on it:\n" +
    "  a user delegates to their own device-local key and then predicts with no wallet popups.\n" +
    "  Open the rest later via rewards.setCapabilities(bitmap) — bit i = capability i,\n" +
    "  EIGHT capabilities at bits 0..7, so \"all on\" is 0xff (docs/design/capability-rollout.md).\n" +
    "  NOTE: voting is bit 7 and ships OFF, so until it is enabled only the admin can vote\n" +
    "  and no game but the protocol's own accrues any weight.\n" +
    `\nReward split: ${OFFCHAIN_SHARE_BPS / 100}% of each round's predictor emission off chain (Merkle), the rest on chain.`
  );

  // 10. write the address book (for the dapp / verification)

  // Record the two constructor-set immutables the DAPP needs, not just the
  // addresses. `deploymentRound` is what every round on screen is relative to
  // (display = absolute - deploymentRound + 1), and it was missing from the
  // book, so the dapp could only learn it by an async on-chain read. That read
  // is why the dashboard printed the raw chain round 41373 for the first frames
  // of a cold load on 2026-08-21. Written here it ships as a build-time
  // constant and the number is right at first paint, on the first visit ever.
  const deploymentRound = Number(await token.deploymentRound());
  const deploymentBlock = Number(await token.deploymentBlock());

  // RECORD THE DEPLOYED STORAGE LAYOUT. This is the only durable record of what
  // is actually in the proxies' storage, and it is what `check-upgrade-safety.js`
  // diffs a future upgrade candidate against.
  //
  // The committed baseline in storage-layouts/ cannot serve this purpose: it
  // tracks main and is legitimately re-snapshotted, while a deployment is frozen
  // at the commit that produced it. Letting those two drift apart, with nothing
  // recording the difference, is what bricked SatoriRewards on Base Sepolia on
  // 2026-08-30 (see the header of check-upgrade-safety.js).
  const { layoutOf, TRACKED } = require("./storage-layout-lib");
  const layouts = {};
  // The same layouts again, keyed by the implementation address that runs them,
  // so a later upgrade is checked against what the proxy is running NOW, not
  // against the deploy-time layout (M08). `deploy-impl.js` adds one per upgrade.
  const implLayouts = {};
  for (const fq of TRACKED) {
    const short = fq.split(":")[1];
    try {
      layouts[short] = await layoutOf(fq);
      const implAddr = A[short.replace(/^Satori/, "").replace(/^./, (c) => c.toLowerCase()) + "Impl"];
      if (implAddr) implLayouts[implAddr.toLowerCase()] = layouts[short];
    }
    catch (e) { console.warn(`  layout capture failed for ${short}: ${e.message}`); }
  }

  saveBook({ complete: true, deploymentRound, deploymentBlock, layouts, implLayouts }, out);
  fs.rmSync(partial, { force: true });
  console.log(`\nDeployed. Address book -> ${out}`);
  console.log(JSON.stringify(A, null, 2));
  return A;
}

main().catch((e) => { console.error(e); process.exit(1); });
