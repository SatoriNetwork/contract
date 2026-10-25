const { ethers, network } = require("hardhat");
const { clearSnapshots } = require("@nomicfoundation/hardhat-network-helpers");

// Fee recipients for tests: valid, non-placeholder, non-signer addresses (so the
// "fee recipient cannot claim" semantics the suite relies on are preserved).
// The platform fee is now the immutable token's dev fee — read the recipient via
// token.PLATFORM_FEE_RECIPIENT(); marketing via rewards.marketingFeeRecipient().
const TEST_PLATFORM_FEE_RECIPIENT = "0x000000000000000000000000000000000000FEE1";
const TEST_MARKETING_FEE_RECIPIENT = "0x000000000000000000000000000000000000FEE2";

// Deploys the restructured stack: immutable SatoriToken + UUPS SatoriEngine
// + SatoriHub + all five children EACH behind a SatoriProxy (phase 2:
// upgrade-with-state everywhere except the token), wired together.
// Mirrors the monolith fixture's children/adapters so the same scenarios run
// against both for differential parity testing.
// opts (optional): { rewardsAdmin, skipDefaultStream, skipNamedAdapter } — a
// rewards admin distinct from the deployer/governor (default the deployer), and
// escape hatches for tests that need the pre-initializeDefaultStream state or a
// stack whose Coined adapter is not wired (skipNamedAdapter implies
// skipDefaultStream). The old
// `votingCap` knob is gone: burn voting has no top-N cap, every game with
// weight earns in proportion to it.
// Deploy `name` behind a SatoriProxy: implementation (ctorArgs bakes any
// immutables + locks the raw instance), then the proxy with an atomic
// `initialize(initArgs)`. Returns the factory attached AT THE PROXY — the
// proxy address is THE contract address everywhere downstream
// (PHASE2-PROXY-ALL.md).
async function deployProxied(name, ctorArgs, initArgs) {
  const F = await ethers.getContractFactory(name);
  const impl = await F.deploy(...ctorArgs);
  await impl.waitForDeployment();
  const initData = F.interface.encodeFunctionData("initialize", initArgs);
  const proxy = await (await ethers.getContractFactory("SatoriProxy"))
    .deploy(await impl.getAddress(), initData);
  await proxy.waitForDeployment();
  return F.attach(await proxy.getAddress());
}

// SatoriMerkle in its SHIPPING shape: behind its own SatoriProxy, publisher and
// upgrade anchor set by `initialize` (2026-08-01 —
// docs/issues/closed/merkle-behind-a-proxy-decision.md). It has no working
// direct-deploy constructor by design, so this is the only way to build one.
async function deployMerkleProxied(rootPublisher, token) {
  return deployProxied("SatoriMerkle", [], [rootPublisher, token]);
}

async function deploySplitFixture(feeBps = 2000, opts = {}) {
  // RESET THE CHAIN, INCLUDING ITS CLOCK, before every stack.
  //
  // The hardhat clock only moves FORWARD and this suite is full of tests that
  // jump months. Without a reset, where a test STARTS depends on how much time
  // every file before it consumed — so a test's outcome depends on which files
  // ran first, which is a determinism bug regardless of what the protocol does.
  //
  // It was invisible for a long time because nothing in the contracts cared
  // which round they were deployed in. It still bit: two tests advanced the
  // clock by 43200s thinking that was a round (the 12h era) and passed anyway,
  // because the half-step crossed a boundary often enough by accident.
  // RewardDistributionAccuracy.test.js documents the symptom in a comment —
  // "dependent on accumulated chain time across the test suite" — and works
  // around it with an alignment helper rather than naming it.
  //
  // clearSnapshots() must go WITH the reset: `loadFixture` caches a snapshot id
  // and reverts to it on later calls, hardhat_reset invalidates those ids, and
  // the next loadFixture anywhere then dies with "Trying to restore an invalid
  // snapshot". Clearing the cache makes it re-run its fixture on the fresh chain.
  await network.provider.send("hardhat_reset");
  await clearSnapshots();

  const signers = await ethers.getSigners();
  const [owner] = signers; // owner == governor (and, by default, rewards admin)
  const rewardsAdmin = opts.rewardsAdmin ?? owner.address;

  // --- token first (immutable; children's initializers take it) ---
  // The token now carries the senior dev fee: its 2nd ctor arg is the immutable
  // PLATFORM_FEE_RECIPIENT. Point it at the owner (== governor) so the genesis
  // dev slice (144) + governor share (576) both land on the owner — owner's
  // balance stays exactly 720 as before, keeping every balance-conservation test
  // intact. The distinct-recipient guarantee is covered in test/next/DevFee.test.js.
  const token = await (await ethers.getContractFactory("SatoriToken"))
    // Third arg is HOME_CHAIN_ID: the live chain, so the fixture is always a
    // HOME deployment and every existing assertion about genesis supply and
    // emission holds unchanged. Off-home behaviour is covered in
    // test/next/SatoriToken.test.js.
    .deploy(owner.address, owner.address, (await ethers.provider.getNetwork()).chainId);
  await token.waitForDeployment();
  const tokenAddrEarly = await token.getAddress();

  // --- the airdrop: a plain contract, no proxy, bound to the token below ---
  // Its loader starts on the same key the rewards admin does, matching
  // scripts/deploy.js (REWARDS_ADMIN loads the table).
  const airdrop = await (await ethers.getContractFactory("SatoriAirdrop"))
    .deploy(tokenAddrEarly, rewardsAdmin);
  await airdrop.waitForDeployment();

  // --- children behind proxies (phase 2: upgrade-with-state) ---
  // Rewards no longer holds the platform fee (moved to the token): its ctor drops
  // initialFeeBps + platformFeeRecipient; it keeps only the marketing recipient.
  const voting = await deployProxied("SatoriVoting", [], [tokenAddrEarly]);
  // Marketing recipient passed twice on purpose: the ctor arg initializes the raw
  // implementation, the initialize arg sets the PROXY storage that is actually
  // read (and that the recipient can later rotate). Mirrors scripts/deploy.js.
  const rewards = await deployProxied("SatoriRewards",
    [await voting.getAddress(), rewardsAdmin, TEST_MARKETING_FEE_RECIPIENT],
    [await voting.getAddress(), rewardsAdmin, tokenAddrEarly, TEST_MARKETING_FEE_RECIPIENT]);
  const registry = await deployProxied("SatoriRegistry", [], [tokenAddrEarly]);
  const games = await deployProxied("SatoriGames", [], [tokenAddrEarly]);
  const bounties = await deployProxied("SatoriBounties", [], [tokenAddrEarly]);

  // --- engine impl + proxy (initialized without hub; hub wired after) ---
  const EngineFactory = await ethers.getContractFactory("SatoriEngine");
  const engineImpl = await EngineFactory.deploy();
  await engineImpl.waitForDeployment();
  const initData = EngineFactory.interface.encodeFunctionData("initialize", [
    tokenAddrEarly,
    await voting.getAddress(),
    await rewards.getAddress(),
    await registry.getAddress(),
    await games.getAddress(),
    await bounties.getAddress(),
  ]);
  const proxy = await (await ethers.getContractFactory("SatoriProxy"))
    .deploy(await engineImpl.getAddress(), initData);
  await proxy.waitForDeployment();
  const engine = EngineFactory.attach(await proxy.getAddress());

  // --- hub behind a proxy (implementation carries token/engine immutables) ---
  const hub = await deployProxied("SatoriHub",
    [tokenAddrEarly,
     await engine.getAddress(),
     await voting.getAddress(),
     await rewards.getAddress(),
     await registry.getAddress(),
     await games.getAddress(),
     await bounties.getAddress()],
    [await voting.getAddress(),
     await rewards.getAddress(),
     await registry.getAddress(),
     await games.getAddress(),
     await bounties.getAddress()]);

  const hubAddr = await hub.getAddress();
  const engineAddr = await engine.getAddress();
  const tokenAddr = await token.getAddress();

  // --- wiring ---
  await engine.connect(owner).setHub(hubAddr);
  await token.connect(owner).setController(hubAddr);
  await token.connect(owner).setHook(hubAddr);
  await token.connect(owner).setAirdrop(await airdrop.getAddress());

  await voting.setSatoriCore(hubAddr);
  await voting.setSatoriEngine(engineAddr);
  // (satoriToken already set by the proxy initializer)

  await rewards.setSatoriCore(hubAddr);
  await rewards.setSatoriEngine(engineAddr);
  await rewards.setSatoriBounties(await bounties.getAddress());

  await registry.setSatoriCore(hubAddr);
  await registry.setSatoriEngine(engineAddr);

  await games.setSatoriCore(hubAddr);

  await bounties.setSatoriCore(hubAddr);
  await bounties.setSatoriEngine(engineAddr);
  await bounties.setSatoriRewards(await rewards.getAddress());
  // (satoriToken already set by the proxy initializer)

  // Progressive-rollout capability flags default OFF at deploy (production
  // launches with only predict / vote / claim). Enable all of them here (bits
  // 0..7 => 0xff) so the full suite exercises every feature; capability-specific
  // tests toggle the bitmap themselves. Must run BEFORE the adapter registration
  // below. Flags + setter live on SatoriRewards (it owns the admin role).
  const adminSigner = signers.find((s) => s.address === rewardsAdmin) ?? owner;
  await (await rewards.connect(adminSigner).setCapabilities(0xff)).wait();

  // The hub pulls creation/adapter fees via transferFrom; approve it generously
  // from every signer so scenarios don't need per-call approvals.
  for (const s of signers) {
    await (await token.connect(s).approve(hubAddr, ethers.MaxUint256)).wait();
  }

  // --- adapters at canonical ids 1,2,3 (via the hub) ---
  const chainlinkAdapter = await (await ethers.getContractFactory("ChainlinkV3Adapter")).deploy(ethers.ZeroAddress);
  await chainlinkAdapter.waitForDeployment();
  const uniswapAdapter = await (await ethers.getContractFactory("UniswapV3Adapter")).deploy(ethers.ZeroAddress);
  await uniswapAdapter.waitForDeployment();
  const customAdapter = await (await ethers.getContractFactory("CustomAdapter")).deploy();
  await customAdapter.waitForDeployment();
  await hub.connect(owner).registerCommunityAdapter(await chainlinkAdapter.getAddress(), "Chainlink V3");
  await hub.connect(owner).registerCommunityAdapter(await uniswapAdapter.getAddress(), "Uniswap V3");
  await hub.connect(owner).registerCommunityAdapter(await customAdapter.getAddress(), "Custom");

  // --- the named-stream adapter (official; id read back, never hard-coded:
  // production registers Coined first so it lands at 5 there, 4 here) ---
  const coined = await (await ethers.getContractFactory("MockCoined")).deploy();
  await coined.waitForDeployment();
  const namedAdapter = await (await ethers.getContractFactory("NamedStreamAdapter"))
    .deploy(engineAddr, await registry.getAddress(), await coined.getAddress());
  await namedAdapter.waitForDeployment();
  const namedAdapterId = await registry.nextAdapterId();
  await hub.connect(adminSigner).registerAdapter(await namedAdapter.getAddress(), "Sentiment");
  // Must precede initializeDefaultStream: setNamedAdapterId requires nextStreamId == 1.
  if (!opts.skipNamedAdapter) await registry.connect(owner).setNamedAdapterId(namedAdapterId);

  // --- the DEFAULT stream/game at id 1, exactly as production deploys it ---
  // scripts/deploy.js calls this and asserts the default lands at id 1
  // (`DefaultStreamNotFirst`). Tests used to skip it, which left game id 1 as an
  // ordinary test-created game — harmless before, but NOT under burn voting:
  // SatoriVoting treats id 1 as the default, gives it a DERIVED 1% weight it
  // never earned, and rejects `vote()` on it (`CannotVoteDefault`). Initializing
  // here keeps the suite on the only configuration that can exist in production.
  //
  // CONSEQUENCE: the first stream a test creates is now id 2, not id 1.
  //
  // opts.skipDefaultStream leaves it uninitialized, for the handful of tests
  // that exercise the PRE-init state itself (e.g. the default-stream squat
  // guard, which must prove init reverts if someone grabbed id 1 first).
  if (!opts.skipDefaultStream && !opts.skipNamedAdapter) {
    await hub.connect(owner).initializeDefaultStream();
  }

  const lens = await (await ethers.getContractFactory("SatoriRewardsLens"))
    .deploy(hubAddr, await rewards.getAddress());
  await lens.waitForDeployment();

  // --- merkle proxy: deployed, deliberately NOT wired ---
  // Present so every proxy sweep (UpgradeLiveness, ProxyUpgrades, the layout
  // guard) covers the merkle channel like the other seven. NOT wired into the
  // hub: `setSatoriMerkle` is write-once, and the suites that exercise the
  // channel wire their own instance — pre-wiring here would take that one shot
  // away from them.
  const merklePublisher = signers[9];
  const merkle = await deployMerkleProxied(merklePublisher.address, tokenAddr);

  return {
    token, engine, hub, voting, rewards, registry, games, bounties, lens,
    airdrop, merkle, merklePublisher,
    owner, signers, chainlinkAdapter, uniswapAdapter, customAdapter,
    namedAdapter, namedAdapterId, coined,
  };
}

// ---------------------------------------------------------------------------
// Compatibility shim: expose the split stack as a monolith-shaped `satori`
// object so the existing suite can run against it. Routes each method to the
// token / engine / hub. State-based tests pass unchanged; tests that assert on
// events emitted BY `satori` or on `satori.getAddress()` being the core will
// need per-file adaptation (the emitting address / core-identity moved).
// ---------------------------------------------------------------------------

// Method -> which underlying contract serves it.
const ENGINE_METHODS = new Set([
  "predictMultipleWithPayloads", "predictMultipleWithReferral", "settlePrediction",
  "streaks", "predictions", "getLatestPrediction",
  "roundPredictionCount", "eligibilityRound", "predictedStreamsCount", "userPredictions",
]);
const TOKEN_METHODS = new Set([
  "balanceOf", "transfer", "transferFrom", "approve", "allowance", "totalSupply",
  "name", "symbol", "decimals", "deploymentBlock", "deploymentRound", "getCurrentRound",
  "hasParticipated", "airdropMintedTo", "totalRewardsMinted",
]);
// Views MIGRATED OFF SatoriHub in audit LA-4 and now owned by SatoriRewardsLens.
// Declared explicitly — matching ENGINE_METHODS / TOKEN_METHODS above — rather
// than letting the shim fall through to whichever contract happens to expose a
// name: routing stays reviewable, and a typo'd method fails loudly instead of
// silently resolving somewhere unintended.
const LENS_METHODS = new Set([
  "streamBurn", "gameBurn", "bountyBurn",
  "lockedUntil", "votingLockedUntil",
  "onChainRewardCeiling", "getValueChange", "streamExists",
  "satoriVoting", "satoriBounties", "satoriMerkle",
]);
// everything else (vote/claim/create/register/delegate/bounty/fees/merkle/getters) -> hub

// Preferred contract order for a given method; the shim returns the FIRST one
// that actually exposes it, so constants/getters on any layer resolve without
// enumerating them.
// `lens` is last in every order: the read-only views migrated off the hub in
// audit LA-4 (burn fees, lockedUntil, onChainRewardCeiling, getValueChange,
// streamExists, the satoriX() address aliases) now live on SatoriRewardsLens.
// Appending it here means those ~250 call sites resolve unchanged — the hub
// simply stopped being an intermediary for reads nothing on-chain consumes.
function routeOrder(prop, token, engine, hub, lens) {
  if (typeof prop === "string") {
    const base = prop.includes("(") ? prop.slice(0, prop.indexOf("(")) : prop;
    if (ENGINE_METHODS.has(base)) return [engine, token, hub];
    if (TOKEN_METHODS.has(base)) return [token, engine, hub];
    if (LENS_METHODS.has(base)) return [lens, hub];
  }
  return [hub, token, engine];
}

function makeSatoriShim(token, engine, hub, mergedIface, lens) {
  return new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === "connect") {
        return (s) => makeSatoriShim(token.connect(s), engine.connect(s), hub.connect(s), mergedIface, lens && lens.connect(s));
      }
      // The monolith's core address meant "the core" — the fee sink, the
      // fee-pulling spender, the privileged caller, the identity children
      // authorize. All of those are the HUB in the split (the token is just the
      // ERC20, reached by method dispatch). So satori.getAddress()/target = hub.
      if (prop === "getAddress") return async () => hub.getAddress();
      if (prop === "target") return hub.target;
      if (prop === "interface") return mergedIface;
      if (prop === "filters") return hub.filters;
      if (prop === "queryFilter") return hub.queryFilter.bind(hub);
      if (prop === "on" || prop === "off" || prop === "removeAllListeners") {
        return (...a) => hub[prop](...a);
      }
      for (const c of routeOrder(prop, token, engine, hub, lens)) {
        if (!c) continue;
        const v = c[prop];
        if (v === undefined) continue;
        // An ethers contract method is already bound and carries staticCall /
        // estimateGas / populateTransaction; `bind` would strip them, so a
        // `satori.x.staticCall(...)` would be undefined and a try/catch around
        // it would silently skip the call.
        if (typeof v === "function") return "staticCall" in v ? v : v.bind(c);
        return v;
      }
      return undefined;
    },
  });
}

async function deploySplitFixtureCompatIface(fix) {
  // Merge fragments across EVERY split contract (dedup; drop constructor/
  // receive/fallback) so `satori.interface` can decode any event or custom
  // error the stack emits — the monolith's core interface happened to declare
  // child events (DataStreamCreated, GameCreated, ...) so tests parse receipts
  // through it; the split emits them from the child contracts, so the shim
  // interface must span them all.
  const seen = new Set();
  const frags = [];
  const contracts = [fix.token, fix.engine, fix.hub, fix.voting, fix.rewards, fix.registry, fix.games, fix.bounties, fix.lens];
  for (const c of contracts) {
    for (const f of c.interface.fragments) {
      if (f.type === "constructor" || f.type === "receive" || f.type === "fallback") continue;
      const key = f.type + ":" + f.format();
      if (seen.has(key)) continue;
      seen.add(key);
      frags.push(f);
    }
  }
  return new ethers.Interface(frags);
}

async function deploySplitCompatFixture(feeBps = 2000, opts = {}) {
  const fix = await deploySplitFixture(feeBps, opts);
  const mergedIface = await deploySplitFixtureCompatIface(fix);
  const satori = makeSatoriShim(fix.token, fix.engine, fix.hub, mergedIface, fix.lens);
  return { ...fix, satori };
}

module.exports = {
  deploySplitFixture, deploySplitCompatFixture, makeSatoriShim, deployProxied, deployMerkleProxied,
  TEST_PLATFORM_FEE_RECIPIENT, TEST_MARKETING_FEE_RECIPIENT,
};
