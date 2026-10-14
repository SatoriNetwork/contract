// Adversarial END-TO-END reward-pool conservation guard for the rawPower
// consistency fix.
//
// SUBSYSTEM: predictions / rewards distribution.
//
// THE FIX UNDER TEST (Satori.sol, committed-pending):
//   The predict-time reward DENOMINATOR (totalWeightPacked) and the score-time
//   NUMERATOR are now both derived from the SAME "effective" rawPower — the
//   value after the packed-slot round-trip (predict uses _effectiveRaw,
//   score uses _predRaw(slot); equal by construction). PR_RAW_SHIFT was also
//   raised 30 -> 40, lifting the saturation cap from ~151k SATORI to ~155M
//   SATORI (effectively unreachable).
//
//   BEFORE the fix: predict used the FULL perStreamPower while score used a
//   truncated/saturated slot value, so for a whale ABOVE the old ~151k cap the
//   winners' numerators summed to LESS than the denominator. _computeReward =
//   streamPool * userWeight / totalWeight then paid out Σ rewards << streamPool,
//   stranding a LARGE residual of the round's stream pool forever.
//
// THE INVARIANT THIS TEST PROVES (end to end, through real settle + credit):
//   For ONE eligible stream/round with several correct UP predictors of MIXED
//   stake (>=1 whale farmed ABOVE the old cap + small co-predictors), the SUM
//   of the winners' CREDITED SATORI rewards (unclaimedRewards deltas at settle
//   time — the eager-credit shadow) equals the round's stream reward pool
//   within integer-division floor dust (RAW_TOLERANCE scale). No meaningful
//   positive residual is stranded.
//
// HOW THE POOL IS MEASURED WITHOUT READING INTERNAL STATE:
//   streamPool and _roundBudget are `internal` (the value-provider cut and its
//   _predictorShareBps are gone entirely, so the pool is now simply the game's
//   whole share of the round budget). The contract pays each winner r_i = floor(streamPool *
//   w_i / totalWeight) where w_i = lens.userWeightByDirection(...) and
//   totalWeight = lens.totalWeightByDirection(...). Inverting the whale's
//   payout pins the pool to a TIGHT interval:
//       poolLow  = r_whale * totalWeight / w_whale
//       poolHigh = (r_whale + 1) * totalWeight / w_whale   (exclusive)
//   The true streamPool lies in [poolLow, poolHigh); the interval width is
//   totalWeight / w_whale, which is tiny for a whale. We then assert:
//     (1) every winner got a strictly POSITIVE reward;
//     (2) each winner's reward is PROPORTIONAL to its effective weight
//         (r_i ≈ streamPool * w_i / totalWeight within floor dust);
//     (3) the residual streamPool - Σ rewards is <= RAW_TOLERANCE with NO
//         meaningful positive stranding.
//   Under the OLD bug the whale's score-time numerator was clamped to the cap
//   while the predict-time denominator used full power, so Σ w_i << totalWeight
//   and Σ rewards << streamPool by a CATASTROPHIC (cap/power)-sized factor —
//   this guard would fail loudly. With the fix, Σ w_i == totalWeight and the
//   pool fully distributes.
//
// CONTROL: a small-stake-only round (no whale) distributes its pool the same
// way (tight conservation), proving the assertion isn't whale-specific.

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture, RAW_TOLERANCE, pack1, voteFor } = require("../fixtures");

const UP = 1;
// A round is 24h; every stream here runs at an explicit 2880-minute cadence
// (two rounds). One value per period, and scoring is the AB window (anchor =
// value AT the predict round, post = the first value after it) — the same
// shape these tests always had.
const ROUND = 86400;
const CADENCE_ROUNDS = 2;
// Advance to the round boundary CADENCE_ROUNDS ahead, +5s (not a raw multiple
// of 86400) — see the note in predictions-rawpower-consistency.cov.test.js: the
// farm loop's +1s-per-tx timestamp drift can push a predict across a round
// boundary from its setValue (spurious PredictExpired) when the chain happens
// to start near a round boundary. Boundary-pinning makes the file
// phase-deterministic.
async function advanceOneDay() {
  const t = await time.latest();
  await time.increaseTo(t - (t % ROUND) + ROUND * CADENCE_ROUNDS + 5);
}

// The OLD SHIFT=30 saturation cap, ~151,115.7 SATORI in wei. With the current
// PR_RAW_SHIFT=40 the real cap is ~155M SATORI (unreachable). We farm the whale
// PAST this old threshold purely to exercise the large-stake path that the old
// bug mispaid.
const OLD_CAP = (((1n << 47n) - 1n) << 30n);

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

// Farm `user` toward a target prediction power by repeatedly predicting UP on a
// rising stream and letting unclaimed rewards compound back into power. Returns
// the final getPredictionPower.
async function farmTo(satori, registry, rewards, authority, user, stream, target, maxRounds) {
  let v = 100;
  await registry.connect(authority).setValue(stream, v);
  for (let r = 0; r < maxRounds; r++) {
    await satori.connect(user).predictMultipleWithPayloads([{ gameId: stream, payload: pack1(UP) }]);
    // AB window: the first post-anchor value settles the prediction; the second
    // post is the NEXT cycle's anchor, a full cadence period later.
    await advanceOneDay();
    v += 10; await registry.connect(authority).setValue(stream, v);
    await satori.settlePrediction(user.address, stream);
    await advanceOneDay();
    v += 10; await registry.connect(authority).setValue(stream, v);
    if ((await rewards.getPredictionPower(user.address)) >= target) break;
  }
  return rewards.getPredictionPower(user.address);
}

// Settle a winner and return the SATORI delta credited to their
// unclaimedRewards bucket (the eager-credit shadow == the streamPool share for
// this (game, round, direction), since no delegation => _splitReward returns
// the full reward). Also asserts the PredictionScored event marked it correct.
async function settleAndCredit(satori, rewards, user, gameId) {
  const before = await rewards.unclaimedRewards(user);
  const tx = await satori.settlePrediction(user, gameId);
  const rcpt = await tx.wait();
  let correct = null;
  for (const log of rcpt.logs) {
    try {
      const p = satori.interface.parseLog(log);
      if (p && p.name === "PredictionScored" && p.args.user === user) {
        correct = p.args.correct;
      }
    } catch (e) {}
  }
  const after = await rewards.unclaimedRewards(user);
  return { credited: after - before, correct };
}

describe("ADV predictions: reward-pool conservation under rawPower consistency", function () {
  this.timeout(180000);

  let satori, rewards, lens, registry, owner, alice, bob, carol, dave, authority;
  let farmStream;

  beforeEach(async function () {
    const fix = await loadFixture(deploySatoriFixture);
    ({ satori, rewards, lens, registry, owner } = fix);
    [, alice, bob, carol, dave, authority] = fix.signers;
    // (The fixture already calls initializeDefaultStream(), exactly as
    // production does, so game id 1 is the default game and the first stream
    // this file creates is id 2.)
    await satori.transfer(alice.address, ethers.parseEther("100"));
    await satori.transfer(bob.address,   ethers.parseEther("100"));
    await satori.transfer(carol.address, ethers.parseEther("100"));
    await satori.transfer(dave.address,  ethers.parseEther("100"));
    await satori.transfer(authority.address, ethers.parseEther("100"));
    farmStream = await createStream(satori, authority, "farm");
    await voteFor(satori, owner, farmStream);
    // Phase-align BEFORE any setValue so every subsequent aligned advance is a
    // full cadence period (the first advance from an arbitrary start offset can be
    // shorter than the 30-min cadence-gap slack).
    await advanceOneDay();
  });

  it("MIXED stakes (whale above old cap + smalls): pool fully distributes, no stranded residual", async function () {
    // 1) Farm alice into a WHALE above the old ~151k SATORI cap. The probe in
    //    this directory measured the crossover near round ~277; 400 is a safe
    //    ceiling.
    const power = await farmTo(
      satori, registry, rewards, authority, alice, farmStream,
      OLD_CAP + ethers.parseEther("1"), 400
    );
    expect(power).to.be.gt(OLD_CAP, "alice did not reach above the old cap; cannot exercise the bug path");

    // 2) Fresh eligible stream for the scored round. Predictors: whale (alice)
    //    + three small co-predictors (bob, carol, dave) — a MIX of stakes, all
    //    UP, all will resolve correct.
    const s = await createStream(satori, authority, "scored-mixed");
    await voteFor(satori, owner, s);
    await registry.connect(authority).setValue(s, 100);

    // Predict order is irrelevant now — the first-predictor bonus is gone, so
    // nothing outside the scored streamPool lands in the unclaimedRewards
    // deltas measured below.
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: s, payload: pack1(UP) }]);
    await satori.connect(bob).predictMultipleWithPayloads([{ gameId: s, payload: pack1(UP) }]);
    await satori.connect(carol).predictMultipleWithPayloads([{ gameId: s, payload: pack1(UP) }]);
    await satori.connect(dave).predictMultipleWithPayloads([{ gameId: s, payload: pack1(UP) }]);

    const round = await satori.getCurrentRound();

    // Predict-time denominator and per-user numerators for (s, round, UP).
    const denom = await lens.totalWeightByDirection(s, round, UP);
    const wAlice = await lens.userWeightByDirection(alice.address, s, round, UP);
    const wBob   = await lens.userWeightByDirection(bob.address,   s, round, UP);
    const wCarol = await lens.userWeightByDirection(carol.address, s, round, UP);
    const wDave  = await lens.userWeightByDirection(dave.address,  s, round, UP);
    const sumW = wAlice + wBob + wCarol + wDave;

    // The whale's numerator must dominate (it is the whole point of the test)
    // and must NOT be clamped to the old cap weight. denom == Σ numerators is
    // the core consistency invariant the fix restores.
    expect(wAlice).to.be.gt(wBob + wCarol + wDave, "alice is not the dominant stake");
    expect(denom - sumW).to.be.lte(
      0n < (denom / 1_000_000_000_000_000_000n) ? denom / 1_000_000_000_000_000_000n : 1n,
      "predict-time denominator diverges from Σ score-time numerators (consistency broken)"
    );
    // Strictly: under the fix they are exactly equal (single source of truth).
    expect(sumW).to.equal(denom, "denominator != Σ numerators — saturation/truncation drift present");

    // 3) Resolve UP correct (post > anchor across the cadence window).
    // AB window (two-round cadence): one post-anchor value resolves it, 110 > 100.
    await advanceOneDay();
    await registry.connect(authority).setValue(s, 110);

    // 4) Settle every winner; capture the credited streamPool share each.
    const a = await settleAndCredit(satori, rewards, alice.address, s);
    const b = await settleAndCredit(satori, rewards, bob.address,   s);
    const c = await settleAndCredit(satori, rewards, carol.address, s);
    const d = await settleAndCredit(satori, rewards, dave.address,  s);
    expect(a.correct).to.equal(true);
    expect(b.correct).to.equal(true);
    expect(c.correct).to.equal(true);
    expect(d.correct).to.equal(true);

    // (1) every winner paid a strictly POSITIVE reward.
    expect(a.credited).to.be.gt(0n, "whale received zero reward");
    expect(b.credited).to.be.gt(0n, "small predictor bob received zero reward");
    expect(c.credited).to.be.gt(0n, "small predictor carol received zero reward");
    expect(d.credited).to.be.gt(0n, "small predictor dave received zero reward");

    const sumRewards = a.credited + b.credited + c.credited + d.credited;

    // Reconstruct the round's stream pool TIGHTLY from the whale's payout:
    //   r_whale = floor(streamPool * wAlice / denom)
    //   => streamPool ∈ [ r_whale*denom/wAlice , (r_whale+1)*denom/wAlice )
    const poolLow  = (a.credited * denom) / wAlice;
    const poolHigh = ((a.credited + 1n) * denom) / wAlice;
    const poolWidth = poolHigh - poolLow;

    // (2) proportionality: each winner's reward matches streamPool * w_i/denom
    // within floor dust. Use poolLow as the lower estimate of the pool.
    for (const [name, w, r] of [
      ["alice", wAlice, a.credited],
      ["bob",   wBob,   b.credited],
      ["carol", wCarol, c.credited],
      ["dave",  wDave,  d.credited],
    ]) {
      const expectedFromPool = (poolLow * w) / denom;
      // r is floor(streamPool * w/denom); poolLow <= streamPool, so r >=
      // floor(poolLow * w/denom) up to the at-most-1-quantum interval. Allow a
      // small absolute slack for the interval + floors.
      const slack = (poolWidth * w) / denom + 2n;
      expect(r + slack).to.be.gte(expectedFromPool,
        `${name}: reward not proportional to effective weight (under)`);
      expect(r).to.be.lte(expectedFromPool + slack,
        `${name}: reward not proportional to effective weight (over)`);
    }

    // (3) POOL CONSERVATION — the headline. Σ rewards must equal the stream pool
    // within floor dust, with NO meaningful positive residual stranded.
    //   - Σ rewards <= streamPool always (each term floors).
    //   - residual = streamPool - Σ rewards. Bound it by [poolLow, poolHigh).
    //     Lower bound on residual uses poolLow; upper bound uses poolHigh.
    const residualVsLow  = poolLow  - sumRewards; // could be slightly negative
    const residualVsHigh = poolHigh - sumRewards;

    // The residual against the BEST (smallest) admissible pool must be tiny.
    // (Against poolHigh it can be up to one interval larger; both must be dust.)
    const absResidualLow = residualVsLow < 0n ? -residualVsLow : residualVsLow;

    // NO catastrophic stranding: under the old bug the residual would be on the
    // order of streamPool * (power - cap)/power — i.e. a large fraction of the
    // whole pool, vastly exceeding RAW_TOLERANCE.
    expect(residualVsHigh).to.be.lte(RAW_TOLERANCE,
      `stranded residual ${residualVsHigh} exceeds dust tolerance ${RAW_TOLERANCE} ` +
      `(pool≈[${poolLow},${poolHigh}), Σrewards=${sumRewards})`);
    expect(absResidualLow).to.be.lte(RAW_TOLERANCE,
      `|pool - Σrewards| ${absResidualLow} exceeds dust tolerance ${RAW_TOLERANCE}`);

    // And the pool was meaningfully large (sanity: this round actually paid out
    // a non-trivial slice of the 1440/round budget so "no stranding" is real).
    expect(poolLow).to.be.gt(ethers.parseEther("1"),
      "reconstructed pool implausibly small — assertion would be vacuous");
  });

  it("CONTROL small-stake-only round: pool fully distributes the same way", async function () {
    // No whale. Three fresh small predictors, all UP, all correct.
    const s = await createStream(satori, authority, "scored-smalls");
    await voteFor(satori, owner, s);
    await registry.connect(authority).setValue(s, 100);

    await satori.connect(bob).predictMultipleWithPayloads([{ gameId: s, payload: pack1(UP) }]);
    await satori.connect(carol).predictMultipleWithPayloads([{ gameId: s, payload: pack1(UP) }]);
    await satori.connect(dave).predictMultipleWithPayloads([{ gameId: s, payload: pack1(UP) }]);

    const round = await satori.getCurrentRound();
    const denom = await lens.totalWeightByDirection(s, round, UP);
    const wBob   = await lens.userWeightByDirection(bob.address,   s, round, UP);
    const wCarol = await lens.userWeightByDirection(carol.address, s, round, UP);
    const wDave  = await lens.userWeightByDirection(dave.address,  s, round, UP);
    const sumW = wBob + wCarol + wDave;
    expect(sumW).to.equal(denom, "control: denominator != Σ numerators");

    // AB window (two-round cadence): one post-anchor value resolves it, 110 > 100.
    await advanceOneDay();
    await registry.connect(authority).setValue(s, 110);

    const b = await settleAndCredit(satori, rewards, bob.address,   s);
    const c = await settleAndCredit(satori, rewards, carol.address, s);
    const d = await settleAndCredit(satori, rewards, dave.address,  s);
    expect(b.correct && c.correct && d.correct).to.equal(true);
    expect(b.credited).to.be.gt(0n);
    expect(c.credited).to.be.gt(0n);
    expect(d.credited).to.be.gt(0n);

    const sumRewards = b.credited + c.credited + d.credited;

    // Reconstruct pool from the largest of the three (here weights are roughly
    // equal; pick bob). Interval width denom/wBob is small.
    const poolLow  = (b.credited * denom) / wBob;
    const poolHigh = ((b.credited + 1n) * denom) / wBob;

    const residualVsHigh = poolHigh - sumRewards;
    const residualVsLow  = poolLow  - sumRewards;
    const absResidualLow = residualVsLow < 0n ? -residualVsLow : residualVsLow;

    expect(residualVsHigh).to.be.lte(RAW_TOLERANCE,
      `control stranded residual ${residualVsHigh} exceeds dust ${RAW_TOLERANCE}`);
    expect(absResidualLow).to.be.lte(RAW_TOLERANCE,
      `control |pool - Σrewards| ${absResidualLow} exceeds dust ${RAW_TOLERANCE}`);
  });
});
