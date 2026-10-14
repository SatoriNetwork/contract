/**
 * prediction-delegation.cov2.test.js
 *
 * SECOND round of adversarial COVERAGE for the prediction-delegation
 * subsystem — the MEDIUM-priority gaps from
 * adversarial-findings/_raw_review.json that the first coverage pass
 * (prediction-delegation.cov.test.js) did NOT exercise.
 *
 * The first pass covered:
 *   - GAP 4 (predict-time stake == frozen snapshot total)        [done]
 *   - GAP 1 (competing predictors split pool by power)           [done]
 *   - GAP 3 (conservation) — but ONLY the clean-JOIN churn case  [partial]
 *   - GAP 5 (multi-round lapsed delegator) — but ONLY a MODEST   [partial]
 *           round count well UNDER the 1024 cap, so the cap +
 *           cursor-resume path itself was never crossed.
 *
 * This file fills the two genuinely-uncovered MED gaps:
 *
 *   GAP 3 (med), churn variant: conservation across a round where a
 *   delegator CLEANLY undelegates a round BEFORE the delegate predicts
 *   (so they are correctly out of the predict-round snapshot). This is
 *   distinct from the CONFIRMED same-round-undelegate orphan finding
 *   (adv_7): here the undelegate activates before the predict, so NO
 *   reward is owed to the departed delegator for the predict round, and
 *   Sum(predictor own + surviving delegator credits) == total minted
 *   must still hold with no orphan and no over-mint.
 *
 *   GAP 5 (med), cap-resume variant: a delegator who lapses for MORE
 *   than MAX_DELEGATOR_ROUNDS_PER_CALL (1024) rounds and claims in one
 *   shot. The walk MUST hit the per-call cap, advance its cursor, and
 *   resume on subsequent claims — crediting every active round EXACTLY
 *   once (no double-credit across the cap boundary, no skipped round).
 *   The cumulative credit must equal an independent per-round reference.
 *
 * IMMUTABLE FEE NOTE (contract change since the audit): the platform-fee
 * RECIPIENT is now the immutable compile-time constant
 * PLATFORM_FEE_RECIPIENT() (the 0x…dEaD placeholder until the real
 * splitter is pasted in) — there is no wire step and no setter. The RATE
 * is deploy-set and immutable (the admin can no longer change it). These
 * tests use deploySatoriFixtureNoFee, which deploys SatoriRewards with a
 * 0 bps rate — exactly what they need to isolate the prediction split from
 * any platform skim.
 */

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixtureNoFee, pack1, VOTE, voteFor, warmUpLoyalty } = require("../fixtures");

const UP = 1;
// The value-provider cut is gone, so stream creation no longer takes a cut-bps
// argument: the 3-arg (name, provider, minCadenceRounds) overload is the one.
const SIMPLE3 = "createSimpleDataStream(string,address,uint24)";
const ROUND_SECONDS = 86400; // 24h rounds

async function advanceRound() {
  const currentTime = await time.latest();
  const nextMidnight = Math.floor(currentTime / ROUND_SECONDS) * ROUND_SECONDS + ROUND_SECONDS;
  await time.increaseTo(nextMidnight + 1);
}

// Jump forward `n` whole rounds in ONE time hop (cheap — no per-round txs).
async function advanceManyRounds(n) {
  const currentTime = await time.latest();
  const base = Math.floor(currentTime / ROUND_SECONDS) * ROUND_SECONDS;
  await time.increaseTo(base + ROUND_SECONDS * n + 1);
}

async function streamIdFromTx(tx, satori) {
  const rcpt = await tx.wait();
  for (const log of rcpt.logs) {
    try {
      const p = satori.interface.parseLog(log);
      if (p && p.name === "DataStreamCreated") return p.args.streamId;
    } catch (e) {}
  }
  throw new Error("DataStreamCreated not found");
}

async function makeStream(satori, registry, owner, name) {
  const sid = await streamIdFromTx(
    await satori[SIMPLE3](name, owner.address, 1440), satori);
  await registry.setValue(sid, 100);
  return sid;
}

function sumRewardSplit(rcpt, rewards) {
  let predictorAmount = 0n, delegatorAmount = 0n;
  for (const log of rcpt.logs) {
    try {
      const p = rewards.interface.parseLog(log);
      if (p && p.name === "RewardSplit") {
        predictorAmount += BigInt(p.args.predictorAmount);
        delegatorAmount += BigInt(p.args.delegatorAmount);
      }
    } catch (e) {}
  }
  return { predictorAmount, delegatorAmount };
}

describe("prediction-delegation coverage round 2 (med-priority gaps)", function () {
  this.timeout(120000);

  // ---------------------------------------------------------------------------
  // GAP 3 (med) — CHURN variant the first pass did not cover.
  //
  // A delegator (A) undelegates a round BEFORE the delegate (D) predicts, so by
  // predict time A is cleanly out of the rate pool AND out of the frozen
  // snapshot. A surviving delegator (B) remains. The intended behavior:
  //   - the predict-round snapshot delegatedPower == B's stake only;
  //   - A earns NOTHING for the predict round (correct — not in the snapshot);
  //   - conservation holds: predictor own-portion + B's credit == total minted,
  //     within rawPower quantization dust and never exceeding.
  //
  // This is the conservation-under-churn case the existing test (clean JOIN)
  // does not reach, and it is deliberately NOT the same-round-undelegate orphan
  // (that is a CONFIRMED bug with its own failing repro, adv_7) — here the
  // undelegate ACTIVATES before the predict, so conservation must hold cleanly.
  // ---------------------------------------------------------------------------
  it("conservation holds when a delegator cleanly undelegates BEFORE the predict round (no orphan, no over-mint)", async function () {
    const { satori, rewards, registry, owner, signers } = await deploySatoriFixtureNoFee();
    const [, D, A, B, voter] = signers;

    await satori.transfer(D.address, ethers.parseEther("10"));
    await satori.transfer(A.address, ethers.parseEther("20"));
    await satori.transfer(B.address, ethers.parseEther("10"));
    await satori.transfer(voter.address, VOTE); // burnt buying the game its weight

    await advanceRound();
    const sid = await makeStream(satori, registry, owner, "S");
    // One burn buys `sid` permanent weight — the old code re-voted every round
    // because weight used to track the voter's balance.
    await voteFor(satori, voter, sid);

    // Both A and B delegate to D.
    await satori.connect(A).delegatePredictionPower(D.address);
    await satori.connect(B).delegatePredictionPower(D.address);
    // Delegator weight is capital x loyalty and a fresh delegation starts at
    // L = 0. B has to carry loyalty into the predict round or the whole
    // delegator share EVAPORATES and the conservation sum below can never
    // balance. A is warmed too, then leaves -- which is the point of the test.
    await warmUpLoyalty(satori, registry, null, D, [A, B], owner, sid);

    // Roll a round so both delegations activate into the rate pool.
    await advanceRound();
    await registry.setValue(sid, 100);

    // A undelegates NOW — a round before D predicts. The close-out subtracts A's
    // effective stake from the pool synchronously (endRound = this round). By the
    // time D predicts next round, A is fully out of BOTH the live pool and the
    // snapshot. This is the CLEAN path (not the same-round orphan).
    await satori.connect(A).delegatePredictionPower(ethers.ZeroAddress);

    // Roll to the predict round.
    await advanceRound();
    await registry.setValue(sid, 100);

    // Live stake now reflects only D's own (10) + B's delegated (10) = 20.
    const stake = await rewards.getPredictionPower(D.address);
    expect(stake).to.equal(ethers.parseEther("20"));

    const R = await satori.getCurrentRound();
    // Marketing bucket DELTA from HERE: the loyalty warm-up is itself a scored
    // round that skims into the same bucket, and the predictor's skim is
    // credited eagerly at settle -- so this must precede the predict.
    const mktStart = await rewards.unclaimedRewards(await rewards.marketingFeeRecipient());
    await satori.connect(D).predictMultipleWithPayloads([{ gameId: sid, payload: pack1(UP) }]);

    // Snapshot must reflect ONLY B's 10 delegated; A is cleanly gone.
    const snap = await rewards.predictionDelegationInfo(D.address, sid, R);
    expect(BigInt(snap.delegatedPower)).to.equal(ethers.parseEther("10"));
    expect(BigInt(snap.ownPower) + BigInt(snap.delegatedPower)).to.equal(stake);

    // Resolve UP and settle.
    await advanceRound();
    await registry.setValue(sid, 110);
    await advanceRound();
    await registry.setValue(sid, 120);

    const settleRcpt = await (await satori.settlePrediction(D.address, sid)).wait();
    const { predictorAmount, delegatorAmount } = sumRewardSplit(settleRcpt, rewards);
    expect(predictorAmount).to.be.gt(0n);

    // The first-predictor bonus is gone: the RewardSplit IS the whole mint for
    // the round.
    const totalMinted = predictorAmount + delegatorAmount;

    async function gain(s) {
      const before = await satori.balanceOf(s.address);
      await satori.connect(s).claim();
      return (await satori.balanceOf(s.address)) - before;
    }
    const dGain = await gain(D);
    const aGain = await gain(A);
    const bGain = await gain(B);

    const dust = totalMinted / 1_000_000n + 1n;

    // Under eager referral credit, EVERY reward credit skims REFERRAL_BPS (5%)
    // at settle/claim time. Neither D nor B has a referral, so both cuts route to
    // MARKETING_FEE_RECIPIENT's own (separately claimable) unclaimed bucket:
    //   - the predictor own-portion cut is credited at settle;
    //   - the delegator-share cut is credited when B claims.
    // Read this bucket AFTER
    // all claims so it captures both cuts, and fold it into the conservation sum
    // so the invariant stays EXACT — documenting exactly where the 5% went.
    const MARKETING = await rewards.marketingFeeRecipient();
    const marketingCut = (await rewards.unclaimedRewards(MARKETING)) - mktStart;

    // INTENDED: A, having cleanly exited before the predict round, earns NOTHING
    // for that round. (A had no winning prediction of its own and is out of the
    // snapshot.) Its claim returns zero.
    expect(aGain).to.equal(0n);

    // INTENDED conservation: predictor own-portion + surviving delegator credit
    // + the referral/marketing skim bucket == total minted, within dust, never
    // exceeding. The 5% is redistributed to marketing, never lost or over-minted.
    const sumParts = dGain + bGain + marketingCut;
    expect(sumParts).to.be.lte(totalMinted);
    expect(totalMinted - sumParts).to.be.lte(dust);

    // The sole surviving delegator B collects the entire delegatorAmount, NET of
    // its own 5% referral skim (the cut went to the marketing bucket above).
    const delegatorNet = delegatorAmount - delegatorAmount * 500n / 10000n;
    expect(bGain).to.be.closeTo(delegatorNet, dust);
  });

  // ---------------------------------------------------------------------------
  // GAP 5 (med) — CAP-RESUME variant the first pass explicitly did NOT cross.
  //
  // The first coverage test kept the round count "well under
  // MAX_DELEGATOR_ROUNDS_PER_CALL = 1024" so a single claim covered the whole
  // window. This test FORCES the cursor across the cap and — crucially — places
  // the single WINNING round BEYOND the first 1024 walked rounds, so a faithful
  // walk MUST hit the cap on the first claim and credit ZERO, then RESUME and
  // credit the late round on the next claim. That is the decisive no-skip proof:
  // a buggy walk that advanced its cursor past unwalked rounds when it capped
  // would skip the late winning round and lose the reward forever.
  //
  // Mechanics: A delegates, then LAPSES ~1100 zero-rate rounds (D makes no
  // prediction). Only AFTER the lapse does D predict + settle, so the sole
  // winning round sits at offset ~1100 in A's open period. A is the SOLE
  // delegator, so the entire RewardSplit delegatorAmount of that one round is
  // owed to A. The first claim walks rounds [start .. start+1023], hits the cap
  // before reaching the winner, and credits 0; the second claim resumes from
  // start+1024, reaches the winner, and credits the full amount.
  // ---------------------------------------------------------------------------
  it("cap-resume: a >1024-round lapsed delegator is credited each round exactly once across the per-call cap (late round not skipped)", async function () {
    const { satori, rewards, registry, owner, signers } = await deploySatoriFixtureNoFee();
    const [, D, A, voter] = signers;
    await satori.transfer(D.address, ethers.parseEther("10"));
    await satori.transfer(A.address, ethers.parseEther("10"));
    await satori.transfer(voter.address, VOTE); // burnt buying the game its weight

    await advanceRound();
    const sid = await makeStream(satori, registry, owner, "S");
    // One burn buys `sid` permanent weight — the old code re-voted every round
    // because weight used to track the voter's balance.
    await voteFor(satori, voter, sid);

    await satori.connect(A).delegatePredictionPower(D.address);
    // A must carry loyalty into the winning round, or the round pays nothing
    // and the cap-resume walk has no credit to resume collecting.
    await warmUpLoyalty(satori, registry, null, D, [A], owner, sid);

    // LAPSE A for well over the per-call cap BEFORE the winning prediction, so
    // the winning round lands beyond the first capped walk. These leading rounds
    // carry a zero delegator rate; the walk must traverse them to reach the
    // winner, which is exactly what forces the cap to fire first.
    await advanceManyRounds(1100);
    await registry.setValue(sid, 100);

    // D predicts the (late) round and it RESOLVES + SETTLES, so the round's
    // delegator rate is final. A is the sole delegator -> the whole
    // delegatorAmount of this round is owed to A.
    await satori.connect(D).predictMultipleWithPayloads([{ gameId: sid, payload: pack1(UP) }]);
    await advanceRound();
    await registry.setValue(sid, 110);
    await advanceRound();
    await registry.setValue(sid, 120);
    const settleRcpt = await (await satori.settlePrediction(D.address, sid)).wait();
    const { delegatorAmount } = sumRewardSplit(settleRcpt, rewards);
    expect(delegatorAmount).to.be.gt(0n);

    // First one-shot claim: the walk hits the cap at 1024 rounds — BEFORE the
    // winning round at offset ~1100 — so it credits ZERO and banks its cursor.
    const a0 = await satori.balanceOf(A.address);
    await satori.connect(A).claim();
    const first = (await satori.balanceOf(A.address)) - a0;
    expect(first).to.equal(0n); // capped before reaching the late winner

    // Resume: subsequent claims pick up from the cursor. Keep claiming until the
    // window fully drains; each call walks at most another 1024 rounds.
    let total = first;
    let credited = false;
    for (let i = 0; i < 5; i++) {
      const before = await satori.balanceOf(A.address);
      await satori.connect(A).claim();
      const delta = (await satori.balanceOf(A.address)) - before;
      total += delta;
      if (delta > 0n) credited = true;
      if (delta === 0n && credited) break; // fully drained after crediting
    }

    // INTENDED: the late winning round is credited EXACTLY once on resume — no
    // skip across the cap boundary (would lose it entirely) and no double-credit
    // (would exceed). Cumulative credit equals the single owed delegator amount,
    // NET of the eager 5% referral skim: A is the sole delegator with no referral,
    // so 5% of the accrued share is diverted to MARKETING_FEE_RECIPIENT at claim
    // and A receives the remaining 95%. The exactly-once, no-skip guarantee is
    // unchanged — only the delivered amount is netted.
    const delegatorNet = delegatorAmount - delegatorAmount * 500n / 10000n;
    expect(credited).to.equal(true);
    expect(total).to.be.closeTo(delegatorNet, ethers.parseEther("0.001"));

    // A final claim with the cursor fully drained must credit exactly zero,
    // proving the cursor advanced past the whole window with no replayable
    // residue and no re-credit of the winning round.
    const aMid = await satori.balanceOf(A.address);
    await satori.connect(A).claim();
    const tail = (await satori.balanceOf(A.address)) - aMid;
    expect(tail).to.equal(0n);
  });
});
