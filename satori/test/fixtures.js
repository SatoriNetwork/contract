const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

// CUTOVER: `satori` is now the restructured stack (immutable SatoriToken +
// UUPS SatoriEngine + SatoriHub + children) behind a monolith-shaped
// compatibility shim. `fix.satori` routes to token/engine/hub; `fix.token`,
// `fix.engine`, `fix.hub` are also exposed for tests that need a specific
// layer (impersonating the core → the hub; ERC20 identity → the token).
// The old monolith deploy path is gone.
async function _deploySplitCompat(bps, opts) {
  const { deploySplitCompatFixture } = require("./next/splitFixture");
  const fix = await deploySplitCompatFixture(bps, opts);
  // Games are opt-in for rewards (gameApproved, design 9.8): a fresh game is
  // born unapproved and cannot be voted on or scored until the rewards admin
  // approves it. The FIXTURE plays that admin, approving each auto-created
  // binary game at stream creation — matching the operational policy of
  // approving the standard games in real time — so the wider suite tests game
  // behaviour, not the approval ceremony. The gate itself is tested explicitly
  // in Voting.test.js, which revokes/creates games without this wrapper.
  const adminAddr = await fix.rewards.admin();
  const { ethers } = require("hardhat");
  const all = [fix.owner, ...(fix.signers || [])];
  let adminSigner = fix.owner;
  for (const s2 of all) {
    if (s2 && s2.address === adminAddr) { adminSigner = s2; break; }
  }
  const approveCtx = { voting: fix.voting, games: fix.games, adminSigner };
  return { ...fix, satori: wrapSatoriForGames(fix.satori, approveCtx), approveCtx };
}

// Parameterized fixture for tests that need a custom top-N voting cap or a
// rewards admin distinct from the deployer. opts = { votingCap, rewardsAdmin }.
// Use with loadFixture via a thunk: loadFixture(() => deploySatoriFixtureOpts(2000, { votingCap: 1 })).
async function deploySatoriFixtureOpts(bps = 2000, opts = {}) {
  return _deploySplitCompat(bps, opts);
}

/** Default fixture — 2000 bps platform fee. loadFixture-compatible. */
async function deploySatoriFixture() {
  return _deploySplitCompat(2000);
}

/** Zero-platform-fee fixture. loadFixture-compatible. */
async function deploySatoriFixtureNoFee() {
  return _deploySplitCompat(0);
}

/** Parameterized fixture (takes an arg; not for loadFixture). */
async function deploySatoriFixtureWithFeeBps(bps) {
  return _deploySplitCompat(bps);
}

function wrapSatoriForGames(satoriContract, approveCtx) {
  return new Proxy(satoriContract, {
    get(target, prop, receiver) {
      if (prop === "connect") {
        return function(signer) {
          return wrapSatoriForGames(target.connect(signer), approveCtx);
        };
      }
      // ethers v6 lets you call overloaded methods either as `satori.foo(...)`
      // (matches the first/canonical overload) or as `satori["foo(types)"](...)`
      // (explicit signature). Both shapes need wrapping.
      if (
        typeof prop === "string" &&
        (prop === "createSimpleDataStream" ||
         prop === "createAdapterDataStream" ||
         prop.startsWith("createSimpleDataStream(") ||
         prop.startsWith("createAdapterDataStream("))
      ) {
        const orig = Reflect.get(target, prop, target);
        if (typeof orig !== "function") return orig;
        const _ = require("ethers");
        return async function(...args) {
          // The core now auto-creates each stream's default binary (type-0)
          // game, so the fixture no longer creates one — doing so would revert
          // DuplicateBinaryGame. We still await the mine so the stream and its
          // auto-created game exist by the time this resolves.
          const tx = await orig.apply(target, args);
          const rcpt = await tx.wait();
          // Approve the stream's auto-created binary game (see
          // _deploySplitCompat). Stream id parsed from the creation event; the
          // game is its first (only) game at this point.
          if (approveCtx) {
            for (const log of rcpt.logs) {
              let sid;
              try {
                const parsed = target.interface.parseLog(log);
                if (parsed && parsed.name === "DataStreamCreated") sid = parsed.args[0];
              } catch {}
              if (sid !== undefined) {
                const gid = await approveCtx.games.binaryGameByStream(sid);
                // Skip the default game (id 1): it is live by construction and
                // setGameApproved rejects it (CannotSetDefaultApproval) — which
                // matters in pre-init/squat scenarios where a created stream
                // can hold id 1.
                if (gid !== 0n && gid !== 1n) {
                  await (await approveCtx.voting
                    .connect(approveCtx.adminSigner)
                    .setGameApproved(gid, true)).wait();
                }
                break;
              }
            }
          }
          return tx;
        };
      }
      return Reflect.get(target, prop, receiver);
    }
  });
}

// Canonical adapter IDs — kept in sync with the production deploy script
// and the dapp's hardcoded map.
const ADAPTER_ID_CHAINLINK = 1;
const ADAPTER_ID_UNISWAP   = 2;
const ADAPTER_ID_CUSTOM    = 3;

// Config encoders used by tests to build (target, config) pairs for
// createAdapterDataStream calls. Per-adapter shape:
//   Chainlink: abi.encode(uint64 maxFeedAge)  — default 1 hour
//   Uniswap:   "0x" (ignored)
//   Custom:    "0x" (ignored)
const { AbiCoder } = require("ethers");
const _coder = AbiCoder.defaultAbiCoder();
const encodeChainlinkConfig = (maxFeedAge = 3600) => _coder.encode(["uint64"], [maxFeedAge]);
const encodeUniswapConfig   = () => "0x";
const encodeCustomConfig    = () => "0x";

// Convenience wrappers for tests that previously called
// createCustomDataStream / createChainlinkDataStream / createUniswapDataStream.
// Each picks the matching adapter ID, encodes the right config, and forwards
// to createAdapterDataStream. Omitting `cadence` uses the 4-arg overload, which
// now defaults to cadence 2 (daily) — the finest a PUBLIC stream may be under
// SatoriHub's cadence floor. Pass an explicit cadence to override; cadence 1
// (every round) is admin-only, so the caller must be `rewards.admin()`.
//
// `signerOrContract` may be either a connected-contract instance or the raw
// satori contract; we accept both for ergonomics in existing tests.
// Helper signatures keep the `_authority` parameter for backward-compat
// with existing test call sites — the parameter is ignored. Under the §3.4
// design, adapter streams have no separate authority field; `provider`
// (the data source) absorbs both roles, and adapter streams cannot be
// renamed or transferred post-creation.
async function createCustomStream(satoriContract, name, provider, _authority, cadence) {
  const config = encodeCustomConfig();
  if (cadence === undefined) {
    return satoriContract["createAdapterDataStream(string,uint16,address,bytes)"](
      name, ADAPTER_ID_CUSTOM, provider, config
    );
  }
  return satoriContract["createAdapterDataStream(string,uint16,address,bytes,uint24)"](
    name, ADAPTER_ID_CUSTOM, provider, config, cadence
  );
}

async function createChainlinkStream(satoriContract, name, provider, _authority, cadence, maxFeedAge = 3600) {
  const config = encodeChainlinkConfig(maxFeedAge);
  if (cadence === undefined) {
    return satoriContract["createAdapterDataStream(string,uint16,address,bytes)"](
      name, ADAPTER_ID_CHAINLINK, provider, config
    );
  }
  return satoriContract["createAdapterDataStream(string,uint16,address,bytes,uint24)"](
    name, ADAPTER_ID_CHAINLINK, provider, config, cadence
  );
}

async function createUniswapStream(satoriContract, name, pool, _authority, cadence) {
  const config = encodeUniswapConfig();
  if (cadence === undefined) {
    return satoriContract["createAdapterDataStream(string,uint16,address,bytes)"](
      name, ADAPTER_ID_UNISWAP, pool, config
    );
  }
  return satoriContract["createAdapterDataStream(string,uint16,address,bytes,uint24)"](
    name, ADAPTER_ID_UNISWAP, pool, config, cadence
  );
}

// A named stream: provider is the ENGINE, config is empty (the registry writes
// the stream's own id), cadence is fixed at 60. Goes through `fix.satori` so the
// auto-created game is approved.
async function createNamedStream(fix, name, signer = fix.owner) {
  return fix.satori.connect(signer)["createAdapterDataStream(string,uint16,address,bytes,uint24)"](
    name, fix.namedAdapterId, await fix.engine.getAddress(), "0x", 60
  );
}

// rawPower-quantization tolerance for reward assertions.
//
// Side A of the rawPower-into-packed-slot optimization stores rawPower
// scaled by 2^PR_RAW_SHIFT (right-shift). PR_RAW_SHIFT is 40 (raises the
// saturation cap to ~155M SATORI so it never binds; see Satori.sol). Anything
// below ~2^40 wei (~0.27 micro-SATORI) rounds to zero; reward calculations
// propagate this rounding so exact-equal SATORI assertions no longer hold.
// RAW_TOLERANCE bounds the absolute wei error at the per-prediction
// quantization unit, multiplied by a safety factor of 64 to cover compounded
// rounding through the multiplier × WEIGHT_SCALE / totalVotes pipeline.
//
// 64 × 2^40 ≈ 7.04 × 10¹³ wei ≈ 70.4 micro-SATORI. Use closeTo with this
// tolerance for any expected-vs-actual reward comparison.
const RAW_TOLERANCE = (1n << 40n) * 64n; // ~7.04e13 wei (tracks PR_RAW_SHIFT=40)

// scaledWeight = rawPower × multiplier × WEIGHT_SCALE / totalVotes. The
// rawPower quantization error gets amplified through this chain by the
// multiplier and the WEIGHT_SCALE (1e18). Under the √streak×1000 curve the
// multiplier is floor(√streak × 1000) — far lower per streak than the old
// quadratic curve (e.g. streak 12 → 3464, not 14400), and only ~128000 even
// at the streak-16383 codec ceiling — so the 1e6 safety factor still
// covers the amplification comfortably. Use this tolerance for direct
// scaledWeight assertions (e.g. PredictionScored event scaledWeight field).
const SCALED_WEIGHT_TOLERANCE = RAW_TOLERANCE * 1_000_000n; // ~6.87e16 wei

// Wrap a 1-byte direction in a hex string for predictMultipleWithPayloads.
// Type-0 binary games consume `payload[0]` as the direction byte; adapters
// can pack richer payloads where the first byte is still the direction.
function pack1(direction) {
  return ethers.hexlify(new Uint8Array([Number(direction) & 0xff]));
}

// ============================================================
// Second-game (adapter) helpers.
//
// deploySatoriFixture auto-creates exactly ONE built-in binary game (type 0)
// per stream and is intentionally left untouched so the ~1650 existing tests
// stay byte-for-byte identical. To put a SECOND game on a stream, a test must
// deploy + register an ADAPTER (gameTypeId >= 1) and create a game from it.
// These two helpers bundle that flow off an existing fixture result.
// ============================================================

// Deploy a YesNoGame adapter against an existing fixture and register it via
// the core's admin (free) registration path. `fix` is a deploySatoriFixture()
// result; fix.owner is the protocol admin (rewards.admin == owner). Parses the
// GameAdapterRegistered event off the SatoriGames interface to recover the
// auto-assigned gameTypeId.
async function deployAndRegisterYesNoGame(fix) {
  // The adapter game's "core" is whatever calls its record/score (_onlyCore).
  // In the monolith that is the core (satori); in the split it is the ENGINE.
  const coreAddr = fix.engine ? await fix.engine.getAddress() : await fix.satori.getAddress();
  const gamesAddr = await fix.games.getAddress();
  const registryAddr = await fix.registry.getAddress();
  const rewardsAddr = await fix.rewards.getAddress();

  const YesNoGame = await ethers.getContractFactory("YesNoGame");
  const yesNoGame = await YesNoGame.deploy(coreAddr, gamesAddr, registryAddr);
  await yesNoGame.waitForDeployment();

  const tx = await fix.satori
    .connect(fix.owner)
    .registerGameAdapter(await yesNoGame.getAddress(), "Yes/No");
  const receipt = await tx.wait();

  let gameTypeId;
  for (const log of receipt.logs) {
    try {
      const parsed = fix.games.interface.parseLog(log);
      if (parsed && parsed.name === "GameAdapterRegistered") {
        gameTypeId = Number(parsed.args.gameTypeId);
        break;
      }
    } catch (e) {}
  }
  if (gameTypeId === undefined) throw new Error("GameAdapterRegistered event missing");

  return { yesNoGame, gameTypeId };
}

// Create a YES/NO adapter game on `streamId`. `satoriConnected` may be the
// fixture's wrapped satori or a fix.satori.connect(signer) result — createGame
// is not wrapped by the Proxy, so it passes through normally. `threshold` is
// abi-encoded as int128 (YesNoGame's frozen gameConfig). Parses the GameCreated
// event off the SatoriGames interface to recover the new gameId.
async function createYesNoGame(satoriConnected, gameTypeId, streamId, threshold, name) {
  const cfg = AbiCoder.defaultAbiCoder().encode(["int128"], [threshold]);
  const tx = await satoriConnected.createGame(streamId, gameTypeId, cfg, name);
  const receipt = await tx.wait();

  // GameCreated is emitted by SatoriGames, not the core — parse against a
  // detached SatoriGames interface (satoriConnected is the core/proxy, whose
  // interface lacks the event). No address needed; we only decode logs.
  const gamesIface = (await ethers.getContractFactory("SatoriGames")).interface;
  for (const log of receipt.logs) {
    try {
      const parsed = gamesIface.parseLog(log);
      if (parsed && parsed.name === "GameCreated") return Number(parsed.args.gameId);
    } catch (e) {}
  }
  throw new Error("GameCreated event missing");
}

/// Bring `user` to streak >= 1 on `gameId` with one complete correct
/// predict -> settle cycle.
///
/// AUDIT C-2: streak 0 now runs the normal curve, so W(0) = 0 and the prediction
/// carries a ZERO multiplier. `SatoriBounties.applyBoost` early-returns on a zero
/// multiplier, so a streak-0 prediction takes no bounty snapshot and earns no
/// bounty — deliberately, so depositors' tokens only ever pay a real streak. Any
/// test that wants a BOOSTED prediction must therefore warm the streak up first.
///
/// Call this BEFORE funding a bounty or staking, so the warm-up cycle cannot
/// touch bounty state (no pool, no stake => nothing to drip or snapshot) and the
/// test's own pot/pool assertions stay exact.
/// `user` may be a single signer or an array — a batch shares ONE rising-value
/// cycle, so warming N predictors costs the same 3 rounds as warming one.
/// `cadence` is the stream's cadence in OLD 12h-round units (kept so call sites
/// did not all change when rounds went 24h): each step waits ceil(cadence/2)
/// new rounds — the same wall-clock as before, rounded up to whole rounds so
/// the round guard clears.
async function warmUpStreak(satori, registry, authority, user, gameId, base = 1000, cadence = 1) {
  const users = Array.isArray(user) ? user : [user];
  // Start from a fresh round: the caller may already have written this stream in
  // the current round (setValue enforces a per-round cadence).
  const step = 86400 * Math.ceil(cadence / 2);
  await time.increase(step);
  await registry.connect(authority).setValue(gameId, base);
  for (const u of users) {
    await satori.connect(u).predictMultipleWithPayloads([{ gameId, payload: pack1(1) }]);
  }
  await time.increase(step);
  await registry.connect(authority).setValue(gameId, base + 10);
  await time.increase(step);
  await registry.connect(authority).setValue(gameId, base + 20);
  for (const u of users) {
    await satori.settlePrediction(u.address, gameId);
  }
  // Leave the caller a full cadence period clear, so their own first setValue is
  // not blocked by this helper's last write.
  await time.increase(step);
}

/// Put loyalty on the books for a delegate's CURRENT delegators.
///
/// Delegator payout weight is capital × loyalty
/// (docs/design/delegation-loyalty-weighting.md). A fresh delegation starts at
/// L = 0 and the fold point is lagged by LOY_LAG (4) rounds, so a delegator's
/// first PAYING round is `startRound + LOY_LAG + 1`. Any test that measures a
/// delegator's share must warm the relationship up first, or it measures zero.
///
/// Runs one winning round on `gameId`, clears the fold lag, then drains
/// `predictor` and every `delegator` to `sink`. The drain is not optional: a
/// predictor's unclaimed counts toward `ownPower` and would shift the
/// predictor/delegator split ratio, and a delegator's balance IS their
/// delegated capital.
///
/// Pinned wei generally survive this unchanged — when a predictor's delegators
/// share one `L`, `c·L·share/(L·C)` collapses back to `c·share/C`.
///
/// `authority` is the stream's value writer; `cadence` is its minCadenceRounds.
async function warmUpLoyalty(
  satori, registry, authority, predictor, delegators, sink, gameId, base = 40, cadence = 1
) {
  const step = 86400 * Math.ceil(cadence / 2);
  const reg = authority ? registry.connect(authority) : registry;
  // The caller has usually written this stream already this round, and setValue
  // is cadence-gated — start from a clean one.
  await time.increase(step);
  await reg.setValue(gameId, base);
  await satori.connect(predictor).predictMultipleWithPayloads([{ gameId, payload: pack1(1) }]);
  await time.increase(step);
  await reg.setValue(gameId, base + 10);
  await time.increase(step);
  await reg.setValue(gameId, base + 20);
  await satori.settlePrediction(predictor.address, gameId);
  for (let i = 0; i < 6; i++) await time.increase(step);
  for (const p of [predictor, ...delegators]) {
    await satori.connect(p)["claim(address)"](sink.address);
  }
}

// ============================================================================
// BURN VOTING — migration helpers
// ============================================================================
// Voting now BURNS the voter's SATORI to buy a game permanent weight:
//
//   1. `vote` takes an AMOUNT: `satori.connect(a).vote(g)` -> `.vote(g, amount)`.
//   2. Voting SPENDS. Prediction power is balance + unclaimed, so tokens burnt
//      voting are no longer available to predict with. A test that used to vote
//      its whole balance and then predict must burn a little and keep the rest.
//   3. Game id 1 is the DEFAULT game. Its weight is DERIVED (20% of all other
//      burn, floored at 1e18) and it CANNOT be voted on — `vote(1, ...)` reverts
//      `CannotVoteDefault`. The fixture now calls `initializeDefaultStream()`, so
//      the first stream a test creates is id 2.
//
// No approval step is needed: the fixture approves the hub for MaxUint256 from
// every signer, and the hub burns via `burnFrom`.

/// Default burn for "just make this game eligible". 10 ether is chosen so the
/// voted game clears the default game's 1e18 derived floor: with a single voted
/// game at 10, the default derives 2.5, giving the clean 80/20 split. It also
/// leaves 90 of a typical 100-ether test balance free for predicting.
const VOTE = ethers.parseEther("10");

/// Burn `amount` for `gameId` as `signer`. Replaces the old `vote(gameId)`.
async function voteFor(satori, signer, gameId, amount = VOTE) {
  return satori.connect(signer).vote(gameId, amount);
}

/// Make several games eligible with the same burn each. Returns total burnt, so
/// a balance/supply assertion can subtract it.
async function makeEligible(satori, signer, gameIds, amount = VOTE) {
  const ids = Array.isArray(gameIds) ? gameIds : [gameIds];
  for (const g of ids) await satori.connect(signer).vote(g, amount);
  return amount * BigInt(ids.length);
}

/// Burn in a given RATIO across games — for reward-split assertions.
/// `pairs` is [[gameId, relativeWeight], ...]. Returns total burnt.
async function voteRatio(satori, signer, pairs, unit = ethers.parseEther("1")) {
  let total = 0n;
  for (const [gameId, w] of pairs) {
    const amt = unit * BigInt(w);
    await satori.connect(signer).vote(gameId, amt);
    total += amt;
  }
  return total;
}

// The on-chain game gross for the CURRENT round: the hub's per-round emission
// net of the senior dev fee, with no dial set.
//
// Read from the chain, always. Most of this suite used to write this out as
// `parseEther("1152")` — 1440 minus a 288 dev fee — which was a fine constant
// while emission was a fixed 1440 and the fee a fixed 20% of it. Emission is
// the hub's decaying schedule now and the fee a flat 15% of THAT, so a literal
// here is a number that goes quietly wrong rather than loudly wrong.
//
// Pass the monolith-shaped `satori` shim (its address is the hub).
async function onChainGrossNow(satori) {
  return (await satori.emissionRateNow()) - (await satori.devRateNow());
}

// token.freezeAirdrop takes the door and the table total it was checked at.
// For tests that are not about that check: freeze the standing door at its
// standing total.
async function freezeStandingAirdrop(token, signer) {
  const door = await token.airdrop();
  const table = await ethers.getContractAt("SatoriAirdrop", door);
  return token.connect(signer).freezeAirdrop(door, await table.airdropLoadedTotal());
}

module.exports = {
  freezeStandingAirdrop,
  onChainGrossNow,
  deploySatoriFixture,
  deploySatoriFixtureNoFee,
  deploySatoriFixtureWithFeeBps,
  deploySatoriFixtureOpts,
  wrapSatoriForGames,
  deployAndRegisterYesNoGame,
  createYesNoGame,
  ADAPTER_ID_CHAINLINK,
  ADAPTER_ID_UNISWAP,
  ADAPTER_ID_CUSTOM,
  encodeChainlinkConfig,
  encodeUniswapConfig,
  encodeCustomConfig,
  createCustomStream,
  createChainlinkStream,
  createUniswapStream,
  createNamedStream,
  RAW_TOLERANCE,
  SCALED_WEIGHT_TOLERANCE,
  pack1,
  warmUpStreak,
  warmUpLoyalty,
  VOTE,
  voteFor,
  makeEligible,
  voteRatio,
};
