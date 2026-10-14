// SECOND round of adversarial COVERAGE for the Satori "scoring" subsystem.
//
// The first pass (scoring.cov.test.js) covered the high-priority gaps and the
// headline shape of each medium gap. This pass drills into the medium-priority
// behavioral *transitions* those tests left unasserted:
//
//   [A] AB-path INCORRECT prediction RESETS a previously-built streak.
//       cov.test.js [1] only exercised AB up-correct / down-correct / void; the
//       AB "wrong direction" streak-reset transition (post != anchor, wrong) was
//       never asserted. A regression that voided-instead-of-reset, or that left
//       the streak intact on an AB miss, would slip through.
//
//   [B] ABC anchor-evicted -> PredictionUnrecoverable. cov.test.js [2]/[4]
//       evicted the AB anchor (getFirstValueAfter path). The ABC branch uses a
//       DIFFERENT registry routine (getFirstTwoValuesAfter) with its own
//       newest-to-oldest walk and its own anchorEvicted signal. That ABC
//       eviction -> Unrecoverable + streak-reset is its own untested code path.
//
//   [C] A SINGLE settlePrediction call drains BOTH pending slots via its
//       internal 2-iteration loop. cov.test.js [6] called settlePrediction
//       twice; the one-call drain of a full 2-slot buffer (oldest then newer)
//       is what the loop exists for and is not directly asserted anywhere.
//
//   [D] A VOIDED slot is genuinely overwriteable: after a void, the pending
//       counter was decremented so a brand-new predict reuses the slot and a
//       later settle of that new prediction succeeds (no NoPendingPrediction
//       revert, no stuck buffer). cov.test.js [0] asserted only the `scored`
//       bit; this asserts the lifecycle continues cleanly through the slot.
//
// SKIPPED (already covered by scoring.cov.test.js): void-preserves-streak [0],
// AB up/down/void correctness [1], AB evicted-anchor->Unrecoverable [2],
// conservation [3], AB eviction boundary 31/32 [4], double-settle idempotency
// [5], two-pending oldest-first [6]. SKIPPED (already-confirmed finding w/
// repro): the 30-bit rawPower truncation asymmetry.
//
// Contract-change note: the platform-fee recipient is now a hard-coded
// immutable constant getter PLATFORM_FEE_RECIPIENT() (no wireFeeRecipient, no
// setPlatformFeeRecipient). None of these scoring cases touch the fee recipient,
// so they assert against current code unchanged.

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture, pack1, voteFor } = require("../fixtures");

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

async function nextRound() {
  await time.increase(ROUND);
}

// ABC scoring — the three-value A/B/C window cases [B], [C] and [D] are named
// for — exists ONLY on an every-round stream (cadence 1440 minutes = one 24h
// round): SatoriEngine takes the ABC path when cadence*60 <= one round, so on
// a coarser stream the identical code takes the AB path instead (that is case
// [A]'s subject). The one-value-per-round rhythm `nextRound()` encodes is the
// right one for it.
async function createABCStream(satori, name, provider) {
  return satori["createSimpleDataStream(string,address,uint24)"](name, provider, 1440);
}

describe("ADV-COV2 scoring (medium-priority transitions)", function () {
  this.timeout(120000);

  // ---------------------------------------------------------------------------
  // [A] AB-path INCORRECT prediction resets a built streak to 0.
  //     Build a streak on a two-round (AB) stream, then predict the WRONG
  //     direction and verify: PredictionScored(correct=false), streak -> 0, no
  //     reward, slot scored. This is the AB miss transition, not the void.
  // ---------------------------------------------------------------------------
  it("[A] AB-path incorrect prediction resets the streak to 0 (scored, not voided, zero pay)", async function () {
    const { satori, engine, registry, rewards, lens, owner, signers } = await loadFixture(deploySatoriFixture);
    const [, alice, bob] = signers;
    const INITIAL = await satori.INITIAL_MINT();
    await satori.transfer(alice.address, INITIAL / 4n);
    await satori.transfer(bob.address, INITIAL / 4n);

    // Two-round (2880-minute) AB stream: anchor = value AT predict round, post = first after.
    const sid = await getStreamId(
      await satori["createSimpleDataStream(string,address,uint24)"]("ABmiss", owner.address, 2880),
      satori
    );
    await registry.setValue(sid, 1000);
    await voteFor(satori, alice, sid);
    await voteFor(satori, bob, sid);

    // Build a streak of 2 via two correct AB cycles (each cycle: A then B>A=UP).
    // Every setValue on a two-round stream needs >= 2 rounds since the last one,
    // so advance 2 rounds before each post (including the cycle's A).
    for (let cyc = 0; cyc < 2; cyc++) {
      const a = 1000 + cyc * 1000;
      await time.increase(2 * ROUND);
      await registry.setValue(sid, a); // A at predict round
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: sid, payload: pack1(UP) }]);
      await time.increase(2 * ROUND);
      await registry.setValue(sid, a + 500); // B > A -> UP correct
      await satori.settlePrediction(alice.address, sid);
    }
    expect(await satori.streaks(alice.address, sid)).to.equal(2n, "two AB wins -> streak 2");

    // Now an AB prediction that is WRONG: predict UP, but B < A -> DOWN wins.
    await time.increase(2 * ROUND);
    await registry.setValue(sid, 5000); // A
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: sid, payload: pack1(UP) }]);
    const missRound = Number(await satori.getCurrentRound());
    await time.increase(2 * ROUND);
    await registry.setValue(sid, 4000); // B (4000) < A (5000) -> market DOWN -> UP wrong

    const owedBefore = (await lens.getTotalClaimableRewards(alice.address))[0];

    // Intent: a wrong AB prediction is SCORED (correct=false), NOT voided.
    await expect(satori.settlePrediction(alice.address, sid))
      .to.emit(engine, "PredictionScored")
      .and.to.not.emit(engine, "PredictionVoided");

    // Intent: the built streak is RESET to 0 (a miss breaks the streak).
    expect(await satori.streaks(alice.address, sid)).to.equal(
      0n,
      "an incorrect AB prediction must reset the streak to 0"
    );
    // Intent: no reward credited for a wrong prediction.
    expect((await lens.getTotalClaimableRewards(alice.address))[0]).to.equal(
      owedBefore,
      "a wrong AB prediction pays nothing"
    );
    // Intent: slot scored (overwriteable for the next predict).
    const pred = await satori.predictions(alice.address, sid, missRound);
    expect(pred.scored).to.equal(true, "missed AB slot is scored");
  });

  // ---------------------------------------------------------------------------
  // [B] ABC anchor-evicted (getFirstTwoValuesAfter path) routes to
  //     PredictionUnrecoverable and resets the streak. The ABC ring-walk is a
  //     distinct routine from the AB getFirstValueAfter walk that cov [2] used.
  // ---------------------------------------------------------------------------
  it("[B] ABC evicted anchor force-finalizes Unrecoverable via getFirstTwoValuesAfter (no spurious score)", async function () {
    this.timeout(600000);
    const { satori, registry, owner, signers } = await loadFixture(deploySatoriFixture);
    const [, alice, bob] = signers;
    const INITIAL = await satori.INITIAL_MINT();
    await satori.transfer(alice.address, INITIAL / 4n);
    await satori.transfer(bob.address, INITIAL / 4n);

    // Every-round (1440-minute) stream — the only cadence band with an ABC window.
    const sid = await getStreamId(await createABCStream(satori, "ABCevict", owner.address), satori);
    await registry.setValue(sid, 1000);
    await voteFor(satori, alice, sid);
    await voteFor(satori, bob, sid);

    // Build a streak of 1 first so we can prove eviction RESETS it.
    await nextRound();
    await registry.setValue(sid, 1100);
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: sid, payload: pack1(UP) }]);
    await nextRound();
    await registry.setValue(sid, 1200); // B
    await nextRound();
    await registry.setValue(sid, 1300); // C > B -> correct
    await satori.settlePrediction(alice.address, sid);
    expect(await satori.streaks(alice.address, sid)).to.equal(1n);

    // Fresh ABC prediction at predRound; then bury the anchor under the ring.
    await nextRound();
    await registry.setValue(sid, 2000);
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: sid, payload: pack1(UP) }]);
    const predRound = Number(await satori.getCurrentRound());
    const predHour = Math.floor(await time.latest() / 3600);

    // The ABC anchor is the entry standing at the prediction's own HOUR (the
    // phase-6 ring and its readers are hour-keyed). 769 fresh post-anchor
    // ticks push every entry <= predHour out of the 768-entry ring, so the
    // newest-to-oldest walk never sees the anchor.
    for (let i = 0; i < 769; i++) {
      await nextRound();
      await registry.setValue(sid, 3000 + i);
    }

    // Confirm the registry reports the ABC anchor as evicted.
    const [, , found, evicted] = await registry.getFirstTwoValuesAfter(sid, predHour);
    expect(found).to.equal(false, "ABC anchor gone -> not found");
    expect(evicted).to.equal(true, "ABC anchor evicted from ring");

    const tx = await satori.settlePrediction(alice.address, sid);
    const rc = await tx.wait();
    const names = rc.logs.map((l) => {
      try { return satori.interface.parseLog(l).name; } catch { return null; }
    });
    expect(names).to.include("PredictionUnrecoverable", "ABC evicted anchor -> Unrecoverable");
    expect(names).to.not.include("PredictionScored", "must NOT score a spurious win/loss");

    const pred = await satori.predictions(alice.address, sid, predRound);
    expect(pred.scored).to.equal(true, "unrecoverable ABC slot is scored");
    expect(await satori.streaks(alice.address, sid)).to.equal(0n, "ABC eviction resets streak");
  });

  // ---------------------------------------------------------------------------
  // [C] A SINGLE settlePrediction call drains BOTH pending slots through its
  //     internal 2-iteration loop. Two ABC predictions are stacked unscored;
  //     after one settlePrediction call both slots are scored.
  // ---------------------------------------------------------------------------
  it("[C] one settlePrediction call drains both pending slots (internal loop)", async function () {
    const { satori, registry, owner, signers } = await loadFixture(deploySatoriFixture);
    const [, alice, bob] = signers;
    const INITIAL = await satori.INITIAL_MINT();
    await satori.transfer(alice.address, INITIAL / 4n);
    await satori.transfer(bob.address, INITIAL / 4n);

    const sid = await getStreamId(await createABCStream(satori, "Drain", owner.address), satori);
    await registry.setValue(sid, 1000);
    await voteFor(satori, alice, sid);
    await voteFor(satori, bob, sid);

    // First (OLDER) ABC prediction at rOld. No settle in between.
    await nextRound();
    await registry.setValue(sid, 5000);
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: sid, payload: pack1(UP) }]);
    const rOld = Number(await satori.getCurrentRound());

    // Second (NEWER) ABC prediction at rNew, one round later. Still no settle:
    // because _makePrediction scores-first, we must ensure no resolvable window
    // exists yet for rOld. We post only ONE value between them (acts as B for
    // rOld but C is not yet present), keeping rOld pending-not-resolvable.
    await nextRound();
    await registry.setValue(sid, 5100); // single post-tick so far
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: sid, payload: pack1(UP) }]);
    const rNew = Number(await satori.getCurrentRound());

    // Both slots populated and unscored.
    expect((await satori.predictions(alice.address, sid, rOld)).scored).to.equal(false);
    expect((await satori.predictions(alice.address, sid, rNew)).scored).to.equal(false);

    // Provide enough post-rNew values that BOTH ABC windows are resolvable:
    // rOld window B,C and rNew window B,C all become available.
    await nextRound();
    await registry.setValue(sid, 5200);
    await nextRound();
    await registry.setValue(sid, 5300);
    await nextRound();
    await registry.setValue(sid, 5400);

    // ONE call must drain BOTH slots (loop runs the internal scorer twice).
    await satori.settlePrediction(alice.address, sid);

    expect((await satori.predictions(alice.address, sid, rOld)).scored).to.equal(
      true,
      "older slot drained by the single call"
    );
    expect((await satori.predictions(alice.address, sid, rNew)).scored).to.equal(
      true,
      "newer slot drained by the same single call"
    );
  });

  // ---------------------------------------------------------------------------
  // [D] A VOIDED slot is fully overwriteable: the void decremented the pending
  //     counter, so a brand-new prediction reuses the slot and later settles
  //     cleanly (no NoPendingPrediction revert, no stuck buffer).
  // ---------------------------------------------------------------------------
  it("[D] a voided slot is reusable: new predict + settle proceeds without revert", async function () {
    const { satori, engine, registry, owner, signers } = await loadFixture(deploySatoriFixture);
    const [, alice, bob] = signers;
    const INITIAL = await satori.INITIAL_MINT();
    await satori.transfer(alice.address, INITIAL / 4n);
    await satori.transfer(bob.address, INITIAL / 4n);

    const sid = await getStreamId(await createABCStream(satori, "VoidReuse", owner.address), satori);
    await registry.setValue(sid, 1000);
    await voteFor(satori, alice, sid);
    await voteFor(satori, bob, sid);

    // Make a prediction that VOIDs (ABC anchor B == post C, flat market).
    await nextRound();
    await registry.setValue(sid, 2000);
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: sid, payload: pack1(UP) }]);
    const voidRound = Number(await satori.getCurrentRound());
    await nextRound();
    await registry.setValue(sid, 2500); // B = 2500
    await nextRound();
    await registry.setValue(sid, 2500); // C == B -> VOID

    await expect(satori.settlePrediction(alice.address, sid))
      .to.emit(engine, "PredictionVoided");
    expect((await satori.predictions(alice.address, sid, voidRound)).scored).to.equal(true);

    // The voided slot must now be reusable. A brand-new prediction proceeds
    // (predict scores-first; the voided slot is overwriteable) and later settles
    // cleanly through the (formerly voided) buffer without reverting.
    await nextRound();
    await registry.setValue(sid, 3000);
    await expect(
      satori.connect(alice).predictMultipleWithPayloads([{ gameId: sid, payload: pack1(UP) }])
    ).to.not.be.reverted;
    const reuseRound = Number(await satori.getCurrentRound());
    expect((await satori.predictions(alice.address, sid, reuseRound)).scored).to.equal(
      false,
      "fresh prediction occupies a (reused) slot, unscored"
    );

    await nextRound();
    await registry.setValue(sid, 3100); // B
    await nextRound();
    await registry.setValue(sid, 3200); // C > B -> correct

    // Settling the reused slot must not revert (no NoPendingPrediction from a
    // mis-tracked pending counter) and must mark it scored.
    await expect(satori.settlePrediction(alice.address, sid)).to.not.be.reverted;
    expect((await satori.predictions(alice.address, sid, reuseRound)).scored).to.equal(
      true,
      "reused slot settles cleanly after a prior void"
    );
  });
});
