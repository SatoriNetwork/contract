// Gas measurement: predicting on 20 streams in one batch, then scoring
// them when 10 of 20 are correct.

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture, pack1, voteFor } = require("./fixtures");

const UP = 1;
const DOWN = 2;
const ROUND_SECONDS = 86400;                                  // 24h
// These streams are created the way a REAL predictor gets them: the 2-arg
// overload, which now yields cadence 2 (daily — the finest a public stream may
// be). The benchmark therefore has to walk the value series at that cadence,
// one write per 2 rounds, which is also what a real predictor pays for.
const CADENCE_ROUNDS = 2;
const CADENCE_SECONDS = ROUND_SECONDS * CADENCE_ROUNDS;       // 24h

async function getStreamIdFromTx(tx, satori) {
  const receipt = await tx.wait();
  for (const log of receipt.logs) {
    try {
      const p = satori.interface.parseLog(log);
      if (p && p.name === "DataStreamCreated") return Number(p.args.streamId);
    } catch (_) {}
  }
  throw new Error("DataStreamCreated missing");
}

// One full cadence period — the gap between two legal value writes.
async function advanceCadence() {
  await time.increase(CADENCE_SECONDS);
}

describe("Gas: 20-prediction batch + scoring with 10/20 correct", function () {
  it("reports gas for predictMultiple(20) and settlePrediction for each", async function () {
    this.timeout(180000);
    const fix = await loadFixture(deploySatoriFixture);
    const { satori, registry, engine, owner } = fix;
    const [, alice, bob] = fix.signers;


    const INITIAL_MINT = await satori.INITIAL_MINT();
    // Alice gets enough power to predict on 20 streams (predictMultiple
    // splits her predictionPower across the batch — so the per-stream
    // commit weight scales with batch size, but she needs SOME power).
    await satori.transfer(alice.address, INITIAL_MINT / 4n);
    await satori.transfer(bob.address, INITIAL_MINT / 4n);

    // Create 20 streams and give each of them weight. Bob burns for each too so
    // there's competing weight — keeps the test realistic. 1 SATORI per game
    // (20 total each) leaves both actors the bulk of their balance as
    // prediction power, which is what this measurement needs.
    const BURN = ethers.parseEther("1");
    const streamIds = [];
    for (let i = 0; i < 20; i++) {
      const tx = await satori.createSimpleDataStream(`S${i}`, owner.address);
      const id = await getStreamIdFromTx(tx, satori);
      streamIds.push(id);
      await registry.setValue(id, 1000);
      await voteFor(satori, alice, id, BURN);
      await voteFor(satori, bob, id, BURN);
    }

    // Advance to a fresh round so the predict happens in a clean window.
    await advanceCadence();
    // Re-set all values (the predict A) at this round.
    for (const id of streamIds) await registry.setValue(id, 1000);

    // === Measurement 1: predictMultiple on 20 streams ===
    // Mix directions: first 10 UP, last 10 DOWN.
    const requests = streamIds.map((id, i) => ({ gameId: id, payload: pack1(i < 10 ? UP : DOWN) }));
    const txPredict = await satori.connect(alice).predictMultipleWithPayloads(requests);
    const rcPredict = await txPredict.wait();
    const gasPredict = rcPredict.gasUsed;

    // === Set B values to make 10 of 20 correct ===
    // For UP predictions (0..9): need C > A. Set B and C above 1000.
    // For DOWN predictions (10..19): need C < A. Set B and C below 1000.
    // To make exactly 10 of 20 correct (a deterministic 50% split), we
    // flip a coin per pair: first 5 UP go correct (price rises), next 5
    // UP go wrong (price falls). Same for DOWN: first 5 correct (falls),
    // next 5 wrong (rises). Net 10 correct out of 20.
    await advanceCadence();
    for (let i = 0; i < 20; i++) {
      const id = streamIds[i];
      const isUp = i < 10;
      const inFirstHalf = isUp ? i < 5 : (i - 10) < 5;
      // First-half UPs go up (correct); second-half UPs go down (wrong).
      // First-half DOWNs go down (correct); second-half DOWNs go up (wrong).
      const correct = inFirstHalf;
      const moveUp = (isUp && correct) || (!isUp && !correct);
      await registry.setValue(id, moveUp ? 1100 : 900);
    }
    // Advance and set C.
    await advanceCadence();
    for (let i = 0; i < 20; i++) {
      const id = streamIds[i];
      const isUp = i < 10;
      const inFirstHalf = isUp ? i < 5 : (i - 10) < 5;
      const correct = inFirstHalf;
      const moveUp = (isUp && correct) || (!isUp && !correct);
      await registry.setValue(id, moveUp ? 1200 : 800);
    }

    // === Measurement 2: settle each prediction one-by-one ===
    // settlePrediction calls _scorePreviousPrediction up to 3 times.
    let totalSettleGas = 0n;
    const perStreamSettleGas = [];
    const scored = [];   // { gameId, correct } per PredictionScored event
    for (const id of streamIds) {
      const tx = await satori.settlePrediction(alice.address, id);
      const rc = await tx.wait();
      perStreamSettleGas.push(rc.gasUsed);
      totalSettleGas += rc.gasUsed;
      for (const log of rc.logs) {
        try {
          const p = engine.interface.parseLog(log);
          if (p && p.name === "PredictionScored" && p.args.user === alice.address) {
            scored.push({ gameId: Number(p.args.gameId), correct: p.args.correct });
          }
        } catch (_) {}
      }
    }

    // Verify the 10/20 expectation the setup above was built for.
    const correctCount = scored.filter((s) => s.correct).length;

    console.log("\n=== Gas measurements (20 predictions, 10 correct) ===");
    console.log(`predictMultiple(20):            ${gasPredict.toLocaleString()} gas`);
    console.log(`  per-prediction (amortized):   ${(gasPredict / 20n).toLocaleString()} gas`);
    console.log(`settlePrediction × 20 (total):  ${totalSettleGas.toLocaleString()} gas`);
    console.log(`  avg per settle:               ${(totalSettleGas / 20n).toLocaleString()} gas`);
    console.log(`  min per settle:               ${perStreamSettleGas.reduce((a, b) => a < b ? a : b).toLocaleString()} gas`);
    console.log(`  max per settle:               ${perStreamSettleGas.reduce((a, b) => a > b ? a : b).toLocaleString()} gas`);
    console.log(`\nGrand total (predict + score):  ${(gasPredict + totalSettleGas).toLocaleString()} gas`);

    // Sanity assertions — the test exists to print numbers, but the numbers are
    // only meaningful if the work actually happened.
    expect(gasPredict).to.be.gt(100_000n);
    // P2: this used to be `totalSettleGas > 0`, which every mined transaction
    // satisfies (>= 21,000 intrinsic gas each, so the 20-tx sum is >= 420,000
    // for ANY state). It would have stayed green if settlePrediction had
    // regressed to a silent no-op for all 20 predictions — every failure path in
    // _scorePreviousPrediction returns without reverting — while still printing
    // plausible gas numbers. Assert the settle work itself instead: all 20
    // predictions scored, exactly one event per stream, and the 10/20
    // correct/wrong split the B/C values above were constructed to produce.
    expect(scored.length, "every one of the 20 predictions was scored").to.equal(20);
    expect(new Set(scored.map((s) => s.gameId)).size, "one score per stream").to.equal(20);
    expect(correctCount, "exactly 10 of 20 predictions correct").to.equal(10);
  });

  it("reports gas for a single predict() + settle() (for comparison)", async function () {
    this.timeout(180000);
    const fix = await loadFixture(deploySatoriFixture);
    const { satori, registry, owner } = fix;
    const [, alice, bob] = fix.signers;

    const INITIAL_MINT = await satori.INITIAL_MINT();
    await satori.transfer(alice.address, INITIAL_MINT / 4n);
    await satori.transfer(bob.address, INITIAL_MINT / 4n);

    const tx = await satori.createSimpleDataStream("S", owner.address);
    const id = await getStreamIdFromTx(tx, satori);
    await registry.setValue(id, 1000);
    await voteFor(satori, alice, id);
    await voteFor(satori, bob, id);
    await advanceCadence();
    await registry.setValue(id, 1000);

    // === Single predict ===
    const txPredict = await satori.connect(alice).predictMultipleWithPayloads([{ gameId: id, payload: pack1(UP) }]);
    const rcPredict = await txPredict.wait();

    // === Set up a CORRECT path: B, C both above A ===
    await advanceCadence();
    await registry.setValue(id, 1100);
    await advanceCadence();
    await registry.setValue(id, 1200);

    // === Settle (correct, full eager credit path) ===
    const txSettleCorrect = await satori.settlePrediction(alice.address, id);
    const rcSettleCorrect = await txSettleCorrect.wait();

    // === Make another prediction that will be wrong, and settle it ===
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: id, payload: pack1(UP) }]);
    await advanceCadence();
    await registry.setValue(id, 1100);  // B
    await advanceCadence();
    await registry.setValue(id, 900);   // C — net DOWN, alice's UP wrong
    const txSettleWrong = await satori.settlePrediction(alice.address, id);
    const rcSettleWrong = await txSettleWrong.wait();

    console.log("\n=== Single predict / settle (for comparison) ===");
    console.log(`predict() single:               ${rcPredict.gasUsed.toLocaleString()} gas`);
    console.log(`settle (correct):               ${rcSettleCorrect.gasUsed.toLocaleString()} gas`);
    console.log(`settle (wrong):                 ${rcSettleWrong.gasUsed.toLocaleString()} gas`);
  });
});
