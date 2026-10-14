const { expect } = require("chai");
const { deploySatoriFixture, pack1, VOTE } = require("./fixtures");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("Comprehensive Delegation Tests", function () {
  let satori, rewards, bounties, owner, alice, bob, carol, dave, eve, registry;
  let streamId1, streamId2;

  async function getStreamIdFromTx(tx, contract) {
    const receipt = await tx.wait();
    const event = receipt.logs.find(log => {
      try {
        const parsed = contract.interface.parseLog(log);
        return parsed && parsed.name === "DataStreamCreated";
      } catch {
        return false;
      }
    });
    if (!event) throw new Error("DataStreamCreated event not found");
    return contract.interface.parseLog(event).args.streamId;
  }

  beforeEach(async function () {
    [owner, alice, bob, carol, dave, eve] = await ethers.getSigners();

    // Deploy the restructured Satori stack via the shared fixture.
    const fix = await deploySatoriFixture();
    ({ satori, rewards, registry, bounties, owner } = fix);

    // Enable test mode and advance to round 1
    await time.increase(86400);

    // Distribute tokens
    await satori.transfer(alice.address, ethers.parseEther("100"));
    await satori.transfer(bob.address, ethers.parseEther("150"));
    await satori.transfer(carol.address, ethers.parseEther("200"));
    await satori.transfer(dave.address, ethers.parseEther("50"));
    await satori.transfer(eve.address, ethers.parseEther("75"));

    // Create data streams at 1440 minutes (every round): these tests measure
    // delegated prediction POWER, and the rounds they step through are
    // delegation/claim windows, not stream write windows.
    const tx1 = await satori.connect(owner)["createSimpleDataStream(string,address,uint24)"]("Stream 1", owner.address, 1440);
    streamId1 = await getStreamIdFromTx(tx1, satori);
    const tx2 = await satori.connect(owner)["createSimpleDataStream(string,address,uint24)"]("Stream 2", owner.address, 1440);
    streamId2 = await getStreamIdFromTx(tx2, satori);

    // Make streams eligible for predictions. OWNER pays the burn: voting now
    // destroys tokens, and every prediction-power assertion below is exact in
    // the balances handed out above.
    await satori.connect(owner).vote(streamId1, VOTE);
    await satori.connect(owner).vote(streamId2, VOTE);
  });

  describe("Power Calculation Edge Cases", function () {
    it("Should correctly calculate power in complex delegation chains", async function () {
      // Create a delegation chain where everyone delegates to Alice
      await satori.connect(dave).delegatePredictionPower(alice.address);
      await satori.connect(carol).delegatePredictionPower(alice.address);
      await satori.connect(bob).delegatePredictionPower(alice.address);

      // Alice should have combined power
      const alicePower = await rewards.getPredictionPower(alice.address);
      // Alice: 100 (own) + 150 (Bob) + 200 (Carol) + 50 (Dave) = 500
      expect(alicePower).to.equal(ethers.parseEther("500"));

      // Others should have 0 prediction power (delegated away)
      expect(await rewards.getPredictionPower(bob.address)).to.equal(0);
      expect(await rewards.getPredictionPower(carol.address)).to.equal(0);
      expect(await rewards.getPredictionPower(dave.address)).to.equal(0);
    });

    it("Should handle partial delegation chain with self-delegation", async function () {
      // Bob delegates to Alice, then Alice "self-delegates" (= undelegate)
      await satori.connect(bob).delegatePredictionPower(alice.address);
      await satori.connect(alice).delegatePredictionPower(alice.address);

      // Alice has 100 (own) + 150 (Bob) = 250
      const alicePower = await rewards.getPredictionPower(alice.address);
      expect(alicePower).to.equal(ethers.parseEther("250"));

      // Carol delegates to (self-normalized = undelegated) Alice
      await satori.connect(carol).delegatePredictionPower(alice.address);

      // Alice now has 100 (own) + 150 (Bob) + 200 (Carol) = 450
      const alicePowerAfter = await rewards.getPredictionPower(alice.address);
      expect(alicePowerAfter).to.equal(ethers.parseEther("450"));

      // Same-round predict blocked by next-round lock from the "undelegate"
      // call (self-delegate normalizes to lockUntilNextRound).
      await registry.setValue(streamId1, 1000);
      await expect(
        satori.connect(alice).predictMultipleWithPayloads([{ gameId: streamId1, payload: pack1(1) }])
      ).to.be.revertedWithCustomError(satori, "Locked");
    });
  });

  describe("Multi-Round Delegation Scenarios", function () {
    it("Should handle delegation changes across multiple rounds", async function () {
      // Round 1: Alice delegates to Bob
      await satori.connect(alice).delegatePredictionPower(bob.address);
      await registry.setValue(streamId1, 1000);
      const round1 = await satori.getCurrentRound();
      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: streamId1, payload: pack1(1) }]);

      // Alice cannot switch in round 1 (Bob predicted)
      await expect(
        satori.connect(alice).delegatePredictionPower(carol.address)
      ).to.be.revertedWithCustomError(satori, "DelegateActive");

      // Advance to round 2
      await time.increase(86400);

      // Round 2: Alice can now switch to Carol
      await satori.connect(alice).delegatePredictionPower(carol.address);
      await registry.setValue(streamId1, 1100);
      const round2 = await satori.getCurrentRound();
      await satori.connect(carol).predictMultipleWithPayloads([{ gameId: streamId1, payload: pack1(2) }]); // Predict DOWN

      // Advance to round 3
      await time.increase(86400);

      // Round 3: Alice undelegates
      const round3 = await satori.getCurrentRound();
      await satori.connect(alice).delegatePredictionPower(ethers.ZeroAddress);

      // Alice is now locked until next round
      const lockedUntil = await satori.lockedUntil(alice.address);
      expect(lockedUntil).to.equal(round3 + 1n);

      // Advance to round 4
      await time.increase(86400);

      // Round 4: Alice can now predict herself
      await registry.setValue(streamId1, 1200);
      const round4 = await satori.getCurrentRound();
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: streamId1, payload: pack1(1) }]);

      // Verify all predictions were recorded
      expect(await satori.predictedStreamsCount(bob.address, round1)).to.equal(1);
      expect(await satori.predictedStreamsCount(carol.address, round2)).to.equal(1);
      expect(await satori.predictedStreamsCount(alice.address, round4)).to.equal(1);
    });

    it("Should track delegation history correctly", async function () {
      // Start undelegated
      expect((await rewards.predictionDelegateInfo(alice.address)).delegate).to.equal(ethers.ZeroAddress);

      // Delegate to Bob
      await satori.connect(alice).delegatePredictionPower(bob.address);
      expect((await rewards.predictionDelegateInfo(alice.address)).delegate).to.equal(bob.address);

      // Switch to Carol
      await satori.connect(alice).delegatePredictionPower(carol.address);
      expect((await rewards.predictionDelegateInfo(alice.address)).delegate).to.equal(carol.address);

      // "Self-delegate" — normalized to address(0) (= undelegated).
      await satori.connect(alice).delegatePredictionPower(alice.address);
      expect((await rewards.predictionDelegateInfo(alice.address)).delegate).to.equal(ethers.ZeroAddress);

      // Already undelegated; calling delegate(0) again is a same-round no-op
      // gated by the lock from the previous call. Skip — storage already at
      // the canonical undelegated state.
    });
  });

  describe("Concurrent Delegations and Predictions", function () {
    it("Should handle multiple users delegating to same target", async function () {
      // Multiple users delegate to Alice
      await satori.connect(bob).delegatePredictionPower(alice.address);
      await satori.connect(carol).delegatePredictionPower(alice.address);
      await satori.connect(dave).delegatePredictionPower(alice.address);

      // Alice has combined power
      const alicePower = await rewards.getPredictionPower(alice.address);
      // Alice: 100 + 150 + 200 + 50 = 500
      expect(alicePower).to.equal(ethers.parseEther("500"));

      // Alice predicts with combined power
      await registry.setValue(streamId1, 1000);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: streamId1, payload: pack1(1) }]);

      // Now no one else can predict
      await expect(
        satori.connect(bob).predictMultipleWithPayloads([{ gameId: streamId1, payload: pack1(1) }])
      ).to.be.revertedWithCustomError(satori, "Delegated");
      await expect(
        satori.connect(carol).predictMultipleWithPayloads([{ gameId: streamId1, payload: pack1(1) }])
      ).to.be.revertedWithCustomError(satori, "Delegated");
    });

    it("Should handle delegation removal when delegate switches", async function () {
      // Bob and Carol delegate to Alice
      await satori.connect(bob).delegatePredictionPower(alice.address);
      await satori.connect(carol).delegatePredictionPower(alice.address);

      // Alice has 100 + 150 + 200 = 450
      expect(await rewards.getPredictionPower(alice.address)).to.equal(ethers.parseEther("450"));

      // Bob switches to Dave
      await satori.connect(bob).delegatePredictionPower(dave.address);

      // Alice now has 100 + 200 = 300
      expect(await rewards.getPredictionPower(alice.address)).to.equal(ethers.parseEther("300"));

      // Dave has 50 + 150 = 200
      expect(await rewards.getPredictionPower(dave.address)).to.equal(ethers.parseEther("200"));

      // Carol undelegates
      await satori.connect(carol).delegatePredictionPower(ethers.ZeroAddress);

      // Alice now has only her own 100
      expect(await rewards.getPredictionPower(alice.address)).to.equal(ethers.parseEther("100"));

      // Carol is locked but has her power back
      expect(await rewards.getPredictionPower(carol.address)).to.equal(ethers.parseEther("200"));
    });
  });

  describe("Error Cases and Validation", function () {
    it("Should revert on invalid delegation attempts", async function () {
      // Alice predicts
      await registry.setValue(streamId1, 1000);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: streamId1, payload: pack1(1) }]);

      // Alice cannot delegate to anyone
      await expect(
        satori.connect(alice).delegatePredictionPower(bob.address)
      ).to.be.revertedWithCustomError(satori, "Locked");

      // Alice cannot self-delegate
      await expect(
        satori.connect(alice).delegatePredictionPower(alice.address)
      ).to.be.revertedWithCustomError(satori, "Locked");

      // Alice cannot undelegate when not delegated and locked
      // (trying to delegate to address(0) when already at address(0) and locked)
      await expect(
        satori.connect(alice).delegatePredictionPower(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(satori, "Locked");
    });

    it("Should handle delegation to zero balance users", async function () {
      // Deploy new user with no balance
      const [, , , , , , newUser] = await ethers.getSigners();

      // Alice delegates to new user (who has 0 balance)
      await satori.connect(alice).delegatePredictionPower(newUser.address);

      // New user has Alice's power
      expect(await rewards.getPredictionPower(newUser.address)).to.equal(ethers.parseEther("100"));

      // New user can predict with Alice's power
      await registry.setValue(streamId1, 1000);
      await satori.connect(newUser).predictMultipleWithPayloads([{ gameId: streamId1, payload: pack1(1) }]);

      // Alice cannot predict
      await expect(
        satori.connect(alice).predictMultipleWithPayloads([{ gameId: streamId1, payload: pack1(1) }])
      ).to.be.revertedWithCustomError(satori, "Delegated");
    });
  });

  describe("Self-Delegation Normalizes to Undelegated", function () {
    it("Self-delegation produces same lock state as undelegating via address(0)", async function () {
      const currentDate = await satori.getCurrentRound();

      // Alice "self-delegates" — normalized to address(0).
      await satori.connect(alice).delegatePredictionPower(alice.address);

      // Storage is at the canonical undelegated value.
      expect((await rewards.predictionDelegateInfo(alice.address)).delegate).to.equal(ethers.ZeroAddress);

      // Lock matches the undelegate path (next-round, not max).
      expect(await satori.lockedUntil(alice.address)).to.equal(currentDate + 1n);

      // Alice can predict next round.
      await time.increase(86400);
      await registry.setValue(streamId1, 1000);
      await expect(satori.connect(alice).predictMultipleWithPayloads([{ gameId: streamId1, payload: pack1(1) }]))
        .to.not.be.reverted;
    });

    it("Should allow receiving delegations after a self-delegate-normalized call", async function () {
      // Alice "self-delegates" (= undelegate normalized)
      await satori.connect(alice).delegatePredictionPower(alice.address);

      // Bob can still delegate to Alice
      await satori.connect(bob).delegatePredictionPower(alice.address);

      // Alice has combined power
      expect(await rewards.getPredictionPower(alice.address)).to.equal(ethers.parseEther("250"));

      // Same-round predict blocked by next-round lock.
      await registry.setValue(streamId1, 1000);
      await expect(
        satori.connect(alice).predictMultipleWithPayloads([{ gameId: streamId1, payload: pack1(1) }])
      ).to.be.revertedWithCustomError(satori, "Locked");
    });

    it("After self-delegate-normalize, must wait one round before re-delegating", async function () {
      // Alice "self-delegates" — sets next-round lock.
      await satori.connect(alice).delegatePredictionPower(alice.address);

      // Same-round re-delegate blocked by lock.
      await expect(
        satori.connect(alice).delegatePredictionPower(bob.address)
      ).to.be.revertedWithCustomError(satori, "Locked");

      // Next round, lock has expired.
      await time.increase(86400);
      await satori.connect(alice).delegatePredictionPower(bob.address);
      expect((await rewards.predictionDelegateInfo(alice.address)).delegate).to.equal(bob.address);

      // Bob has Alice's power
      expect(await rewards.getPredictionPower(bob.address)).to.equal(ethers.parseEther("250"));

      // Bob can predict
      await registry.setValue(streamId1, 1000);
      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: streamId1, payload: pack1(1) }]);
    });
  });

  describe("Multiple Streams and Predictions", function () {
    it("Should handle predictions on multiple streams with delegation", async function () {
      // Setup delegation
      await satori.connect(alice).delegatePredictionPower(bob.address);
      await satori.connect(carol).delegatePredictionPower(bob.address);

      // Bob has combined power
      expect(await rewards.getPredictionPower(bob.address)).to.equal(ethers.parseEther("450"));

      // Bob can only predict once per round (on one stream)
      await registry.setValue(streamId1, 1000);
      await registry.setValue(streamId2, 2000);
      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: streamId1, payload: pack1(1) }]); // UP

      // Bob cannot predict on second stream (already predicted this round)
      await expect(
        satori.connect(bob).predictMultipleWithPayloads([{ gameId: streamId2, payload: pack1(2) }])
      ).to.be.revertedWithCustomError(satori, "AlreadyPredicted");

      // Verify only one prediction was recorded
      const currentRound = await satori.getCurrentRound();
      expect(await satori.predictedStreamsCount(bob.address, currentRound)).to.equal(1);
    });

    it("Should prevent switching after multi-stream prediction", async function () {
      // Alice delegates to Bob
      await satori.connect(alice).delegatePredictionPower(bob.address);

      // Bob predicts on stream 1
      await registry.setValue(streamId1, 1000);
      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: streamId1, payload: pack1(1) }]);

      // Alice cannot switch (Bob has predicted)
      await expect(
        satori.connect(alice).delegatePredictionPower(carol.address)
      ).to.be.revertedWithCustomError(satori, "DelegateActive");

      // Bob cannot predict on another stream anyway (already predicted)
      await registry.setValue(streamId2, 2000);
      await expect(
        satori.connect(bob).predictMultipleWithPayloads([{ gameId: streamId2, payload: pack1(1) }])
      ).to.be.revertedWithCustomError(satori, "AlreadyPredicted");

      // Alice still cannot switch
      await expect(
        satori.connect(alice).delegatePredictionPower(carol.address)
      ).to.be.revertedWithCustomError(satori, "DelegateActive");
    });
  });

  describe("Undelegation Timing", function () {
    it("Should always allow undelegation regardless of delegate's actions", async function () {
      // Alice delegates to Bob
      await satori.connect(alice).delegatePredictionPower(bob.address);

      // Bob predicts
      await registry.setValue(streamId1, 1000);
      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: streamId1, payload: pack1(1) }]);

      // Alice can still undelegate (even though Bob predicted)
      const currentDate = await satori.getCurrentRound();
      await satori.connect(alice).delegatePredictionPower(ethers.ZeroAddress);

      // Verify undelegation
      expect((await rewards.predictionDelegateInfo(alice.address)).delegate).to.equal(ethers.ZeroAddress);

      // Alice is locked until next round
      expect(await satori.lockedUntil(alice.address)).to.equal(currentDate + 1n);
    });

    it("Should handle rapid delegation/undelegation cycles", async function () {
      // Delegate
      await satori.connect(alice).delegatePredictionPower(bob.address);
      expect((await rewards.predictionDelegateInfo(alice.address)).delegate).to.equal(bob.address);

      // Undelegate immediately
      const currentDate = await satori.getCurrentRound();
      await satori.connect(alice).delegatePredictionPower(ethers.ZeroAddress);
      expect((await rewards.predictionDelegateInfo(alice.address)).delegate).to.equal(ethers.ZeroAddress);

      // Alice is now locked until next round
      expect(await satori.lockedUntil(alice.address)).to.equal(currentDate + 1n);

      // Cannot re-delegate while locked
      await expect(
        satori.connect(alice).delegatePredictionPower(carol.address)
      ).to.be.revertedWithCustomError(satori, "Locked");

      // Advance round
      await time.increase(86400);

      // Now can delegate again
      await satori.connect(alice).delegatePredictionPower(carol.address);
      expect((await rewards.predictionDelegateInfo(alice.address)).delegate).to.equal(carol.address);
    });
  });

  describe("Gas Optimization Scenarios", function () {
    it("Should handle mass delegation efficiently", async function () {
      // All users delegate to Alice in one round
      const delegations = [
        satori.connect(bob).delegatePredictionPower(alice.address),
        satori.connect(carol).delegatePredictionPower(alice.address),
        satori.connect(dave).delegatePredictionPower(alice.address),
        satori.connect(eve).delegatePredictionPower(alice.address)
      ];

      await Promise.all(delegations);

      // Alice has everyone's power
      const alicePower = await rewards.getPredictionPower(alice.address);
      // 100 + 150 + 200 + 50 + 75 = 575
      expect(alicePower).to.equal(ethers.parseEther("575"));
    });

    it("Should handle mass undelegation efficiently", async function () {
      // Setup delegations
      await satori.connect(bob).delegatePredictionPower(alice.address);
      await satori.connect(carol).delegatePredictionPower(alice.address);
      await satori.connect(dave).delegatePredictionPower(alice.address);

      // Mass undelegate
      const currentDate = await satori.getCurrentRound();
      const undelegations = [
        satori.connect(bob).delegatePredictionPower(ethers.ZeroAddress),
        satori.connect(carol).delegatePredictionPower(ethers.ZeroAddress),
        satori.connect(dave).delegatePredictionPower(ethers.ZeroAddress)
      ];

      await Promise.all(undelegations);

      // Alice back to own power
      expect(await rewards.getPredictionPower(alice.address)).to.equal(ethers.parseEther("100"));

      // All are locked until next round
      expect(await satori.lockedUntil(bob.address)).to.equal(currentDate + 1n);
      expect(await satori.lockedUntil(carol.address)).to.equal(currentDate + 1n);
      expect(await satori.lockedUntil(dave.address)).to.equal(currentDate + 1n);
    });
  });
});