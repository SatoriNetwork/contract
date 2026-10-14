// ADVERSARIAL COVERAGE — Predict/settle/claim lifecycle.
//
// GAP (IMPORTANT): a SINGLE predictMultipleWithPayloads batch that mixes a
// cadence-1 (ABC) stream and a cadence>=2 (AB) stream, then settling both.
//
// The validation loop captures `cadences[i]` PER-ENTRY (Satori.sol ~1467) and
// `_makePrediction` stores a per-prediction `isABC` flag via `_withABC`
// (~1582/1605). `_scorePreviousPrediction` branches ABC-vs-AB off that stored
// PER-SLOT flag (~1861/1872):
//   - ABC (cadence==1): anchor = B (first value after predRound),
//                       post   = C (second value after predRound).
//   - AB  (cadence>=2): anchor = A (value AT predRound),
//                       post   = B (first value after predRound).
//
// Every existing test exercises AB and ABC each in ISOLATION (one game per
// predict call): StreamCadence.test.js + scoring.cov2 [A]/[B] cover AB/ABC
// scoring/void/evict/miss but never together in one batch; PerStreamPower /
// BatchPrediction cover multi-stream batches but ONLY default cadence-1 streams.
// No test ever puts two DIFFERENT-cadence games in one batch — the exact place
// the per-slot flag could diverge. A regression that wrote one cadence for the
// whole batch (hoisting the cadence read out of the loop, or `_withABC`
// clobbering across slots) would silently mis-score one leg with NO revert:
// an ABC scored as AB compares the wrong anchor (value-at-predRound instead of
// first-after), flipping correct/void/incorrect and mis-paying.
//
// STRATEGY: the value sets are chosen so that if a leg is mis-branched the
// OUTCOME FLIPS (no weak/coincidental pass):
//   - ABC leg: correct under ABC (B<C, predict UP) but INCORRECT under the
//     wrong AB lens (value@R > first-after). Mis-branch -> correct=false,
//     streak stays 0.
//   - AB leg: correct under AB (A<B, predict UP) but UNRESOLVABLE under the
//     wrong ABC lens (only ONE value exists after predRound, so
//     getFirstTwoValuesAfter can't find a second). Mis-branch -> the leg
//     stays PENDING (scored=false) instead of scoring correct=true.
//
// Contract is IMMUTABLE — these assert current code unchanged.

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture, pack1, VOTE } = require("../fixtures");

const UP = 1;
const DOWN = 2;
const ROUND = 86400; // 24h round length in seconds

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

// Find the PredictionScored event for a specific gameId in a receipt.
// NOTE: the event field is named `gameId` and carries the gameId argument
// passed to the scorer; in the 1:1 fixture stream and game ids coincide.
function findScored(rc, satori, gameId) {
  for (const log of rc.logs) {
    try {
      const p = satori.interface.parseLog(log);
      if (p && p.name === "PredictionScored" && Number(p.args.gameId) === Number(gameId)) {
        return p.args;
      }
    } catch (_) {}
  }
  return null;
}
function eventNames(rc, satori) {
  return rc.logs
    .map((l) => { try { return satori.interface.parseLog(l).name; } catch { return null; } })
    .filter(Boolean);
}

describe("ADV-COV mixed-cadence batch (ABC + AB in ONE predict, per-slot cadence)", function () {
  this.timeout(120000);

  // Shared setup: one cadence-1 ABC stream (sA) and one cadence-7 AB stream
  // (sB), both eligible, both seeded with a value at the SAME predict round.
  async function setup() {
    const fix = await loadFixture(deploySatoriFixture);
    const { satori, registry, owner, signers } = fix;
    const [, alice, bob] = signers;
    const INITIAL = await satori.INITIAL_MINT();
    await satori.transfer(alice.address, INITIAL / 4n);
    await satori.transfer(bob.address, INITIAL / 4n);

    // sA: cadence-1 (ABC). sB: cadence-7 (AB). A cadence-1 stream is ADMIN-ONLY
    // now (a public caller gets `StreamCadenceTooShort` below cadence 2), and it
    // is exactly what this file needs: only a cadence-1 stream takes the ABC
    // lens, so the mixed-lens batch cannot be built without one. `satori` is
    // connected to the deployer, which is rewards.admin() in this fixture, so
    // the explicit 3-arg overload is allowed here.
    const sA = await getStreamId(
      await satori["createSimpleDataStream(string,address,uint24)"]("ABC-cad1", owner.address, 720),
      satori
    );
    const sB = await getStreamId(
      await satori["createSimpleDataStream(string,address,uint24)"]("AB-cad7", owner.address, 5040),
      satori
    );
    // Burn weight for both games so both legs are eligible (power splits across
    // eligible games only, so both legs must carry weight). A distinct voter
    // each keeps the two burns independent.
    await satori.connect(alice).vote(sA, VOTE);
    await satori.connect(bob).vote(sB, VOTE);
    return { ...fix, alice, bob, sA, sB };
  }

  it("[1] one batch mixes ABC+AB; each leg scores via its OWN lens (outcome would FLIP if mis-branched)", async function () {
    const { satori, registry, alice, sA, sB } = await setup();

    // --- Seed BOTH streams with a value in the SAME (predict) round R. ---
    // sB (cadence-7) value at R is the AB anchor A = 1000.
    // sA (cadence-1) value at R is just the predict-enabler; the ABC anchor is
    // the FIRST value AFTER R, so this 5000 must NOT be the anchor.
    await time.increase(ROUND); // step to a clean round before seeding
    await registry.setValue(sA, 5000); // sA value @ R (NOT the ABC anchor)
    await registry.setValue(sB, 1000); // sB value @ R == AB anchor A

    const predRound = Number(await satori.getCurrentRound());

    // --- ONE batch predicting UP on BOTH games. ---
    await satori.connect(alice).predictMultipleWithPayloads([
      { gameId: sA, payload: pack1(UP) },
      { gameId: sB, payload: pack1(UP) },
    ]);

    // Both pending, unscored.
    expect((await satori.predictions(alice.address, sA, predRound)).scored).to.equal(false);
    expect((await satori.predictions(alice.address, sB, predRound)).scored).to.equal(false);
    expect(await satori.streaks(alice.address, sA)).to.equal(0n);
    expect(await satori.streaks(alice.address, sB)).to.equal(0n);

    // --- ABC leg (sA) post-ticks: B then C, with B < C so UP is CORRECT. ---
    // ABC lens: anchor=B(1000), post=C(2000) -> 2000 > 1000 -> UP correct.
    // WRONG AB lens would use anchor = value@R = 5000, post = first-after =
    // 1000 -> 1000 < 5000 -> UP INCORRECT. So a mis-branch flips the outcome.
    await time.increase(ROUND);
    await registry.setValue(sA, 1000); // ABC B (first after R)
    await time.increase(ROUND);
    await registry.setValue(sA, 2000); // ABC C (second after R), C > B -> UP

    // --- AB leg (sB) post-tick: a SINGLE B at R+7, with B > A so UP correct. ---
    // AB lens: anchor=A(1000), post=B(2000) -> UP correct.
    // WRONG ABC lens needs TWO values after R; only ONE exists -> unresolvable
    // (the leg would stay PENDING instead of scoring). cadence-7 means we must
    // wait 7 rounds before sB can take its next value.
    // We already advanced 2 rounds above; advance 5 more to reach >= R+7.
    await time.increase(5 * ROUND);
    await registry.setValue(sB, 2000); // AB B (first/only value after R)

    // --- Settle ABC leg (sA): expect a CORRECT score, streak -> 1. ---
    const txA = await satori.settlePrediction(alice.address, sA);
    const rcA = await txA.wait();
    const scoredA = findScored(rcA, satori, sA);
    expect(scoredA, "ABC leg must emit PredictionScored").to.not.equal(null);
    expect(scoredA.correct).to.equal(
      true,
      "ABC leg scored UP-correct via B<C lens (would be INCORRECT if mis-branched as AB)"
    );
    expect(Number(scoredA.streak)).to.equal(1, "ABC win ticks streak 0 -> 1");
    expect((await satori.predictions(alice.address, sA, predRound)).scored).to.equal(true);
    expect(await satori.streaks(alice.address, sA)).to.equal(1n);

    // --- Settle AB leg (sB): expect a CORRECT score, streak -> 1. ---
    // If this leg had been mis-branched as ABC it would still be PENDING here
    // (only one post-tick exists), so settlePrediction would be a no-op and
    // scored would remain false. We assert it actually SCORES.
    const txB = await satori.settlePrediction(alice.address, sB);
    const rcB = await txB.wait();
    const scoredB = findScored(rcB, satori, sB);
    expect(scoredB, "AB leg must emit PredictionScored (NOT stay pending)").to.not.equal(null);
    expect(scoredB.correct).to.equal(
      true,
      "AB leg scored UP-correct via A<B lens (would be PENDING if mis-branched as ABC)"
    );
    expect(Number(scoredB.streak)).to.equal(1, "AB win ticks streak 0 -> 1");
    expect((await satori.predictions(alice.address, sB, predRound)).scored).to.equal(true);
    expect(await satori.streaks(alice.address, sB)).to.equal(1n);

    // Each leg's committed scaledWeight reflects ITS OWN per-leg lens (both
    // eligible, both first-prediction so multiplier=1, but the denominator is
    // each leg's own predRound totals). Both nonzero (eligible + scored).
    expect(scoredA.scaledWeight).to.be.gt(0n, "ABC leg committed nonzero weight");
    expect(scoredB.scaledWeight).to.be.gt(0n, "AB leg committed nonzero weight");
  });

  it("[2] AB leg does NOT void with only one post-tick; ABC leg stays pending until two ticks (per-slot lens)", async function () {
    // The void/pending variant from the sketch: with exactly ONE value posted
    // after the predict round on BOTH streams, the AB leg is RESOLVABLE (scores)
    // while the ABC leg is still PENDING (needs a second tick). This proves the
    // resolvability decision uses each slot's OWN cadence, in one batch.
    const { satori, registry, alice, sA, sB } = await setup();

    await time.increase(ROUND);
    await registry.setValue(sA, 4000); // sA value @ R
    await registry.setValue(sB, 1000); // sB value @ R == AB anchor A
    const predRound = Number(await satori.getCurrentRound());

    await satori.connect(alice).predictMultipleWithPayloads([
      { gameId: sA, payload: pack1(UP) },
      { gameId: sB, payload: pack1(UP) },
    ]);

    // Post exactly ONE value after R on EACH stream.
    //   sA (ABC): one post-tick is only B -> NOT yet resolvable (needs C).
    //   sB (AB):  one post-tick is B -> resolvable now.
    await time.increase(ROUND);
    await registry.setValue(sA, 4500); // ABC B only (no C yet)
    await time.increase(6 * ROUND);    // reach >= R+7 for cadence-7 sB
    await registry.setValue(sB, 2000); // AB B (A<B -> UP correct)

    // Settle BOTH. AB leg scores; ABC leg is a no-op (still pending).
    await satori.settlePrediction(alice.address, sA);
    await satori.settlePrediction(alice.address, sB);

    // ABC leg: still PENDING (not scored, not voided) — only one post-tick.
    expect((await satori.predictions(alice.address, sA, predRound)).scored).to.equal(
      false,
      "ABC leg needs TWO post-ticks; with one it stays pending (not voided/scored)"
    );
    expect(await satori.streaks(alice.address, sA)).to.equal(0n);

    // AB leg: SCORED correct via its own A<B lens with a single post-tick.
    expect((await satori.predictions(alice.address, sB, predRound)).scored).to.equal(
      true,
      "AB leg resolves with a single post-tick (A<B) and does NOT void"
    );
    expect(await satori.streaks(alice.address, sB)).to.equal(1n);

    // Now provide the ABC leg's C, flat with B -> VOID (proves ABC void uses
    // B-vs-C, not value@R-vs-B). C == B == 4500.
    await time.increase(ROUND);
    await registry.setValue(sA, 4500); // ABC C == B -> VOID (no movement)
    const txA2 = await satori.settlePrediction(alice.address, sA);
    const rcA2 = await txA2.wait();
    expect(eventNames(rcA2, satori)).to.include(
      "PredictionVoided",
      "ABC leg voids on B==C (flat), proving the B-vs-C lens, not value@R-vs-B"
    );
    expect((await satori.predictions(alice.address, sA, predRound)).scored).to.equal(true);
    expect(await satori.streaks(alice.address, sA)).to.equal(0n, "void leaves streak unchanged at 0");
  });

  it("[3] order-independence: AB-first / ABC-second batch still scores each via its own lens", async function () {
    // Same as [1] but the batch order is reversed (AB entry index 0, ABC entry
    // index 1). If `_withABC` clobbered across slots, or the cadence read were
    // hoisted, the leg that lands in the slot the bug favors would be mis-branched
    // regardless of position — so we re-run with swapped positions to make the
    // per-slot capture load-bearing in BOTH orderings.
    const { satori, registry, alice, sA, sB } = await setup();

    await time.increase(ROUND);
    await registry.setValue(sA, 5000); // sA value @ R (NOT ABC anchor)
    await registry.setValue(sB, 1000); // sB value @ R == AB anchor A
    const predRound = Number(await satori.getCurrentRound());

    // Reversed order: AB (sB) first, ABC (sA) second.
    await satori.connect(alice).predictMultipleWithPayloads([
      { gameId: sB, payload: pack1(UP) },
      { gameId: sA, payload: pack1(UP) },
    ]);

    // ABC post-ticks: B(1000) then C(2000) -> UP correct under B<C.
    await time.increase(ROUND);
    await registry.setValue(sA, 1000); // ABC B
    await time.increase(ROUND);
    await registry.setValue(sA, 2000); // ABC C > B

    // AB single post-tick at R+7: B(2000) > A(1000) -> UP correct.
    await time.increase(5 * ROUND);
    await registry.setValue(sB, 2000); // AB B

    const txA = await satori.settlePrediction(alice.address, sA);
    const scoredA = findScored(await txA.wait(), satori, sA);
    expect(scoredA, "ABC leg scored").to.not.equal(null);
    expect(scoredA.correct).to.equal(true, "ABC leg correct via B<C even when batch index 1");
    expect(await satori.streaks(alice.address, sA)).to.equal(1n);

    const txB = await satori.settlePrediction(alice.address, sB);
    const scoredB = findScored(await txB.wait(), satori, sB);
    expect(scoredB, "AB leg scored (not pending)").to.not.equal(null);
    expect(scoredB.correct).to.equal(true, "AB leg correct via A<B even when batch index 0");
    expect(await satori.streaks(alice.address, sB)).to.equal(1n);

    expect((await satori.predictions(alice.address, sA, predRound)).scored).to.equal(true);
    expect((await satori.predictions(alice.address, sB, predRound)).scored).to.equal(true);
  });
});
