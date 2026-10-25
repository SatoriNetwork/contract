// UniswapV3Adapter — only pools the trusted factory created (sweep C4).
//
// A look-alike pool can report any fee, any observations and any price. The
// factory's registry cannot be faked, so `validate` asks it for the pool under
// (token0, token1, fee) and refuses anything else.

const { expect } = require("chai");
const { ethers } = require("hardhat");

async function setup(withFactory = true) {
  const factory = await (await ethers.getContractFactory("MockUniswapV3Factory")).deploy();
  const pool = await (await ethers.getContractFactory("MockUniswapV3Pool")).deploy();
  const adapter = await (await ethers.getContractFactory("UniswapV3Adapter"))
    .deploy(withFactory ? await factory.getAddress() : ethers.ZeroAddress);
  return { factory, pool, adapter };
}

describe("UniswapV3Adapter — factory pin", function () {
  it("accepts a pool the factory created under its (token0, token1, fee)", async function () {
    const { factory, pool, adapter } = await setup();
    await factory.setPool(await pool.token0(), await pool.token1(), 3000, await pool.getAddress());
    await expect(adapter.validate(await pool.getAddress(), "0x")).to.not.be.reverted;
  });

  it("rejects a look-alike the factory never created", async function () {
    const { pool, adapter } = await setup();
    await expect(adapter.validate(await pool.getAddress(), "0x"))
      .to.be.revertedWithCustomError(adapter, "NotFactoryPool");
  });

  it("rejects a pool whose tokens map to a different pool", async function () {
    const { factory, pool, adapter } = await setup();
    const real = await (await ethers.getContractFactory("MockUniswapV3Pool")).deploy();
    await factory.setPool(await pool.token0(), await pool.token1(), 3000, await real.getAddress());
    await expect(adapter.validate(await pool.getAddress(), "0x"))
      .to.be.revertedWithCustomError(adapter, "NotFactoryPool");
  });

  it("rejects a pool that claims a different fee tier than the one it is registered under", async function () {
    const { factory, pool, adapter } = await setup();
    await factory.setPool(await pool.token0(), await pool.token1(), 500, await pool.getAddress());
    await expect(adapter.validate(await pool.getAddress(), "0x"))
      .to.be.revertedWithCustomError(adapter, "NotFactoryPool");
  });

  it("with no factory (a chain without Uniswap V3) the check is off", async function () {
    const { pool, adapter } = await setup(false);
    expect(await adapter.FACTORY()).to.equal(ethers.ZeroAddress);
    await expect(adapter.validate(await pool.getAddress(), "0x")).to.not.be.reverted;
  });
});
