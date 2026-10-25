// UniswapV3Adapter — fee tier + pool history validation.
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

describe("UniswapV3Adapter — pool history check (M33)", function () {
  // A ring that has not wrapped starts at the pool's first observation, so its
  // oldest entry IS the pool's age. A wrapped ring only shows how far back it
  // reaches, which on a busy pool is hours, so it is held to the TWAP window.
  describe("ring not yet full (oldest slot uninitialized): true pool age", function () {
    it("accepts a pool exactly 1 day + 1s old", async function () {
      const { satori, authority, pool } = await deployFixture();
      const now = await time.latest();
      await pool.setOldestObservation(now - 86400 - 1, false);
      await expect(
        createUniswapStream(satori, "Edge Old", await pool.getAddress(), authority.address)
      ).to.not.be.reverted;
    });

    it("rejects a pool just under 1 day old", async function () {
      const { satori, authority, pool, uniswapAdapter } = await deployFixture();
      const now = await time.latest();
      // Margin of 100s to absorb the +1s block advance the next tx introduces.
      await pool.setOldestObservation(now - 86400 + 100, false);
      await expect(
        createUniswapStream(satori, "Just Too Young", await pool.getAddress(), authority.address)
      ).to.be.revertedWithCustomError(uniswapAdapter, "PoolTooYoung");
    });

    it("rejects a brand-new pool", async function () {
      const { satori, authority, pool, uniswapAdapter } = await deployFixture();
      const now = await time.latest();
      await pool.setOldestObservation(now, false);
      await expect(
        createUniswapStream(satori, "Brand New", await pool.getAddress(), authority.address)
      ).to.be.revertedWithCustomError(uniswapAdapter, "PoolTooYoung");
    });
  });

  describe("ring wrapped (oldest slot initialized): reach must cover the TWAP window", function () {
    it("accepts a busy pool whose ring reaches back only 3 hours", async function () {
      const { satori, authority, pool } = await deployFixture();
      const now = await time.latest();
      await pool.setOldestObservation(now - 3 * 3600, true);
      await expect(
        createUniswapStream(satori, "Busy Pool", await pool.getAddress(), authority.address)
      ).to.not.be.reverted;
    });

    it("accepts a ring that reaches back exactly the default 30-minute window", async function () {
      const { satori, authority, pool } = await deployFixture();
      const now = await time.latest();
      await pool.setOldestObservation(now - 1800 - 5, true);
      await expect(
        createUniswapStream(satori, "Exact Reach", await pool.getAddress(), authority.address)
      ).to.not.be.reverted;
    });

    it("rejects a ring that reaches back less than the window", async function () {
      const { satori, authority, pool, uniswapAdapter } = await deployFixture();
      const now = await time.latest();
      await pool.setOldestObservation(now - 600, true);
      await expect(
        createUniswapStream(satori, "Short Reach", await pool.getAddress(), authority.address)
      ).to.be.revertedWithCustomError(uniswapAdapter, "PoolNotReady");
    });
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
