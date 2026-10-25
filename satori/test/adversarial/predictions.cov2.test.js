const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture, pack1, voteFor } = require("../fixtures");

const UP = 1;
const TIME_UNIT = 86400; // 24 hours per round
const DEFAULT_ID = 1;

async function advanceOneRound() {
  await time.increase(TIME_UNIT);
}

// The streams below are created at an explicit 2880-minute (two-round)
// cadence. A value may only be written every CADENCE_ROUNDS rounds, so on such
// a stream there is a round between writes in which nobody can predict at all
// — the freshness cases below straddle it.
const CADENCE_ROUNDS = 2;

async function streamIdFrom(tx, satori) {
  const r = await tx.wait();
  const ev = r.logs.find((l) => {
    try { return satori.interface.parseLog(l)?.name === "DataStreamCreated"; }
    catch { return false; }
  });
  return satori.interface.parseLog(ev).args.streamId;
}

/**
 * ADV-COV (round 2) for the `predictions` subsystem — MEDIUM/remaining edges.
 *
 * The two HIGH gaps ("predict-time totalWeight == Σ score-time userWeights"
 * and the >151K saturation-cap whale under-payment) and the single MED gap
 * ("undelegate-then-redelegate same round cannot double-use power") are
 * ALREADY covered by predictions.cov.test.js and the confirmed repro
 * adv_5_predictions.test.js, so they are intentionally NOT re-tested here.
 *
 * What remains are the two LOW-priority freshness/window edges flagged in the
 * raw review's coverage_gaps. The single most valuable, deterministically
 * testable one is:
 *
 *   "Default-stream one-round-lag predict window combined with constraint-4
 *    freshness across consecutive rounds. The `streamLastUpdate <=
 *    lastPredRound` check plus the round-1 expected-round exception is an
 *    off-by-one-prone area; a dedicated test that a user cannot double-predict
 *    a stream across rounds where its value did not advance would lock the
 *    behavior."
 *
 * These tests pin the phase-6 (moment-anchored) predict-window state machine
 * in SatoriEngine.predictMultipleWithPayloads:
 *
 *   - PredictExpired is DELETED: a prediction anchors to its own moment (the
 *     standing sample at-or-before its hour), so a fresh predictor is admitted
 *     at ANY moment — there is no expected-round window any more.
 *   - Game clock: one batch per user per round (AlreadyPredicted fires first),
 *     one predict per user per game per round (DuplicatePrediction), and for
 *     games with targetMinutes > 1440 (a 2880-minute stream defaults its game
 *     to tgt = 2880) at least tgt/60 hours between a user's predictions on
 *     that game — also DuplicatePrediction. Predicting exactly at +tgt/60
 *     hours is allowed.
 *   - Constraint-4 freshness survives: once past the game clock, a user still
 *     cannot re-predict until the stream has a WRITE strictly after their
 *     last prediction's hour (else StaleValue). The clock guards run BEFORE
 *     the staleness check, so inside the target window a stale re-predict
 *     surfaces as DuplicatePrediction, and only past it as StaleValue.
 */
describe("ADV-COV2 predictions: predict-window freshness / one-round-lag", function () {
  this.timeout(120000);

  let satori, registry, lens, engine, owner, signers;

  beforeEach(async function () {
    const fx = await loadFixture(deploySatoriFixture);
    ({ satori, registry, lens, engine, owner, signers } = fx);
  });

  // -------------------------------------------------------------------------
  // NORMAL stream: constraint-4 freshness across consecutive rounds.
  // -------------------------------------------------------------------------
  describe("normal stream: cannot double-predict across rounds without a fresh value", function () {
    it("re-predict in same round => AlreadyPredicted; inside the 48h target window => DuplicatePrediction; past it with a STALE value => StaleValue; fresh value => allowed", async function () {
      const [, a, authority] = signers;
      await satori.transfer(a.address, ethers.parseEther("10"));
      await satori.transfer(authority.address, ethers.parseEther("1"));

      const s = await streamIdFrom(
        await satori["createSimpleDataStream(string,address,uint24)"]("FRESH", authority.address, 2880), satori
      );
      await voteFor(satori, owner, s);

      // Round R: post a value, then predict. This is the only fresh window.
      await registry.connect(authority).setValue(s, 100);
      const r = await satori.getCurrentRound();
      await satori.connect(a).predictMultipleWithPayloads([{ gameId: s, payload: pack1(UP) }]);
      expect(await satori.predictedStreamsCount(a.address, r)).to.equal(1n);

      // Same round, second batch => AlreadyPredicted (the one-batch-per-round
      // lock in predictMultipleWithPayloads fires before any per-game guard).
      await expect(
        satori.connect(a).predictMultipleWithPayloads([{ gameId: s, payload: pack1(UP) }])
      ).to.be.revertedWithCustomError(satori, "AlreadyPredicted");

      // Next round: this game's targetMinutes defaults to its 2880-minute
      // stream cadence, so the moment-anchored game clock demands 48h between
      // a user's predictions on it. Only 24h have passed =>
      // DuplicatePrediction (the clock guard runs before the staleness check,
      // so the stale value never gets to surface here).
      await advanceOneRound();
      const r2 = await satori.getCurrentRound();
      expect(r2).to.equal(r + 1n);
      await expect(
        satori.connect(a).predictMultipleWithPayloads([{ gameId: s, payload: pack1(UP) }])
      ).to.be.revertedWithCustomError(satori, "DuplicatePrediction");
      // No predict slot was acquired by the reverted attempt.
      expect(await satori.predictedStreamsCount(a.address, r2)).to.equal(0n);

      // R+1 is also the CADENCE GAP: this stream runs at a two-round (2880
      // minute) cadence, so the provider may not post again until R+2. Prove
      // that too — the gap is precisely why R+1 is a round in which nobody can
      // re-predict this stream at all.
      await expect(
        registry.connect(authority).setValue(s, 110)
      ).to.be.revertedWithCustomError(registry, "CadenceRoundsNotElapsed");

      // R+2 (exactly +48h — predicting exactly at the target boundary is
      // allowed by the clock), but the stream value did NOT advance since a's
      // prediction => StaleValue. This is the core double-use guard that
      // survives phase 6: no new value, no new prediction.
      await advanceOneRound();
      const r3 = await satori.getCurrentRound();
      expect(r3).to.equal(r + BigInt(CADENCE_ROUNDS));
      await expect(
        satori.connect(a).predictMultipleWithPayloads([{ gameId: s, payload: pack1(UP) }])
      ).to.be.revertedWithCustomError(satori, "StaleValue");
      expect(await satori.predictedStreamsCount(a.address, r3)).to.equal(0n);

      // Still R+2: the cadence period has elapsed, so a FRESH value may be
      // posted. It lands strictly after a's last prediction hour, so the
      // predict is now permitted.
      await registry.connect(authority).setValue(s, 110);
      await satori.connect(a).predictMultipleWithPayloads([{ gameId: s, payload: pack1(UP) }]);
      expect(await satori.predictedStreamsCount(a.address, r3)).to.equal(1n);
    });

    it("guard order: inside the target window a stale re-predict surfaces as DuplicatePrediction, while a FRESH predictor is admitted the same moment", async function () {
      // Same adversarial spot the old StaleValue-vs-PredictExpired test
      // probed: a stale, non-current value one round after A predicted. Under
      // phase 6 the re-predictor A is refused by the game CLOCK
      // (DuplicatePrediction — checked before staleness), while the fresh
      // predictor B, who used to hit PredictExpired here, is now ADMITTED:
      // predictions are moment-anchored, so any standing sample works. This
      // pins both the guard order and the PredictExpired deletion.
      const [, a, b, authority] = signers;
      await satori.transfer(a.address, ethers.parseEther("10"));
      await satori.transfer(b.address, ethers.parseEther("10"));
      await satori.transfer(authority.address, ethers.parseEther("1"));

      const s = await streamIdFrom(
        await satori["createSimpleDataStream(string,address,uint24)"]("ORDER", authority.address, 2880), satori
      );
      await voteFor(satori, owner, s);

      // Round R: post a value; A predicts on it.
      await registry.connect(authority).setValue(s, 100);
      await satori.connect(a).predictMultipleWithPayloads([{ gameId: s, payload: pack1(UP) }]);

      // Round R+1, value NOT advanced.
      await advanceOneRound();
      const r2 = await satori.getCurrentRound();

      // A (already predicted, only 24h into the game's 48h target window) =>
      // DuplicatePrediction. The staleness of the value never surfaces —
      // the clock guard precedes it.
      await expect(
        satori.connect(a).predictMultipleWithPayloads([{ gameId: s, payload: pack1(UP) }])
      ).to.be.revertedWithCustomError(satori, "DuplicatePrediction");

      // B (never predicted) is admitted against the STANDING value from R —
      // no expected-round window exists any more.
      await satori.connect(b).predictMultipleWithPayloads([{ gameId: s, payload: pack1(UP) }]);
      expect(await satori.predictedStreamsCount(b.address, r2)).to.equal(1n);
    });

    it("fresh predictor on a non-current value is ADMITTED and anchors to the standing sample (PredictExpired deleted)", async function () {
      // The old rule refused this predict with PredictExpired (the value was
      // from R, not R+1). Phase 6 deletes that window: predicting works any
      // moment, and the prediction's anchor is the standing sample at its own
      // moment. Prove all THREE halves of the uniform moment-anchored rule —
      // the predict succeeds; the very next write does NOT settle it (b
      // predicted late in the period, only 24h before that write, less than
      // the 48h target minus the 30-minute allowance, so the target pushes to
      // the sample after — the horizon-compression exploit the target rule
      // kills); and the settling sample is scored against the R value b
      // anchored on, not any later one.
      const [, b, authority] = signers;
      await satori.transfer(b.address, ethers.parseEther("10"));
      await satori.transfer(authority.address, ethers.parseEther("1"));

      const s = await streamIdFrom(
        await satori["createSimpleDataStream(string,address,uint24)"]("EXPIRE", authority.address, 2880), satori
      );
      await voteFor(satori, owner, s);

      // Value posted in round R.
      await registry.connect(authority).setValue(s, 100);
      // Advance WITHOUT posting again: the standing value is from R, current
      // round is R+1 — and the predict is now legal.
      await advanceOneRound();
      const r2 = await satori.getCurrentRound();
      await satori.connect(b).predictMultipleWithPayloads([{ gameId: s, payload: pack1(UP) }]);
      expect(await satori.predictedStreamsCount(b.address, r2)).to.equal(1n);

      // R+2: the cadence period since the R write elapses and the provider
      // posts. This sample is only ~24h after b's hour — short of the 48h
      // wait (ceil((2880*60 − 1800)/3600)) — so it is NOT b's target: the
      // prediction stays pending. It goes UP (150) so that if scoring ever
      // wrongly re-anchored on it, the final assertion below would flip.
      await advanceOneRound();
      await registry.connect(authority).setValue(s, 150);
      await expect(satori.settlePrediction(b.address, s))
        .to.not.emit(engine, "PredictionScored");

      // R+4: the next cadence write, ~72h after b's hour — the first sample
      // past the 48h wait, so it IS the target. 120 > 100 (the R anchor) =>
      // b's UP call is correct; against a wrong R+2 re-anchor (150) it would
      // be scored INCORRECT (120 < 150) — streak 1 proves the moment anchor.
      await advanceOneRound();
      await advanceOneRound();
      await registry.connect(authority).setValue(s, 120);
      await expect(satori.settlePrediction(b.address, s))
        .to.emit(engine, "PredictionScored");
      expect(await satori.streaks(b.address, s)).to.equal(1n);
    });
  });

  // -------------------------------------------------------------------------
  // DEFAULT stream: SAME-round predict window (_expectedRound == round), like
  // every normal every-round stream. The former default-only one-round lag was
  // removed when the default value moved to current-round indexing.
  // -------------------------------------------------------------------------
  describe("default stream: same-round predict window (every-round, no lag)", function () {
    it("default game accepts a predict against the CURRENT-round value in the init round (no one-round lag)", async function () {
      const [, a] = signers;
      await satori.transfer(a.address, ethers.parseEther("10"));

      // The fixture already ran initializeDefaultStream() (exactly as production
      // deploys), which seeded the default's value AT the deploy round —
      // current-round indexed — and that is still the current round here. The
      // default game no longer casts a bootstrap vote: its weight is DERIVED.
      const r0 = await satori.getCurrentRound();

      // Current-round indexing: streamLastUpdate(default) == R0 == current round,
      // so the default accepts a predict IN R0 against R0's value — the same-round
      // window every normal every-round stream uses. (Pre-fix this reverted
      // PredictExpired because the default expected round-1; that one-round lag is
      // gone with current-round indexing.)
      await satori.connect(a).predictMultipleWithPayloads([{ gameId: DEFAULT_ID, payload: pack1(UP) }]);
      expect(await satori.predictedStreamsCount(a.address, r0)).to.equal(1n);
    });

    it("default game is predictable EVERY round (every-round cadence); same-round re-predict is AlreadyPredicted (audit M5)", async function () {
      const [, a, authority] = signers;
      await satori.transfer(a.address, ethers.parseEther("10"));
      await satori.transfer(authority.address, ethers.parseEther("1"));

      // Default stream already initialized by the fixture (see above).
      const r0 = await satori.getCurrentRound();

      // R0+1: the predict auto-flushes the default to value@(R0+1), then predicts
      // against it — the same-round (current-round) window.
      await advanceOneRound();
      const r1 = await satori.getCurrentRound();
      await satori.connect(a).predictMultipleWithPayloads([{ gameId: DEFAULT_ID, payload: pack1(UP) }]);
      expect(await satori.predictedStreamsCount(a.address, r1)).to.equal(1n);

      // Same round, second batch => AlreadyPredicted (one-batch-per-round lock).
      // This — not StaleValue — is what stops a same-round double predict.
      await expect(
        satori.connect(a).predictMultipleWithPayloads([{ gameId: DEFAULT_ID, payload: pack1(UP) }])
      ).to.be.revertedWithCustomError(satori, "AlreadyPredicted");

      // Every subsequent round the predict's own pull writes the default
      // stream's snapshot, so its value advances to a NEW current-round value each round. With the
      // freshness check using the same-round window (`streamLastUpdate == round`)
      // and the staleness threshold `streamLastUpdate > lastPredRound`, the
      // default game lands a prediction EVERY round — not every other round
      // (the original M5 throttle; current-round indexing preserves the
      // every-round cadence without the former one-round lag).
      for (let k = 0; k < 3; k++) {
        await advanceOneRound();
        const rk = await satori.getCurrentRound();
        await satori.connect(a).predictMultipleWithPayloads([{ gameId: DEFAULT_ID, payload: pack1(UP) }]);
        expect(await satori.predictedStreamsCount(a.address, rk)).to.equal(1n);
      }
      expect(Number(r0)).to.be.greaterThan(0); // sanity: deployment round captured
    });
  });
});
