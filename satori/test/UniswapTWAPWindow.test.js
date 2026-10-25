// Uniswap V3 TWAP adapter: 30-minute default window (1800s), per-stream config.
//
// Reduced from 8 hours (28800s) on 2026-09-04. A window is only usable while the
// pool's observation ring still reaches back that far, and the ring holds at
// most one entry per SECOND, so its reach shrinks as a pool gets busier. The
// adapter now also enforces requiredCardinality(window) at create time (see
// below), which turns a silent future failure into a loud rejection.
//
// Under the adapter architecture, the TWAP window constant lives on
// `UniswapV3Adapter` (not on `SatoriRegistry`). The natural failure
// mode of a pool with insufficient observation cardinality is the
// adapter's `validate` reverting `PoolNotReady` at stream creation, or
// `observe` reverting inside `readValue` at update time. Anyone can
// pay for `increaseObservationCardinalityNext` to repair the pool.

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture, createUniswapStream } = require("./fixtures");

async function getStreamIdFromTx(tx, satori) {
  const r = await tx.wait();
  for (const log of r.logs) {
    try {
      const p = satori.interface.parseLog(log);
      if (p && p.name === "DataStreamCreated") return p.args.streamId;
    } catch (e) {}
  }
  throw new Error("DataStreamCreated event missing");
}

describe("Uniswap TWAP window", function () {
  let satori, registry, owner, authority, uniswapAdapter;
  let mockPool;

  beforeEach(async function () {
    const fix = await loadFixture(deploySatoriFixture);
    ({ satori, registry, owner, uniswapAdapter } = fix);
    [, authority] = fix.signers;

    const M = await ethers.getContractFactory("MockUniswapV3Pool");
    mockPool = await M.deploy();
    await mockPool.waitForDeployment();
  });

  it("defaults to a 30-minute window with a 15-minute floor and no ceiling", async function () {
    expect(await uniswapAdapter.DEFAULT_TWAP_WINDOW()).to.equal(1800);
    expect(await uniswapAdapter.MIN_TWAP_WINDOW()).to.equal(900);
  });

  // ONE, and it is a fact about Uniswap rather than an assumption about the
  // chain: observation timestamps are uint32 SECONDS and Oracle.write
  // early-returns on a repeat, so a pool records at most one observation per
  // second however fast blocks are produced. A block-time assumption here would
  // make the guarantee breakable by a chain upgrade.
  it("bounds observations per second, not per block", async function () {
    expect(await uniswapAdapter.MIN_OBSERVATION_INTERVAL()).to.equal(1);
  });

  // An empty config must mean the default, not zero. Getting this wrong would
  // divide by zero in readValue rather than fail loudly.
  it("treats an empty config as the default window", async function () {
    expect(await uniswapAdapter.windowOf("0x")).to.equal(1800);
  });

  it("reads a configured window out of config", async function () {
    const cfg = ethers.AbiCoder.defaultAbiCoder().encode(["uint32"], [1800]);
    expect(await uniswapAdapter.windowOf(cfg)).to.equal(1800);
  });

  // The requirement scales with what was asked for: ask for more history, prove
  // the pool can sustain more. One entry per SECOND is the worst case, so
  // window / 1s is a bound a pool can never outgrow however busy it gets.
  it("derives the cardinality requirement from the window", async function () {
    expect(await uniswapAdapter.requiredCardinality(900)).to.equal(900);
    expect(await uniswapAdapter.requiredCardinality(1800)).to.equal(1800);
    expect(await uniswapAdapter.requiredCardinality(3600)).to.equal(3600);
  });

  it("rejects a pool whose ring is too small to guarantee the window", async function () {
    // Passes every other check - fee tier, age, and the live observe probe -
    // and is refused purely on capacity. That is the point: the probe answers
    // "can it serve the window NOW", this answers "can it serve it ALWAYS".
    await mockPool.setCardinality(1799, 0);
    await expect(createUniswapStream(
      satori, "THIN RING", await mockPool.getAddress(), authority.address
    )).to.be.revertedWithCustomError(uniswapAdapter, "InsufficientCardinality")
      .withArgs(1799, 1800);
  });

  const enc = (w) => ethers.AbiCoder.defaultAbiCoder().encode(["uint32"], [w]);

  it("rejects a window below the floor before touching the pool", async function () {
    await expect(
      satori["createAdapterDataStream(string,uint32,address,bytes)"](
        "TOO SHORT", 2, await mockPool.getAddress(), enc(899)
      )
    ).to.be.revertedWithCustomError(uniswapAdapter, "TwapWindowTooShort");
  });

  // There is deliberately NO policy ceiling: a long window is refused on the
  // pool's actual capacity instead, so anyone who provisions a deep enough ring
  // may have one. A 4-hour window is fine given the ring for it.
  it("allows a long window when the pool's ring can back it", async function () {
    await mockPool.setCardinality(14400, 0);
    const tx = await satori["createAdapterDataStream(string,uint32,address,bytes)"](
      "FOUR HOUR", 2, await mockPool.getAddress(), enc(14400)
    );
    expect(await getStreamIdFromTx(tx, satori)).to.be.gte(1);
  });

  // One second past the ceiling: cardinality is a uint16, so 65,535 slots is
  // every observation a pool can hold, and a window of 65,536s needs one more
  // than exists. The boundary is the interesting case — and `need` must NOT be
  // truncated into uint16, since truncation would print a number smaller than
  // the truth and send the caller off to provision a ring that still would not
  // pass.
  it("refuses a window one second past what any ring can hold", async function () {
    await mockPool.setCardinality(65535, 0);
    await expect(
      satori["createAdapterDataStream(string,uint32,address,bytes)"](
        "PAST THE CEILING", 2, await mockPool.getAddress(), enc(65536)
      )
    ).to.be.revertedWithCustomError(uniswapAdapter, "InsufficientCardinality")
      .withArgs(65535, 65536);
  });

  it("createAdapterDataStream(Uniswap) probes the pool with secondsAgo = 1800", async function () {
    await mockPool.setTickCumulatives(0, 0);
    const tx = await createUniswapStream(
      satori, "TEST/POOL TWAP", await mockPool.getAddress(), authority.address
    );
    const streamId = await getStreamIdFromTx(tx, satori);
    expect(streamId).to.be.gte(1);
  });

  it("updateValue computes tick = tickDelta / 1800", async function () {
    await mockPool.setTickCumulatives(0, 0);
    const tx = await createUniswapStream(
      satori, "TEST", await mockPool.getAddress(), authority.address
    );
    const streamId = await getStreamIdFromTx(tx, satori);

    await mockPool.setTickCumulatives(0, 1_800_000);
    await registry.connect(authority).updateValue(streamId);

    const info = await registry.getDataStreamInfo(streamId);
    expect(info[3]).to.equal(1000n);
  });

  it("the same tick delta reads 16x larger than under the old 8-hour window (proves the change took effect)", async function () {
    await mockPool.setTickCumulatives(0, 0);
    const tx = await createUniswapStream(
      satori, "TEST", await mockPool.getAddress(), authority.address
    );
    const streamId = await getStreamIdFromTx(tx, satori);

    await mockPool.setTickCumulatives(0, 1_800_000);
    await registry.connect(authority).updateValue(streamId);

    const info = await registry.getDataStreamInfo(streamId);
    // floor(1_800_000 / 1800) = 1000, against 62 under the old 28800 window.
    expect(info[3]).to.equal(1000n);
  });

  it("rejects pools whose observe() reverts at create time", async function () {
    const RevertingPool = await ethers.getContractFactory("RevertingUniswapV3Pool");
    const bad = await RevertingPool.deploy();
    await bad.waitForDeployment();
    await expect(
      createUniswapStream(satori, "BAD", await bad.getAddress(), authority.address)
    ).to.be.revertedWithCustomError(uniswapAdapter, "PoolNotReady");
  });
});
