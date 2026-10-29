// SatoriEngine#10 / SatoriRewards#15 and permissionless claim-to-owner
// (SatoriRewards._checkClaimAuth). Unclaimed rewards count toward prediction
// power, so once the owner has predicted this round:
//   - a claim goes only to the owner (ClaimElsewhereAfterPredicting), and
//   - a fee out of the claim goes only to the admin-set official relayer
//     (FeeNotToOfficialRelayer), on every path that ends in `_claimFor`.
// And anyone may claim for an owner who names no claimer, to the owner only.

const { expect } = require("chai");
const { deploySatoriFixture, pack1, VOTE } = require("./fixtures");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const NO_PERMIT = { value: 0n, deadline: 0n, signature: "0x" };
const FAR_FUTURE = 4102444800n;
const ONE = ethers.parseEther("1");
const A = { Predict: 0, Claim: 1, Transfer: 2, DelegatePrediction: 3, SetAllowedDelegator: 4, SetPredictorFee: 5, Vote: 6 };
const abi = ethers.AbiCoder.defaultAbiCoder();
const encPredict = (referrer, reqs) =>
  abi.encode(["address", "tuple(uint32 gameId, bytes payload)[]"], [referrer, reqs]);
const encAddr = (a) => abi.encode(["address"], [a]);

async function getStreamIdFromTx(tx, satoriContract) {
  const receipt = await tx.wait();
  for (const log of receipt.logs) {
    try {
      const parsed = satoriContract.interface.parseLog(log);
      if (parsed && parsed.name === "DataStreamCreated") return parsed.args.streamId;
    } catch {}
  }
  throw new Error("DataStreamCreated event not found");
}

async function advanceToNextRound() {
  const currentTime = await time.latest();
  const nextMidnight = Math.floor(currentTime / 86400) * 86400 + 86400;
  await time.increaseTo(nextMidnight + 1);
  await time.increase(86400);
}

async function nextRoundOnly() {
  const currentTime = await time.latest();
  await time.increaseTo(Math.floor(currentTime / 86400) * 86400 + 86400 + 1);
}

async function signRelay(hub, user, req) {
  const chainId = (await ethers.provider.getNetwork()).chainId;
  const domain = { name: "SatoriHub", version: "1", chainId, verifyingContract: await hub.getAddress() };
  const types = {
    RelayRequest: [
      { name: "user", type: "address" },
      { name: "action", type: "uint8" },
      { name: "data", type: "bytes" },
      { name: "fee", type: "uint256" },
      { name: "relayer", type: "address" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
  };
  return user.signTypedData(domain, types, req);
}

describe("Claims after predicting this round, and claiming for others", function () {
  let fix, satori, token, hub, engine, rewards, registry;
  let owner, alice, bob, carol, relayer, official;
  let stream1, value;

  beforeEach(async function () {
    fix = await loadFixture(deploySatoriFixture);
    ;({ satori, token, hub, engine, rewards, registry, owner } = fix);
    [, alice, bob, carol, relayer, official] = fix.signers;

    const tx1 = await satori.createSimpleDataStream("Stream 1", owner.address);
    stream1 = await getStreamIdFromTx(tx1, satori);
    await satori.transfer(alice.address, ethers.parseEther("300"));
    await satori.transfer(bob.address, ethers.parseEther("100"));
    await satori.connect(alice).vote(stream1, VOTE);
    await advanceToNextRound();
    value = 100;
  });

  async function post() {
    value += 50;
    await registry.setValue(stream1, value);
  }

  // Uses the latest posted value; a stream takes one post per round.
  async function predict(user) {
    await satori.connect(user).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(1) }]);
  }

  // Alice wins a round (rising stream, UP) and settles: a bucket, and no
  // prediction in the current round.
  async function aliceWins() {
    await post();
    await predict(alice);
    await advanceToNextRound();
    await post();
    await advanceToNextRound();
    await post();
    await engine.settlePrediction(alice.address, stream1);
    expect(await rewards.unclaimedRewards(alice.address)).to.be.gt(ONE);
  }

  async function relay(user, action, data, fee = ONE, by = relayer) {
    const req = {
      user: user.address, action, data, fee, relayer: by.address,
      nonce: await hub.relayNonces(user.address), deadline: FAR_FUTURE,
    };
    const sig = await signRelay(hub, user, req);
    return hub.connect(by).relay(req, sig, NO_PERMIT);
  }

  describe("the official relayer setting", function () {
    it("only the rewards admin sets it, and it emits OfficialRelayerSet", async function () {
      await expect(rewards.connect(alice).setOfficialRelayer(official.address))
        .to.be.revertedWithCustomError(rewards, "Unauthorized");
      await expect(rewards.connect(owner).setOfficialRelayer(official.address))
        .to.emit(rewards, "OfficialRelayerSet").withArgs(official.address, owner.address);
      expect(await rewards.officialRelayer()).to.equal(official.address);
      await expect(rewards.connect(owner).setOfficialRelayer(ethers.ZeroAddress))
        .to.emit(rewards, "OfficialRelayerSet").withArgs(ethers.ZeroAddress, owner.address);
      expect(await rewards.officialRelayer()).to.equal(ethers.ZeroAddress);
    });
  });

  describe("after the owner predicts this round", function () {
    beforeEach(async function () {
      await aliceWins();
      await predict(alice);
    });

    it("claim(recipient) to another address is refused", async function () {
      await expect(satori.connect(alice)["claim(address)"](bob.address))
        .to.be.revertedWithCustomError(rewards, "ClaimElsewhereAfterPredicting");
    });

    it("claiming to yourself with no fee still works", async function () {
      const bucket = await rewards.unclaimedRewards(alice.address);
      const before = await token.balanceOf(alice.address);
      await satori.connect(alice)["claim(address)"](alice.address);
      expect(await token.balanceOf(alice.address)).to.equal(before + bucket);
    });

    it("a named claimer may claim only to the owner", async function () {
      await satori.connect(alice).delegateClaimAbility(bob.address);
      await expect(satori.connect(bob)["claimFor(address,address)"](alice.address, bob.address))
        .to.be.revertedWithCustomError(rewards, "ClaimElsewhereAfterPredicting");
      const bucket = await rewards.unclaimedRewards(alice.address);
      const before = await token.balanceOf(alice.address);
      await satori.connect(bob)["claimFor(address,address)"](alice.address, alice.address);
      expect(await token.balanceOf(alice.address)).to.equal(before + bucket);
    });

    it("a stranger may still claim to the owner", async function () {
      const bucket = await rewards.unclaimedRewards(alice.address);
      const before = await token.balanceOf(alice.address);
      await satori.connect(carol)["claimFor(address,address)"](alice.address, alice.address);
      expect(await token.balanceOf(alice.address)).to.equal(before + bucket);
    });

    it("relay Claim: another recipient is refused", async function () {
      await rewards.connect(owner).setOfficialRelayer(relayer.address);
      await expect(relay(alice, A.Claim, encAddr(bob.address)))
        .to.be.revertedWithCustomError(rewards, "ClaimElsewhereAfterPredicting");
    });

    it("relay Claim: a fee to a relayer that isn't the official one is refused", async function () {
      await rewards.connect(owner).setOfficialRelayer(official.address);
      await expect(relay(alice, A.Claim, encAddr(alice.address)))
        .to.be.revertedWithCustomError(rewards, "FeeNotToOfficialRelayer");
      expect(await hub.relayNonces(alice.address)).to.equal(0n);
    });

    it("relay Claim: the official relayer is paid", async function () {
      await rewards.connect(owner).setOfficialRelayer(official.address);
      const bucket = await rewards.unclaimedRewards(alice.address);
      const aliceBefore = await token.balanceOf(alice.address);
      const relayerBefore = await token.balanceOf(official.address);
      await relay(alice, A.Claim, encAddr(alice.address), ONE, official);
      expect(await token.balanceOf(official.address)).to.equal(relayerBefore + ONE);
      expect(await token.balanceOf(alice.address)).to.equal(aliceBefore + bucket - ONE);
    });

    it("relay Claim with no fee goes through any relayer", async function () {
      const bucket = await rewards.unclaimedRewards(alice.address);
      const before = await token.balanceOf(alice.address);
      await relay(alice, A.Claim, encAddr(alice.address), 0n);
      expect(await token.balanceOf(alice.address)).to.equal(before + bucket);
    });

    it("fee fallback (locked wallet, other action): a relayer that isn't official is refused", async function () {
      await rewards.connect(owner).setOfficialRelayer(official.address);
      await expect(relay(alice, A.SetAllowedDelegator, encAddr(ethers.ZeroAddress)))
        .to.be.revertedWithCustomError(rewards, "FeeNotToOfficialRelayer");
    });

    it("fee fallback (locked wallet, other action): the official relayer is paid", async function () {
      await rewards.connect(owner).setOfficialRelayer(official.address);
      const relayerBefore = await token.balanceOf(official.address);
      await relay(alice, A.SetAllowedDelegator, encAddr(bob.address), ONE, official);
      expect(await token.balanceOf(official.address)).to.equal(relayerBefore + ONE);
      expect(await hub.allowedDelegator(alice.address)).to.equal(bob.address);
    });

    it("with no official relayer set, every fee is refused (Claim arm and fallback)", async function () {
      expect(await rewards.officialRelayer()).to.equal(ethers.ZeroAddress);
      await expect(relay(alice, A.Claim, encAddr(alice.address)))
        .to.be.revertedWithCustomError(rewards, "FeeNotToOfficialRelayer");
      await expect(relay(alice, A.SetAllowedDelegator, encAddr(ethers.ZeroAddress)))
        .to.be.revertedWithCustomError(rewards, "FeeNotToOfficialRelayer");
    });
  });

  describe("before predicting, and on a round without predictions", function () {
    it("before predicting this round: claim elsewhere, and a fee to any relayer, both work", async function () {
      await aliceWins();
      const bucket = await rewards.unclaimedRewards(alice.address);
      const bobBefore = await token.balanceOf(bob.address);
      const relayerBefore = await token.balanceOf(relayer.address);
      await relay(alice, A.Claim, encAddr(bob.address));
      expect(await token.balanceOf(relayer.address)).to.equal(relayerBefore + ONE);
      expect(await token.balanceOf(bob.address)).to.equal(bobBefore + bucket - ONE);
    });

    it("the round after predicting (still transfer-locked): claim elsewhere works", async function () {
      await aliceWins();
      await predict(alice);
      await nextRoundOnly();
      expect(await token.transferLockedUntil(alice.address)).to.be.gte(await hub.getCurrentRound());
      const bucket = await rewards.unclaimedRewards(alice.address);
      const bobBefore = await token.balanceOf(bob.address);
      await satori.connect(alice)["claim(address)"](bob.address);
      expect(await token.balanceOf(bob.address)).to.equal(bobBefore + bucket);
    });

    it("a relayed Predict pays its fee to any relayer, even from unclaimed rewards", async function () {
      await aliceWins();
      await predict(alice);
      await nextRoundOnly(); // still locked, no prediction yet this round: the fee falls back to the bucket
      const bucket = await rewards.unclaimedRewards(alice.address);
      const relayerBefore = await token.balanceOf(relayer.address);
      await post();
      await relay(alice, A.Predict, encPredict(ethers.ZeroAddress, [{ gameId: stream1, payload: pack1(1) }]));
      expect(await token.balanceOf(relayer.address)).to.equal(relayerBefore + ONE);
      expect(await rewards.unclaimedRewards(alice.address)).to.equal(0n); // claimed to alice less the fee
      expect(await engine.predictedStreamsCount(alice.address, await hub.getCurrentRound())).to.equal(1n);
      expect(bucket).to.be.gt(ONE);
    });

    it("a staked wallet (prediction delegator) is never held, even after its delegate predicts", async function () {
      await satori.connect(bob).delegatePredictionPower(alice.address);
      await aliceWins();
      await predict(alice);
      const carolBefore = await token.balanceOf(carol.address);
      await satori.connect(bob)["claim(address)"](carol.address);
      expect(await token.balanceOf(carol.address)).to.be.gt(carolBefore);
    });
  });

  describe("claiming for someone else", function () {
    beforeEach(async function () {
      await aliceWins();
    });

    it("a stranger claims for an owner with no claimer: the owner is paid, the stranger gets nothing", async function () {
      const bucket = await rewards.unclaimedRewards(alice.address);
      const aliceBefore = await token.balanceOf(alice.address);
      const carolBefore = await token.balanceOf(carol.address);
      await expect(satori.connect(carol)["claimFor(address,address)"](alice.address, alice.address))
        .to.emit(rewards, "RewardsClaimed");
      expect(await token.balanceOf(alice.address)).to.equal(aliceBefore + bucket);
      expect(await token.balanceOf(carol.address)).to.equal(carolBefore);
      expect(await rewards.unclaimedRewards(alice.address)).to.equal(0n);
    });

    it("a stranger may not send it anywhere else", async function () {
      await expect(satori.connect(carol)["claimFor(address,address)"](alice.address, carol.address))
        .to.be.revertedWithCustomError(rewards, "Unauthorized");
    });

    it("a stranger is refused when the owner has named a claimer", async function () {
      await satori.connect(alice).delegateClaimAbility(bob.address);
      await expect(satori.connect(carol)["claimFor(address,address)"](alice.address, alice.address))
        .to.be.revertedWithCustomError(rewards, "Unauthorized");
    });

    it("naming yourself as claimer opts out: strangers refused, your own claim still works", async function () {
      await satori.connect(alice).delegateClaimAbility(alice.address);
      await expect(satori.connect(carol)["claimFor(address,address)"](alice.address, alice.address))
        .to.be.revertedWithCustomError(rewards, "Unauthorized");
      const bucket = await rewards.unclaimedRewards(alice.address);
      const before = await token.balanceOf(alice.address);
      await satori.connect(alice)["claim(address)"](alice.address);
      expect(await token.balanceOf(alice.address)).to.equal(before + bucket);
    });

    it("the named claimer still claims to any address", async function () {
      await satori.connect(alice).delegateClaimAbility(bob.address);
      const bucket = await rewards.unclaimedRewards(alice.address);
      const carolBefore = await token.balanceOf(carol.address);
      await satori.connect(bob)["claimFor(address,address)"](alice.address, carol.address);
      expect(await token.balanceOf(carol.address)).to.equal(carolBefore + bucket);
    });
  });
});
