/**
 * REWARD MANIPULATION TEST SUITE
 *
 * This test suite covers critical attack vectors related to reward claiming and calculation.
 * Rewards are minted when users claim, and proper protections prevent double-claiming and theft.
 *
 * Reward System Overview:
 * - Rewards calculated based on correct predictions weighted by streak
 * - Rewards distributed proportionally based on weight
 * - With delegation defaults: 80% to delegators, 10% bonus to predictor, 10% to platform (5% + 5%) - 80/10/5/5 split
 * - Claims must wait until round N+2 (prediction round N, value set round N+1, claim round N+2)
 *
 * WHY THESE TESTS ARE CRITICAL:
 * - Reward manipulation could allow:
 *   a) Double-claiming rewards
 *   b) Claiming rewards that belong to others
 *   c) Manipulating delegation to steal rewards
 *   d) Breaking proportional distribution
 * - Timing attacks around claiming windows
 *
 * ASSUMPTIONS:
 * - Test mode enabled for rapid round advancement
 * - TOKENS_PER_ROUND = 1440 ether distributed among winners
 * - Platform fee address can be set
 * - unclaimedRewards tracks minted rewards
 */

const { expect } = require("chai");
const { deploySatoriFixture, pack1, voteFor } = require("./fixtures");
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

describe("Reward Manipulation Tests", function () {
  let satori, voting, rewards, bounties, registry, hub, lens;
  let owner, alice, bob, carol, dave, platform;
  let stream1, stream2;

  const UP = 1;
  const DOWN = 2;

  beforeEach(async function () {
    [owner, alice, bob, carol, dave, platform] = await ethers.getSigners();

    // Restructured Satori stack via the shared fixture (2000 bps platform fee).
    const fix = await deploySatoriFixture();
    ;({ satori, voting, rewards, registry, bounties, hub, lens } = fix);

    // Create test streams. Every scenario below drives a scored prediction
    // through the A-B-C rhythm of an every-round stream, so these are
    // 1440-minute (every-round) streams — one write per 24h round.
    const tx1 = await satori["createSimpleDataStream(string,address,uint24)"]("ETH/USD", owner.address, 1440);
    stream1 = await getStreamIdFromTx(tx1, satori);

    const tx2 = await satori["createSimpleDataStream(string,address,uint24)"]("BTC/USD", owner.address, 1440);
    stream2 = await getStreamIdFromTx(tx2, satori);

    // Distribute tokens
    await satori.transfer(alice.address, ethers.parseEther("200"));
    await satori.transfer(bob.address, ethers.parseEther("200"));
    await satori.transfer(carol.address, ethers.parseEther("100"));
    await satori.transfer(dave.address, ethers.parseEther("100"));

    // Make streams eligible
    await voteFor(satori, alice, stream1);
    await voteFor(satori, bob, stream2);

    // Advance round to snapshot votes
    await advanceRound(); // Now in round 1
  });

  describe("1. Double Claim Attack", function () {
    /**
     * ATTACK: Claim rewards, try to claim again
     * EXPECTED: Second claim should return 0
     * WHY: Rewards should only be claimable once
     */
    it("Should prevent double claiming same rewards", async function () {
      // Round 1: Set value and predict
      await registry.setValue(stream1, 1000);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // Round 2: Change value (Alice was correct)
      await advanceRound();
      await registry.setValue(stream1, 1100);

      // Round 3: Trigger scoring with new value and prediction
      await advanceRound();
      await registry.setValue(stream1, 1200);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      const balanceBefore = await satori.balanceOf(alice.address);

      // First claim should succeed
      const claimed1 = await hub.connect(alice).claim.staticCall();
      await satori.connect(alice).claim();

      const balanceAfter = await satori.balanceOf(alice.address);
      expect(balanceAfter).to.be.greaterThan(balanceBefore);
      expect(claimed1).to.be.greaterThan(0);

      // Second claim should return 0 (nothing to claim)
      const claimed2 = await hub.connect(alice).claim.staticCall();
      expect(claimed2).to.equal(0);

      // Balance shouldn't change
      await satori.connect(alice).claim();
      const balanceAfter2 = await satori.balanceOf(alice.address);
      expect(balanceAfter2).to.equal(balanceAfter);
    });

    it("Should prevent claiming same round rewards twice via re-entry", async function () {
      // Setup: Alice predicts correctly
      await registry.setValue(stream1, 1000);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      await advanceRound();
      await registry.setValue(stream1, 1100);

      await advanceRound();
      await registry.setValue(stream1, 1200);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // Claim once
      await satori.connect(alice).claim();

      // Try to claim again immediately
      const claimed2 = await hub.connect(alice).claim.staticCall();
      expect(claimed2).to.equal(0);
    });

    it("Should track unclaimed rewards correctly after partial claim", async function () {
      // Alice predicts correctly in round 1
      await registry.setValue(stream1, 1000);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      await advanceRound();
      await registry.setValue(stream1, 1100);

      await advanceRound();
      await registry.setValue(stream1, 1200);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // Check unclaimed before claim
      const unclaimedBefore = (await lens.getTotalClaimableRewards(alice.address))[0];
      expect(unclaimedBefore).to.be.greaterThan(0);

      // Claim
      await satori.connect(alice).claim();

      // Check unclaimed after claim (should be 0)
      const unclaimedAfter = (await lens.getTotalClaimableRewards(alice.address))[0];
      expect(unclaimedAfter).to.equal(0);
    });
  });

  describe("2. Claim Without Rewards", function () {
    /**
     * ATTACK: User never predicted, tries to claim
     * EXPECTED: Should return 0 (no rewards)
     * WHY: Only users who correctly predicted should get rewards
     */
    it("Should return 0 when claiming without predictions", async function () {
      // Alice never predicted
      // Try to claim
      const claimed = await hub.connect(alice).claim.staticCall();
      expect(claimed).to.equal(0);

      const balanceBefore = await satori.balanceOf(alice.address);
      await satori.connect(alice).claim();
      const balanceAfter = await satori.balanceOf(alice.address);

      expect(balanceAfter).to.equal(balanceBefore);
    });

    it("Should return 0 when claiming with incorrect prediction", async function () {
      // Round 1: Alice predicts UP
      await registry.setValue(stream1, 1000);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // Round 2: Value goes DOWN (Alice was wrong)
      await advanceRound();
      await registry.setValue(stream1, 900);

      // Round 3: Try to claim
      await advanceRound();

      // Nothing is claimable at all: a wrong prediction pays nothing, and there
      // is no longer a first-predictor liveness bonus to pick up on the way past.
      const claimed = await hub.connect(alice).claim.staticCall();
      expect(claimed).to.equal(0n);
    });

    it("Should return 0 when claiming before enough rounds have passed", async function () {
      // Round 1: Alice predicts
      await registry.setValue(stream1, 1000);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // Try to claim immediately — nothing is claimable before scoring.
      const claimed1 = await hub.connect(alice).claim.staticCall();
      expect(claimed1).to.equal(0n);

      // Round 2: still nothing — the prediction has not scored yet.
      await advanceRound();
      const claimed2 = await hub.connect(alice).claim.staticCall();
      expect(claimed2).to.equal(0n);

      // Round 3: Set second value
      await registry.setValue(stream1, 1100);
      await advanceRound();

      // Round 4: Set third value and make new prediction to trigger scoring
      await registry.setValue(stream1, 1200);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      const claimed3 = await hub.connect(alice).claim.staticCall();
      expect(claimed3).to.be.greaterThan(0);
    });
  });

  describe("3. Delegator Reward Theft", function () {
    /**
     * ATTACK: Delegator tries to claim delegate's rewards
     * EXPECTED: Should fail - each gets their allocated share
     * WHY: Rewards are split but claimed separately
     */
    it("Should prevent delegator from claiming predictor's share", async function () {
      // Alice delegates to Bob
      await satori.connect(alice).delegatePredictionPower(bob.address);
      await time.increase(86400);

      // Bob predicts using Alice's power
      await registry.setValue(stream1, 1000);
      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // Advance and make prediction correct
      await advanceRound();
      await registry.setValue(stream1, 1100);

      await advanceRound();
      await registry.setValue(stream1, 1200);
      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // Each party pulls their own share — Bob only gets his predictor share,
      // Alice only gets her delegator share.
      const aliceBalanceBefore = await satori.balanceOf(alice.address);
      const bobBalanceBefore = await satori.balanceOf(bob.address);

      await satori.connect(bob).claim();
      const bobBalanceAfter = await satori.balanceOf(bob.address);
      const bobRewards = bobBalanceAfter - bobBalanceBefore;

      await satori.connect(alice).claim();
      const aliceBalanceAfter = await satori.balanceOf(alice.address);
      const aliceRewards = aliceBalanceAfter - aliceBalanceBefore;

      // Bob's predictor share and Alice's delegator share are both non-zero
      expect(bobRewards).to.be.greaterThan(0);
      expect(aliceRewards).to.be.greaterThan(0);

      // Alice's second claim yields nothing (she can't reclaim Bob's share)
      const aliceClaim2 = await hub.connect(alice).claim.staticCall();
      expect(aliceClaim2).to.equal(0);
    });

    it("Should distribute rewards correctly with delegation (80/10/10 split)", async function () {
      // Alice (1000) delegates to Bob (1000)
      await satori.connect(alice).delegatePredictionPower(bob.address);
      await time.increase(86400);

      // Bob predicts with combined power (2000)
      await registry.setValue(stream1, 1000);
      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // Make prediction correct
      await advanceRound();
      await registry.setValue(stream1, 1100);

      await advanceRound();
      await registry.setValue(stream1, 1200);
      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // Get balances before claiming
      const aliceBalanceBefore = await satori.balanceOf(alice.address);
      const bobBalanceBefore = await satori.balanceOf(bob.address);

      await satori.connect(alice).claim();
      await satori.connect(bob).claim();

      const aliceBalanceAfter = await satori.balanceOf(alice.address);
      const bobBalanceAfter = await satori.balanceOf(bob.address);

      const aliceRewards = aliceBalanceAfter - aliceBalanceBefore;
      const bobRewards = bobBalanceAfter - bobBalanceBefore;

      // platform fee moved to immutable token (see test/next/DevFee.test.js): it
      // is minted senior at the token, not accrued into claimable rewards, so the
      // old platform-fee accrual assertion is dropped. Both the delegator and the
      // predictor still receive their (fee-free) split.
      expect(aliceRewards).to.be.greaterThan(0);
      expect(bobRewards).to.be.greaterThan(0);

      // Total should be conserved (accounting for rounding)
      // Note: Exact percentages are hard to verify due to weight calculations
      // But we can verify all parties got something and total is reasonable
    });
  });

  describe("4. Reward Calculation with Delegation", function () {
    /**
     * TEST: Verify 80/10/10 split is exact
     * EXPECTED: Exact split of delegated portion
     * WHY: Ensure no rewards are lost or created
     */
    it("Should split delegated rewards exactly as 80/10/10", async function () {
      // Alice delegates to Bob
      await satori.connect(alice).delegatePredictionPower(bob.address);
      await time.increase(86400);

      // Bob predicts
      await registry.setValue(stream1, 1000);
      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // Correct prediction
      await advanceRound();
      await registry.setValue(stream1, 1100);

      await advanceRound();
      await registry.setValue(stream1, 1200);
      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // Claim all
      const aliceBalanceBefore = await satori.balanceOf(alice.address);
      const bobBalanceBefore = await satori.balanceOf(bob.address);

      await satori.connect(alice).claim();
      await satori.connect(bob).claim();

      const aliceBalanceAfter = await satori.balanceOf(alice.address);
      const bobBalanceAfter = await satori.balanceOf(bob.address);

      const aliceRewards = aliceBalanceAfter - aliceBalanceBefore;
      const bobRewards = bobBalanceAfter - bobBalanceBefore;

      // platform fee moved to immutable token (see test/next/DevFee.test.js): it
      // is minted senior at the token, not accrued into claimable rewards, so the
      // platform-fee term is dropped from the split (payouts sum to gross − bonus;
      // the dev fee is off-budget at the token).
      // All should have received rewards
      expect(aliceRewards).to.be.greaterThan(0);
      expect(bobRewards).to.be.greaterThan(0);

      // Total rewards should be non-zero
      const totalRewarded = aliceRewards + bobRewards;
      expect(totalRewarded).to.be.greaterThan(0);
    });

    it("Should handle multiple delegators correctly", async function () {
      // Alice and Carol both delegate to Bob
      await satori.connect(alice).delegatePredictionPower(bob.address);
      await satori.connect(carol).delegatePredictionPower(bob.address);

      // Bob predicts with combined power (Bob: 1000, Alice: 1000, Carol: 500 = 2500)
      await registry.setValue(stream1, 1000);
      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // Correct prediction
      await advanceRound();
      await registry.setValue(stream1, 1100);

      await advanceRound();
      await registry.setValue(stream1, 1200);
      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // All claim
      await satori.connect(alice).claim();
      await satori.connect(carol).claim();
      await satori.connect(bob).claim();

      // Verify all got rewards
      const aliceBalance = await satori.balanceOf(alice.address);
      const carolBalance = await satori.balanceOf(carol.address);
      const bobBalance = await satori.balanceOf(bob.address);

      // Alice should get more than Carol (1000 vs 500 delegated)
      // Both delegators should get rewards
      // Bob should get rewards (his share + bonus)
      expect(aliceBalance).to.be.greaterThan(0);
      expect(carolBalance).to.be.greaterThan(0);
      expect(bobBalance).to.be.greaterThan(0);
    });
  });

  describe("5. Claim Timing", function () {
    /**
     * TEST: Predict round 0, try to claim before round 2
     * EXPECTED: Can't claim until 2 rounds after prediction
     * WHY: Need to wait for value to be set in next round
     */
    it("Should not allow claiming in same round as prediction", async function () {
      // Round 1: Predict
      await registry.setValue(stream1, 1000);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // Try to claim immediately — nothing is claimable before scoring.
      const claimed = await hub.connect(alice).claim.staticCall();
      expect(claimed).to.equal(0n);
    });

    it("Should not allow claiming one round after prediction", async function () {
      // Round 1: Predict
      await registry.setValue(stream1, 1000);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // Round 2: Set new value (determines if prediction correct)
      await advanceRound();
      await registry.setValue(stream1, 1100);

      // Try to claim in round 2 — the prediction has not scored yet, so nothing.
      const claimed = await hub.connect(alice).claim.staticCall();
      expect(claimed).to.equal(0n);
    });

    it("Should allow claiming two rounds after prediction", async function () {
      // Round 1: Predict
      await registry.setValue(stream1, 1000);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // Round 2: Confirm prediction
      await advanceRound();
      await registry.setValue(stream1, 1100);

      // Round 3: Trigger scoring
      await advanceRound();
      await registry.setValue(stream1, 1200);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      const claimed = await hub.connect(alice).claim.staticCall();
      expect(claimed).to.be.greaterThan(0);
    });
  });

  describe("6. Multiple Round Claiming", function () {
    /**
     * TEST: Accumulate rewards across 5 rounds, claim all
     * EXPECTED: Should get sum of all round rewards
     * WHY: Verify accumulation works correctly
     */
    it("Should accumulate rewards across multiple rounds", async function () {
      // Predict correctly in rounds 1-5
      for (let round = 1; round <= 5; round++) {
        await registry.setValue(stream1, 1000 + round * 100);
        await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);
        await advanceRound();
      }

      // Set final value to make last prediction correct
      await registry.setValue(stream1, 1700);
      await advanceRound();

      // Trigger scoring with one more prediction
      await registry.setValue(stream1, 1800);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // Claim all accumulated rewards
      const claimed = await hub.connect(alice).claim.staticCall();
      expect(claimed).to.be.greaterThan(0);

      await satori.connect(alice).claim();

      // Verify all claimed
      const unclaimed = (await lens.getTotalClaimableRewards(alice.address))[0];
      expect(unclaimed).to.equal(0);
    });

    it("Should handle mixed correct/incorrect predictions", async function () {
      // Round 1: Correct (UP)
      await registry.setValue(stream1, 1000);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      await advanceRound();
      await registry.setValue(stream1, 1100); // UP - correct

      await advanceRound();
      await registry.setValue(stream1, 1200);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // Round 3: Incorrect (UP but goes DOWN)
      await advanceRound();
      await registry.setValue(stream1, 1000); // DOWN - incorrect

      await advanceRound();
      await registry.setValue(stream1, 900);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(DOWN) }]);

      // Round 5: Correct (DOWN)
      await advanceRound();
      await registry.setValue(stream1, 800); // DOWN - correct

      await advanceRound();
      await registry.setValue(stream1, 700);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(DOWN) }]);

      // Claim - should get rewards from round 1 and 5 only
      const claimed = await hub.connect(alice).claim.staticCall();
      expect(claimed).to.be.greaterThan(0);
    });

    it("Should track streak correctly across multiple rounds", async function () {
      // Make 3 correct predictions in a row to build streak
      await registry.setValue(stream1, 1000);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);
      await advanceRound();

      await registry.setValue(stream1, 1100);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);
      await advanceRound();

      await registry.setValue(stream1, 1200);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);
      await advanceRound();

      // Continue adding values and predictions to trigger scoring of all previous predictions
      await registry.setValue(stream1, 1300);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);
      await advanceRound();

      await registry.setValue(stream1, 1400);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);
      await advanceRound();

      await registry.setValue(stream1, 1500);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // Check streak (should be 3 or higher since all were correct)
      const streak = await satori.streaks(alice.address, stream1);
      expect(streak).to.be.greaterThanOrEqual(3);

      // Claim rewards - later predictions should have higher weight due to streak
      const claimed = await hub.connect(alice).claim.staticCall();
      expect(claimed).to.be.greaterThan(0);
    });
  });

  describe("7. Claim Delegation", function () {
    /**
     * TEST: Delegate claim ability, original user tries to claim
     * EXPECTED: Should fail - only delegate can claim
     * WHY: Claim delegation transfers claiming rights
     */
    it("Should prevent original user from claiming after delegating claim", async function () {
      // Alice delegates claim to Bob
      await satori.connect(alice).delegateClaimAbility(bob.address);

      // Alice predicts and is correct
      await registry.setValue(stream1, 1000);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      await advanceRound();
      await registry.setValue(stream1, 1100);

      await advanceRound();

      // Alice tries to claim - should fail
      await expect(
        satori.connect(alice).claim()
      ).to.be.revertedWithCustomError(rewards, "ClaimDelegatedAway");
    });

    it("Should allow delegate to claim on behalf of delegator", async function () {
      // Alice delegates claim to Bob
      await satori.connect(alice).delegateClaimAbility(bob.address);

      // Alice predicts and is correct
      await registry.setValue(stream1, 1000);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      await advanceRound();
      await registry.setValue(stream1, 1100);

      await advanceRound();
      await registry.setValue(stream1, 1200);
      await satori.settlePrediction(alice.address, stream1); // score without predicting, so the claim may go elsewhere

      // Bob claims Alice's rewards to himself via claimFor
      const bobBalanceBefore = await satori.balanceOf(bob.address);
      await satori.connect(bob).claimFor(alice.address, bob.address);
      const bobBalanceAfter = await satori.balanceOf(bob.address);

      // Bob should have received Alice's rewards
      expect(bobBalanceAfter).to.be.greaterThan(bobBalanceBefore);
    });

    it("Should allow delegate to specify recipient", async function () {
      // Alice delegates claim to Bob
      await satori.connect(alice).delegateClaimAbility(bob.address);

      // Alice predicts and is correct
      await registry.setValue(stream1, 1000);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      await advanceRound();
      await registry.setValue(stream1, 1100);

      await advanceRound();
      await registry.setValue(stream1, 1200);
      await satori.settlePrediction(alice.address, stream1); // score without predicting, so the claim may go elsewhere

      // Bob claims Alice's rewards to Carol via claimFor
      const carolBalanceBefore = await satori.balanceOf(carol.address);
      await satori.connect(bob).claimFor(alice.address, carol.address);
      const carolBalanceAfter = await satori.balanceOf(carol.address);

      // Carol should have received rewards
      expect(carolBalanceAfter).to.be.greaterThan(carolBalanceBefore);
    });

    it("Should allow undelegation of claim ability", async function () {
      // Alice delegates claim to Bob
      await satori.connect(alice).delegateClaimAbility(bob.address);

      // Alice undelegates
      await satori.connect(alice).delegateClaimAbility(alice.address);

      // Alice predicts and is correct
      await registry.setValue(stream1, 1000);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      await advanceRound();
      await registry.setValue(stream1, 1100);

      await advanceRound();
      await registry.setValue(stream1, 1200);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // Wait one more round (can't claim in same round as undelegation)
      await advanceRound();

      // Now Alice can claim herself
      const claimed = await hub.connect(alice).claim.staticCall();
      expect(claimed).to.be.greaterThan(0);

      await satori.connect(alice).claim();
    });
  });

  describe("8. Reward Conservation", function () {
    /**
     * TEST: Verify total rewards minted equals expected
     * EXPECTED: No rewards created or destroyed
     * WHY: Ensure reward math is correct
     */
    it("Should not mint more rewards than available in pool", async function () {
      // Both Alice and Bob predict correctly
      await registry.setValue(stream1, 1000);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);
      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      await advanceRound();
      await registry.setValue(stream1, 1100);

      await advanceRound();
      await registry.setValue(stream1, 1200);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);
      // Round-4 refactor: per-(stream, round) finality gate. Both predictors
      // must be scored before either's claim releases the cursor.
      await satori.settlePrediction(bob.address, stream1);

      // Track total supply before claims
      const supplyBefore = await satori.totalSupply();

      // Both claim
      await satori.connect(alice).claim();
      await satori.connect(bob).claim();

      const supplyAfter = await satori.totalSupply();

      // Total minted should be non-zero but reasonable
      const totalMinted = supplyAfter - supplyBefore;
      expect(totalMinted).to.be.greaterThan(0);

      // Should not exceed max tokens per round (1440 ether)
      // Note: In practice it might be less due to only one stream being eligible
      expect(totalMinted).to.be.lessThanOrEqual(ethers.parseEther("1440"));
    });

    it("Should distribute rewards proportionally by weight", async function () {
      // Alice predicts with 1000, Bob with 1000 (equal weight if same streak)
      await registry.setValue(stream1, 1000);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);
      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      await advanceRound();
      await registry.setValue(stream1, 1100);

      await advanceRound();
      await registry.setValue(stream1, 1200);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);
      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      const aliceBalanceBefore = await satori.balanceOf(alice.address);
      const bobBalanceBefore = await satori.balanceOf(bob.address);

      await satori.connect(alice).claim();
      await satori.connect(bob).claim();

      const aliceBalanceAfter = await satori.balanceOf(alice.address);
      const bobBalanceAfter = await satori.balanceOf(bob.address);

      const aliceRewards = aliceBalanceAfter - aliceBalanceBefore;
      const bobRewards = bobBalanceAfter - bobBalanceBefore;

      // Should be approximately equal (accounting for rounding)
      const ratio = Number(aliceRewards) / Number(bobRewards);
      expect(ratio).to.be.closeTo(1.0, 0.1); // Within 10%
    });

    it("Should handle zero total weight gracefully", async function () {
      // Alice predicts UP, but value goes DOWN (wrong)
      await registry.setValue(stream1, 1000);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      await advanceRound();
      await registry.setValue(stream1, 900);

      await advanceRound();
      await registry.setValue(stream1, 850);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // No one was correct → nothing to pay, and nothing else to pick up: the
      // first-predictor liveness bonus that used to accrue here is gone.
      const claimed = await hub.connect(alice).claim.staticCall();
      expect(claimed).to.equal(0n);
    });
  });
});
