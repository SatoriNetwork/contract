// docs/design/gasless-relay.md — the hub's `relay()` entry point. One EIP-712
// signature authorizes an action AND the SATORI fee to the bound relayer; the
// relayer pays the Base gas. The properties under test:
//
//   1. The signature commits to everything: user, action, params, fee, relayer,
//      nonce, deadline. Change any of them and the relay is refused.
//   2. Atomicity: a failed action takes no fee and consumes no nonce.
//   3. A claim's fee is minted out of the claim itself, so a zero-balance or
//      transfer-locked wallet with unclaimed rewards can still claim.
//   4. Each relayed action produces the same state transition as its direct
//      msg.sender call.

const { expect } = require("chai");
const { deploySatoriFixture, pack1, VOTE } = require("./fixtures");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const NO_PERMIT = { value: 0n, deadline: 0n, signature: "0x" };
const FAR_FUTURE = 4102444800n; // 2100-01-01
const ONE = ethers.parseEther("1");

// SatoriHub.RelayAction
const A = { Predict: 0, Claim: 1, Transfer: 2, DelegatePrediction: 3, SetAllowedDelegator: 4, SetPredictorFee: 5, Vote: 6 };

const abi = ethers.AbiCoder.defaultAbiCoder();
const encPredict = (referrer, reqs) =>
  abi.encode(["address", "tuple(uint32 gameId, bytes payload)[]"], [referrer, reqs]);

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

/// EIP-712 RelayRequest signature — mirrors SatoriHub.RELAY_TYPEHASH.
async function signRelay(hub, user, req, domainOverride = {}) {
  const chainId = (await ethers.provider.getNetwork()).chainId;
  const domain = {
    name: "SatoriHub", version: "1", chainId,
    verifyingContract: await hub.getAddress(),
    ...domainOverride,
  };
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

/// The token's bytes-signature ERC-2612 permit (see PermitEntryPoints.test.js).
async function signPermit(token, owner, spender, value, deadline) {
  const [chainId, name, nonce, verifyingContract] = await Promise.all([
    ethers.provider.getNetwork().then((n) => n.chainId),
    token.name(),
    token.nonces(owner.address),
    token.getAddress(),
  ]);
  const raw = await owner.signTypedData(
    { name, version: "1", chainId, verifyingContract },
    {
      Permit: [
        { name: "owner", type: "address" },
        { name: "spender", type: "address" },
        { name: "value", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    { owner: owner.address, spender, value, nonce, deadline },
  );
  return { value, deadline, signature: raw };
}

describe("Gasless relay", function () {
  let fix, satori, token, hub, engine, rewards, registry, voting;
  let owner, alice, bob, carol, relayer;
  let stream1;

  beforeEach(async function () {
    fix = await loadFixture(deploySatoriFixture);
    ;({ satori, token, hub, engine, rewards, registry, voting, owner } = fix);
    [, alice, bob, carol, relayer] = fix.signers;

    const tx1 = await satori.createSimpleDataStream("Stream 1", owner.address);
    stream1 = await getStreamIdFromTx(tx1, satori);

    await satori.transfer(alice.address, ethers.parseEther("300"));
    await satori.transfer(bob.address, ethers.parseEther("100"));
    await satori.connect(alice).vote(stream1, VOTE);
    await advanceToNextRound();
  });

  // Build-and-sign in one step; every field defaults to a valid request so a
  // test only spells out what it is actually about.
  async function relayReq(user, action, data, overrides = {}) {
    const req = {
      user: user.address,
      action,
      data,
      fee: ONE,
      relayer: relayer.address,
      nonce: await hub.relayNonces(user.address),
      deadline: FAR_FUTURE,
      ...overrides,
    };
    const sig = await signRelay(hub, user, req, overrides.domain ?? {});
    delete req.domain;
    return { req, sig };
  }

  describe("Predict", function () {
    it("relays a prediction with a same-tx permit: no prior allowance, fee paid, referral set", async function () {
      await token.connect(alice).approve(await hub.getAddress(), 0); // kill the fixture's blanket approval
      await registry.setValue(stream1, 100);

      const data = encPredict(bob.address, [{ gameId: stream1, payload: pack1(1) }]);
      const { req, sig } = await relayReq(alice, A.Predict, data);
      // Standing allowance: enough for ~20 relays, topped up client-side.
      const p = await signPermit(token, alice, await hub.getAddress(), ethers.parseEther("20"), FAR_FUTURE);

      const relayerBefore = await token.balanceOf(relayer.address);
      await hub.connect(relayer).relay(req, sig, p);

      const round = await hub.getCurrentRound();
      expect(await engine.predictedStreamsCount(alice.address, round)).to.equal(1n);
      expect(await token.balanceOf(relayer.address)).to.equal(relayerBefore + ONE);
      expect(await rewards.referral(alice.address)).to.equal(bob.address);
      expect(await hub.relayNonces(alice.address)).to.equal(1n);
    });

    it("records the SIGNER as predictor, not the relayer", async function () {
      await registry.setValue(stream1, 100);
      const data = encPredict(ethers.ZeroAddress, [{ gameId: stream1, payload: pack1(1) }]);
      const { req, sig } = await relayReq(alice, A.Predict, data);
      await hub.connect(relayer).relay(req, sig, NO_PERMIT);

      const round = await hub.getCurrentRound();
      expect(await engine.predictedStreamsCount(alice.address, round)).to.equal(1n);
      expect(await engine.predictedStreamsCount(relayer.address, round)).to.equal(0n);
    });

    it("leaves the normal predict path untouched", async function () {
      await registry.setValue(stream1, 100);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(1) }]);
      const round = await hub.getCurrentRound();
      expect(await engine.predictedStreamsCount(alice.address, round)).to.equal(1n);
    });

    it("a failed action consumes no nonce (revert inside the dispatch)", async function () {
      await registry.setValue(stream1, 100);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(1) }]);

      // fee 0 so the relay reaches the engine, which refuses the second
      // prediction — and the nonce bump unwinds with it.
      const data = encPredict(ethers.ZeroAddress, [{ gameId: stream1, payload: pack1(1) }]);
      const { req, sig } = await relayReq(alice, A.Predict, data, { fee: 0n });
      await expect(hub.connect(relayer).relay(req, sig, NO_PERMIT))
        .to.be.revertedWithCustomError(engine, "AlreadyPredicted");
      expect(await hub.relayNonces(alice.address)).to.equal(0n);
    });

    it("a failed fee transfer takes no fee and consumes no nonce (locked user)", async function () {
      await registry.setValue(stream1, 100);
      // Predicting locks alice for the round, so the relay's fee transfer is
      // what refuses — same atomic unwind from the other side of the dispatch.
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(1) }]);

      const data = encPredict(ethers.ZeroAddress, [{ gameId: stream1, payload: pack1(1) }]);
      const { req, sig } = await relayReq(alice, A.Predict, data);
      const relayerBefore = await token.balanceOf(relayer.address);
      await expect(hub.connect(relayer).relay(req, sig, NO_PERMIT))
        .to.be.revertedWithCustomError(token, "Locked");
      expect(await token.balanceOf(relayer.address)).to.equal(relayerBefore);
      expect(await hub.relayNonces(alice.address)).to.equal(0n);
    });
  });

  describe("Refusals — the signature commits to everything", function () {
    let data;
    beforeEach(async function () {
      await registry.setValue(stream1, 100);
      data = encPredict(ethers.ZeroAddress, [{ gameId: stream1, payload: pack1(1) }]);
    });

    it("refuses a request submitted by anyone but the bound relayer", async function () {
      const { req, sig } = await relayReq(alice, A.Predict, data);
      await expect(hub.connect(bob).relay(req, sig, NO_PERMIT))
        .to.be.revertedWithCustomError(hub, "Unauthorized");
    });

    it("refuses tampered action data", async function () {
      const { req, sig } = await relayReq(alice, A.Predict, data);
      req.data = encPredict(carol.address, [{ gameId: stream1, payload: pack1(1) }]);
      await expect(hub.connect(relayer).relay(req, sig, NO_PERMIT))
        .to.be.revertedWithCustomError(hub, "BadRelaySignature");
    });

    it("refuses a raised fee", async function () {
      const { req, sig } = await relayReq(alice, A.Predict, data);
      req.fee = ONE * 2n;
      await expect(hub.connect(relayer).relay(req, sig, NO_PERMIT))
        .to.be.revertedWithCustomError(hub, "BadRelaySignature");
    });

    it("refuses a signature made for a different contract", async function () {
      const { req, sig } = await relayReq(alice, A.Predict, data, {
        domain: { verifyingContract: await token.getAddress() },
      });
      await expect(hub.connect(relayer).relay(req, sig, NO_PERMIT))
        .to.be.revertedWithCustomError(hub, "BadRelaySignature");
    });

    it("refuses an expired authorization", async function () {
      const { req, sig } = await relayReq(alice, A.Predict, data, { deadline: 1n });
      await expect(hub.connect(relayer).relay(req, sig, NO_PERMIT))
        .to.be.revertedWithCustomError(hub, "RelayExpired");
    });

    it("refuses a replay", async function () {
      const { req, sig } = await relayReq(alice, A.Predict, data);
      await hub.connect(relayer).relay(req, sig, NO_PERMIT);
      await expect(hub.connect(relayer).relay(req, sig, NO_PERMIT))
        .to.be.revertedWithCustomError(hub, "BadInput");
    });

    it("refuses another user's signature over the same request", async function () {
      const req = {
        user: alice.address, action: A.Predict, data, fee: ONE,
        relayer: relayer.address, nonce: 0n, deadline: FAR_FUTURE,
      };
      const sig = await signRelay(hub, bob, req); // bob signs for alice
      await expect(hub.connect(relayer).relay(req, sig, NO_PERMIT))
        .to.be.revertedWithCustomError(hub, "BadRelaySignature");
    });
  });

  describe("Claim", function () {
    it("pays the fee out of the claim itself — a zero-balance wallet can claim", async function () {
      // Alice wins a round on stream1, then empties her wallet entirely.
      await registry.setValue(stream1, 100);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(1) }]);
      await advanceToNextRound();
      await registry.setValue(stream1, 150); // UP was correct
      await advanceToNextRound();
      await registry.setValue(stream1, 200);
      await engine.settlePrediction(alice.address, stream1);

      await token.connect(alice).transfer(carol.address, await token.balanceOf(alice.address));
      expect(await token.balanceOf(alice.address)).to.equal(0n);

      const data = abi.encode(["address"], [alice.address]);
      const { req, sig } = await relayReq(alice, A.Claim, data);
      const relayerBefore = await token.balanceOf(relayer.address);
      await hub.connect(relayer).relay(req, sig, NO_PERMIT);

      expect(await token.balanceOf(relayer.address)).to.equal(relayerBefore + ONE);
      expect(await token.balanceOf(alice.address)).to.be.gt(0n); // proceeds minus fee
    });
  });

  describe("Claim fee comes out of the claim", function () {
    async function aliceWinsThenPredictsAgain() {
      await registry.setValue(stream1, 100);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(1) }]);
      await advanceToNextRound();
      await registry.setValue(stream1, 150);
      await advanceToNextRound();
      await registry.setValue(stream1, 200);
      await engine.settlePrediction(alice.address, stream1);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(1) }]);
    }

    it("a wallet locked by a prediction can still claim: the fee is minted from the bucket", async function () {
      await aliceWinsThenPredictsAgain();
      const claimData = abi.encode(["address"], [alice.address]);
      const bucket = await rewards.unclaimedRewards(alice.address);
      const aliceBefore = await token.balanceOf(alice.address);
      const relayerBefore = await token.balanceOf(relayer.address);
      const { req, sig } = await relayReq(alice, A.Claim, claimData);

      await hub.connect(relayer).relay(req, sig, NO_PERMIT);

      expect(await token.balanceOf(relayer.address)).to.equal(relayerBefore + ONE);
      expect(await token.balanceOf(alice.address)).to.equal(aliceBefore + bucket - ONE);
      expect(await rewards.unclaimedRewards(alice.address)).to.equal(0n);
    });

    it("a fee larger than the bucket refuses, takes nothing and keeps the nonce", async function () {
      await aliceWinsThenPredictsAgain();
      const claimData = abi.encode(["address"], [alice.address]);
      const bucket = await rewards.unclaimedRewards(alice.address);
      const { req, sig } = await relayReq(alice, A.Claim, claimData, { fee: bucket + 1n });

      await expect(hub.connect(relayer).relay(req, sig, NO_PERMIT))
        .to.be.revertedWithCustomError(rewards, "BadInput");
      expect(await rewards.unclaimedRewards(alice.address)).to.equal(bucket);
      expect(await hub.relayNonces(alice.address)).to.equal(0n);
    });

    it("a zero fee claims the whole bucket", async function () {
      await aliceWinsThenPredictsAgain();
      const claimData = abi.encode(["address"], [alice.address]);
      const bucket = await rewards.unclaimedRewards(alice.address);
      const aliceBefore = await token.balanceOf(alice.address);
      const { req, sig } = await relayReq(alice, A.Claim, claimData, { fee: 0n });

      await hub.connect(relayer).relay(req, sig, NO_PERMIT);

      expect(await token.balanceOf(alice.address)).to.equal(aliceBefore + bucket);
    });
  });

  describe("Transfer", function () {
    it("relays a plain SATORI transfer", async function () {
      const amount = ethers.parseEther("5");
      const data = abi.encode(["address", "uint256"], [carol.address, amount]);
      const { req, sig } = await relayReq(alice, A.Transfer, data);

      const aliceBefore = await token.balanceOf(alice.address);
      const carolBefore = await token.balanceOf(carol.address);
      await hub.connect(relayer).relay(req, sig, NO_PERMIT);

      expect(await token.balanceOf(carol.address)).to.equal(carolBefore + amount);
      expect(await token.balanceOf(alice.address)).to.equal(aliceBefore - amount - ONE);
    });
  });

  describe("Vote", function () {
    it("relays a burn-to-vote as the signer", async function () {
      const amount = ethers.parseEther("10");
      const data = abi.encode(["uint32", "uint256"], [stream1, amount]);
      const { req, sig } = await relayReq(alice, A.Vote, data);

      const supplyBefore = await token.totalSupply();
      const weightBefore = await voting.voterGameWeight(alice.address, stream1);
      await hub.connect(relayer).relay(req, sig, NO_PERMIT);

      expect(await token.totalSupply()).to.equal(supplyBefore - amount); // burned
      expect(await voting.voterGameWeight(alice.address, stream1)).to.be.gt(weightBefore);
    });
  });

  describe("Delegation and settings", function () {
    it("relays delegatePredictionPower", async function () {
      const data = abi.encode(["address"], [bob.address]);
      const { req, sig } = await relayReq(alice, A.DelegatePrediction, data);
      await hub.connect(relayer).relay(req, sig, NO_PERMIT);
      const [delegate] = await rewards.predictionDelegateInfo(alice.address);
      expect(delegate).to.equal(bob.address);
    });

    it("relays setAllowedDelegator", async function () {
      const data = abi.encode(["address"], [bob.address]);
      const { req, sig } = await relayReq(alice, A.SetAllowedDelegator, data);
      await hub.connect(relayer).relay(req, sig, NO_PERMIT);
      expect(await hub.allowedDelegator(alice.address)).to.equal(bob.address);
    });

    it("relays setPredictorFee, and the set-once lock still holds", async function () {
      const data = abi.encode(["uint16"], [500]);
      const { req, sig } = await relayReq(alice, A.SetPredictorFee, data);
      await hub.connect(relayer).relay(req, sig, NO_PERMIT);
      expect(await rewards.predictorFeeStored(alice.address)).to.equal(500);
      await expect(rewards.connect(alice).setPredictorFee(300))
        .to.be.revertedWithCustomError(rewards, "AlreadySet");
    });

    it("still gates relayed actions on the USER's capability, not the relayer's", async function () {
      await rewards.connect(owner).setCapabilities(0); // all off; owner (admin) is exempt
      const data = abi.encode(["address"], [bob.address]);
      const { req, sig } = await relayReq(alice, A.DelegatePrediction, data);
      await expect(hub.connect(relayer).relay(req, sig, NO_PERMIT))
        .to.be.revertedWithCustomError(hub, "CapabilityDisabled");
    });
  });
});
