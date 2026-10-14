// Adversarial finding (low) — stream-adapters:
// "Uniswap TWAP tick truncates toward zero instead of flooring —
//  off-by-one on negative ticks"
//   location: adapters/UniswapV3Adapter.sol:readValue (line 87)
//
// INTENDED behavior (per canonical Uniswap OracleLibrary.consult, which the
// adapter docstring claims to mirror: "raw, signed, monotonic … the
// arithmetic mean tick over the window is (tickCumulatives[1] -
// tickCumulatives[0]) / secondsAgo"):
//
//   arithmeticMeanTick = tickCumulativeDelta / secondsAgo
//   if (tickCumulativeDelta < 0 && tickCumulativeDelta % secondsAgo != 0)
//       arithmeticMeanTick--;   // FLOOR toward -inf, not truncate toward 0
//
// The adapter omits the floor correction, so for any negative delta with a
// nonzero remainder the stored tick is +1 too high (rounds toward zero).
//
// This test asserts the INTENDED (canonical-floor) value.
//   FAIL  => finding CONFIRMED (adapter truncates instead of floors)
//   PASS  => finding REFUTED   (adapter already floors)

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture, createUniswapStream } = require("../fixtures");

// Default window, in sync with UniswapV3Adapter.DEFAULT_TWAP_WINDOW. These
// streams supply no config, so they take the default.
const TWAP_WINDOW = 1800n;

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

// Canonical Uniswap OracleLibrary.consult mean-tick (floor toward -inf).
function canonicalMeanTick(delta, secondsAgo) {
  let mean = delta / secondsAgo; // BigInt division truncates toward zero
  if (delta < 0n && delta % secondsAgo !== 0n) mean -= 1n;
  return mean;
}

describe("LOW stream-adapters: Uniswap TWAP negative-tick flooring", function () {
  this.timeout(120000);

  let satori, registry, authority, mockPool;

  beforeEach(async function () {
    const fix = await loadFixture(deploySatoriFixture);
    ({ satori, registry } = fix);
    [, authority] = fix.signers;

    const M = await ethers.getContractFactory("MockUniswapV3Pool");
    mockPool = await M.deploy();
    await mockPool.waitForDeployment();
    // Seed a valid (non-negative) value so the stream can be created.
    await mockPool.setTickCumulatives(0, 0);
  });

  async function storedTickForDelta(delta) {
    // tick0 = 0, tick1 = delta  ->  tickCumulativeDelta = delta
    const tx = await createUniswapStream(
      satori, "NEG TWAP", await mockPool.getAddress(), authority.address
    );
    const streamId = await getStreamIdFromTx(tx, satori);

    await mockPool.setTickCumulatives(0, delta);
    await registry.connect(authority).updateValue(streamId);

    const info = await registry.getDataStreamInfo(streamId);
    return BigInt(info[3]); // stored current value (the mean tick)
  }

  it("delta = -100 should floor to -1 (canonical), not truncate to 0", async function () {
    const delta = -100n;
    const stored = await storedTickForDelta(delta);
    const expected = canonicalMeanTick(delta, TWAP_WINDOW); // = -1
    expect(stored).to.equal(expected);
  });

  it("delta = -28900 should floor to -2 (canonical), not truncate to -1", async function () {
    const delta = -28900n;
    const stored = await storedTickForDelta(delta);
    const expected = canonicalMeanTick(delta, TWAP_WINDOW); // = -2
    expect(stored).to.equal(expected);
  });

  it("positive delta with remainder is unaffected (truncation == floor for delta > 0)", async function () {
    const delta = 100n;
    const stored = await storedTickForDelta(delta);
    const expected = canonicalMeanTick(delta, TWAP_WINDOW); // = 0
    expect(stored).to.equal(expected);
  });
});
