const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const {
  deploySatoriFixture,
  createCustomStream,
  createChainlinkStream,
} = require("./fixtures");

const STREAM_TYPE_ADAPTER = 1;

// These adapter (pull) streams are created through the 4-arg
// `createAdapterDataStream` helper, which now defaults to cadence 2 (daily) —
// what a real public user gets. `updateValue` is bound by the same two cadence
// guards as `setValue`, so a re-pull is only legal one full cadence period
// (TWO rounds / 24h) after the previous one.
const ROUND = 86400;                            // 24h — one round
const CADENCE_ROUNDS = 2;                       // daily
const CADENCE_SECONDS = ROUND * CADENCE_ROUNDS; // 24h — one cadence period

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
  return satoriContract.interface.parseLog(event).args.streamId;
}

describe("External DataStreams (via adapters)", function () {
  let satori, registry;
  let mockDataStream, mockChainlink;
  let owner, authority, user1;

  beforeEach(async function () {
    const fix = await loadFixture(deploySatoriFixture);
    ({ satori, registry, owner } = fix);
    [, authority, user1] = fix.signers;

    const MockDataStream = await ethers.getContractFactory("MockDataStream");
    mockDataStream = await MockDataStream.deploy();
    await mockDataStream.waitForDeployment();

    const MockChainlinkAggregator = await ethers.getContractFactory("MockChainlinkAggregator");
    mockChainlink = await MockChainlinkAggregator.deploy();
    await mockChainlink.waitForDeployment();
  });

  describe("Custom DataStream (CustomAdapter)", function () {
    let streamId;

    beforeEach(async function () {
      const tx = await createCustomStream(
        satori, "Custom Test Stream", await mockDataStream.getAddress(), authority.address
      );
      streamId = await getStreamIdFromTx(tx, satori);
    });

    it("Should create an Adapter-type stream backed by CustomAdapter", async function () {
      const info = await registry.getDataStreamInfo(streamId);
      expect(info[0]).to.equal("Custom Test Stream");
      // Under §3.4 the provider for adapter streams is the data-source
      // contract (the IDataStream mock), not a key-holding address.
      expect(info[1]).to.equal(await mockDataStream.getAddress());
      expect(info[2]).to.equal(STREAM_TYPE_ADAPTER);
    });

    it("Should update value via the custom contract", async function () {
      await mockDataStream.setValue(42000);
      await registry.connect(authority).updateValue(streamId);
      const info = await registry.getDataStreamInfo(streamId);
      expect(info[3]).to.equal(42000n);
    });

    it("Should track round transitions for Custom streams", async function () {
      await mockDataStream.setValue(100);
      await registry.connect(authority).updateValue(streamId);
      const round0 = await satori.getCurrentRound();

      const currentTime = await time.latest();
      const nextRoundBoundary = Math.floor(currentTime / 86400) * 86400 + 86400;
      await time.setNextBlockTimestamp(nextRoundBoundary + 1);
      await time.increase(CADENCE_SECONDS); // one cadence period (2 rounds)

      await mockDataStream.setValue(150);
      await registry.connect(authority).updateValue(streamId);
      const round1 = await satori.getCurrentRound();

      const change = await satori.getValueChange(streamId, round0, round1);
      expect(change).to.equal(1); // UP from 100 to 150
    });

    it("Should not allow setValue for Adapter streams", async function () {
      // Under §3.4, the provider check fires before stream-type. For
      // adapter streams `provider` is the data-source contract; no signer
      // can satisfy the provider gate, so the revert is NotStreamProvider.
      await expect(
        registry.connect(authority).setValue(streamId, 123)
      ).to.be.revertedWithCustomError(registry, "NotStreamProvider");
    });
  });

  describe("Chainlink DataStream (ChainlinkV3Adapter)", function () {
    let streamId;

    beforeEach(async function () {
      const tx = await createChainlinkStream(
        satori, "ETH/USD Feed", await mockChainlink.getAddress(), authority.address
      );
      streamId = await getStreamIdFromTx(tx, satori);
    });

    it("Should create an Adapter-type stream backed by ChainlinkV3Adapter", async function () {
      const info = await registry.getDataStreamInfo(streamId);
      expect(info[0]).to.equal("ETH/USD Feed");
      // Under §3.4 the provider for adapter streams is the data-source
      // contract (the Chainlink feed), not a key-holding address.
      expect(info[1]).to.equal(await mockChainlink.getAddress());
      expect(info[2]).to.equal(STREAM_TYPE_ADAPTER);
    });

    it("Should update value from Chainlink aggregator", async function () {
      await mockChainlink.setAnswer(300000000000n); // $3000 with 8 decimals
      await registry.connect(authority).updateValue(streamId);
      const info = await registry.getDataStreamInfo(streamId);
      expect(info[3]).to.equal(300000000000n);
    });

    it("Should revert on second updateValue in same round", async function () {
      await mockChainlink.setAnswer(3000n);
      await registry.connect(authority).updateValue(streamId);

      await mockChainlink.setAnswer(3100n);
      await expect(
        registry.connect(authority).updateValue(streamId)
      ).to.be.revertedWithCustomError(registry, "CadenceRoundsNotElapsed");

      const info = await registry.getDataStreamInfo(streamId);
      expect(info[3]).to.equal(3000n);
    });
  });

  describe("Mixed Stream Types", function () {
    let simpleStream, customStream, chainlinkStream;

    beforeEach(async function () {
      let tx = await satori.createSimpleDataStream("Simple", authority.address);
      simpleStream = await getStreamIdFromTx(tx, satori);

      tx = await createCustomStream(
        satori, "Custom", await mockDataStream.getAddress(), authority.address
      );
      customStream = await getStreamIdFromTx(tx, satori);

      tx = await createChainlinkStream(
        satori, "Chainlink", await mockChainlink.getAddress(), authority.address
      );
      chainlinkStream = await getStreamIdFromTx(tx, satori);
    });

    it("Should handle different update methods for different types", async function () {
      await registry.connect(authority).setValue(simpleStream, 100);

      await mockDataStream.setValue(200);
      await registry.connect(authority).updateValue(customStream);

      await mockChainlink.setAnswer(300);
      await registry.connect(authority).updateValue(chainlinkStream);

      expect((await registry.getDataStreamInfo(simpleStream))[3]).to.equal(100n);
      expect((await registry.getDataStreamInfo(customStream))[3]).to.equal(200n);
      expect((await registry.getDataStreamInfo(chainlinkStream))[3]).to.equal(300n);
    });

    it("Should enforce correct update method for each type", async function () {
      await expect(
        registry.connect(authority).updateValue(simpleStream)
      ).to.be.revertedWithCustomError(registry, "NotPullStream");

      // Under §3.4 provider check fires before stream-type check.
      await expect(
        registry.connect(authority).setValue(customStream, 123)
      ).to.be.revertedWithCustomError(registry, "NotStreamProvider");

      await expect(
        registry.connect(authority).setValue(chainlinkStream, 456)
      ).to.be.revertedWithCustomError(registry, "NotStreamProvider");
    });
  });

  describe("Edge Cases", function () {
    it("Should handle non-existent stream", async function () {
      await expect(
        registry.connect(authority).updateValue(9999)
      ).to.be.revertedWithCustomError(registry, "InvalidStreamId");
    });

    it("Should allow multiple Custom streams with different targets", async function () {
      const MockDS2 = await ethers.getContractFactory("MockDataStream");
      const mock2 = await MockDS2.deploy();
      await mock2.waitForDeployment();

      const tx1 = await createCustomStream(
        satori, "First", await mockDataStream.getAddress(), authority.address
      );
      const stream1 = await getStreamIdFromTx(tx1, satori);

      const tx2 = await createCustomStream(
        satori, "Second", await mock2.getAddress(), authority.address
      );
      const stream2 = await getStreamIdFromTx(tx2, satori);

      expect(stream1).to.not.equal(stream2);

      await mockDataStream.setValue(100);
      await mock2.setValue(200);

      await registry.connect(authority).updateValue(stream1);
      await registry.connect(authority).updateValue(stream2);

      expect((await registry.getDataStreamInfo(stream1))[3]).to.equal(100n);
      expect((await registry.getDataStreamInfo(stream2))[3]).to.equal(200n);
    });
  });
});
