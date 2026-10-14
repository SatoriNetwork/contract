// Adversarial repro for finding (high), subsystem: predictions
//
//   "Saturating rawPower cap makes predict-time totalWeight diverge from
//    score-time userWeight (denominator drift), under-paying large stakes and
//    stranding budget"
//   location: Satori.sol:_makePrediction (1460) vs _scorePreviousPrediction
//             (1732-1733); _packPred saturation (342-343)
//
// THE INTENDED BEHAVIOR (the narrative's invariant — "single source of truth
// `_deriveWeight`"): for a given (game, round, direction), the per-(game,round,
// direction) denominator `totalWeightPacked` accumulated at PREDICT time must
// equal the sum of the per-prediction NUMERATOR weights re-derived at SCORE
// time, modulo sub-nano-SATORI quantization dust (the suite bakes in
// RAW_TOLERANCE / SCALED_WEIGHT_TOLERANCE for exactly that dust). If they
// agree, then `_computeReward = streamPool * userWeight / totalWeight` fully
// distributes the stream pool among the winners (no stranded residual, no
// short-changed co-predictor).
//
// THE FIX (verified here): predict and score now derive the weight from the
// SAME effective rawPower — the value after the packed-slot round-trip
// (`_effectiveRaw` at predict == `_predRaw` of the stored slot at score). So the
// per-(game, round, direction) `totalWeightPacked` denominator equals the sum of
// the score-time numerators exactly (modulo the shared low-bit floor), for ANY
// stake size — no asymmetric saturation/truncation drift, no stranded budget.
// (Before the fix, predict used the FULL perStreamPower while score used the
// truncated/saturated slot value, so large stakes were under-paid and budget
// stranded.)
//
// NOTE on the cap: PR_RAW_SHIFT is now 40, so the saturation cap sits at
// (2^47<<40) ≈ 155M SATORI — unreachable in any realistic protocol life (or
// test). This test farms alice to a LARGE stake (~151k SATORI, the OLD cap) to
// exercise large-stake consistency; with SHIFT=40 nothing saturates, so
// denominator == Σ numerators holds exactly there.
//
// This test asserts the INTENDED invariant (denominator == Σ score-time
// numerators, within the shared low-bit dust) at a large stake, with a small
// control co-predictor.

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture, SCALED_WEIGHT_TOLERANCE, pack1, voteFor } = require("../fixtures");

const UP = 1;
// A round is 24h. Every stream in this file runs at an explicit 2880-minute
// cadence (two rounds) so the provider may only post a value once per period
// below, and the scoring window is AB (anchor = value AT the predict round,
// post = the first value after) — the same shape these tests always had.
const ROUND = 86400;
const CADENCE_ROUNDS = 2;
// Advance to the round boundary CADENCE_ROUNDS ahead, +5s (not a raw
// +CADENCE_ROUNDS*86400): farmTo below runs hundreds of sequential txs, each
// nudging the block timestamp +1s, and with a raw increase that drift
// eventually pushes a predict across a round boundary from its setValue ->
// spurious PredictExpired. Re-pinning every advance to boundary+5s makes the
// file phase-deterministic regardless of the wall-clock time the chain started
// at (the flake fired only when the suite launched within ~10 minutes of a
// round boundary).
async function advanceOneDay() {
  const t = await time.latest();
  await time.increaseTo(t - (t % ROUND) + ROUND * CADENCE_ROUNDS + 5);
}

// A LARGE-STAKE target (= the OLD SHIFT=30 saturation cap, ≈151k SATORI). With
// the current PR_RAW_SHIFT=40 the real cap is ~155M SATORI (unreachable), so we
// farm alice above THIS threshold only to exercise large-stake consistency.
const RAW_CAP = (((1n << 47n) - 1n) << 30n); // ≈ 151,115.7 SATORI in wei (old-cap-sized target)

async function createStream(satori, signer, name) {
  const fee = await satori.streamBurn();
  if ((await satori.balanceOf(signer.address)) < fee) {
    await satori.transfer(signer.address, fee);
  }
  const tx = await satori.connect(signer)["createSimpleDataStream(string,address,uint24)"](name, signer.address, 2880);
  const rcpt = await tx.wait();
  for (const log of rcpt.logs) {
    try {
      const p = satori.interface.parseLog(log);
      if (p && p.name === "DataStreamCreated") return p.args.streamId;
    } catch (e) {}
  }
  throw new Error("DataStreamCreated event missing");
}

// Pull the score-time `scaledWeight` (the numerator) out of the
// PredictionScored event emitted by settlePrediction.
async function settleAndGetScaledWeight(satori, user, gameId) {
  const tx = await satori.settlePrediction(user, gameId);
  const rcpt = await tx.wait();
  for (const log of rcpt.logs) {
    try {
      const p = satori.interface.parseLog(log);
      if (p && p.name === "PredictionScored" && p.args.user === user) {
        return { correct: p.args.correct, scaledWeight: p.args.scaledWeight };
      }
    } catch (e) {}
  }
  throw new Error("PredictionScored event missing for " + user);
}

// Farm `alice` toward a target prediction power by repeatedly predicting UP on
// a rising stream and letting unclaimed rewards compound back into her power.
// Stops once getPredictionPower(alice) >= target. Returns the final power.
async function farmTo(satori, registry, rewards, owner, authority, alice, stream, target, maxRounds) {
  let v = 100;
  await registry.connect(authority).setValue(stream, v);
  for (let r = 0; r < maxRounds; r++) {
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream, payload: pack1(UP) }]);
    // AB window: the first post-anchor value settles the prediction. The second
    // post below is the NEXT cycle's anchor, posted a full cadence period later.
    await advanceOneDay();
    v += 10; await registry.connect(authority).setValue(stream, v);
    await satori.settlePrediction(alice.address, stream);
    await advanceOneDay();
    v += 10; await registry.connect(authority).setValue(stream, v);
    if ((await rewards.getPredictionPower(alice.address)) >= target) break;
  }
  return rewards.getPredictionPower(alice.address);
}

describe("ADV-5 predictions: rawPower saturation denominator drift", function () {
  this.timeout(120000);

  let satori, voting, rewards, lens, registry, owner, alice, bob, authority;
  let farmStream;

  beforeEach(async function () {
    const fix = await loadFixture(deploySatoriFixture);
    ({ satori, voting, rewards, lens, registry, owner } = fix);
    [, alice, bob, authority] = fix.signers;
    // (The fixture already calls initializeDefaultStream(), exactly as
    // production does, so game id 1 is the default game and the first stream
    // this file creates is id 2.)
    await satori.transfer(alice.address, ethers.parseEther("100"));
    await satori.transfer(bob.address, ethers.parseEther("100"));
    await satori.transfer(authority.address, ethers.parseEther("100"));
    farmStream = await createStream(satori, authority, "farm");
    await voteFor(satori, owner, farmStream);
    // Phase-align BEFORE any setValue: the chain starts at an arbitrary
    // wall-clock offset into the 24h round, and the FIRST aligned advance
    // (see advanceOneDay above) is only as long as the distance to the next
    // boundary — which can be shorter than the 30-min cadence-gap slack.
    // Jumping to boundary+5 here (no setValue has happened yet, so no gap
    // check applies) makes every subsequent advance a full cadence period.
    await advanceOneDay();
  });

  it("INTENDED: denominator == Σ(score-time numerators) for a whale stake above the cap", async function () {
    // 1) Farm alice's prediction power above the saturation cap. The probe in
    //    this directory measured the crossover near round ~277; 400 rounds is a
    //    safe ceiling and still runs in a few seconds.
    const power = await farmTo(
      satori, registry, rewards, owner, authority, alice, farmStream, RAW_CAP + ethers.parseEther("1"), 400
    );
    expect(power).to.be.gt(RAW_CAP, "alice did not reach the cap; cannot exercise saturation");

    // 2) Fresh, eligible single stream for the actual scored round so the only
    //    predictors on it are the whale (alice) and a tiny co-predictor (bob).
    const s = await createStream(satori, authority, "scored");
    await voteFor(satori, owner, s);

    await registry.connect(authority).setValue(s, 100);

    // alice predicts a 1-entry batch => perStreamPower = full power (no
    // division), which exceeds the cap. bob predicts the same direction with a
    // tiny stake. Both are committed into totalWeightPacked at predict time.
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: s, payload: pack1(UP) }]);
    await satori.connect(bob).predictMultipleWithPayloads([{ gameId: s, payload: pack1(UP) }]);

    const round = await satori.getCurrentRound();
    // Predict-time denominator for (s, round, UP).
    const denom = await lens.totalWeightByDirection(s, round, UP);

    // 3) Resolve UP correct (post > anchor across the cadence window).
    await advanceOneDay();
    await registry.connect(authority).setValue(s, 110);

    // 4) Settle both; capture the score-time numerator (scaledWeight) each.
    const aRes = await settleAndGetScaledWeight(satori, alice.address, s);
    const bRes = await settleAndGetScaledWeight(satori, bob.address, s);
    expect(aRes.correct).to.equal(true);
    expect(bRes.correct).to.equal(true);

    const sumNumerators = aRes.scaledWeight + bRes.scaledWeight;

    // INTENDED INVARIANT: the predict-time denominator equals the sum of the
    // score-time numerators (single source of truth `_deriveWeight`), modulo
    // sub-nano-SATORI quantization dust. If this holds, _computeReward fully
    // distributes the stream pool (streamPool * ΣuserWeight / totalWeight ==
    // streamPool) with no stranded residual and no short-changed co-predictor.
    //
    // Under the saturation bug, alice's score-time numerator is clamped to the
    // cap while her predict-time contribution to `denom` used her full power,
    // so sumNumerators << denom by a catastrophic (non-dust) margin.
    expect(denom - sumNumerators).to.be.lte(
      SCALED_WEIGHT_TOLERANCE,
      "denominator (predict-time, full power) exceeds Σ score-time numerators " +
      "(saturated) by more than dust => stream pool under-distributed"
    );
  });

  it("CONTROL: just-under-the-cap whale leaves only dust drift", async function () {
    // Farm alice to a large stake that stays just UNDER the cap. Stop early.
    const target = RAW_CAP - ethers.parseEther("5000");
    const power = await farmTo(
      satori, registry, rewards, owner, authority, alice, farmStream, target, 400
    );
    // It is fine if we land slightly under target; we just need < cap and large.
    expect(power).to.be.lt(RAW_CAP, "control alice unexpectedly exceeded the cap");
    expect(power).to.be.gt(ethers.parseEther("50000"), "control alice stake too small to be meaningful");

    const s = await createStream(satori, authority, "scored2");
    await voteFor(satori, owner, s);
    await registry.connect(authority).setValue(s, 100);

    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: s, payload: pack1(UP) }]);
    await satori.connect(bob).predictMultipleWithPayloads([{ gameId: s, payload: pack1(UP) }]);

    const round = await satori.getCurrentRound();
    const denom = await lens.totalWeightByDirection(s, round, UP);

    await advanceOneDay();
    await registry.connect(authority).setValue(s, 110);

    const aRes = await settleAndGetScaledWeight(satori, alice.address, s);
    const bRes = await settleAndGetScaledWeight(satori, bob.address, s);
    const sumNumerators = aRes.scaledWeight + bRes.scaledWeight;

    // Below the cap, the only gap is the documented 2^30 quantization dust,
    // which SCALED_WEIGHT_TOLERANCE is sized to absorb.
    expect(denom - sumNumerators).to.be.lte(SCALED_WEIGHT_TOLERANCE);
  });
});
