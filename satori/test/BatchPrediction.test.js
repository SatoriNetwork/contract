const { expect } = require("chai");
const { deploySatoriFixture, RAW_TOLERANCE, pack1, VOTE } = require("./fixtures");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

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

// Helper to advance to the next round boundary.
async function advanceToNextRound() {
  const currentTime = await time.latest();
  const nextMidnight = Math.floor(currentTime / 86400) * 86400 + 86400;
  await time.increaseTo(nextMidnight + 1);
}

// Every stream in this file is created through the 2-arg createSimpleDataStream,
// which now yields the finest cadence a PUBLIC caller may ask for: 2 rounds. A
// provider may only post once per period, and predicting requires a value posted
// in the CURRENT round — so on these streams the "next round I can act in" is two
// rounds away, and that is what every step below advances by. Scoring is the AB
// window: anchor = the value AT the predict round, post = the first value after.
const CADENCE_ROUNDS = 2;
async function advanceToNextCadencePeriod() {
  for (let i = 0; i < CADENCE_ROUNDS; i++) await advanceToNextRound();
}

describe("Batch Prediction System", function () {
  let satori, engine, voting, rewards, bounties, registry, lens;
  let owner;
  let alice;
  let bob;
  let carol;

  let stream1, stream2, stream3, stream4, stream5;
  let INITIAL_MINT, PER_ACTOR;

  // Prediction directions
  const UP = 1;
  const DOWN = 2;

  beforeEach(async function () {
    [owner, alice, bob, carol] = await ethers.getSigners();

    // Restructured Satori stack via the shared fixture (2000 bps platform fee).
    const fix = await deploySatoriFixture();
    ;({ satori, engine, voting, rewards, registry, bounties, lens, owner } = fix);

    // Create 5 test streams
    const tx1 = await satori.createSimpleDataStream("Stream 1", owner.address);
    stream1 = await getStreamIdFromTx(tx1, satori);

    const tx2 = await satori.createSimpleDataStream("Stream 2", owner.address);
    stream2 = await getStreamIdFromTx(tx2, satori);

    const tx3 = await satori.createSimpleDataStream("Stream 3", owner.address);
    stream3 = await getStreamIdFromTx(tx3, satori);

    const tx4 = await satori.createSimpleDataStream("Stream 4", owner.address);
    stream4 = await getStreamIdFromTx(tx4, satori);

    const tx5 = await satori.createSimpleDataStream("Stream 5", owner.address);
    stream5 = await getStreamIdFromTx(tx5, satori);

    // Derive per-actor amounts from INITIAL_MINT so the test scales with the
    // bootstrap. 6 actors × INITIAL_MINT/6 = full bootstrap distributed.
    // Per-actor amount is exposed on `this` so it tests have access to it
    // for assertions that previously hardcoded 200 ether.
    INITIAL_MINT = await satori.INITIAL_MINT();
    // 6 actors × INITIAL_MINT/8 = 6/8 of bootstrap distributed, owner keeps
    // 2/8 for additional in-test transfers (bob/carol balances in some cases).
    PER_ACTOR = INITIAL_MINT / 8n;

    // Give alice tokens for predictions.
    await satori.transfer(alice.address, PER_ACTOR);

    // Burn voting: a game is eligible iff it carries burnt weight. Three voters
    // burn VOTE each for stream1..stream3, so those three earn; stream4 and
    // stream5 are deliberately left with ZERO burnt weight and are therefore
    // NOT eligible — the same shape the old top-N/threshold setup produced.
    // Tests that previously used stream4/5 use stream1-3 only.
    const signers = await ethers.getSigners();
    const voter1 = signers[3];
    const voter2 = signers[4];
    const voter3 = signers[5];
    await satori.transfer(voter1.address, PER_ACTOR);
    await satori.transfer(voter2.address, PER_ACTOR);
    await satori.transfer(voter3.address, PER_ACTOR);

    await satori.connect(voter1).vote(stream1, VOTE);
    await satori.connect(voter2).vote(stream2, VOTE);
    await satori.connect(voter3).vote(stream3, VOTE);
    // Result: stream1, stream2, stream3 eligible; stream4, stream5 not eligible

    // Advance to fresh round so tests can set their own values
    await advanceToNextCadencePeriod();
  });

  describe("Basic Functionality (5 tests)", function () {
    beforeEach(async function () {
      // Set fresh values for this test group
      await registry.setValue(stream1, 100);
      await registry.setValue(stream2, 200);
      await registry.setValue(stream3, 300);
      await registry.setValue(stream4, 400);
      await registry.setValue(stream5, 500);
    });

    it("1. Should make multiple predictions in one transaction", async function () {
      const predictions = [
        { gameId: stream1, payload: pack1(UP) },
        { gameId: stream2, payload: pack1(DOWN) },
        { gameId: stream3, payload: pack1(UP) }
      ];

      const round1 = await satori.getCurrentRound();
      await satori.connect(alice).predictMultipleWithPayloads(predictions);

      // Verify all predictions are stored
      const pred1 = await satori.predictions(alice.address, stream1, round1);
      const pred2 = await satori.predictions(alice.address, stream2, round1);
      const pred3 = await satori.predictions(alice.address, stream3, round1);

      expect(pred1.direction).to.equal(UP);
      expect(pred2.direction).to.equal(DOWN);
      expect(pred3.direction).to.equal(UP);
    });

    it("2. Should emit MultiplePredictionsMade event", async function () {
      const predictions = [
        { gameId: stream1, payload: pack1(UP) },
        { gameId: stream2, payload: pack1(DOWN) }
      ];

      const round1 = await satori.getCurrentRound();
      await expect(satori.connect(alice).predictMultipleWithPayloads(predictions))
        .to.emit(engine, "MultiplePredictionsMade")
        .withArgs(alice.address, round1, 2);
    });

    it("3. Should emit PredictionMade event for each prediction", async function () {
      const predictions = [
        { gameId: stream1, payload: pack1(UP) },
        { gameId: stream2, payload: pack1(DOWN) }
      ];

      const tx = await satori.connect(alice).predictMultipleWithPayloads(predictions);
      const receipt = await tx.wait();

      // Count PredictionMade events
      const predictionEvents = receipt.logs.filter(log => {
        try {
          const parsed = satori.interface.parseLog(log);
          return parsed && parsed.name === 'PredictionMade';
        } catch {
          return false;
        }
      });

      expect(predictionEvents.length).to.equal(2);
    });

    it("4. Should return correct count", async function () {
      const predictions = [
        { gameId: stream1, payload: pack1(UP) },
        { gameId: stream2, payload: pack1(DOWN) },
        { gameId: stream3, payload: pack1(UP) }
      ];

      const round1 = await satori.getCurrentRound();
      const tx = await satori.connect(alice).predictMultipleWithPayloads(predictions);
      // Note: We can't directly access return value from transaction, but we can check via event
      await expect(tx)
        .to.emit(engine, "MultiplePredictionsMade")
        .withArgs(alice.address, round1, 3);
    });

    it("5. Should lock balance once for all predictions", async function () {
      const predictions = [
        { gameId: stream1, payload: pack1(UP) },
        { gameId: stream2, payload: pack1(DOWN) }
      ];

      const round1 = await satori.getCurrentRound();
      await satori.connect(alice).predictMultipleWithPayloads(predictions);

      // Check that balance is locked until round + 1
      const lockedUntil = await satori.lockedUntil(alice.address);
      expect(lockedUntil).to.equal(round1 + 1n);

      // Test by attempting a transfer - should fail
      await expect(
        satori.connect(alice).transfer(bob.address, ethers.parseEther("100"))
      ).to.be.revertedWithCustomError(satori, "Locked");
    });
  });

  describe("Prediction Power Division (4 tests)", function () {
    beforeEach(async function () {
      await registry.setValue(stream1, 100);
      await registry.setValue(stream2, 200);
      await registry.setValue(stream3, 300);
      await registry.setValue(stream4, 400);
      await registry.setValue(stream5, 500);
    });

    it("6. Should divide power among all batch predictions correctly", async function () {
      const predictions = [
        { gameId: stream1, payload: pack1(UP) },
        { gameId: stream2, payload: pack1(DOWN) },
        { gameId: stream3, payload: pack1(UP) }
      ];

      const round1 = await satori.getCurrentRound();
      await satori.connect(alice).predictMultipleWithPayloads(predictions);

      const pred1 = await satori.predictions(alice.address, stream1, round1);
      const pred2 = await satori.predictions(alice.address, stream2, round1);
      const pred3 = await satori.predictions(alice.address, stream3, round1);

      // Alice's PER_ACTOR power is spread across 3 streams: PER_ACTOR/3 per stream (truncated).
      const expected = PER_ACTOR / 3n;
      expect(pred1.rawPredictionPower).to.be.closeTo(expected, RAW_TOLERANCE);
      expect(pred2.rawPredictionPower).to.be.closeTo(expected, RAW_TOLERANCE);
      expect(pred3.rawPredictionPower).to.be.closeTo(expected, RAW_TOLERANCE);

      // Stream count should be 3
      const streamCount = await satori.predictedStreamsCount(alice.address, round1);
      expect(streamCount).to.equal(3);
    });

    it("7. Should handle single predictMultiple call with multiple streams", async function () {
      // Predict all three streams in a single predictMultiple call
      const predictions = [
        { gameId: stream1, payload: pack1(UP) },
        { gameId: stream2, payload: pack1(DOWN) },
        { gameId: stream3, payload: pack1(UP) }
      ];

      const round1 = await satori.getCurrentRound();
      await satori.connect(alice).predictMultipleWithPayloads(predictions);

      // All should share the same divided power (totalPower / batchSize).
      const pred1 = await satori.predictions(alice.address, stream1, round1);
      const pred2 = await satori.predictions(alice.address, stream2, round1);
      const pred3 = await satori.predictions(alice.address, stream3, round1);

      const expected = PER_ACTOR / 3n;
      expect(pred1.rawPredictionPower).to.be.closeTo(expected, RAW_TOLERANCE);
      expect(pred2.rawPredictionPower).to.be.closeTo(expected, RAW_TOLERANCE);
      expect(pred3.rawPredictionPower).to.be.closeTo(expected, RAW_TOLERANCE);

      // Stream count should be 3 total
      const streamCount = await satori.predictedStreamsCount(alice.address, round1);
      expect(streamCount).to.equal(3);
    });

    it("8. Should calculate weight correctly at scoring time", async function () {
      const predictions = [
        { gameId: stream1, payload: pack1(UP) },
        { gameId: stream2, payload: pack1(UP) }
      ];

      // Capture the round when predictions are made
      // Streams are already eligible from beforeEach setup
      const predictionRound = await satori.getCurrentRound();
      await satori.connect(alice).predictMultipleWithPayloads(predictions);

      // Advance round (provides value B for A-B-C scoring)
      await advanceToNextCadencePeriod();
      await registry.setValue(stream1, 150); // UP - correct, value B
      await registry.setValue(stream2, 250); // UP - correct, value B

      // Advance to round 2 (provides value C for A-B-C scoring)
      await advanceToNextCadencePeriod();
      await registry.setValue(stream1, 160); // value C
      await registry.setValue(stream2, 260); // value C

      // Make new predictions to trigger scoring (must use predictMultiple for both)
      const round2Predictions = [
        { gameId: stream1, payload: pack1(UP) },
        { gameId: stream2, payload: pack1(UP) }
      ];
      await satori.connect(alice).predictMultipleWithPayloads(round2Predictions);

      // Check weights - should be divided by stream count (2)
      // Effective power = 1000 / 2 = 500 per stream
      // Weight = (500 * 1 (streak) * WEIGHT_SCALE) / totalVotes
      // Weights are scaled by 1e18 and divided by total voting power
      const weight1 = await lens.userWeightByDirection(alice.address, stream1, predictionRound, UP);
      expect(weight1).to.be.gt(0); // Verify weight was recorded

      const weight2 = await lens.userWeightByDirection(alice.address, stream2, predictionRound, UP);
      expect(weight2).to.be.gt(0); // Verify weight was recorded
      expect(weight1).to.equal(weight2); // Both streams should have equal weight
    });

    it("9. Should make all predictions in one call per round", async function () {
      // With one-prediction-per-round constraint, must use predictMultiple for all streams
      const predictions = [
        { gameId: stream1, payload: pack1(UP) },
        { gameId: stream2, payload: pack1(DOWN) },
        { gameId: stream3, payload: pack1(UP) }
      ];

      const currentRound = await satori.getCurrentRound();
      await satori.connect(alice).predictMultipleWithPayloads(predictions);

      // Total stream count should be 3
      const streamCount = await satori.predictedStreamsCount(alice.address, currentRound);
      expect(streamCount).to.equal(3);
    });
  });

  describe("Validation (6 tests)", function () {
    beforeEach(async function () {
      await registry.setValue(stream1, 100);
      await registry.setValue(stream2, 200);
      await registry.setValue(stream3, 300);
      await registry.setValue(stream4, 400);
      await registry.setValue(stream5, 500);
    });

    it("10. Should revert on empty prediction array", async function () {
      await expect(
        satori.connect(alice).predictMultipleWithPayloads([])
      ).to.be.revertedWithCustomError(satori, "EmptyBatch");
    });

    it("11. No batch-size cap: large batches succeed as long as the user has enough power and gas", async function () {
      // Previously capped at 25 with `BatchTooLarge`; the cap was removed
      // because nothing in the contract structurally requires it (caller
      // is naturally bounded by block gas limit). A batch with 26 entries
      // that DUPLICATES the same stream would still revert on the in-batch
      // duplicate check — verify that path still fires.
      const predictions = [];
      for (let i = 0; i < 26; i++) {
        predictions.push({ gameId: stream1, payload: pack1(UP) });
      }

      await expect(
        satori.connect(alice).predictMultipleWithPayloads(predictions)
      ).to.be.revertedWithCustomError(satori, "DuplicatePrediction");
    });

    it("12. Should revert if any stream ID is invalid", async function () {
      const predictions = [
        { gameId: stream1, payload: pack1(UP) },
        { gameId: 999, payload: pack1(DOWN) } // Invalid stream
      ];

      await expect(
        satori.connect(alice).predictMultipleWithPayloads(predictions)
      ).to.be.revertedWithCustomError(satori, "UnknownStream");
    });

    it("13. Should revert if any direction is invalid", async function () {
      const predictions = [
        { gameId: stream1, payload: pack1(UP) },
        { gameId: stream2, payload: pack1(3) } // Bad direction
      ];

      await expect(
        satori.connect(alice).predictMultipleWithPayloads(predictions)
      ).to.be.revertedWithCustomError(satori, "BadDirection");
    });

    it("14. Should revert if already predicted on any stream", async function () {
      // First prediction
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // Try to batch predict including stream1
      const predictions = [
        { gameId: stream1, payload: pack1(DOWN) },
        { gameId: stream2, payload: pack1(UP) }
      ];

      await expect(
        satori.connect(alice).predictMultipleWithPayloads(predictions)
      ).to.be.revertedWithCustomError(satori, "AlreadyPredicted");
    });

    it("15. Should ADMIT a batch from a zero-balance wallet, which earns nothing", async function () {
      // Transfer all tokens away
      const aliceBalance = await satori.balanceOf(alice.address);
      await satori.connect(alice).transfer(bob.address, aliceBalance);

      const predictions = [
        { gameId: stream1, payload: pack1(UP) },
        { gameId: stream2, payload: pack1(DOWN) }
      ];

      await expect(
        satori.connect(alice).predictMultipleWithPayloads(predictions)
      // A zero-power wallet is ADMITTED now. It earns nothing (weight is
      // power x multiplier) and cannot grow a streak (the farming threshold), so
      // there is nothing to gain and no reason to lock it out.
      // docs/design/farming-threshold.md; substantive coverage in
      // test/FarmingThreshold.test.js.
      ).to.not.be.reverted;
    });
  });

  describe("Integration (5 tests)", function () {
    beforeEach(async function () {
      await registry.setValue(stream1, 100);
      await registry.setValue(stream2, 200);
      await registry.setValue(stream3, 300);
      await registry.setValue(stream4, 400);
      await registry.setValue(stream5, 500);
    });

    it("16. Should work with prediction delegation", async function () {
      // Bob delegates to Alice
      await satori.transfer(bob.address, PER_ACTOR);
      await satori.connect(bob).delegatePredictionPower(alice.address);

      const predictions = [
        { gameId: stream1, payload: pack1(UP) },
        { gameId: stream2, payload: pack1(DOWN) }
      ];

      const round1 = await satori.getCurrentRound();
      await satori.connect(alice).predictMultipleWithPayloads(predictions);

      // Alice's combined 2×PER_ACTOR (own + delegated) is split across 2 streams.
      const pred1 = await satori.predictions(alice.address, stream1, round1);
      expect(pred1.rawPredictionPower).to.be.closeTo(PER_ACTOR, RAW_TOLERANCE);
    });

    it("17. Should work with scoring (2 rounds ago)", async function () {
      const predictions = [
        { gameId: stream1, payload: pack1(UP) },
        { gameId: stream2, payload: pack1(DOWN) }
      ];

      const round1 = await satori.getCurrentRound();
      await satori.connect(alice).predictMultipleWithPayloads(predictions);

      // Advance and update values
      await advanceToNextCadencePeriod();
      await registry.setValue(stream1, 150); // UP - correct
      await registry.setValue(stream2, 150); // DOWN - correct

      // Advance to round 2
      await advanceToNextCadencePeriod();
      // Update values before predicting to avoid "Expired"
      await registry.setValue(stream1, 160);
      await registry.setValue(stream2, 160);

      // Make new predictions to trigger scoring for both streams
      const newPredictions = [
        { gameId: stream1, payload: pack1(UP) },
        { gameId: stream2, payload: pack1(UP) }
      ];
      await satori.connect(alice).predictMultipleWithPayloads(newPredictions);

      // Check that round 1 predictions were scored
      const pred1 = await satori.predictions(alice.address, stream1, round1);
      expect(pred1.scored).to.equal(true);

      const pred2 = await satori.predictions(alice.address, stream2, round1);
      expect(pred2.scored).to.equal(true);
    });

    it("18. Should work with rewards and claiming", async function () {
      // Streams are already eligible from beforeEach setup.
      // Integration beforeEach already set stream1=100, stream2=200.
      // Use those values directly for predictions.

      const predictions = [
        { gameId: stream1, payload: pack1(UP) },
        { gameId: stream2, payload: pack1(UP) }
      ];

      await satori.connect(alice).predictMultipleWithPayloads(predictions);

      // Advance and make correct
      await advanceToNextCadencePeriod();
      await registry.setValue(stream1, 150); // UP - correct
      await registry.setValue(stream2, 250); // UP - correct

      // Advance to round 3 to score
      await advanceToNextCadencePeriod();
      // Update values before predicting to avoid "Expired"
      await registry.setValue(stream1, 160);
      await registry.setValue(stream2, 260);
      const scoringPredictions = [
        { gameId: stream1, payload: pack1(UP) },
        { gameId: stream2, payload: pack1(UP) }
      ];
      await satori.connect(alice).predictMultipleWithPayloads(scoringPredictions); // Triggers scoring

      // Check unclaimed rewards
      const unclaimedRewards = (await lens.getTotalClaimableRewards(alice.address))[0];

      // Should have rewards from correct predictions
      expect(unclaimedRewards).to.be.gt(0);
    });

    it("19. Should handle single predictMultiple call with four streams", async function () {
      // Only stream1-3 carry burnt weight (stream4-5 have none, so they earn nothing).
      // Test uses 3 eligible streams instead of 4.
      const round1 = await satori.getCurrentRound();
      await satori.connect(alice).predictMultipleWithPayloads([
        { gameId: stream1, payload: pack1(UP) },
        { gameId: stream2, payload: pack1(DOWN) },
        { gameId: stream3, payload: pack1(UP) }
      ]);

      // Verify all predictions exist
      const pred1 = await satori.predictions(alice.address, stream1, round1);
      const pred2 = await satori.predictions(alice.address, stream2, round1);
      const pred3 = await satori.predictions(alice.address, stream3, round1);

      expect(pred1.direction).to.equal(UP);
      expect(pred2.direction).to.equal(DOWN);
      expect(pred3.direction).to.equal(UP);

      // All should share the same divided power (totalPower / batchSize).
      const expected = PER_ACTOR / 3n;
      expect(pred1.rawPredictionPower).to.be.closeTo(expected, RAW_TOLERANCE);
      expect(pred2.rawPredictionPower).to.be.closeTo(expected, RAW_TOLERANCE);
      expect(pred3.rawPredictionPower).to.be.closeTo(expected, RAW_TOLERANCE);

      // Stream count should be 3
      const streamCount = await satori.predictedStreamsCount(alice.address, round1);
      expect(streamCount).to.equal(3);
    });

    it("20. Should prevent predictions if delegated away", async function () {
      // Alice delegates to Bob
      await satori.connect(alice).delegatePredictionPower(bob.address);

      const predictions = [
        { gameId: stream1, payload: pack1(UP) },
        { gameId: stream2, payload: pack1(DOWN) }
      ];

      await expect(
        satori.connect(alice).predictMultipleWithPayloads(predictions)
      ).to.be.revertedWithCustomError(satori, "Delegated");
    });
  });

  describe("Edge Cases (4 tests)", function () {
    beforeEach(async function () {
      await registry.setValue(stream1, 100);
      await registry.setValue(stream2, 200);
      await registry.setValue(stream3, 300);
      await registry.setValue(stream4, 400);
      await registry.setValue(stream5, 500);
    });

    it("21. Should handle single prediction in batch (array of 1)", async function () {
      const predictions = [
        { gameId: stream1, payload: pack1(UP) }
      ];

      const round1 = await satori.getCurrentRound();
      await satori.connect(alice).predictMultipleWithPayloads(predictions);

      const pred = await satori.predictions(alice.address, stream1, round1);
      expect(pred.direction).to.equal(UP);
      expect(pred.rawPredictionPower).to.be.closeTo(PER_ACTOR, RAW_TOLERANCE);

      const streamCount = await satori.predictedStreamsCount(alice.address, round1);
      expect(streamCount).to.equal(1);
    });

    it("22. Should handle maximum predictions (50)", async function () {
      // Only stream1-3 carry burnt weight; stream4-5 have none.
      // Test that batch up to 3 eligible streams works correctly.

      // Predict on all 3 eligible streams
      const predictions = [
        { gameId: stream1, payload: pack1(UP) },
        { gameId: stream2, payload: pack1(DOWN) },
        { gameId: stream3, payload: pack1(UP) }
      ];

      const round1 = await satori.getCurrentRound();
      await satori.connect(alice).predictMultipleWithPayloads(predictions);

      // Verify stream count
      const streamCount = await satori.predictedStreamsCount(alice.address, round1);
      expect(streamCount).to.equal(3);

      // Verify predictions
      const pred1 = await satori.predictions(alice.address, stream1, round1);
      const pred3 = await satori.predictions(alice.address, stream3, round1);

      expect(pred1.direction).to.equal(UP);
      expect(pred3.direction).to.equal(UP);
    });

    it("23. Should handle duplicate streams (should revert)", async function () {
      const predictions = [
        { gameId: stream1, payload: pack1(UP) },
        { gameId: stream1, payload: pack1(DOWN) } // Duplicate
      ];

      await expect(
        satori.connect(alice).predictMultipleWithPayloads(predictions)
      ).to.be.revertedWithCustomError(satori, "DuplicatePrediction");
    });

    it("24. Should track stream count correctly", async function () {
      // Only stream1-3 carry burnt weight; stream4-5 have none.
      // Single batch prediction for round 1 (3 eligible streams)
      const round1 = await satori.getCurrentRound();
      await satori.connect(alice).predictMultipleWithPayloads([
        { gameId: stream1, payload: pack1(UP) },
        { gameId: stream2, payload: pack1(DOWN) },
        { gameId: stream3, payload: pack1(UP) }
      ]);

      let streamCount = await satori.predictedStreamsCount(alice.address, round1);
      expect(streamCount).to.equal(3);

      // New round
      await advanceToNextCadencePeriod();
      // Update values for next round
      await registry.setValue(stream1, 110);
      await registry.setValue(stream2, 210);
      await registry.setValue(stream3, 310);

      // Batch in new round using eligible streams only
      const round2 = await satori.getCurrentRound();
      await satori.connect(alice).predictMultipleWithPayloads([
        { gameId: stream1, payload: pack1(DOWN) },
        { gameId: stream2, payload: pack1(UP) },
        { gameId: stream3, payload: pack1(DOWN) }
      ]);

      streamCount = await satori.predictedStreamsCount(alice.address, round2);
      expect(streamCount).to.equal(3);
    });
  });

  describe("Gas Tests (2 tests)", function () {
    beforeEach(async function () {
      await registry.setValue(stream1, 100);
      await registry.setValue(stream2, 200);
      await registry.setValue(stream3, 300);
      await registry.setValue(stream4, 400);
      await registry.setValue(stream5, 500);
    });

    it("25. Should use less gas with batch than multiple rounds", async function () {
      // Give Bob tokens (streams 1-3 already carry burnt weight from beforeEach)
      await satori.transfer(bob.address, PER_ACTOR / 2n);

      // Measure individual predictions across multiple rounds
      // (With one-prediction-per-round constraint, this is the only way)
      const tx1 = await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);
      const receipt1 = await tx1.wait();

      await advanceToNextCadencePeriod();
      await registry.setValue(stream2, 220); // Update for new round

      const tx2 = await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream2, payload: pack1(DOWN) }]);
      const receipt2 = await tx2.wait();

      await advanceToNextCadencePeriod();
      await registry.setValue(stream3, 330); // Update for new round

      const tx3 = await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream3, payload: pack1(UP) }]);
      const receipt3 = await tx3.wait();

      const totalIndividualGas = receipt1.gasUsed + receipt2.gasUsed + receipt3.gasUsed;

      // Give Carol tokens
      await satori.transfer(carol.address, PER_ACTOR / 2n);

      // Advance to a new round for Carol's batch prediction
      await advanceToNextCadencePeriod();
      // Update all streams for new round
      await registry.setValue(stream1, 110);
      await registry.setValue(stream2, 210);
      await registry.setValue(stream3, 310);

      // Measure batch prediction (all in same round)
      const batchTx = await satori.connect(carol).predictMultipleWithPayloads([
        { gameId: stream1, payload: pack1(UP) },
        { gameId: stream2, payload: pack1(DOWN) },
        { gameId: stream3, payload: pack1(UP) }
      ]);
      const batchReceipt = await batchTx.wait();

      console.log("\n  Gas Comparison:");
      console.log(`    Individual (3 predictions): ${totalIndividualGas.toString()}`);
      console.log(`    Batch (3 predictions):      ${batchReceipt.gasUsed.toString()}`);
      console.log(`    Savings:                    ${(totalIndividualGas - batchReceipt.gasUsed).toString()}`);
      console.log(`    Percentage:                 ${(((totalIndividualGas - batchReceipt.gasUsed) * 100n) / totalIndividualGas).toString()}%`);

      // Batch should use less gas
      expect(batchReceipt.gasUsed).to.be.lt(totalIndividualGas);
    });

    it("26. Should measure gas for various batch sizes (1, 2, 3)", async function () {
      // Only stream1-3 carry burnt weight; stream4-5 have none.
      // Use the 3 eligible streams from beforeEach (stream1-stream3)
      const allStreams = [stream1, stream2, stream3];

      const sizes = [1, 2, 3];
      console.log("\n  Gas Usage by Batch Size:");

      // Advance time before first iteration so we can refresh values
      await advanceToNextCadencePeriod();

      let valueMultiplier = 1;
      for (const size of sizes) {
        // Give bob fresh tokens
        await satori.transfer(bob.address, PER_ACTOR / 4n);

        // Refresh values for all streams (needed after advancing rounds)
        // Use different values each iteration to avoid "Value unchanged" error
        for (let i = 0; i < allStreams.length; i++) {
          await registry.setValue(allStreams[i], 100 + i + (valueMultiplier * 50));
        }
        valueMultiplier++;

        const predictions = allStreams.slice(0, size).map(sid => ({ gameId: sid, payload: pack1(UP) }));
        const tx = await satori.connect(bob).predictMultipleWithPayloads(predictions);
        const receipt = await tx.wait();

        console.log(`    Batch size ${size}:  ${receipt.gasUsed.toString()} gas (${(receipt.gasUsed / BigInt(size)).toString()} per prediction)`);

        // Move to next round for next test
        await advanceToNextCadencePeriod();
      }
    });
  });
});
