const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time, impersonateAccount, setBalance } =
  require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture, pack1, VOTE } = require("../fixtures");

// Adapter games are paid NOTHING by the mint, end to end.
//
// WHAT THIS FILE USED TO BE
// A width/overflow guard on the adapter SATORI payout: a near-2^255 userScore
// must not overflow `Math.mulDiv`, an over-reported numerator must be clamped to
// the first-scorer's pinned total, and the running paid sum must cap at one
// pool. Real concerns, for a payout that existed.
//
// It stopped existing when burn voting made adapter games non-mint-eligible.
// `SatoriVoting.vote` reverts GameNotMintEligible for gameTypeIdOf != 0 and
// weight is written nowhere else, so an adapter game's pool is always 0. The
// tests were left in place asserting "and the pool is zero", "half of zero is
// zero" — driving arithmetic whose only possible answer was 0, through rails
// with no public getters, so the ratio they existed to check was not observable
// anyway. The file's own header said as much.
//
// On 2026-08-23 the arithmetic itself was removed (SatoriRewards: the pinned
// denominator, the paid cap, the saturating product, two storage slots, and
// `multiplier`/`total` from the signature). Tests for removed arithmetic went
// with it. There is no overflow left to guard because there is no multiply.
//
// WHAT SURVIVES, BECAUSE IT IS STILL LOAD-BEARING
//   1. End to end, five self-declared "winners" of an adapter game are paid
//      zero. This is the property the whole file was ever really about, and it
//      now holds structurally rather than by arithmetic.
//   2. The `_adapterPending` flag is consumed at score time, so a second settle
//      is a no-op. That is the protocol owning double-pay prevention, and it is
//      unaffected by anything above.

const ROUND = 86400;
const TOKENS_PER_ROUND = ethers.parseEther("720");

// Advance TWO rounds. Both call sites sit between the host's two setValue writes
// on a two-round (2880-minute) stream, which can only be re-written every 2
// rounds (>= 2 rounds AND >= 2880min - 30min = 171000s of wall-clock).
// 2*ROUND = 172800s satisfies both.
async function advanceRound() { await time.increase(2 * ROUND); }

async function impersonateCore(satori) {
  const satoriAddr = await satori.getAddress();
  await impersonateAccount(satoriAddr);
  await setBalance(satoriAddr, ethers.parseEther("10"));
  return ethers.getSigner(satoriAddr);
}

async function gameIdFrom(tx, games) {
  const r = await tx.wait();
  for (const log of r.logs) {
    try {
      const p = games.interface.parseLog(log);
      if (p && p.name === "GameCreated") return Number(p.args.gameId);
    } catch (e) {}
  }
  throw new Error("GameCreated event missing");
}

// Deploy the fixture + an EveryoneWinsGame adapter game on a fresh stream,
// voted eligible, with one real predictor who has committed in round R. Returns
// the round R the bet was made on so a test can score that exact (game, round).
async function setupAdapterBet() {
  const fix = await loadFixture(deploySatoriFixture);
  const { satori, registry, games, owner, signers } = fix;

  const Evil = await ethers.getContractFactory("EveryoneWinsGame");
  const evil = await Evil.deploy(await satori.getAddress());
  await evil.waitForDeployment();
  const coreSigner = await impersonateCore(satori);
  await games.connect(coreSigner).registerGameAdapter(
    await evil.getAddress(), owner.address, "Evil", false);

  await satori.connect(owner)["createSimpleDataStream(string,address,uint24)"]("S", owner.address, 2880);
  // Stream/game id 1 is the protocol's DEFAULT game (the fixture initializes it
  // exactly as production does), so this stream is id 2 — capture it.
  const streamId = Number(await registry.nextStreamId()) - 1;
  await registry.connect(owner).setValue(streamId, 100);
  const g = await gameIdFrom(
    await satori.connect(owner).createGame(streamId, 1, "0x", "evil"), games);
  // No vote: only the built-in binary game is mint-eligible, so `vote` on an
  // adapter game reverts GameNotMintEligible. The game therefore has no round
  // allocation, and `pool × effShare / total` is zero for every effShare — see
  // the header note on what that does and does not still exercise.

  const user = signers[1];
  await satori.transfer(user.address, ethers.parseEther("10"));
  const round = Number(await satori.getCurrentRound());
  await satori.connect(user).predictMultipleWithPayloads([{ gameId: g, payload: pack1(1) }]);

  // Roll past the bet round so the pool's round budget is computable and the
  // bet is resolvable.
  await advanceRound();
  await registry.connect(owner).setValue(streamId, 200);
  return { ...fix, evil, streamId, g, user, round };
}

describe("adapter games are paid nothing by the mint, and cannot be settled twice", function () {
  this.timeout(300000);

  it("end-to-end: 5 EveryoneWinsGame 'winners' (each announcing total == own score) are paid NOTHING, let alone 5×", async function () {
    // The adapter announces, for EVERY predictor, total == that user's OWN
    // userScore (the analogue of the old singleton-bucket attack with full-width
    // numerators). The pin+cap rails mean exactly ONE pool is minted total.
    const fix = await loadFixture(deploySatoriFixture);
    const { satori, rewards, registry, games, owner, signers } = fix;

    const Evil = await ethers.getContractFactory("EveryoneWinsGame");
    const evil = await Evil.deploy(await satori.getAddress());
    await evil.waitForDeployment();
    const core = await impersonateCore(satori);
    await games.connect(core).registerGameAdapter(
      await evil.getAddress(), owner.address, "Evil", false);

    await satori.connect(owner)["createSimpleDataStream(string,address,uint24)"]("S", owner.address, 2880);
    // Stream/game id 1 is the protocol's DEFAULT game; this stream is id 2.
    const streamId = Number(await registry.nextStreamId()) - 1;
    await registry.connect(owner).setValue(streamId, 100);
    const g = await gameIdFrom(
      await satori.connect(owner).createGame(streamId, 1, "0x", "evil"), games);
    // Unvotable: an adapter game is not mint-eligible.
    await expect(satori.connect(owner).vote(g, VOTE))
      .to.be.revertedWithCustomError(fix.voting, "GameNotMintEligible");

    const ps = [];
    for (let i = 1; i <= 5; i++) {
      ps.push(signers[i]);
      await satori.transfer(signers[i].address, ethers.parseEther("10"));
      await satori.connect(signers[i]).predictMultipleWithPayloads([{ gameId: g, payload: pack1(1) }]);
    }

    await advanceRound();
    await registry.connect(owner).setValue(streamId, 200);

    const before = {};
    for (const p of ps) before[p.address] = await rewards.unclaimedRewards(p.address);
    for (const p of ps) await satori.settlePrediction(p.address, g);

    let totalCredited = 0n;
    const gains = [];
    for (const p of ps) {
      const gain = (await rewards.unclaimedRewards(p.address)) - before[p.address];
      gains.push(gain);
      totalCredited += gain;
    }

    // Every bet really was scored: the adapter consumed all five pending
    // records, so the zeros below are resolved outcomes, not stalled settles.
    for (const p of ps) expect(await evil.pendingRound(g, p.address)).to.equal(0n);

    // Conservation: total credited across ALL "winners" ≤ one round budget —
    // and in fact exactly zero. Five self-declared winners of a game that is not
    // mint-eligible split five times nothing.
    expect(totalCredited).to.be.lte(TOKENS_PER_ROUND,
      "sum of adapter-game payouts must not exceed one round budget");
    expect(totalCredited).to.equal(0n);
    expect(gains.filter((x) => x > 0n).length).to.equal(0,
      "no adapter predictor is paid at all: the game draws no pool to be capped against");
  });

  it("a second settle pays nothing: the pending flag is consumed at score time (no double-pay)", async function () {
    const { satori, rewards, g, user, round } = await setupAdapterBet();
    const core = await impersonateCore(satori);

    const HUGE = 1n << 200n;
    const before = await rewards.unclaimedRewards(user.address);

    // `finalized` is the direct witness of the pending flag — read it off a
    // static call so the observation itself changes nothing. Before the first
    // score it is true (a real pending exists).
    const [finalizedBefore] = await rewards.connect(core)
      .scoreAdapterPrediction.staticCall(user.address, g, round, HUGE, 0);
    expect(finalizedBefore).to.equal(true);

    await rewards.connect(core).scoreAdapterPrediction(user.address, g, round, HUGE, 0);
    const afterFirst = (await rewards.unclaimedRewards(user.address)) - before;
    expect(afterFirst).to.equal(0n); // an adapter game credits nothing

    // The (user, gameId, round) pending flag WAS consumed on the first score, so
    // a second score is a no-op: it neither finalizes again nor pays.
    const [finalizedAfter] = await rewards.connect(core)
      .scoreAdapterPrediction.staticCall(user.address, g, round, HUGE, 0);
    expect(finalizedAfter).to.equal(false);
    await rewards.connect(core).scoreAdapterPrediction(user.address, g, round, HUGE, 0);
    expect((await rewards.unclaimedRewards(user.address)) - before).to.equal(afterFirst,
      "second score on a consumed bet must pay nothing");
  });
});
