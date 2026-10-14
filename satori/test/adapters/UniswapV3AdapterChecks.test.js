// UniswapV3Adapter — fee tier + pool age validation.
//
// These checks live in `validate` (called once at create) and are the
// permissionless guards against the lowest-effort manipulation
// vectors: non-standard / experimental fee tiers, and wash-bootstrap
// pools that haven't been on-chain long enough to accumulate honest
// price history.

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture, createUniswapStream } = require("../fixtures");

async function deployFixture() {
  const fix = await loadFixture(deploySatoriFixture);
  const [, authority] = fix.signers;
  const MockUniswapV3Pool = await ethers.getContractFactory("MockUniswapV3Pool");
  const pool = await MockUniswapV3Pool.deploy();
  await pool.waitForDeployment();
  return { ...fix, authority, pool };
}

describe("UniswapV3Adapter — fee tier check", function () {
  it("accepts the 0.05% (500) tier", async function () {
    const { satori, authority, pool } = await deployFixture();
    await pool.setFee(500);
    await expect(
      createUniswapStream(satori, "USDC/USDT 0.05%", await pool.getAddress(), authority.address)
    ).to.not.be.reverted;
  });

  it("accepts the 0.30% (3000) tier", async function () {
    const { satori, authority, pool } = await deployFixture();
    await pool.setFee(3000);
    await expect(
      createUniswapStream(satori, "ETH/USDC 0.30%", await pool.getAddress(), authority.address)
    ).to.not.be.reverted;
  });

  it("accepts the 1.00% (10000) tier", async function () {
    const { satori, authority, pool } = await deployFixture();
    await pool.setFee(10000);
    await expect(
      createUniswapStream(satori, "EXOTIC/WETH 1%", await pool.getAddress(), authority.address)
    ).to.not.be.reverted;
  });

  it("accepts the 0.01% (100) tier — F50 (deepest Base stable pools)", async function () {
    const { satori, authority, pool } = await deployFixture();
    await pool.setFee(100);
    await expect(
      createUniswapStream(satori, "USDC/USDT 0.01%", await pool.getAddress(), authority.address)
    ).to.not.be.reverted;
  });

  it("rejects an arbitrary custom tier (e.g. 4242)", async function () {
    const { satori, authority, pool, uniswapAdapter } = await deployFixture();
    await pool.setFee(4242);
    await expect(
      createUniswapStream(satori, "Custom Tier", await pool.getAddress(), authority.address)
    ).to.be.revertedWithCustomError(uniswapAdapter, "BadFeeTier");
  });
});

describe("UniswapV3Adapter — 1-day pool-age check", function () {
  it("accepts a pool whose oldest observation is 2 days old (default mock state)", async function () {
    const { satori, authority, pool } = await deployFixture();
    // Default mock: oldest observation is 2 days ago, comfortably past the
    // 1-day minimum.
    await expect(
      createUniswapStream(satori, "Old Pool", await pool.getAddress(), authority.address)
    ).to.not.be.reverted;
  });

  it("accepts a pool exactly 1 day + 1s old", async function () {
    const { satori, authority, pool } = await deployFixture();
    const now = await time.latest();
    await pool.setOldestObservation(now - 86400 - 1, true);
    await expect(
      createUniswapStream(satori, "Edge Old", await pool.getAddress(), authority.address)
    ).to.not.be.reverted;
  });

  it("rejects a pool just under 1 day old", async function () {
    const { satori, authority, pool, uniswapAdapter } = await deployFixture();
    const now = await time.latest();
    // Margin of 100s to absorb the +1s block advance the next tx introduces.
    await pool.setOldestObservation(now - 86400 + 100, true);
    await expect(
      createUniswapStream(satori, "Just Too Young", await pool.getAddress(), authority.address)
    ).to.be.revertedWithCustomError(uniswapAdapter, "PoolTooYoung");
  });

  it("rejects a brand-new pool (oldest observation = current block)", async function () {
    const { satori, authority, pool, uniswapAdapter } = await deployFixture();
    const now = await time.latest();
    await pool.setOldestObservation(now, true);
    await expect(
      createUniswapStream(satori, "Brand New", await pool.getAddress(), authority.address)
    ).to.be.revertedWithCustomError(uniswapAdapter, "PoolTooYoung");
  });

  it("falls back to index-0 timestamp when oldest slot is uninitialized (buffer not full)", async function () {
    // When cardinality slots haven't all been written yet, the "next-to-
    // overwrite" slot isn't initialized and the adapter falls back to
    // index 0. This test simulates that by marking the oldest slot
    // uninitialized while index 0 (also mocked to the same field) returns
    // a 2-day-old timestamp.
    const { satori, authority, pool } = await deployFixture();
    const now = await time.latest();
    // Mock returns the same timestamp for both `oldestIdx` and index-0 —
    // marking it uninitialized exercises the fallback branch.
    await pool.setOldestObservation(now - 2 * 86400, false);
    await expect(
      createUniswapStream(satori, "Fallback Branch", await pool.getAddress(), authority.address)
    ).to.not.be.reverted;
  });
});

describe("UniswapV3Adapter — checks compose", function () {
  it("rejects on fee tier BEFORE checking age (cheaper rejection on the bad-tier case)", async function () {
    const { satori, authority, pool, uniswapAdapter } = await deployFixture();
    await pool.setFee(4242); // bad tier
    const now = await time.latest();
    await pool.setOldestObservation(now, true); // also too young
    // Both checks would fail; adapter rejects with the first one it hits.
    await expect(
      createUniswapStream(satori, "Both Bad", await pool.getAddress(), authority.address)
    ).to.be.revertedWithCustomError(uniswapAdapter, "BadFeeTier");
  });
});
