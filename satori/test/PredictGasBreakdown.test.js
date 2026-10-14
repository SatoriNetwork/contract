// Gas attribution: predict + score cost broken down by what's happening.

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture, pack1, voteFor } = require("./fixtures");

const UP = 1;
const ROUND_SECONDS = 86400;                                  // 24h
// Streams come from the 2-arg overload, i.e. cadence 2 (daily) — what a real
// user gets. Value writes must therefore be spaced a full cadence period apart,
// so the attributed costs are the ones a real predictor actually pays.
const CADENCE_ROUNDS = 2;
const CADENCE_SECONDS = ROUND_SECONDS * CADENCE_ROUNDS;       // 24h

async function getStreamId(tx, satori) {
  const rc = await tx.wait();
  for (const log of rc.logs) {
    try { const p = satori.interface.parseLog(log);
      if (p && p.name === "DataStreamCreated") return Number(p.args.streamId);
    } catch (_) {}
  }
  throw new Error("DataStreamCreated missing");
}
// One full cadence period — the gap between two legal value writes.
async function advanceCadence() { await time.increase(CADENCE_SECONDS); }

describe("Gas: attribution breakdown", function () {
  it("isolates each cost component", async function () {
    this.timeout(300000);
    const fix = await loadFixture(deploySatoriFixture);
    const { satori, registry, owner } = fix;
    const [, alice, bob] = fix.signers;

    const INITIAL_MINT = await satori.INITIAL_MINT();
    // 20 streams will be created below at 14 SATORI each = 280 SATORI from owner.
    // Halve the actor allocations so the deployer can cover both stream creation
    // and the subsequent funding rounds without running into the bootstrap cap.
    await satori.transfer(alice.address, INITIAL_MINT / 8n);
    await satori.transfer(bob.address, INITIAL_MINT / 8n);

    // 20 streams, all eligible
    const streamIds = [];
    for (let i = 0; i < 20; i++) {
      const tx = await satori.createSimpleDataStream(`S${i}`, owner.address);
      streamIds.push(await getStreamId(tx, satori));
    }
    // 1 SATORI burned per game (20 total each) — enough to give every game
    // weight while leaving both actors most of their balance as predict power.
    const BURN = ethers.parseEther("1");
    for (const id of streamIds) {
      await registry.setValue(id, 1000);
      await voteFor(satori, alice, id, BURN);
      await voteFor(satori, bob, id, BURN);
    }
    await advanceCadence();
    for (const id of streamIds) await registry.setValue(id, 1000);

    // ============================================================
    // Scenario 1: First-ever predictMultiple(20) — NO prior to score
    // ============================================================
    const requests = streamIds.map(id => ({ gameId: id, payload: pack1(UP) }));
    const tx1 = await satori.connect(alice).predictMultipleWithPayloads(requests);
    const rc1 = await tx1.wait();
    const G_predict_only = rc1.gasUsed;

    // Advance + set B and C so we can score these
    await advanceCadence();
    for (const id of streamIds) await registry.setValue(id, 1100);
    await advanceCadence();
    for (const id of streamIds) await registry.setValue(id, 1200);

    // ============================================================
    // Scenario 2: SECOND predictMultiple(20) with 20 prior scorings folded in
    // ============================================================
    // Advance and set fresh A values for the new round.
    await advanceCadence();
    for (const id of streamIds) await registry.setValue(id, 1300);

    const tx2 = await satori.connect(alice).predictMultipleWithPayloads(requests);
    const rc2 = await tx2.wait();
    const G_predict_with_scoring = rc2.gasUsed;

    // ============================================================
    // Scenario 3: predict(1) — single stream, no prior, baseline overhead
    // ============================================================
    // Use a fresh actor + fresh stream so nothing carries over.
    const [,,, carol] = fix.signers;
    await satori.transfer(carol.address, INITIAL_MINT / 10n);
    const tx_make = await satori.createSimpleDataStream("SOLO", owner.address);
    const soloId = await getStreamId(tx_make, satori);
    await registry.setValue(soloId, 1000);
    await voteFor(satori, carol, soloId);
    await advanceCadence();
    await registry.setValue(soloId, 1000);

    const txS1 = await satori.connect(carol).predictMultipleWithPayloads([{ gameId: soloId, payload: pack1(UP) }]);
    const rcS1 = await txS1.wait();
    const G_solo_predict = rcS1.gasUsed;

    // ============================================================
    // Scenario 4: Sub-component — first predict in a round is the FIRST
    //             to initialize round totals. Re-measure single predict
    //             when SOMEONE ELSE already initialized this round.
    // ============================================================
    // Bob predicts first, then we measure Alice's tx.
    await advanceCadence();
    await registry.setValue(soloId, 1100);
    await advanceCadence();
    await registry.setValue(soloId, 1200);
    await satori.connect(carol).settlePrediction(carol.address, soloId);
    await advanceCadence();
    await registry.setValue(soloId, 1300);

    // Now: Bob does the first predict of this round, then we measure Carol.
    await satori.connect(bob).predictMultipleWithPayloads([{ gameId: soloId, payload: pack1(UP) }]);
    const txS2 = await satori.connect(carol).predictMultipleWithPayloads([{ gameId: soloId, payload: pack1(UP) }]);
    const rcS2 = await txS2.wait();
    const G_solo_predict_warm_round = rcS2.gasUsed;

    // ============================================================
    // Scenario 5: settle a single prediction in isolation
    // ============================================================
    const [,,,, dave] = fix.signers;
    await satori.transfer(dave.address, INITIAL_MINT / 10n);
    const txDS = await satori.createSimpleDataStream("D", owner.address);
    const dId = await getStreamId(txDS, satori);
    await registry.setValue(dId, 1000);
    await voteFor(satori, dave, dId);
    await advanceCadence();
    await registry.setValue(dId, 1000);
    await satori.connect(dave).predictMultipleWithPayloads([{ gameId: dId, payload: pack1(UP) }]);
    await advanceCadence();
    await registry.setValue(dId, 1100);
    await advanceCadence();
    await registry.setValue(dId, 1200);
    const txSet = await satori.settlePrediction(dave.address, dId);
    const rcSet = await txSet.wait();
    const G_settle_correct = rcSet.gasUsed;

    // ============================================================
    // REPORT
    // ============================================================
    console.log("\n=== Gas attribution ===\n");
    console.log("predictMultiple(20), no prior scoring:        ", G_predict_only.toLocaleString(), "gas");
    console.log("predictMultiple(20) with 20 prior settles:    ", G_predict_with_scoring.toLocaleString(), "gas");
    console.log("  Δ = scoring overhead inside predict:        ", (G_predict_with_scoring - G_predict_only).toLocaleString(), "gas");
    console.log("  per-stream scoring (inside predict):        ", ((G_predict_with_scoring - G_predict_only) / 20n).toLocaleString(), "gas");
    console.log("");
    console.log("Single predict() — cold round (first predict): ", G_solo_predict.toLocaleString(), "gas");
    console.log("Single predict() — warm round (someone first): ", G_solo_predict_warm_round.toLocaleString(), "gas");
    console.log("  Δ = round-initialization overhead:           ", (G_solo_predict - G_solo_predict_warm_round).toLocaleString(), "gas");
    console.log("");
    console.log("Single settlePrediction (correct):             ", G_settle_correct.toLocaleString(), "gas");
    console.log("");
    console.log("Per-stream amortized in predictMultiple(20):   ", (G_predict_only / 20n).toLocaleString(), "gas");
    console.log("vs single predict() (warm):                    ", G_solo_predict_warm_round.toLocaleString(), "gas");
    console.log("Batch savings per stream:                       ", (G_solo_predict_warm_round - (G_predict_only / 20n)).toLocaleString(), "gas");
  });
});
