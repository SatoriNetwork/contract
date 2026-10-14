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
async function endRound(satori) {
  const currentTime = await time.latest();
  const nextMidnight = Math.floor(currentTime / 86400) * 86400 + 86400;
  await time.increaseTo(nextMidnight + 1);
  await time.increase(86400);
}

describe("LockedUntil Mechanism", function () {
  let satori, voting, rewards, bounties, registry;
  let owner, alice, bob, carol, voter;
  // UNIT = INITIAL_MINT/20. Setup gives alice=10U, bob=5U, carol=3U
  // (preserves original 400:200:120 ratio).
  let UNIT;
  let stream1;

  const UP = 1;
  const DOWN = 2;

  beforeEach(async function () {
    // `voter` exists only to pay for vote weight. Voting BURNS SATORI now, and
    // every balance assertion below is stated against alice/bob/carol's exact
    // UNIT multiples — so the burn is kept off all three.
    const _s = await ethers.getSigners();
    [owner, alice, bob, carol] = _s;
    voter = _s[6];

    const fix = await deploySatoriFixture();
    ;({ satori, voting, rewards, registry, bounties, owner } = fix);

    // Create a test stream. Every lock assertion here is stated in single
    // rounds ("locked until round + 1"), so the stream must be writable each
    // round: a 1440-minute (every-round) stream.
    const tx = await satori["createSimpleDataStream(string,address,uint24)"]("Test Stream", owner.address, 1440);
    stream1 = await getStreamIdFromTx(tx, satori);

    // Give actors tokens in 10:5:3 ratio derived from INITIAL_MINT.
    // UNIT = INITIAL_MINT/20 leaves headroom for stream-creation fees and the
    // dummy voters used in the batch-prediction test.
    const INITIAL_MINT = await satori.INITIAL_MINT();
    UNIT = INITIAL_MINT / 20n;
    await satori.transfer(alice.address, UNIT * 10n);
    await satori.transfer(bob.address, UNIT * 5n);
    await satori.transfer(carol.address, UNIT * 3n);

    // Burn for stream1 so predictions on it carry weight (40 SATORI funds this
    // vote plus the second one in the batch-prediction test below).
    await satori.transfer(voter.address, ethers.parseEther("40"));
    await satori.connect(voter).vote(stream1, VOTE);

    // Set initial value
    await registry.setValue(stream1, 100);
  });

  describe("Basic Locking After Prediction", function () {
        it("Should lock balance until next round after prediction", async function () {
      // Alice predicts
      const currentRound = await satori.getCurrentRound();
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // Check locked until currentRound + 1
      const lockedUntil = await satori.lockedUntil(alice.address);
      expect(lockedUntil).to.equal(currentRound + 1n);

      // Should fail to transfer in same round
      await expect(
        satori.connect(alice).transfer(bob.address, 100)
      ).to.be.revertedWithCustomError(satori, "Locked");

      // End round
      await endRound(satori);

      // Should succeed to transfer in next round
      await satori.connect(alice).transfer(bob.address, 100);
      expect(await satori.balanceOf(bob.address)).to.be.gt(UNIT * 5n);
    });

    it("Should prevent predictions when balance is locked", async function () {
      // Alice predicts
      const currentRound = await satori.getCurrentRound();
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // Check locked until currentRound + 1
      const lockedUntil = await satori.lockedUntil(alice.address);
      expect(lockedUntil).to.equal(currentRound + 1n);

      // Should fail to predict again in same round. Post-collapse the
      // one-batch-per-round lock (AlreadyPredicted) fires before the per-
      // entry DuplicatePrediction check — both errors mean "you can't
      // predict twice this round" but the unified path uses the broader
      // error code.
      await expect(
        satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(DOWN) }])
      ).to.be.revertedWithCustomError(satori, "AlreadyPredicted");
    });

    it("Should allow predictions in new round after unlock", async function () {
      // Alice predicts
      const currentRound = await satori.getCurrentRound();
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // Locked until currentRound + 1
      let lockedUntil = await satori.lockedUntil(alice.address);
      expect(lockedUntil).to.equal(currentRound + 1n);

      // End round to round 1
      await endRound(satori);
      await registry.setValue(stream1, 150);

      // Should succeed to predict in round 1
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(DOWN) }]);

      // Now locked until next round + 1
      const newRound = await satori.getCurrentRound();
      lockedUntil = await satori.lockedUntil(alice.address);
      expect(lockedUntil).to.equal(newRound + 1n);
    });
  });

  describe("Delegation Locks Indefinitely", function () {
    it("Should lock balance indefinitely when delegated", async function () {
      // Alice delegates to Bob
      await satori.connect(alice).delegatePredictionPower(bob.address);

      // Check locked to max value
      const lockedUntil = await satori.lockedUntil(alice.address);
      expect(lockedUntil).to.equal(2n ** 24n - 1n);

      // Should fail to transfer (with delegation-specific error)
      await expect(
        satori.connect(alice).transfer(carol.address, 100)
      ).to.be.revertedWithCustomError(satori, "Locked");

      // Should fail to predict
      await expect(
        satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }])
      ).to.be.revertedWithCustomError(satori, "Delegated");
    });

    it("Should remain locked after round changes when delegated", async function () {
      // Alice delegates to Bob
      await satori.connect(alice).delegatePredictionPower(bob.address);

      // Check locked to max
      let lockedUntil = await satori.lockedUntil(alice.address);
      expect(lockedUntil).to.equal(2n ** 24n - 1n);

      // End round
      await endRound(satori);

      // Still locked to max
      lockedUntil = await satori.lockedUntil(alice.address);
      expect(lockedUntil).to.equal(2n ** 24n - 1n);

      // Should still fail to transfer (with delegation-specific error)
      await expect(
        satori.connect(alice).transfer(carol.address, 100)
      ).to.be.revertedWithCustomError(satori, "Locked");
    });
  });

  describe("Undelegation Unlocks After Next Round", function () {
    it("Should unlock after next round when undelegated", async function () {
      // Delegate in round 0
      await satori.connect(alice).delegatePredictionPower(bob.address);

      // Verify locked to max
      let lockedUntil = await satori.lockedUntil(alice.address);
      expect(lockedUntil).to.equal(2n ** 24n - 1n);

      // Undelegate in round 1 (using ZeroAddress for undelegation)
      const currentRound = await satori.getCurrentRound();
      await satori.connect(alice).delegatePredictionPower(ethers.ZeroAddress);

      // Check locked until round 1
      lockedUntil = await satori.lockedUntil(alice.address);
      expect(lockedUntil).to.equal(currentRound + 1n);

      // Should fail to transfer in round 0
      await expect(
        satori.connect(alice).transfer(carol.address, 100)
      ).to.be.revertedWithCustomError(satori, "Locked");

      // End round to round 1
      await endRound(satori);

      // Should succeed in round 1
      await satori.connect(alice).transfer(carol.address, 100);
      expect(await satori.balanceOf(carol.address)).to.be.gt(UNIT * 3n);
    });

    it("Should allow prediction after undelegation lock expires", async function () {
      // Delegate
      await satori.connect(alice).delegatePredictionPower(bob.address);

      // Undelegate
      const currentRound = await satori.getCurrentRound();
      await satori.connect(alice).delegatePredictionPower(ethers.ZeroAddress);

      // Check locked until currentRound + 1
      let lockedUntil = await satori.lockedUntil(alice.address);
      expect(lockedUntil).to.equal(currentRound + 1n);

      // Should fail to predict in same round
      await expect(
        satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }])
      ).to.be.revertedWithCustomError(satori, "Locked");

      // End round
      await endRound(satori);
      await registry.setValue(stream1, 150);

      // Should succeed to predict in next round
      const newRound = await satori.getCurrentRound();
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // Now locked until newRound + 1 (from prediction)
      lockedUntil = await satori.lockedUntil(alice.address);
      expect(lockedUntil).to.equal(newRound + 1n);
    });
  });

  describe("Edge Cases", function () {
    it("Should handle changing delegation between users", async function () {
      // Delegate to Bob
      await satori.connect(alice).delegatePredictionPower(bob.address);
      let lockedUntil = await satori.lockedUntil(alice.address);
      expect(lockedUntil).to.equal(2n ** 24n - 1n);

      // Change delegation to Carol (still delegated, so still locked to max)
      await satori.connect(alice).delegatePredictionPower(carol.address);
      lockedUntil = await satori.lockedUntil(alice.address);
      expect(lockedUntil).to.equal(2n ** 24n - 1n);

      // Undelegate
      const currentRound = await satori.getCurrentRound();
      await satori.connect(alice).delegatePredictionPower(ethers.ZeroAddress);
      lockedUntil = await satori.lockedUntil(alice.address);
      expect(lockedUntil).to.equal(currentRound + 1n);

      // End round to unlock
      await endRound(satori);

      // Now Alice can operate freely
      await satori.connect(alice).transfer(bob.address, 100);
    });

    it("Should handle prediction after delegation lock expires", async function () {
      // Alice delegates to Bob
      await satori.connect(alice).delegatePredictionPower(bob.address);

      // Alice undelegates
      await satori.connect(alice).delegatePredictionPower(ethers.ZeroAddress);

      // End round
      await endRound(satori);
      await registry.setValue(stream1, 150);

      // Alice predicts
      const round1 = await satori.getCurrentRound();
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      let lockedUntil = await satori.lockedUntil(alice.address);
      expect(lockedUntil).to.equal(round1 + 1n);

      // End round
      await endRound(satori);
      await registry.setValue(stream1, 200);

      // Alice can predict again
      const round2 = await satori.getCurrentRound();
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(DOWN) }]);

      lockedUntil = await satori.lockedUntil(alice.address);
      expect(lockedUntil).to.equal(round2 + 1n);
    });

    it("Should not lock users who haven't predicted or delegated", async function () {
      // Carol has tokens but hasn't predicted or delegated
      const lockedUntil = await satori.lockedUntil(carol.address);
      expect(lockedUntil).to.equal(0);

      // Should be able to transfer
      await satori.connect(carol).transfer(alice.address, 100);
      expect(await satori.balanceOf(alice.address)).to.be.gt(UNIT * 10n);

      // Should be able to predict
      const currentRound = await satori.getCurrentRound();
      await satori.connect(carol).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);
      expect((await satori.predictions(carol.address, stream1, currentRound)).direction).to.equal(UP);
    });

    it("Should handle zero balance users", async function () {
      // Transfer all of Carol's balance away
      const carolBalance = await satori.balanceOf(carol.address);
      await satori.connect(carol).transfer(alice.address, carolBalance);

      // Carol has 0 balance
      expect(await satori.balanceOf(carol.address)).to.equal(0);

      // LockedUntil should still be 0
      const lockedUntil = await satori.lockedUntil(carol.address);
      expect(lockedUntil).to.equal(0);

      // Carol can delegate (even with 0 balance)
      await satori.connect(carol).delegatePredictionPower(bob.address);

      // Now locked to max
      const lockedUntilAfter = await satori.lockedUntil(carol.address);
      expect(lockedUntilAfter).to.equal(2n ** 24n - 1n);
    });
  });

  describe("Batch Predictions", function () {
    it("Should lock balance when making batch predictions", async function () {
      // Create another stream
      const tx = await satori["createSimpleDataStream(string,address,uint24)"]("Stream 2", owner.address, 1440);
      const stream2 = await getStreamIdFromTx(tx, satori);
      await registry.setValue(stream2, 200);

      // Weight stream2 as well. There is no eligibility threshold any more —
      // every enabled game with weight > 0 earns — so the two "Dummy" streams
      // that existed purely to dilute the old 50% bar, and the balance
      // shuffling that funded their voters, are gone. One burn per real stream
      // is the whole setup.
      await satori.connect(voter).vote(stream2, VOTE);

      // Alice makes batch prediction
      const currentRound = await satori.getCurrentRound();
      await satori.connect(alice).predictMultipleWithPayloads([
        { gameId: stream1, payload: pack1(UP) },
        { gameId: stream2, payload: pack1(DOWN) }
      ]);

      // Check locked until currentRound + 1
      const lockedUntil = await satori.lockedUntil(alice.address);
      expect(lockedUntil).to.equal(currentRound + 1n);

      // Should fail to transfer
      await expect(
        satori.connect(alice).transfer(bob.address, 100)
      ).to.be.revertedWithCustomError(satori, "Locked");

      // End round
      await endRound(satori);

      // Should succeed to transfer
      await satori.connect(alice).transfer(bob.address, 100);
    });
  });
});
