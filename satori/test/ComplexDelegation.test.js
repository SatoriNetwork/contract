/**
 * COMPLEX DELEGATION INTERACTIONS TEST SUITE
 *
 * This test suite covers advanced delegation scenarios involving
 * multiple types of delegation (prediction, claim) and their interactions.
 *
 * Delegation Types:
 * 1. Prediction Delegation: Let someone else predict with your tokens
 * 2. Claim Delegation: Let someone else claim your rewards
 *
 * VOTE delegation no longer exists: voting BURNS the voter's own SATORI to buy
 * a game permanent weight, so there is no transferable "voting power" left to
 * delegate. The blocks that covered it have been dropped; everything they were
 * guarding against (interference between the surviving delegation types) is
 * still covered below.
 *
 * WHY THESE TESTS ARE CRITICAL:
 * - Users can delegate prediction and claim independently
 * - These delegations must not interfere with each other, nor with voting
 * - Circular / chained prediction delegation must be handled gracefully
 * - Mass delegation accounting must be correct
 * - Zero-balance and token-receipt edge cases must work
 */

const { expect } = require("chai");
const { deploySatoriFixture, RAW_TOLERANCE, pack1, VOTE, voteFor, warmUpLoyalty } = require("./fixtures");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

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

async function advanceRound() {
  await time.increase(86400);
}

describe("Complex Delegation Interactions", function () {
  let satori, voting, rewards, bounties, registry, lens;
  let owner, alice, bob, carol, dave, eve;
  let stream1, stream2;
  // UNIT = INITIAL_MINT / 8. alice/bob/carol = 2×UNIT, dave/eve = 1×UNIT.
  // Sum = 8×UNIT = INITIAL_MINT (preserves original 2:2:2:1:1 ratio).
  let UNIT;

  const UP = 1;
  const DOWN = 2;

  beforeEach(async function () {
    [owner, alice, bob, carol, dave, eve] = await ethers.getSigners();

    const fix = await deploySatoriFixture();
    ;({ satori, voting, rewards, registry, bounties, lens, owner } = fix);



    // Every-round (1440-minute) streams. The subject here is delegation
    // accounting, not the stream's rhythm, so the every-round write cadence
    // the rest of this file assumes is kept deliberately.
    const tx1 = await satori.connect(owner)["createSimpleDataStream(string,address,uint24)"]("ETH/USD", owner.address, 1440);
    stream1 = await getStreamIdFromTx(tx1, satori);
    const tx2 = await satori.connect(owner)["createSimpleDataStream(string,address,uint24)"]("BTC/USD", owner.address, 1440);
    stream2 = await getStreamIdFromTx(tx2, satori);

    const INITIAL_MINT = await satori.INITIAL_MINT();
    // Distribute 8U to actors; owner keeps the remainder for stream-creation
    // fees and other in-test transfers (UNIT = INITIAL_MINT/9 → 8U = ~8/9 of
    // bootstrap; preserves the 2:2:2:1:1 ratio across actors).
    UNIT = INITIAL_MINT / 9n;
    await satori.transfer(alice.address, UNIT * 2n);
    await satori.transfer(bob.address, UNIT * 2n);
    await satori.transfer(carol.address, UNIT * 2n);
    await satori.transfer(dave.address, UNIT);
    await satori.transfer(eve.address, UNIT);

    // Buy both games their eligibility weight from the OWNER's stack, so the
    // actors keep their exact 2U/1U balances (burning spends, and prediction
    // power is balance-derived, so an actor's own burn would skew every
    // delegated-power figure below).
    await voteFor(satori, owner, stream1);
    await voteFor(satori, owner, stream2);
    await advanceRound();
  });

  describe("1. Independent Delegation (prediction + claim) alongside voting", function () {
    it("Should allow prediction to A and claim to C - both work independently, and voting is nobody's to delegate", async function () {
      // Alice delegates prediction to Bob and claim to Dave. There is no third
      // delegation any more: vote weight is BOUGHT WITH A BURN, so it belongs to
      // the game, not to a delegable balance.
      await satori.connect(alice).delegatePredictionPower(bob.address);
      // Delegator weight is capital x loyalty and a fresh delegation starts at
      // L = 0, so any share measured below reads zero without a warm-up. The
      // helper drains predictor and delegators to `owner`, so prediction power
      // and delegated capital are exactly as the delegations left them.
      await warmUpLoyalty(satori, registry, null, bob, [alice], owner, stream1);
      await satori.connect(alice).delegateClaimAbility(dave.address);

      // Verify delegations
      expect((await rewards.predictionDelegateInfo(alice.address)).delegate).to.equal(bob.address);
      expect(await rewards.claimDelegateInfo(alice.address)).to.equal(dave.address);

      // Bob should have prediction power from Alice
      const bobPredPower = await rewards.getPredictionPower(bob.address);
      expect(bobPredPower).to.equal(UNIT * 4n); // Bob 2U + Alice 2U

      // Carol backs stream2 with her OWN burn — Alice's delegations neither add
      // to it nor stop it.
      const stream2WeightBefore = await voting.weightOf(stream2);
      await voteFor(satori, carol, stream2);
      expect(await voting.weightOf(stream2)).to.equal(stream2WeightBefore + VOTE);

      // Both delegates can perform their delegated functions
      await registry.setValue(stream1, 1000);

      // Bob predicts using Alice's power in round 2
      const predictionRound = await satori.getCurrentRound();
      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // Dave will be able to claim Alice's rewards later
      await advanceRound(); // Now round 3
      await registry.setValue(stream1, 1100); // Value went up - Bob was correct

      await advanceRound(); // Now round 4
      await registry.setValue(stream1, 1200);

      // Trigger scoring by having Bob predict again (lazy evaluation)
      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // Advance more rounds to accumulate rewards
      await advanceRound();
      await advanceRound();
      await advanceRound();

      // Verify that all three delegations worked:

      // 1. Bob predicted using Alice's delegated prediction power
      const pred = await satori.predictions(bob.address, stream1, predictionRound);
      expect(pred.direction).to.equal(UP);
      expect(pred.scored).to.be.true;

      // 2. Weight was recorded for Bob's prediction
      const weight = await lens.userWeightByDirection(bob.address, stream1, predictionRound, UP);
      expect(weight).to.be.gt(0);

      // 3. Dave can claim ON BEHALF OF ALICE (claim delegation).
      //
      // OLD (P9): `await expect(satori.connect(dave).claim()).to.not.be.reverted`.
      // `claim()` is the SELF-claim entry point — SatoriHub.claim() forwards
      // msg.sender as the OWNER (rewards.claim(msg.sender, msg.sender) ->
      // _claimFor(dave, dave, dave)), so Dave was reading his OWN bucket and
      // Alice's address never entered the call. `_claimFor` short-circuits the
      // mint on a zero bucket and never reverts, so that expectation passed with
      // a delta of 0 — and passed identically for a stranger signer, and with
      // `delegateClaimAbility` never called at all. It would have stayed green if
      // claim delegation were a complete no-op.
      //
      // The delegated path is `claimFor(owner, recipient)`, authorized by
      // `claimDelegateInfo[owner] == msg.sender` (SatoriRewards._checkClaimAuth,
      // A_claim_delegation.md). Assert BOTH halves of the guarantee: only Dave
      // may drain Alice's bucket, and doing so actually moves SATORI.

      // Negative: a non-delegate cannot claim for Alice.
      await expect(satori.connect(eve).claimFor(alice.address, eve.address))
        .to.be.revertedWithCustomError(rewards, "Unauthorized");
      // Negative: while delegated away, Alice cannot self-claim.
      await expect(satori.connect(alice).claim())
        .to.be.revertedWithCustomError(rewards, "ClaimDelegatedAway");

      // Positive: Dave drains Alice's bucket to himself — a real balance delta,
      // not "did not revert".
      const daveBefore = await satori.balanceOf(dave.address);
      const aliceBefore = await satori.balanceOf(alice.address);
      await expect(satori.connect(dave).claimFor(alice.address, dave.address))
        .to.emit(rewards, "RewardsClaimed");
      const daveDelta = (await satori.balanceOf(dave.address)) - daveBefore;
      expect(daveDelta, "the delegate must actually receive Alice's rewards").to.be.gt(0n);
      // The rewards are ALICE's (she delegated her prediction power to Bob and
      // earned the delegator slice of his win) — Alice's own balance is untouched
      // because the delegate chose himself as recipient.
      expect(await satori.balanceOf(alice.address)).to.equal(aliceBefore);
      expect(await rewards.unclaimedRewards(alice.address)).to.equal(0n);
    });
  });

  describe("2. Delegate Prediction + Retain Vote", function () {
    it("Should allow predicting delegated while retaining own vote", async function () {
      // Alice buys stream1 weight with her own burn, THEN delegates prediction.
      const weightBefore = await voting.weightOf(stream1);
      await voteFor(satori, alice, stream1);
      expect(await voting.weightOf(stream1)).to.equal(weightBefore + VOTE);

      await satori.connect(alice).delegatePredictionPower(bob.address);

      // Her weight is hers for good: burnt tokens cannot be reclaimed, moved or
      // re-pointed, so handing prediction power to Bob leaves it exactly where
      // she put it.
      expect(await voting.weightOf(stream1)).to.equal(weightBefore + VOTE);

      // Being delegated no longer blocks voting. The hub sequences it: it
      // undelegates her (the tested clean-removal path), burns, then puts her
      // straight back — so the burn can never leave Bob predicting on tokens
      // that no longer exist. Her delegation survives, and Bob's power falls by
      // exactly what she burnt.
      const bobPowerBefore = await rewards.getPredictionPower(bob.address);
      await satori.connect(alice).vote(stream1, VOTE);
      expect(await voting.weightOf(stream1)).to.equal(weightBefore + VOTE * 2n);
      const [stillDelegate] = await rewards.predictionDelegateInfo(alice.address);
      expect(stillDelegate).to.equal(bob.address);
      expect(await rewards.getPredictionPower(bob.address))
        .to.equal(bobPowerBefore - VOTE);

      // Bob can predict with Alice's power
      await registry.setValue(stream1, 1000);
      const currentRound = await satori.getCurrentRound();
      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      const prediction = await satori.predictions(bob.address, stream1, currentRound);
      expect(prediction.direction).to.equal(UP);
    });
  });

  describe("3. Delegate Prediction + Retain Claim", function () {
    it("Should allow delegating prediction while retaining claim ability", async function () {
      // Alice delegates prediction to Bob
      await satori.connect(alice).delegatePredictionPower(bob.address);
      // Delegator weight is capital x loyalty and a fresh delegation starts at
      // L = 0, so any share measured below reads zero without a warm-up. The
      // helper drains predictor and delegators to `owner`, so prediction power
      // and delegated capital are exactly as the delegations left them.
      await warmUpLoyalty(satori, registry, null, bob, [alice], owner, stream1);

      // Bob predicts with Alice's power in round 2
      await registry.setValue(stream1, 1000);
      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      await advanceRound(); // Now round 3
      await registry.setValue(stream1, 1100); // Value went up - Bob was correct
      await advanceRound(); // Now round 4

      // Trigger scoring by having Bob predict again (lazy evaluation)
      await registry.setValue(stream1, 1200);
      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // Alice's balance before claims
      const aliceBalanceBefore = await satori.balanceOf(alice.address);

      // Pull-based model: Bob settles rounds via his claim, Alice pulls her share.
      await satori.connect(bob).claim();
      await satori.connect(alice).claim();

      const aliceBalanceAfter = await satori.balanceOf(alice.address);

      expect(aliceBalanceAfter).to.be.greaterThan(aliceBalanceBefore);
    });
  });

  describe("4. Chained Prediction Delegation", function () {
    it("Should handle prediction A→B→C chain (single-hop only)", async function () {
      // Alice → Bob → Carol chain
      await satori.connect(alice).delegatePredictionPower(bob.address);
      await satori.connect(bob).delegatePredictionPower(carol.address);

      // Carol only gets Bob's OWN tokens (single-hop), not Alice's
      const carolPower = await rewards.getPredictionPower(carol.address);
      expect(carolPower).to.equal(UNIT * 4n); // Carol 2U + Bob 2U (NOT Alice's)

      // Bob has 0 power (delegated to Carol)
      const bobPower = await rewards.getPredictionPower(bob.address);
      expect(bobPower).to.equal(0);

      // Alice has 0 power (delegated to Bob)
      const alicePower = await rewards.getPredictionPower(alice.address);
      expect(alicePower).to.equal(0);

      // Carol can predict
      await registry.setValue(stream1, 1000);
      const currentRound = await satori.getCurrentRound();
      await satori.connect(carol).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      const prediction = await satori.predictions(carol.address, stream1, currentRound);
      expect(prediction.direction).to.equal(UP);
    });
  });

  describe("5. Mass Delegation", function () {
    it("Should handle 5 users delegating to 1 user correctly", async function () {
      // Everyone delegates prediction to Alice
      await satori.connect(bob).delegatePredictionPower(alice.address);
      await satori.connect(carol).delegatePredictionPower(alice.address);
      await satori.connect(dave).delegatePredictionPower(alice.address);
      await satori.connect(eve).delegatePredictionPower(alice.address);
      // Delegator weight is capital x loyalty and a fresh delegation starts at
      // L = 0, so any share measured below reads zero without a warm-up. The
      // helper drains predictor and delegators to `owner`, so prediction power
      // and delegated capital are exactly as the delegations left them.
      await warmUpLoyalty(satori, registry, null, alice, [bob, carol, dave, eve], owner, stream1);

      // Alice should have massive prediction power
      const alicePower = await rewards.getPredictionPower(alice.address);
      // Alice: 2U + Bob: 2U + Carol: 2U + Dave: U + Eve: U = 8U
      expect(alicePower).to.equal(UNIT * 8n);

      // Alice predicts with all delegated power
      await registry.setValue(stream1, 1000);
      const roundBefore = await satori.getCurrentRound();
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // Verify prediction power recorded
      const prediction = await satori.predictions(alice.address, stream1, roundBefore);
      expect(prediction.rawPredictionPower).to.be.closeTo(UNIT * 8n, RAW_TOLERANCE);

      // Make prediction correct
      await advanceRound(); // Now round 3
      await registry.setValue(stream1, 1100); // Value went up, Alice was correct
      await advanceRound(); // Now round 4

      // Trigger scoring by having Alice predict again (lazy evaluation)
      await registry.setValue(stream1, 1200);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // All delegators should be able to claim their share
      await satori.connect(bob).claim();
      await satori.connect(carol).claim();
      await satori.connect(dave).claim();
      await satori.connect(eve).claim();
      await satori.connect(alice).claim();

      // Verify everyone got rewards (each holds at least their starting balance)
      expect(await satori.balanceOf(bob.address)).to.be.greaterThan(UNIT * 2n);
      expect(await satori.balanceOf(carol.address)).to.be.greaterThan(UNIT * 2n);
      expect(await satori.balanceOf(dave.address)).to.be.greaterThan(UNIT);
      expect(await satori.balanceOf(eve.address)).to.be.greaterThan(UNIT);
      expect(await satori.balanceOf(alice.address)).to.be.greaterThan(UNIT * 2n);
    });
  });

  describe("6. Delegation with Zero Balance", function () {
    it("Should allow user with 0 tokens to delegate", async function () {
      // Transfer all of Alice's tokens away (Alice started with 2U)
      await advanceRound(); // Unlock from initial setup
      await satori.connect(alice).transfer(bob.address, UNIT * 2n);

      expect(await satori.balanceOf(alice.address)).to.equal(0);

      // Alice can still delegate (even with 0 balance)
      await satori.connect(alice).delegatePredictionPower(bob.address);
      await satori.connect(alice).delegateClaimAbility(bob.address);

      // Verify delegations set
      expect((await rewards.predictionDelegateInfo(alice.address)).delegate).to.equal(bob.address);
      expect(await rewards.claimDelegateInfo(alice.address)).to.equal(bob.address);

      // ...but with nothing to burn she cannot buy a game any weight.
      await expect(satori.connect(alice).vote(stream1, VOTE)).to.be.reverted;
    });
  });

  describe("7. Receive Tokens While Delegated", function () {
    it("Should update delegate power when delegator receives tokens", async function () {
      // Alice delegates to Bob
      await satori.connect(alice).delegatePredictionPower(bob.address);

      const bobPowerBefore = await rewards.getPredictionPower(bob.address);
      expect(bobPowerBefore).to.equal(UNIT * 4n); // Bob 2U + Alice 2U

      // Alice receives 1U more tokens from Carol
      await satori.connect(carol).transfer(alice.address, UNIT);

      // adv_6: a mid-round receipt to a delegator DEFERS to next round — so Bob's
      // power is unchanged this round...
      expect(await rewards.getPredictionPower(bob.address)).to.equal(UNIT * 4n);
      // ...and reflects Alice's +1U once it activates next round.
      await advanceRound();
      const bobPowerAfter = await rewards.getPredictionPower(bob.address);
      expect(bobPowerAfter).to.equal(UNIT * 5n); // Bob 2U + Alice 3U

      // Bob predicts with the now-activated power
      await registry.setValue(stream1, 1000);
      const currentRound = await satori.getCurrentRound();
      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      const prediction = await satori.predictions(bob.address, stream1, currentRound);
      expect(prediction.rawPredictionPower).to.be.closeTo(UNIT * 5n, RAW_TOLERANCE);
    });

    it("Should leave already-bought vote weight untouched when a holder's balance moves", async function () {
      // Under burn voting the tokens that bought weight no longer exist, so a
      // later balance move — in either direction — cannot change a game's
      // weight. (This replaces the old "receiving tokens raises your delegate's
      // voting power": there is no balance-tracking vote weight any more.)
      await voteFor(satori, alice, stream1);
      const weightAfterVote = await voting.weightOf(stream1);

      await satori.connect(carol).transfer(alice.address, UNIT * 2n);
      expect(await voting.weightOf(stream1)).to.equal(weightAfterVote);

      await advanceRound();
      await satori.connect(alice).transfer(carol.address, UNIT * 2n);
      expect(await voting.weightOf(stream1)).to.equal(weightAfterVote);
    });

    it("Should handle claim delegation when delegator accumulates rewards", async function () {
      // Alice delegates claim to Bob
      await satori.connect(alice).delegateClaimAbility(bob.address);

      // Alice predicts and earns rewards in round 2. stream1 already carries
      // burnt weight from beforeEach, and that weight is permanent — there is
      // nothing to re-cast each round.
      await registry.setValue(stream1, 1000);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      await advanceRound(); // Now round 3, provides value B
      await registry.setValue(stream1, 1100); // Value went up - Alice was correct, value B

      await advanceRound(); // Now round 4, provides value C
      await registry.setValue(stream1, 1200); // value C

      // Trigger scoring by having Alice predict again (A-B-C scoring)
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // Advance rounds to accumulate rewards
      await advanceRound();
      await advanceRound();
      await advanceRound();

      // Check if Alice has unclaimed rewards
      const aliceUnclaimed = await rewards.unclaimedRewards(alice.address);
      console.log("Alice unclaimed rewards:", aliceUnclaimed.toString());

      // Bob can claim Alice's rewards via claimFor (Bob is claim delegate, rewards go to Bob)
      const bobBalanceBefore = await satori.balanceOf(bob.address);

      await satori.connect(bob).claimFor(alice.address, bob.address);

      const bobBalanceAfter = await satori.balanceOf(bob.address);

      // Bob should have received Alice's rewards
      expect(bobBalanceAfter).to.be.greaterThan(bobBalanceBefore);
    });
  });
});
