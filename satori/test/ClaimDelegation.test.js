const { expect } = require("chai");
const { deploySatoriFixture, pack1, VOTE } = require("./fixtures");
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

// Helper to advance to next day and call endRound
async function advanceToNextRound() {
  const currentTime = await time.latest();
  const nextMidnight = Math.floor(currentTime / 86400) * 86400 + 86400;
  await time.increaseTo(nextMidnight + 1);
  await time.increase(86400);
}

describe("Claim Delegation", function () {
  let satori, voting, rewards, bounties, registry;
  let owner, alice, bob, carol, dave;
  let stream1, stream2;
  const UP = 1;
  const DOWN = 2;

  beforeEach(async function () {
    [owner, alice, bob, carol, dave] = await ethers.getSigners();

    const fix = await deploySatoriFixture();
    ({ satori, voting, rewards, registry, bounties } = fix);

    // Create test streams
    const tx1 = await satori.createSimpleDataStream("Stream 1", owner.address);
    stream1 = await getStreamIdFromTx(tx1, satori);

    const tx2 = await satori.createSimpleDataStream("Stream 2", owner.address);
    stream2 = await getStreamIdFromTx(tx2, satori);

    // Distribute tokens in 5:2.5:1.5:1 ratio. Sum stays well under the
    // bootstrap minus stream-creation fees (2 streams × 14 SATORI = 28
    // already spent above = ~692 SATORI available; scale to
    // 45/22.5/13.5/9 → 90% sum = 648).
    const INITIAL_MINT = await satori.INITIAL_MINT();
    await satori.transfer(alice.address, (INITIAL_MINT * 45n) / 100n);
    await satori.transfer(bob.address, (INITIAL_MINT * 225n) / 1000n);
    await satori.transfer(carol.address, (INITIAL_MINT * 135n) / 1000n);
    await satori.transfer(dave.address, (INITIAL_MINT * 9n) / 100n);

    // Burn once per stream to establish eligibility. Burnt weight is PERMANENT,
    // so nothing needs to re-vote each round; several voters can back the same
    // game and their burns simply add up.
    await satori.connect(alice).vote(stream1, VOTE);
    await satori.connect(bob).vote(stream1, VOTE);
    await satori.connect(carol).vote(stream2, VOTE);
    await satori.connect(dave).vote(stream2, VOTE);

    // Advance one round so the burns above sit in a finished round
    await advanceToNextRound();
  });

  describe("Basic Delegation", function () {
    it("Should allow delegating claim ability to another address", async function () {
      // Alice delegates claim ability to Bob
      await satori.connect(alice).delegateClaimAbility(bob.address);

      // Check delegation stored
      const delegate = await rewards.claimDelegateInfo(alice.address);
      expect(delegate).to.equal(bob.address);
    });

    it("Should update claimDelegate correctly", async function () {
      // Initially no delegation
      expect(await rewards.claimDelegateInfo(alice.address)).to.equal(ethers.ZeroAddress);

      // Alice delegates to Bob
      await satori.connect(alice).delegateClaimAbility(bob.address);
      expect(await rewards.claimDelegateInfo(alice.address)).to.equal(bob.address);

      // Alice changes delegation to Carol
      await satori.connect(alice).delegateClaimAbility(carol.address);
      expect(await rewards.claimDelegateInfo(alice.address)).to.equal(carol.address);
    });

    it("Should allow delegation to self (undelegation)", async function () {
      // Alice delegates to Bob
      await satori.connect(alice).delegateClaimAbility(bob.address);
      expect(await rewards.claimDelegateInfo(alice.address)).to.equal(bob.address);

      // Alice undelegates by delegating to self
      await satori.connect(alice).delegateClaimAbility(alice.address);

      // Check delegation updated to self
      const delegate = await rewards.claimDelegateInfo(alice.address);
      expect(delegate).to.equal(alice.address);
    });

    it("Should allow delegation to address(0) (undelegation)", async function () {
      // Alice delegates to Bob
      await satori.connect(alice).delegateClaimAbility(bob.address);
      expect(await rewards.claimDelegateInfo(alice.address)).to.equal(bob.address);

      // Alice undelegates by delegating to address(0)
      await satori.connect(alice).delegateClaimAbility(ethers.ZeroAddress);

      // Check delegation updated to address(0)
      const delegate = await rewards.claimDelegateInfo(alice.address);
      expect(delegate).to.equal(ethers.ZeroAddress);
    });

    it("Should emit ClaimDelegated event", async function () {
      await expect(satori.connect(alice).delegateClaimAbility(bob.address))
        .to.emit(rewards, "ClaimDelegated")
        .withArgs(alice.address, bob.address);
    });
  });

  describe("Claiming with Delegation", function () {
    beforeEach(async function () {
      // Setup: Alice makes predictions to generate rewards
      // The main beforeEach already voted and advanced to round 1
      // R1: Alice predicts Stream 1
      await registry.setValue(stream1, 100);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // R2: Value changes
      await advanceToNextRound();
      await registry.setValue(stream1, 150); // UP

      // R3: Score R1 - Alice now has claimable rewards
      await advanceToNextRound();
      await registry.setValue(stream1, 200);
      await satori.settlePrediction(alice.address, stream1); // score without predicting, so the claim may go elsewhere
    });

    it("Should allow delegate to claim on behalf of owner", async function () {
      // Alice delegates claim ability to Bob
      await satori.connect(alice).delegateClaimAbility(bob.address);

      // Bob claims Alice's rewards using claimFor
      const bobBalanceBefore = await satori.balanceOf(bob.address);
      await satori.connect(bob)['claimFor(address,address)'](alice.address, bob.address);
      const bobBalanceAfter = await satori.balanceOf(bob.address);

      // Bob should receive the rewards (claims Alice's delegated rewards)
      expect(bobBalanceAfter).to.be.gt(bobBalanceBefore);
    });

    it("Should allow delegate to specify recipient", async function () {
      // Alice delegates claim ability to Bob
      await satori.connect(alice).delegateClaimAbility(bob.address);

      // Bob claims Alice's rewards and sends to Carol
      const carolBalanceBefore = await satori.balanceOf(carol.address);
      await satori.connect(bob)['claimFor(address,address)'](alice.address, carol.address);
      const carolBalanceAfter = await satori.balanceOf(carol.address);

      // Carol should receive the rewards
      expect(carolBalanceAfter).to.be.gt(carolBalanceBefore);
    });

    it("Should default to delegate's address as recipient", async function () {
      // Alice delegates claim ability to Bob
      await satori.connect(alice).delegateClaimAbility(bob.address);

      // Bob claims and sends to his own address
      const bobBalanceBefore = await satori.balanceOf(bob.address);
      await satori.connect(bob)['claimFor(address,address)'](alice.address, bob.address);
      const bobBalanceAfter = await satori.balanceOf(bob.address);

      // Bob should receive the rewards (defaulted to msg.sender)
      expect(bobBalanceAfter).to.be.gt(bobBalanceBefore);
    });

    it("Should prevent owner from claiming while delegated", async function () {
      // Alice delegates claim ability to Bob
      await satori.connect(alice).delegateClaimAbility(bob.address);

      // Alice tries to claim her own rewards - with new claim() she cannot claim while delegated
      await expect(
        satori.connect(alice)['claim()']()
      ).to.be.revertedWithCustomError(rewards, "ClaimDelegatedAway");
    });

    it("Should prevent non-delegate from claiming", async function () {
      // Alice delegates claim ability to Bob
      await satori.connect(alice).delegateClaimAbility(bob.address);

      // The property in the title is the claimFor authorization gate
      // (_checkClaimAuth: `if (caller != owner) { if (ownerDelegate != caller)
      // revert Unauthorized(); }`). The previous body had Carol call her OWN
      // self-claim instead, where caller == owner so that branch is statically
      // unreachable — and Carol owns no bucket, so `carolAfter == carolBefore`
      // was 0 == 0 (P9: on an empty bucket neither a no-revert nor a no-delta
      // proves anything). Deleting the Unauthorized revert outright left it
      // green. Call the function the title names, as the non-delegate.
      const aliceBucketBefore = await rewards.unclaimedRewards(alice.address);
      expect(aliceBucketBefore, "alice must actually have a bucket worth stealing").to.be.gt(0n);
      const carolBalanceBefore = await satori.balanceOf(carol.address);

      await expect(
        satori.connect(carol)['claimFor(address,address)'](alice.address, carol.address)
      ).to.be.revertedWithCustomError(rewards, "Unauthorized");

      // …and the rejected attempt moved nothing: alice's bucket is intact and
      // Carol received no tokens.
      expect(await rewards.unclaimedRewards(alice.address)).to.equal(aliceBucketBefore);
      expect(await satori.balanceOf(carol.address)).to.equal(carolBalanceBefore);
    });

    it("Should allow delegate to claim to owner's address", async function () {
      // Alice delegates claim ability to Bob
      await satori.connect(alice).delegateClaimAbility(bob.address);

      // Bob claims and sends rewards back to Alice
      const aliceBalanceBefore = await satori.balanceOf(alice.address);
      await satori.connect(bob)['claimFor(address,address)'](alice.address, alice.address);
      const aliceBalanceAfter = await satori.balanceOf(alice.address);

      // Alice should receive her own rewards (claimed by Bob, her delegate)
      expect(aliceBalanceAfter).to.be.gt(aliceBalanceBefore);
    });
  });

  describe("Undelegation Timing", function () {
    beforeEach(async function () {
      // Setup: Alice makes predictions in multiple rounds
      // R1: Predict
      await registry.setValue(stream1, 100);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // R2: Value changes, predict again
      await advanceToNextRound();
      await registry.setValue(stream1, 150); // UP
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // R3: Score R1, predict again
      await advanceToNextRound();
      await registry.setValue(stream1, 200);
      await satori.settlePrediction(alice.address, stream1); // score without predicting, so the claim may go elsewhere

      // Alice now has claimable rewards for round 1
    });

    it("Should allow owner to claim immediately after undelegation (no cooldown)", async function () {
      // Alice delegates to Bob
      await satori.connect(alice).delegateClaimAbility(bob.address);

      // Bob claims all available rewards (round 1)
      await satori.connect(bob)['claimFor(address,address)'](alice.address, bob.address);

      // Continue to build more claimable rewards
      await advanceToNextRound();
      await registry.setValue(stream1, 250);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // Alice undelegates.
      await satori.connect(alice).delegateClaimAbility(alice.address);

      // Alice can claim immediately in the same round.
      await expect(
        satori.connect(alice)['claim()']()
      ).to.not.be.reverted;
    });

    it("Should allow owner to claim after round advances", async function () {
      // Alice delegates to Bob
      await satori.connect(alice).delegateClaimAbility(bob.address);

      // Continue to build more claimable rewards
      // R4: Score R2
      await advanceToNextRound();
      await registry.setValue(stream1, 250);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // Alice now has round 2 claimable

      // Alice undelegates in round 4
      await satori.connect(alice).delegateClaimAbility(alice.address);

      // Advance to next round (R5)
      await advanceToNextRound();
      await registry.setValue(stream1, 300);

      // Now Alice can claim
      await expect(
        satori.connect(alice)['claim()']()
      ).to.not.be.reverted;
    });

    it("Should allow immediate delegation to a new delegate AND immediate claim by that new delegate", async function () {
      // Alice delegates to Bob.
      await satori.connect(alice).delegateClaimAbility(bob.address);

      // Build more claimable rewards.
      await advanceToNextRound();
      await registry.setValue(stream1, 250);
      await satori.settlePrediction(alice.address, stream1); // score without predicting, so the claim may go elsewhere

      // Alice undelegates, then re-delegates to Carol — both in the same round.
      await satori.connect(alice).delegateClaimAbility(alice.address);
      await satori.connect(alice).delegateClaimAbility(carol.address);

      // Carol can claim for Alice immediately. No cooldown gate.
      await expect(
        satori.connect(carol)['claimFor(address,address)'](alice.address, carol.address)
      ).to.not.be.reverted;
    });
  });

  describe("Integration with Existing Systems", function () {
    it("Should work with prediction delegation reward splits", async function () {
      // Alice delegates prediction power to Bob
      await satori.connect(alice).delegatePredictionPower(bob.address);
      await time.increase(86400);

      // Bob predicts using Alice's power
      await registry.setValue(stream1, 100);
      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      await advanceToNextRound();
      await registry.setValue(stream1, 150); // UP
      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      await advanceToNextRound();
      await registry.setValue(stream1, 200);
      await satori.settlePrediction(bob.address, stream1); // score without predicting, so the claim may go elsewhere

      // Bob delegates claim ability to Carol
      await satori.connect(bob).delegateClaimAbility(carol.address);

      // Pull-based model: Carol claims Bob's predictor share via claimFor;
      // Alice pulls her own delegator share.
      const carolBalanceBefore = await satori.balanceOf(carol.address);
      const aliceBalanceBefore = await satori.balanceOf(alice.address);

      await satori.connect(carol).claimFor(bob.address, carol.address);
      await satori.connect(alice)['claim()']();

      const carolBalanceAfter = await satori.balanceOf(carol.address);
      const aliceBalanceAfter = await satori.balanceOf(alice.address);

      // Carol should receive Bob's predictor rewards (own power + predictor bonus)
      expect(carolBalanceAfter).to.be.gt(carolBalanceBefore);

      // Alice's pull claim mints her delegator share
      expect(aliceBalanceAfter).to.be.gt(aliceBalanceBefore);
    });

    it("Should allow batch claiming as delegate", async function () {
      // Only stream1 is ever predicted, so it is the only game in the round's
      // denominator and Alice takes the whole slice.
      await registry.setValue(stream1, 100);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      await advanceToNextRound();
      await registry.setValue(stream1, 150);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      await advanceToNextRound();
      await registry.setValue(stream1, 200);
      await satori.settlePrediction(alice.address, stream1); // score without predicting, so the claim may go elsewhere

      // Alice delegates claim ability to Bob
      await satori.connect(alice).delegateClaimAbility(bob.address);

      // Bob claims Alice's rewards as her delegate
      const bobBalanceBefore = await satori.balanceOf(bob.address);
      await satori.connect(bob)['claimFor(address,address)'](alice.address, bob.address);
      const bobBalanceAfter = await satori.balanceOf(bob.address);

      expect(bobBalanceAfter).to.be.gt(bobBalanceBefore);
    });

    it("Should maintain backward compatibility (no owner param)", async function () {
      // Setup: Alice makes a prediction
      await registry.setValue(stream1, 100);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      await advanceToNextRound();
      await registry.setValue(stream1, 150);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      await advanceToNextRound();
      await registry.setValue(stream1, 200);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // Alice claims (new claim() function defaults to claiming for self)
      const balanceBefore = await satori.balanceOf(alice.address);
      await satori.connect(alice)['claim()']();
      const balanceAfter = await satori.balanceOf(alice.address);

      expect(balanceAfter).to.be.gt(balanceBefore);
    });

    it("Should work with multiple streams and rounds", async function () {
      // Only stream1 is ever predicted, so it is the only game in each round's
      // denominator. Alice makes predictions across multiple rounds on stream1.
      for (let round = 0; round < 5; round++) {
        await registry.setValue(stream1, 100 + round * 50);
        await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);
        await advanceToNextRound();
      }

      // Alice delegates claim ability to Bob
      await satori.connect(alice).delegateClaimAbility(bob.address);

      // Bob claims all rewards at once for Alice
      const bobBalanceBefore = await satori.balanceOf(bob.address);

      await satori.connect(bob)['claimFor(address,address)'](alice.address, bob.address);

      const bobBalanceAfter = await satori.balanceOf(bob.address);
      expect(bobBalanceAfter).to.be.gt(bobBalanceBefore);
    });

    it("Should emit correct events with owner/claimer/recipient", async function () {
      // Setup: Alice makes a prediction
      await registry.setValue(stream1, 100);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      await advanceToNextRound();
      await registry.setValue(stream1, 150);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      await advanceToNextRound();
      await registry.setValue(stream1, 200);
      await satori.settlePrediction(alice.address, stream1); // score without predicting, so the claim may go elsewhere

      // Alice delegates claim ability to Bob
      await satori.connect(alice).delegateClaimAbility(bob.address);

      // Bob claims for Alice, sending to Carol
      const currentRound = await satori.getCurrentRound();
      await expect(
        satori.connect(bob)['claimFor(address,address)'](alice.address, carol.address)
      )
        .to.emit(rewards, "RewardsClaimed")
        .withArgs(alice.address, carol.address, anyUint(), currentRound);

      function anyUint() {
        return (value) => value > 0n;
      }
    });
  });

  describe("Edge Cases", function () {
    it("Should handle changing delegation (from Bob to Carol)", async function () {
      // Setup: Alice makes predictions
      await registry.setValue(stream1, 100);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      await advanceToNextRound();
      await registry.setValue(stream1, 150);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      await advanceToNextRound();
      await registry.setValue(stream1, 200);
      await satori.settlePrediction(alice.address, stream1); // score without predicting, so the claim may go elsewhere

      // Alice delegates to Bob
      await satori.connect(alice).delegateClaimAbility(bob.address);

      // Bob can claim
      await expect(
        satori.connect(bob)['claimFor(address,address)'](alice.address, bob.address)
      ).to.not.be.reverted;

      // Build more rewards
      await advanceToNextRound();
      await registry.setValue(stream1, 250);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      await advanceToNextRound();
      await registry.setValue(stream1, 300);

      // Alice changes delegation to Carol
      await satori.connect(alice).delegateClaimAbility(carol.address);

      // Bob can no longer claim for Alice after delegation changed to Carol
      await expect(
        satori.connect(bob)['claimFor(address,address)'](alice.address, bob.address)
      ).to.be.revertedWithCustomError(rewards, "Unauthorized");

      // Carol can now claim for Alice
      await expect(
        satori.connect(carol)['claimFor(address,address)'](alice.address, carol.address)
      ).to.not.be.reverted;
    });

    it("Should handle owner claiming own rewards (default behavior)", async function () {
      // Setup: Alice makes predictions without any delegation
      await registry.setValue(stream1, 100);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      await advanceToNextRound();
      await registry.setValue(stream1, 150);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      await advanceToNextRound();
      await registry.setValue(stream1, 200);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // Alice claims her own rewards (no delegation involved)
      const balanceBefore = await satori.balanceOf(alice.address);
      await satori.connect(alice)['claim()']();
      const balanceAfter = await satori.balanceOf(alice.address);

      expect(balanceAfter).to.be.gt(balanceBefore);
    });

    it("Should handle zero address as owner (default to msg.sender)", async function () {
      // Setup: Alice makes predictions
      await registry.setValue(stream1, 100);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      await advanceToNextRound();
      await registry.setValue(stream1, 150);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      await advanceToNextRound();
      await registry.setValue(stream1, 200);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // Alice claims with new claim() (defaults to claiming for self)
      const balanceBefore = await satori.balanceOf(alice.address);
      await satori.connect(alice)['claim()']();
      const balanceAfter = await satori.balanceOf(alice.address);

      expect(balanceAfter).to.be.gt(balanceBefore);
    });

    it("Should handle delegate claiming to various recipients", async function () {
      // Setup: Alice makes predictions
      await registry.setValue(stream1, 100);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      await advanceToNextRound();
      await registry.setValue(stream1, 150);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      await advanceToNextRound();
      await registry.setValue(stream1, 200);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // Continue to build rewards for round 2
      await advanceToNextRound();
      await registry.setValue(stream1, 250);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      await advanceToNextRound();
      await registry.setValue(stream1, 300);

      // Alice delegates to Bob
      await satori.connect(alice).delegateClaimAbility(bob.address);

      // Bob claims Alice's delegated rewards to himself
      const bobBalanceBefore = await satori.balanceOf(bob.address);
      await satori.connect(bob)['claimFor(address,address)'](alice.address, bob.address);
      const bobBalanceAfter = await satori.balanceOf(bob.address);
      expect(bobBalanceAfter).to.be.gt(bobBalanceBefore);

      // Since all rewards were already claimed, trying to claim again gets nothing
      const aliceBalanceBefore = await satori.balanceOf(alice.address);
      await satori.connect(bob)['claimFor(address,address)'](alice.address, alice.address);
      const aliceBalanceAfter = await satori.balanceOf(alice.address);
      expect(aliceBalanceAfter).to.equal(aliceBalanceBefore);
    });
  });
});
