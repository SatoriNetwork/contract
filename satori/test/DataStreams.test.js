const { expect } = require("chai");

// initializeDefaultStream() creates the default stream (id 1) AND its derived
// family (ids 2..4, the [28,183,731] ladder). So user streams start at 5.
const GENESIS_STREAMS = 1;
const { deploySatoriFixture } = require("./fixtures");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

// The registry's value mechanics (the cadence guards and the history ring) are
// what this file pins, so the streams below are created the way a real public
// user gets them: the 2-arg `createSimpleDataStream` overload, which defaults to
// cadence 2 (daily — the finest cadence a non-admin may create). One cadence
// period is therefore TWO rounds / 24h, and every re-write of a stream's value
// must be spaced by CADENCE_SECONDS.
const ROUND = 86400;                            // 24h — one round
const CADENCE_ROUNDS = 2;                       // daily
const CADENCE_SECONDS = ROUND * CADENCE_ROUNDS; // 24h — one cadence period

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

describe("DataStream Registry", function () {
  let satori, registry;
  let owner;
  let authority1;
  let authority2;
  let user1;
  let user2;

  beforeEach(async function () {
    [owner, authority1, authority2, user1, user2] = await ethers.getSigners();

    const fix = await deploySatoriFixture();
    satori = fix.satori;
    registry = fix.registry;

    // Fund authorities so they can pay the STREAM_CREATION_FEE (1 SATORI per create)
    await satori.transfer(authority1.address, ethers.parseEther("100"));
    await satori.transfer(authority2.address, ethers.parseEther("100"));
  });

  describe("Registry Structure", function () {
    it("has a 2-way DataStreamType taxonomy (Simple=0, Adapter=1)", async function () {
      // The restructure collapsed the monolith's 4-way STREAM_TYPE_* constants
      // (Simple/Custom/Uniswap/Chainlink) into a 2-way enum in SatoriTypes:
      // { Simple = 0, Adapter = 1 } — Custom/Uniswap/Chainlink are all pull-based
      // Adapter streams now. Verify the taxonomy via the streamType each creates.
      await satori.connect(owner)["createSimpleDataStream(string,address)"]("SimpleT", authority1.address);
      const simpleId = Number(await registry.getDataStreamCount());
      expect((await registry.getDataStreamInfo(simpleId))[2]).to.equal(0); // Simple

      // Custom adapter (id 3, registered by the fixture); any non-zero target
      // passes CustomAdapter.validate, which is all creation needs.
      await satori.connect(owner)["createAdapterDataStream(string,uint16,address,bytes)"](
        "AdapterT", 3, authority1.address, "0x"
      );
      const adapterId = Number(await registry.getDataStreamCount());
      expect((await registry.getDataStreamInfo(adapterId))[2]).to.equal(1); // Adapter
    });

    it("Should track registry entries", async function () {
      // The fixture calls initializeDefaultStream() (matching deploy.js), which
      // creates the default stream at id 1 and nothing else (the derived family
      // it used to spawn at ids 2..4 was deleted 2026-09-06). So the registry
      // starts with GENESIS_STREAMS entries and the first stream a test creates
      // is id 2.
      const count = await registry.getDataStreamCount();
      expect(count).to.equal(GENESIS_STREAMS);
      expect((await registry.getDataStreamInfo(1))[5]).to.equal(true); // exists
    });
  });

  describe("Simple DataStream Creation", function () {
    it("Should create a Simple datastream", async function () {
      const name = "Temperature NYC";

      const tx = await satori.connect(authority1).createSimpleDataStream(
        name,
        authority1.address
      );
      const streamId = await getStreamIdFromTx(tx, satori);

      // Verify it was created
      const info = await registry.getDataStreamInfo(streamId);
      expect(info[0]).to.equal(name);  // name
      expect(info[1]).to.equal(authority1.address);  // provider (was authority; same position)
      expect(info[2]).to.equal(0);  // streamType (Simple = 0)
      expect(info[3]).to.equal(0n);  // value (int256) — position shifted down after target field removal
      expect(info[4]).to.equal(0);  // valueHour
      expect(info[5]).to.equal(true);  // exists
    });

    it("Should increment streamId sequentially", async function () {
      const tx1 = await satori.connect(authority1).createSimpleDataStream(
        "Stream1",
        authority1.address
      );
      const streamId1 = await getStreamIdFromTx(tx1, satori);
      // The default FAMILY occupies ids 1..4, so the first stream a test
      // creates is GENESIS_STREAMS + 1.
      expect(streamId1).to.equal(GENESIS_STREAMS + 1);

      const tx2 = await satori.connect(authority2).createSimpleDataStream(
        "Stream2",
        authority2.address
      );
      const streamId2 = await getStreamIdFromTx(tx2, satori);
      expect(streamId2).to.equal(GENESIS_STREAMS + 2);
    });

    // The creation record is the whole StreamMeta plus who created it, so an
    // indexer never has to read `streams(id-1)` (docs/issues/events-are-the-read-model.md).
    it("Should emit DataStreamCreated with the full creation record", async function () {
      const name = "BTC/USD";

      await expect(
        satori.connect(authority1).createSimpleDataStream(
          name,
          authority2.address
        )
      )
        .to.emit(registry, "DataStreamCreated")
        // creator is the hub's caller, provider is the key the stream was given;
        // adapterId 0 = Simple, cadence is the 2-arg overload's daily default.
        .withArgs(GENESIS_STREAMS + 1, authority1.address, authority2.address, 0, 1440, "0x", name);
    });

    it("emits the adapter stream's adapterId, config and cadence at creation", async function () {
      const config = ethers.AbiCoder.defaultAbiCoder().encode(["uint64"], [3600]);
      await expect(
        satori.connect(owner)["createAdapterDataStream(string,uint16,address,bytes,uint24)"](
          "Custom", 3, authority1.address, config, 2880
        )
      )
        .to.emit(registry, "DataStreamCreated")
        .withArgs(GENESIS_STREAMS + 1, owner.address, authority1.address, 3, 2880, config, "Custom");
    });

    it("records the hub as the default stream's creator and provider", async function () {
      const hub = await satori.getAddress();
      const [log] = await registry.queryFilter(registry.filters.DataStreamCreated(1));
      expect(log.args.creator).to.equal(hub);
      expect(log.args.provider).to.equal(hub);
      expect(log.args.adapterId).to.equal(0);
      expect(log.args.minCadenceMinutes).to.equal(1440);
    });

    it("Should increment datastream count", async function () {
      // Baseline is the default stream + its 3 derived children.
      expect(await registry.getDataStreamCount()).to.equal(GENESIS_STREAMS);

      await satori.createSimpleDataStream("Stream1", authority1.address);
      expect(await registry.getDataStreamCount()).to.equal(GENESIS_STREAMS + 1);

      await satori.createSimpleDataStream("Stream2", authority2.address);
      expect(await registry.getDataStreamCount()).to.equal(GENESIS_STREAMS + 2);
    });
  });

  describe("Value Management", function () {
    let streamId;

    beforeEach(async function () {
      const tx = await satori.connect(authority1).createSimpleDataStream(
        "Test Stream",
        authority1.address
      );
      streamId = await getStreamIdFromTx(tx, satori);
    });

    it("Should allow authority to update value", async function () {
      const newValue = 42000;
      await registry.connect(authority1).setValue(streamId, newValue);

      const info = await registry.getDataStreamInfo(streamId);
      expect(info[3]).to.equal(BigInt(newValue)); // value is int256
    });

    it("Should prevent non-authority from updating value", async function () {
      await expect(
        registry.connect(user1).setValue(streamId, 123)
      ).to.be.revertedWithCustomError(registry, "NotStreamProvider");
    });

    it("Should store value history in circular buffer", async function () {
      // Update value multiple times
      await registry.connect(authority1).setValue(streamId, 100);
      await time.increase(CADENCE_SECONDS); // Advance one cadence period (2 rounds)
      await registry.connect(authority1).setValue(streamId, 200);
      await time.increase(CADENCE_SECONDS); // Advance one cadence period (2 rounds)
      await registry.connect(authority1).setValue(streamId, 300);

      // Get history
      const history = await registry.getRecentHistory(streamId);
      expect(history[0].length).to.be.at.least(2);  // values array
      expect(history[0][0]).to.equal(100n);
      expect(history[0][1]).to.equal(200n);
    });

    it("Should handle 3+ updates (circular buffer)", async function () {
      // Update 5 times to test circular buffer (max 3)
      for (let i = 1; i <= 5; i++) {
        await registry.connect(authority1).setValue(streamId, i * 100);
        await time.increase(CADENCE_SECONDS); // one cadence period, to allow the next setValue
      }

      const history = await registry.getRecentHistory(streamId);
      expect(history[0].length).to.equal(3); // Max 3 history (ValueState)
      expect(history[0][0]).to.equal(300n); // Oldest should be 3rd update (1-2 dropped)
      expect(history[0][2]).to.equal(500n); // Newest should be 5th
    });

    it("Should emit StreamValueUpdated event", async function () {
      const oldValue = 0; // Stream starts with value 0
      const newValue = 999;
      // The event's last arg is the absolute HOUR of the write (block.timestamp / 3600).
      const tx = await registry.connect(authority1).setValue(streamId, newValue);
      const rcpt = await tx.wait();
      const hour = BigInt((await ethers.provider.getBlock(rcpt.blockNumber)).timestamp) / 3600n;
      await expect(tx)
        .to.emit(registry, "StreamValueUpdated")
        .withArgs(streamId, oldValue, newValue, hour);
    });

    it("Should only work for Simple datastreams", async function () {
      // This test will be relevant when we add other types
      // For now, all streams are Simple, so this should work
      await registry.connect(authority1).setValue(streamId, 777);
      const info = await registry.getDataStreamInfo(streamId);
      expect(info[3]).to.equal(777n); // value field
    });
  });

  describe("Name Management", function () {
    let streamId;

    beforeEach(async function () {
      const tx = await satori.connect(authority1).createSimpleDataStream(
        "Original Name",
        authority1.address
      );
      streamId = await getStreamIdFromTx(tx, satori);
    });

    it("Should allow authority to change name", async function () {
      const newName = "Updated Name";
      await registry.connect(authority1).setDataStreamName(streamId, newName);

      const info = await registry.getDataStreamInfo(streamId);
      expect(info[0]).to.equal(newName); // name field
    });

    it("Should prevent non-authority from changing name", async function () {
      await expect(
        registry.connect(user1).setDataStreamName(streamId, "Hacked Name")
      ).to.be.revertedWithCustomError(registry, "NotStreamProvider");
    });

    it("Should not store name history", async function () {
      await registry.connect(authority1).setDataStreamName(streamId, "Name 1");
      await registry.connect(authority1).setDataStreamName(streamId, "Name 2");
      await registry.connect(authority1).setDataStreamName(streamId, "Name 3");

      // Only current name should be accessible
      const info = await registry.getDataStreamInfo(streamId);
      expect(info[0]).to.equal("Name 3");
      // No history function for names
    });

    it("Should emit NameUpdated event", async function () {
      const newName = "New Stream Name";
      await expect(registry.connect(authority1).setDataStreamName(streamId, newName))
        .to.emit(registry, "NameUpdated")
        .withArgs(streamId, newName);
    });
  });

  describe("Authority Management", function () {
    let streamId;

    beforeEach(async function () {
      const tx = await satori.connect(authority1).createSimpleDataStream(
        "Auth Test",
        authority1.address
      );
      streamId = await getStreamIdFromTx(tx, satori);
    });

    it("Should allow authority transfer", async function () {
      await registry.connect(authority1).setProvider(streamId, authority2.address);

      const info = await registry.getDataStreamInfo(streamId);
      expect(info[1]).to.equal(authority2.address); // authority field
    });

    it("Should prevent non-authority from transferring", async function () {
      await expect(
        registry.connect(user1).setProvider(streamId, user2.address)
      ).to.be.revertedWithCustomError(registry, "NotStreamProvider");
    });

    it("Should allow new authority to update after transfer", async function () {
      // Transfer authority
      await registry.connect(authority1).setProvider(streamId, authority2.address);

      // Old authority can't update
      await expect(
        registry.connect(authority1).setValue(streamId, 123)
      ).to.be.revertedWithCustomError(registry, "NotStreamProvider");

      // New authority can update
      await registry.connect(authority2).setValue(streamId, 456);
      const info = await registry.getDataStreamInfo(streamId);
      expect(info[3]).to.equal(456n); // value field
    });

    it("Should emit ProviderChanged event", async function () {
      await expect(registry.connect(authority1).setProvider(streamId, authority2.address))
        .to.emit(registry, "ProviderChanged")
        .withArgs(streamId, authority1.address, authority2.address);
    });

    it("Should not allow transfer to zero address", async function () {
      await expect(
        registry.connect(authority1).setProvider(streamId, ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(registry, "InvalidProvider");
    });
  });

  describe("Query Functions", function () {
    let stream1;
    let stream2;

    beforeEach(async function () {
      const tx1 = await satori.createSimpleDataStream(
        "Stream 1",
        authority1.address
      );
      stream1 = await getStreamIdFromTx(tx1, satori);

      const tx2 = await satori.createSimpleDataStream(
        "Stream 2",
        authority2.address
      );
      stream2 = await getStreamIdFromTx(tx2, satori);

      // Add some values
      await registry.connect(authority1).setValue(stream1, 100);
      await registry.connect(authority2).setValue(stream2, 200);
    });

    it("Should get current value", async function () {
      expect(await registry.getValue(stream1)).to.equal(100n);
      expect(await registry.getValue(stream2)).to.equal(200n);
    });

    it("Should get complete datastream info", async function () {
      const info = await registry.getDataStreamInfo(stream1);
      expect(info[0]).to.equal("Stream 1");  // name
      expect(info[1]).to.equal(authority1.address);  // authority
      expect(info[2]).to.equal(0);  // streamType (Simple = 0)
      expect(info[3]).to.equal(100n);  // value (int128)
    });

    it("Should return zero for non-existent stream", async function () {
      const invalidStreamId = 9999;
      expect(await registry.getValue(invalidStreamId)).to.equal(0n);
    });

    it("Should get recent history", async function () {
      // Add more values to stream1 (the beforeEach already wrote 100).
      // The ring is HOUR-keyed now: history[1] carries each write's absolute
      // hour (block.timestamp / 3600), read back via getLatestUpdateInfo.
      const hour100 = (await registry.getLatestUpdateInfo(stream1))[1];
      await time.increase(CADENCE_SECONDS); // one cadence period — stream1 already has a value
      await registry.connect(authority1).setValue(stream1, 150);
      const hour150 = (await registry.getLatestUpdateInfo(stream1))[1];
      await time.increase(CADENCE_SECONDS); // one cadence period
      await registry.connect(authority1).setValue(stream1, 175);
      const hour175 = (await registry.getLatestUpdateInfo(stream1))[1];

      const history = await registry.getRecentHistory(stream1);
      // WHY THIS CHANGED: the old body only asserted
      // `history[1].length == history[0].length`, but getRecentHistory
      // allocates BOTH arrays from one local `viewCount`
      // (SatoriRegistry.sol ~1313-1314), so the two lengths are equal on every
      // path — an x == x check that pinned no history behaviour at all and
      // never looked at the three writes above. Assert the actual
      // (value, hour) pairs, oldest → newest, per the NatSpec contract
      // "Array of up to 3 historical values (oldest to newest)".
      expect(history[0].length).to.equal(3);  // values array: exactly the 3 writes
      expect(history[1].length).to.equal(3);  // hours array: one per value
      expect([...history[0]]).to.deep.equal([100n, 150n, 175n]);
      expect([...history[1]]).to.deep.equal([hour100, hour150, hour175]);
      // The three writes landed in three distinct, strictly increasing hours.
      expect(hour150).to.be.gt(hour100);
      expect(hour175).to.be.gt(hour150);
    });

    it("Should enumerate all datastreams", async function () {
      const streams = await registry.getAllDataStreams();
      // The default family (ids 1..4) plus the two created in beforeEach.
      expect(streams.length).to.equal(GENESIS_STREAMS + 2);
      for (let i = 0; i < GENESIS_STREAMS; i++)
        expect(streams[i]).to.equal(i + 1); // default base then its children
      expect(streams[GENESIS_STREAMS]).to.equal(stream1);
      expect(streams[GENESIS_STREAMS + 1]).to.equal(stream2);
    });
  });
});
