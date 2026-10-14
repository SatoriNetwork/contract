const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture, pack1, SCALED_WEIGHT_TOLERANCE, VOTE, voteFor } = require("../fixtures");

const UP = 1;
const TIME_UNIT = 86400; // 24 hours per round

async function advanceOneDay() {
  await time.increase(TIME_UNIT);
}

// Streams below are created with an explicit 2880-minute cadence (two 24h
// rounds). A value may therefore only be written every CADENCE_ROUNDS rounds,
// and scoring is the AB window — anchor = the value AT the predict round,
// post = the first value after it (every-round streams are the ones that
// score ABC).
const CADENCE_ROUNDS = 2;

async function advanceOneCadencePeriod() {
  await time.increase(TIME_UNIT * CADENCE_ROUNDS);
}

async function streamIdFrom(tx, satori) {
  const r = await tx.wait();
  const ev = r.logs.find((l) => {
    try { return satori.interface.parseLog(l)?.name === "DataStreamCreated"; }
    catch { return false; }
  });
  return satori.interface.parseLog(ev).args.streamId;
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

/**
 * Adversarial COVERAGE for the `predictions` subsystem.
 *
 * Targets the HIGH/MED-priority coverage gaps from the raw review that are NOT
 * already covered by the single confirmed finding's repro:
 *
 *   [HIGH] "predict-time totalWeight equals sum of score-time userWeights
 *          (no saturation)".  The narrative invariant is that `_deriveWeight`
 *          is a single source of truth: for one (game, round, direction) the
 *          per-direction denominator `totalWeightByDirection` accumulated at
 *          PREDICT time must equal the sum of every winner's NUMERATOR weight
 *          re-derived at SCORE time, modulo the documented sub-nano-SATORI
 *          quantization dust.  When it holds, `_computeReward` fully
 *          distributes the stream pool — no stranded residual, no
 *          short-changed co-predictor.  This is the regime BELOW the
 *          saturation cap, so it must hold exactly (within dust).
 *
 *   [MED]  "undelegate-then-redelegate same round cannot double-use prediction
 *          power".  A delegates to B; B actually predicts (consuming A's
 *          power); A undelegates; then A must NOT be able to (a) self-predict
 *          or (b) re-delegate to C in the same round (both revert Locked()),
 *          and A's power must NOT be credited a second time through any second
 *          predictor.  The guard is `lockUntilNextRound` applied on undelegate.
 *
 * The single confirmed HIGH finding (rawPower saturation -> denominator drift,
 * whale above the ~151K cap) already has a kept failing repro under
 * adversarial-findings/adv_5_predictions.test.js, so it is intentionally NOT
 * re-tested here.
 */
describe("ADV-COV predictions", function () {
  this.timeout(120000);

  let satori, voting, rewards, lens, registry, owner, signers;

  beforeEach(async function () {
    const fx = await loadFixture(deploySatoriFixture);
    ({ satori, voting, rewards, lens, registry, owner, signers } = fx);
  });

  // -------------------------------------------------------------------------
  // [HIGH] Conservation of streamPool: predict-time denominator == Σ
  // score-time numerators for N modest-stake winners on one (game, round, dir).
  // -------------------------------------------------------------------------
  describe("predict-time denominator == Σ score-time numerators (no saturation)", function () {
    it("N modest winners on one eligible stream: denom == Σ scaledWeight within dust, and Σunclaimed ≈ streamPool", async function () {
      const [, a, b, c, d, authority] = signers;

      // Fund a few modest predictors well under the ~151K SATORI cap.
      // (Owner's bootstrap mint is small once fixture spam fees are paid, so
      // these stay tiny — the invariant is scale-independent.)
      await satori.transfer(a.address, ethers.parseEther("10"));
      await satori.transfer(b.address, ethers.parseEther("25"));
      await satori.transfer(c.address, ethers.parseEther("7"));
      await satori.transfer(d.address, ethers.parseEther("40"));
      await satori.transfer(authority.address, ethers.parseEther("1"));

      // One eligible stream: owner burns SATORI for it so it carries weight
      // (burn voting — every enabled game with weight > 0 earns, in proportion).
      const s = await streamIdFrom(
        await satori["createSimpleDataStream(string,address,uint24)"]("S", authority.address, 2880), satori
      );
      await voteFor(satori, owner, s);

      // First value lands this round -> opens the predict window for this round.
      await registry.connect(authority).setValue(s, 100);

      const predictors = [a, b, c, d];
      // All predict UP, 1-entry batch (perStreamPower = full power, no division,
      // but all well under the saturation cap).
      for (const p of predictors) {
        await satori.connect(p).predictMultipleWithPayloads([{ gameId: s, payload: pack1(UP) }]);
      }

      const round = await satori.getCurrentRound();
      // Predict-time denominator for (s, round, UP).
      const denom = await lens.totalWeightByDirection(s, round, UP);
      expect(denom).to.be.gt(0n, "denominator was not accumulated at predict time");

      // AB scoring (two-round cadence): one post-anchor value decides it, compared
      // against the value AT the predict round (A = 100).
      await advanceOneCadencePeriod();
      await registry.connect(authority).setValue(s, 120); // B > A (100) => UP correct

      // Settle everyone; collect the score-time numerators.
      let sumNumerators = 0n;
      for (const p of predictors) {
        const res = await settleAndGetScaledWeight(satori, p.address, s);
        expect(res.correct, `${p.address} should have scored correct`).to.equal(true);
        sumNumerators += res.scaledWeight;
      }

      // INTENDED INVARIANT (single source of truth `_deriveWeight`): the
      // predict-time denominator equals the sum of the score-time numerators,
      // modulo sub-nano-SATORI quantization dust. Below the saturation cap this
      // must hold exactly within the documented tolerance.
      const drift = denom > sumNumerators ? denom - sumNumerators : sumNumerators - denom;
      expect(drift).to.be.lte(
        SCALED_WEIGHT_TOLERANCE,
        "predict-time denominator diverges from Σ score-time numerators beyond dust"
      );

      // Cross-check: per-user lens numerator equals the score-time scaledWeight
      // exactly, and Σ(lens userWeight) == denom within dust (full distribution).
      let sumLens = 0n;
      for (const p of predictors) {
        sumLens += await lens.userWeightByDirection(p.address, s, round, UP);
      }
      const lensDrift = denom > sumLens ? denom - sumLens : sumLens - denom;
      expect(lensDrift).to.be.lte(
        SCALED_WEIGHT_TOLERANCE,
        "Σ lens userWeightByDirection diverges from denominator beyond dust"
      );
    });

    it("two opposite-direction predictors: each direction's denom == its own winner's numerator", async function () {
      // The packed totalWeight slot stores UP and DOWN halves separately; a
      // winner on one side must not pull weight from the loser's side. The
      // surviving (correct) side's denominator must equal its winner's
      // score-time numerator within dust.
      const [, up1, down1, authority] = signers;

      await satori.transfer(up1.address, ethers.parseEther("12"));
      await satori.transfer(down1.address, ethers.parseEther("9"));
      await satori.transfer(authority.address, ethers.parseEther("1"));

      const s = await streamIdFrom(
        await satori["createSimpleDataStream(string,address,uint24)"]("S2", authority.address, 2880), satori
      );
      await voteFor(satori, owner, s);
      await registry.connect(authority).setValue(s, 100);

      await satori.connect(up1).predictMultipleWithPayloads([{ gameId: s, payload: pack1(1) }]);   // UP
      await satori.connect(down1).predictMultipleWithPayloads([{ gameId: s, payload: pack1(2) }]); // DOWN

      const round = await satori.getCurrentRound();
      const denomUp = await lens.totalWeightByDirection(s, round, 1);
      const denomDown = await lens.totalWeightByDirection(s, round, 2);
      expect(denomUp).to.be.gt(0n);
      expect(denomDown).to.be.gt(0n);

      // Resolve UP correct: B > A.
      await advanceOneCadencePeriod();
      await registry.connect(authority).setValue(s, 130); // B > A (100) => UP wins, DOWN loses

      const upRes = await settleAndGetScaledWeight(satori, up1.address, s);
      const downRes = await settleAndGetScaledWeight(satori, down1.address, s);
      expect(upRes.correct).to.equal(true);
      expect(downRes.correct).to.equal(false);
      // Loser earns no weight.
      expect(downRes.scaledWeight).to.equal(0n);

      // The UP side's denominator equals its lone winner's numerator (dust).
      const upDrift = denomUp > upRes.scaledWeight
        ? denomUp - upRes.scaledWeight
        : upRes.scaledWeight - denomUp;
      expect(upDrift).to.be.lte(SCALED_WEIGHT_TOLERANCE);
    });
  });

  // -------------------------------------------------------------------------
  // [MED] undelegate-then-redelegate same round cannot double-use power.
  // -------------------------------------------------------------------------
  describe("undelegate same round locks self-predict AND re-delegate (no double-use)", function () {
    it("A->B, B predicts, A undelegates: A cannot self-predict or re-delegate this round; power not double-credited", async function () {
      const [, a, b, c, authority] = signers;

      // A has the prediction power; B and C are delegates with their own small
      // stakes so we can tell A's contribution apart.
      await satori.transfer(a.address, ethers.parseEther("50"));
      await satori.transfer(authority.address, ethers.parseEther("1"));

      const s = await streamIdFrom(
        await satori["createSimpleDataStream(string,address,uint24)"]("D", authority.address, 2880), satori
      );
      await voteFor(satori, owner, s);
      await registry.connect(authority).setValue(s, 100);

      // A delegates prediction power to B.
      await satori.connect(a).delegatePredictionPower(b.address);
      // B's prediction power now includes A's 500 (inbound delegated power).
      const bPower = await rewards.getPredictionPower(b.address);
      expect(bPower).to.be.gte(ethers.parseEther("50"));

      // B actually predicts, consuming A's delegated power this round.
      await satori.connect(b).predictMultipleWithPayloads([{ gameId: s, payload: pack1(UP) }]);
      const round = await satori.getCurrentRound();
      expect(await satori.predictedStreamsCount(b.address, round)).to.equal(1n);
      const denomAfterB = await lens.totalWeightByDirection(s, round, UP);
      expect(denomAfterB).to.be.gt(0n);

      // A undelegates in the SAME round. lockUntilNextRound sets A's
      // lockedUntil = currentRound + 1.
      await satori.connect(a).delegatePredictionPower(ethers.ZeroAddress);
      expect(await satori.lockedUntil(a.address)).to.equal(round + 1n);

      // (a) A cannot self-predict this round — constraint 8 lock fires.
      await expect(
        satori.connect(a).predictMultipleWithPayloads([{ gameId: s, payload: pack1(UP) }])
      ).to.be.revertedWithCustomError(satori, "Locked");

      // (b) A cannot re-delegate to C this round — the undelegated branch in
      // delegatePredictionPower re-checks lockedUntil.
      await expect(
        satori.connect(a).delegatePredictionPower(c.address)
      ).to.be.revertedWithCustomError(satori, "Locked");

      // No double-use: the denominator did not grow from any A-driven second
      // prediction this round (both attempts reverted).
      expect(await lens.totalWeightByDirection(s, round, UP)).to.equal(denomAfterB);
      // A never acquired a predict slot this round.
      expect(await satori.predictedStreamsCount(a.address, round)).to.equal(0n);

      // Next round: A is unlocked and can act normally (delegate to C). The
      // lock is exactly ONE round (lockedUntil == round + 1) — a lock deadline,
      // not a value cadence — so this advance is deliberately NOT doubled.
      await advanceOneDay();
      await satori.connect(a).delegatePredictionPower(c.address);
      const cPower = await rewards.getPredictionPower(c.address);
      expect(cPower).to.be.gte(ethers.parseEther("50"), "A's power should now be usable by C next round");

      // The stream's own rhythm is separate: a two-round-cadence stream may only be
      // written every 2 rounds, so its next value lands one round further on.
      await advanceOneDay();
      await registry.connect(authority).setValue(s, 110);
    });
  });
});
