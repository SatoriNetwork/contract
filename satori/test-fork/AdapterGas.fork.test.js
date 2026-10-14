// Q5 measurement: what a real oracle pull costs on Base mainnet.
//
// FORK TEST — deliberately OUTSIDE satori/test/ so `npm test` never runs it.
// It forks live Base state over a public RPC (slow, network-dependent) and
// measures the true gas of `updateValue` against a REAL Uniswap V3 pool and a
// REAL Chainlink feed, alongside the same pulls against the suite's mocks on
// the same fork, so the mock understatement is visible in one table.
//
// Run:   cd satori && npx hardhat test test-fork/AdapterGas.fork.test.js
// RPC:   BASE_RPC env var overrides the default public endpoint.
//
// Context (docs/issues/rolling-24h-scoring.md, question 5): the redesign
// samples the default stream hourly, and the pull is paid by the first
// predict of each hour. This measures that surcharge.

const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture, createUniswapStream, createChainlinkStream } = require("../test/fixtures");

const BASE_RPC = process.env.BASE_RPC || "https://base-rpc.publicnode.com";

// Live Base mainnet addresses, verified 2026-09-05:
// - WETH/USDC 0.05% pool (from factory 0x33128a8f...: getPool(WETH, USDC, 500)).
//   Cardinality 5000 (> the 1800 the default 30-min window requires); oldest
//   observation ~43h old (> the 1-day MIN_POOL_AGE).
// - Chainlink ETH/USD proxy, ~20-min heartbeat.
const REAL_POOL = "0xd0b53D9277642d899DF5C87A3966A349A798F224";
const REAL_FEED = "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70";

// One cadence period for the default (1440-minute, daily) adapter stream
// under 24h rounds: one round. Advancing this far clears both the round
// guard and the 23.5h wall-clock gap before a second pull.
const CADENCE_SECONDS = 86400;

// maxFeedAge for the Chainlink stream: 26h (the adapter's MAX_FEED_AGE), so
// the SECOND pull — 24h of simulated time later, during which the forked
// feed's updatedAt cannot move — still passes the freshness check. The live
// feed updates every ~20min, so this looseness is measurement scaffolding,
// not a recommendation.
const MAX_FEED_AGE = 26 * 3600;

async function measure(tx) {
  const r = await (await tx).wait();
  return Number(r.gasUsed);
}

async function streamIdFromTx(tx, satori) {
  const r = await tx.wait();
  for (const log of r.logs) {
    try {
      const parsed = satori.interface.parseLog(log);
      if (parsed && parsed.name === "DataStreamCreated") return parsed.args[0];
    } catch {}
  }
  throw new Error("DataStreamCreated not found");
}

describe("[fork] Q5 — adapter pull gas on live Base state", function () {
  // Fork RPCs are slow; every fixture tx round-trips state reads.
  this.timeout(600_000);

  let fix, satori, registry, owner;
  const results = [];

  before(async function () {
    await network.provider.request({
      method: "hardhat_reset",
      params: [{ forking: { jsonRpcUrl: BASE_RPC } }],
    });
    // Direct call, not loadFixture: snapshots don't mix with hardhat_reset.
    fix = await deploySatoriFixture();
    ({ satori, registry, owner } = fix);
  });

  after(async function () {
    // Leave the process on a clean local chain, not the fork.
    await network.provider.request({ method: "hardhat_reset", params: [] });
    if (results.length) {
      console.log("\n  ── Q5 gas per pull (updateValue tx gas, incl. 21k intrinsic) ──");
      for (const [label, gas] of results) {
        console.log(`  ${label.padEnd(46)} ${gas.toLocaleString()}`);
      }
      console.log("");
    }
  });

  // Runs FIRST: the forked feed's updatedAt is frozen, so only the first
  // 24h advance keeps it inside MAX_FEED_AGE. Uniswap's observe() only
  // extrapolates and does not care how much further time moves.
  it("Chainlink: real ETH/USD feed, first and steady-state pull", async function () {
    const tx = await createChainlinkStream(
      satori, "FORK ETH/USD", REAL_FEED, owner.address, undefined, MAX_FEED_AGE
    );
    const creationGas = Number((await tx.wait()).gasUsed);
    const id = await streamIdFromTx(tx, satori);
    results.push(["Chainlink stream creation (validate incl.)", creationGas]);

    const first = await measure(registry.updateValue(id));
    results.push(["Chainlink pull #1 (fresh ring slot)", first]);

    await time.increase(CADENCE_SECONDS);
    const second = await measure(registry.updateValue(id));
    results.push(["Chainlink pull #2 (steady state)", second]);

    const info = await registry.getDataStreamInfo(id);
    expect(info[3]).to.not.equal(0n);
    expect(first).to.be.greaterThan(21000);
  });

  it("Uniswap V3: real WETH/USDC pool, first and steady-state pull", async function () {
    const tx = await createUniswapStream(satori, "FORK ETH/USDC TWAP", REAL_POOL, owner.address);
    const creationGas = Number((await tx.wait()).gasUsed);
    const id = await streamIdFromTx(tx, satori);
    results.push(["Uniswap stream creation (validate incl.)", creationGas]);

    const first = await measure(registry.updateValue(id));
    results.push(["Uniswap pull #1 (fresh ring slot, 20k SSTORE)", first]);

    await time.increase(CADENCE_SECONDS);
    const second = await measure(registry.updateValue(id));
    results.push(["Uniswap pull #2 (steady state)", second]);

    const info = await registry.getDataStreamInfo(id);
    expect(info[3]).to.not.equal(0n); // a real tick landed
    expect(first).to.be.greaterThan(21000);
  });

  it("Mock baseline: the same pulls against the suite's mocks, same fork", async function () {
    const Pool = await ethers.getContractFactory("MockUniswapV3Pool");
    const pool = await Pool.deploy();
    await pool.waitForDeployment();
    await pool.setTickCumulatives(0, 1800000);
    const utx = await createUniswapStream(satori, "MOCK POOL", await pool.getAddress(), owner.address);
    const uid = await streamIdFromTx(utx, satori);
    results.push(["MOCK Uniswap pull #1", await measure(registry.updateValue(uid))]);
    await time.increase(CADENCE_SECONDS);
    results.push(["MOCK Uniswap pull #2 (steady state)", await measure(registry.updateValue(uid))]);

    const Agg = await ethers.getContractFactory("MockChainlinkAggregator");
    const agg = await Agg.deploy();
    await agg.waitForDeployment();
    await agg.setAnswer(2458_75863401n);
    const ctx = await createChainlinkStream(
      satori, "MOCK FEED", await agg.getAddress(), owner.address, undefined, MAX_FEED_AGE
    );
    const cid = await streamIdFromTx(ctx, satori);
    results.push(["MOCK Chainlink pull #1", await measure(registry.updateValue(cid))]);
    await time.increase(CADENCE_SECONDS);
    await agg.setAnswer(2500_00000000n); // keep updatedAt fresh, like the live feed would
    results.push(["MOCK Chainlink pull #2 (steady state)", await measure(registry.updateValue(cid))]);
  });
});
