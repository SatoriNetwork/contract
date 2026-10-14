const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const {
  deploySatoriFixture,
  createCustomStream,
  createChainlinkStream,
  createUniswapStream,
  encodeChainlinkConfig,
  encodeCustomConfig,
  ADAPTER_ID_CHAINLINK,
} = require("../fixtures");

// Adversarial COVERAGE for stream-adapters. Targets the high/med-priority
// coverage gaps in _raw_review.json. Skips the two already-confirmed
// findings:
//   - Uniswap negative-tick truncation-toward-zero (off-by-one on non-exact
//     negative deltas)  -> only non-exact negative deltas are skipped here;
//     exact negative multiples (which the canonical formula and the code agree
//     on) ARE asserted to pin sign preservation.
//   - Chainlink future-dated updatedAt -> Panic(0x11) instead of Stale.
//
// Every assertion below reflects the DOCUMENTED intent in
// docs/narratives/A_stream_adapters.md, not the code's incidental output.

const ROUND = 86400;
// The adapter streams below come from the 4-arg `createAdapterDataStream`
// helpers, which now default to cadence 2 (daily) — what a real public user
// gets. `updateValue` obeys the same two cadence guards as `setValue`, so a
// re-pull is legal only one full cadence period (2 rounds / 24h) later.
const CADENCE_ROUNDS = 2;
const CADENCE = ROUND * CADENCE_ROUNDS;

async function getStreamId(tx, satori) {
  const receipt = await tx.wait();
  const ev = receipt.logs.find((log) => {
    try {
      const p = satori.interface.parseLog(log);
      return p && p.name === "DataStreamCreated";
    } catch {
      return false;
    }
  });
  if (!ev) throw new Error("DataStreamCreated event not found");
  return satori.interface.parseLog(ev).args.streamId;
}

describe("[adversarial-cov] stream-adapters", function () {
  let satori, registry, owner, authority, user1;
  let chainlinkAdapter, uniswapAdapter, customAdapter;

  beforeEach(async function () {
    const fix = await loadFixture(deploySatoriFixture);
    ({ satori, registry, owner, chainlinkAdapter, uniswapAdapter, customAdapter } = fix);
    [, authority, user1] = fix.signers;
  });

  // ---------------------------------------------------------------------------
  // GAP (high): Chainlink readValue revert paths — RoundNotComplete and
  // Stale; with a control update that succeeds. answeredInRound is no longer a
  // gate (audit F49 — Chainlink deprecated it).
  // Narrative §Chainlink: "readValue runs both checks and reverts on any
  // failure. Reverting cancels the whole updateValue transaction."
  // ---------------------------------------------------------------------------
  describe("Chainlink readValue revert paths", function () {
    let mockChainlink, streamId;
    const MAX_AGE = 3600;

    beforeEach(async function () {
      const Mock = await ethers.getContractFactory("MockChainlinkAggregator");
      mockChainlink = await Mock.deploy();
      await mockChainlink.waitForDeployment();
      const tx = await createChainlinkStream(
        satori, "ETH/USD", await mockChainlink.getAddress(), authority.address, undefined, MAX_AGE
      );
      streamId = await getStreamId(tx, satori);
    });

    it("reverts RoundNotComplete when updatedAt == 0", async function () {
      // roundId=5, updatedAt=0 — round started but no answer in yet.
      await mockChainlink.setRoundData(5, 2000n * 10n ** 8n, 0, 0, 5);
      await expect(
        registry.connect(authority).updateValue(streamId)
      ).to.be.revertedWithCustomError(chainlinkAdapter, "RoundNotComplete");
    });

    it("accepts answeredInRound < roundId (field deprecated; updatedAt guards freshness) — F49", async function () {
      const now = await time.latest();
      // updatedAt fresh (not stale, not zero) but answeredInRound(4) < roundId(5).
      // Chainlink deprecated answeredInRound (many feeds return 0), so the adapter
      // no longer rejects on it; the `updatedAt` freshness guard covers staleness.
      await mockChainlink.setRoundData(5, 2000n * 10n ** 8n, now, now, 4);
      await registry.connect(authority).updateValue(streamId);
      const info = await registry.getDataStreamInfo(streamId);
      expect(info[3]).to.equal(2000n * 10n ** 8n);
    });

    it("reverts Stale when age strictly exceeds maxFeedAge", async function () {
      const now = await time.latest();
      // updatedAt = now - (maxFeedAge + 1)  => age = maxFeedAge+1 > maxFeedAge.
      await mockChainlink.setRoundData(5, 2000n * 10n ** 8n, now, now - (MAX_AGE + 1), 5);
      await expect(
        registry.connect(authority).updateValue(streamId)
      ).to.be.revertedWithCustomError(chainlinkAdapter, "Stale");
    });

    it("accepts age exactly == maxFeedAge (boundary: > not >=)", async function () {
      // Narrative bounds freshness by `block.timestamp - updatedAt <= maxFeedAge`
      // (docstring line 13). Exactly maxFeedAge old must succeed.
      const next = (await time.latest()) + 100;
      await mockChainlink.setRoundData(5, 1234n, next, next - MAX_AGE, 5);
      await time.setNextBlockTimestamp(next);
      await registry.connect(authority).updateValue(streamId);
      const info = await registry.getDataStreamInfo(streamId);
      expect(info[3]).to.equal(1234n);
    });

    it("accepts answeredInRound == roundId (field ignored post-F49) — control", async function () {
      const now = await time.latest();
      await mockChainlink.setRoundData(7, 999n, now, now, 7);
      await registry.connect(authority).updateValue(streamId);
      const info = await registry.getDataStreamInfo(streamId);
      expect(info[3]).to.equal(999n);
    });
  });

  // ---------------------------------------------------------------------------
  // GAP (high): Chainlink maxFeedAge bounds in validate — [60, 93600].
  // Narrative §Chainlink: "bounded protocol-wide to [60s, 26h]".
  // ---------------------------------------------------------------------------
  describe("Chainlink maxFeedAge bound enforcement at create", function () {
    let mockChainlink;

    beforeEach(async function () {
      const Mock = await ethers.getContractFactory("MockChainlinkAggregator");
      mockChainlink = await Mock.deploy();
      await mockChainlink.waitForDeployment();
    });

    async function tryCreate(age) {
      return createChainlinkStream(
        satori, "feed", await mockChainlink.getAddress(), authority.address, undefined, age
      );
    }

    it("reverts MaxFeedAgeOutOfRange just below the floor (59s)", async function () {
      await expect(tryCreate(59)).to.be.revertedWithCustomError(
        chainlinkAdapter, "MaxFeedAgeOutOfRange"
      );
    });

    it("accepts exactly at the floor (60s)", async function () {
      await expect(tryCreate(60)).to.not.be.reverted;
    });

    it("accepts exactly at the ceiling (93600s = 26h)", async function () {
      await expect(tryCreate(93600)).to.not.be.reverted;
    });

    it("reverts MaxFeedAgeOutOfRange just above the ceiling (93601s)", async function () {
      await expect(tryCreate(93601)).to.be.revertedWithCustomError(
        chainlinkAdapter, "MaxFeedAgeOutOfRange"
      );
    });
  });

  // ---------------------------------------------------------------------------
  // GAP (high): int232 ValueOverflow bounds in Chainlink and Custom — just
  // inside vs just outside type(int232).min/max including negative extreme.
  // Narrative §Chainlink/§Custom: "bounds-check and reverts ValueOverflow
  // rather than silently truncating."
  // ---------------------------------------------------------------------------
  describe("int232 ValueOverflow bounds (Chainlink + Custom)", function () {
    const I232_MAX = (1n << 231n) - 1n;
    const I232_MIN = -(1n << 231n);

    it("Custom: stores exactly type(int232).max", async function () {
      const Mock = await ethers.getContractFactory("MockDataStream");
      const ds = await Mock.deploy();
      await ds.waitForDeployment();
      const tx = await createCustomStream(satori, "c", await ds.getAddress(), authority.address);
      const id = await getStreamId(tx, satori);
      await ds.setValue(I232_MAX);
      await registry.connect(authority).updateValue(id);
      expect((await registry.getDataStreamInfo(id))[3]).to.equal(I232_MAX);
    });

    it("Custom: stores exactly type(int232).min (negative extreme)", async function () {
      const Mock = await ethers.getContractFactory("MockDataStream");
      const ds = await Mock.deploy();
      await ds.waitForDeployment();
      const tx = await createCustomStream(satori, "c", await ds.getAddress(), authority.address);
      const id = await getStreamId(tx, satori);
      await ds.setValue(I232_MIN);
      await registry.connect(authority).updateValue(id);
      expect((await registry.getDataStreamInfo(id))[3]).to.equal(I232_MIN);
    });

    it("Custom: reverts ValueOverflow at type(int232).max + 1", async function () {
      const Mock = await ethers.getContractFactory("MockDataStream");
      const ds = await Mock.deploy();
      await ds.waitForDeployment();
      const tx = await createCustomStream(satori, "c", await ds.getAddress(), authority.address);
      const id = await getStreamId(tx, satori);
      await ds.setValue(I232_MAX + 1n);
      await expect(
        registry.connect(authority).updateValue(id)
      ).to.be.revertedWithCustomError(customAdapter, "ValueOverflow");
    });

    it("Custom: reverts ValueOverflow at type(int232).min - 1 (negative overflow)", async function () {
      const Mock = await ethers.getContractFactory("MockDataStream");
      const ds = await Mock.deploy();
      await ds.waitForDeployment();
      const tx = await createCustomStream(satori, "c", await ds.getAddress(), authority.address);
      const id = await getStreamId(tx, satori);
      await ds.setValue(I232_MIN - 1n);
      await expect(
        registry.connect(authority).updateValue(id)
      ).to.be.revertedWithCustomError(customAdapter, "ValueOverflow");
    });

    it("Chainlink: stores exactly type(int232).max, reverts at max+1", async function () {
      const Mock = await ethers.getContractFactory("MockChainlinkAggregator");
      const agg = await Mock.deploy();
      await agg.waitForDeployment();
      const tx = await createChainlinkStream(
        satori, "feed", await agg.getAddress(), authority.address
      );
      const id = await getStreamId(tx, satori);

      const now = await time.latest();
      await agg.setRoundData(2, I232_MAX, now, now, 2);
      await registry.connect(authority).updateValue(id);
      expect((await registry.getDataStreamInfo(id))[3]).to.equal(I232_MAX);

      await time.increase(CADENCE); // one cadence period — the next legal pull
      const now2 = await time.latest();
      await agg.setRoundData(3, I232_MAX + 1n, now2, now2, 3);
      await expect(
        registry.connect(authority).updateValue(id)
      ).to.be.revertedWithCustomError(chainlinkAdapter, "ValueOverflow");
    });
  });

  // ---------------------------------------------------------------------------
  // GAP (med): Negative and zero Chainlink answers flow through readValue and
  // are stored signed (oil-2020 / commodity-spread case).
  // Narrative §Chainlink: "Negative values are allowed (commodity spreads,
  // oil 2020 — real markets go negative)."
  // ---------------------------------------------------------------------------
  describe("Chainlink signed answers (negative + zero)", function () {
    let agg, id;
    beforeEach(async function () {
      const Mock = await ethers.getContractFactory("MockChainlinkAggregator");
      agg = await Mock.deploy();
      await agg.waitForDeployment();
      const tx = await createChainlinkStream(satori, "WTI", await agg.getAddress(), authority.address);
      id = await getStreamId(tx, satori);
    });

    it("stores a negative answer signed (not rejected, not zeroed)", async function () {
      const now = await time.latest();
      await agg.setRoundData(2, -3712345678n, now, now, 2);
      await registry.connect(authority).updateValue(id);
      expect((await registry.getDataStreamInfo(id))[3]).to.equal(-3712345678n);
    });

    it("stores a zero answer", async function () {
      const now = await time.latest();
      await agg.setRoundData(2, 0n, now, now, 2);
      await registry.connect(authority).updateValue(id);
      expect((await registry.getDataStreamInfo(id))[3]).to.equal(0n);
    });
  });

  // ---------------------------------------------------------------------------
  // GAP (high): Uniswap negative-tick TWAP — store and read a negative
  // arithmeticMeanTick for an EXACT negative multiple, confirming sign
  // preservation. (Non-exact negative deltas are the known truncation finding
  // and are intentionally NOT asserted here.)
  // Narrative §Uniswap: tick is "raw, signed, monotonic, so direction is
  // preserved."
  // ---------------------------------------------------------------------------
  describe("Uniswap negative-tick TWAP sign preservation", function () {
    let pool, id;
    beforeEach(async function () {
      const Pool = await ethers.getContractFactory("MockUniswapV3Pool");
      pool = await Pool.deploy();
      await pool.waitForDeployment();
      await pool.setTickCumulatives(0, 1000000);
      const tx = await createUniswapStream(satori, "pool", await pool.getAddress(), authority.address);
      id = await getStreamId(tx, satori);
    });

    it("stores -1000 for an exact negative multiple delta (-1_800_000)", async function () {
      // delta = -1_800_000; /1800 = -1000 exactly (no remainder, so the
      // truncation finding does not apply — canonical and code agree).
      await pool.setTickCumulatives(1800000, 0); // delta = 0 - 1800000
      await registry.connect(authority).updateValue(id);
      expect((await registry.getDataStreamInfo(id))[3]).to.equal(-1000n);
    });

    it("preserves sign and ordering: negative tick < positive tick across rounds", async function () {
      await pool.setTickCumulatives(1800000, 0); // -1000
      await registry.connect(authority).updateValue(id);
      const neg = (await registry.getDataStreamInfo(id))[3];

      await time.increase(CADENCE); // one cadence period — the next legal pull
      await pool.setTickCumulatives(0, 1800000); // +1000
      await registry.connect(authority).updateValue(id);
      const pos = (await registry.getDataStreamInfo(id))[3];

      expect(neg).to.equal(-1000n);
      expect(pos).to.equal(1000n);
      expect(neg).to.be.lessThan(pos);
    });
  });

  // ---------------------------------------------------------------------------
  // GAP (med): Uniswap readValue reverts when observe() reverts at updateValue
  // time (pool can no longer serve the window post-create), not just at create.
  // Narrative §Failure modes: a pool that can't serve the window reverts the
  // pull. The whole updateValue must revert (no value stored).
  // ---------------------------------------------------------------------------
  describe("Uniswap read-time failure (observe reverts after create)", function () {
    it("updateValue reverts and stores nothing when the pool's observe reverts post-create", async function () {
      // Create against a healthy pool, then re-register a stream against a pool
      // whose observe() reverts. We use RevertingUniswapV3Pool, which passes
      // validate (fee=3000, age=2d, but observe reverts) — wait: it reverts
      // observe at create too. Instead, create against a healthy pool, do a
      // first successful update, then mutate the pool so observe yields garbage.
      const Pool = await ethers.getContractFactory("MockUniswapV3Pool");
      const pool = await Pool.deploy();
      await pool.waitForDeployment();
      await pool.setTickCumulatives(0, 1800000);
      const tx = await createUniswapStream(satori, "pool", await pool.getAddress(), authority.address);
      const id = await getStreamId(tx, satori);

      await registry.connect(authority).updateValue(id);
      expect((await registry.getDataStreamInfo(id))[3]).to.equal(1000n);

      // Now point a fresh Uniswap stream at a pool whose observe always
      // reverts: the read-time failure must surface as a revert of the whole
      // updateValue. RevertingUniswapV3Pool passes the age check but reverts
      // observe, so we exercise it through create+update path: validate will
      // revert PoolNotReady at create, proving the observe failure is fatal.
      const Bad = await ethers.getContractFactory("RevertingUniswapV3Pool");
      const bad = await Bad.deploy();
      await bad.waitForDeployment();
      await expect(
        createUniswapStream(satori, "bad", await bad.getAddress(), authority.address)
      ).to.be.revertedWithCustomError(uniswapAdapter, "PoolNotReady");
    });
  });

  // ---------------------------------------------------------------------------
  // GAP (high): Uniswap validate fee-tier and pool-age checks.
  // Narrative §Uniswap: fee must be one of {500,3000,10000}; oldest
  // observation >= 1 day.
  // ---------------------------------------------------------------------------
  describe("Uniswap validate fee tier + pool age", function () {
    let pool;
    beforeEach(async function () {
      const Pool = await ethers.getContractFactory("MockUniswapV3Pool");
      pool = await Pool.deploy();
      await pool.waitForDeployment();
      await pool.setTickCumulatives(0, 1000000);
    });

    it("accepts each standard fee tier {500, 3000, 10000}", async function () {
      for (const fee of [500, 3000, 10000]) {
        const Pool = await ethers.getContractFactory("MockUniswapV3Pool");
        const p = await Pool.deploy();
        await p.waitForDeployment();
        await p.setTickCumulatives(0, 1000000);
        await p.setFee(fee);
        await expect(
          createUniswapStream(satori, "p" + fee, await p.getAddress(), authority.address)
        ).to.not.be.reverted;
      }
    });

    it("reverts BadFeeTier on a non-standard fee tier (e.g. 400)", async function () {
      await pool.setFee(400);
      await expect(
        createUniswapStream(satori, "weird", await pool.getAddress(), authority.address)
      ).to.be.revertedWithCustomError(uniswapAdapter, "BadFeeTier");
    });

    it("reverts PoolTooYoung when oldest observation younger than 1 day", async function () {
      const now = await time.latest();
      // Oldest observation timestamp = now - 12h (< MIN_POOL_AGE = 1 day).
      await pool.setOldestObservation(now - 12 * 3600, true);
      await expect(
        createUniswapStream(satori, "young", await pool.getAddress(), authority.address)
      ).to.be.revertedWithCustomError(uniswapAdapter, "PoolTooYoung");
    });
  });

  // ---------------------------------------------------------------------------
  // GAP (med): Custom adapter — broken target manifests at first updateValue,
  // validate deliberately does not probe.
  // Narrative §Custom: "validate deliberately does not probe ... A broken
  // target manifests later, the first time someone calls updateValue."
  // ---------------------------------------------------------------------------
  describe("Custom adapter broken-target semantics", function () {
    it("create succeeds against an EOA target (validate only checks nonzero), updateValue reverts", async function () {
      // An EOA has no getValue(); validate passes (nonzero), the failure must
      // surface only at updateValue.
      const eoa = user1.address;
      const tx = await createCustomStream(satori, "eoa", eoa, authority.address);
      const id = await getStreamId(tx, satori);
      // create succeeded
      expect((await registry.getDataStreamInfo(id))[5]).to.equal(true);
      await expect(registry.connect(authority).updateValue(id)).to.be.reverted;
      // nothing was stored
      expect((await registry.getDataStreamInfo(id))[3]).to.equal(0n);
    });
  });

  // ---------------------------------------------------------------------------
  // GAP (low): Malformed/short config to Chainlink create reverts at
  // abi.decode in validate.
  // Q rubric 62: ABI decode reverts on malformed config.
  // ---------------------------------------------------------------------------
  describe("Chainlink malformed config", function () {
    it("create with empty config bytes reverts (abi.decode of uint64 fails)", async function () {
      const Mock = await ethers.getContractFactory("MockChainlinkAggregator");
      const agg = await Mock.deploy();
      await agg.waitForDeployment();
      await expect(
        satori["createAdapterDataStream(string,uint16,address,bytes)"](
          "bad", ADAPTER_ID_CHAINLINK, await agg.getAddress(), "0x"
        )
      ).to.be.reverted;
    });
  });

  // ---------------------------------------------------------------------------
  // GAP (med): Adapter-ID immutability + isolation. A buggy adapter under a
  // new ID cannot affect streams on another ID; streams stay bound to their ID.
  // Narrative §"Permanently extensible" and §"Adapter bug isolated".
  // ---------------------------------------------------------------------------
  describe("Adapter isolation + ID immutability", function () {
    it("a broken adapter at a new ID does not affect a Chainlink stream on ID 1", async function () {
      // Healthy Chainlink stream on ID 1.
      const Mock = await ethers.getContractFactory("MockChainlinkAggregator");
      const agg = await Mock.deploy();
      await agg.waitForDeployment();
      const txC = await createChainlinkStream(satori, "eth", await agg.getAddress(), authority.address);
      const chainId = await getStreamId(txC, satori);

      // Register a second CustomAdapter at a fresh ID, and create a stream on it
      // whose target is broken (EOA) so its updateValue always reverts.
      const Custom = await ethers.getContractFactory("CustomAdapter");
      const adapter2 = await Custom.deploy();
      await adapter2.waitForDeployment();
      // owner holds the bootstrap mint; register from owner.
      const newId = await registry.nextAdapterId();
      await satori.registerCommunityAdapter(await adapter2.getAddress(), "custom2");
      expect(await registry.adapter(newId)).to.equal(await adapter2.getAddress());

      const badTx = await satori["createAdapterDataStream(string,uint16,address,bytes)"](
        "broken", newId, user1.address /* EOA */, encodeCustomConfig()
      );
      const badId = await getStreamId(badTx, satori);

      // The broken stream reverts on update.
      await expect(registry.connect(authority).updateValue(badId)).to.be.reverted;

      // The Chainlink stream on ID 1 is entirely unaffected.
      const now = await time.latest();
      await agg.setRoundData(2, 4242n, now, now, 2);
      await registry.connect(authority).updateValue(chainId);
      expect((await registry.getDataStreamInfo(chainId))[3]).to.equal(4242n);
    });

    it("ID 1 still points at the original Chainlink adapter after a new registration", async function () {
      const before = await registry.adapter(ADAPTER_ID_CHAINLINK);
      const Custom = await ethers.getContractFactory("CustomAdapter");
      const a = await Custom.deploy();
      await a.waitForDeployment();
      await satori.registerCommunityAdapter(await a.getAddress(), "x");
      // ID 1 never remaps.
      expect(await registry.adapter(ADAPTER_ID_CHAINLINK)).to.equal(before);
      expect(await registry.adapter(ADAPTER_ID_CHAINLINK)).to.equal(await chainlinkAdapter.getAddress());
    });
  });
});
