// smoke-dapp.js — proves the satori-ui dapp's ABIs + call SHAPES execute
// against a live local deploy (milestone A re-alignment).
//
// Strategy:
//   (a) deploy the fully-wired system via the test fixture (deploySatoriFixture),
//       which wires voting/rewards/registry/games/bounties/core and registers the
//       3 canonical adapters. Streams auto-create their type-0 binary game.
//   (b) load the dapp's ABIs from satori-ui/src/contracts/*.json and RE-INSTANTIATE
//       each contract at the fixture's deployed address using the DAPP's ABI — so we
//       exercise the dapp's ABIs, not the hardhat artifacts. Split-stack routing
//       mirrors the dapp facade: hub = user API/views, engine = predict, token = ERC20.
//   (c) exercise each dapp call SHAPE (reads first, then writes). Each call is
//       wrapped in try/catch and prints PASS/FAIL with the revert reason.
//
// The goal is NOT a full predict->score->claim economic cycle — it's that every
// dapp call SHAPE executes against the live contracts without an ABI/shape/keying
// revert. Run: npx hardhat run satori/scripts/smoke-dapp.js

const hre = require("hardhat");
const { ethers } = hre;
const path = require("path");
const { deploySatoriFixture } = require("../test/fixtures");

const ABI_DIR = path.resolve(__dirname, "../../satori-ui/src/contracts");
const loadAbi = (name) => require(path.join(ABI_DIR, `${name}.json`)).abi;

const results = [];
function record(ok, label, err) {
  if (ok) {
    results.push(`PASS — ${label}`);
    console.log(`PASS ${label}`);
  } else {
    const reason = decodeErr(err);
    results.push(`FAIL — ${label} — (${reason})`);
    console.log(`FAIL ${label}: ${reason}`);
  }
}

function decodeErr(err) {
  if (!err) return "unknown";
  // ethers v6 custom-error / revert surfaces
  return (
    err.shortMessage ||
    (err.revert && err.revert.name) ||
    err.reason ||
    (err.info && err.info.error && err.info.error.message) ||
    (err.message ? err.message.split("\n")[0] : String(err))
  );
}

// run a single labelled call shape; returns the value (or undefined on failure)
async function step(label, fn) {
  try {
    const v = await fn();
    record(true, label);
    return v;
  } catch (e) {
    record(false, label, e);
    return undefined;
  }
}

async function main() {
  console.log("=== smoke-dapp: dapp ABI/shape smoke test against live local deploy ===\n");

  // ---------------------------------------------------------------------------
  // (a) Deploy the fully-wired system via the fixture.
  // ---------------------------------------------------------------------------
  const fix = await deploySatoriFixture();
  const { satori, voting, rewards, registry, games, bounties, owner, signers } = fix;
  const { token: tokenC, engine: engineC } = fix;
  const user = signers[1] || owner; // a second signer for predict/referral shapes

  // The fixture does NOT call initializeDefaultStream; do it here so a default
  // stream (ID 1) + its auto-created binary game exist.
  try {
    await (await satori.initializeDefaultStream()).wait();
    console.log("initializeDefaultStream() done\n");
  } catch (e) {
    // Already initialized (idempotent guard) — fine.
    console.log("initializeDefaultStream() skipped:", decodeErr(e), "\n");
  }

  // Collect the fixture's deployed addresses.
  const addr = {
    satori: await satori.getAddress(), // the hub — the dapp's user-API surface
    engine: await engineC.getAddress(),
    token: await tokenC.getAddress(),
    voting: await voting.getAddress(),
    rewards: await rewards.getAddress(),
    registry: await registry.getAddress(),
    games: await games.getAddress(),
    bounties: await bounties.getAddress(),
  };
  console.log("Fixture deployed addresses:");
  for (const [k, v] of Object.entries(addr)) console.log(`  ${k}: ${v}`);
  console.log("");

  // ---------------------------------------------------------------------------
  // (b) Re-instantiate each contract at the fixture address using the DAPP's ABI.
  // ---------------------------------------------------------------------------
  // The lens is a stateless read facade the dapp instantiates as contracts.lens;
  // the fixture doesn't deploy it, so deploy one here (constructor: hub, rewards).
  const lensImpl = await (await ethers.getContractFactory("SatoriRewardsLens")).deploy(addr.satori, addr.rewards);
  await lensImpl.waitForDeployment();
  const dSatori   = new ethers.Contract(addr.satori,   loadAbi("SatoriHub"),      owner);
  const dLens     = new ethers.Contract(await lensImpl.getAddress(), loadAbi("SatoriRewardsLens"), owner);
  const dEngine   = new ethers.Contract(addr.engine,   loadAbi("SatoriEngine"),   owner);
  const dToken    = new ethers.Contract(addr.token,    loadAbi("SatoriToken"),    owner);
  const dRegistry = new ethers.Contract(addr.registry, loadAbi("SatoriRegistry"), owner);
  const dVoting   = new ethers.Contract(addr.voting,   loadAbi("SatoriVoting"),   owner);
  const dRewards  = new ethers.Contract(addr.rewards,  loadAbi("SatoriRewards"),  owner);
  const dGames    = new ethers.Contract(addr.games,    loadAbi("SatoriGames"),    owner);
  const dBounties = new ethers.Contract(addr.bounties, loadAbi("SatoriBounties"), owner);
  console.log("Re-instantiated all 8 contracts with the dapp's ABIs.\n");

  const DEFAULT_STREAM = 1;

  // ===========================================================================
  // READS (no state change) — verify shapes/keying first.
  // ===========================================================================
  console.log("--- READS ---");

  await step("registry.getDataStreamInfo(streamId) 6-field", async () => {
    const info = await dRegistry.getDataStreamInfo(DEFAULT_STREAM);
    // Must decode 6 fields: name, provider, streamType, value, valueHour, exists
    const fields = [info.name, info.provider, info.streamType, info.value, info.valueHour, info.exists];
    if (fields.length !== 6) throw new Error(`expected 6 fields, got ${fields.length}`);
    if (info.exists !== true) throw new Error("default stream not marked exists");
    return info;
  });

  // stream<->game 1:1: default stream's binary game id
  const defaultGameId = await step("games.binaryGameByStream(streamId) -> gameId", async () => {
    const gid = await dGames.binaryGameByStream(DEFAULT_STREAM);
    if (gid === 0n) throw new Error("no binary game for default stream");
    return gid;
  });

  // ---- W7 GAMES enumeration (reads) ----
  // nextGameTypeId() bounds the game-adapter type space: registered IDs are
  // 1 .. nextGameTypeId()-1 (0 reserved for the built-in binary game). With no
  // community game adapters registered yet, the fixture leaves this at 1.
  await step("games.nextGameTypeId() -> uint16", async () => {
    const n = await dGames.nextGameTypeId();
    if (n < 1n) throw new Error(`expected >=1 (sentinel), got ${n}`);
    return n;
  });

  // gamesByStream(streamId) enumerates ALL games on a stream. The default
  // stream auto-creates exactly one type-0 binary game, so its list must be
  // non-empty and include that binary game id.
  await step("games.gamesByStream(streamId) includes the auto binary game", async () => {
    const list = await dGames.gamesByStream(DEFAULT_STREAM);
    if (!Array.isArray(list) && list.length === undefined) {
      throw new Error("gamesByStream did not return an array");
    }
    if (list.length === 0) throw new Error("gamesByStream(default) is empty");
    if (defaultGameId !== undefined && !list.some((g) => g === defaultGameId)) {
      throw new Error(`gamesByStream(default) ${list} missing binary game ${defaultGameId}`);
    }
    return list;
  });

  // gameMeta(binaryGameByStream(streamId)) — the auto game is type-0 binary.
  await step("games.gameMeta(binaryGame).gameTypeId === 0", async () => {
    if (defaultGameId === undefined) throw new Error("no default binary game id captured");
    const meta = await dGames.gameMeta(defaultGameId);
    if (Number(meta.gameTypeId) !== 0) {
      throw new Error(`auto binary game type expected 0, got ${meta.gameTypeId}`);
    }
    if (Number(meta.dataStreamId) !== DEFAULT_STREAM) {
      throw new Error(`auto binary game dataStreamId expected ${DEFAULT_STREAM}, got ${meta.dataStreamId}`);
    }
    return meta;
  });

  // (rewards.feeSlot() smoke step removed 2026-08-31 — getter deleted with the
  //  dead fee storage it exposed.)
  await step("rewards.admin()", () => dRewards.admin());
  await step("rewards.PLATFORM_FEE_RECIPIENT()", () => dRewards.PLATFORM_FEE_RECIPIENT());
  await step("rewards.predictorFeeStored(addr)", () => dRewards.predictorFeeStored(owner.address));
  await step("rewards.getPredictionPower(addr)", () => dRewards.getPredictionPower(owner.address));
  await step("lens.getTotalClaimableRewards(addr)", () => dLens.getTotalClaimableRewards(owner.address));
  await step("rewards.referral(addr)", () => dRewards.referral(owner.address));

  // Burn voting: no heap, no eligible set, no ordering. The dapp's leaderboard
  // read is getGameWeights (game-id order; the client sorts) and weight is
  // whatever has been burnt for a game.
  await step("voting.weightOf(gameId)", () => dVoting.weightOf(defaultGameId ?? 1n));
  await step("voting.totalBurnedWeight()", () => dVoting.totalBurnedWeight());
  await step("voting.defaultDerivedWeight()", () => dVoting.defaultDerivedWeight());
  await step("voting.getGameWeights(offset,limit,round)",
    async () => dVoting.getGameWeights(1, 50, await dSatori.getCurrentRound()));

  await step("satori.getCurrentRound()", () => dSatori.getCurrentRound());
  await step("satori.streamBurn()", () => dSatori.streamBurn());
  await step("satori.gameBurn()", () => dSatori.gameBurn());
  await step("satori.bountyBurn()", () => dSatori.bountyBurn());
  await step("satori.streaks(user,gameId)", () => dSatori.streaks(owner.address, defaultGameId ?? 1n));
  await step("satori.getLatestPrediction(user,gameId)", () => dSatori.getLatestPrediction(owner.address, defaultGameId ?? 1n));

  // bounty reads (keyed by gameId,token)
  await step("bounties.pool(gameId,token)", () => dBounties.pool(defaultGameId ?? 1n, ethers.ZeroAddress));
  await step("bounties.ratePerRound(gameId,token)", () => dBounties.ratePerRound(defaultGameId ?? 1n, ethers.ZeroAddress));
  await step("bounties.stakeLockedUntil(user,token)", () => dBounties.stakeLockedUntil(owner.address, ethers.ZeroAddress));

  // ---- adapter enumeration (W5 STREAM adapter picker) ----
  // Enumeration lives on the registry: nextAdapterId() bounds the range, and
  // adapter(i)/adapterName(i)/isCommunityAdapter(i) describe each registered
  // adapter. Registered IDs are 1 .. nextAdapterId()-1. The fixture registers
  // the 3 canonical adapters (Chainlink=1, Uniswap=2, Custom=3).
  const adapterCount = await step("registry.nextAdapterId() -> uint16", async () => {
    const n = await dRegistry.nextAdapterId();
    if (n < 4n) throw new Error(`expected >=4 (3 canonical adapters + sentinel), got ${n}`);
    return n;
  });

  await step("registry adapter(i)/adapterName(i)/isCommunityAdapter(i) for canonical ids 1..3", async () => {
    for (let i = 1; i <= 3; i++) {
      const impl = await dRegistry.adapter(i);
      const name = await dRegistry.adapterName(i);
      const community = await dRegistry.isCommunityAdapter(i);
      if (impl === ethers.ZeroAddress) throw new Error(`adapter(${i}) impl is zero`);
      if (!name || name.length === 0) throw new Error(`adapterName(${i}) is empty`);
      if (typeof community !== "boolean") throw new Error(`isCommunityAdapter(${i}) not bool`);
      console.log(`    adapter ${i}: impl=${impl} name="${name}" community=${community}`);
    }
    return true;
  });

  // ---- W8 IStreamAdapterUIDescriptor (OPTIONAL UI metadata) on the canonical
  // STREAM adapters ----
  // Mirror of the W7 IGameUIDescriptor checks, but for STREAM adapters. The
  // descriptor is the dapp's PREFERRED source for rendering a stream's
  // create-config form (configSchema -> ConfigField[] / encodeConfigFromFields)
  // and its value display (valueDisplay -> decimals/unit/label). Instantiate
  // the descriptor at each adapter IMPL (impl = registry.adapter(id)) using the
  // DAPP's IStreamAdapterUIDescriptor ABI (not the hardhat artifact) and assert
  // every view via eth_call. All views are pure/view and must NEVER revert —
  // in particular Chainlink's valueDisplay must fall back gracefully for a
  // codeless (EOA / non-aggregator) target.

  // Chainlink (id 1): configSchema has one uint64 "maxFeedAge" field
  // (min "60", max "93600"); valueDisplay against a codeless EOA target must
  // return the fallback (decimals 8, label "Chainlink feed") WITHOUT reverting.
  await step("stream descriptor [Chainlink id 1]: schema(maxFeedAge uint64 60..93600) + valueDisplay EOA fallback", async () => {
    const impl = await dRegistry.adapter(1);
    if (impl === ethers.ZeroAddress) throw new Error("adapter(1) impl is zero");
    const desc = new ethers.Contract(impl, loadAbi("IStreamAdapterUIDescriptor"), owner);

    const ver = await desc.uiSchemaVersion();
    if (Number(ver) !== 1) throw new Error(`uiSchemaVersion expected 1, got ${ver}`);

    const cfgSchema = await desc.configSchema();
    const parsed = JSON.parse(cfgSchema);
    if (!parsed.fields || parsed.fields.length === 0) {
      throw new Error(`configSchema fields empty, got ${cfgSchema}`);
    }
    const f0 = parsed.fields[0];
    if (f0.key !== "maxFeedAge") throw new Error(`fields[0].key expected "maxFeedAge", got "${f0.key}"`);
    if (f0.type !== "uint64") throw new Error(`fields[0].type expected "uint64", got "${f0.type}"`);
    if (f0.min !== "60") throw new Error(`fields[0].min expected "60", got "${f0.min}"`);
    if (f0.max !== "93600") throw new Error(`fields[0].max expected "93600", got "${f0.max}"`);

    // owner.address is a signer EOA (codeless) — exercises the extcodesize
    // short-circuit fallback. Must NOT revert.
    const [decimals, unit, label] = await desc.valueDisplay(owner.address, "0x");
    if (Number(decimals) !== 8) throw new Error(`valueDisplay decimals expected 8, got ${decimals}`);
    if (label !== "Chainlink feed") throw new Error(`valueDisplay label expected "Chainlink feed", got "${label}"`);
    if (unit !== "") throw new Error(`valueDisplay unit expected "", got "${unit}"`);
    return true;
  });

  // Uniswap (id 2): configSchema fields === []; valueDisplay (pure) is the
  // fixed tuple (0, "tick", "Uniswap V3 8h TWAP tick").
  await step('stream descriptor [Uniswap id 2]: schema fields===[] + valueDisplay (0,"tick","Uniswap V3 8h TWAP tick")', async () => {
    const impl = await dRegistry.adapter(2);
    if (impl === ethers.ZeroAddress) throw new Error("adapter(2) impl is zero");
    const desc = new ethers.Contract(impl, loadAbi("IStreamAdapterUIDescriptor"), owner);

    const ver = await desc.uiSchemaVersion();
    if (Number(ver) !== 1) throw new Error(`uiSchemaVersion expected 1, got ${ver}`);

    const parsed = JSON.parse(await desc.configSchema());
    if (!Array.isArray(parsed.fields) || parsed.fields.length !== 0) {
      throw new Error(`configSchema fields expected [], got ${JSON.stringify(parsed.fields)}`);
    }

    const [decimals, unit, label] = await desc.valueDisplay(owner.address, "0x");
    if (Number(decimals) !== 0) throw new Error(`valueDisplay decimals expected 0, got ${decimals}`);
    if (unit !== "tick") throw new Error(`valueDisplay unit expected "tick", got "${unit}"`);
    if (label !== "Uniswap V3 8h TWAP tick") throw new Error(`valueDisplay label expected "Uniswap V3 8h TWAP tick", got "${label}"`);
    return true;
  });

  // Custom (id 3): configSchema fields === []; valueDisplay (pure) is the
  // fixed tuple (0, "", "Custom value").
  await step('stream descriptor [Custom id 3]: schema fields===[] + valueDisplay (0,"","Custom value")', async () => {
    const impl = await dRegistry.adapter(3);
    if (impl === ethers.ZeroAddress) throw new Error("adapter(3) impl is zero");
    const desc = new ethers.Contract(impl, loadAbi("IStreamAdapterUIDescriptor"), owner);

    const ver = await desc.uiSchemaVersion();
    if (Number(ver) !== 1) throw new Error(`uiSchemaVersion expected 1, got ${ver}`);

    const parsed = JSON.parse(await desc.configSchema());
    if (!Array.isArray(parsed.fields) || parsed.fields.length !== 0) {
      throw new Error(`configSchema fields expected [], got ${JSON.stringify(parsed.fields)}`);
    }

    const [decimals, unit, label] = await desc.valueDisplay(owner.address, "0x");
    if (Number(decimals) !== 0) throw new Error(`valueDisplay decimals expected 0, got ${decimals}`);
    if (unit !== "") throw new Error(`valueDisplay unit expected "", got "${unit}"`);
    if (label !== "Custom value") throw new Error(`valueDisplay label expected "Custom value", got "${label}"`);
    return true;
  });

  // ===========================================================================
  // WRITES — minimal valid setup for each shape.
  // ===========================================================================
  console.log("\n--- WRITES ---");

  // ---- W5 community adapter registration + adapter-backed stream ----
  // This block runs FIRST among the writes ON PURPOSE: registerCommunityAdapter
  // pulls streamBurn() SATORI from the caller via an ERC20 _transfer, and
  // SatoriToken._update reverts Locked() while the caller's balance is prediction-
  // locked. The predictMultipleWithPayloads step below sets owner.lockedUntil =
  // round+1, so the registration MUST happen before that lock is taken.
  //
  // Deploy a FRESH CustomAdapter instance (trivial, no-arg ctor) and register
  // it as a community adapter via the core. The AdapterRegistered event is
  // emitted by the REGISTRY (not the hub), so parse it via dRegistry.interface
  // — the dapp's SatoriHub ABI does not even carry that event.
  let newAdapterId;
  await step("satori.registerCommunityAdapter(impl, name) [fresh CustomAdapter]", async () => {
    const CustomAdapterFactory = await ethers.getContractFactory("CustomAdapter");
    const newCustomAdapter = await CustomAdapterFactory.deploy();
    await newCustomAdapter.waitForDeployment();
    const implAddr = await newCustomAdapter.getAddress();

    const before = await dRegistry.nextAdapterId();
    const tx = await dSatori.registerCommunityAdapter(implAddr, "Smoke Community Adapter");
    const rcpt = await tx.wait();

    // Parse AdapterRegistered (emitted on the registry) for the assigned id.
    for (const log of rcpt.logs) {
      try {
        const parsed = dRegistry.interface.parseLog(log);
        if (parsed && parsed.name === "AdapterRegistered") {
          newAdapterId = Number(parsed.args.adapterId);
          break;
        }
      } catch (_) {}
    }
    // Fallback: the assigned id is the pre-registration nextAdapterId.
    if (newAdapterId === undefined) newAdapterId = Number(before);

    const after = await dRegistry.nextAdapterId();
    if (after !== before + 1n) throw new Error(`nextAdapterId did not increment: ${before} -> ${after}`);
    if (newAdapterId !== Number(before)) throw new Error(`assigned id ${newAdapterId} != expected ${before}`);
    return newAdapterId;
  });

  await step("registry.isCommunityAdapter(newId) === true", async () => {
    if (newAdapterId === undefined) throw new Error("no new adapter id captured");
    const community = await dRegistry.isCommunityAdapter(newAdapterId);
    if (community !== true) throw new Error(`isCommunityAdapter(${newAdapterId}) = ${community}`);
    const impl = await dRegistry.adapter(newAdapterId);
    if (impl === ethers.ZeroAddress) throw new Error(`adapter(${newAdapterId}) impl is zero`);
    return community;
  });

  // Create a stream against the new community adapter via the generic adapter
  // path. CustomAdapter.validate only rejects a zero target, so owner.address
  // is an acceptable provider/target. config = "0x" (ignored by CustomAdapter).
  let adapterStreamId, adapterGameId;
  await step("satori.createAdapterDataStream(string,uint16,address,bytes) [community adapter]", async () => {
    if (newAdapterId === undefined) throw new Error("no new adapter id captured");
    const tx = await dSatori["createAdapterDataStream(string,uint16,address,bytes)"](
      "CommunityStream", newAdapterId, owner.address, "0x"
    );
    const rcpt = await tx.wait();
    for (const log of rcpt.logs) {
      try {
        const parsed = dRegistry.interface.parseLog(log);
        if (parsed && parsed.name === "DataStreamCreated") {
          adapterStreamId = Number(parsed.args.streamId);
          break;
        }
      } catch (_) {}
    }
    if (adapterStreamId === undefined) {
      adapterStreamId = Number(await dRegistry.getDataStreamCount());
    }
    return adapterStreamId;
  });

  // Auto game must exist for the adapter-backed stream (stream<->game 1:1).
  await step("games.binaryGameByStream(adapterStreamId) > 0 (auto game)", async () => {
    if (adapterStreamId === undefined) throw new Error("no adapter stream id captured");
    adapterGameId = await dGames.binaryGameByStream(adapterStreamId);
    if (adapterGameId === 0n) throw new Error(`no binary game auto-created for adapter stream ${adapterStreamId}`);
    return adapterGameId;
  });

  // ---- plain stream creates (the dapp's default create path) ----
  // These two writes BOTH charge streamBurn() SATORI from owner via the
  // core's _transfer, so they MUST run while owner is still unlocked — i.e.
  // before the owner-locking binary predict further below. They sit here
  // alongside the other pre-lock fee-charging writes (W5 community adapter,
  // W7 game adapter) ON PURPOSE.
  //
  // A create makes exactly ONE stream and its game.
  await step('satori.createSimpleDataStream(name, provider, 1440) creates one stream', async () => {
    const before = Number(await dRegistry.getDataStreamCount());
    const tx = await dSatori.createSimpleDataStream("SMOKE/PLAIN", owner.address, 1440);
    await tx.wait();
    const after = Number(await dRegistry.getDataStreamCount());
    if (after - before !== 1) {
      throw new Error(`expected exactly one stream, got ${after - before}`);
    }
    return after;
  });

  // The adapter twin, against the fresh community adapter.
  await step('satori.createAdapterDataStream(..., 1440) [community adapter] creates one stream + game', async () => {
    if (newAdapterId === undefined) throw new Error("no new community adapter id captured");
    const before = Number(await dRegistry.getDataStreamCount());
    let adapterStreamId;
    const tx = await dSatori["createAdapterDataStream(string,uint16,address,bytes,uint24)"](
      "CommunityPlain", newAdapterId, owner.address, "0x", 1440
    );
    const rcpt = await tx.wait();
    for (const log of rcpt.logs) {
      try {
        const parsed = dRegistry.interface.parseLog(log);
        if (parsed && parsed.name === "DataStreamCreated") { adapterStreamId = Number(parsed.args.streamId); break; }
      } catch (_) {}
    }
    const after = Number(await dRegistry.getDataStreamCount());
    if (after - before !== 1) {
      throw new Error(`expected exactly one stream, got ${after - before}`);
    }
    // Auto binary game must exist (stream<->game 1:1).
    const autoGame = await dGames.binaryGameByStream(adapterStreamId);
    if (autoGame === 0n) throw new Error(`no binary game for adapter stream ${adapterStreamId}`);
    return adapterStreamId;
  });

  // streams(streamId-1).config returns the adapter config bytes. For the adapter
  // stream created from the canonical Chainlink adapter (id 1) with
  // abi.encode(uint64 maxFeedAge), this must be NON-EMPTY. We create that
  // Chainlink stream here (still pre-lock, owner pays the spam fee) and assert
  // .config decodes back to the uint64 we encoded.
  await step("streams(streamId-1).config is the non-empty config bytes for a Chainlink adapter stream", async () => {
    const maxFeedAge = 3600n;
    const config = ethers.AbiCoder.defaultAbiCoder().encode(["uint64"], [maxFeedAge]);
    // ChainlinkV3Adapter.validate probes the target via latestRoundData() at
    // CREATE time, so the target must be a v3-conforming aggregator (a codeless
    // EOA would revert the staticcall). Deploy a MockChainlinkAggregator — its
    // default round is healthy, so validate passes.
    const MockAgg = await ethers.getContractFactory("MockChainlinkAggregator");
    const agg = await MockAgg.deploy();
    await agg.waitForDeployment();
    const aggAddr = await agg.getAddress();
    // Chainlink adapter id is 1 (canonical).
    const tx = await dSatori["createAdapterDataStream(string,uint16,address,bytes)"](
      "CHAINLINK/CFG", 1, aggAddr, config
    );
    const rcpt = await tx.wait();
    let chainlinkStreamId;
    for (const log of rcpt.logs) {
      try {
        const parsed = dRegistry.interface.parseLog(log);
        if (parsed && parsed.name === "DataStreamCreated") {
          chainlinkStreamId = Number(parsed.args.streamId);
          break;
        }
      } catch (_) {}
    }
    if (chainlinkStreamId === undefined) chainlinkStreamId = Number(await dRegistry.getDataStreamCount());

    // Read config BY NAME — the StreamMeta struct has other fields before
    // config, so named access is reorder-proof.
    const meta = await dRegistry.streams(chainlinkStreamId - 1);
    const storedConfig = meta.config;
    if (!storedConfig || storedConfig === "0x" || storedConfig.length <= 2) {
      throw new Error(`streams(${chainlinkStreamId - 1}).config is empty, got "${storedConfig}"`);
    }
    // Round-trips back to the uint64 we encoded.
    const [decoded] = ethers.AbiCoder.defaultAbiCoder().decode(["uint64"], storedConfig);
    if (decoded !== maxFeedAge) {
      throw new Error(`config decoded to ${decoded}, expected ${maxFeedAge}`);
    }
    return storedConfig;
  });

  // createSimpleDataStream(name, provider) — auto-creates the binary game.
  // owner is the provider so it can later call setValue. owner holds the
  // bootstrap mint, so it can cover streamBurn().
  let newStreamId, gameId;
  const created = await step("satori.createSimpleDataStream(name, provider)", async () => {
    const tx = await dSatori.createSimpleDataStream("SMOKE/USD", owner.address);
    const rcpt = await tx.wait();
    // Resolve the new stream id from the DataStreamCreated event (most reliable).
    for (const log of rcpt.logs) {
      try {
        const parsed = dRegistry.interface.parseLog(log);
        if (parsed && parsed.name === "DataStreamCreated") {
          newStreamId = Number(parsed.args.streamId);
          break;
        }
      } catch (_) {}
    }
    if (newStreamId === undefined) {
      // Fallback: newest stream is the last by count.
      newStreamId = Number(await dRegistry.getDataStreamCount());
    }
    return tx;
  });

  // Confirm a binary game auto-created for the new stream (stream<->game 1:1).
  await step("games.binaryGameByStream(newStreamId) > 0 (auto-created game)", async () => {
    gameId = await dGames.binaryGameByStream(newStreamId);
    if (gameId === 0n) throw new Error(`no binary game auto-created for stream ${newStreamId}`);
    return gameId;
  });

  // registry.setProvider(streamId, addr) — keep owner as provider (set to self
  // is allowed) so the setValue below stays authorized.
  await step("registry.setProvider(streamId, addr)", async () => {
    const tx = await dRegistry.setProvider(newStreamId, owner.address);
    await tx.wait();
    return tx;
  });

  // Games are born unapproved; owner is the rewards admin, so approve the
  // fresh binary game before voting on it (vote reverts GameNotApproved
  // otherwise).
  await step("voting.setGameApproved(gameId, true) [admin]", async () => {
    const tx = await dVoting.setGameApproved(gameId, true);
    await tx.wait();
    return tx;
  });

  // vote(uint32 gameId, uint256 amount) — burns the amount for weight.
  await step("satori.vote(gameId, amount)", async () => {
    const tx = await dSatori.vote(gameId, ethers.parseEther("1"));
    await tx.wait();
    return tx;
  });

  // setValue so a value exists (provider-only; owner is the provider).
  // First write on a fresh stream has no cadence guard.
  await step("registry.setValue(streamId, value)", async () => {
    const tx = await dRegistry.setValue(newStreamId, 1000);
    await tx.wait();
    return tx;
  });

  // ---- W7 GAME-adapter registration + games-per-stream + adapter predict ----
  // This whole block runs BEFORE the owner's balance-locking binary predict
  // below. registerCommunityGameAdapter (streamBurn) and createGame (gameBurn)
  // each pull SATORI from the caller via an ERC20 _transfer (voting is free), and
  // SatoriToken._update reverts Locked() once owner.lockedUntil is set by a predict.
  // Mirrors how the W5 community-adapter registration above is sequenced ahead
  // of the lock. owner holds the bootstrap mint, so it covers every fee here.
  //
  // The adapter predict (YES) is issued from `user` (a second signer), NOT
  // owner: predictMultipleWithPayloads enforces a GLOBAL one-batch-per-round
  // lock per address, so reusing owner here would collide with the binary
  // predict below (AlreadyPredicted). owner funds `user` with SATORI for
  // prediction power while owner is still unlocked.
  //
  // Game-adapter events (GameAdapterRegistered / GameCreated) are declared on
  // SatoriGames, so parse receipts via dGames.interface (the hub ABI does not
  // carry them); fall back to dSatori.interface.
  let newGameType, aboveBelowGameId, yesNoImplAddr;
  const ABOVE_BELOW_THRESHOLD = 500; // value 1000 (set above) > 500 => YES wins at score time

  await step("satori.registerCommunityGameAdapter(impl, name) [fresh YesNoGame]", async () => {
    const YesNoGameFactory = await ethers.getContractFactory("YesNoGame");
    // The adapter's "core" (its record/score caller) is the ENGINE, not the hub.
    const yesNo = await YesNoGameFactory.deploy(
      addr.engine, addr.games, addr.registry);
    await yesNo.waitForDeployment();
    const implAddr = await yesNo.getAddress();
    yesNoImplAddr = implAddr; // hoist for the IGameUIDescriptor checks below

    const before = await dGames.nextGameTypeId();
    const tx = await dSatori.registerCommunityGameAdapter(implAddr, "Yes/No");
    const rcpt = await tx.wait();

    // Parse GameAdapterRegistered (emitted on the games contract) for the id.
    for (const log of rcpt.logs) {
      try {
        const parsed = dGames.interface.parseLog(log);
        if (parsed && parsed.name === "GameAdapterRegistered") {
          newGameType = Number(parsed.args.gameTypeId);
          break;
        }
      } catch (_) {}
    }
    if (newGameType === undefined) {
      // Fallback via the core's interface, then the pre-registration value.
      for (const log of rcpt.logs) {
        try {
          const parsed = dSatori.interface.parseLog(log);
          if (parsed && parsed.name === "GameAdapterRegistered") {
            newGameType = Number(parsed.args.gameTypeId);
            break;
          }
        } catch (_) {}
      }
    }
    if (newGameType === undefined) newGameType = Number(before);

    const after = await dGames.nextGameTypeId();
    if (after !== before + 1n) throw new Error(`nextGameTypeId did not increment: ${before} -> ${after}`);
    if (newGameType !== Number(before)) throw new Error(`assigned type ${newGameType} != expected ${before}`);
    return newGameType;
  });

  await step("games.isCommunityGameAdapter(newType) === true", async () => {
    if (newGameType === undefined) throw new Error("no new game type captured");
    const community = await dGames.isCommunityGameAdapter(newGameType);
    if (community !== true) throw new Error(`isCommunityGameAdapter(${newGameType}) = ${community}`);
    const impl = await dGames.gameAdapter(newGameType);
    if (impl === ethers.ZeroAddress) throw new Error(`gameAdapter(${newGameType}) impl is zero`);
    return community;
  });

  // createGame(streamId, gameTypeId, gameConfig, name) on the existing stream.
  // YesNoGame config = abi.encode(['int128'],[threshold]) (32 bytes); caller
  // (owner) becomes the game authority.
  await step("satori.createGame(streamId, newType, abi.encode(int128 threshold), name)", async () => {
    if (newGameType === undefined) throw new Error("no new game type captured");
    const cfg = ethers.AbiCoder.defaultAbiCoder().encode(["int128"], [ABOVE_BELOW_THRESHOLD]);
    const tx = await dSatori.createGame(newStreamId, newGameType, cfg, "Above/Below");
    const rcpt = await tx.wait();
    for (const log of rcpt.logs) {
      try {
        const parsed = dGames.interface.parseLog(log);
        if (parsed && parsed.name === "GameCreated") {
          aboveBelowGameId = Number(parsed.args.gameId);
          break;
        }
      } catch (_) {}
    }
    if (aboveBelowGameId === undefined) {
      for (const log of rcpt.logs) {
        try {
          const parsed = dSatori.interface.parseLog(log);
          if (parsed && parsed.name === "GameCreated") {
            aboveBelowGameId = Number(parsed.args.gameId);
            break;
          }
        } catch (_) {}
      }
    }
    if (aboveBelowGameId === undefined) {
      aboveBelowGameId = Number(await dGames.gameCount());
    }
    return aboveBelowGameId;
  });

  await step("games.gamesByStream(streamId) now includes the new game", async () => {
    if (aboveBelowGameId === undefined) throw new Error("no adapter game id captured");
    const list = await dGames.gamesByStream(newStreamId);
    if (!list.some((g) => Number(g) === aboveBelowGameId)) {
      throw new Error(`gamesByStream(${newStreamId}) ${list} missing new game ${aboveBelowGameId}`);
    }
    return list;
  });

  await step("games.gameMeta(newGameId).gameTypeId === newType", async () => {
    if (aboveBelowGameId === undefined) throw new Error("no adapter game id captured");
    const meta = await dGames.gameMeta(aboveBelowGameId);
    if (Number(meta.gameTypeId) !== newGameType) {
      throw new Error(`gameMeta type expected ${newGameType}, got ${meta.gameTypeId}`);
    }
    if (Number(meta.dataStreamId) !== newStreamId) {
      throw new Error(`gameMeta dataStreamId expected ${newStreamId}, got ${meta.dataStreamId}`);
    }
    return meta;
  });

  // Voting on an ADAPTER (type > 0) game is rejected outright now — only
  // type-0 binary games are mint-eligible/votable. Assert the revert.
  await step("satori.vote(newGameId, amount) reverts GameNotMintEligible [adapter game]", async () => {
    if (aboveBelowGameId === undefined) throw new Error("no adapter game id captured");
    try {
      const tx = await dSatori.vote(aboveBelowGameId, ethers.parseEther("1"));
      await tx.wait();
    } catch (e) {
      // The dapp hub ABI does not carry the voting child's errors, so match
      // the decoded name OR the raw selector of GameNotMintEligible().
      const reason = decodeErr(e);
      const data = e.data || (e.info && e.info.error && e.info.error.data) || "";
      if (!/GameNotMintEligible/.test(reason) && !String(data).startsWith("0x199c101d")) throw e;
      return `reverted as expected (${reason})`;
    }
    throw new Error("vote on adapter game unexpectedly succeeded");
  });

  // ---- W7 IGameUIDescriptor (OPTIONAL UI metadata) on the YesNoGame impl ----
  // The descriptor is the dapp's PREFERRED source for rendering predict
  // options / config form / result labels; gameTypes.ts is the FALLBACK when a
  // game type does not implement it. Instantiate the descriptor at the
  // YesNoGame impl using the DAPP's IGameUIDescriptor ABI (not the hardhat
  // artifact) and assert every view via eth_call. These are pure/view and must
  // never revert (except optionLabel/optionPayload out-of-range), so they run
  // independent of any predict lock.
  let descPayloadYes;
  await step("descriptor: IGameUIDescriptor reads on YesNoGame impl (schema/options/config/buckets)", async () => {
    if (yesNoImplAddr === undefined) throw new Error("no YesNoGame impl address captured");
    if (aboveBelowGameId === undefined) throw new Error("no adapter game id captured");
    const desc = new ethers.Contract(yesNoImplAddr, loadAbi("IGameUIDescriptor"), owner);
    const gid = aboveBelowGameId;

    const ver = await desc.uiSchemaVersion();
    if (Number(ver) !== 1) throw new Error(`uiSchemaVersion expected 1, got ${ver}`);

    const oc = await desc.optionCount(gid);
    if (Number(oc) !== 2) throw new Error(`optionCount expected 2, got ${oc}`);

    const lbl0 = await desc.optionLabel(gid, 0);
    const lbl1 = await desc.optionLabel(gid, 1);
    if (lbl0 !== "Yes") throw new Error(`optionLabel(0) expected "Yes", got "${lbl0}"`);
    if (lbl1 !== "No") throw new Error(`optionLabel(1) expected "No", got "${lbl1}"`);

    const pay0 = await desc.optionPayload(gid, 0);
    const pay1 = await desc.optionPayload(gid, 1);
    if (pay0 !== "0x01") throw new Error(`optionPayload(0) expected "0x01", got "${pay0}"`);
    if (pay1 !== "0x02") throw new Error(`optionPayload(1) expected "0x02", got "${pay1}"`);
    descPayloadYes = pay0; // feed the user predict below from the descriptor

    const pis = await desc.predictInputSchema(gid);
    if (pis !== "") throw new Error(`predictInputSchema expected "", got "${pis}"`);

    const cfgSchema = await desc.configSchema();
    const parsed = JSON.parse(cfgSchema);
    if (!parsed.fields || parsed.fields[0].key !== "threshold") {
      throw new Error(`configSchema fields[0].key expected "threshold", got "${parsed.fields && parsed.fields[0] && parsed.fields[0].key}"`);
    }

    const bl1 = await desc.bucketLabel(gid, 1);
    const bl2 = await desc.bucketLabel(gid, 2);
    if (bl1 !== "Yes") throw new Error(`bucketLabel(1) expected "Yes", got "${bl1}"`);
    if (bl2 !== "No") throw new Error(`bucketLabel(2) expected "No", got "${bl2}"`);

    return true;
  });

  // Fund `user` with SATORI for prediction power (owner is still unlocked here).
  await step("token.transfer(user, power) [fund adapter predictor]", async () => {
    const tx = await dToken.transfer(user.address, ethers.parseEther("10"));
    await tx.wait();
    const power = await dRewards.getPredictionPower(user.address);
    if (power === 0n) throw new Error("user has zero prediction power after transfer");
    return power;
  });

  // predictMultipleWithPayloads on the YesNoGame from `user`. The YES payload
  // comes FROM the descriptor — optionPayload(gameId,0) === "0x01" — instead of
  // a hardcoded 0x01, proving the descriptor-driven predict path executes
  // end-to-end against the live game. The stream's value was set this round
  // above, satisfying the predict freshness window.
  await step("engine.predictMultipleWithPayloads([{gameId:newGameId, payload:descriptor.optionPayload(0)}]) [user]", async () => {
    if (aboveBelowGameId === undefined) throw new Error("no adapter game id captured");
    if (descPayloadYes === undefined) throw new Error("no descriptor YES payload captured");
    const payload = descPayloadYes; // "0x01" from optionPayload(gameId, 0)
    const tx = await dEngine.connect(user).predictMultipleWithPayloads([
      { gameId: aboveBelowGameId, payload },
    ]);
    await tx.wait();
    return tx;
  });

  // READ-BACK: gamesByStreamCount reflects the added adapter game (binary + 1).
  await step("games.gamesByStreamCount(streamId) reflects the added game", async () => {
    if (aboveBelowGameId === undefined) throw new Error("no adapter game id captured");
    const count = await dGames.gamesByStreamCount(newStreamId);
    if (count < 2n) throw new Error(`expected >=2 games on stream ${newStreamId}, got ${count}`);
    return count;
  });

  // ---- bounties on the SEPARATE SatoriBounties contract ----
  // Runs PRE-LOCK on purpose: funding a NON-SATORI bounty charges the SATORI
  // bounty burn via the hub's chargeBountyBurn -> token.transferFrom(funder),
  // which needs (a) owner's SATORI allowance to the hub and (b) owner still
  // transfer-unlocked — the binary predict below locks owner's balance.
  const MockERC20 = await ethers.getContractFactory("MockERC20");
  const token = await MockERC20.deploy("SmokeUSD", "sUSD");
  await token.waitForDeployment();
  const tokenAddr = await token.getAddress();
  await (await token.mint(owner.address, ethers.parseEther("10000"))).wait();
  await (await token.connect(owner).approve(addr.bounties, ethers.parseEther("10000"))).wait();
  await (await dToken.approve(addr.satori, ethers.parseEther("100"))).wait(); // bounty-burn allowance

  await step("bounties.stakeBountyToken(token, amount)", async () => {
    const tx = await dBounties.stakeBountyToken(tokenAddr, ethers.parseEther("10"));
    await tx.wait();
    return tx;
  });

  await step("bounties.fundBounty(gameId, token, amount, proposedRate)", async () => {
    const tx = await dBounties.fundBounty(
      gameId,
      tokenAddr,
      ethers.parseEther("1000"),
      ethers.parseEther("10")
    );
    await tx.wait();
    return tx;
  });

  // confirm the bounty pool/rate getters now reflect the funded state (keying check)
  await step("bounties.pool(gameId,token) reflects funded amount", async () => {
    const p = await dBounties.pool(gameId, tokenAddr);
    if (p === 0n) throw new Error("pool is 0 after fundBounty");
    return p;
  });

  // predictMultipleWithPayloads([{gameId, payload}]) — payload = 1-byte direction
  // via ethers.solidityPacked(['uint8'],[1]).
  await step("engine.predictMultipleWithPayloads([{gameId, payload}])", async () => {
    const payload = ethers.solidityPacked(["uint8"], [1]);
    const tx = await dEngine.predictMultipleWithPayloads([{ gameId, payload }]);
    await tx.wait();
    return tx;
  });

  // setReferral(addr) — set from a fresh signer referencing owner.
  await step("rewards.setReferral(addr)", async () => {
    const tx = await dRewards.connect(user).setReferral(owner.address);
    await tx.wait();
    return tx;
  });

  // setAdmin(addr) — transfer admin (then restore so we don't leave it dangling).
  await step("rewards.setAdmin(addr)", async () => {
    const tx = await dRewards.setAdmin(owner.address);
    await tx.wait();
    return tx;
  });

  // ---- accrueProtocolFee (permissionless poke) ----
  // No precondition / no auth gate — anyone may call it to roll the protocol
  // fee bookkeeping forward. Asserts the dapp's rewards.accrueProtocolFee()
  // call shape executes against the live deploy.
  await step("rewards.accrueProtocolFee() [permissionless]", async () => {
    const tx = await dRewards.accrueProtocolFee();
    await tx.wait();
    return tx;
  });

  // ---- claim-delegation EXECUTE (delegateClaimAbility -> claimFor) ----
  // ownerA delegates claim ability to delegateB; delegateB then calls the
  // core's claimFor(ownerA, ownerA). Authorization is keyed by
  // rewards.claimDelegateInfo(ownerA) === delegateB. We READ that back first
  // to prove the delegation took, then EXECUTE the claim. ownerA may have no
  // claimable rewards here — that's fine: an AUTHORIZED claimFor with zero
  // owed does NOT revert (it credits/zeros nothing and returns 0). The point
  // is that the call shape resolves WITHOUT an auth revert (Unauthorized()).
  //
  // Use dedicated signers (ownerA = signers[2], delegateB = signers[3]) so we
  // don't disturb owner's / user's claim-delegation state used elsewhere.
  const ownerA = signers[2] || owner;
  const delegateB = signers[3] || user;
  await step("satori.connect(ownerA).delegateClaimAbility(delegateB) + rewards.claimDelegateInfo(ownerA) === delegateB", async () => {
    const tx = await dSatori.connect(ownerA).delegateClaimAbility(delegateB.address);
    await tx.wait();
    const del = await dRewards.claimDelegateInfo(ownerA.address);
    if (del.toLowerCase() !== delegateB.address.toLowerCase()) {
      throw new Error(`claimDelegateInfo(ownerA) expected ${delegateB.address}, got ${del}`);
    }
    return del;
  });

  await step("satori.connect(delegateB).claimFor(ownerA, ownerA) executes (authorized; no auth revert)", async () => {
    // recipient defaults to the owner. Authorized iff claimDelegateInfo(ownerA)
    // === delegateB (set above) — so this must NOT revert Unauthorized().
    const tx = await dSatori.connect(delegateB).claimFor(ownerA.address, ownerA.address);
    await tx.wait();
    return tx;
  });

  // ===========================================================================
  // Summary
  // ===========================================================================
  console.log("\n=== SMOKE RESULTS ===");
  for (const r of results) console.log(r);
  const fails = results.filter((r) => r.startsWith("FAIL"));
  console.log(`\n${results.length - fails.length}/${results.length} PASS, ${fails.length} FAIL`);
  if (fails.length) {
    console.log("\nFAILURES:");
    for (const f of fails) console.log("  " + f);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Fatal error in smoke-dapp:", error);
    process.exit(1);
  });
