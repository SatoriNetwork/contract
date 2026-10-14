const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const {
  deploySatoriFixture,
  createCustomStream,
  createChainlinkStream,
  createUniswapStream,
  ADAPTER_ID_CHAINLINK,
  ADAPTER_ID_UNISWAP,
} = require("../fixtures");

// SECOND round of adversarial COVERAGE for stream-adapters. Targets the
// MEDIUM-priority coverage gaps in _raw_review.json that the first pass
// (stream-adapters.cov.test.js) did NOT actually exercise, plus the
// remaining un-asserted validate/readValue branches in the three canonical
// adapters.
//
// Explicitly SKIPS:
//   - everything already asserted in stream-adapters.cov.test.js
//     (Chainlink revert paths / maxFeedAge bounds / int232 overflow /
//      signed answers / Uniswap negative-tick sign / fee+age validate /
//      Custom EOA target / malformed config / adapter isolation+ID immut.)
//   - the two already-CONFIRMED findings (Uniswap negative-tick
//     truncation-toward-zero; Chainlink future-dated -> Panic(0x11)).
//
// Every assertion reflects DOCUMENTED intent in the adapter contracts /
// narrative, not the code's incidental output.
//
// NOTE on the platform-fee change: the fee recipient is now a hard-coded
// immutable constant, PLATFORM_FEE_RECIPIENT() == 0x...dEaD; there is no
// setter and no wiring step. These adapter tests do not touch the
// fee-recipient surface at all, so no assertion here depends on it.

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

describe("[adversarial-cov2] stream-adapters (medium-priority gaps)", function () {
  this.timeout(120000);

  let satori, registry, owner, authority, user1;
  let chainlinkAdapter, uniswapAdapter, customAdapter;

  beforeEach(async function () {
    // Push the chain past midnight so round bookkeeping is deterministic,
    // matching the harness convention used across the adversarial suite.
    await time.increase(ROUND);
    const fix = await loadFixture(deploySatoriFixture);
    ({ satori, registry, owner, chainlinkAdapter, uniswapAdapter, customAdapter } = fix);
    [, authority, user1] = fix.signers;
  });

  // ---------------------------------------------------------------------------
  // GAP (med, untested branch): zero-address provider on adapter-stream
  // creation is rejected by the REGISTRY's InvalidProvider guard
  // (SatoriRegistry.sol) BEFORE the adapter's own validate /
  // ChainlinkV3Adapter InvalidFeed guard is ever reached. This pins the
  // defense-in-depth layering: the core/registry short-circuits zero provider,
  // so the adapter's InvalidFeed is belt-and-suspenders for direct adapter
  // calls only. cov.test.js never asserted the zero-provider path at all.
  // ---------------------------------------------------------------------------
  describe("Chainlink zero-provider rejection (registry-level)", function () {
    it("reverts InvalidProvider when the feed (provider) is the zero address", async function () {
      await expect(
        createChainlinkStream(
          satori, "zero", ethers.ZeroAddress, authority.address
        )
      ).to.be.revertedWithCustomError(registry, "InvalidProvider");
    });

    it("InvalidProvider fires even with a perfectly valid maxFeedAge (guard ordered first)", async function () {
      // maxFeedAge=3600 is in-range; a failure here proves the registry's
      // zero-provider check short-circuits ahead of any adapter-level
      // maxFeedAge / InvalidFeed validation, not by luck.
      await expect(
        createChainlinkStream(
          satori, "zero2", ethers.ZeroAddress, authority.address, undefined, 3600
        )
      ).to.be.revertedWithCustomError(registry, "InvalidProvider");
    });
  });

  // ---------------------------------------------------------------------------
  // GAP (med, untested branch): UniswapV3Adapter.validate cardinality==0 path.
  // UniswapV3Adapter.sol  `if (cardinality == 0) revert PoolNotReady();`
  // cov.test.js tested BadFeeTier / PoolTooYoung / observe-revert PoolNotReady,
  // but never the cardinality==0 early PoolNotReady branch.
  // ---------------------------------------------------------------------------
  describe("Uniswap validate cardinality==0", function () {
    it("reverts PoolNotReady when observationCardinality is zero", async function () {
      const Pool = await ethers.getContractFactory("MockUniswapV3Pool");
      const pool = await Pool.deploy();
      await pool.waitForDeployment();
      await pool.setTickCumulatives(0, 16000000);
      // Fee tier (3000) is standard and observe would succeed, but
      // cardinality==0 must trip the early guard first.
      await pool.setCardinality(0, 0);
      await expect(
        createUniswapStream(satori, "card0", await pool.getAddress(), authority.address)
      ).to.be.revertedWithCustomError(uniswapAdapter, "PoolNotReady");
    });
  });

  // ---------------------------------------------------------------------------
  // GAP (med, untested branch): UniswapV3Adapter.validate ring-not-full
  // fallback. When the oldest-slot observation is NOT initialized
  // (ring buffer still filling), the adapter re-reads index 0 as the true
  // oldest (UniswapV3Adapter.sol). cov.test.js never drove the
  // !initialized fallback.
  // ---------------------------------------------------------------------------
  describe("Uniswap validate ring-not-full fallback to index 0", function () {
    it("accepts when the oldest slot is uninitialized but index-0 ts is old enough", async function () {
      // The mock returns the SAME (_oldestTimestamp,_oldestInitialized) for
      // every index, so marking it uninitialized forces the adapter down the
      // fallback branch; the timestamp is still 2 days old (default), so the
      // PoolTooYoung check passes and create succeeds.
      const Pool = await ethers.getContractFactory("MockUniswapV3Pool");
      const pool = await Pool.deploy();
      await pool.waitForDeployment();
      await pool.setTickCumulatives(0, 16000000);
      const now = await time.latest();
      // uninitialized -> forces fallback read of index 0 (same ts), 2 days old.
      await pool.setOldestObservation(now - 2 * 24 * 3600, false);
      await expect(
        createUniswapStream(satori, "fill", await pool.getAddress(), authority.address)
      ).to.not.be.reverted;
    });

    it("still reverts PoolTooYoung via the fallback path when index-0 ts is young", async function () {
      const Pool = await ethers.getContractFactory("MockUniswapV3Pool");
      const pool = await Pool.deploy();
      await pool.waitForDeployment();
      await pool.setTickCumulatives(0, 16000000);
      const now = await time.latest();
      // uninitialized AND only 6h old: fallback reads the same young ts -> too young.
      await pool.setOldestObservation(now - 6 * 3600, false);
      await expect(
        createUniswapStream(satori, "fillyoung", await pool.getAddress(), authority.address)
      ).to.be.revertedWithCustomError(uniswapAdapter, "PoolTooYoung");
    });
  });

  // ---------------------------------------------------------------------------
  // GAP (med): Custom adapter broken-target manifests at first updateValue —
  // a CONTRACT WITH CODE that lacks getValue() (distinct from the EOA case
  // cov.test.js covered). validate only checks nonzero target, so create must
  // succeed and the failure must surface only at updateValue.
  // CustomAdapter.sol validate / :36 readValue.
  // ---------------------------------------------------------------------------
  describe("Custom adapter broken-target (contract w/ code, no getValue)", function () {
    it("create succeeds against a code-bearing target lacking getValue, updateValue reverts", async function () {
      // MockChainlinkAggregator has bytecode but no getValue() selector, so the
      // CustomAdapter readValue staticcall hits a non-existent function and
      // reverts — proving validate's no-probe escape-hatch semantics.
      const Agg = await ethers.getContractFactory("MockChainlinkAggregator");
      const codeTarget = await Agg.deploy();
      await codeTarget.waitForDeployment();

      const tx = await createCustomStream(
        satori, "codetgt", await codeTarget.getAddress(), authority.address
      );
      const id = await getStreamId(tx, satori);

      // create succeeded, and the stream really is bound to the broken target.
      // P2: this used to assert tuple[5] `exists`, which SatoriRegistry.
      // getDataStreamInfo returns as a hard-coded `true` for every id that
      // clears the bounds check (NatSpec at SatoriRegistry.sol) — and
      // `id` came out of a DataStreamCreated event, so it is in-bounds by
      // construction. Nothing about the create could have failed it. Assert the
      // fields that carry the create-time decision instead: an Adapter-type
      // stream whose provider is the code-bearing, getValue-less target that
      // validate() waved through.
      const info = await registry.getDataStreamInfo(id);
      expect(info[0], "stream name").to.equal("codetgt");
      expect(info[1], "provider is the code-bearing target").to.equal(await codeTarget.getAddress());
      expect(info[2], "registered as an Adapter stream").to.equal(1); // DataStreamType.Adapter
      // failure manifests only now, at updateValue
      await expect(registry.connect(authority).updateValue(id)).to.be.reverted;
      // nothing stored
      expect((await registry.getDataStreamInfo(id))[3]).to.equal(0n);
    });

    it("after a previously-good update, a target that flips to overflow reverts and KEEPS the old value", async function () {
      // Atomicity of the failing updateValue: a value already stored survives a
      // later reverting pull. Uses MockDataStream which CAN overflow int232.
      const I232_MAX = (1n << 231n) - 1n;
      const DS = await ethers.getContractFactory("MockDataStream");
      const ds = await DS.deploy();
      await ds.waitForDeployment();
      const tx = await createCustomStream(
        satori, "flip", await ds.getAddress(), authority.address
      );
      const id = await getStreamId(tx, satori);

      await ds.setValue(777n);
      await registry.connect(authority).updateValue(id);
      expect((await registry.getDataStreamInfo(id))[3]).to.equal(777n);

      await time.increase(CADENCE); // one cadence period — the next legal pull
      await ds.setValue(I232_MAX + 1n); // now overflows
      await expect(
        registry.connect(authority).updateValue(id)
      ).to.be.revertedWithCustomError(customAdapter, "ValueOverflow");
      // the previously-stored good value is untouched (ring un-advanced)
      expect((await registry.getDataStreamInfo(id))[3]).to.equal(777n);
    });
  });

  // ---------------------------------------------------------------------------
  // GAP (med): int232 just-INSIDE boundaries (max-1, min+1) on the Custom
  // adapter — cov.test.js pinned exactly max/min and max+1/min-1; this pins the
  // adjacent inside values to confirm the comparison is inclusive at the
  // extremes and not off-by-one inward.
  // CustomAdapter.sol `value < type(int232).min || value > type(int232).max`.
  // ---------------------------------------------------------------------------
  describe("Custom int232 just-inside boundaries", function () {
    const I232_MAX = (1n << 231n) - 1n;
    const I232_MIN = -(1n << 231n);

    async function freshStream() {
      const DS = await ethers.getContractFactory("MockDataStream");
      const ds = await DS.deploy();
      await ds.waitForDeployment();
      const tx = await createCustomStream(
        satori, "inside" + Math.random(), await ds.getAddress(), authority.address
      );
      const id = await getStreamId(tx, satori);
      return { ds, id };
    }

    it("stores type(int232).max - 1", async function () {
      const { ds, id } = await freshStream();
      await ds.setValue(I232_MAX - 1n);
      await registry.connect(authority).updateValue(id);
      expect((await registry.getDataStreamInfo(id))[3]).to.equal(I232_MAX - 1n);
    });

    it("stores type(int232).min + 1", async function () {
      const { ds, id } = await freshStream();
      await ds.setValue(I232_MIN + 1n);
      await registry.connect(authority).updateValue(id);
      expect((await registry.getDataStreamInfo(id))[3]).to.equal(I232_MIN + 1n);
    });
  });

  // ---------------------------------------------------------------------------
  // GAP (med): Chainlink readValue check ORDERING — RoundNotComplete is
  // evaluated before Stale. A round with updatedAt==0 (and otherwise bad) must
  // surface as RoundNotComplete, proving the first guard short-circuits.
  // answeredInRound is no longer a gate (audit F49). ChainlinkV3Adapter.readValue.
  // ---------------------------------------------------------------------------
  describe("Chainlink readValue guard ordering", function () {
    it("RoundNotComplete wins when updatedAt==0 even if other conditions also fail", async function () {
      const Agg = await ethers.getContractFactory("MockChainlinkAggregator");
      const agg = await Agg.deploy();
      await agg.waitForDeployment();
      const tx = await createChainlinkStream(
        satori, "ord", await agg.getAddress(), authority.address, undefined, 3600
      );
      const id = await getStreamId(tx, satori);

      // updatedAt==0 (incomplete) — RoundNotComplete short-circuits first.
      await agg.setRoundData(9, 2000n * 10n ** 8n, 0, 0, 3);
      await expect(
        registry.connect(authority).updateValue(id)
      ).to.be.revertedWithCustomError(chainlinkAdapter, "RoundNotComplete");
    });

    it("a stale answer reverts Stale even with answeredInRound < roundId (field ignored — F49)", async function () {
      const Agg = await ethers.getContractFactory("MockChainlinkAggregator");
      const agg = await Agg.deploy();
      await agg.waitForDeployment();
      const tx = await createChainlinkStream(
        satori, "ord2", await agg.getAddress(), authority.address, undefined, 3600
      );
      const id = await getStreamId(tx, satori);

      const now = await time.latest();
      // updatedAt nonzero & very old (stale) AND answeredInRound(2) < roundId(9):
      // post-F49 answeredInRound is ignored, so the age guard surfaces as Stale.
      await agg.setRoundData(9, 1n, now, now - 100000, 2);
      await expect(
        registry.connect(authority).updateValue(id)
      ).to.be.revertedWithCustomError(chainlinkAdapter, "Stale");
    });
  });
});
