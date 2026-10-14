/**
 * LOCK MANIPULATION TEST SUITE
 *
 * This test suite covers critical attack vectors related to the lock mechanism.
 * The lock system prevents users from transferring or predicting while their
 * tokens are committed to certain actions.
 *
 * Lock Types:
 * 1. Prediction Lock: After predicting, locked until next round
 * 2. Delegation Lock: While delegated, locked until undelegation + next round
 * 3. Max Lock: type(uint256).max for permanent delegation lock
 *
 * WHY THESE TESTS ARE CRITICAL:
 * - Locks are the primary mechanism preventing:
 *   a) Double-predictions in the same round
 *   b) Transferring tokens after committing to predictions
 *   c) Escaping delegation commitments
 * - Lock manipulation could allow:
 *   a) Using tokens multiple times per round
 *   b) Front-running predictions by transferring
 *   c) Breaking reward calculations
 *
 * ASSUMPTIONS:
 * - Test mode enabled for rapid round advancement
 * - lockedUntil[user] tracks the round until which user is locked
 * - lockedUntil <= currentRound means unlocked
 * - type(uint256).max is special value for delegation lock
 */

const { expect } = require("chai");
const { deploySatoriFixture, RAW_TOLERANCE, pack1, makeEligible } = require("./fixtures");
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

// Helper to advance to next round
async function advanceRound() {
  await time.increase(86400);
}

describe("Lock Manipulation Tests", function () {
  let satori, voting, rewards, bounties, registry;
  // PER_ACTOR = INITIAL_MINT/8 (was 200). HALF = PER_ACTOR/2 (was 100).
  // Inner transfers between actors use HALF; recipient ends with 1.5×PER_ACTOR.
  let PER_ACTOR, HALF;
  let owner, alice, bob, carol, dave;
  let stream1, stream2;

  const UP = 1;
  const DOWN = 2;

  beforeEach(async function () {
    const fix = await deploySatoriFixture();
    ;({ satori, voting, rewards, registry, bounties } = fix);
    owner = fix.owner;
    [, alice, bob, carol, dave] = fix.signers;

    // Enable test mode

    // Create test streams. The lock assertions here are stated in single
    // rounds ("locked until round + 1"), so the streams must be writable
    // every round: 1440-minute (every-round) streams.
    const tx1 = await satori["createSimpleDataStream(string,address,uint24)"]("ETH/USD", owner.address, 1440);
    stream1 = await getStreamIdFromTx(tx1, satori);

    const tx2 = await satori["createSimpleDataStream(string,address,uint24)"]("BTC/USD", owner.address, 1440);
    stream2 = await getStreamIdFromTx(tx2, satori);

    // The old third "DUMMY" stream existed only to dilute the eligibility
    // threshold so stream1 and stream2 both cleared it. There is no threshold
    // and no top-N any more — every enabled game with weight > 0 earns — so the
    // dilution stream has no job left and is gone.

    // Distribute tokens
    const INITIAL_MINT = await satori.INITIAL_MINT();
    PER_ACTOR = INITIAL_MINT / 8n;
    HALF = PER_ACTOR / 2n;
    await satori.transfer(alice.address, PER_ACTOR);
    await satori.transfer(bob.address, PER_ACTOR);
    await satori.transfer(carol.address, PER_ACTOR);
    await satori.transfer(dave.address, PER_ACTOR);

    // Weight both streams from DAVE's balance only. Voting BURNS, and every
    // lock/transfer assertion in this file is stated in exact multiples of
    // PER_ACTOR — so the burn is kept off alice/bob/carol entirely. Dave takes
    // the whole 20-SATORI cost and is otherwise unused.
    await makeEligible(satori, dave, [stream1, stream2]);

    // Set initial values
    await registry.setValue(stream1, 1000);
    await registry.setValue(stream2, 50000);
  });

  describe("1. Transfer While Prediction-Locked", function () {
    /**
     * ATTACK: Predict then immediately try to transfer
     * EXPECTED: Transfer should fail until lock expires
     * WHY: Prevents users from committing to prediction then moving tokens
     */
    it("Should prevent transfer immediately after prediction", async function () {
      // Alice predicts
      const currentRound = await satori.getCurrentRound();
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // Alice should be locked until current round + 2
      const lockedUntil = await satori.lockedUntil(alice.address);
      expect(lockedUntil).to.equal(currentRound + 1n);

      // Transfer should fail
      await expect(
        satori.connect(alice).transfer(bob.address, HALF)
      ).to.be.revertedWithCustomError(satori, "Locked");
    });

    it("Should allow transfer after lock expires", async function () {
      // Round 1: Alice predicts (locked until round 2)
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // Advance to round 2 (can predict again but not transfer)
      await advanceRound();

      // Advance to round 3 (now can transfer - one extra round for transfers)
      await advanceRound();

      // Now Alice can transfer
      await satori.connect(alice).transfer(bob.address, HALF);

      const bobBalance = await satori.balanceOf(bob.address);
      expect(bobBalance).to.equal(PER_ACTOR + HALF);
    });

    it("Should prevent transfer even with tiny amount while locked", async function () {
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // Try to transfer even 1 wei
      await expect(
        satori.connect(alice).transfer(bob.address, 1)
      ).to.be.revertedWithCustomError(satori, "Locked");
    });

    it("Should allow receiving transfers while locked", async function () {
      // Alice predicts (locked)
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // Bob sends to Alice - should succeed
      await satori.connect(bob).transfer(alice.address, HALF);

      const aliceBalance = await satori.balanceOf(alice.address);
      expect(aliceBalance).to.equal(PER_ACTOR + HALF);
    });
  });

  describe("2. Transfer While Delegation-Locked", function () {
    /**
     * ATTACK: Delegate then try to transfer
     * EXPECTED: Transfer should fail while delegated (max lock)
     * WHY: Delegated tokens shouldn't be moveable
     */
    it("Should prevent transfer while delegated", async function () {
      // Alice delegates to Bob
      await satori.connect(alice).delegatePredictionPower(bob.address);

      // Lock should be max
      const lockedUntil = await satori.lockedUntil(alice.address);
      expect(lockedUntil).to.equal(2n ** 24n - 1n);

      // Transfer should fail
      await expect(
        satori.connect(alice).transfer(carol.address, HALF)
      ).to.be.revertedWithCustomError(satori, "Locked");
    });

    it("Should prevent transfer even after delegate predicts", async function () {
      // Alice delegates to Bob
      await satori.connect(alice).delegatePredictionPower(bob.address);

      // Bob predicts using Alice's power
      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // Alice still can't transfer (still delegated)
      await expect(
        satori.connect(alice).transfer(carol.address, HALF)
      ).to.be.revertedWithCustomError(satori, "Locked");
    });

    it("Should allow transfer after undelegation and lock expiry", async function () {
      // Alice delegates to Bob
      await satori.connect(alice).delegatePredictionPower(bob.address);

      // Alice undelegates (locked until round 2)
      await satori.connect(alice).delegatePredictionPower(ethers.ZeroAddress);

      // Advance to round 2 (can predict but not transfer)
      await advanceRound();

      // Advance to round 3 (now can transfer - one extra round for transfers)
      await advanceRound();

      // Now Alice can transfer
      await satori.connect(alice).transfer(carol.address, HALF);

      const carolBalance = await satori.balanceOf(carol.address);
      expect(carolBalance).to.equal(PER_ACTOR + HALF);
    });
  });

  describe("3. Predict While Locked", function () {
    /**
     * ATTACK: Predict, then try to predict again before unlock
     * EXPECTED: Should fail - can only predict once per round
     * WHY: Prevents double predictions
     */
    it("Should prevent second prediction in same round", async function () {
      // First prediction
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // Try to predict again
      await expect(
        satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream2, payload: pack1(DOWN) }])
      ).to.be.revertedWithCustomError(satori, "AlreadyPredicted");
    });

    it("Should prevent prediction while delegated", async function () {
      // Alice delegates to Bob
      await satori.connect(alice).delegatePredictionPower(bob.address);

      // Alice tries to predict herself
      await expect(
        satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }])
      ).to.be.revertedWithCustomError(satori, "Delegated");
    });

    it("Should allow prediction after lock expires", async function () {
      // Alice predicts
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // Advance to next round
      await advanceRound();

      // Update stream value
      await registry.setValue(stream1, 1100);

      // Now Alice can predict again
      const round2 = await satori.getCurrentRound();
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(DOWN) }]);

      const prediction = await satori.predictions(alice.address, stream1, round2);
      expect(prediction.direction).to.equal(DOWN);
    });

    it("Should prevent batch prediction while locked", async function () {
      // Alice predicts on stream1
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // Try batch prediction including stream2
      await expect(
        satori.connect(alice).predictMultipleWithPayloads([
          { gameId: stream2, payload: pack1(DOWN) }
        ])
      ).to.be.revertedWithCustomError(satori, "AlreadyPredicted");
    });
  });

  describe("4. Lock Inheritance on Token Receive", function () {
    /**
     * TEST: Receive tokens while locked, verify lock applies to all tokens
     * EXPECTED: Lock is per-user, not per-token
     * WHY: Ensure you can't bypass lock by receiving fresh tokens
     */
    it("Should not allow transferring newly received tokens while locked", async function () {
      // Alice predicts (locked until round 1)
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // Alice receives tokens from Bob
      await satori.connect(bob).transfer(alice.address, HALF);

      // Alice now has 1500 tokens total
      const aliceBalance = await satori.balanceOf(alice.address);
      expect(aliceBalance).to.equal(PER_ACTOR + HALF);

      // But Alice still can't transfer ANY amount (even the new tokens)
      await expect(
        satori.connect(alice).transfer(carol.address, HALF)
      ).to.be.revertedWithCustomError(satori, "Locked");

      await expect(
        satori.connect(alice).transfer(carol.address, HALF)
      ).to.be.revertedWithCustomError(satori, "Locked");
    });

    it("Should allow transferring all tokens after lock expires", async function () {
      // Alice predicts with 1000 tokens
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // Alice receives 500 more
      await satori.connect(bob).transfer(alice.address, HALF);

      // Advance to round 2 (can predict but not transfer)
      await advanceRound();

      // Advance to round 3 (can transfer now)
      await advanceRound();

      // Alice can now transfer all 1500 tokens
      await satori.connect(alice).transfer(carol.address, PER_ACTOR + HALF);

      const aliceBalance = await satori.balanceOf(alice.address);
      expect(aliceBalance).to.equal(0);
    });

    it("Should not extend lock when receiving tokens", async function () {
      // Alice predicts (locked until current round + 2)
      const currentRound = await satori.getCurrentRound();
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      const lockedUntilBefore = await satori.lockedUntil(alice.address);

      // Alice receives tokens
      await satori.connect(bob).transfer(alice.address, HALF);

      // Lock should not change
      const lockedUntilAfter = await satori.lockedUntil(alice.address);
      expect(lockedUntilAfter).to.equal(lockedUntilBefore);
      expect(lockedUntilAfter).to.equal(currentRound + 1n);
    });
  });

  describe("5. Lock Expiration Timing", function () {
    /**
     * TEST: Lock until round N, verify can act in round N
     * EXPECTED: lockedUntil <= currentRound means unlocked
     * WHY: Ensure lock expiration logic is correct
     */
    it("Should be unlocked for prediction when currentRound equals lockedUntil", async function () {
      // Alice predicts (locked until current round + 2)
      const round1 = await satori.getCurrentRound();
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      expect(await satori.lockedUntil(alice.address)).to.equal(round1 + 1n);
      expect(await satori.getCurrentRound()).to.equal(round1);

      // Advance to round 2
      await advanceRound();

      const round2 = await satori.getCurrentRound();
      expect(round2).to.equal(round1 + 1n);

      // Alice can predict again (lockedUntil == currentRound allows prediction)
      await registry.setValue(stream1, 1100);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(DOWN) }]);

      // But transfer requires currentRound > lockedUntil
      await expect(
        satori.connect(alice).transfer(bob.address, HALF)
      ).to.be.revertedWithCustomError(satori, "Locked");
    });

    it("Should be unlocked when currentRound > lockedUntil", async function () {
      // Alice predicts (locked until round + 2)
      const round1 = await satori.getCurrentRound();
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);
      const lockUntil = round1 + 1n;

      // Advance to round 3 (2 rounds later)
      await advanceRound(); // Round 2
      await advanceRound(); // Round 3

      const round3 = await satori.getCurrentRound();
      expect(round3).to.equal(round1 + 2n);
      expect(await satori.lockedUntil(alice.address)).to.equal(lockUntil);

      // Alice should be unlocked for transfers
      await satori.connect(alice).transfer(bob.address, HALF);

      const bobBalance = await satori.balanceOf(bob.address);
      expect(bobBalance).to.equal(PER_ACTOR + HALF);
    });

    it("Should be locked when currentRound < lockedUntil", async function () {
      // Alice predicts (locked until current round + 2)
      const round1 = await satori.getCurrentRound();
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      expect(await satori.getCurrentRound()).to.equal(round1);
      expect(await satori.lockedUntil(alice.address)).to.equal(round1 + 1n);

      // Alice is locked (currentRound < lockedUntil)
      await expect(
        satori.connect(alice).transfer(bob.address, HALF)
      ).to.be.revertedWithCustomError(satori, "Locked");
    });
  });

  describe("6. Max Lock Undelegation", function () {
    /**
     * TEST: Delegate (locked forever), undelegate, verify lock resets to round+1
     * EXPECTED: Undelegation changes lock from MaxUint256 to currentRound+1
     * WHY: Users must be able to escape max lock by undelegating
     */
    it("Should change lock from MaxUint256 to currentRound+1 on undelegation", async function () {
      // Alice delegates (max lock)
      await satori.connect(alice).delegatePredictionPower(bob.address);

      expect(await satori.lockedUntil(alice.address)).to.equal(2n ** 24n - 1n);

      // Alice undelegates (use ZeroAddress for undelegation)
      await satori.connect(alice).delegatePredictionPower(ethers.ZeroAddress);

      const currentRound = await satori.getCurrentRound();
      const lockedUntil = await satori.lockedUntil(alice.address);
      expect(lockedUntil).to.equal(currentRound + 1n);
    });

    it("Should prevent immediate transfer after undelegation", async function () {
      // Delegate then undelegate
      await satori.connect(alice).delegatePredictionPower(bob.address);
      await satori.connect(alice).delegatePredictionPower(ethers.ZeroAddress);

      // Still locked until next round
      await expect(
        satori.connect(alice).transfer(carol.address, HALF)
      ).to.be.revertedWithCustomError(satori, "Locked");
    });

    it("Should allow transfer after undelegation lock expires", async function () {
      // Round 1: Delegate then undelegate (locked until round 2)
      await satori.connect(alice).delegatePredictionPower(bob.address);
      await satori.connect(alice).delegatePredictionPower(ethers.ZeroAddress);

      // Advance to round 2 (can predict but not transfer)
      await advanceRound();

      // Advance to round 3 (can transfer now)
      await advanceRound();

      // Now Alice can transfer
      await satori.connect(alice).transfer(carol.address, HALF);

      const carolBalance = await satori.balanceOf(carol.address);
      expect(carolBalance).to.equal(PER_ACTOR + HALF);
    });

    it("Should handle multiple delegation cycles correctly", async function () {
      // Cycle 1: Delegate, undelegate, wait
      await satori.connect(alice).delegatePredictionPower(bob.address);
      await satori.connect(alice).delegatePredictionPower(ethers.ZeroAddress);
      const round1 = await satori.getCurrentRound();
      await advanceRound(); // Next round

      // Cycle 2: Delegate again, undelegate again
      const round2 = await satori.getCurrentRound();
      await satori.connect(alice).delegatePredictionPower(carol.address);
      await satori.connect(alice).delegatePredictionPower(ethers.ZeroAddress);

      // Locked until current round + 1
      const currentRound = await satori.getCurrentRound();
      const lockedUntil = await satori.lockedUntil(alice.address);
      expect(lockedUntil).to.equal(currentRound + 1n);
      expect(currentRound).to.equal(round2);
      expect(lockedUntil).to.equal(round2 + 1n);
    });
  });

  describe("7. Double Prediction Attempt", function () {
    /**
     * ATTACK: Try to predict twice in same round via different methods
     * EXPECTED: All attempts should fail
     * WHY: Only one prediction batch allowed per round
     */
    it("Should prevent predict() then predictMultiple() in same round", async function () {
      // First predict on stream1
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // Try batch prediction on stream2
      await expect(
        satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream2, payload: pack1(DOWN) }])
      ).to.be.revertedWithCustomError(satori, "AlreadyPredicted");
    });

    it("Should prevent predictMultiple() then predict() in same round", async function () {
      // First batch predict
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // Try single prediction
      await expect(
        satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream2, payload: pack1(DOWN) }])
      ).to.be.revertedWithCustomError(satori, "AlreadyPredicted");
    });

    it("Should prevent two predictMultiple() calls in same round", async function () {
      // First batch
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // Second batch
      await expect(
        satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream2, payload: pack1(DOWN) }])
      ).to.be.revertedWithCustomError(satori, "AlreadyPredicted");
    });

    it("Should prevent predicting same stream twice via predictMultiple", async function () {
      await expect(
        satori.connect(alice).predictMultipleWithPayloads([
          { gameId: stream1, payload: pack1(UP) },
          { gameId: stream1, payload: pack1(DOWN) }
        ])
      ).to.be.revertedWithCustomError(satori, "DuplicatePrediction");
    });
  });

  describe("8. Batch Prediction Lock", function () {
    /**
     * TEST: Make batch prediction, verify single lock
     * EXPECTED: One lock regardless of number of predictions
     * WHY: All predictions in a batch happen in same round
     */
    it("Should set single lock for batch prediction", async function () {
      // Batch predict on both streams
      const currentRound = await satori.getCurrentRound();
      await satori.connect(alice).predictMultipleWithPayloads([
        { gameId: stream1, payload: pack1(UP) },
        { gameId: stream2, payload: pack1(DOWN) }
      ]);

      // Should be locked until current round + 2
      const lockedUntil = await satori.lockedUntil(alice.address);
      expect(lockedUntil).to.equal(currentRound + 1n);

      // Can't transfer
      await expect(
        satori.connect(alice).transfer(bob.address, HALF)
      ).to.be.revertedWithCustomError(satori, "Locked");
    });

    it("Should unlock batch prediction after one round for predictions, two for transfers", async function () {
      // Round 1: Batch predict
      await satori.connect(alice).predictMultipleWithPayloads([
        { gameId: stream1, payload: pack1(UP) },
        { gameId: stream2, payload: pack1(DOWN) }
      ]);

      // Advance to round 2 (can predict but not transfer)
      await advanceRound();

      // Advance to round 3 (can transfer now)
      await advanceRound();

      // Should be unlocked for transfers
      await satori.connect(alice).transfer(bob.address, HALF);

      const bobBalance = await satori.balanceOf(bob.address);
      expect(bobBalance).to.equal(PER_ACTOR + HALF);
    });

    it("Should use same prediction power for all streams in batch", async function () {
      // Alice has 200 tokens
      // Batch predict on 2 streams: each prediction stores totalPower/batchSize = 100 ether.
      const currentRound = await satori.getCurrentRound();
      await satori.connect(alice).predictMultipleWithPayloads([
        { gameId: stream1, payload: pack1(UP) },
        { gameId: stream2, payload: pack1(DOWN) }
      ]);

      // Check both predictions have same (divided) power
      const pred1 = await satori.predictions(alice.address, stream1, currentRound);
      const pred2 = await satori.predictions(alice.address, stream2, currentRound);

      expect(pred1.rawPredictionPower).to.be.closeTo(HALF, RAW_TOLERANCE);
      expect(pred2.rawPredictionPower).to.be.closeTo(HALF, RAW_TOLERANCE);
    });

    it("Should prevent prediction after failed batch attempt", async function () {
      // Try batch with invalid stream (should fail)
      await expect(
        satori.connect(alice).predictMultipleWithPayloads([
          { gameId: stream1, payload: pack1(UP) },
          { gameId: 999, payload: pack1(DOWN) } // Invalid stream
        ])
      ).to.be.revertedWithCustomError(satori, "UnknownStream");

      // Alice should NOT be locked (batch failed completely)
      const lockedUntil = await satori.lockedUntil(alice.address);
      expect(lockedUntil).to.equal(0); // Not locked

      // Alice can still predict normally
      const currentRound = await satori.getCurrentRound();
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      const prediction = await satori.predictions(alice.address, stream1, currentRound);
      expect(prediction.direction).to.equal(UP);
    });
  });
});
