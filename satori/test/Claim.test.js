const { expect } = require("chai");
const { deploySatoriFixture, pack1, VOTE, warmUpLoyalty } = require("./fixtures");
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

describe("Claim Feature", function () {
  let satori, voting, rewards, bounties, registry, lens;
  let owner, alice, bob, carol;
  let stream1, stream2;
  const UP = 1;
  const DOWN = 2;

  beforeEach(async function () {
    const fix = await deploySatoriFixture();
    ;({ satori, voting, rewards, registry, bounties, lens, owner } = fix);
    [, alice, bob, carol] = await ethers.getSigners();

    // Create test streams
    const tx1 = await satori.createSimpleDataStream("Stream 1", owner.address);
    stream1 = await getStreamIdFromTx(tx1, satori);

    const tx2 = await satori.createSimpleDataStream("Stream 2", owner.address);
    stream2 = await getStreamIdFromTx(tx2, satori);

    // Give users tokens. INITIAL_MINT is 720; this fixture creates 2 streams
    // up front (28 SATORI at 14/stream), leaving 692 — so cap user grants at
    // 600 total to keep some headroom for any in-test stream creations.
    await satori.transfer(alice.address, ethers.parseEther("300"));
    await satori.transfer(bob.address, ethers.parseEther("200"));
    await satori.transfer(carol.address, ethers.parseEther("100"));

    // Burn for each stream once to establish eligibility. Weight is PERMANENT
    // now, so a single burn per game is all any round ever needs — the old
    // re-vote-every-round pattern is gone with the per-round vote snapshot.
    await satori.connect(alice).vote(stream1, VOTE);
    await satori.connect(bob).vote(stream2, VOTE);

    // Advance one round so the burns above sit in a finished round
    await advanceToNextRound();
  });

  describe("Basic Claiming", function () {
    it("Should claim rewards to own address (existing behavior)", async function () {
      // R1: Alice predicts Stream 1
      await registry.setValue(stream1, 100);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // R2: Value changes
      await advanceToNextRound();
      await registry.setValue(stream1, 150); // UP
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // R3: Score R1
      await advanceToNextRound();
      await registry.setValue(stream1, 200);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // Claim reward to self
      const balanceBefore = await satori.balanceOf(alice.address);
      await satori.connect(alice)['claim()']();
      const balanceAfter = await satori.balanceOf(alice.address);

      expect(balanceAfter).to.be.gt(balanceBefore);
    });

    it("Should claim rewards to specified address", async function () {
      // R1: Alice predicts Stream 1
      await registry.setValue(stream1, 100);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // R2: Value changes
      await advanceToNextRound();
      await registry.setValue(stream1, 150); // UP
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // R3: Score R1
      await advanceToNextRound();
      await registry.setValue(stream1, 200);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // Claim reward to Bob's address
      const aliceBalanceBefore = await satori.balanceOf(alice.address);
      const bobBalanceBefore = await satori.balanceOf(bob.address);

      await satori.connect(alice)['claim(address)'](bob.address);

      const aliceBalanceAfter = await satori.balanceOf(alice.address);
      const bobBalanceAfter = await satori.balanceOf(bob.address);

      // Alice's balance should not increase
      expect(aliceBalanceAfter).to.equal(aliceBalanceBefore);
      // Bob's balance should increase
      expect(bobBalanceAfter).to.be.gt(bobBalanceBefore);
    });

    it("Should default to msg.sender when recipient is address(0)", async function () {
      // R1: Alice predicts Stream 1
      await registry.setValue(stream1, 100);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // R2: Value changes
      await advanceToNextRound();
      await registry.setValue(stream1, 150); // UP
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // R3: Score R1
      await advanceToNextRound();
      await registry.setValue(stream1, 200);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // Claim with no recipient specified (defaults to msg.sender)
      const balanceBefore = await satori.balanceOf(alice.address);
      await satori.connect(alice)['claim()']();
      const balanceAfter = await satori.balanceOf(alice.address);

      // Alice's balance should increase (defaulted to msg.sender)
      expect(balanceAfter).to.be.gt(balanceBefore);
    });

    it("Should emit RewardClaimed with correct recipient", async function () {
      // R1: Alice predicts Stream 1
      await registry.setValue(stream1, 100);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // R2: Value changes
      await advanceToNextRound();
      await registry.setValue(stream1, 150); // UP
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // R3: Score R1
      await advanceToNextRound();
      await registry.setValue(stream1, 200);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // Claim and check event
      const currentRound = await satori.getCurrentRound();
      await expect(satori.connect(alice)['claim(address)'](bob.address))
        .to.emit(rewards, "RewardsClaimed")
        .withArgs(alice.address, bob.address, anyUint(), currentRound);

      function anyUint() {
        return (value) => value > 0n;
      }
    });

    it("Should prevent claiming already-claimed rewards", async function () {
      // R1: Alice predicts Stream 1
      await registry.setValue(stream1, 100);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // R2: Value changes
      await advanceToNextRound();
      await registry.setValue(stream1, 150); // UP
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // R3: Score R1
      await advanceToNextRound();
      await registry.setValue(stream1, 200);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // Claim once
      await satori.connect(alice)['claim(address)'](bob.address);

      // Try to claim again - with new claim() there's just nothing left to claim
      const bobBalanceBefore = await satori.balanceOf(bob.address);
      await satori.connect(alice)['claim(address)'](bob.address);
      const bobBalanceAfter = await satori.balanceOf(bob.address);

      // Bob's balance should not increase since all rewards were already claimed
      expect(bobBalanceAfter).to.equal(bobBalanceBefore);
    });
  });

  describe("Simplified Claiming (New claim() Function)", function () {
    beforeEach(async function () {
      // Setup multiple predictions for Alice across rounds.
      // Both streams carry burnt weight, but only stream1 is ever PREDICTED,
      // so it is the only game that enters a round's denominator and Alice
      // takes the whole slice. Predictions use only stream1.

      // R1: Predict stream1
      await registry.setValue(stream1, 100);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // R2: Values change
      await advanceToNextRound();
      await registry.setValue(stream1, 150); // UP
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // R3: Score R1, predict again
      await advanceToNextRound();
      await registry.setValue(stream1, 200);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // R4: Score R2
      await advanceToNextRound();
      await registry.setValue(stream1, 250);
      // Predict again to trigger R2 scoring
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // Now Alice has claimable rewards accumulated from multiple predictions
    });

    it("Should claim all rewards at once", async function () {
      const balanceBefore = await satori.balanceOf(alice.address);

      // Claim all rewards at once with new simplified function
      await satori.connect(alice)['claim()']();

      const balanceAfter = await satori.balanceOf(alice.address);
      expect(balanceAfter).to.be.gt(balanceBefore);
    });

    it("Should claim all rewards to specified recipient", async function () {
      const aliceBalanceBefore = await satori.balanceOf(alice.address);
      const bobBalanceBefore = await satori.balanceOf(bob.address);

      // Claim all rewards to Bob
      await satori.connect(alice)['claim(address)'](bob.address);

      const aliceBalanceAfter = await satori.balanceOf(alice.address);
      const bobBalanceAfter = await satori.balanceOf(bob.address);

      // Alice's balance should not increase
      expect(aliceBalanceAfter).to.equal(aliceBalanceBefore);
      // Bob's balance should increase
      expect(bobBalanceAfter).to.be.gt(bobBalanceBefore);
    });

    it("Should default to msg.sender when no recipient specified", async function () {
      const balanceBefore = await satori.balanceOf(alice.address);

      // Claim with no recipient
      await satori.connect(alice)['claim()']();

      const balanceAfter = await satori.balanceOf(alice.address);
      expect(balanceAfter).to.be.gt(balanceBefore);
    });

    it("Should claim correct total amount from all predictions", async function () {
      // Get total claimable amount
      const expectedTotal = (await lens.getTotalClaimableRewards(alice.address))[0];

      const balanceBefore = await satori.balanceOf(alice.address);

      // Claim all
      await satori.connect(alice)['claim()']();

      const balanceAfter = await satori.balanceOf(alice.address);
      const actualReceived = balanceAfter - balanceBefore;

      expect(actualReceived).to.equal(expectedTotal);
    });

    it("Should emit RewardsClaimed event", async function () {
      await expect(satori.connect(alice)['claim(address)'](bob.address))
        .to.emit(rewards, "RewardsClaimed");
    });

    it("Should have nothing to claim after already claiming all", async function () {
      // Claim all rewards first
      await satori.connect(alice)['claim()']();

      // Check unclaimed rewards is now 0
      const unclaimedAfter = await rewards.unclaimedRewards(alice.address);
      expect(unclaimedAfter).to.equal(0);

      // Try to claim again - should succeed but with 0 amount
      const balanceBefore = await satori.balanceOf(alice.address);
      await satori.connect(alice)['claim()']();
      const balanceAfter = await satori.balanceOf(alice.address);

      expect(balanceAfter).to.equal(balanceBefore);
    });
  });

  describe("Edge Cases", function () {
    it("Should handle single prediction claim", async function () {
      // Setup a single prediction
      await registry.setValue(stream1, 100);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      await advanceToNextRound();
      await registry.setValue(stream1, 150);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      await advanceToNextRound();
      await registry.setValue(stream1, 200);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]); // Trigger R1 scoring

      // Claim single reward
      const balanceBefore = await satori.balanceOf(alice.address);
      await satori.connect(alice)['claim()']();
      const balanceAfter = await satori.balanceOf(alice.address);

      expect(balanceAfter).to.be.gt(balanceBefore);
    });

    it("Should handle claim with no rewards gracefully", async function () {
      // No predictions made, so no rewards
      const balanceBefore = await satori.balanceOf(alice.address);
      await satori.connect(alice)['claim()']();
      const balanceAfter = await satori.balanceOf(alice.address);

      // Balance should not change
      expect(balanceAfter).to.equal(balanceBefore);
    });

    it("Should handle claiming with delegation splits to recipient", async function () {
      // Alice delegates prediction power to Bob
      await satori.connect(alice).delegatePredictionPower(bob.address);
      // Delegator weight is capital x loyalty and a fresh delegation starts at
      // L = 0, so any delegator share measured below reads zero without a
      // warm-up. Drains to `carol` so no balance the test relies on moves.
      await warmUpLoyalty(satori, registry, null, bob, [alice], carol, stream1, 40, 2);

      // R1: Bob predicts using Alice's delegated power
      await registry.setValue(stream1, 100);
      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // R2: Value changes
      await advanceToNextRound();
      await registry.setValue(stream1, 150); // UP
      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // R3: Score R1
      await advanceToNextRound();
      await registry.setValue(stream1, 200);
      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]); // Trigger R1 scoring

      // Bob claims his predictor share to Carol's address
      const carolBalanceBefore = await satori.balanceOf(carol.address);
      await satori.connect(bob)['claim(address)'](carol.address);
      const carolBalanceAfter = await satori.balanceOf(carol.address);

      // Carol should receive Bob's predictor reward (90% of delegated portion)
      expect(carolBalanceAfter).to.be.gt(carolBalanceBefore);
    });

    it("Should maintain reward split when claiming to different address", async function () {
      // Alice delegates prediction power to Bob
      await satori.connect(alice).delegatePredictionPower(bob.address);
      // Delegator weight is capital x loyalty and a fresh delegation starts at
      // L = 0, so any delegator share measured below reads zero without a
      // warm-up. Drains to `carol` so no balance the test relies on moves.
      await warmUpLoyalty(satori, registry, null, bob, [alice], carol, stream1, 40, 2);

      // R1: Bob predicts using Alice's delegated power
      await registry.setValue(stream1, 100);
      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // R2: Value changes
      await advanceToNextRound();
      await registry.setValue(stream1, 150); // UP
      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // R3: Score R1
      await advanceToNextRound();
      await registry.setValue(stream1, 200);
      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]); // Trigger R1 scoring

      // Pull-based model: Bob claims his predictor share to Carol;
      // Alice claims her delegator share herself.
      const aliceBalanceBefore = await satori.balanceOf(alice.address);
      const carolBalanceBefore = await satori.balanceOf(carol.address);

      await satori.connect(bob)['claim(address)'](carol.address);
      await satori.connect(alice)['claim()']();

      const aliceBalanceAfter = await satori.balanceOf(alice.address);
      const carolBalanceAfter = await satori.balanceOf(carol.address);

      // Carol should receive Bob's rewards (own power + predictor bonus)
      expect(carolBalanceAfter).to.be.gt(carolBalanceBefore);
      // Alice's pull claim mints her delegator share
      expect(aliceBalanceAfter).to.be.gt(aliceBalanceBefore);
    });
  });
});
