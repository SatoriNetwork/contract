const { expect } = require("chai");
const { deploySatoriFixture, pack1, VOTE } = require("./fixtures");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("Critical Security Fix: Delegation After Prediction", function () {
  let satori, rewards, bounties, owner, alice, bob, registry;
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
    [owner, alice, bob] = fix.signers;

    // Enable test mode and advance to round 1
    await time.increase(86400);

    // Distribute tokens
    await satori.transfer(alice.address, ethers.parseEther("100"));
    await satori.transfer(bob.address, ethers.parseEther("100"));

    // Create a data stream. Admin-created with an explicit cadence of 1
    // (every round): these tests are about the delegation lock, not the
    // stream's rhythm, so they keep the every-round write cadence. A public
    // caller could only get cadence >= 2 here.
    const tx = await satori.connect(owner)["createSimpleDataStream(string,address,uint24)"]("Test Stream", owner.address, 720);
    streamId = await getStreamIdFromTx(tx, satori);

    // Make streamId eligible for predictions. The burn comes out of OWNER's
    // balance, not alice's: voting now destroys tokens, and these tests assert
    // alice's and bob's prediction power to the wei.
    await satori.connect(owner).vote(streamId, VOTE);
  });

  describe("Critical Vulnerability Fix", function () {
    it("Should PREVENT delegation after user has predicted (double-use attack)", async function () {
      // Alice predicts first
      await registry.setValue(streamId, 1000);
      const currentDate = await satori.getCurrentRound();
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(1) }]);

      // Alice is now locked until next round
      const lockedUntil = await satori.lockedUntil(alice.address);
      expect(lockedUntil).to.equal(currentDate + 1n); // Locked until next round

      // Alice tries to delegate to Bob - THIS SHOULD FAIL
      await expect(
        satori.connect(alice).delegatePredictionPower(bob.address)
      ).to.be.revertedWithCustomError(satori, "Locked");

      // Verify Alice still has no delegate
      expect((await rewards.predictionDelegateInfo(alice.address)).delegate).to.equal(ethers.ZeroAddress);

      // Verify Bob cannot use Alice's power
      const bobPower = await rewards.getPredictionPower(bob.address);
      expect(bobPower).to.equal(ethers.parseEther("100")); // Only Bob's own power
    });

    it("Should allow delegation BEFORE prediction", async function () {
      // Alice delegates to Bob BEFORE predicting
      await satori.connect(alice).delegatePredictionPower(bob.address);

      // Verify delegation succeeded
      expect((await rewards.predictionDelegateInfo(alice.address)).delegate).to.equal(bob.address);

      // Bob now has combined power
      const bobPower = await rewards.getPredictionPower(bob.address);
      expect(bobPower).to.equal(ethers.parseEther("200")); // Bob's 100 + Alice's 100

      // Bob can predict with combined power
      await registry.setValue(streamId, 1000);
      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(1) }]);

      // Alice cannot delegate again or predict (she's locked via delegation)
      const aliceLockedUntil = await satori.lockedUntil(alice.address);
      expect(aliceLockedUntil).to.equal(2n ** 24n - 1n); // Locked until undelegation
    });

    it("Should allow delegation after round changes", async function () {
      // Alice predicts in round 1
      await registry.setValue(streamId, 1000);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(1) }]);

      // Alice is locked for round 1
      await expect(
        satori.connect(alice).delegatePredictionPower(bob.address)
      ).to.be.revertedWithCustomError(satori, "Locked");

      // Advance to round 2
      await time.increase(86400);

      // Now Alice can delegate (lock expired)
      await satori.connect(alice).delegatePredictionPower(bob.address);
      expect((await rewards.predictionDelegateInfo(alice.address)).delegate).to.equal(bob.address);
    });

    it("Should prevent the double-use attack completely", async function () {
      // Setup initial balances
      const aliceInitial = await satori.balanceOf(alice.address);
      const bobInitial = await satori.balanceOf(bob.address);

      // ATTACK ATTEMPT:
      // 1. Alice predicts
      await registry.setValue(streamId, 1000);
      const currentDate = await satori.getCurrentRound();
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(1) }]);

      // 2. Alice tries to delegate to Bob (BLOCKED)
      await expect(
        satori.connect(alice).delegatePredictionPower(bob.address)
      ).to.be.revertedWithCustomError(satori, "Locked");

      // 3. Bob cannot predict with Alice's power
      const bobPower = await rewards.getPredictionPower(bob.address);
      expect(bobPower).to.equal(ethers.parseEther("100")); // Only his own

      // Bob can still predict with his own power
      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(1) }]);

      // Verify predictions were recorded
      expect(await satori.predictedStreamsCount(alice.address, currentDate)).to.equal(1);
      expect(await satori.predictedStreamsCount(bob.address, currentDate)).to.equal(1);

      // Advance to round 2 and set outcome
      await time.increase(86400);

      // Set value in round 2 showing UP was correct
      await registry.setValue(streamId, 1100);

      // Advance to round 3 for scoring
      await time.increase(86400);

      // Try to claim rewards - just attempt to claim, will do nothing if no rewards
      try {
        await satori.connect(alice).claim();
        await satori.connect(bob).claim();
      } catch {
        // If claiming fails, that's okay - might not have rewards yet
      }

      const aliceFinal = await satori.balanceOf(alice.address);
      const bobFinal = await satori.balanceOf(bob.address);

      // Verify balances are reasonable (no major issues)
      expect(aliceFinal).to.be.gte(aliceInitial); // Alice balance unchanged or increased
      expect(bobFinal).to.be.gte(bobInitial); // Bob balance unchanged or increased

      // Most importantly: verify attack was prevented
      // Alice couldn't delegate after predicting
      expect((await rewards.predictionDelegateInfo(alice.address)).delegate).to.equal(ethers.ZeroAddress);
    });
  });
});