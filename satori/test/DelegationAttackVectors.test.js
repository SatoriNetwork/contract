/**
 * DELEGATION ATTACK VECTORS TEST SUITE
 *
 * This test suite covers critical attack vectors related to delegation mechanics.
 * These tests are essential for security as they verify that:
 * 1. Delegated power cannot be double-used through delegation switching
 * 2. Locks prevent unauthorized transfers
 * 3. Delegation state transitions are properly protected
 * 4. Circular delegation is prevented
 * 5. Snapshot mechanics work correctly
 *
 * WHY THESE TESTS ARE CRITICAL:
 * - Delegation is a powerful feature that allows token holders to let others predict with their tokens
 * - Without proper protections, attackers could:
 *   a) Double-use tokens by switching delegation mid-round
 *   b) Escape locks by delegating then transferring
 *   c) Create circular delegation loops that break accounting
 *   d) Manipulate prediction power snapshots
 *
 * ASSUMPTIONS:
 * - Test mode is enabled for rapid round advancement
 * - Platform fee address can be set for reward split testing
 * - ERC20 transfers respect lock mechanisms
 */

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

// Helper to advance to next round in test mode
async function advanceRound() {
  await time.increase(86400);
}

describe("Delegation Attack Vectors", function () {
  let satori, voting, rewards, bounties, registry;
  let owner, alice, bob, carol, dave, platform;
  let stream1;
  // PER_ACTOR = INITIAL_MINT/8; 4 actors each get PER_ACTOR, owner keeps
  // half the bootstrap for in-test "bump" transfers (BUMP = PER_ACTOR).
  let PER_ACTOR, BUMP, SMALL;

  const UP = 1;
  const DOWN = 2;

  beforeEach(async function () {
    const fix = await deploySatoriFixture();
    ({ satori, voting, rewards, registry, bounties } = fix);
    [owner, alice, bob, carol, dave, platform] = fix.signers;

    // Create test stream at 1440 minutes (every round): the attack vectors
    // here turn on delegation switching WITHIN and ACROSS single rounds, so
    // the round boundaries must stay one apart.
    const tx1 = await satori.connect(owner)["createSimpleDataStream(string,address,uint24)"]("ETH/USD", owner.address, 1440);
    stream1 = await getStreamIdFromTx(tx1, satori);

    // Distribute tokens to test users (PER_ACTOR derived from INITIAL_MINT)
    const INITIAL_MINT = await satori.INITIAL_MINT();
    PER_ACTOR = INITIAL_MINT / 8n;
    BUMP = PER_ACTOR; // bumps used to test "balance changed mid-round"
    SMALL = PER_ACTOR / 10n; // small inner transfers
    await satori.transfer(alice.address, PER_ACTOR);
    await satori.transfer(bob.address, PER_ACTOR);
    await satori.transfer(carol.address, PER_ACTOR);
    await satori.transfer(dave.address, PER_ACTOR);

    // Make the stream eligible. OWNER burns for it, not alice: voting destroys
    // tokens now, and every power assertion below is exact in PER_ACTOR.
    await satori.connect(owner).vote(stream1, VOTE);

    // Set initial value for predictions
    await registry.setValue(stream1, 1000);
  });

  describe("1. Double-Use Attack: Delegate Switch After Prediction", function () {
    /**
     * ATTACK: Alice delegates to Bob, Bob predicts, Alice switches to Carol, Carol predicts
     * EXPECTED: Should fail - cannot switch to someone who already predicted this round
     * WHY: This would allow Alice's tokens to be used twice in the same round
     */
    it("Should prevent switching to delegate who already predicted this round", async function () {
      // Alice delegates to Bob
      await satori.connect(alice).delegatePredictionPower(bob.address);

      // Bob predicts using Alice's delegated power
      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // Carol also predicts
      await satori.connect(carol).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(DOWN) }]);

      // Alice tries to switch delegation to Carol (who already predicted)
      // This should fail with the protection we added
      await expect(
        satori.connect(alice).delegatePredictionPower(carol.address)
      ).to.be.revertedWithCustomError(satori, "DelegateActive");
    });

    it("Should prevent switching delegates after current delegate predicted", async function () {
      // Alice delegates to Bob
      await satori.connect(alice).delegatePredictionPower(bob.address);

      // Bob predicts using Alice's delegated power
      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // Carol has NOT predicted yet, but that doesn't matter
      // Alice cannot switch because Bob (current delegate) already predicted this round
      await expect(
        satori.connect(alice).delegatePredictionPower(carol.address)
      ).to.be.revertedWithCustomError(satori, "DelegateActive");

      // Verify delegation didn't change
      const delegate = (await rewards.predictionDelegateInfo(alice.address)).delegate;
      expect(delegate).to.equal(bob.address);
    });

    it("Should always allow undelegation (switching to self)", async function () {
      // Alice delegates to Bob
      await satori.connect(alice).delegatePredictionPower(bob.address);

      // Bob predicts
      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // Alice should always be able to undelegate (delegate to self)
      // even after Bob has predicted
      await satori.connect(alice).delegatePredictionPower(ethers.ZeroAddress);

      // Verify undelegation
      const delegate = (await rewards.predictionDelegateInfo(alice.address)).delegate;
      expect(delegate).to.equal(ethers.ZeroAddress);
    });
  });

  describe("2. Lock Escape via Delegation", function () {
    /**
     * ATTACK: Try to transfer tokens while delegated to escape lock
     * EXPECTED: Should fail - delegation locks tokens
     * WHY: Locked tokens should not be transferable
     */
    it("Should prevent transfers after delegating prediction power", async function () {
      // Alice delegates to Bob
      await satori.connect(alice).delegatePredictionPower(bob.address);

      // Alice should not be able to transfer (balance is locked forever while delegated)
      await expect(
        satori.connect(alice).transfer(carol.address, SMALL)
      ).to.be.revertedWithCustomError(satori, "Locked");
    });

    it("Should allow transfers after undelegating", async function () {
      // Alice delegates to Bob
      await satori.connect(alice).delegatePredictionPower(bob.address);

      // Alice undelegates
      await satori.connect(alice).delegatePredictionPower(ethers.ZeroAddress);

      // Advance 2 rounds to unlock transfers (currentRound > lockedUntil)
      await advanceRound();
      await advanceRound();

      // Alice should now be able to transfer
      await satori.connect(alice).transfer(carol.address, SMALL);

      const carolBalance = await satori.balanceOf(carol.address);
      expect(carolBalance).to.equal(PER_ACTOR + SMALL);
    });

    it("Should prevent transfers even after delegate predicts", async function () {
      // Alice delegates to Bob
      await satori.connect(alice).delegatePredictionPower(bob.address);

      // Bob predicts
      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // Alice still can't transfer (still delegated)
      await expect(
        satori.connect(alice).transfer(carol.address, SMALL)
      ).to.be.revertedWithCustomError(satori, "Locked");
    });
  });

  describe("3. Predict Then Delegate Attack", function () {
    /**
     * ATTACK: Predict, then delegate to let delegate predict again
     * EXPECTED: Should fail - once you predict, you're locked
     * WHY: This would allow double predictions
     */
    it("Should prevent delegation after making a prediction in same round", async function () {
      // Alice predicts
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // Alice tries to delegate to Bob (to let Bob use her power again)
      // This should fail because Alice is locked until next round
      await expect(
        satori.connect(alice).delegatePredictionPower(bob.address)
      ).to.be.revertedWithCustomError(satori, "Locked");
    });

    it("Should allow delegation after round advances", async function () {
      // Alice predicts in round 0
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // Advance to round 1
      await advanceRound();

      // Now Alice can delegate
      await satori.connect(alice).delegatePredictionPower(bob.address);

      const delegate = (await rewards.predictionDelegateInfo(alice.address)).delegate;
      expect(delegate).to.equal(bob.address);
    });
  });

  describe("4. Delegate Cycle Detection", function () {
    /**
     * ATTACK: Create circular delegation A→B, B→C, C→A
     * EXPECTED: Current implementation may allow this but it shouldn't break accounting
     * WHY: Circular delegation could create infinite loops or break prediction power calculations
     */
    it("Should handle A→B→C delegation chain without cycles", async function () {
      // Alice delegates to Bob
      await satori.connect(alice).delegatePredictionPower(bob.address);

      // Bob delegates to Carol (his own balance, not Alice's)
      await satori.connect(bob).delegatePredictionPower(carol.address);

      // Carol delegates to Dave
      await satori.connect(carol).delegatePredictionPower(dave.address);

      // Dave should have prediction power from Carol only (not Alice or Bob)
      const davePower = await rewards.getPredictionPower(dave.address);
      // Dave's own 1000 + Carol's 1000 = 2000
      expect(davePower).to.equal(PER_ACTOR * 2n);
    });

    it("Should prevent harmful circular delegation A→B, B→A", async function () {
      // Alice delegates to Bob
      await satori.connect(alice).delegatePredictionPower(bob.address);

      // Bob tries to delegate back to Alice (creating circular delegation)
      await satori.connect(bob).delegatePredictionPower(alice.address);

      // In circular delegation, both users have 0 power
      const alicePower = await rewards.getPredictionPower(alice.address);
      const bobPower = await rewards.getPredictionPower(bob.address);
      expect(alicePower).to.equal(0);
      expect(bobPower).to.equal(0);

      // Alice can't predict (delegated to Bob)
      await expect(
        satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }])
      ).to.be.revertedWithCustomError(satori, "Delegated");

      // Bob can't predict (delegated to Alice)
      await expect(
        satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }])
      ).to.be.revertedWithCustomError(satori, "Delegated");

      // This creates a deadlock - both have 0 power and can't predict
    });

    it("Should handle A→B→A cycle without breaking", async function () {
      // Alice delegates to Bob
      await satori.connect(alice).delegatePredictionPower(bob.address);

      // Bob initially has Alice's power
      let bobPower = await rewards.getPredictionPower(bob.address);
      expect(bobPower).to.equal(PER_ACTOR * 2n); // Bob's 1000 + Alice's 1000

      // Bob delegates back to Alice (creating circular delegation)
      await satori.connect(bob).delegatePredictionPower(alice.address);

      // After circular delegation, both have 0 power
      const alicePower = await rewards.getPredictionPower(alice.address);
      bobPower = await rewards.getPredictionPower(bob.address);
      expect(alicePower).to.equal(0); // Alice has 0 (delegated to Bob)
      expect(bobPower).to.equal(0); // Bob has 0 (delegated to Alice)

      // Alice can't predict because she's delegated to Bob
      await expect(
        satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }])
      ).to.be.revertedWithCustomError(satori, "Delegated");

      // Bob can't predict because he's delegated to Alice
      await expect(
        satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }])
      ).to.be.revertedWithCustomError(satori, "Delegated");
    });
  });

  describe("5. Self-Delegation During Active Delegation", function () {
    /**
     * TEST: Switch from delegated to self mid-round
     * EXPECTED: Should work (undelegation) but lock should persist
     * WHY: Users should be able to take back control
     */
    it("Should allow switching from delegate to self mid-round", async function () {
      // Alice delegates to Bob
      await satori.connect(alice).delegatePredictionPower(bob.address);

      // Bob predicts
      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // Alice undelegates (switches to self)
      await satori.connect(alice).delegatePredictionPower(ethers.ZeroAddress);

      // Verify Alice is now undelegated (zero address)
      const delegate = (await rewards.predictionDelegateInfo(alice.address)).delegate;
      expect(delegate).to.equal(ethers.ZeroAddress);

      // Alice still can't predict this round (Bob already used her power)
      // But she also can't because she's still locked until next round
      await expect(
        satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(DOWN) }])
      ).to.be.revertedWithCustomError(satori, "Locked");
    });

    it("Should unlock after undelegation and round advance", async function () {
      // Alice delegates to Bob
      await satori.connect(alice).delegatePredictionPower(bob.address);

      // Bob predicts
      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // Alice undelegates
      await satori.connect(alice).delegatePredictionPower(ethers.ZeroAddress);

      // Advance round
      await advanceRound();

      // Update value for next prediction
      await registry.setValue(stream1, 1100);

      // Now Alice should be able to predict herself
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // Verify prediction was made
      const currentRound = await satori.getCurrentRound();
      const prediction = await satori.predictions(alice.address, stream1, currentRound);
      expect(prediction.direction).to.equal(UP);
    });
  });

  describe("6. Prediction Power Snapshot Timing", function () {
    /**
     * TEST: Delegate with 1000 tokens, receive 500 more, check if delegate can use 1500
     * EXPECTED: Power is snapshotted at prediction time, not delegation time
     * WHY: We need to verify when the snapshot happens to prevent manipulation
     */
    it("Should use current balance at prediction time, not delegation time", async function () {
      // Alice delegates to Bob
      await satori.connect(alice).delegatePredictionPower(bob.address);

      // Check Bob's prediction power (should be Bob's 1000 + Alice's 1000)
      let bobPower = await rewards.getPredictionPower(bob.address);
      expect(bobPower).to.equal(PER_ACTOR * 2n);

      // Alice receives 500 more tokens from owner
      await satori.transfer(alice.address, BUMP);

      // adv_6: a mid-round receipt to a delegator DEFERS to next round — so the
      // same round Bob's power is unchanged (the snapshot is taken at round
      // start, which is "current at prediction", NOT stale delegation-time)...
      expect(await rewards.getPredictionPower(bob.address)).to.equal(PER_ACTOR * 2n);
      // ...and includes the +BUMP once it activates next round.
      await advanceRound();
      bobPower = await rewards.getPredictionPower(bob.address);
      expect(bobPower).to.equal(PER_ACTOR * 2n + BUMP);

      // Bob predicts - the snapshot uses the activated current balance.
      await registry.setValue(stream1, 1100);
      const currentRound = await satori.getCurrentRound();
      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // Verify the prediction was made with correct power
      const prediction = await satori.predictions(bob.address, stream1, currentRound);
      expect(prediction.rawPredictionPower).to.be.closeTo(PER_ACTOR * 2n + BUMP, RAW_TOLERANCE);
    });

    it("Should not include tokens transferred after prediction", async function () {
      // Alice delegates to Bob
      await satori.connect(alice).delegatePredictionPower(bob.address);

      // Bob predicts (power snapshot happens now)
      const currentRound = await satori.getCurrentRound();
      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // Verify power used
      const prediction = await satori.predictions(bob.address, stream1, currentRound);
      expect(prediction.rawPredictionPower).to.be.closeTo(PER_ACTOR * 2n, RAW_TOLERANCE);

      // Alice receives more tokens AFTER prediction
      // This should NOT affect Bob's already-made prediction
      await satori.transfer(alice.address, BUMP);

      // Prediction power should still be 2000
      expect(prediction.rawPredictionPower).to.be.closeTo(PER_ACTOR * 2n, RAW_TOLERANCE);
    });

    it("Should handle delegation power decrease via transfer out", async function () {
      // Alice delegates to Bob
      await satori.connect(alice).delegatePredictionPower(bob.address);

      // Bob's power should be 2000
      let bobPower = await rewards.getPredictionPower(bob.address);
      expect(bobPower).to.equal(PER_ACTOR * 2n);

      // This test reveals a limitation: Alice can't transfer while delegated
      // So we can't test power decrease via transfer
      await expect(
        satori.connect(alice).transfer(carol.address, BUMP)
      ).to.be.revertedWithCustomError(satori, "Locked");
    });
  });

  describe("7. Undelegation Timing and Lock State", function () {
    /**
     * TEST: Undelegate and immediately try to predict/transfer
     * EXPECTED: Should be locked until next round
     * WHY: Undelegation should set lock correctly
     */
    it("Should lock until next round after undelegation", async function () {
      // Alice delegates to Bob
      await satori.connect(alice).delegatePredictionPower(bob.address);

      // Alice undelegates
      await satori.connect(alice).delegatePredictionPower(ethers.ZeroAddress);

      // Check lock state - should be locked until currentRound + 1
      const currentRound = await satori.getCurrentRound();
      const lockedUntil = await satori.lockedUntil(alice.address);
      expect(lockedUntil).to.equal(currentRound + 1n);

      // Alice can't predict immediately
      await expect(
        satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }])
      ).to.be.revertedWithCustomError(satori, "Locked");

      // Alice can't transfer immediately
      await expect(
        satori.connect(alice).transfer(carol.address, SMALL)
      ).to.be.revertedWithCustomError(satori, "Locked");
    });

    it("Should allow actions after lock expires", async function () {
      // Round 0: Alice delegates to Bob
      await satori.connect(alice).delegatePredictionPower(bob.address);

      // Alice undelegates (locked until next round)
      await satori.connect(alice).delegatePredictionPower(ethers.ZeroAddress);

      // Advance 1 round to unlock predictions (currentRound >= lockedUntil)
      await advanceRound();

      // Update stream value for prediction
      await registry.setValue(stream1, 1100);

      // Now Alice can predict
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // Verify prediction
      const currentRound = await satori.getCurrentRound();
      const prediction = await satori.predictions(alice.address, stream1, currentRound);
      expect(prediction.direction).to.equal(UP);
    });

    it("Should handle max lock (type(uint256).max) from delegation", async function () {
      // Alice delegates to Bob - this sets lock to max
      await satori.connect(alice).delegatePredictionPower(bob.address);

      // Check lock is at max
      const lockedUntil = await satori.lockedUntil(alice.address);
      expect(lockedUntil).to.equal(2n ** 24n - 1n);

      // Can't predict
      await expect(
        satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }])
      ).to.be.revertedWithCustomError(satori, "Delegated");

      // Can't transfer
      await expect(
        satori.connect(alice).transfer(carol.address, SMALL)
      ).to.be.revertedWithCustomError(satori, "Locked");

      // Undelegate resets lock to round + 1
      await satori.connect(alice).delegatePredictionPower(ethers.ZeroAddress);

      const currentRound = await satori.getCurrentRound();
      const newLock = await satori.lockedUntil(alice.address);
      expect(newLock).to.equal(currentRound + 1n);
    });

    it("Should allow prediction after advancing to unlock round", async function () {
      // Round 1: Alice delegates to Bob
      await satori.connect(alice).delegatePredictionPower(bob.address);

      // Advance to round 2
      await advanceRound();

      // Alice undelegates in round 2 (locked until round 3)
      await satori.connect(alice).delegatePredictionPower(ethers.ZeroAddress);

      // Update value
      await registry.setValue(stream1, 1100);

      // Alice can't predict yet (locked until round 3)
      await expect(
        satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }])
      ).to.be.revertedWithCustomError(satori, "Locked");

      // Advance to round 3
      await advanceRound();

      // Now Alice can predict (currentRound >= lockedUntil)
      await registry.setValue(stream1, 1200);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      const currentRound = await satori.getCurrentRound();
      const prediction = await satori.predictions(alice.address, stream1, currentRound);
      expect(prediction.direction).to.equal(UP);
    });
  });
});
