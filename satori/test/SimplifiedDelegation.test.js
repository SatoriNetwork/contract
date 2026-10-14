const { expect } = require("chai");
const { deploySatoriFixture, pack1, voteFor } = require("./fixtures");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("Simplified Delegation Model", function () {
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

    // Deploy the restructured Satori stack via the shared fixture.
    const fix = await deploySatoriFixture();
    ;({ satori, rewards, registry, bounties, owner } = fix);

    // Enable test mode and advance to round 1
    await time.increase(86400);

    // Distribute tokens
    await satori.transfer(alice.address, ethers.parseEther("100"));
    await satori.transfer(bob.address, ethers.parseEther("100"));
    await satori.transfer(carol.address, ethers.parseEther("100"));
    await satori.transfer(dave.address, ethers.parseEther("100"));

    // Create a data stream. Admin-created with an explicit cadence of 1 (every
    // round): the subject is the delegation state machine, and the rounds below
    // are delegation/lock windows rather than stream write windows.
    // A public caller may only create cadence >= 2.
    const tx = await satori.connect(owner)["createSimpleDataStream(string,address,uint24)"]("Test Stream", owner.address, 1440);
    streamId = await getStreamIdFromTx(tx, satori);

    // Give streamId weight so it earns. The OWNER burns, not alice: burning
    // destroys tokens, and the prediction-power assertions below depend on
    // alice/bob/carol/dave each keeping exactly 100.
    await voteFor(satori, owner, streamId);
  });

  describe("Simplified Delegation States", function () {
    it("Should start with address(0) as undelegated state", async function () {
      // Alice starts undelegated (address(0))
      expect((await rewards.predictionDelegateInfo(alice.address)).delegate).to.equal(ethers.ZeroAddress);
    });

    it("Self-delegation input normalizes to address(0) in storage", async function () {
      // Alice can delegate to Bob — stored verbatim.
      await satori.connect(alice).delegatePredictionPower(bob.address);
      expect((await rewards.predictionDelegateInfo(alice.address)).delegate).to.equal(bob.address);

      // Bob "self-delegates" — normalized to address(0). Storage holds two
      // states only: address(0) (undelegated) or some-other-address.
      await satori.connect(bob).delegatePredictionPower(bob.address);
      expect((await rewards.predictionDelegateInfo(bob.address)).delegate).to.equal(ethers.ZeroAddress);

      // Carol can delegate to Dave
      await satori.connect(carol).delegatePredictionPower(dave.address);
      expect((await rewards.predictionDelegateInfo(carol.address)).delegate).to.equal(dave.address);
    });

    it("Should use address(0) for undelegation (not self-address)", async function () {
      // Alice delegates to Bob
      await satori.connect(alice).delegatePredictionPower(bob.address);
      expect((await rewards.predictionDelegateInfo(alice.address)).delegate).to.equal(bob.address);

      // Alice undelegates by delegating to address(0)
      const currentRound = await satori.getCurrentRound();
      await satori.connect(alice).delegatePredictionPower(ethers.ZeroAddress);
      expect((await rewards.predictionDelegateInfo(alice.address)).delegate).to.equal(ethers.ZeroAddress);

      // Alice is locked from prediction until next round after undelegation
      const lockedUntil = await satori.lockedUntil(alice.address);
      expect(lockedUntil).to.equal(currentRound + 1n); // Locked until next round
    });
  });

  describe("Self-Delegation Normalizes to Undelegated", function () {
    it("Self-delegation behaves identically to undelegating via address(0)", async function () {
      const currentRound = await satori.getCurrentRound();

      // Alice "self-delegates" — normalized to address(0).
      await satori.connect(alice).delegatePredictionPower(alice.address);

      // Storage matches address(0)-undelegate.
      expect((await rewards.predictionDelegateInfo(alice.address)).delegate).to.equal(ethers.ZeroAddress);

      // Lock matches address(0)-undelegate (next-round, not max).
      const lockedUntil = await satori.lockedUntil(alice.address);
      expect(lockedUntil).to.equal(currentRound + 1n);
    });

    it("Self-delegated input does not block predicting next round", async function () {
      // Setup: Bob delegates to Alice, then Alice "self-delegates" (= undelegate).
      await satori.connect(bob).delegatePredictionPower(alice.address);
      await satori.connect(alice).delegatePredictionPower(alice.address);

      // Alice still sees her own + delegated power (storage normalized to 0).
      const alicePower = await rewards.getPredictionPower(alice.address);
      expect(alicePower).to.equal(ethers.parseEther("200"));

      // Same-round predict is blocked by the next-round lock — but with the
      // "Locked" message, NOT "Delegated".
      await registry.setValue(streamId, 1000);
      await expect(
        satori.connect(alice).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(1) }])
      ).to.be.revertedWithCustomError(satori, "Locked");

      // Next round, the lock has expired and predict goes through.
      await time.increase(86400);
      await registry.setValue(streamId, 1100);
      await expect(satori.connect(alice).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(1) }]))
        .to.not.be.reverted;
    });
  });

  describe("Security Checks with Simplified Model", function () {
    it("Should prevent initial delegation after prediction", async function () {
      // Alice predicts first
      const currentRound = await satori.getCurrentRound();
      await registry.setValue(streamId, 1000);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(1) }]);

      // Alice is locked from prediction until next round
      const lockedUntil = await satori.lockedUntil(alice.address);
      expect(lockedUntil).to.equal(currentRound + 1n); // Locked until next round

      // Alice cannot delegate to Bob (or anyone)
      await expect(
        satori.connect(alice).delegatePredictionPower(bob.address)
      ).to.be.revertedWithCustomError(satori, "Locked");
    });

    it("Should prevent switching FROM delegate who predicted", async function () {
      // Alice delegates to Bob
      await satori.connect(alice).delegatePredictionPower(bob.address);

      // Bob predicts with Alice's power
      await registry.setValue(streamId, 1000);
      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(1) }]);

      // Alice cannot switch to Carol
      await expect(
        satori.connect(alice).delegatePredictionPower(carol.address)
      ).to.be.revertedWithCustomError(satori, "DelegateActive");

      // Alice CAN undelegate via self (normalized to address(0)) even when
      // current delegate predicted — the undelegate path skips the
      // "current delegate predicted" check (it's a non-attack action).
      await satori.connect(alice).delegatePredictionPower(alice.address);
      expect((await rewards.predictionDelegateInfo(alice.address)).delegate).to.equal(ethers.ZeroAddress);
    });

    it("Should always allow undelegation via address(0)", async function () {
      // Alice delegates to Bob
      await satori.connect(alice).delegatePredictionPower(bob.address);

      // Bob predicts with Alice's power
      const currentRound = await satori.getCurrentRound();
      await registry.setValue(streamId, 1000);
      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(1) }]);

      // Alice can still undelegate (to address(0))
      await satori.connect(alice).delegatePredictionPower(ethers.ZeroAddress);

      // Verify undelegation succeeded
      expect((await rewards.predictionDelegateInfo(alice.address)).delegate).to.equal(ethers.ZeroAddress);

      // Alice is locked from prediction until next round
      const lockedUntil = await satori.lockedUntil(alice.address);
      expect(lockedUntil).to.equal(currentRound + 1n); // Locked until next round
    });

    it("Should allow switching if current delegate hasn't predicted", async function () {
      // Alice delegates to Bob
      await satori.connect(alice).delegatePredictionPower(bob.address);

      // Bob hasn't predicted yet, so Alice can switch to Carol
      await satori.connect(alice).delegatePredictionPower(carol.address);
      expect((await rewards.predictionDelegateInfo(alice.address)).delegate).to.equal(carol.address);

      // Alice "self-delegates" — normalized to address(0). Same as undelegating.
      await satori.connect(alice).delegatePredictionPower(alice.address);
      expect((await rewards.predictionDelegateInfo(alice.address)).delegate).to.equal(ethers.ZeroAddress);

      // She is now locked-until-next-round (undelegate side-effect). Advance
      // past the lock before re-delegating.
      await time.increase(86400);

      // Alice can re-delegate to Bob next round.
      await satori.connect(alice).delegatePredictionPower(bob.address);
      expect((await rewards.predictionDelegateInfo(alice.address)).delegate).to.equal(bob.address);
    });
  });

  describe("Complex Scenarios", function () {
    it("Should handle chain of delegation changes correctly", async function () {
      // Round 1: Alice delegates to Bob
      await satori.connect(alice).delegatePredictionPower(bob.address);

      // Bob predicts
      await registry.setValue(streamId, 1000);
      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(1) }]);

      // Alice cannot switch to Carol
      await expect(
        satori.connect(alice).delegatePredictionPower(carol.address)
      ).to.be.revertedWithCustomError(satori, "DelegateActive");

      // Alice undelegates
      await satori.connect(alice).delegatePredictionPower(ethers.ZeroAddress);

      // Advance to round 2
      await time.increase(86400);

      // Alice can now delegate to Carol
      await satori.connect(alice).delegatePredictionPower(carol.address);
      expect((await rewards.predictionDelegateInfo(alice.address)).delegate).to.equal(carol.address);

      // Carol hasn't predicted, so Alice can "self-delegate" — which is
      // normalized to undelegate.
      await satori.connect(alice).delegatePredictionPower(alice.address);
      expect((await rewards.predictionDelegateInfo(alice.address)).delegate).to.equal(ethers.ZeroAddress);

      // Same-round predict still blocked by the next-round lock.
      await registry.setValue(streamId, 1100);
      await expect(
        satori.connect(alice).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(1) }])
      ).to.be.revertedWithCustomError(satori, "Locked");
    });

    it("Should correctly calculate power across self-delegation normalization", async function () {
      // Multiple users delegate to Alice
      await satori.connect(bob).delegatePredictionPower(alice.address);
      await satori.connect(carol).delegatePredictionPower(alice.address);

      // Alice "self-delegates" — normalized to address(0). She remains
      // undelegated; her storage doesn't change inbound accounting.
      await satori.connect(alice).delegatePredictionPower(alice.address);

      // Alice should have 300 total power (100 own + 100 Bob + 100 Carol)
      const alicePowerBefore = await rewards.getPredictionPower(alice.address);
      expect(alicePowerBefore).to.equal(ethers.parseEther("300"));

      // Now Dave delegates to Alice
      await satori.connect(dave).delegatePredictionPower(alice.address);
      const alicePowerAfter = await rewards.getPredictionPower(alice.address);
      expect(alicePowerAfter).to.equal(ethers.parseEther("400"));

      // Bob/Carol/Dave delegated away — they cannot predict.
      await registry.setValue(streamId, 1000);
      await expect(
        satori.connect(bob).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(1) }])
      ).to.be.revertedWithCustomError(satori, "Delegated");
      await expect(
        satori.connect(carol).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(1) }])
      ).to.be.revertedWithCustomError(satori, "Delegated");
      await expect(
        satori.connect(dave).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(1) }])
      ).to.be.revertedWithCustomError(satori, "Delegated");

      // Alice (normalized to undelegated) is locked same-round but can
      // predict next round.
      await time.increase(86400);
      await registry.setValue(streamId, 1100);
      await expect(satori.connect(alice).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(1) }]))
        .to.not.be.reverted;
    });

    it("Should prevent all forms of double-use attacks", async function () {
      // Attack 1: Predict then delegate - BLOCKED
      const dateAlice = await satori.getCurrentRound();
      await registry.setValue(streamId, 1000);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(1) }]);
      await expect(
        satori.connect(alice).delegatePredictionPower(bob.address)
      ).to.be.revertedWithCustomError(satori, "Locked");

      // Advance round
      await time.increase(86400);

      // Attack 2: Delegate, have delegate predict, switch - BLOCKED
      const dateBob = await satori.getCurrentRound();
      await satori.connect(alice).delegatePredictionPower(bob.address);
      await registry.setValue(streamId, 1100);
      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(1) }]);
      await expect(
        satori.connect(alice).delegatePredictionPower(carol.address)
      ).to.be.revertedWithCustomError(satori, "DelegateActive");

      // Attack 3: Self-delegate after prediction - BLOCKED
      await time.increase(86400);
      const dateCarol = await satori.getCurrentRound();
      await registry.setValue(streamId, 1200);
      await satori.connect(carol).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(1) }]);
      await expect(
        satori.connect(carol).delegatePredictionPower(carol.address)
      ).to.be.revertedWithCustomError(satori, "Locked");

      // Verify no double-use occurred (each user predicted on their respective dates)
      expect(await satori.predictedStreamsCount(alice.address, dateAlice)).to.equal(1);
      expect(await satori.predictedStreamsCount(bob.address, dateBob)).to.equal(1);
      expect(await satori.predictedStreamsCount(carol.address, dateCarol)).to.equal(1);
    });
  });

  describe("Edge Cases", function () {
    it("Should handle delegation to address(0) when already undelegated", async function () {
      // Alice is already undelegated (address(0))
      expect((await rewards.predictionDelegateInfo(alice.address)).delegate).to.equal(ethers.ZeroAddress);

      // Alice "undelegates" again - should work without issue
      const currentRound = await satori.getCurrentRound();
      await satori.connect(alice).delegatePredictionPower(ethers.ZeroAddress);

      // Still undelegated
      expect((await rewards.predictionDelegateInfo(alice.address)).delegate).to.equal(ethers.ZeroAddress);

      // Alice gets locked from prediction until next round (standard undelegation lock)
      const lockedUntil = await satori.lockedUntil(alice.address);
      expect(lockedUntil).to.equal(currentRound + 1n); // Locked until next round
    });

    it("Should handle rapid delegation switching correctly", async function () {
      // Start: Alice not delegated
      expect((await rewards.predictionDelegateInfo(alice.address)).delegate).to.equal(ethers.ZeroAddress);

      // Delegate to Bob
      await satori.connect(alice).delegatePredictionPower(bob.address);
      expect((await rewards.predictionDelegateInfo(alice.address)).delegate).to.equal(bob.address);

      // Switch to Carol (Bob hasn't predicted)
      await satori.connect(alice).delegatePredictionPower(carol.address);
      expect((await rewards.predictionDelegateInfo(alice.address)).delegate).to.equal(carol.address);

      // "Self-delegate" — normalized to address(0). This is undelegating, and
      // sets lockUntilNextRound, so further delegate calls are blocked
      // until the lock clears.
      await satori.connect(alice).delegatePredictionPower(alice.address);
      expect((await rewards.predictionDelegateInfo(alice.address)).delegate).to.equal(ethers.ZeroAddress);

      // Same-round re-delegation now blocked by the lock.
      await expect(
        satori.connect(alice).delegatePredictionPower(dave.address)
      ).to.be.revertedWithCustomError(satori, "Locked");

      // Advance one round; lock clears.
      await time.increase(86400);

      // Alice can delegate again after the lock expires.
      await satori.connect(alice).delegatePredictionPower(dave.address);
      expect((await rewards.predictionDelegateInfo(alice.address)).delegate).to.equal(dave.address);
    });
  });
});