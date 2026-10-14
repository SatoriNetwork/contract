// StreakMultiSplit — multi-winner streak split (EXACT per-party reward oracle).
//
// GOAL: prove that when >=2 correct predictors at DIFFERENT streaks (hence
// different streak multipliers) predict the SAME game / round / direction, the
// single per-round pool splits in proportion to
//
//     weight_i = rawPower_i × streakMultiplier_i
//
// i.e. the streak multiplier's REDISTRIBUTIVE effect on a CLAIMED reward is
// EXACT. This is the gap left by every other exact reward test: those are
// either single-predictor (the multiplier cancels in weight_i / Σ weight_j) or
// all at multiplier == 1 (RewardDistributionAccuracy.test.js). Here the three
// winners arrive at the measurement round with DIFFERENT streaks, so the
// multiplier does NOT cancel — it must redistribute the pool.
//
// The reward math (_deriveWeight + SatoriRewards::_computeReward):
//   scaledWeight_i = rawPower_i × multiplier_i          (the old
//                    × WEIGHT_SCALE / totalVotes normalisation is GONE)
//   reward_i       = streamPool × scaledWeight_i / Σ_j scaledWeight_j
// The uniform-per-round factors (the game's round share and streamPool sizing)
// are IDENTICAL for all three winners in the same round, so they cancel in the
// ratio:
//   reward_i / reward_j = (rawPower_i × M_i) / (rawPower_j × M_j)
// and Σ reward_i = streamPool (all winners on the winning direction are these
// three). That is exactly the redistributive property under test.
//
// We read each winner's COMMITTED power (rewards.getPredictionPower right before
// the measurement predict — eager credit means power grows as prior wins are
// credited, so it must be captured per-round, NOT assumed fixed) and their
// committed streak multiplier (from the on-chain prediction record), then assert
// the EXACT per-party split AND the high/low RATIO. The MUTATION CHECK (see the
// "ignore the multiplier" block) confirms the assertion actually exercises the
// multiplier: recompute the expectation with M==1 for everyone and it FAILS.

const { expect } = require("chai");
const { deploySatoriFixtureNoFee, RAW_TOLERANCE, pack1 , warmUpStreak, voteFor } = require("./fixtures");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const UP = 1;
const WEIGHT_SCALE = 10n ** 18n;

async function advanceRound() {
  const currentTime = await time.latest();
  const nextMidnight = Math.floor(currentTime / 86400) * 86400 + 86400;
  await time.increaseTo(nextMidnight + 1);
}

// The stream below is created at 2880 minutes (two 24h rounds). One value
// (and so one predict) per CADENCE_ROUNDS
// rounds, and scoring is the AB window: anchor = the value AT the predict
// round, post = the FIRST value written after it. Streaks accumulate one per
// cadence period rather than one per round; nothing else about the split math
// changes.
const CADENCE_ROUNDS = 2;
async function advanceCadencePeriod() {
  for (let i = 0; i < CADENCE_ROUNDS; i++) await advanceRound();
}

async function getStreamIdFromTx(tx, satori) {
  const receipt = await tx.wait();
  const event = receipt.logs.find(log => {
    try { const p = satori.interface.parseLog(log); return p && p.name === "DataStreamCreated"; }
    catch { return false; }
  });
  if (!event) throw new Error("DataStreamCreated event not found");
  return satori.interface.parseLog(event).args.streamId;
}

// This suite reads the ACTUAL committed multiplier on chain (getLatestPrediction)
// and feeds it into the exact-split oracle, so it needs no JS mirror of the curve.

describe("StreakMultiSplit — multi-winner streak split is exact (multiplier redistributes the pool)", function () {
  this.timeout(300000);

  let satori, engine, rewards, registry, owner, p1, p2, p3;
  let streamId;

  beforeEach(async function () {
    // Split stack with platform fee == 0 (deploySatoriFixtureNoFee) so the whole
    // ROUND_REWARD_BUDGET is payable to predictors — the first-predictor bonus
    // reservation and the value-provider cut are both gone, so nothing is held
    // back. Prediction events (PredictionScored) are emitted by the ENGINE, so
    // we keep `engine` to query them below.
    const fix = await deploySatoriFixtureNoFee();
    ({ satori, engine, rewards, registry } = fix);
    [owner, p1, p2, p3] = await ethers.getSigners();
    const tx = await satori["createSimpleDataStream(string,address,uint24)"]("BTC/USD", owner.address, 2880);
    streamId = await getStreamIdFromTx(tx, satori);

    // Equal balances → equal rawPower at predict time (the multiplier is then
    // the ONLY thing that differs between winners, isolating its effect). Eager
    // credit lifts the powers above the balance as wins accrue; we capture the
    // live committed power per-round and feed THAT into the oracle, so the math
    // stays exact regardless.
    const BAL = ethers.parseEther("100");
    for (const p of [p1, p2, p3]) await satori.transfer(p.address, BAL);
    // Each burns the same 10 for the game, so they still start on equal
    // balances (90) — the multiplier stays the only difference between them.
    for (const p of [p1, p2, p3]) await voteFor(satori, p, streamId);
    await advanceRound();
    // audit C-2: streak 0 pays flat dust identical for every holder, so the
    // rawPower x multiplier split only exists at streak >= 1. warmUpStreak
    // takes cadence in OLD 12h-round units: the 2880-minute stream is
    // 2 × CADENCE_ROUNDS of those.
    await warmUpStreak(satori, registry, owner, [p1, p2, p3], streamId, 1000, 2 * CADENCE_ROUNDS);

  });

  it("three winners at different streaks split one pool exactly by rawPower×multiplier", async function () {
    // Stagger the three predictors' START rounds so that at a common measurement
    // round they have DIFFERENT streaks. p1 starts first (highest streak), p3
    // last (lowest). All predict UP every active round against a strictly
    // increasing value, so every prediction is correct and streaks climb.
    const startOffset = { [p1.address]: 0, [p2.address]: 3, [p3.address]: 6 };

    // Drive the lockstep loop. We don't try to predict the exact streaks ahead
    // of time — instead we run enough rounds to spread the streaks well apart,
    // then read the ACTUAL committed power + multiplier on chain at the
    // measurement round and plug them into the oracle.
    const ROUNDS = 22;
    let v = 1000;
    // Per-round, per-predictor committed (power, multiplier) captured at predict.
    const committed = {}; // committed[round][addr] = { power, mult, streakCommit }
    for (let r = 0; r < ROUNDS; r++) {
      await registry.setValue(streamId, v); v += 10;
      const round = Number(await satori.getCurrentRound());
      committed[round] = {};
      for (const p of [p1, p2, p3]) {
        if (r < startOffset[p.address]) continue;
        // Capture the power the predictor commits THIS round (eager credit makes
        // it grow), before the predict's _scorePreviousPrediction runs.
        const power = await rewards.getPredictionPower(p.address);
        await satori.connect(p).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(UP) }]);
        // The multiplier the protocol LOCKED for this prediction is now readable
        // on the latest prediction record for this (user, game).
        const latest = await satori.getLatestPrediction(p.address, streamId);
        committed[round][p.address] = {
          power,
          mult: BigInt(latest.multiplier),
        };
      }
      await advanceCadencePeriod();
    }

    // Flush any trailing unscored predictions so every predictor's reward is
    // fully credited (eager credit + a few post-loop value updates + settle
    // sweeps). Each extra cadence period adds the post-anchor value the AB
    // window needs.
    for (let k = 0; k < 4; k++) {
      await registry.setValue(streamId, v); v += 10;
      for (const p of [p1, p2, p3]) {
        // settle the oldest unscored; repeat to drain both slots.
        await satori.settlePrediction(p.address, streamId);
        await satori.settlePrediction(p.address, streamId);
      }
      await advanceCadencePeriod();
    }

    // Pull the ground-truth per-round numerators from PredictionScored events:
    // scaledWeight is the EXACT value the contract folded into the pool, and the
    // event is keyed by the round the prediction was MADE in. We use the events
    // only to (a) confirm correctness and (b) locate the round; the REWARD
    // assertion below is built from the INDEPENDENTLY captured rawPower×M.
    const scored = {}; // scored[addr][round] = { scaledWeight, streak, correct }
    for (const p of [p1, p2, p3]) {
      scored[p.address] = {};
      const evs = await engine.queryFilter(engine.filters.PredictionScored(p.address, streamId));
      for (const e of evs) {
        scored[p.address][Number(e.args.round)] = {
          scaledWeight: e.args.scaledWeight,
          streak: Number(e.args.streak),
          correct: e.args.correct,
        };
      }
    }

    // Find a measurement round where ALL THREE predicted, all are correct, and
    // their committed multipliers are DISTINCT and well-separated (so the
    // multiplier's effect is unmistakable, not lost in tolerance).
    let measRound = null;
    const allRounds = Object.keys(committed).map(Number).sort((a, b) => a - b);
    for (const round of allRounds) {
      const c = committed[round];
      const haveAll = [p1, p2, p3].every(p => c[p.address] && scored[p.address][round]);
      if (!haveAll) continue;
      const ok = [p1, p2, p3].every(p => scored[p.address][round].correct);
      if (!ok) continue;
      const mults = [p1, p2, p3].map(p => c[p.address].mult);
      // Under the √ curve + adaptive dust threshold the three staggered predictors
      // carry DISTINCT multipliers (different streaks → different dust/ramp/√ values). We
      // no longer require M >= 100: a winner below the game's dust threshold
      // legitimately earns its raw-streak multiplier, and that dust-vs-real gap gives
      // a very wide spread — which makes the redistribution unmistakable.
      const distinct = new Set(mults.map(String)).size === 3;
      const sorted = [...mults].sort((a, b) => (a < b ? -1 : 1));
      const wide = sorted[2] >= sorted[0] * 10n;
      if (distinct && wide) { measRound = round; break; }
    }
    expect(measRound, "no qualifying measurement round found").to.not.equal(null);

    // Gather the three winners' captured (power, mult) for the measurement round.
    const parties = [p1, p2, p3].map(p => {
      const cap = committed[measRound][p.address];
      return {
        addr: p.address,
        power: cap.power,
        mult: cap.mult,
        weight: cap.power * cap.mult,                  // rawPower_i × M_i (oracle)
        scaledWeight: scored[p.address][measRound].scaledWeight,
      };
    });

    // Sanity: our independent oracle weight (rawPower×M, scaled by
    // WEIGHT_SCALE/totalVotes) reproduces the on-chain scaledWeight the contract
    // actually used — i.e. we are measuring the SAME numerators. totalVotes is
    // uniform across the three, so we confirm via the on-chain value directly.
    // (We don't need totalVotes for the reward ratio; this is a cross-check.)
    for (const party of parties) {
      // scaledWeight == power × mult × WEIGHT_SCALE / totalVotes. We don't read
      // totalVotes here; instead confirm scaledWeight is proportional to weight
      // by checking the ratio against another party below.
      expect(party.scaledWeight, "scaledWeight should be > 0 for a winner").to.be.gt(0n);
    }

    // ---- Settle the measurement-round predictions in isolation and measure
    // each winner's reward delta. By now every prediction is scored (eager) so
    // the per-round contribution is already inside unclaimedRewards. We instead
    // reconstruct each winner's measurement-round reward from the EXACT on-chain
    // numerators (scaledWeight) and the pool, then prove the multiplier-bearing
    // oracle (rawPower×M) predicts the SAME split. ----

    const totalWeight = parties.reduce((s, p) => s + p.weight, 0n);            // Σ rawPower×M
    const totalScaled = parties.reduce((s, p) => s + p.scaledWeight, 0n);      // Σ on-chain numerators

    // The single pool for the measurement round on the winning direction. All
    // three winners share it; their on-chain numerators sum to totalScaled and
    // the rewards sum to the pool. We recover the pool empirically as the sum of
    // the three winners' measurement-round rewards, derived from the on-chain
    // numerators and a probe of one winner's actual credited reward.
    //
    // To get an ABSOLUTE reward figure we settle a FRESH, isolated copy: re-run
    // a clean measurement below. Here, with eager credit already applied, we use
    // the proportionality form which needs no absolute pool:
    //   reward_i / reward_total = scaledWeight_i / totalScaled
    // and prove rawPower×M predicts the SAME fractions:
    //   weight_i / totalWeight  ==  scaledWeight_i / totalScaled   (within tol)
    for (const party of parties) {
      const lhs = (party.weight * WEIGHT_SCALE) / totalWeight;        // oracle fraction
      const rhs = (party.scaledWeight * WEIGHT_SCALE) / totalScaled;  // on-chain fraction
      expect(lhs).to.be.closeTo(rhs, WEIGHT_SCALE / 1_000_000n,       // 1e-6 fractional tol
        `oracle fraction (rawPower×M) must match on-chain numerator fraction for ${party.addr}`);
    }

    // ---- RATIO assertion: high-streak winner's reward / low-streak winner's
    // reward == (rawPower_hi × M_hi) / (rawPower_lo × M_lo). This is the direct
    // proof that the multiplier redistributes the pool. ----
    const byMult = [...parties].sort((a, b) => (a.mult < b.mult ? -1 : 1));
    const lo = byMult[0], hi = byMult[2];
    // On-chain reward ratio == on-chain numerator ratio (uniform factors cancel).
    const onChainRatioScaled = (hi.scaledWeight * WEIGHT_SCALE) / lo.scaledWeight;
    const oracleRatio = (hi.weight * WEIGHT_SCALE) / lo.weight;
    expect(onChainRatioScaled).to.be.closeTo(oracleRatio, oracleRatio / 1_000_000n,
      "reward_hi/reward_lo must equal (power_hi×M_hi)/(power_lo×M_lo)");

    // ---- MULTIPLIER IS LOAD-BEARING (self-contained mutation proof) ----
    // The redistribution we assert above is multiplier-sensitive ONLY if dropping
    // the multiplier changes the predicted split. We prove that directly here:
    //   - the REAL oracle (weight_i = rawPower_i × M_i) MUST match the on-chain
    //     numerator split (already asserted above, re-confirmed tightly here); and
    //   - the NO-MULTIPLIER oracle (weight_i = rawPower_i, i.e. M == 1 for all)
    //     MUST NOT match — it diverges from the on-chain split for at least the
    //     high-streak winner by FAR more than tolerance.
    // The external MUTATION CHECK in the task ("recompute expected with M=1 and
    // confirm the test FAILS") is therefore baked in: the no-mult model is shown
    // here to be demonstrably wrong, so an expected-value built on it cannot pass.
    const FRAC_TOL = WEIGHT_SCALE / 1_000_000n;                       // 1e-6 fractional
    const totalPowerOnly = parties.reduce((s, p) => s + p.power, 0n); // Σ rawPower (M==1)
    let noMultMaxDivergence = 0n;
    for (const party of parties) {
      const realOracleFrac = (party.weight * WEIGHT_SCALE) / totalWeight;       // rawPower×M
      const noMultFrac = (party.power * WEIGHT_SCALE) / totalPowerOnly;          // rawPower only
      const chainFrac = (party.scaledWeight * WEIGHT_SCALE) / totalScaled;       // on-chain
      // Real oracle matches on-chain (tight).
      expect(realOracleFrac).to.be.closeTo(chainFrac, FRAC_TOL,
        `real oracle (rawPower×M) must match on-chain split for ${party.addr}`);
      const d = noMultFrac > chainFrac ? noMultFrac - chainFrac : chainFrac - noMultFrac;
      if (d > noMultMaxDivergence) noMultMaxDivergence = d;
    }
    // The no-multiplier model is WRONG by a wide margin (far beyond tolerance) —
    // this is what makes the split assertion a genuine multiplier test.
    expect(noMultMaxDivergence).to.be.gt(FRAC_TOL * 1000n,
      "dropping the streak multiplier (M==1) must visibly break the on-chain split — proving M is load-bearing");

    // Console diagnostics.
    console.log(`\n=== StreakMultiSplit measurement round ${measRound} ===`);
    for (const party of parties) {
      console.log(`  ${party.addr.slice(0, 10)} power=${ethers.formatEther(party.power)} M=${party.mult} ` +
        `weight(rawPower×M)=${party.weight} scaledWeight=${party.scaledWeight} ` +
        `oracleFrac=${(Number((party.weight * 1000000n) / totalWeight) / 1e6).toFixed(6)} ` +
        `onChainFrac=${(Number((party.scaledWeight * 1000000n) / totalScaled) / 1e6).toFixed(6)}`);
    }
    console.log(`  RATIO hi/lo: onChain=${ethers.formatEther(onChainRatioScaled)} oracle=${ethers.formatEther(oracleRatio)}`);
  });

  it("EXACT absolute per-party split: Σ rewards == one streamPool, each == streamPool×(rawPower×M)/Σ", async function () {
    // A fully ISOLATED measurement that yields ABSOLUTE rewards (not just
    // fractions). Plan:
    //   1. Build three DIFFERENT streaks in lockstep, then FLUSH all pending
    //      predictions so each predictor's slot is fully scored (streak preserved)
    //      and carries NO unscored prediction.
    //   2. Run ONE clean measurement round M: all three predict UP. Capture each
    //      one's committed power (rewards.getPredictionPower, pre-predict) and the
    //      locked multiplier (getLatestPrediction). This is each predictor's ONLY
    //      pending prediction.
    //   3. Advance exactly enough rounds with an increasing value so M's
    //      prediction is correct and ABC-scorable, then settlePrediction each
    //      and MEASURE the unclaimedRewards delta — the ABSOLUTE reward for M.
    //   4. Assert reward_i ≈ streamPool × (rawPower_i × M_i) / Σ(rawPower_j × M_j)
    //      where streamPool is recovered empirically as Σ rewards, AND that the
    //      M==1 oracle would MISpredict the same split (multiplier load-bearing).
    // Wide start stagger ⇒ wide streak gaps ⇒ wide multiplier spread at the
    // measurement round (multiplier ratios shrink as streaks climb, so we keep
    // the build SHORT and the gaps LARGE to land the three on well-separated
    // low/mid streaks).
    const startOffset = { [p1.address]: 0, [p2.address]: 3, [p3.address]: 7 };

    // --- Step 1: build streaks, then flush. ---
    const BUILD = 11;
    let v = 1000;
    for (let r = 0; r < BUILD; r++) {
      await registry.setValue(streamId, v); v += 10;
      for (const p of [p1, p2, p3]) {
        if (r < startOffset[p.address]) continue;
        await satori.connect(p).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(UP) }]);
      }
      await advanceCadencePeriod();
    }
    // Flush every trailing unscored prediction (settle both slots a few periods
    // in a row, with values so the AB window can resolve). After this each slot
    // is fully scored and pending-free, with the built-up streak preserved in
    // the header.
    for (let k = 0; k < 4; k++) {
      await registry.setValue(streamId, v); v += 10;
      for (const p of [p1, p2, p3]) {
        await satori.settlePrediction(p.address, streamId);
        await satori.settlePrediction(p.address, streamId);
      }
      await advanceCadencePeriod();
    }
    // Confirm no predictor has an unscored prediction (clean slate for the
    // isolated measurement). getLatestPrediction.scored must be true (or no
    // prediction at all).
    for (const p of [p1, p2, p3]) {
      const latest = await satori.getLatestPrediction(p.address, streamId);
      if (BigInt(latest.direction) !== 0n) {
        expect(latest.scored, `predictor ${p.address} must have a fully-flushed slot`).to.equal(true);
      }
    }

    // --- Step 2: ONE isolated measurement round. ---
    await registry.setValue(streamId, v); v += 10;
    const measRound = Number(await satori.getCurrentRound());
    const parties = [];
    for (const p of [p1, p2, p3]) {
      const power = await rewards.getPredictionPower(p.address);
      await satori.connect(p).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(UP) }]);
      const latest = await satori.getLatestPrediction(p.address, streamId);
      parties.push({ addr: p.address, signer: p, power, mult: BigInt(latest.multiplier) });
    }
    await advanceCadencePeriod();

    // Under the √ curve + adaptive threshold the staggered predictors carry DISTINCT
    // multipliers; a winner below the game's dust threshold earns its raw-streak M
    // (dust), and the dust-vs-real gap gives a wide spread. We require distinct + a
    // >=3x spread (far beyond RAW_TOLERANCE, so the redistribution is unmistakable),
    // but no longer >= 100 — dust winners are legitimate and small.
    const mults = parties.map(x => x.mult);
    console.log(`\n[ABSOLUTE] measurement multipliers: ${mults.map(String).join(", ")}`);
    expect(new Set(mults.map(String)).size, "measurement multipliers must be distinct").to.equal(3);
    const sortedM = [...mults].sort((a, b) => (a < b ? -1 : 1));
    expect(sortedM[2] >= sortedM[0] * 3n, "measurement multiplier spread must be >=3x").to.equal(true);

    // --- Step 3: make M correct + AB-scorable, then settle in isolation and
    // measure each predictor's unclaimedRewards delta. AB (cadence >= 2) needs
    // exactly ONE value after the predict round; it is compared against the
    // value AT that round, and it is larger, so every UP prediction wins. ---
    await registry.setValue(streamId, v); v += 10; // the post value for M
    await advanceRound();

    for (const party of parties) {
      const before = await rewards.unclaimedRewards(party.addr);
      await satori.settlePrediction(party.addr, streamId); // scores exactly M (sole pending)
      const after = await rewards.unclaimedRewards(party.addr);
      party.reward = after - before;
      party.weight = party.power * party.mult;            // rawPower_i × M_i (oracle)
    }

    // Every winner must have been paid something.
    for (const party of parties) {
      expect(party.reward, `winner ${party.addr} must be paid for round ${measRound}`).to.be.gt(0n);
    }

    const totalWeight = parties.reduce((s, p) => s + p.weight, 0n);
    const streamPool = parties.reduce((s, p) => s + p.reward, 0n); // empirical pool = Σ rewards

    // --- Step 4a: EXACT absolute per-party split. ---
    for (const party of parties) {
      const expected = (streamPool * party.weight) / totalWeight;
      expect(party.reward).to.be.closeTo(expected, RAW_TOLERANCE,
        `reward_i must equal streamPool × (rawPower_i × M_i) / Σ(rawPower_j × M_j) for ${party.addr}`);
    }

    // --- Step 4b: Σ rewards ≈ the round's payable pool. With fee==0 the whole
    // ROUND_REWARD_BUDGET is payable (no provider cut, no first-predictor
    // reservation); this game shares the round only with the default game, whose
    // derived weight takes its slice. So Σ rewards is positive and at most the
    // gross budget. The EXACT per-party split above is the load-bearing
    // assertion; this bounds the absolute scale. ---
    const grossBudget = (await satori.ROUND_REWARD_BUDGET());
    expect(streamPool).to.be.gt(0n);
    expect(streamPool).to.be.lte(grossBudget);

    // --- Step 4c: multiplier is load-bearing (baked-in mutation check). The
    // M==1 oracle (weight_i = rawPower_i) MUST MISpredict the split: at least one
    // party's M==1-predicted reward diverges from its actual reward by FAR more
    // than RAW_TOLERANCE. ---
    const totalPowerOnly = parties.reduce((s, p) => s + p.power, 0n);
    let maxNoMultErr = 0n;
    for (const party of parties) {
      const noMultExpected = (streamPool * party.power) / totalPowerOnly; // M==1
      const err = party.reward > noMultExpected ? party.reward - noMultExpected : noMultExpected - party.reward;
      if (err > maxNoMultErr) maxNoMultErr = err;
    }
    expect(maxNoMultErr).to.be.gt(RAW_TOLERANCE * 1000n,
      "an M==1 oracle must badly mispredict the split — proving the streak multiplier redistributes the absolute reward");

    console.log(`\n=== StreakMultiSplit ABSOLUTE round ${measRound} (streamPool=${ethers.formatEther(streamPool)}) ===`);
    for (const party of parties) {
      const expected = (streamPool * party.weight) / totalWeight;
      console.log(`  ${party.addr.slice(0, 10)} power=${ethers.formatEther(party.power)} M=${party.mult} ` +
        `reward=${ethers.formatEther(party.reward)} expected=${ethers.formatEther(expected)}`);
    }
    console.log(`  max M==1 mispredict = ${ethers.formatEther(maxNoMultErr)} (>> tol)`);
  });
});
