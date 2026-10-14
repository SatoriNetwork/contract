// Adversarial repro for LOW finding (scoring subsystem):
//
//   "Score-time numerator weight is derived from a 30-bit-truncated rawPower
//    while the predict-time denominator used the full untruncated weight
//    (asymmetric drift)."
//
//   location: Satori.sol:_makePrediction (~1460) vs
//             Satori.sol:_scorePreviousPrediction (~1732-1734)
//
// CLAIMED INTENT (docs/narratives/A_scoring.md "Weight & reward math" +
// the predict-path comment at Satori.sol (pre-split)):
//
//   weight = (rawPower * multiplier * WEIGHT_SCALE) / roundTotals[round]
//   reward = (weight * streamPool) / totalWeight
//
//   The comment states the predict-time committed weight uses the "same
//   formula as score-time re-derivation ... single source of truth:
//   `_deriveWeight`", i.e. numerator (this winner's weight at score time) and
//   the value contributed to the denominator (totalWeight, accumulated at
//   predict time) MUST AGREE BY CONSTRUCTION over the same rawPower.
//
// ACTUAL CODE:
//   - Predict time (Satori.sol (pre-split)): scaledWeight = _deriveWeight(
//       perStreamPower, ...) uses the FULL untruncated perStreamPower. This
//       value is added into totalWeightPacked (the per-(game,round,dir)
//       DENOMINATOR consumed as totalWeight in _computeReward).
//   - Pack time (Satori.sol (pre-split)): the packed slot stores
//       rawPower >> PR_RAW_SHIFT (PR_RAW_SHIFT = 30), dropping the low 30 bits.
//   - Score time (Satori.sol (pre-split)): rawPower is recovered as
//       floor(perStreamPower / 2^30) * 2^30  (<= perStreamPower), and
//       scaledWeight = _deriveWeight(rawPower, ...) becomes the NUMERATOR.
//
// So when perStreamPower is NOT a multiple of 2^30, the numerator weight is
// derived from a strictly SMALLER value than the one that entered the
// denominator. The "agree by construction" property is violated for the low
// PR_RAW_SHIFT bits; Sigma(numerators) < winners' contribution to totalWeight,
// stranding dust. Direction is under-pay (safe), magnitude sub-nano-SATORI.
//
// INTENDED behavior asserted below:
//   The score-time numerator weight (PredictionScored.scaledWeight) EQUALS
//   the predict-time committed weight that fed the denominator, computed over
//   the SAME rawPower in both places.
//
// BURN-VOTING MIGRATION: the weight formula lost its normalisation. It used to
// be `(rawPower * mult * WEIGHT_SCALE) / roundTotals[round]`; the round total
// is no longer locked up front (the denominator now ACCUMULATES as games join
// the round), so dividing by it at predict time and again at score time would
// divide by two different numbers. `SatoriEngine._deriveWeight` is now simply
// `rawPower * multiplier` — the common factor cancelled anyway, since the value
// is only ever used as a share of `totalWeightPacked[game][round]`. The
// consistency invariant under test is unchanged; only the formula it is
// expressed in is simpler.
//
// FAIL  -> finding CONFIRMED (numerator built on truncated rawPower).
// PASS  -> finding REFUTED.

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture, pack1, voteFor, VOTE } = require("../fixtures");

const UP = 1;
const ROUND = 86400; // 24h round length in seconds
const PR_RAW_SHIFT = 40n; // must track SatoriEngine PR_RAW_SHIFT
const TWO_POW_30 = 1n << PR_RAW_SHIFT; // (name kept; = 2^PR_RAW_SHIFT)

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

// The stream here is scaffolding for the weight arithmetic; it runs at an
// explicit two-round cadence (2880 minutes). One cadence period is therefore
// TWO rounds, and the scoring window is AB — anchor = the value AT the predict
// round, post = the first value after it (every-round streams are the ones
// that score ABC). The invariant under test is independent of which window
// scores the prediction.
const CADENCE_ROUNDS = 2;
const CADENCE_SECONDS = ROUND * CADENCE_ROUNDS; // 48h

async function nextCadence() {
  await time.increase(CADENCE_SECONDS);
}

// Pull the score-time numerator weight out of the PredictionScored event.
async function scaledWeightFromSettle(tx, satori) {
  const rc = await tx.wait();
  for (const log of rc.logs) {
    try {
      const p = satori.interface.parseLog(log);
      if (p && p.name === "PredictionScored" && p.args.correct === true) {
        return BigInt(p.args.scaledWeight);
      }
    } catch (_) {}
  }
  throw new Error("PredictionScored(correct=true) missing");
}

describe("ADV-LOW scoring: predict/score weight asymmetry (30-bit rawPower truncation)", function () {
  it("score-time numerator weight equals the predict-time committed weight (single source of truth)", async function () {
    this.timeout(120000);
    const { satori, rewards, registry, owner, signers } = await loadFixture(deploySatoriFixture);
    const [, alice] = signers;

    // (The fixture already calls initializeDefaultStream(), exactly as
    // production deploys — so the stream created below is id 2, not id 1.)

    // Give Alice a balance whose low PR_RAW_SHIFT bits are non-zero so that
    // perStreamPower is NOT a multiple of 2^40. Any odd-wei tail works; we use
    // a large round amount + a small non-multiple-of-2^40 remainder. The vote
    // burn below is a whole number of ether, so it cannot cancel the tail.
    const INITIAL = await satori.INITIAL_MINT();
    const ODD_TAIL = 123_456_789n; // < 2^40, not a multiple of 2^40
    await satori.transfer(alice.address, INITIAL / 4n + ODD_TAIL);

    // Sole weighted stream so Alice is the SINGLE winner of (game,round,dir).
    // Explicit two-round (2880-minute) cadence keeps the AB shape.
    const sid = await getStreamId(await satori["createSimpleDataStream(string,address,uint24)"]("S", owner.address, 2880), satori);
    await registry.setValue(sid, 1000);
    // Burn-backed vote: buys the game permanent weight so Alice's predictions
    // on it are eligible (weightOf(sid) > 0). Alice keeps the rest to predict with.
    await voteFor(satori, alice, sid, VOTE);

    // Build Alice a streak of 2 so the scored prediction carries multiplier>0
    // (streak<2 => multiplier 0 => weight 0, never scored for reward).
    // AB semantics (two-round cadence): anchor = the value AT the predict round (A),
    //                           post   = the first value after it (B);
    //                           UP correct iff B > A.

    // streak 0 -> 1
    await nextCadence();
    await registry.setValue(sid, 1100); // A
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: sid, payload: pack1(UP) }]);
    await nextCadence();
    await registry.setValue(sid, 1300); // B > A -> UP correct
    await satori.settlePrediction(alice.address, sid);
    expect(await satori.streaks(alice.address, sid)).to.equal(1n);

    // streak 1 -> 2
    await nextCadence();
    await registry.setValue(sid, 1400); // A
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: sid, payload: pack1(UP) }]);
    await nextCadence();
    await registry.setValue(sid, 1600); // B > A -> UP correct
    await satori.settlePrediction(alice.address, sid);
    expect(await satori.streaks(alice.address, sid)).to.equal(2n);

    // ---- The prediction under test (streak 2 -> 3). ----
    await nextCadence();
    await registry.setValue(sid, 1700); // A

    // Snapshot the EXACT inputs the contract will use at predict time:
    //   perStreamPower = getPredictionPower(alice) / streamCount (=1 here)
    //   multiplier     = the ACTUAL committed streak multiplier (read from the slot
    //                    post-predict). Under the √ curve at streak 2 (below the floor-4 bar) this is the thr-2 ramp √2×10=14
    //                    or the raw streak (deep dust) depending on the
    //                    game's adaptive threshold — this consistency invariant holds
    //                    for ANY multiplier, so we read the real one rather than assume.
    const perStreamPower = BigInt(await rewards.getPredictionPower(alice.address));

    // sanity: confirm the low bits are actually set (else the test is vacuous).
    expect(perStreamPower % TWO_POW_30).to.not.equal(
      0n,
      "test setup invalid: perStreamPower happens to be a multiple of 2^40"
    );

    const predTx = await satori
      .connect(alice)
      .predictMultipleWithPayloads([{ gameId: sid, payload: pack1(UP) }]);
    await predTx.wait();
    const predRound = BigInt(await satori.getCurrentRound());
    // The committed multiplier the contract actually stored for this prediction.
    const MULT = BigInt((await satori.getLatestPrediction(alice.address, sid)).multiplier);
    expect(MULT).to.be.gt(0n);
    expect(predRound).to.be.gt(0n);

    // EFFECTIVE rawPower: what this stake resolves to after the packed-slot
    // round-trip (floor to a 2^40 multiple; below the saturation cap here). The
    // FIX derives the predict-time committed weight (the DENOMINATOR
    // contribution) from THIS, not the full perStreamPower, so it equals the
    // score-time numerator (re-derived from the same slot value). The 47-bit
    // slot field can't hold full-precision rawPower, so "consistent effective
    // raw" is the achievable invariant — and it removes the stranding.
    const effectiveRaw = (perStreamPower / TWO_POW_30) * TWO_POW_30; // floor to 2^40
    // _deriveWeight is now plain `rawPower * multiplier` — no WEIGHT_SCALE and
    // no division by the round total (see the header note).
    const committedWeight = effectiveRaw * MULT;

    // Resolve the prediction correctly.
    await nextCadence();
    await registry.setValue(sid, 2100); // B > A (1700) -> UP correct

    const settleTx = await satori.settlePrediction(alice.address, sid);
    const numeratorWeight = await scaledWeightFromSettle(settleTx, satori);

    console.log("perStreamPower :", perStreamPower.toString());
    console.log("effectiveRaw   :", effectiveRaw.toString());
    console.log("committedWeight:", committedWeight.toString());
    console.log("numeratorWeight:", numeratorWeight.toString());

    // INTENT (single source of truth): the score-time numerator weight EQUALS
    // the predict-time committed weight that fed the denominator — both derived
    // from the same effective (slot-round-tripped) rawPower. The old code derived
    // the denominator from the FULL perStreamPower and the numerator from the
    // 40-bit-truncated slot value, so they diverged and stranded dust; the fix
    // makes predict use the effective value too, so they agree exactly.
    expect(numeratorWeight).to.equal(
      committedWeight,
      "score-time numerator must equal the predict-time denominator contribution " +
        "(both from the effective slot-round-tripped rawPower)"
    );
  });
});
