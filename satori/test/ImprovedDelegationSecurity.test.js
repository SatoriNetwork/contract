const { expect } = require("chai");
const { deploySatoriFixture, pack1, VOTE } = require("./fixtures");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("Improved Delegation Security", function () {
  let satori, rewards, bounties, owner, alice, bob, carol, registry;
  let streamId;

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
    const fix = await deploySatoriFixture();
    ({ satori, rewards, bounties, registry } = fix);
    owner = fix.owner;
    [, alice, bob, carol] = fix.signers;

    // Enable test mode and advance to round 1
    await time.increase(86400);

    // Distribute tokens
    await satori.transfer(alice.address, ethers.parseEther("100"));
    await satori.transfer(bob.address, ethers.parseEther("100"));
    await satori.transfer(carol.address, ethers.parseEther("100"));

    // Create a data stream
    const tx = await satori.createSimpleDataStream("Test Stream", owner.address);
    streamId = await getStreamIdFromTx(tx, registry);

    // Burn SATORI to weight streamId's game so predictions on it carry power.
    // Alice keeps 90 of her 100; voting no longer locks or moves her balance,
    // it destroys the 10 outright.
    await satori.connect(alice).vote(streamId, VOTE);
  });

  describe("Initial Delegation After Prediction", function () {
    it("Should BLOCK initial delegation after user has predicted", async function () {
      // Alice predicts first
      await registry.setValue(streamId, 1000);
      const currentDate = await satori.getCurrentRound();
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(1) }]);

      // Alice is locked from prediction
      const lockedUntil = await satori.lockedUntil(alice.address);
      expect(lockedUntil).to.equal(currentDate + 1n); // Locked until next round

      // Alice tries to delegate to Bob - SHOULD FAIL
      await expect(
        satori.connect(alice).delegatePredictionPower(bob.address)
      ).to.be.revertedWithCustomError(satori, "Locked");
    });
  });

  describe("Switching Delegates While Locked", function () {
    it("Should ALLOW switching delegates even when locked by delegation", async function () {
      // Alice delegates to Bob
      await satori.connect(alice).delegatePredictionPower(bob.address);

      // Alice is now locked until undelegation (max uint)
      const lockedUntil = await satori.lockedUntil(alice.address);
      expect(lockedUntil).to.equal(2n ** 24n - 1n);

      // But Alice CAN switch to Carol (Bob hasn't predicted yet)
      await satori.connect(alice).delegatePredictionPower(carol.address);

      // Verify switch succeeded
      expect((await rewards.predictionDelegateInfo(alice.address)).delegate).to.equal(carol.address);
    });

    it("Should BLOCK switching if current delegate has predicted", async function () {
      // Alice delegates to Bob
      await satori.connect(alice).delegatePredictionPower(bob.address);

      // Bob predicts with Alice's power
      await registry.setValue(streamId, 1000);
      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(1) }]);

      // Alice is locked by delegation (max uint)
      const lockedUntil = await satori.lockedUntil(alice.address);
      expect(lockedUntil).to.equal(2n ** 24n - 1n);

      // Alice tries to switch to Carol - SHOULD FAIL
      await expect(
        satori.connect(alice).delegatePredictionPower(carol.address)
      ).to.be.revertedWithCustomError(satori, "DelegateActive");

      // Verify Alice is still delegated to Bob
      expect((await rewards.predictionDelegateInfo(alice.address)).delegate).to.equal(bob.address);
    });

    it("Should allow switching after round changes", async function () {
      // Alice delegates to Bob
      await satori.connect(alice).delegatePredictionPower(bob.address);

      // Bob predicts in round 1
      await registry.setValue(streamId, 1000);
      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(1) }]);

      // Alice cannot switch in round 1
      await expect(
        satori.connect(alice).delegatePredictionPower(carol.address)
      ).to.be.revertedWithCustomError(satori, "DelegateActive");

      // Advance to round 2
      await time.increase(86400);

      // Now Alice CAN switch (new round, Bob hasn't predicted in round 2)
      await satori.connect(alice).delegatePredictionPower(carol.address);
      expect((await rewards.predictionDelegateInfo(alice.address)).delegate).to.equal(carol.address);
    });
  });

  describe("Complex Scenarios", function () {
    it("Should handle undelegation correctly", async function () {
      // Alice delegates to Bob
      await satori.connect(alice).delegatePredictionPower(bob.address);

      // Bob predicts
      await registry.setValue(streamId, 1000);
      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(1) }]);

      // Alice cannot switch to Carol
      await expect(
        satori.connect(alice).delegatePredictionPower(carol.address)
      ).to.be.revertedWithCustomError(satori, "DelegateActive");

      // But Alice CAN undelegate (delegate to address(0))
      const currentDate = await satori.getCurrentRound();
      await satori.connect(alice).delegatePredictionPower(ethers.ZeroAddress);

      // Alice is now locked until next round (from undelegation)
      const lockedUntil = await satori.lockedUntil(alice.address);
      expect(lockedUntil).to.equal(currentDate + 1n); // Round + 1

      // And Alice is no longer delegated
      expect((await rewards.predictionDelegateInfo(alice.address)).delegate).to.equal(ethers.ZeroAddress);
    });

    it("Should prevent double-use through initial delegation", async function () {
      // Alice predicts with her own power
      await registry.setValue(streamId, 1000);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(1) }]);

      const currentRound = await satori.getCurrentRound();

      // Alice cannot delegate to Bob (initial delegation blocked)
      await expect(
        satori.connect(alice).delegatePredictionPower(bob.address)
      ).to.be.revertedWithCustomError(satori, "Locked");

      // Bob can still predict with his own power
      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(1) }]);

      // Verify powers are separate
      expect(await satori.predictedStreamsCount(alice.address, currentRound)).to.equal(1);
      expect(await satori.predictedStreamsCount(bob.address, currentRound)).to.equal(1);
    });

    it("Should prevent double-use through switching", async function () {
      // Setup: Alice delegates to Bob
      await satori.connect(alice).delegatePredictionPower(bob.address);

      // Bob predicts with combined power
      await registry.setValue(streamId, 1000);
      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(1) }]);

      // Alice cannot switch to Carol (would be double-use)
      await expect(
        satori.connect(alice).delegatePredictionPower(carol.address)
      ).to.be.revertedWithCustomError(satori, "DelegateActive");

      // Carol cannot use Alice's power this round
      const carolPower = await rewards.getPredictionPower(carol.address);
      expect(carolPower).to.equal(ethers.parseEther("100")); // Only Carol's own
    });
  });
});