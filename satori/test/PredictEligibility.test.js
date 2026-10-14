/**
 * PredictEligibility.test.js
 *
 * Predictions on ineligible streams are allowed on purpose — this lets users
 * trigger settlement of orphaned predictions on streams that have since lost
 * eligibility. The new prediction itself earns nothing (gameVotesAtRound is
 * 0 for ineligible streams), so there is no inflation risk.
 */

const { expect } = require("chai");
const { deploySatoriFixture, pack1, voteFor } = require("./fixtures");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const UP = 1;
const DOWN = 2;

async function advanceRound() {
  const currentTime = await time.latest();
  const nextMidnight = Math.floor(currentTime / 86400) * 86400 + 86400;
  await time.increaseTo(nextMidnight + 1);
}

// Streams here are created at 2880 minutes (two 24h rounds). A value may only
// be written once per CADENCE_ROUNDS rounds, and the scoring window is AB:
// anchor = the value AT the predict round, post = the FIRST value written
// after it. (A 1440-minute stream would score ABC — not this file's point.)
const CADENCE_ROUNDS = 2;
async function advanceCadencePeriod() {
  for (let i = 0; i < CADENCE_ROUNDS; i++) await advanceRound();
}

async function getStreamIdFromTx(tx, satoriContract) {
  const receipt = await tx.wait();
  const event = receipt.logs.find(log => {
    try {
      const parsed = satoriContract.interface.parseLog(log);
      return parsed && parsed.name === 'DataStreamCreated';
    } catch {
      return false;
    }
  });
  if (!event) throw new Error("DataStreamCreated event not found");
  const parsed = satoriContract.interface.parseLog(event);
  return parsed.args.streamId;
}

describe("Predict on ineligible streams", function () {
  let satori, engine, voting, rewards, bounties, owner, alice, bob, registry, lens;
  let stream1;

  beforeEach(async function () {
    const fix = await deploySatoriFixture();
    ({ satori, engine, voting, rewards, lens, owner, registry } = fix);
    [, alice, bob] = fix.signers;

    // Give alice and bob tokens
    await satori.transfer(alice.address, ethers.parseEther("100"));
    await satori.transfer(bob.address, ethers.parseEther("200"));

    // Create a stream
    const tx = await satori["createSimpleDataStream(string,address,uint24)"]("Test Stream", owner.address, 2880);
    stream1 = await getStreamIdFromTx(tx, registry);

    // Align to a fresh midnight so every subsequent setValue / advanceRound pair
    // produces an exactly ~24-hour gap. Without this, whatever time of day the
    // tests happen to run at leaves setValue caught between the ≥23h write
    // cadence and the ≤23h predict staleness gate.
    await advanceRound();
    await registry.setValue(stream1, 100);
  });

  it("Should allow predict() even when stream is not eligible", async function () {
    // Stream exists but has no votes — not eligible
    expect(await voting.isEligible(stream1)).to.equal(false);

    // Prediction succeeds — the stream's zero numerator at settlement time
    // makes it earn nothing, so the gate belongs at reward time, not here.
    await expect(
      satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }])
    ).to.emit(engine, "PredictionMade");
  });

  it("Should allow predict() once stream becomes eligible", async function () {
    // Alice votes for stream1 to make it eligible
    await voteFor(satori, alice, stream1);

    // Stream should now be eligible
    expect(await voting.isEligible(stream1)).to.equal(true);

    // Alice predicts — should succeed
    await expect(
      satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }])
    ).to.emit(engine, "PredictionMade");
  });

  it("Should allow predictMultiple() even when stream is not eligible", async function () {
    expect(await voting.isEligible(stream1)).to.equal(false);

    await expect(
      satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }])
    ).to.emit(engine, "PredictionMade");
  });

  it("Should allow predictMultiple() once stream becomes eligible", async function () {
    // Alice votes for stream1 to make it eligible
    await voteFor(satori, alice, stream1);

    expect(await voting.isEligible(stream1)).to.equal(true);

    await expect(
      satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }])
    ).to.emit(engine, "PredictionMade");
  });

  it("Correct prediction on ineligible stream: streak advances, reward ledger untouched", async function () {
    // Regression test for REWARD_BUGS #2. A predictor is allowed to predict on an
    // ineligible stream (streak/reputation reasons); doing so must NOT write any
    // reward-path state that would bloat the predictor's round-keyed win
    // bucket (in SatoriRewards) and drag every future claim — by the user AND
    // by every one of their delegators.
    expect(await voting.isEligible(stream1)).to.equal(false);

    const predictionDate = await satori.getCurrentRound();
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

    // Set up the A-B window. A = 100 (the value AT the predict round, already
    // set), post = 110 one cadence period later → UP wins.
    await advanceCadencePeriod();
    await registry.setValue(stream1, 110);

    // Settle.
    await satori.settlePrediction(alice.address, stream1);

    // Prediction is marked scored.
    const pred = await satori.predictions(alice.address, stream1, predictionDate);
    expect(pred.scored).to.equal(true);

    // Streak advanced — streak works for ineligible streams (free, by design).
    expect(await satori.streaks(alice.address, stream1)).to.equal(1);

    // Power is split across ELIGIBLE streams only, so an ineligible pick is
    // recorded with 0 power — it costs the predictor nothing and earns nothing.
    expect(pred.rawPredictionPower).to.equal(0n);

    // 0 power ⇒ 0 weight: nothing is accumulated for an ineligible stream.
    expect(
      await lens.userWeightByDirection(alice.address, stream1, predictionDate, UP)
    ).to.equal(0n);
    expect(
      await lens.totalWeightByDirection(stream1, predictionDate, UP)
    ).to.equal(0n);

    // No SCORING reward: an unvoted game carries zero weight, so
    // recordGameVotesForRound writes no numerator for it and its allocation is
    // 0. Nothing else can credit the ledger either — the first-predictor bonus
    // that used to tip the round's denominator-setter no longer exists. So the
    // reward ledger is genuinely untouched, matching this test's name.
    expect(await rewards.unclaimedRewards(alice.address)).to.equal(0n);

    // claim() is callable and does not revert with a settled ineligible prediction.
    await expect(satori.connect(alice).claim()).to.not.be.reverted;
  });

  it("Mixed batch: eligible stream pays, ineligible stream only advances streak", async function () {
    // Two streams in one batch — one eligible (via bob's vote), one ineligible.
    // Power splits across ELIGIBLE streams only, so the single eligible stream
    // gets the FULL power; the ineligible one gets 0 (only bumps streak).
    const txB = await satori["createSimpleDataStream(string,address,uint24)"]("Other", owner.address, 2880);
    const stream2 = await getStreamIdFromTx(txB, registry);
    await registry.setValue(stream2, 500);
    await voteFor(satori, bob, stream2); // burn buys stream2 weight -> eligible

    expect(await voting.isEligible(stream1)).to.equal(false);
    expect(await voting.isEligible(stream2)).to.equal(true);

    const predictionDate = await satori.getCurrentRound();
    await satori.connect(alice).predictMultipleWithPayloads([
      { gameId: stream1, payload: pack1(UP) },
      { gameId: stream2, payload: pack1(UP) },
    ]);

    // One post-anchor value per stream resolves both AB windows (110 > 100 and
    // 510 > 500), a full cadence period after the anchors.
    await advanceCadencePeriod();
    await registry.setValue(stream1, 110);
    await registry.setValue(stream2, 510);

    await satori.settlePrediction(alice.address, stream1);
    await satori.settlePrediction(alice.address, stream2);

    // Both prediction slots scored.
    const p1 = await satori.predictions(alice.address, stream1, predictionDate);
    const p2 = await satori.predictions(alice.address, stream2, predictionDate);
    expect(p1.scored).to.equal(true);
    expect(p2.scored).to.equal(true);

    // Both streaks advanced.
    expect(await satori.streaks(alice.address, stream1)).to.equal(1);
    expect(await satori.streaks(alice.address, stream2)).to.equal(1);

    // Ineligible stream: 0 power ⇒ 0 weight (recorded but weightless).
    expect(
      await lens.userWeightByDirection(alice.address, stream1, predictionDate, UP)
    ).to.equal(0n);
    expect(
      await lens.totalWeightByDirection(stream1, predictionDate, UP)
    ).to.equal(0n);

    // Eligible stream: reward-path state is populated.
    expect(
      await lens.userWeightByDirection(alice.address, stream2, predictionDate, UP)
    ).to.be.gt(0n);
    expect(
      await lens.totalWeightByDirection(stream2, predictionDate, UP)
    ).to.be.gt(0n);

    // Overall claimable reward is positive (from the eligible stream only).
    const claimable = (await lens.getTotalClaimableRewards(alice.address))[0];
    expect(claimable).to.be.gt(0n);

    // Claim succeeds and mints exactly that amount.
    const balBefore = await satori.balanceOf(alice.address);
    await satori.connect(alice).claim();
    const balAfter = await satori.balanceOf(alice.address);
    expect(balAfter - balBefore).to.equal(claimable);
  });
});
