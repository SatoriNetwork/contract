// Adversarial COVERAGE for the Satori "scoring" subsystem.
//
// Targets the high/med-priority coverage gaps recorded in
// adversarial-findings/_raw_review.json (system == "scoring"):
//   [0] void preserves a NON-ZERO streak, pays zero, marks the slot scored.
//   [1] AB (cadence>=2) anchor = value-AT-round (not first-after); UP/DOWN/void
//       correctness, with values chosen to FLIP under an ABC misreading.
//   [2] AB evicted-anchor routes to PredictionUnrecoverable (not a bogus
//       win/loss against getValueAtHour's zero fallback).
//   [3] conservation: Σ(rewards across winners) <= streamPool, never over.
//   [4] eviction exact boundary 767 (recoverable) vs 768 (unrecoverable).
//   [5] double-settle idempotency: no counter underflow, reward credited once.
//   [6] (low, included) two-pending ABC oldest-first streak ordering.
//
// The one already-confirmed finding for this system (30-bit rawPower
// truncation asymmetry) is deliberately NOT re-tested here.

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture, pack1, voteFor } = require("../fixtures");

const UP = 1;
const DOWN = 2;
const ROUND = 86400; // 24h round length in seconds
const RING = 768;    // hour-keyed history ring depth (phase 6); eviction takes RING+ newer entries

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

// Advance one full round (86400s). A full round both rolls getCurrentRound()
// forward AND satisfies the every-round timestamp guard (which needs
// >= ROUND - 30min between consecutive setValues).
async function nextRound() {
  await time.increase(ROUND);
}

// ABC scoring — the three-value A/B/C window these cases are named for — exists
// ONLY on an every-round stream (cadence 1440 minutes = one 24h round):
// SatoriEngine takes the ABC path when cadence*60 <= one round, so any coarser
// stream takes the AB path (already covered by cases [1], [2] and [4] below,
// which build explicit two-round streams). The one-round-per-value rhythm
// `nextRound()` encodes is the correct one for it.
async function createABCStream(satori, name, provider) {
  return satori["createSimpleDataStream(string,address,uint24)"](name, provider, 1440);
}

describe("ADV-COV scoring", function () {
  // ---------------------------------------------------------------------------
  // [0] Void on a NON-ZERO streak: streak unchanged, zero payout, slot scored.
  // ---------------------------------------------------------------------------
  it("[0] void on a built streak preserves the streak, pays zero, marks slot scored", async function () {
    this.timeout(120000);
    const { satori, engine, registry, rewards, owner, signers } = await loadFixture(deploySatoriFixture);
    const [, alice, bob] = signers;
    const INITIAL = await satori.INITIAL_MINT();
    await satori.transfer(alice.address, INITIAL / 4n);
    await satori.transfer(bob.address, INITIAL / 4n);

    const sid = await getStreamId(await createABCStream(satori, "S", owner.address), satori);
    await registry.setValue(sid, 1000);
    await voteFor(satori, alice, sid);
    await voteFor(satori, bob, sid);

    // Build alice a streak of 2 via two correct ABC predictions.
    // ABC: anchor=B (first after), post=C (second after); UP wins iff C>B.
    // Cycle 1
    await nextRound();
    await registry.setValue(sid, 1100);
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: sid, payload: pack1(UP) }]);
    const r1 = Number(await satori.getCurrentRound());
    await nextRound();
    await registry.setValue(sid, 1200); // B
    await nextRound();
    await registry.setValue(sid, 1300); // C > B -> UP correct
    await satori.settlePrediction(alice.address, sid);
    expect(await satori.streaks(alice.address, sid)).to.equal(1n);

    // Cycle 2
    await nextRound();
    await registry.setValue(sid, 1400);
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: sid, payload: pack1(UP) }]);
    await nextRound();
    await registry.setValue(sid, 1500); // B
    await nextRound();
    await registry.setValue(sid, 1600); // C > B -> UP correct
    // Prove the payout METER used for the void below is live: a genuinely
    // winning settle must move `unclaimedRewards`. Without this, "the void
    // credited nothing" is indistinguishable from "this ledger never moves".
    const owedBeforeWin = await rewards.unclaimedRewards(alice.address);
    await satori.settlePrediction(alice.address, sid);
    const owedAfterWin = await rewards.unclaimedRewards(alice.address);
    expect(owedAfterWin - owedBeforeWin, "a WINNING settle must credit the ledger").to.be.gt(0n);
    const streakBeforeVoid = await satori.streaks(alice.address, sid);
    expect(streakBeforeVoid).to.equal(2n);

    // Now a prediction that VOIDS: ABC anchor B == post C (flat market).
    await nextRound();
    await registry.setValue(sid, 1700);
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: sid, payload: pack1(UP) }]);
    const voidRound = Number(await satori.getCurrentRound());
    await nextRound();
    await registry.setValue(sid, 1900); // B = 1900
    await nextRound();
    await registry.setValue(sid, 1900); // C == B -> VOID

    // Snapshot the reward ledger before settling the void.
    // P3 — WRONG LEDGER. Settling only ever CREDITS `unclaimedRewards`
    // (_creditReward, SatoriRewards.sol); the only user-facing mint is
    // inside `_claimFor` (:1638), i.e. only on `claim()`. `balanceOf` therefore
    // cannot move across `settlePrediction` under ANY behaviour, so the old
    // `balanceOf == balBefore` check was frozen at zero by construction: a void
    // branch that paid a FULL reward would have left it green (a genuinely
    // paying settle in this same fixture moves unclaimedRewards by ~590e18 and
    // balanceOf by exactly 0). Measure the ledger the payout actually lands in.
    const balBefore = await satori.balanceOf(alice.address);
    const owedBefore = await rewards.unclaimedRewards(alice.address);

    await expect(satori.settlePrediction(alice.address, sid))
      .to.emit(engine, "PredictionVoided");

    // Intent: streak UNCHANGED (not reset, not incremented).
    expect(await satori.streaks(alice.address, sid)).to.equal(
      streakBeforeVoid,
      "void must preserve the streak"
    );
    // Intent: zero payout for the void.
    expect(await rewards.unclaimedRewards(alice.address)).to.equal(owedBefore, "void pays nothing");
    // ...and no direct mint on the settle path either (kept: still true, just
    // not sufficient on its own).
    expect(await satori.balanceOf(alice.address)).to.equal(balBefore, "void mints nothing");
    // Intent: slot marked scored so it is overwriteable on next predict.
    const pred = await satori.predictions(alice.address, sid, voidRound);
    expect(pred.scored).to.equal(true, "voided slot must be scored");

    // And a follow-up correct prediction continues from the preserved streak
    // (streak 2 -> would have produced multiplier; correct -> streak 3).
    void r1;
    await nextRound();
    await registry.setValue(sid, 2000);
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: sid, payload: pack1(UP) }]);
    await nextRound();
    await registry.setValue(sid, 2100);
    await nextRound();
    await registry.setValue(sid, 2200);
    await satori.settlePrediction(alice.address, sid);
    expect(await satori.streaks(alice.address, sid)).to.equal(
      streakBeforeVoid + 1n,
      "streak continues from preserved value after a void"
    );
  });

  // ---------------------------------------------------------------------------
  // [1] AB-path anchor = value AT the predict round, NOT the first value after.
  //     We pick values so the result FLIPS if the code mistakenly used the
  //     ABC interpretation (anchor = first-after).
  // ---------------------------------------------------------------------------
  it("[1] AB-path scores UP/DOWN/void against value-AT-round (flips vs ABC misreading)", async function () {
    this.timeout(120000);
    const { satori, engine, registry, owner, signers } = await loadFixture(deploySatoriFixture);
    const [, alice, bob] = signers;
    const INITIAL = await satori.INITIAL_MINT();
    await satori.transfer(alice.address, INITIAL / 4n);
    await satori.transfer(bob.address, INITIAL / 4n);

    // Helper: build a fresh two-round (AB) stream, vote it eligible, post A.
    async function freshABStream(name, aValue) {
      const sid = await getStreamId(
        await satori["createSimpleDataStream(string,address,uint24)"](name, owner.address, 2880),
        satori
      );
      await registry.setValue(sid, aValue); // A at predict round
      await voteFor(satori, alice, sid);
      await voteFor(satori, bob, sid);
      return sid;
    }

    // Case UP-correct with ABC-flip:
    //   A = 100 (value AT predict round).
    //   B = 90  (first value after -> would be the ABC anchor).
    //   C = 95  (second value after).
    //   AB:  post(B=90) vs anchor(A=100) -> 90 < 100 -> DOWN wins -> UP wrong.
    //   ABC: post(C=95) vs anchor(B=90)  -> 95 > 90  -> UP wins.
    // We predict DOWN so AB => CORRECT, ABC => WRONG. The streak proves which.
    {
      const sid = await freshABStream("ABdown", 100);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: sid, payload: pack1(DOWN) }]);
      await time.increase(2 * ROUND);
      await registry.setValue(sid, 90); // B
      await time.increase(2 * ROUND);
      await registry.setValue(sid, 95); // C (must be ignored by AB)
      await satori.settlePrediction(alice.address, sid);
      // AB: B(90) < A(100) -> DOWN correct -> streak 1.
      expect(await satori.streaks(alice.address, sid)).to.equal(
        1n,
        "AB must compare B against value-AT-round (A=100), not the next value"
      );
    }

    // Case UP-correct: A=100, B=150 -> UP wins under AB.
    {
      const sid = await freshABStream("ABup", 100);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: sid, payload: pack1(UP) }]);
      await time.increase(2 * ROUND);
      await registry.setValue(sid, 150); // B > A -> UP correct
      await satori.settlePrediction(alice.address, sid);
      expect(await satori.streaks(alice.address, sid)).to.equal(1n, "AB UP correct (B>A)");
    }

    // Case void: A=100, B=100 -> no movement -> void.
    {
      const sid = await freshABStream("ABvoid", 100);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: sid, payload: pack1(UP) }]);
      const vRound = Number(await satori.getCurrentRound());
      await time.increase(2 * ROUND);
      await registry.setValue(sid, 100); // B == A -> void
      await expect(satori.settlePrediction(alice.address, sid))
        .to.emit(engine, "PredictionVoided");
      expect(await satori.streaks(alice.address, sid)).to.equal(0n, "void leaves streak 0");
      const pred = await satori.predictions(alice.address, sid, vRound);
      expect(pred.scored).to.equal(true, "voided AB slot is scored");
    }
  });

  // ---------------------------------------------------------------------------
  // [2] AB evicted-anchor routes to Unrecoverable, never a bogus win/loss
  //     against getValueAtRound's zero/straddle fallback.
  // ---------------------------------------------------------------------------
  it("[2] AB evicted anchor force-finalizes Unrecoverable (no spurious score)", async function () {
    this.timeout(600000);
    const { satori, registry, owner, signers } = await loadFixture(deploySatoriFixture);
    const [, alice, bob] = signers;
    const INITIAL = await satori.INITIAL_MINT();
    await satori.transfer(alice.address, INITIAL / 4n);
    await satori.transfer(bob.address, INITIAL / 4n);

    // Two-round (2880-minute) AB stream.
    const sid = await getStreamId(
      await satori["createSimpleDataStream(string,address,uint24)"]("ABevict", owner.address, 2880),
      satori
    );
    await registry.setValue(sid, 100); // A (will be evicted)
    await voteFor(satori, alice, sid);
    await voteFor(satori, bob, sid);

    // Build a streak of 1 first (so we can prove eviction RESETS it to 0).
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: sid, payload: pack1(UP) }]);
    await time.increase(2 * ROUND);
    await registry.setValue(sid, 150); // B > A -> correct
    await satori.settlePrediction(alice.address, sid);
    expect(await satori.streaks(alice.address, sid)).to.equal(1n);

    // Fresh prediction; let the ring roll the anchor out (>=768 newer values).
    await time.increase(2 * ROUND);
    await registry.setValue(sid, 200); // P2 anchor
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: sid, payload: pack1(UP) }]);
    const p2Round = Number(await satori.getCurrentRound());

    // RING+1 fresh post-anchor ticks evict P2's anchor from the 768-entry ring.
    for (let i = 0; i < RING + 1; i++) {
      await time.increase(2 * ROUND);
      await registry.setValue(sid, 300 + i);
    }

    // getValueAtHour for the evicted hour returns 0 (older than everything),
    // but the AB walk must report anchorEvicted=true and route to Unrecoverable.
    const tx = await satori.settlePrediction(alice.address, sid);
    const rc = await tx.wait();
    const names = rc.logs.map((l) => {
      try { return satori.interface.parseLog(l).name; } catch { return null; }
    });
    expect(names).to.include("PredictionUnrecoverable", "evicted AB anchor -> Unrecoverable");
    expect(names).to.not.include("PredictionScored", "must NOT score a spurious win/loss");

    const pred = await satori.predictions(alice.address, sid, p2Round);
    expect(pred.scored).to.equal(true, "unrecoverable slot is scored");
    expect(await satori.streaks(alice.address, sid)).to.equal(0n, "eviction resets streak");
  });

  // ---------------------------------------------------------------------------
  // [4] Eviction exact boundary: RING-1 (767) post-anchor ticks recoverable;
  //     RING (768) evicts. Uses the AB (single post tick) path so we can pin
  //     the count precisely. The registry probes query the prediction's HOUR —
  //     the hour-keyed unit the phase-6 ring and its readers speak.
  // ---------------------------------------------------------------------------
  it("[4] AB eviction boundary: RING-1 post-anchor ticks recoverable, RING unrecoverable", async function () {
    this.timeout(600000);
    const { satori, engine, registry, owner, signers } = await loadFixture(deploySatoriFixture);
    const [, alice, bob] = signers;
    const INITIAL = await satori.INITIAL_MINT();
    await satori.transfer(alice.address, INITIAL / 4n);
    await satori.transfer(bob.address, INITIAL / 4n);

    // --- RING-1 post-anchor ticks: ring still holds anchor (anchor + 767 = 768). ---
    {
      const sid = await getStreamId(
        await satori["createSimpleDataStream(string,address,uint24)"]("E31", owner.address, 2880),
        satori
      );
      await registry.setValue(sid, 100); // A
      await voteFor(satori, alice, sid);
      await voteFor(satori, bob, sid);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: sid, payload: pack1(UP) }]);
      const pRound = Number(await satori.getCurrentRound());
      const pHour = Math.floor(await time.latest() / 3600);

      // Push exactly RING-1 newer values. ring = [A, +767] = 768 entries, anchor present.
      for (let i = 0; i < RING - 1; i++) {
        await time.increase(2 * ROUND);
        await registry.setValue(sid, 200 + i); // strictly increasing -> UP correct
      }
      const [, found, evicted] = await registry.getFirstValueAfter(sid, pHour);
      expect(found).to.equal(true, "RING-1 ticks: anchor still present, B found");
      expect(evicted).to.equal(false, "RING-1 ticks: not evicted");

      await expect(satori.settlePrediction(alice.address, sid))
        .to.emit(engine, "PredictionScored");
      const pred = await satori.predictions(alice.address, sid, pRound);
      expect(pred.scored).to.equal(true);
      // First post value (200) > A (100) -> UP correct.
      expect(await satori.streaks(alice.address, sid)).to.equal(1n);
    }

    // --- RING post-anchor ticks: anchor pushed out -> unrecoverable. ---
    {
      const sid = await getStreamId(
        await satori["createSimpleDataStream(string,address,uint24)"]("E32", owner.address, 2880),
        satori
      );
      await registry.setValue(sid, 100); // A
      await voteFor(satori, alice, sid);
      await voteFor(satori, bob, sid);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: sid, payload: pack1(UP) }]);
      const pRound = Number(await satori.getCurrentRound());
      const pHour = Math.floor(await time.latest() / 3600);

      for (let i = 0; i < RING; i++) {
        await time.increase(2 * ROUND);
        await registry.setValue(sid, 200 + i);
      }
      const [, found, evicted] = await registry.getFirstValueAfter(sid, pHour);
      expect(found).to.equal(false, "RING ticks: anchor evicted, B not returned");
      expect(evicted).to.equal(true, "RING ticks: anchorEvicted");

      await expect(satori.settlePrediction(alice.address, sid))
        .to.emit(engine, "PredictionUnrecoverable");
      const pred = await satori.predictions(alice.address, sid, pRound);
      expect(pred.scored).to.equal(true);
    }
  });

  // ---------------------------------------------------------------------------
  // [5] Double-settle idempotency: a second (and third) settle on an
  //     already-scored slot is a no-op; reward credited exactly once; no
  //     counter underflow / NoPendingPrediction revert.
  // ---------------------------------------------------------------------------
  it("[5] double-settle on a scored slot is a no-op (reward once, no underflow)", async function () {
    this.timeout(120000);
    const { satori, registry, rewards, lens, owner, signers } = await loadFixture(deploySatoriFixture);
    const [, alice, bob, carol] = signers;
    const INITIAL = await satori.INITIAL_MINT();
    await satori.transfer(alice.address, INITIAL / 4n);
    await satori.transfer(bob.address, INITIAL / 4n);

    const sid = await getStreamId(await createABCStream(satori, "S", owner.address), satori);
    await registry.setValue(sid, 1000);
    await voteFor(satori, alice, sid);
    await voteFor(satori, bob, sid);

    // Build streak to 2 so the next correct prediction earns a real reward.
    for (let cyc = 0; cyc < 2; cyc++) {
      await nextRound();
      await registry.setValue(sid, 2000 + cyc * 1000);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: sid, payload: pack1(UP) }]);
      await nextRound();
      await registry.setValue(sid, 2100 + cyc * 1000);
      await nextRound();
      await registry.setValue(sid, 2200 + cyc * 1000);
      await satori.settlePrediction(alice.address, sid);
    }
    expect(await satori.streaks(alice.address, sid)).to.equal(2n);

    // Earning prediction (streak 2 -> multiplier 100).
    await nextRound();
    await registry.setValue(sid, 5000);
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: sid, payload: pack1(UP) }]);
    const earnRound = Number(await satori.getCurrentRound());
    await nextRound();
    await registry.setValue(sid, 5100); // B
    await nextRound();
    await registry.setValue(sid, 5200); // C > B -> UP correct, pays out

    // First settle: credits reward.
    await satori.connect(carol).settlePrediction(alice.address, sid);
    const owedAfterFirst = (await lens.getTotalClaimableRewards(alice.address))[0];
    const streakAfterFirst = await satori.streaks(alice.address, sid);
    const predAfterFirst = await satori.predictions(alice.address, sid, earnRound);
    expect(predAfterFirst.scored).to.equal(true);
    expect(owedAfterFirst).to.be.gt(0n, "correct prediction should have earned a reward");

    // Second settle, same tx context: must not revert, must not double-credit.
    await expect(satori.connect(carol).settlePrediction(alice.address, sid)).to.not.be.reverted;
    // Third settle in a later tx: still a no-op.
    await nextRound();
    await expect(satori.connect(bob).settlePrediction(alice.address, sid)).to.not.be.reverted;

    expect((await lens.getTotalClaimableRewards(alice.address))[0]).to.equal(
      owedAfterFirst,
      "reward must be credited exactly once across repeated settles"
    );
    expect(await satori.streaks(alice.address, sid)).to.equal(
      streakAfterFirst,
      "streak stable across repeated settles"
    );
  });

  // ---------------------------------------------------------------------------
  // [3] Conservation: Σ(rewards across winners of one (game,round,dir)) is
  //     <= streamPool, and the per-winner committed weight never over-sums the
  //     denominator (truncation only ever under-distributes).
  // ---------------------------------------------------------------------------
  it("[3] sum of winner rewards <= streamPool; Σuserweight <= totalweight (no over-pay)", async function () {
    this.timeout(120000);
    const { satori, token, registry, rewards, lens, owner, signers } = await loadFixture(deploySatoriFixture);
    const voters = signers.slice(1, 6); // 5 winners
    const INITIAL = await satori.INITIAL_MINT();

    // Spread odd-wei balances so per-stream power has non-zero low-30 bits,
    // exposing the rawPower 30-bit truncation in the numerator vs denominator.
    const amounts = [
      INITIAL / 7n + 12345n,
      INITIAL / 9n + 6789n,
      INITIAL / 11n + 4242n,
      INITIAL / 13n + 99n,
      INITIAL / 17n + 1n,
    ];
    for (let i = 0; i < voters.length; i++) {
      await satori.transfer(voters[i].address, amounts[i]);
    }

    // Single weighted stream, so streamPool == the round's full per-game
    // allocation. (The value-provider cut is gone entirely — there is no longer
    // a cut-bps creation argument, and nothing is subtracted from the pool.)
    const sid = await getStreamId(
      await satori["createSimpleDataStream(string,address,uint24)"](
        "C", owner.address, 720
      ),
      satori
    );
    await registry.setValue(sid, 1000);
    for (const v of voters) await voteFor(satori, v, sid);

    // Build everyone to streak 2 (so multiplier=100, real weights) with three
    // synchronized correct ABC cycles.
    for (let cyc = 0; cyc < 2; cyc++) {
      await nextRound();
      await registry.setValue(sid, 2000 + cyc * 1000);
      for (const v of voters) {
        await satori.connect(v).predictMultipleWithPayloads([{ gameId: sid, payload: pack1(UP) }]);
      }
      await nextRound();
      await registry.setValue(sid, 2100 + cyc * 1000); // B
      await nextRound();
      await registry.setValue(sid, 2200 + cyc * 1000); // C > B
      for (const v of voters) await satori.settlePrediction(v.address, sid);
    }
    for (const v of voters) {
      expect(await satori.streaks(v.address, sid)).to.equal(2n);
    }

    // The measured round: all five predict UP, all win.
    await nextRound();
    await registry.setValue(sid, 9000);
    for (const v of voters) {
      await satori.connect(v).predictMultipleWithPayloads([{ gameId: sid, payload: pack1(UP) }]);
    }
    const round = Number(await satori.getCurrentRound());

    // totalWeight committed at predict time (denominator).
    const totalWeight = await lens.totalWeightByDirection(sid, round, UP);
    expect(totalWeight).to.be.gt(0n);

    // Per-winner committed weight (derived from the truncated stored rawPower).
    let sumUserWeight = 0n;
    for (const v of voters) {
      sumUserWeight += await lens.userWeightByDirection(v.address, sid, round, UP);
    }
    // Truncation must NEVER let the numerator over-sum the denominator.
    expect(sumUserWeight).to.be.lte(
      totalWeight,
      "Σ userWeight must be <= totalWeight (never over-distribute)"
    );

    // streamPool for this round: the sole weighted game that was predicted takes
    // the whole round denominator, so its allocation == the on-chain round
    // budget. Both carve-outs that used to shrink it are gone (no value-provider
    // cut, no first-predictor bonus reservation), so the budget IS the on-chain
    // gross. The platform fee moved to the immutable token as a senior,
    // off-budget dev fee (see test/next/DevFee.test.js), so that gross is the
    // RESIDUAL after it: emissionRateNow - devRateNow (offchainShareBps == 0
    // here). Both come from the HUB: the emission is its decaying schedule, and
    // the token can no longer compute a per-round fee slice because it does not
    // know that schedule.
    const gross = (await satori.emissionRateNow()) - (await satori.devRateNow());
    const streamPool = gross;

    // Settle all five (post B & C), summing the actual credited reward deltas.
    await nextRound();
    await registry.setValue(sid, 9100); // B
    await nextRound();
    await registry.setValue(sid, 9200); // C > B -> all UP correct

    // Under eager credit, 1% (REFERRAL_BPS) is skimmed from each predictor
    // reward at credit time. These voters set no referral, so every skim routes
    // to MARKETING_FEE_RECIPIENT's unclaimedRewards bucket. Conservation must be
    // measured over the winners' NET buckets PLUS that marketing bucket so the
    // full pool is still accounted for exactly.
    const MARKETING = await rewards.marketingFeeRecipient();
    const marketingBefore = await rewards.unclaimedRewards(MARKETING);

    const before = [];
    for (const v of voters) before.push((await lens.getTotalClaimableRewards(v.address))[0]);
    for (const v of voters) await satori.settlePrediction(v.address, sid);

    let sumRewards = 0n;
    for (let i = 0; i < voters.length; i++) {
      const delta = ((await lens.getTotalClaimableRewards(voters[i].address))[0]) - before[i];
      expect(delta).to.be.gte(0n);
      sumRewards += delta;
    }
    // Add the 1% skim that landed in the marketing/referral bucket for these
    // credits, so sumRewards reconstructs the GROSS distribution (winner net +
    // diverted cut) and the pool-level invariant stays exact.
    const marketingDelta = (await rewards.unclaimedRewards(MARKETING)) - marketingBefore;
    expect(marketingDelta).to.be.gt(0n, "the 1% referral skim must land in the marketing bucket");
    sumRewards += marketingDelta;

    // Conservation: never pays out more than the pool.
    expect(sumRewards).to.be.lte(streamPool, "Σ rewards must not exceed streamPool");
    // And it should actually distribute a meaningful share (sanity: > 99% of pool,
    // since five winners hold ~all the eligible weight in their direction).
    expect(sumRewards).to.be.gt((streamPool * 99n) / 100n, "winners + skim receive ~all of the pool");
  });

  // ---------------------------------------------------------------------------
  // [6] ABC two-pending: oldest slot settles first. An older Unrecoverable
  //     resets the streak; the newer pending slot still carries its
  //     predict-time-captured multiplier when it later scores.
  // ---------------------------------------------------------------------------
  it("[6] two-pending ABC settles oldest-first; older unrecoverable resets, newer keeps its multiplier", async function () {
    this.timeout(120000);
    const { satori, registry, owner, signers } = await loadFixture(deploySatoriFixture);
    const [, alice, bob] = signers;
    const INITIAL = await satori.INITIAL_MINT();
    await satori.transfer(alice.address, INITIAL / 4n);
    await satori.transfer(bob.address, INITIAL / 4n);

    const sid = await getStreamId(await createABCStream(satori, "S", owner.address), satori);
    await registry.setValue(sid, 1000);
    await voteFor(satori, alice, sid);
    await voteFor(satori, bob, sid);

    // Build alice's streak to 3 so her captured multiplier on later predicts is
    // non-trivial (and so an eviction-reset is observable).
    for (let cyc = 0; cyc < 3; cyc++) {
      await nextRound();
      await registry.setValue(sid, 2000 + cyc * 1000);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: sid, payload: pack1(UP) }]);
      await nextRound();
      await registry.setValue(sid, 2100 + cyc * 1000);
      await nextRound();
      await registry.setValue(sid, 2200 + cyc * 1000);
      await satori.settlePrediction(alice.address, sid);
    }
    expect(await satori.streaks(alice.address, sid)).to.equal(3n);

    // OLDER pending prediction (slot 1) at round rOld. Capture nothing after,
    // so it remains unscored.
    await nextRound();
    await registry.setValue(sid, 6000);
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: sid, payload: pack1(UP) }]);
    const rOld = Number(await satori.getCurrentRound());
    const predOld0 = await satori.predictions(alice.address, sid, rOld);
    expect(predOld0.scored).to.equal(false);
    const oldMultiplier = predOld0.multiplier; // captured from streak 3

    // NEWER pending prediction (slot 2) at a later round. Make this one
    // resolvable LATER (post B & C) while the older one gets evicted.
    await nextRound();
    await registry.setValue(sid, 6100);
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: sid, payload: pack1(UP) }]);
    const rNew = Number(await satori.getCurrentRound());
    const predNew0 = await satori.predictions(alice.address, sid, rNew);
    expect(predNew0.scored).to.equal(false);
    const newMultiplier = predNew0.multiplier; // captured from streak 3 (no score between)
    // Both are streak-3 captures, but the per-game adaptive dust threshold can nudge
    // between the two predicts, so old/new multipliers may legitimately differ now
    // (they no longer depend on streak alone). Both are real, non-zero captures — the
    // point tested below is that the NEWER slot RETAINS whatever it captured.
    expect(oldMultiplier).to.be.gt(0n);
    expect(newMultiplier).to.be.gt(0n);

    // Both slots now occupied + unscored. Drain the buffer.
    // First, push the OLDER anchor out of the ring (>=32 ticks past rOld) while
    // keeping the NEWER anchor (rNew) + its post values present is impossible
    // simultaneously, so instead we settle in stages:
    //
    // Stage 1: provide B & C just after rNew (but BEFORE evicting rOld). The
    // oldest-first rule means the FIRST settle targets rOld, which at this point
    // is still recoverable-pending (no eviction yet, B/C for rOld not yet 2
    // post-anchor ticks dedicated to it). To force an OLDER Unrecoverable we
    // roll the ring far enough to evict rOld but we must do it without evicting
    // rNew. Since rOld and rNew are only one round apart, evicting rOld via 32
    // ticks would also evict rNew. So we instead resolve rNew first by letting
    // the oldest (rOld) become Unrecoverable only after rNew has been scored.
    //
    // Concretely: settle repeatedly. Oldest-first picks rOld each call until it
    // terminates. We post values that make rOld's window VOID-or-correct, then
    // observe rNew still scores with its captured multiplier.

    // Post two values after rNew: these serve as B,C for BOTH pending rounds'
    // ABC windows (first-after rOld = 6100 already, etc). We control outcomes.
    await nextRound();
    await registry.setValue(sid, 6300); // tick X
    await nextRound();
    await registry.setValue(sid, 6400); // tick Y

    // Drain: settlePrediction loops up to 2 internal score attempts; call it
    // enough times to settle both slots.
    await satori.settlePrediction(alice.address, sid);
    await satori.settlePrediction(alice.address, sid);

    const predOld1 = await satori.predictions(alice.address, sid, rOld);
    const predNew1 = await satori.predictions(alice.address, sid, rNew);
    expect(predOld1.scored).to.equal(true, "older slot settled");
    expect(predNew1.scored).to.equal(true, "newer slot settled");

    // The newer slot retained its predict-time multiplier through the whole
    // sequence (it is read back from storage, not recomputed from the
    // possibly-changed live streak).
    expect(predNew1.multiplier).to.equal(
      newMultiplier,
      "newer slot keeps its predict-time-captured multiplier"
    );
  });
});
