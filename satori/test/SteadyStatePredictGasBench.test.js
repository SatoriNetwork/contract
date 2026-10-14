// Steady-state gas benchmark: how much does a predictor really pay each
// cadence period if they predict on 25 streams every period, forever?
//
// A public stream is cadence 2 (daily), so "every period" means once per 24h —
// one value write, one bundled predict+settle. That is the real steady state.
//
// Run with: npx hardhat test satori/test/SteadyStatePredictGasBench.test.js
//
// The test:
//   1. Spins up 25 eligible streams, makes alice the predictor.
//   2. Runs a 5-round warmup so the prediction buffer fills (3 slots
//      per (user, stream)) and the per-round storage transitions settle
//      into their repeating pattern.
//   3. Measures 5 successive predictMultiple(25) calls in the steady
//      state. Each call bundles 25 fresh predictions AND scores 25
//      prior-round predictions inline.
//   4. Reports the per-round cost, per-stream amortized cost, and
//      shape of the distribution (min/avg/max).
//
// Use this number when reasoning about real predictor cost. Re-run
// the test after any gas-affecting change and compare.

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture, pack1, voteFor } = require("./fixtures");

const UP = 1;
const DOWN = 2;
const STREAMS = 25;
const WARMUP_ROUNDS = 5;
const MEASURE_ROUNDS = 5;
const ROUND_SECONDS = 86400;                                  // 24h
// The streams come from the 2-arg overload, i.e. cadence 2 (daily) — exactly
// what a real public predictor gets. A cadence-2 stream accepts one value write
// per 2 rounds, so the steady state being measured is one predict+settle cycle
// per DAY, and that is what these numbers now price.
const CADENCE_ROUNDS = 2;
const CADENCE_SECONDS = ROUND_SECONDS * CADENCE_ROUNDS;       // 24h
const PERIODS_PER_YEAR = Math.round((365 * 24 * 3600) / CADENCE_SECONDS); // 365

async function getStreamId(tx, satori) {
  const rc = await tx.wait();
  for (const log of rc.logs) {
    try {
      const p = satori.interface.parseLog(log);
      if (p && p.name === "DataStreamCreated") return Number(p.args.streamId);
    } catch (_) {}
  }
  throw new Error("DataStreamCreated missing");
}

// One full cadence period — the gap between two legal value writes.
async function advanceCadence() { await time.increase(CADENCE_SECONDS); }

describe("Steady-state gas benchmark: 25 predictions/cadence period, forever", function () {
  it("measures per-cadence-period cost of a continuously-active 25-stream predictor", async function () {
    this.timeout(600000);
    const fix = await loadFixture(deploySatoriFixture);
    const { satori, registry, owner, signers } = fix;
    const [, alice, bob] = signers;
    // The fixture already calls initializeDefaultStream() (default stream at id
    // 1), exactly as production does — calling it again reverts AlreadySet.

    const INITIAL = await satori.INITIAL_MINT();
    await satori.transfer(alice.address, INITIAL / 4n);
    await satori.transfer(bob.address, INITIAL / 4n);

    // 25 streams, each given weight by a small burn from alice + bob. 1 SATORI
    // apiece keeps 25 games weighted while leaving both predictors ~155 of
    // their 180 to predict with (burnt tokens are gone from prediction power).
    const PER_STREAM_BURN = ethers.parseEther("1");
    const streamIds = [];
    for (let i = 0; i < STREAMS; i++) {
      const tx = await satori.createSimpleDataStream(`S${i}`, owner.address);
      const id = await getStreamId(tx, satori);
      streamIds.push(id);
      await registry.setValue(id, 1000);
      await voteFor(satori, alice, id, PER_STREAM_BURN);
      await voteFor(satori, bob, id, PER_STREAM_BURN);
    }

    // Build the request set once. We'll vary direction round-to-round
    // so streaks don't trivially go in one direction (more realistic
    // mix).
    function requestsForRound(r) {
      return streamIds.map((id, i) => ({ gameId: id, payload: pack1(((r + i) % 2 === 0) ? UP : DOWN) }));
    }

    // Per-round value updater. Alternates direction so scoring sees
    // both wins and losses, exercising both the score-and-credit and
    // score-and-reset-streak paths.
    let baseValue = 2000;
    async function advanceAndSetValues() {
      await advanceCadence();
      baseValue += 100;
      for (const id of streamIds) {
        await registry.setValue(id, baseValue);
      }
    }

    // ------------------------------------------------------------
    // Warmup. Fill the prediction buffer (3 slots per user-stream)
    // and reach the storage-state pattern that repeats every round.
    // ------------------------------------------------------------
    for (let r = 0; r < WARMUP_ROUNDS; r++) {
      await advanceAndSetValues();
      await satori.connect(alice).predictMultipleWithPayloads(requestsForRound(r));
    }

    // ------------------------------------------------------------
    // Measurement. Record gas for MEASURE_ROUNDS successive rounds.
    // ------------------------------------------------------------
    const gasPerRound = [];
    for (let r = 0; r < MEASURE_ROUNDS; r++) {
      await advanceAndSetValues();
      const tx = await satori.connect(alice).predictMultipleWithPayloads(requestsForRound(WARMUP_ROUNDS + r));
      const rc = await tx.wait();
      gasPerRound.push(rc.gasUsed);
    }

    // ------------------------------------------------------------
    // Report.
    // ------------------------------------------------------------
    const total = gasPerRound.reduce((a, b) => a + b, 0n);
    const avg = total / BigInt(gasPerRound.length);
    const min = gasPerRound.reduce((a, b) => a < b ? a : b);
    const max = gasPerRound.reduce((a, b) => a > b ? a : b);
    const perStream = avg / BigInt(STREAMS);

    const fmt = (n) => Number(n).toLocaleString().padStart(13);

    console.log("\n========================================================");
    console.log(`Steady-state predictMultiple(${STREAMS}) gas — alice, every period`);
    console.log("========================================================");
    console.log(`Warmup periods:               ${WARMUP_ROUNDS}`);
    console.log(`Measurement window:           ${MEASURE_ROUNDS} cadence periods`);
    console.log("--------------------------------------------------------");
    gasPerRound.forEach((g, i) => {
      console.log(`Period ${WARMUP_ROUNDS + i + 1}:              ${fmt(g)} gas`);
    });
    console.log("--------------------------------------------------------");
    console.log(`Total over ${MEASURE_ROUNDS} periods:        ${fmt(total)} gas`);
    console.log(`Average per cadence period:   ${fmt(avg)} gas`);
    console.log(`Min:                          ${fmt(min)} gas`);
    console.log(`Max:                          ${fmt(max)} gas`);
    console.log(`Per-stream (amortized):       ${fmt(perStream)} gas`);
    console.log("========================================================");
    // A cadence-2 stream takes ONE value write (hence one predict+settle cycle)
    // per 24h, so a cadence period IS a day and a year is 365 of them.
    console.log(`Daily cost (1 period × avg):  ${fmt(avg)} gas/day`);
    console.log(`Annual cost (${PERIODS_PER_YEAR} periods):     ${fmt(avg * BigInt(PERIODS_PER_YEAR))} gas/year`);
    console.log("========================================================\n");

    // Sanity assertions — keep loose so the test doesn't break on
    // minor optimizations, but catch huge regressions.
    expect(avg).to.be.gt(100_000n);
    expect(avg).to.be.lt(20_000_000n);
  });
});
