const { expect } = require("chai");
const { deploySatoriFixture, pack1, voteFor } = require("./fixtures");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { TEST_MARKETING_FEE_RECIPIENT } = require("./next/splitFixture");

// Helper: recover the streamId (== the auto-created binary gameId) from a
// createSimpleDataStream tx. The fixture now initializes the DEFAULT stream at
// id 1, so the first stream a test creates is id 2 — never hardcode.
async function getStreamIdFromTx(tx, satoriContract) {
  const receipt = await tx.wait();
  for (const log of receipt.logs) {
    try {
      const parsed = satoriContract.interface.parseLog(log);
      if (parsed && parsed.name === "DataStreamCreated") return Number(parsed.args.streamId);
    } catch {}
  }
  throw new Error("DataStreamCreated event not found");
}

describe("Security Fixes", function () {
  async function deployFixture() {
    // Restructured stack (SatoriToken + SatoriEngine + SatoriHub + children)
    // behind the monolith-shaped compatibility shim. 2000 bps platform fee.
    const fix = await deploySatoriFixture();
    const [owner, addr1, addr2, addr3] = fix.signers;
    return { ...fix, owner, addr1, addr2, addr3 };
  }

  describe("Task 1: setValue Once-Per-Round Protection", function () {
    it("Should allow setValue once per round", async function () {
      const { satori, owner, registry } = await loadFixture(deployFixture);

      // Create a simple stream
      const gameId = await getStreamIdFromTx(
        await satori.createSimpleDataStream("Test Stream", owner.address), satori);

      // Set value once - should succeed
      await registry.setValue(gameId, 100);

      const value = await registry.getValue(gameId);
      expect(value).to.equal(100);
    });

    it("Should prevent setValue twice in same round", async function () {
      const { satori, owner, registry } = await loadFixture(deployFixture);

      // Create a simple stream
      const gameId = await getStreamIdFromTx(
        await satori.createSimpleDataStream("Test Stream", owner.address), satori);

      // Set value first time - should succeed
      await registry.setValue(gameId, 100);

      // Try to set value second time in same round - should fail
      await expect(
        registry.setValue(gameId, 200)
      ).to.be.revertedWithCustomError(registry, "CadenceRoundsNotElapsed");
    });

    it("Should allow setValue after round advances", async function () {
      const { satori, owner, registry } = await loadFixture(deployFixture);

      // Create a simple stream
      const gameId = await getStreamIdFromTx(
        await satori.createSimpleDataStream("Test Stream", owner.address), satori);

      // Set value in round 0
      await registry.setValue(gameId, 100);

      // Advance time and end round
      await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
      await ethers.provider.send("evm_mine");
      await time.increase(86400);

      // Set value in round 1 - should succeed
      await registry.setValue(gameId, 200);

      const value = await registry.getValue(gameId);
      expect(value).to.equal(200);
    });
  });

  describe("Task 2: Delegation Double-Use Attack Prevention", function () {
    it("Should allow initial delegation", async function () {
      const { satori, rewards, owner, addr1, addr2, registry } = await loadFixture(deployFixture);

      // Give addr1 some tokens
      await satori.transfer(addr1.address, 1000);

      // addr1 delegates to addr2
      await satori.connect(addr1).delegatePredictionPower(addr2.address);

      const delegate = (await rewards.predictionDelegateInfo(addr1.address)).delegate;
      expect(delegate).to.equal(addr2.address);
    });

    it("Should prevent switching to delegate who already predicted", async function () {
      const { satori, owner, addr1, addr2, addr3, registry } = await loadFixture(deployFixture);

      // Create a stream and make it eligible
      const gameId = await getStreamIdFromTx(
        await satori.createSimpleDataStream("Test Stream", owner.address), satori);
      await registry.setValue(gameId, 100);

      // Give tokens to everyone
      await satori.transfer(addr1.address, 1000);
      await satori.transfer(addr2.address, 1000);
      await satori.transfer(addr3.address, 1000);

      // Burn to buy the game weight (makes it eligible)
      await voteFor(satori, owner, gameId);

      // addr1 delegates to addr2
      await satori.connect(addr1).delegatePredictionPower(addr2.address);

      // addr2 makes a prediction
      await satori.connect(addr2).predictMultipleWithPayloads([{ gameId, payload: pack1(1) }]);

      // addr1 tries to switch delegation to addr3 who already predicted
      // First let addr3 predict
      await satori.connect(addr3).predictMultipleWithPayloads([{ gameId, payload: pack1(1) }]);

      // Now addr1 tries to switch to addr3 - should fail
      await expect(
        satori.connect(addr1).delegatePredictionPower(addr3.address)
      ).to.be.revertedWithCustomError(satori, "DelegateActive");
    });

    it("Should allow switching to delegate who hasn't predicted", async function () {
      const { satori, rewards, owner, addr1, addr2, addr3, registry } = await loadFixture(deployFixture);

      // Create a stream
      const gameId = await getStreamIdFromTx(
        await satori["createSimpleDataStream(string,address,uint24)"]("Test Stream", owner.address, 1440),
        satori);
      // Admin-created CADENCE-1 stream. What this test is about is the
      // delegation rule, which is measured in ROUNDS: the "next round" steps
      // below have to stay one round, so the stream has to be writable every
      // round. A public caller may no longer create that (StreamCadenceTooShort),
      // but `satori` here is connected to signers[0] == owner == rewards.admin(),
      // which is exempt. Provider is unchanged, so every later setValue still works.
      await registry.setValue(gameId, 100);

      // Give tokens to everyone
      await satori.transfer(addr1.address, 1000);
      await satori.transfer(addr2.address, 1000);
      await satori.transfer(addr3.address, 1000);

      // Burn to buy the game weight (makes it eligible)
      await voteFor(satori, owner, gameId);

      // addr1 delegates to addr2
      await satori.connect(addr1).delegatePredictionPower(addr2.address);

      // addr2 makes a prediction
      await satori.connect(addr2).predictMultipleWithPayloads([{ gameId, payload: pack1(1) }]);

      // Advance to next round so addr3 hasn't predicted THIS round
      await time.increase(86400);
      await registry.setValue(gameId, 150); // Update value for new round

      // addr1 switches to addr3 who hasn't predicted in this round - should succeed
      await satori.connect(addr1).delegatePredictionPower(addr3.address);

      const delegate = (await rewards.predictionDelegateInfo(addr1.address)).delegate;
      expect(delegate).to.equal(addr3.address);
    });

    it("Should always allow undelegation (delegation to self)", async function () {
      const { satori, rewards, owner, addr1, addr2, registry } = await loadFixture(deployFixture);

      // Create a stream
      const gameId = await getStreamIdFromTx(
        await satori["createSimpleDataStream(string,address,uint24)"]("Test Stream", owner.address, 1440),
        satori);
      // Admin-created CADENCE-1 stream. What this test is about is the
      // delegation rule, which is measured in ROUNDS: the "next round" steps
      // below have to stay one round, so the stream has to be writable every
      // round. A public caller may no longer create that (StreamCadenceTooShort),
      // but `satori` here is connected to signers[0] == owner == rewards.admin(),
      // which is exempt. Provider is unchanged, so every later setValue still works.
      await registry.setValue(gameId, 100);

      // Give tokens
      await satori.transfer(addr1.address, 1000);
      await satori.transfer(addr2.address, 1000);

      // Burn to buy the game weight (makes it eligible)
      await voteFor(satori, owner, gameId);

      // addr1 delegates to addr2
      await satori.connect(addr1).delegatePredictionPower(addr2.address);

      // addr2 makes a prediction
      await satori.connect(addr2).predictMultipleWithPayloads([{ gameId, payload: pack1(1) }]);

      // Advance to next round to allow delegation change
      await time.increase(86400);
      await registry.setValue(gameId, 150);

      // addr1 undelegates (delegates to self) - normalized to address(0)
      await satori.connect(addr1).delegatePredictionPower(addr1.address);

      const delegate = (await rewards.predictionDelegateInfo(addr1.address)).delegate;
      expect(delegate).to.equal(ethers.ZeroAddress);
    });
  });

  describe("Task 3: Claim delegation undelegation path", function () {
    it("Should allow self-claim after undelegating claim", async function () {
      const { satori, rewards, owner, addr1, addr2, addr3, registry } = await loadFixture(deployFixture);

      // Create a stream and set value
      const gameId = await getStreamIdFromTx(
        await satori["createSimpleDataStream(string,address,uint24)"]("Test Stream", owner.address, 1440),
        satori);
      // Admin-created CADENCE-1 stream. What this test is about is the
      // delegation rule, which is measured in ROUNDS: the "next round" steps
      // below have to stay one round, so the stream has to be writable every
      // round. A public caller may no longer create that (StreamCadenceTooShort),
      // but `satori` here is connected to signers[0] == owner == rewards.admin(),
      // which is exempt. Provider is unchanged, so every later setValue still works.
      await registry.setValue(gameId, 100);

      // Give tokens and burn for the game so it carries weight (most of bootstrap
      // goes to addr1; the owner keeps enough to burn).
      const INITIAL_MINT = await satori.INITIAL_MINT();
      await satori.transfer(addr1.address, (INITIAL_MINT * 9n) / 10n);
      await voteFor(satori, owner, gameId);

      // addr1 delegates claim ability to addr2
      await satori.connect(addr1).delegateClaimAbility(addr2.address);

      // addr1 makes a prediction in round 1
      await satori.connect(addr1).predictMultipleWithPayloads([{ gameId, payload: pack1(1) }]);

      // Advance to round 2 - scoring happens
      await time.increase(86400);
      await registry.setValue(gameId, 200); // value goes up, direction 1 (UP) is correct

      // Advance to round 3 - rewards available
      await time.increase(86400);
      await registry.setValue(gameId, 300);

      // addr1 undelegates claim ability
      await satori.connect(addr1).delegateClaimAbility(addr1.address);

      // addr1 must wait one round after undelegation
      const currentDelegate = await rewards.claimDelegateInfo(addr1.address);
      expect(currentDelegate).to.equal(addr1.address);

      // Advance one more round
      await time.increase(86400);
      await registry.setValue(gameId, 400);

      // addr1 should now be able to claim for themselves
      // (claim may return 0 if no rewards were scored, but should not revert)
      await expect(
        satori.connect(addr1)["claim(address)"](addr1.address)
      ).to.not.be.reverted;
    });
  });

  describe("Task 4: Delegator scale (pull model)", function () {
    it("Should support many delegators without hard cap reverts", async function () {
      // Deploy a fresh scenario against the restructured stack.
      const fix = await deploySatoriFixture();
      const allSigners = fix.signers;
      const owner = allSigners[0];
      const target = allSigners[1];
      const satori2 = fix.satori;
      const rewards2 = fix.rewards;

      // Use available signer set to create many delegators.
      // In the pull-based model there should be no "Max delegators reached" hard cap.
      const delegators = allSigners.slice(2, 18); // 16 delegators
      const amount = ethers.parseEther("10");
      for (const delegator of delegators) {
        await satori2.transfer(delegator.address, amount);
        await expect(
          satori2.connect(delegator).delegatePredictionPower(target.address)
        ).to.not.be.reverted;
      }

      const targetPower = await rewards2.getPredictionPower(target.address);
      expect(targetPower).to.equal(amount * BigInt(delegators.length));
    }, 120000);
  });

  describe("Task 5: setSatoriCore deployer guard", function () {
    it("Should prevent non-deployer from calling setSatoriCore on SatoriVoting", async function () {
      const [owner, attacker] = await ethers.getSigners();

      const SatoriVoting = await ethers.getContractFactory("SatoriVoting");
      const freshVoting = await SatoriVoting.deploy();

      // attacker tries to set satoriCore before the deployer does
      await expect(
        freshVoting.connect(attacker).setSatoriCore(attacker.address)
      ).to.be.revertedWithCustomError(freshVoting, "OnlyDeployer");
    });

    it("Should prevent non-deployer from calling setSatoriCore on SatoriRewards", async function () {
      const [owner, attacker] = await ethers.getSigners();

      const SatoriVoting = await ethers.getContractFactory("SatoriVoting");
      const freshVoting = await SatoriVoting.deploy();

      const SatoriRewards = await ethers.getContractFactory("SatoriRewards");
      // Platform fee moved to the immutable token (see test/next/DevFee.test.js);
      // the rewards ctor no longer takes initialFeeBps/platformRecipient — only
      // (voting, admin, marketingRecipient).
      const freshRewards = await SatoriRewards.deploy(await freshVoting.getAddress(), owner.address, TEST_MARKETING_FEE_RECIPIENT);

      await expect(
        freshRewards.connect(attacker).setSatoriCore(attacker.address)
      ).to.be.revertedWithCustomError(freshRewards, "Unauthorized");
    });

    it("Should prevent non-deployer from calling setSatoriCore on SatoriRegistry", async function () {
      const [owner, attacker] = await ethers.getSigners();

      const SatoriRegistry = await ethers.getContractFactory("SatoriRegistry");
      const freshRegistry = await SatoriRegistry.deploy();

      await expect(
        freshRegistry.connect(attacker).setSatoriCore(attacker.address)
      ).to.be.revertedWithCustomError(freshRegistry, "OnlyDeployer");
    });

    it("Should allow deployer to call setSatoriCore", async function () {
      // setSatoriCore on SatoriVoting now resolves the games registry off
      // the core (`core.satoriGames()`), so we need a real Satori-shaped
      // contract on the other end — an EOA won't have the method. In the
      // restructured stack the "core" children authorize is the HUB (it
      // exposes satoriGames()), so point a fresh SatoriVoting at the
      // fixture's hub and assert the deployer-side success.
      const fix = await deploySatoriFixture();
      const owner = fix.signers[0];
      const coreAddr = await fix.hub.getAddress();

      const SatoriVoting = await ethers.getContractFactory("SatoriVoting");
      const freshVoting = await SatoriVoting.deploy();

      // deployer (owner) should succeed
      await expect(
        freshVoting.connect(owner).setSatoriCore(coreAddr)
      ).to.not.be.reverted;

      expect(await freshVoting.satoriCore()).to.equal(coreAddr);
    });
  });
});
