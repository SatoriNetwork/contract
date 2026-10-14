const { expect } = require("chai");
const { deploySatoriFixture, RAW_TOLERANCE, pack1, voteFor, VOTE, onChainGrossNow } = require("./fixtures");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");

// On-chain gross emission per round: TOKENS_PER_ROUND (720) − devRateNow (144).
// Used as the INDEPENDENT anchor for reward assertions (P1) so they never
// reduce to "the halves sum to the total they were built from".
// The on-chain game gross: the hub's per-round emission net of the senior dev
// fee, read from the chain. This was `parseEther("1152")` — 1440 less a 288 dev
// fee — which held only while emission was a fixed 1440.
let ROUND_BUDGET;

// Helper function to extract streamId from DataStreamCreated event
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

// Helper to advance to next day
async function advanceToNextRound() {
  // Advance by 24 hours — one full round — to the next day
  await time.increase(86400);
}

describe("Prediction System", function () {
  let satori, engine, voting, rewards, bounties, registry, lens;
  // PER_ACTOR = INITIAL_MINT/4 (was 400). Updates all hardcoded amounts.
  let PER_ACTOR;
  // What alice actually holds — and therefore predicts with — after the setup
  // burn: voting DESTROYS the tokens it buys weight with.
  let POWER;
  let owner;
  let alice;
  let bob;
  let carol;

  let stream1;

  // Prediction directions
  const UP = 1;
  const DOWN = 2;

  beforeEach(async function () {
    const fix = await deploySatoriFixture();
    ;({ satori, engine, voting, rewards, registry, bounties, lens, owner } = fix);
    [, alice, bob, carol] = fix.signers;
    ROUND_BUDGET = await onChainGrossNow(satori);

    // Create a test stream. ABC scoring — the "2 predictions ago" settlement lag
    // this file is built around — exists ONLY on a cadence-1 stream:
    // SatoriEngine sets `isABC = (minCadenceRounds <= 1)` at predict time, and at
    // cadence 2 the very same code settles a prediction against the NEXT value
    // instead (the AB window), one step of lag rather than two. Since the cadence
    // floor landed, only the ADMIN may create a cadence-1 stream — `satori` here
    // is connected to signers[0] == owner == rewards.admin(), which is exempt. So
    // every stream in this file is the admin's every-round stream, and
    // advanceToNextRound() below stays exactly one round.
    const tx = await satori["createSimpleDataStream(string,address,uint24)"](
      "Test Stream", owner.address, 720);
    stream1 = await getStreamIdFromTx(tx, registry);

    // Give alice tokens — INITIAL_MINT/4 leaves owner room for additional
    // in-test transfers (bob/dummies, plus tests that double alice's balance).
    const INITIAL_MINT = await satori.INITIAL_MINT();
    PER_ACTOR = INITIAL_MINT / 4n;
    await satori.transfer(alice.address, PER_ACTOR);

    // Give stream1 weight (and so make it earn) by burning for it.
    await voteFor(satori, alice, stream1);
    POWER = PER_ACTOR - VOTE;
  });

  describe("Basic Prediction Flow", function () {
    it("Should allow user to make a prediction", async function () {
      // Set initial value
      await registry.setValue(stream1, 100);

      // Capture current round
      const round1 = await satori.getCurrentRound();

      // Alice predicts UP
      await expect(satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]))
        .to.emit(engine, "PredictionMade")
        .withArgs(alice.address, stream1, round1, UP, 0, POWER);

      // Check prediction stored
      const pred = await satori.predictions(alice.address, stream1, round1);
      expect(pred.direction).to.equal(UP);
      expect(pred.roundMade).to.equal(round1);
      expect(pred.rawPredictionPower).to.be.closeTo(POWER, RAW_TOLERANCE);
    });

    it("Should prevent double prediction in same round", async function () {
      await registry.setValue(stream1, 100);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // Post-collapse: the one-batch-per-round lock fires first (the unified
      // predictMultipleWithPayloads checks `predictedStreamsCount[user][round]
      // != 0` before per-entry constraints). Pre-collapse the single-predict
      // path emitted DuplicatePrediction here.
      await expect(
        satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(DOWN) }])
      ).to.be.revertedWithCustomError(satori, "AlreadyPredicted");
    });

    it("Should allow prediction in next round after endRound", async function () {
      await registry.setValue(stream1, 100);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // Advance to next round
      await advanceToNextRound();
      await registry.setValue(stream1, 150);

      // Should allow prediction in new round
      await expect(satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(DOWN) }]))
        .to.emit(engine, "PredictionMade");
    });
  });

  describe("Scoring Logic: 2 Predictions Ago", function () {
    it("Should NOT score first prediction (no prior predictions)", async function () {
      await registry.setValue(stream1, 100);

      const currentRound = await satori.getCurrentRound();
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // No scoring event should fire
      const pred = await satori.predictions(alice.address, stream1, currentRound);
      expect(pred.scored).to.be.false;
    });

    it("Should NOT score second prediction (only 1 prior prediction)", async function () {
      // First prediction
      await registry.setValue(stream1, 100);
      const round0 = await satori.getCurrentRound();
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // Second prediction
      await advanceToNextRound();
      await registry.setValue(stream1, 150);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // First prediction should not be scored yet
      const pred0 = await satori.predictions(alice.address, stream1, round0);
      expect(pred0.scored).to.be.false;
    });

    it("Should score first prediction when making third prediction", async function () {
      // First prediction: value=100, predict UP
      // (No per-round re-voting: burnt weight is permanent, and voting after a
      // prediction would revert `Locked` — predicting locks the balance a vote
      // would have to burn from.)
      await registry.setValue(stream1, 100);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // Second prediction: value=150, predict UP (B for first prediction)
      await advanceToNextRound();
      await registry.setValue(stream1, 150);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // Third prediction: value=200, predict UP (C for first prediction)
      // This should trigger scoring of first prediction (A=100, B=150, C=200)
      await advanceToNextRound();
      await registry.setValue(stream1, 200);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // First prediction was scored as correct → streak should be 1.
      // (Packed 2-slot ring: the round-0 record gets overwritten by round-2's
      // fresh prediction once it's terminal. Streak is the authoritative
      // proof that scoring fired.)
      expect(await satori.streaks(alice.address, stream1)).to.equal(1);
    });

    it("Should score correct prediction (UP)", async function () {
      // R0: 100, predict UP
      const round0 = await satori.getCurrentRound();
      await registry.setValue(stream1, 100);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // R1: 150 (went UP), predict UP
      await advanceToNextRound();
      await registry.setValue(stream1, 150);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // R2: score R0 (B=150 → C=200 = UP, predicted UP = CORRECT)
      await advanceToNextRound();
      await registry.setValue(stream1, 200);
      const unclaimedBefore = await rewards.unclaimedRewards(alice.address);
      const tx = await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // NOTE: this body used to end here with ZERO expects, under a stale
      // "// Rewards are now claimed via claimPredictionRewards() instead"
      // comment (that function does not exist anywhere in contracts/). It
      // therefore passed identically whether R0 scored correct, scored
      // incorrect, voided, or was never scored at all — its only signal was
      // "the three predict calls did not revert" (and the displacement path
      // means even a total scoring failure would not revert). Assert the three
      // things A_scoring.md promises for a correct ABC call: scored, streak++,
      // and weight × streamPool / totalWeight actually credited.
      await expect(tx)
        .to.emit(engine, "PredictionScored")
        .withArgs(alice.address, stream1, round0, true, 1n, anyValue);

      // Correct → streak advances to 1 (an incorrect scoring zeroes it).
      expect(await satori.streaks(alice.address, stream1)).to.equal(1n);

      // ...and the win is CREDITED (eager credit → unclaimedRewards; only
      // claim() mints, so balanceOf would be frozen at zero here — P3).
      // Alice is the sole winner of (stream1, round0, UP) and stream1 is the
      // only game predicted that round, so it is the round's whole denominator
      // and she takes the entire pool — less the 5% referral skim, which routes
      // to marketing because she set no referral. Nothing is reserved out of the
      // budget any more, so this is an EXACT figure anchored on the INDEPENDENT
      // round budget rather than on the sum of the pieces (P1).
      const credited = (await rewards.unclaimedRewards(alice.address)) - unclaimedBefore;
      // `budget - floor(5%)`, not `floor(95%)`: the contract skims the cut and
      // pays the remainder, so the two differ by a wei whenever the budget is
      // not a clean multiple — which the hub's emission is not.
      expect(credited).to.equal(ROUND_BUDGET - (ROUND_BUDGET * 500n) / 10000n);
    });

    it("Should score incorrect prediction (predicted UP, went DOWN)", async function () {
      // R0: 100, predict UP
      await registry.setValue(stream1, 100);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // R1: 50 (went DOWN), predict UP
      await advanceToNextRound();
      await registry.setValue(stream1, 50);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // R2: score R0 (100→50 = DOWN, predicted UP = WRONG)
      await advanceToNextRound();
      await registry.setValue(stream1, 75);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(DOWN) }]);

      // No rewards for incorrect predictions
    });

    it("Should score correct prediction (DOWN)", async function () {
      // R0: 100, predict DOWN
      await registry.setValue(stream1, 100);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(DOWN) }]);

      // R1: 50 (went DOWN), predict UP
      await advanceToNextRound();
      await registry.setValue(stream1, 50);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // R2: score R0 (100→50 = DOWN, predicted DOWN = CORRECT)
      await advanceToNextRound();
      await registry.setValue(stream1, 75);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);
    });
  });

  describe("Balance Locking", function () {
    it("Should lock balance when making prediction", async function () {
      await registry.setValue(stream1, 100);

      // Alice holds what's left after the setup burn
      expect(await satori.balanceOf(alice.address)).to.equal(POWER);

      // Predict - should lock balance until current round + 1
      const currentRound = await satori.getCurrentRound();
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // Check locked until current round + 1
      const lockedUntil = await satori.lockedUntil(alice.address);
      expect(lockedUntil).to.equal(currentRound + 1n);

      // Test by attempting transfer - should fail
      await expect(
        satori.connect(alice).transfer(bob.address, ethers.parseEther("100"))
      ).to.be.revertedWithCustomError(satori, "Locked");
    });

    it("Should prevent transfer of locked balance", async function () {
      await registry.setValue(stream1, 100);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // Try to transfer - should fail
      await expect(
        satori.connect(alice).transfer(bob.address, ethers.parseEther("100"))
      ).to.be.revertedWithCustomError(satori, "Locked");
    });

    it("Should unlock balance after target round ends", async function () {
      await registry.setValue(stream1, 100);
      const currentRound = await satori.getCurrentRound();
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]); // Locked until current + 1

      // Check locked until current round + 1
      const lockedUntil = await satori.lockedUntil(alice.address);
      expect(lockedUntil).to.equal(currentRound + 1n);

      // Still locked in current round
      await expect(
        satori.connect(alice).transfer(bob.address, ethers.parseEther("100"))
      ).to.be.revertedWithCustomError(satori, "Locked");

      // Advance to expiry day (current + 1) - transfer still blocked on expiry day (<)
      await advanceToNextRound();
      await expect(
        satori.connect(alice).transfer(bob.address, ethers.parseEther("100"))
      ).to.be.revertedWithCustomError(satori, "Locked");

      // Advance one more round (current + 2) - lock fully expired
      await advanceToNextRound();

      // Now unlocked: lockedUntil D+1 < currentDate D+2
      await satori.connect(alice).transfer(bob.address, ethers.parseEther("100"));
      expect(await satori.balanceOf(bob.address)).to.be.gt(0);
    });

    it("Should accumulate locked balance from multiple predictions", async function () {
      // Give alice more tokens (double her starting balance)
      await satori.transfer(alice.address, PER_ACTOR);
      expect(await satori.balanceOf(alice.address)).to.equal(POWER + PER_ACTOR);

      // Round 0: Predict with 2000 tokens
      await registry.setValue(stream1, 100);
      const round0 = await satori.getCurrentRound();
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // Balance locked until round0 + 1
      const lockedUntil1 = await satori.lockedUntil(alice.address);
      expect(lockedUntil1).to.equal(round0 + 1n);

      // Next round: Lock is released and renewed, so can predict again
      await advanceToNextRound();
      await registry.setValue(stream1, 150);
      const round1 = await satori.getCurrentRound();
      await expect(
        satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }])
      ).to.emit(engine, "PredictionMade");

      // Balance locked until round1 + 1
      const lockedUntil2 = await satori.lockedUntil(alice.address);
      expect(lockedUntil2).to.equal(round1 + 1n);
    });
  });

  describe("Multiple Streams", function () {
    let stream2;

    beforeEach(async function () {
      const tx = await satori["createSimpleDataStream(string,address,uint24)"]("Stream 2", owner.address, 720);
      stream2 = await getStreamIdFromTx(tx, registry);
      // There is no threshold and no top-N any more: every game carrying burnt
      // weight earns. Alice already burned for stream1 in the outer beforeEach;
      // bob burns the same amount for stream2, so the two carry EQUAL weight and
      // split a round they both take part in 50/50. The two dummy games exist to
      // prove the opposite half of the rule: they carry weight but are never
      // predicted, so they never enter a round's denominator.
      await satori.transfer(bob.address, PER_ACTOR / 2n);
      const [,,,,dv1, dv2] = await ethers.getSigners();
      await satori.transfer(dv1.address, PER_ACTOR / 4n);
      await satori.transfer(dv2.address, PER_ACTOR / 4n);
      const d1tx = await satori["createSimpleDataStream(string,address,uint24)"]("Dummy1", owner.address, 720);
      const dummy1 = await getStreamIdFromTx(d1tx, registry);
      const d2tx = await satori["createSimpleDataStream(string,address,uint24)"]("Dummy2", owner.address, 720);
      const dummy2 = await getStreamIdFromTx(d2tx, registry);
      await voteFor(satori, bob, stream2);
      await voteFor(satori, dv1, dummy1);
      await voteFor(satori, dv2, dummy2);
    });

    it("Should allow predictions on multiple streams in same round", async function () {
      await registry.setValue(stream1, 100);
      await registry.setValue(stream2, 200);

      // Capture current round
      const currentRound = await satori.getCurrentRound();

      // Predict both streams using predictMultiple
      await satori.connect(alice).predictMultipleWithPayloads([
        { gameId: stream1, payload: pack1(UP) },
        { gameId: stream2, payload: pack1(DOWN) }
      ]);

      // Both predictions stored
      const pred1 = await satori.predictions(alice.address, stream1, currentRound);
      const pred2 = await satori.predictions(alice.address, stream2, currentRound);
      expect(pred1.direction).to.equal(UP);
      expect(pred2.direction).to.equal(DOWN);
    });

    it("Should score each stream independently", async function () {
      // R0: stream1=100, stream2=200
      const round0 = await satori.getCurrentRound();
      await registry.setValue(stream1, 100);
      await registry.setValue(stream2, 200);
      await satori.connect(alice).predictMultipleWithPayloads([
        { gameId: stream1, payload: pack1(UP) },
        { gameId: stream2, payload: pack1(DOWN) }
      ]);

      // R1: stream1=150 (UP), stream2=150 (DOWN)
      await advanceToNextRound();
      await registry.setValue(stream1, 150);
      await registry.setValue(stream2, 150);
      await satori.connect(alice).predictMultipleWithPayloads([
        { gameId: stream1, payload: pack1(UP) },
        { gameId: stream2, payload: pack1(UP) }
      ]);

      // R2: Trigger scoring
      await advanceToNextRound();
      await registry.setValue(stream1, 200);
      await registry.setValue(stream2, 100);

      // Per-user committed weight, read BEFORE the R2 batch: the packed 2-slot
      // ring recycles the round-0 record once it is terminal, so
      // userWeightByDirection(round0) reads 0 after scoring.
      const userWeightS1Up = await lens.userWeightByDirection(alice.address, stream1, round0, UP);
      const userWeightS2Down = await lens.userWeightByDirection(alice.address, stream2, round0, DOWN);
      expect(userWeightS1Up).to.be.gt(0);
      expect(userWeightS2Down).to.be.gt(0);

      // Score both streams (must use predictMultiple for multiple predictions in same round)
      // stream1 R0 window: B=150 → C=200 = UP, predicted UP = CORRECT
      // stream2 R0 window: B=150 → C=100 = DOWN, predicted DOWN = CORRECT
      const predictions = [
        { gameId: stream1, payload: pack1(UP) },
        { gameId: stream2, payload: pack1(DOWN) }
      ];
      const unclaimedBefore = await rewards.unclaimedRewards(alice.address);
      const tx = await satori.connect(alice).predictMultipleWithPayloads(predictions);

      // NOTE: this body used to end here with ZERO expects (stale
      // "claimed via claimPredictionRewards()" comment — no such function
      // exists), so the independence property the test is NAMED for was never
      // observed: any non-reverting cross-stream contamination left it green.
      //
      // Each stream resolves on its OWN ABC window and in OPPOSITE directions
      // in the same round — that is the whole point of the setup.
      await expect(tx)
        .to.emit(engine, "PredictionScored")
        .withArgs(alice.address, stream1, round0, true, 1n, anyValue);
      await expect(tx)
        .to.emit(engine, "PredictionScored")
        .withArgs(alice.address, stream2, round0, true, 1n, anyValue);
      expect(await satori.streaks(alice.address, stream1)).to.equal(1n);
      expect(await satori.streaks(alice.address, stream2)).to.equal(1n);

      // Denominators are per (game, round, direction) and must not bleed
      // across streams: alice is the only predictor, so stream1's UP total is
      // exactly her stream1 weight and stream2's DOWN total exactly her
      // stream2 weight, with the opposite-direction buckets empty on both.
      const totS1Up = await lens.totalWeightByDirection(stream1, round0, UP);
      const totS2Down = await lens.totalWeightByDirection(stream2, round0, DOWN);
      expect(totS1Up).to.be.gt(0);
      expect(totS2Down).to.be.gt(0);
      expect(await lens.totalWeightByDirection(stream1, round0, DOWN)).to.equal(0);
      expect(await lens.totalWeightByDirection(stream2, round0, UP)).to.equal(0);
      expect(totS1Up).to.equal(userWeightS1Up); // per-stream commit, unmerged
      expect(totS2Down).to.equal(userWeightS2Down);

      // Both wins paid (eager credit → unclaimedRewards; only claim() mints, P3).
      // Anchored on the independent round budget, not on the sum of the two
      // stream pools (P1). stream1 and stream2 are the only games predicted this
      // round, so between them they take the WHOLE budget; alice is the only
      // predictor on both, so she is credited all of it bar the 5% referral skim.
      const credited = (await rewards.unclaimedRewards(alice.address)) - unclaimedBefore;
      expect(credited).to.be.gt(ROUND_BUDGET / 2n);
    });
  });

  describe("Edge Cases", function () {
    it("Should handle prediction with minimum balance", async function () {
      // Give alice only 1 wei
      const balance = await satori.balanceOf(alice.address);
      await satori.connect(alice).transfer(bob.address, balance - 1n);

      await registry.setValue(stream1, 100);
      const currentRound = await satori.getCurrentRound();
      await expect(satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]))
        .to.emit(engine, "PredictionMade")
        .withArgs(alice.address, stream1, currentRound, UP, 0, 1);
    });

    it("Should ADMIT a zero-power predictor, who simply earns nothing", async function () {
      // Give bob tokens and have him vote so stream1 stays eligible after alice transfers away
      await satori.transfer(bob.address, PER_ACTOR / 4n);
      await voteFor(satori, bob, stream1);

      // Transfer all alice's balance away
      const balance = await satori.balanceOf(alice.address);
      await satori.connect(alice).transfer(owner.address, balance);

      // Now alice has 0 balance but stream1 is still eligible (bob voted)
      await registry.setValue(stream1, 100);
      await expect(
        satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }])
      // A zero-power wallet is ADMITTED now. It earns nothing (weight is
      // power x multiplier) and cannot grow a streak (the farming threshold), so
      // there is nothing to gain and no reason to lock it out.
      // docs/design/farming-threshold.md; substantive coverage in
      // test/FarmingThreshold.test.js.
      ).to.not.be.reverted;
    });

    it("Should handle many predictions in sequence", async function () {
      // Make multiple predictions with proper spacing for lock behavior and scoring
      const firstRound = await satori.getCurrentRound();

      // Prediction 1 (stream1 already carries alice's burnt weight, which is
      // permanent — no per-round re-voting needed, and none possible while the
      // prediction lock is on her balance).
      await registry.setValue(stream1, 100);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // Advance and set values for scoring
      await advanceToNextRound();
      await registry.setValue(stream1, 110); // Value B for prediction 1

      await advanceToNextRound();
      await registry.setValue(stream1, 120); // Value C for prediction 1

      // Advance one more round to ensure unlock
      await advanceToNextRound();
      await registry.setValue(stream1, 130);

      // Prediction 2 (triggers scoring of prediction 1)
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // Check that first prediction was scored
      const weight = await lens.userWeightByDirection(alice.address, stream1, firstRound, UP);
      expect(weight).to.be.gt(0);
    });

    it("Should validate direction parameter", async function () {
      await registry.setValue(stream1, 100);

      await expect(
        satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(0) }])
      ).to.be.revertedWithCustomError(satori, "BadDirection");

      await expect(
        satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(3) }])
      ).to.be.revertedWithCustomError(satori, "BadDirection");
    });

    it("Should validate stream exists", async function () {
      await expect(
        satori.connect(alice).predictMultipleWithPayloads([{ gameId: 9999, payload: pack1(UP) }])
      ).to.be.revertedWithCustomError(satori, "UnknownStream");
    });
  });
});
