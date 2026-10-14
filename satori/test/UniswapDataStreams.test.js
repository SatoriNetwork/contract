// NOTE: the tickCumulative literals below are scaled to the adapter's TWAP
// window. They were chosen against the old 28800s (8h) window and were divided
// by 16 when it became 1800s (30m) on 2026-09-04, so the EXPECTED TICK values in
// these tests are unchanged. tick = tickCumulativeDelta / TWAP_WINDOW.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const {
  deploySatoriFixture,
  createUniswapStream,
  createCustomStream,
} = require("./fixtures");

const STREAM_TYPE_ADAPTER = 1;

// These Uniswap adapter (pull) streams come from the 4-arg
// `createAdapterDataStream` helper, which now defaults to cadence 2 (daily) —
// what a real public user gets. `updateValue` obeys the same two cadence guards
// as `setValue`, so a re-pull is legal only one full cadence period (TWO rounds
// / 24h) after the previous one.
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

describe("Uniswap TWAP DataStreams", function () {
  let satori, registry, mockUniswapPool, uniswapAdapter;
  let owner, authority, user1;

  beforeEach(async function () {
    const fix = await loadFixture(deploySatoriFixture);
    ({ satori, registry, owner, uniswapAdapter } = fix);
    [, authority, user1] = fix.signers;

    const MockUniswapV3Pool = await ethers.getContractFactory("MockUniswapV3Pool");
    mockUniswapPool = await MockUniswapV3Pool.deploy();
    await mockUniswapPool.waitForDeployment();
  });

  describe("Stream Creation", function () {
    it("Should create Uniswap stream with valid pool", async function () {
      // Set tick cumulatives to make the pool valid
      await mockUniswapPool.setTickCumulatives(0, 1000000);

      const tx = await createUniswapStream(satori, "ETH/USDC Pool TWAP",
        await mockUniswapPool.getAddress(),
        authority.address
      );
      const streamId = await getStreamIdFromTx(tx, satori);

      const info = await registry.getDataStreamInfo(streamId);

      expect(info[0]).to.equal("ETH/USDC Pool TWAP");  // name
      // For adapter streams, `provider` IS the data-source contract (the pool).
      expect(info[1]).to.equal(await mockUniswapPool.getAddress());  // provider == pool address
      expect(info[2]).to.equal(1); // streamType: Adapter = 1
    });

    it("Should reject invalid pool address (zero address)", async function () {
      // Under §3.4, provider IS the pool for adapter streams; the registry's
      // provider == 0 guard fires before the adapter's InvalidPool check.
      await expect(
        createUniswapStream(satori, "Invalid Pool",
          ethers.ZeroAddress,
          authority.address)
      ).to.be.revertedWithCustomError(registry, "InvalidProvider");
    });

    // Old test "Should reject invalid authority address" was removed —
    // under §3.4 adapter streams have no separate authority field; the
    // provider IS the data source, and the only zero-check is on the
    // provider itself (covered by the test above).

    it("Should reject non-pool contract (invalid pool)", async function () {
      // A contract that doesn't implement the V3 pool surface fails one of
      // the adapter's view-call checks (fee/slot0/observations/observe).
      // The exact revert path depends on check ordering; just require revert.
      await expect(
        createUniswapStream(satori, "Invalid Pool",
          await satori.getAddress(),
          authority.address
        )
      ).to.be.reverted;
    });
  });

  describe("TWAP Reading", function () {
    let streamId;

    beforeEach(async function () {
      // Set initial tick cumulatives
      await mockUniswapPool.setTickCumulatives(0, 1000000);

      const tx = await createUniswapStream(satori, "ETH/USDC Pool TWAP",
        await mockUniswapPool.getAddress(),
        authority.address
      );
      streamId = await getStreamIdFromTx(tx, satori);
    });

    it("Should read TWAP from Uniswap pool", async function () {
      // Set tick cumulatives
      // Tick at 30m ago: 0
      // Tick now: 1800000 (1000 ticks * 1800 seconds)
      // Average tick: 1800000 / 1800 = 1000
      // Raw tick value returned directly (no scaling)
      await mockUniswapPool.setTickCumulatives(0, 1800000);

      // Update value
      await registry.connect(authority).updateValue(streamId);

      // Check value — raw tick (1000), direction preserved
      const info = await registry.getDataStreamInfo(streamId);
      const expectedValue = 1000n;
      expect(info[3]).to.equal(expectedValue);
    });

    it("Should update value when pool price changes", async function () {
      // First update - average tick = 500
      // tickCumulatives[0] = 0 (30m ago)
      // tickCumulatives[1] = 900000 (500 ticks * 1800 seconds)
      await mockUniswapPool.setTickCumulatives(0, 900000);
      await registry.connect(authority).updateValue(streamId);

      const info1 = await registry.getDataStreamInfo(streamId);
      const expectedValue1 = 500n;
      expect(info1[3]).to.equal(expectedValue1);

      // Advance one full cadence period — 2 rounds, clearing both the round
      // guard and the 23h30m wall-clock gap a cadence-2 stream imposes.
      await time.increase(CADENCE_SECONDS);

      // Price increases - average tick = 1000
      await mockUniswapPool.setTickCumulatives(0, 1800000);
      await registry.connect(authority).updateValue(streamId);

      const info2 = await registry.getDataStreamInfo(streamId);
      const expectedValue2 = 1000n;
      expect(info2[3]).to.equal(expectedValue2);

      // Verify value increased
      expect(info2[3]).to.be.greaterThan(info1[3]);
    });

    it("Should handle negative tick values", async function () {
      // Negative average tick = -500
      // tickCumulatives[0] = 0 (30m ago)
      // tickCumulatives[1] = -900000 (-500 ticks * 1800 seconds)
      await mockUniswapPool.setTickCumulatives(0, -900000);
      await registry.connect(authority).updateValue(streamId);

      const info = await registry.getDataStreamInfo(streamId);
      const expectedValue = -500n;
      expect(info[3]).to.equal(expectedValue);
    });

    it("Should track round transitions for Uniswap streams", async function () {
      // Set initial value - tick = 500
      await mockUniswapPool.setTickCumulatives(0, 900000);
      await registry.connect(authority).updateValue(streamId);

      const round0 = await satori.getCurrentRound();

      // Move on one full cadence period (2 rounds)
      const currentTime = await time.latest();
      const tomorrowMidnight = Math.floor(currentTime / 86400) * 86400 + 86400;
      await time.setNextBlockTimestamp(tomorrowMidnight + 1);
      await time.increase(CADENCE_SECONDS);

      // Update value one cadence on - tick = 1000
      await mockUniswapPool.setTickCumulatives(0, 1800000);
      await registry.connect(authority).updateValue(streamId);

      const round1 = await satori.getCurrentRound();

      // Check value change (should be UP)
      const change = await satori.getValueChange(streamId, round0, round1);
      expect(change).to.equal(1); // UP
    });

    it("Should not allow setValue for Uniswap streams", async function () {
      // Under §3.4 the provider check fires before the stream-type check.
      // For adapter streams `provider` is the data-source contract (the
      // pool), not a key-holding address, so any setValue call from any
      // signer reverts NotStreamProvider — there is no caller for whom
      // the gate would pass and reach the NotSimpleStream check.
      await expect(
        registry.connect(authority).setValue(streamId, 123)
      ).to.be.revertedWithCustomError(registry, "NotStreamProvider");
    });

    it("Should allow anyone to call updateValue (permissionless pull)", async function () {
      await mockUniswapPool.setTickCumulatives(0, 1800000);

      // Non-authority can trigger the pull — this prevents the authority from
      // timing the oracle read to their own predictive advantage.
      await expect(
        registry.connect(user1).updateValue(streamId)
      ).to.not.be.reverted;

      const info = await registry.getDataStreamInfo(streamId);
      expect(info[3]).to.equal(1000n);
    });
  });

  describe("Mixed Stream Types", function () {
    let simpleStream;
    let uniswapStream;
    let mockDataStream;
    let customStream;

    beforeEach(async function () {
      // Create a Simple stream
      let tx = await satori.createSimpleDataStream(
        "Simple",
        authority.address
      );
      simpleStream = await getStreamIdFromTx(tx, satori);

      // Create a Uniswap stream
      await mockUniswapPool.setTickCumulatives(0, 1000000);
      tx = await createUniswapStream(satori, "Uniswap TWAP",
        await mockUniswapPool.getAddress(),
        authority.address
      );
      uniswapStream = await getStreamIdFromTx(tx, satori);

      // Create a Custom stream
      const MockDataStream = await ethers.getContractFactory("MockDataStream");
      mockDataStream = await MockDataStream.deploy();
      await mockDataStream.waitForDeployment();

      tx = await createCustomStream(satori, "Custom",
        await mockDataStream.getAddress(),
        authority.address
      );
      customStream = await getStreamIdFromTx(tx, satori);
    });

    it("Should handle different update methods for different types", async function () {
      // Simple: use setValue
      await registry.connect(authority).setValue(simpleStream, 100);

      // Uniswap: use updateValue
      await mockUniswapPool.setTickCumulatives(0, 1800000);
      await registry.connect(authority).updateValue(uniswapStream);

      // Custom: use updateValue
      await mockDataStream.setValue(300);
      await registry.connect(authority).updateValue(customStream);

      // Verify all values
      expect((await registry.getDataStreamInfo(simpleStream))[3]).to.equal(100n);

      const expectedUniswapValue = 1000n;
      expect((await registry.getDataStreamInfo(uniswapStream))[3]).to.equal(expectedUniswapValue);

      expect((await registry.getDataStreamInfo(customStream))[3]).to.equal(300n);
    });

    it("Should enforce correct update method for each type", async function () {
      // Can't use updateValue on Simple
      await expect(
        registry.connect(authority).updateValue(simpleStream)
      ).to.be.revertedWithCustomError(registry, "NotPullStream");

      // Can't use setValue on Uniswap — under §3.4 the provider check fires
      // first; the adapter's provider is the pool contract, not a signer.
      await expect(
        registry.connect(authority).setValue(uniswapStream, 123)
      ).to.be.revertedWithCustomError(registry, "NotStreamProvider");

      // Can't use setValue on Custom — same as above.
      await expect(
        registry.connect(authority).setValue(customStream, 456)
      ).to.be.revertedWithCustomError(registry, "NotStreamProvider");
    });
  });

  describe("Multiple Uniswap Streams", function () {
    it("Should allow multiple Uniswap streams with different pools", async function () {
      // Create first pool and stream
      await mockUniswapPool.setTickCumulatives(0, 1800000);
      const tx1 = await createUniswapStream(satori, "ETH/USDC",
        await mockUniswapPool.getAddress(),
        authority.address
      );
      const stream1 = await getStreamIdFromTx(tx1, satori);

      // Create second pool and stream
      const MockUniswapV3Pool2 = await ethers.getContractFactory("MockUniswapV3Pool");
      const mockPool2 = await MockUniswapV3Pool2.deploy();
      await mockPool2.waitForDeployment();
      await mockPool2.setTickCumulatives(0, 900000);

      const tx2 = await createUniswapStream(satori, "WBTC/USDC",
        await mockPool2.getAddress(),
        authority.address
      );
      const stream2 = await getStreamIdFromTx(tx2, satori);

      // Should have different IDs
      expect(stream1).to.not.equal(stream2);

      // Update both
      await registry.connect(authority).updateValue(stream1);
      await registry.connect(authority).updateValue(stream2);

      // Verify different values
      const value1 = (await registry.getDataStreamInfo(stream1))[3];
      const value2 = (await registry.getDataStreamInfo(stream2))[3];

      const expectedValue1 = 1000n;
      const expectedValue2 = 500n;

      expect(value1).to.equal(expectedValue1);
      expect(value2).to.equal(expectedValue2);
      expect(value1).to.not.equal(value2);
    });
  });

  describe("Edge Cases", function () {
    it("Should handle zero tick cumulative delta", async function () {
      // Same tick value at both times (no price movement)
      await mockUniswapPool.setTickCumulatives(1000000, 1000000);

      const tx = await createUniswapStream(satori, "Stable Pool",
        await mockUniswapPool.getAddress(),
        authority.address
      );
      const streamId = await getStreamIdFromTx(tx, satori);

      await registry.connect(authority).updateValue(streamId);

      const info = await registry.getDataStreamInfo(streamId);
      expect(info[3]).to.equal(0n); // Average tick = 0
    });

    it("Should handle large tick values", async function () {
      // Large positive tick = 10000
      // tickCumulatives[1] - tickCumulatives[0] = 10000 * 1800 = 18000000
      // Raw tick returned directly
      await mockUniswapPool.setTickCumulatives(0, 18000000);

      const tx = await createUniswapStream(satori, "High Price Pool",
        await mockUniswapPool.getAddress(),
        authority.address
      );
      const streamId = await getStreamIdFromTx(tx, satori);

      await registry.connect(authority).updateValue(streamId);

      const info = await registry.getDataStreamInfo(streamId);
      const expectedValue = 10000n;
      expect(info[3]).to.equal(expectedValue);
    });

    it("Should handle tick cumulative decrease (negative price movement)", async function () {
      // tickCumulatives[0] = 1800000 (30m ago)
      // tickCumulatives[1] = 0 (now)
      // Delta = -1800000
      // Average tick = -1000
      await mockUniswapPool.setTickCumulatives(1800000, 0);

      const tx = await createUniswapStream(satori, "Declining Pool",
        await mockUniswapPool.getAddress(),
        authority.address
      );
      const streamId = await getStreamIdFromTx(tx, satori);

      await registry.connect(authority).updateValue(streamId);

      const info = await registry.getDataStreamInfo(streamId);
      const expectedValue = -1000n;
      expect(info[3]).to.equal(expectedValue);
    });
  });
});
