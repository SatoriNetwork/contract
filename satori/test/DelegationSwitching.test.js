const { expect } = require("chai");
const { deploySatoriFixture, pack1, VOTE } = require("./fixtures");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("Delegation Switching", function () {
  let satori, rewards, bounties, owner, alice, bob, carol, dave, registry;
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
    [owner, alice, bob, carol, dave] = await ethers.getSigners();

    const fix = await deploySatoriFixture();
    ({ satori, rewards, registry, bounties } = fix);

    // Advance to round 1 first
    await time.increase(86400);

    // Distribute tokens
    await satori.transfer(alice.address, ethers.parseEther("100"));
    await satori.transfer(bob.address, ethers.parseEther("100"));
    await satori.transfer(carol.address, ethers.parseEther("100"));
    await satori.transfer(dave.address, ethers.parseEther("100"));

    // Create a data stream at 1440 minutes (every round) — the subject here
    // is delegation switching across round boundaries, not the stream's write
    // rhythm, so the rounds stay one apart.
    const tx = await satori.connect(owner)["createSimpleDataStream(string,address,uint24)"]("Test Stream", owner.address, 1440);
    streamId = await getStreamIdFromTx(tx, satori);

    // Make streamId eligible for predictions. OWNER pays the burn: voting
    // destroys tokens now, alice/bob/carol are delegating and predicting
    // throughout, and the power assertions below are exact. One burn is enough
    // for every round — weight is permanent.
    await satori.connect(owner).vote(streamId, VOTE);
  });

  describe("Direct Switching Without Predictions", function () {
    it("Should allow direct switching when neither delegate has predicted", async function () {
      // Alice delegates to Bob
      await satori.connect(alice).delegatePredictionPower(bob.address);
      expect((await rewards.predictionDelegateInfo(alice.address)).delegate).to.equal(bob.address);

      // Alice switches directly to Carol (no undelegation needed)
      await satori.connect(alice).delegatePredictionPower(carol.address);
      expect((await rewards.predictionDelegateInfo(alice.address)).delegate).to.equal(carol.address);

      // Verify Carol can predict with Alice's power
      const carolPower = await rewards.getPredictionPower(carol.address);
      expect(carolPower).to.equal(ethers.parseEther("200")); // Carol's 100 + Alice's 100

      // Carol predicts
      await registry.setValue(streamId, 100);
      const currentRound = await satori.getCurrentRound();
      await satori.connect(carol).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(1) }]);

      // Verify prediction was made
      expect(await satori.predictedStreamsCount(carol.address, currentRound)).to.equal(1);
    });

    it("Should allow multiple switches in the same round if no predictions", async function () {
      // Alice delegates to Bob
      await satori.connect(alice).delegatePredictionPower(bob.address);

      // Alice switches to Carol
      await satori.connect(alice).delegatePredictionPower(carol.address);

      // Alice switches to Dave
      await satori.connect(alice).delegatePredictionPower(dave.address);

      // Alice switches back to Bob
      await satori.connect(alice).delegatePredictionPower(bob.address);

      expect((await rewards.predictionDelegateInfo(alice.address)).delegate).to.equal(bob.address);
    });
  });

  describe("Security Check 1: Prevent switching FROM delegate who predicted", function () {
    it("Should block switching from delegate who already predicted", async function () {
      // Alice delegates to Bob
      await satori.connect(alice).delegatePredictionPower(bob.address);

      // Bob predicts using Alice's power
      await registry.setValue(streamId, 1000);
      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(1) }]);

      // Alice tries to switch to Carol - should fail
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

      // Advance to round 2
      await time.increase(86400);

      // Now Alice can switch to Carol
      await satori.connect(alice).delegatePredictionPower(carol.address);
      expect((await rewards.predictionDelegateInfo(alice.address)).delegate).to.equal(carol.address);

      // Carol can predict with Alice's power
      await registry.setValue(streamId, 2000);
      const currentRound = await satori.getCurrentRound();
      await satori.connect(carol).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(1) }]);
      expect(await satori.predictedStreamsCount(carol.address, currentRound)).to.equal(1);
    });
  });

  describe("Security Check 2: Prevent switching TO delegate who predicted", function () {
    it("Should allow switching to delegate who already predicted (no protection)", async function () {
      // Carol predicts with her own power first
      await registry.setValue(streamId, 1000);
      await satori.connect(carol).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(1) }]);

      // Alice can delegate to Carol even though Carol already predicted
      // (The system only checks if current delegate predicted, not new delegate)
      await satori.connect(alice).delegatePredictionPower(carol.address);

      // Verify Alice is now delegated to Carol
      expect((await rewards.predictionDelegateInfo(alice.address)).delegate).to.equal(carol.address);
    });

    it("Should allow switching from one delegate to another who predicted", async function () {
      // Alice delegates to Bob
      await satori.connect(alice).delegatePredictionPower(bob.address);

      // Carol predicts with her own power
      await registry.setValue(streamId, 1000);
      await satori.connect(carol).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(1) }]);

      // Alice can switch from Bob to Carol even though Carol predicted
      // (Only checks if Bob predicted, not Carol)
      await satori.connect(alice).delegatePredictionPower(carol.address);

      // Verify Alice is now delegated to Carol
      expect((await rewards.predictionDelegateInfo(alice.address)).delegate).to.equal(carol.address);
    });
  });

  describe("Both Security Checks Together", function () {
    it("Should block if current delegate predicted", async function () {
      // Setup: Alice → Bob, Dave → Carol
      await satori.connect(alice).delegatePredictionPower(bob.address);
      await satori.connect(dave).delegatePredictionPower(carol.address);

      // Bob predicts
      await registry.setValue(streamId, 1000);
      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(1) }]);

      // Alice cannot switch to anyone, even unpredicted delegates
      await expect(
        satori.connect(alice).delegatePredictionPower(owner.address)
      ).to.be.revertedWithCustomError(satori, "DelegateActive");
    });

    it("Should allow switching even if new delegate predicted", async function () {
      // Setup: Alice → Bob, Dave → Carol
      await satori.connect(alice).delegatePredictionPower(bob.address);
      await satori.connect(dave).delegatePredictionPower(carol.address);

      // Carol predicts
      await registry.setValue(streamId, 1000);
      await satori.connect(carol).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(1) }]);

      // Alice CAN switch to Carol (no check for new delegate)
      await satori.connect(alice).delegatePredictionPower(carol.address);
      expect((await rewards.predictionDelegateInfo(alice.address)).delegate).to.equal(carol.address);
    });

    it("Should prevent double-use attack completely", async function () {
      // Alice delegates to Bob
      await satori.connect(alice).delegatePredictionPower(bob.address);

      // Bob predicts using Alice's power
      await registry.setValue(streamId, 1000);
      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(1) }]);

      // Alice cannot switch to Carol (Check 1 blocks this)
      await expect(
        satori.connect(alice).delegatePredictionPower(carol.address)
      ).to.be.revertedWithCustomError(satori, "DelegateActive");

      // In the next round, Carol predicts with own power
      await time.increase(86400);
      await registry.setValue(streamId, 2000);
      await satori.connect(carol).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(1) }]);

      // Dave CAN delegate to Carol (no check for new delegate having predicted)
      await satori.connect(dave).delegatePredictionPower(carol.address);
      expect((await rewards.predictionDelegateInfo(dave.address)).delegate).to.equal(carol.address);
    });
  });

  describe("Reward Distribution After Switching", function () {
    it("Should distribute rewards based on delegation at prediction time", async function () {
      // Round 1: Alice delegates to Bob
      await satori.connect(alice).delegatePredictionPower(bob.address);

      // Bob predicts
      await registry.setValue(streamId, 1000);
      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(1) }]);

      // Score the prediction at end of round (value B)
      await time.increase(86400);
      await registry.setValue(streamId, 1100); // UP was correct, value B

      // Round 2: Alice switches to Carol (allowed now)
      await satori.connect(alice).delegatePredictionPower(carol.address);

      // Carol predicts
      await satori.connect(carol).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(1) }]);

      // End round 2 (value C for Bob's round 1 prediction)
      await time.increase(86400);
      await registry.setValue(streamId, 1200); // UP was correct, value C for Bob

      // Round 3: Trigger scoring by having participants predict again
      await time.increase(86400);
      await registry.setValue(streamId, 1300);
      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(1) }]); // Triggers scoring for Bob's round 1 prediction
      await satori.connect(carol).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(1) }]); // Triggers scoring for Carol's round 2 prediction

      // Advance rounds to accumulate rewards
      await time.increase(86400);
      await time.increase(86400);
      await time.increase(86400);

      // Bob can claim rewards from round 1 (includes delegated portion)
      const bobBalanceBefore = await satori.balanceOf(bob.address);
      await satori.connect(bob).claim();
      const bobBalanceAfter = await satori.balanceOf(bob.address);
      expect(bobBalanceAfter).to.be.gt(bobBalanceBefore);

      // Carol can claim rewards from round 2 (includes Alice's delegated rewards)
      const carolBalanceBefore = await satori.balanceOf(carol.address);
      await satori.connect(carol).claim();
      const carolBalanceAfter = await satori.balanceOf(carol.address);
      expect(carolBalanceAfter).to.be.gt(carolBalanceBefore);
    });
  });

  describe("Edge Cases", function () {
    it("Should handle undelegation (self-delegation) correctly", async function () {
      // Alice delegates to Bob
      await satori.connect(alice).delegatePredictionPower(bob.address);

      // Bob predicts
      await registry.setValue(streamId, 1000);
      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(1) }]);

      // Alice cannot switch to anyone else this round
      await expect(
        satori.connect(alice).delegatePredictionPower(carol.address)
      ).to.be.revertedWithCustomError(satori, "DelegateActive");

      // But Alice CAN undelegate (delegate to address(0)) even if Bob predicted
      // This is safe because it doesn't allow double-use
      await satori.connect(alice).delegatePredictionPower(ethers.ZeroAddress);
      expect((await rewards.predictionDelegateInfo(alice.address)).delegate).to.equal(ethers.ZeroAddress);
    });

    it("Should handle zero balance delegation switching", async function () {
      // Create a new account with no tokens
      const [, , , , , newUser] = await ethers.getSigners();

      // New user delegates to Bob (even with 0 balance)
      await satori.connect(newUser).delegatePredictionPower(bob.address);

      // New user switches to Carol
      await satori.connect(newUser).delegatePredictionPower(carol.address);

      // No effect on power since balance is 0
      expect(await rewards.getPredictionPower(carol.address)).to.equal(ethers.parseEther("100"));
    });
  });
});