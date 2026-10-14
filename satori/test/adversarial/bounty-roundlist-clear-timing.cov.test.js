/**
 * Adversarial regression guard — CLEAR-TIMING / NO-PREMATURE-CLEAR.
 *
 * The fix re-keyed bounty score-time payout from the LIVE `userStakedTokens`
 * list to a per-(user, round) snapshot set `boostedTokensInRound[user][round]`.
 * That set is appended (deduped) in `applyBoost` at predict time and `delete`d
 * by `clearRoundBountyList` — but ONLY once the round is FULLY settled.
 *
 * The clear is gated in `SatoriRewards.notifyPredictionFinalized` on
 *   `nc == 0 && gameHasBounty[gameId]`
 * where `nc` is the user's remaining unsettled-prediction count for the round.
 * `predictMultipleWithPayloads([gA, gB])` bumps that count by 2, so settling
 * the FIRST game (count 2 -> 1) must NOT clear the list; only settling the
 * SECOND (count 1 -> 0) clears it.
 *
 * PROPERTIES UNDER ATTACK:
 *   1. DEDUP: a single staked token predicted across TWO bountied games in one
 *      round yields boostedTokenCountInRound == 1 (not 2). The games sit on two
 *      separate streams (one binary game per stream is now enforced).
 *   2. NO PREMATURE CLEAR: after settling the first of two same-round
 *      predictions, the round list is STILL present (count 1) and the user is
 *      paid for that game. The list is cleared (count 0) only after the second
 *      settle. The user is paid for BOTH games — nothing stranded.
 *   3. ORDER-INDEPENDENCE: holds in either settle order.
 *   4. UNSTAKE-IMMUNE: a user who fully UNSTAKES the token at R+1 (after the
 *      1-round lock lifts) before settling either game is STILL paid for BOTH
 *      games from the predict-time snapshot, then the list clears.
 *
 * A premature clear (list gone before the 2nd settle -> 2nd game pays 0,
 * earned share stranded in the round pot) is a BUG; this test fails loudly.
 *
 * Asserts the INTENDED (safe) behavior — passing == property holds.
 */

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture, pack1 , voteFor } = require("../fixtures");

const UP = 1;

async function deployMockToken(sym = "USDC") {
  const M = await ethers.getContractFactory("MockERC20");
  const t = await M.deploy(sym, sym);
  await t.waitForDeployment();
  return t;
}

async function advanceOneDay() { await time.increase(86400); }

// Stream cadence floor: a PUBLIC caller may only create streams with
// round-length (>= 1440 minute) cadence; sub-round streams are admin-only. This
// test's subject is bounty pool/drip/stake mechanics, not stream rhythm, so it
// keeps the fast (720-minute, sub-round) beat by having the ADMIN (`owner`)
// create the stream. `authority` stays the stream's PROVIDER, so
// it is still the account that writes values.
async function createStream(satori, signer, name, authority) {
  // Fixture Proxy auto-creates a paired binary game (gameId == streamId).
  const tx = await satori.connect(signer)["createSimpleDataStream(string,address,uint24)"](name, authority, 720);
  const rcpt = await tx.wait();
  for (const log of rcpt.logs) {
    try {
      const p = satori.interface.parseLog(log);
      if (p && p.name === "DataStreamCreated") return Number(p.args.streamId);
    } catch (e) {}
  }
  throw new Error("DataStreamCreated event missing");
}

// NOTE (2026-07-30, skip triage): this file used to build gameB as a SECOND
// BINARY game on the SAME stream. SatoriGames now enforces one binary (type-0)
// game per stream -- the core auto-creates it at stream creation, so any further
// type-0 createGame on that stream reverts DuplicateBinaryGame
// (SatoriGames.sol). That premise is gone for good, so gameB now lives on
// a SECOND STREAM. The properties under test are unaffected: they are about one
// staked token being deduped across MULTIPLE GAMES in one round, and about clear
// timing being gated on all of the round's predictions settling -- neither needs
// the two games to share a stream. See docs/issues/closed/skip-triage-2026-07-30.md.

async function stakeFor(bounties, user, token, amount) {
  await token.mint(user.address, amount);
  await token.connect(user).approve(await bounties.getAddress(), amount);
  await bounties.connect(user).stakeBountyToken(await token.getAddress(), amount);
}

// RE-ENABLED 2026-07-30 (skip triage). A prior note deferred this file as
// "cannot be expressed", on the reasoning that every property here is
// intrinsically about two bountied games sharing ONE stream, and that a second
// type-0 game on a stream now reverts DuplicateBinaryGame. The first half is
// wrong: none of the properties depend on the two games sharing a stream. DEDUP
// is about one staked token across multiple GAMES in one ROUND; NO-PREMATURE-CLEAR
// is gated on the user's per-round unsettled count; both are stream-agnostic. Two
// streams, each carrying its auto-paired binary game, exercise all four properties
// -- including the conservation check that both pots pay -- and the suite is green.
// (Bounties being type-0-binary-only is true and is why a YesNoGame second game
// would NOT work; a second binary game on a second stream is the right shape.)
describe("bounty round-list clear timing — no premature clear across multi-game-same-round", function () {
  this.timeout(180000);

  let satori, rewards, bounties, registry, games, owner;
  let alice, funder, authority;
  let streamId, streamIdB, gameA, gameB, usd, usdAddr;

  const POOL = ethers.parseEther("100000");
  const RATE = ethers.parseEther("200"); // dripped per round per game
  const STAKE = ethers.parseEther("100");

  beforeEach(async function () {
    const fix = await loadFixture(deploySatoriFixture);
    ({ satori, rewards, bounties, registry, games, owner } = fix);
    [, alice, funder, authority] = fix.signers;

    await satori.transfer(alice.address, ethers.parseEther("100"));
    await satori.transfer(funder.address, ethers.parseEther("100"));
    await satori.transfer(authority.address, ethers.parseEther("100"));

    streamId = await createStream(satori, owner, "S", authority.address);
    gameA = streamId; // auto-paired game
    streamIdB = await createStream(satori, owner, "S2", authority.address);
    gameB = streamIdB; // auto-paired binary game on the second stream
    expect(gameB).to.not.equal(gameA);

    // Both games need burnt weight. Burn voting is per-game and permanent, so
    // one voter could fund both; we keep two so alice's remaining balance (and
    // therefore her prediction power) is not reduced twice.
    await voteFor(satori, alice, gameA);
    await voteFor(satori, funder, gameB);

    usd = await deployMockToken("USDC");
    usdAddr = await usd.getAddress();
    await usd.mint(funder.address, POOL * 2n);
    await usd.connect(funder).approve(await bounties.getAddress(), POOL * 2n);

    // Fund BOTH games with USDC.
    await bounties.connect(funder).fundBounty(gameA, usdAddr, POOL, RATE);
    await bounties.connect(funder).fundBounty(gameB, usdAddr, POOL, RATE);
    expect(await bounties.gameBountyTokenCount(gameA)).to.equal(1n);
    expect(await bounties.gameBountyTokenCount(gameB)).to.equal(1n);
  });

  // earned == current live stake minus the original principal.
  async function earnedFor(user) {
    const live = await bounties.bountyStake(user.address, usdAddr);
    return live - STAKE;
  }

  // Audit C-2: `applyBoost` is invoked with multiplier 0 whenever the predictor's
  // streak is 0 (SatoriEngine.sol — "Streak 0 takes NO bounty"), so a
  // FIRST-EVER prediction is never boosted and writes no snapshot at all. These
  // tests predate that rule, which is exactly why they measured an empty round
  // list. Warm one winning round on both games BEFORE any stake exists, so the
  // measured round runs at streak >= 1 while the warm-up itself consumes no
  // bounty (no stake => applyBoost finds nothing to snapshot).
  // (2026-07-30, skip triage — docs/issues/closed/skip-triage-2026-07-30.md)
  async function warmStreak() {
    await registry.connect(authority).setValue(streamId, 100);
    await registry.connect(authority).setValue(streamIdB, 100);
    await satori.connect(alice).predictMultipleWithPayloads([
      { gameId: gameA, payload: pack1(UP) },
      { gameId: gameB, payload: pack1(UP) },
    ]);
    await advanceOneDay();
    await registry.connect(authority).setValue(streamId, 110);
    await registry.connect(authority).setValue(streamIdB, 110);
    await advanceOneDay();
    await registry.connect(authority).setValue(streamId, 120);
    await registry.connect(authority).setValue(streamIdB, 120);
    await satori.settlePrediction(alice.address, gameA);
    await satori.settlePrediction(alice.address, gameB);
    expect(await satori.streaks(alice.address, gameA)).to.be.gt(0n);
    expect(await satori.streaks(alice.address, gameB)).to.be.gt(0n);
    // Leave the warm-up round behind: both streams were just updated, and a
    // stream cannot be updated twice inside one round (CadenceRoundsNotElapsed).
    await advanceOneDay();
  }

  async function runClearTiming(firstGame, secondGame, label) {
    await warmStreak();
    // ---- Round R: stake once, predict BOTH games in one batch ----
    await registry.connect(authority).setValue(streamId, 130);
    await registry.connect(authority).setValue(streamIdB, 130);
    await stakeFor(bounties, alice, usd, STAKE);
    await satori.connect(alice).predictMultipleWithPayloads([
      { gameId: gameA, payload: pack1(UP) },
      { gameId: gameB, payload: pack1(UP) },
    ]);
    const r = await satori.getCurrentRound();

    // DEDUP: one staked token across two games -> list length 1, not 2.
    expect(
      await bounties.boostedTokenCountInRound(alice.address, r),
      `${label}: round list deduped to 1`
    ).to.equal(1n);
    expect(await bounties.boostedTokensInRound(alice.address, r, 0)).to.equal(usdAddr);

    // Both per-game snapshots present and equal (same stake, same round).
    const snapA = await bounties.boostStakeForPrediction(alice.address, gameA, r, usdAddr);
    const snapB = await bounties.boostStakeForPrediction(alice.address, gameB, r, usdAddr);
    expect(snapA).to.be.gt(0n);
    expect(snapB).to.be.gt(0n);
    expect(snapA).to.equal(snapB);

    // ---- Drive A-B-C so UP is correct on the stream ----
    await advanceOneDay();
    await registry.connect(authority).setValue(streamId, 140);
    await registry.connect(authority).setValue(streamIdB, 140);
    await advanceOneDay();
    await registry.connect(authority).setValue(streamId, 150);
    await registry.connect(authority).setValue(streamIdB, 150);

    // ---- Settle FIRST game: round NOT fully settled (1 prediction left) ----
    await satori.settlePrediction(alice.address, firstGame);

    // NO PREMATURE CLEAR: list still present, count still 1.
    expect(
      await bounties.boostedTokenCountInRound(alice.address, r),
      `${label}: list MUST survive after first settle (2nd prediction still pending)`
    ).to.equal(1n);

    const earnedAfterFirst = await earnedFor(alice);
    // Paid for the first game already.
    expect(
      earnedAfterFirst,
      `${label}: user paid for first game`
    ).to.be.gt(0n);
    // First game's pot was dripped and accrued.
    const potFirst = await bounties.roundBountyPot(firstGame, r, usdAddr);
    expect(potFirst).to.equal(RATE);

    // ---- Settle SECOND game: round now fully settled -> list cleared ----
    await satori.settlePrediction(alice.address, secondGame);

    // List cleared (refund) only after the LAST prediction finalized.
    expect(
      await bounties.boostedTokenCountInRound(alice.address, r),
      `${label}: list cleared (count 0) after final settle`
    ).to.equal(0n);

    // Paid for BOTH games -> total earned strictly greater than after first.
    const earnedFinal = await earnedFor(alice);
    expect(
      earnedFinal,
      `${label}: second game also paid (earnings increased after 2nd settle)`
    ).to.be.gt(earnedAfterFirst);

    // Second game's pot dripped too — proves nothing stranded.
    const potSecond = await bounties.roundBountyPot(secondGame, r, usdAddr);
    expect(potSecond).to.equal(RATE);

    // Sole predictor: earns each pot. With equal snapshot it's the only staker
    // so totalBoost == userBoost -> share == full pot; total == 2 pots.
    const TOL = ethers.parseEther("0.0001");
    expect(
      earnedFinal,
      `${label}: conservation — Sigma(share) == both dripped pots`
    ).to.be.closeTo(RATE * 2n, TOL);

    // Sole predictor takes essentially the whole dripped amount (minus fee).
    expect(earnedFinal).to.be.gt(RATE); // more than one pot's worth
    expect(earnedFinal).to.be.lte(RATE * 2n + TOL);
  }

  it("settle order A-then-B: no premature clear; both games pay; cleared after last", async function () {
    await runClearTiming(gameA, gameB, "A-then-B");
  });

  it("settle order B-then-A: no premature clear; both games pay; cleared after last", async function () {
    await runClearTiming(gameB, gameA, "B-then-A");
  });

  it("full UNSTAKE at R+1 before either settle: both games still pay from snapshot, then clear", async function () {
    await warmStreak();
    // ---- Round R: stake once, predict BOTH games ----
    await registry.connect(authority).setValue(streamId, 130);
    await registry.connect(authority).setValue(streamIdB, 130);
    await stakeFor(bounties, alice, usd, STAKE);
    await satori.connect(alice).predictMultipleWithPayloads([
      { gameId: gameA, payload: pack1(UP) },
      { gameId: gameB, payload: pack1(UP) },
    ]);
    const r = await satori.getCurrentRound();
    expect(await bounties.boostedTokenCountInRound(alice.address, r)).to.equal(1n);

    const snapA = await bounties.boostStakeForPrediction(alice.address, gameA, r, usdAddr);
    const snapB = await bounties.boostStakeForPrediction(alice.address, gameB, r, usdAddr);
    expect(snapA).to.be.gt(0n);
    expect(snapB).to.be.gt(0n);

    // ---- Round R+1: lock lifts, fully unstake USDC BEFORE any settle ----
    await advanceOneDay();
    expect(await satori.getCurrentRound()).to.equal(r + 1n);
    await bounties.connect(alice).unstakeBountyToken(usdAddr, STAKE, alice.address);
    expect(await bounties.bountyStake(alice.address, usdAddr)).to.equal(0n);
    // Live staked-token list emptied — the OLD buggy code would strand here.
    expect(await bounties.userStakedTokenCount(alice.address)).to.equal(0n);
    // Snapshot set survives unstake.
    expect(await bounties.boostedTokenCountInRound(alice.address, r)).to.equal(1n);

    // ---- Drive A-B-C (UP correct) ----
    await advanceOneDay();
    await registry.connect(authority).setValue(streamId, 140);
    await registry.connect(authority).setValue(streamIdB, 140);
    await advanceOneDay();
    await registry.connect(authority).setValue(streamId, 150);
    await registry.connect(authority).setValue(streamIdB, 150);

    // Settle game A: list survives (B still pending), A pays from snapshot.
    await satori.settlePrediction(alice.address, gameA);
    expect(
      await bounties.boostedTokenCountInRound(alice.address, r),
      "unstake variant: list survives first settle"
    ).to.equal(1n);
    // After unstake, credited shares re-materialize as a fresh stake entry
    // (priorStake==0 path).
    const afterA = await bounties.bountyStake(alice.address, usdAddr);
    expect(afterA, "unstake variant: A paid from snapshot").to.be.gt(0n);

    // Settle game B: round fully settled -> list cleared, B also pays.
    await satori.settlePrediction(alice.address, gameB);
    expect(
      await bounties.boostedTokenCountInRound(alice.address, r),
      "unstake variant: list cleared after final settle"
    ).to.equal(0n);
    const afterB = await bounties.bountyStake(alice.address, usdAddr);
    expect(afterB, "unstake variant: B also paid from snapshot").to.be.gt(afterA);

    // Conservation: sole predictor gets both pots; no strand.
    const TOL = ethers.parseEther("0.0001");
    expect(
      afterB,
      "unstake variant: conservation — share == both dripped pots"
    ).to.be.closeTo(RATE * 2n, TOL);
    expect(await bounties.roundBountyPot(gameA, r, usdAddr)).to.equal(RATE);
    expect(await bounties.roundBountyPot(gameB, r, usdAddr)).to.equal(RATE);
  });
});
