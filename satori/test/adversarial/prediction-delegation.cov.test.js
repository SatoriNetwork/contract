/**
 * prediction-delegation.cov.test.js
 *
 * Adversarial COVERAGE for the prediction-delegation subsystem.
 *
 * These tests assert the DOCUMENTED INTENDED behavior from
 * docs/narratives/A_prediction_delegation.md for the high/med-priority
 * coverage gaps in adversarial-findings/_raw_review.json.
 *
 * Two prediction-delegation bugs are ALREADY confirmed and have failing
 * repros under adversarial-findings/ (adv_6, adv_7) plus a related
 * same-round-receipt checkpoint bug (adv_15). Both center on a single
 * trigger: a token RECEIPT to a delegator in the SAME round their delegate
 * predicts (live di.power moves immediately, the deferred _delegatePowerForRate
 * does not). To exercise the INTENDED single-quantity behavior without
 * tripping those known bugs, every scenario here either (a) avoids same-round
 * receipts entirely, or (b) lets the receipt ACTIVATE a round before the
 * predict (the narrative-consistent frame). The tests then assert the
 * invariants the narrative promises: stake == snapshot total at predict time,
 * weight-proportional pool slices between competing predictors, and
 * Sum(predictor own-portion + every delegator credit) == totalReward.
 */

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixtureNoFee, pack1, VOTE, voteFor, warmUpLoyalty } = require("../fixtures");

const UP = 1;
// The value-provider cut is gone, so stream creation no longer takes a cut-bps
// argument: the 3-arg (name, provider, minCadenceRounds) overload is the one.
const SIMPLE3 = "createSimpleDataStream(string,address,uint24)";

async function advanceRound() {
  const currentTime = await time.latest();
  const nextMidnight = Math.floor(currentTime / 86400) * 86400 + 86400;
  await time.increaseTo(nextMidnight + 1);
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

// Drive a binary stream UP across two post-predict updates so a UP
// prediction resolves correct. Caller settles afterwards.
async function makeStream(satori, registry, owner, name) {
  const sid = await streamIdFromTx(
    await satori[SIMPLE3](name, owner.address, 1440), satori);
  await registry.setValue(sid, 100);
  return sid;
}

describe("prediction-delegation coverage (intended behavior)", function () {
  this.timeout(120000);

  // ---------------------------------------------------------------------------
  // GAP 4 (high): getPredictionPower(delegate) == ownPower + delegatedPower
  // stored in the predict-time snapshot. The narrative defines ONE quantity
  // (delegatedPredictionPower[delegate]) that is BOTH the committed stake AND
  // the split denominator. In a clean sequence (no same-round receipt) the
  // live stake the delegate predicts with MUST equal the frozen snapshot total.
  // ---------------------------------------------------------------------------
  it("predict-time stake equals the frozen (ownPower + delegatedPower) snapshot (clean delegation)", async function () {
    const { satori, rewards, registry, owner, signers } = await deploySatoriFixtureNoFee();
    const [, delegate, dA, dB, voter] = signers;

    await satori.transfer(delegate.address, ethers.parseEther("10"));
    await satori.transfer(dA.address, ethers.parseEther("10"));
    await satori.transfer(dB.address, ethers.parseEther("10"));
    await satori.transfer(voter.address, VOTE); // burnt buying the game its weight

    await advanceRound();
    const sid = await makeStream(satori, registry, owner, "S");
    await voteFor(satori, voter, sid);

    // Two delegators delegate to `delegate`. No same-round receipts after this.
    await satori.connect(dA).delegatePredictionPower(delegate.address);
    await satori.connect(dB).delegatePredictionPower(delegate.address);

    // Roll a round so any deferred activation folds in; nothing is in flight.
    await advanceRound();
    await registry.setValue(sid, 100);

    // Capture the LIVE stake the protocol will commit, right before predict.
    const liveStake = await rewards.getPredictionPower(delegate.address);

    const R = await satori.getCurrentRound();
    await satori.connect(delegate).predictMultipleWithPayloads([{ gameId: sid, payload: pack1(UP) }]);

    // Read the frozen snapshot captured at predict time.
    const snap = await rewards.predictionDelegationInfo(delegate.address, sid, R);
    const snapTotal = BigInt(snap.ownPower) + BigInt(snap.delegatedPower);

    // INTENDED single-quantity invariant: the power that WINS the pool slice
    // (liveStake -> weight) is the SAME power that DIVIDES the reward
    // (ownPower + delegatedPower). They must agree at predict time.
    expect(snapTotal).to.equal(liveStake);
    // And the delegated portion equals exactly the sum of the two delegations.
    expect(BigInt(snap.delegatedPower)).to.equal(ethers.parseEther("20"));
  });

  // ---------------------------------------------------------------------------
  // GAP 4 (high) continued: the single-quantity invariant must also hold across
  // an ACTIVATED token receipt to a delegator. A receipt that lands a round
  // BEFORE the delegate predicts is the narrative-consistent frame: it folds
  // into BOTH the live di.power AND the deferred _delegatePowerForRate before
  // predict time, so getPredictionPower == ownPower + delegatedPower still
  // holds and the receipt's power is fully recognized in the snapshot. (The
  // SAME-round receipt path is the known bug, covered by adv_6; this asserts
  // the clean activated path behaves per intent.)
  // ---------------------------------------------------------------------------
  it("activated receipt to a delegator is fully recognized in the predict-time snapshot", async function () {
    const { satori, rewards, registry, owner, signers } = await deploySatoriFixtureNoFee();
    const [, D, A, voter, sender] = signers;
    await satori.transfer(D.address, ethers.parseEther("10"));
    await satori.transfer(A.address, ethers.parseEther("10"));
    await satori.transfer(voter.address, VOTE); // burnt buying the game its weight
    await satori.transfer(sender.address, ethers.parseEther("5"));

    await advanceRound();
    const sid = await makeStream(satori, registry, owner, "S");
    await voteFor(satori, voter, sid);

    await satori.connect(A).delegatePredictionPower(D.address);

    // Receipt to the (delegated) A one round BEFORE D predicts.    // Delegator weight is capital x loyalty and a fresh delegation starts at
    // L = 0, so every credit measured below reads zero without a warm-up.
    // Drains to `owner`, who holds the untouched remainder of supply.
    await warmUpLoyalty(satori, registry, null, D, [A], owner, sid);

    // Receipt to the (delegated) A one round BEFORE D predicts. Receiving while
    // delegated is allowed (only the sender side is lock-checked). The increment
    // is deferred to today+1 and activates on the next round's flush.
    await satori.connect(sender).transfer(A.address, ethers.parseEther("5"));

    // Roll a round so the deferred activation folds into BOTH trackers.
    await advanceRound();
    await registry.setValue(sid, 100);

    const liveStake = await rewards.getPredictionPower(D.address); // own10 + 15
    expect(liveStake).to.equal(ethers.parseEther("25"));

    const R = await satori.getCurrentRound();
    await satori.connect(D).predictMultipleWithPayloads([{ gameId: sid, payload: pack1(UP) }]);

    const snap = await rewards.predictionDelegationInfo(D.address, sid, R);
    // INTENDED single-quantity invariant under an activated receipt: the live
    // committed stake equals the frozen snapshot total, and the delegated
    // portion fully includes the activated receipt (10 + 5 = 15).
    expect(BigInt(snap.ownPower) + BigInt(snap.delegatedPower)).to.equal(liveStake);
    expect(BigInt(snap.delegatedPower)).to.equal(ethers.parseEther("15"));
  });

  // ---------------------------------------------------------------------------
  // GAP 1 (high): two COMPETING predictors on the same game/round split the
  // pool by weight. With no same-round receipts, each predictor's snapshot
  // total equals the live stake that earned their weight, so the pool slice is
  // weight-proportional AND each delegator is paid their full snapshot share.
  // (The single-predictor existing tests cannot see weight effects because the
  //  lone predictor takes 100% of the pool regardless of weight.)
  // ---------------------------------------------------------------------------
  it("competing predictors split the pool by committed power; delegator credits match snapshots (no churn)", async function () {
    const { satori, rewards, registry, owner, signers } = await deploySatoriFixtureNoFee();
    // P keeps 0% bonus so delegators take the whole delegated portion.
    // NOTE: the predictor-fee encoding is a default-swap involution
    // (_effectivePredictorFee): setPredictorFee(0) STORES the explicit-zero
    // sentinel (1000) which DECODES back to an effective 0% — so passing 0 is
    // how a predictor declares "delegators take 100% of the delegated portion".
    // (Passing 1000 would store 0 = the untouched default = effective 10%.)
    const [, P, Q, A, B, voter] = signers;
    await rewards.connect(P).setPredictorFee(0); // effective 0%
    await rewards.connect(Q).setPredictorFee(0); // effective 0%

    // P own 10, delegator A delegates 30 -> P committed 40.
    // Q own 10, delegator B delegates 10 -> Q committed 20.
    await satori.transfer(P.address, ethers.parseEther("10"));
    await satori.transfer(Q.address, ethers.parseEther("10"));
    await satori.transfer(A.address, ethers.parseEther("30"));
    await satori.transfer(B.address, ethers.parseEther("10"));
    await satori.transfer(voter.address, VOTE); // burnt buying the game its weight

    await advanceRound();
    const sid = await makeStream(satori, registry, owner, "S");
    await voteFor(satori, voter, sid);

    await satori.connect(A).delegatePredictionPower(P.address);
    await satori.connect(B).delegatePredictionPower(Q.address);
    // Delegator weight is capital x loyalty and a fresh delegation starts at
    // L = 0, so every credit measured below reads zero without a warm-up.
    // Drains to `owner`, who holds the untouched remainder of supply.
    await warmUpLoyalty(satori, registry, null, P, [A], owner, sid);
    await warmUpLoyalty(satori, registry, null, Q, [B], owner, sid);

    // Settle delegations into the rate pool a round before predicting.
    await advanceRound();
    await registry.setValue(sid, 100);

    const pStake = await rewards.getPredictionPower(P.address); // 40
    const qStake = await rewards.getPredictionPower(Q.address); // 20
    expect(pStake).to.equal(ethers.parseEther("40"));
    expect(qStake).to.equal(ethers.parseEther("20"));

    const R = await satori.getCurrentRound();
    await satori.connect(P).predictMultipleWithPayloads([{ gameId: sid, payload: pack1(UP) }]);
    await satori.connect(Q).predictMultipleWithPayloads([{ gameId: sid, payload: pack1(UP) }]);

    // Snapshot totals must match the live stake that earned the weight.
    const snapP = await rewards.predictionDelegationInfo(P.address, sid, R);
    const snapQ = await rewards.predictionDelegationInfo(Q.address, sid, R);
    expect(BigInt(snapP.ownPower) + BigInt(snapP.delegatedPower)).to.equal(pStake);
    expect(BigInt(snapQ.ownPower) + BigInt(snapQ.delegatedPower)).to.equal(qStake);

    // Resolve UP and settle.
    await advanceRound();
    await registry.setValue(sid, 110);
    await advanceRound();
    await registry.setValue(sid, 120);
    await satori.settlePrediction(P.address, sid);
    await satori.settlePrediction(Q.address, sid);

    // Total reward minted to each predictor's "team" = own credit + delegator
    // credits. Capture via claim deltas.
    async function gain(s) {
      const before = await satori.balanceOf(s.address);
      await satori.connect(s).claim();
      return (await satori.balanceOf(s.address)) - before;
    }
    const pOwn = await gain(P);
    const qOwn = await gain(Q);
    const aGain = await gain(A);
    const bGain = await gain(B);

    const pTeam = pOwn + aGain;
    const qTeam = qOwn + bGain;

    // INTENDED: pool slices are proportional to committed power 40 : 20 = 2 : 1.
    // Compare the ratio of the two teams' total realized rewards.
    expect(pTeam).to.be.gt(0n);
    expect(qTeam).to.be.gt(0n);
    // pTeam / qTeam ~= 2 (tolerance 1% of qTeam scaled).
    const ratioNum = (pTeam * 1000n) / qTeam;
    expect(ratioNum).to.be.closeTo(2000n, 30n); // 2.0 +/- 0.03

    // With P's effective fee 0, P keeps own/total of P's slice = 10/40 = 25%.
    // A (delegated 30/40) gets 75% of P's slice. Assert that split ratio.
    const aOverTeam = (aGain * 1000n) / pTeam;
    expect(aOverTeam).to.be.closeTo(750n, 5n); // 75% +/- 0.5%
    const pOwnOverTeam = (pOwn * 1000n) / pTeam;
    expect(pOwnOverTeam).to.be.closeTo(250n, 5n); // 25% +/- 0.5%
  });

  // ---------------------------------------------------------------------------
  // GAP 3 (med): conservation across a round with a mid-round JOIN (a clean
  // churn that activates next round). Sum(predictor own-portion credited) +
  // Sum(every delegator credit) == totalReward minted for that round.
  // A late joiner (delegated mid-round-before, predict next round) is the
  // narrative-consistent activation path and must NOT orphan or over-mint.
  // ---------------------------------------------------------------------------
  it("conservation: predictor own-portion + Sum(delegator credits) == total reward (clean join)", async function () {
    const { satori, rewards, registry, owner, signers } = await deploySatoriFixtureNoFee();
    const [, D, A, B, voter] = signers;
    // Use the DEFAULT predictor fee (effective 10%) so the predictor's bonus
    // path is also exercised in the conservation sum.
    await satori.transfer(D.address, ethers.parseEther("10"));
    await satori.transfer(A.address, ethers.parseEther("20"));
    await satori.transfer(B.address, ethers.parseEther("10"));
    await satori.transfer(voter.address, VOTE); // burnt buying the game its weight

    await advanceRound();
    const sid = await makeStream(satori, registry, owner, "S");
    await voteFor(satori, voter, sid);

    // A and B both delegate BEFORE the warm-up. This test's subject is the
    // stake-proportional 2:1 split between them, and loyalty only cancels
    // out of that ratio when both carry the SAME L — which means both must
    // be present for the same warm-up. (Late-joiner behaviour has its own
    // dedicated coverage in the H1 probes.)
    await satori.connect(A).delegatePredictionPower(D.address);
    await advanceRound();
    await registry.setValue(sid, 100);

    await satori.connect(B).delegatePredictionPower(D.address);
    await warmUpLoyalty(satori, registry, null, D, [A, B], owner, sid);
    await advanceRound();
    await registry.setValue(sid, 100);

    const stake = await rewards.getPredictionPower(D.address); // own10 + 30 = 40
    const R = await satori.getCurrentRound();
    // Marketing bucket DELTA from here, not its absolute value: the loyalty
    // warm-up above is itself a scored round and skims into the same bucket,
    // so an absolute read carries that in and the conservation sum over-counts.
    const marketingStart = await rewards.unclaimedRewards(await rewards.marketingFeeRecipient());
    await satori.connect(D).predictMultipleWithPayloads([{ gameId: sid, payload: pack1(UP) }]);

    const snap = await rewards.predictionDelegationInfo(D.address, sid, R);
    expect(BigInt(snap.ownPower) + BigInt(snap.delegatedPower)).to.equal(stake);

    // Capture the total reward credited for this prediction via RewardSplit.
    await advanceRound();
    await registry.setValue(sid, 110);
    await advanceRound();
    await registry.setValue(sid, 120);

    const settleTx = await satori.settlePrediction(D.address, sid);
    const settleRcpt = await settleTx.wait();
    let predictorAmount = 0n, delegatorAmount = 0n;
    for (const log of settleRcpt.logs) {
      try {
        const p = rewards.interface.parseLog(log);
        if (p && p.name === "RewardSplit") {
          predictorAmount += BigInt(p.args.predictorAmount);
          delegatorAmount += BigInt(p.args.delegatorAmount);
        }
      } catch (e) {}
    }
    // The first-predictor bonus is gone, so the RewardSplit IS the whole mint
    // for the round: nothing is credited outside it.
    const totalReward = predictorAmount + delegatorAmount;
    const totalMinted = totalReward;
    expect(totalReward).to.be.gt(0n);

    // Claim everyone.
    async function gain(s) {
      const before = await satori.balanceOf(s.address);
      await satori.connect(s).claim();
      return (await satori.balanceOf(s.address)) - before;
    }
    const dGain = await gain(D);
    const aGain = await gain(A);
    const bGain = await gain(B);

    // Referral-eager-credit model: 5% (REFERRAL_BPS) is skimmed from EVERY
    // reward credit at settle time — the predictor's own portion AND each
    // delegator's accrued share. None of D/A/B set a referral, so all three
    // skims land in the MARKETING_FEE_RECIPIENT unclaimed bucket. That bucket
    // is claimable by marketing separately and is NOT minted into any of the
    // three earners' balances, so it must be included in the conservation sum
    // for the round budget to still be fully accounted.
    const marketing = await rewards.marketingFeeRecipient();
    const marketingBucket = (await rewards.unclaimedRewards(marketing)) - marketingStart;

    // INTENDED conservation: the predictor's own-portion plus every delegator's
    // claimed credit PLUS the marketing bucket that received every earner's 5%
    // skim equals the total minted for the round, within rawPower quantization
    // dust, and never exceeds it.
    const sumParts = dGain + aGain + bGain + marketingBucket;
    // Allow small positive dust loss (orphaned quantization remainder) but no
    // over-mint. Bound the loss to a tiny fraction of the reward.
    const dust = totalMinted / 1_000_000n + 1n;
    expect(sumParts).to.be.lte(totalMinted);
    expect(totalMinted - sumParts).to.be.lte(dust);

    // Delegators (A 20 + B 10 = 30 of 40 total) get 90% of the delegated
    // portion; predictor keeps own (10/40) + 10% of delegated portion.
    // RewardSplit.delegatorAmount is the GROSS delegated share (pre-skim); each
    // delegator's claimed credit is net of its own 5% skim, so the combined
    // net credit plus the delegated portion's skim reconstructs the gross.
    // Reconstruct the gross by netting delegatorAmount the same way.
    const delegatorNet = delegatorAmount - delegatorAmount * 500n / 10000n;
    expect(aGain + bGain).to.be.closeTo(delegatorNet, dust);
    // A:B credit ratio == their stake ratio 20:10 = 2:1 (the per-earner skim is
    // proportional, so the ratio is preserved).
    expect((aGain * 1000n) / bGain).to.be.closeTo(2000n, 5n);
  });

  // ---------------------------------------------------------------------------
  // GAP 5 (med): a delegator who lapses for a long stretch (many rounds with
  // active per-round rate) and claims in one shot must be credited each round
  // exactly once. We assert the cumulative credit equals an independent
  // reference (Sum over the active rounds of balance*rate). This exercises the
  // multi-round walk + cursor advancement without double-credit or skips.
  //
  // We keep the round count modest (well under MAX_DELEGATOR_ROUNDS_PER_CALL =
  // 1024) so a single claim covers the whole window; the assertion is the
  // per-round-exactly-once property the cap path is built to preserve.
  // ---------------------------------------------------------------------------
  it("multi-round lapsed delegator is credited each active round exactly once (no double-credit, no skip)", async function () {
    const { satori, rewards, registry, owner, signers } = await deploySatoriFixtureNoFee();
    const [, D, A, voter] = signers;
    await satori.transfer(D.address, ethers.parseEther("10"));
    await satori.transfer(A.address, ethers.parseEther("10"));
    await satori.transfer(voter.address, VOTE); // burnt buying the game its weight

    await advanceRound();
    const sid = await makeStream(satori, registry, owner, "S");
    await voteFor(satori, voter, sid);

    await satori.connect(A).delegatePredictionPower(D.address);
    // Warm A's loyalty before the measured window. Without it the first
    // LOY_LAG+1 rounds have A at L = 0, so their delegator share EVAPORATES
    // -- the RewardSplit reference sum would then include amounts nobody
    // can receive and could never equal A's one-shot claim.
    await warmUpLoyalty(satori, registry, null, D, [A], owner, sid);
    await advanceRound();
    await registry.setValue(sid, 100);

    // D predicts in N separate rounds; A never claims in between (lapses).
    // A is the SOLE delegator, so for every round D wins, the ENTIRE
    // RewardSplit delegatorAmount is owed to A. We accumulate those per-round
    // delegator amounts as an independent reference, then assert A's single
    // one-shot lapsed claim credits EXACTLY that sum (every active round once).
    //
    // (We deliberately do NOT compare against a "claim every round" variant:
    //  claiming mid-window credits A's rewards into A's balance, which — A
    //  being a delegator — raises D's live delegated power for LATER rounds and
    //  changes those rounds' splits. That is correct compounding, not a walk
    //  discrepancy. The walk's own correctness is: Σ per-round delegatorAmount
    //  == one-shot credit, with A's balance held constant across the window.)
    const N = 3;
    let v = 100;
    let delegSplitSum = 0n;
    for (let i = 0; i < N; i++) {
      await satori.connect(D).predictMultipleWithPayloads([{ gameId: sid, payload: pack1(UP) }]);
      // Resolve this prediction UP across two updates, then settle it so the
      // per-round rate is written.
      await advanceRound();
      v += 10; await registry.setValue(sid, v);
      await advanceRound();
      v += 10; await registry.setValue(sid, v);
      const st = await (await satori.settlePrediction(D.address, sid)).wait();
      for (const log of st.logs) {
        try {
          const p = rewards.interface.parseLog(log);
          if (p && p.name === "RewardSplit") delegSplitSum += BigInt(p.args.delegatorAmount);
        } catch (e) {}
      }
    }
    expect(delegSplitSum).to.be.gt(0n);

    // One-shot lapsed claim across all N rounds. Capture the marketing bucket
    // across the claim so we can attribute the 5% skim that A's claim diverts.
    const marketing = await rewards.marketingFeeRecipient();
    const mktBefore = await rewards.unclaimedRewards(marketing);
    const aBefore = await satori.balanceOf(A.address);
    await satori.connect(A).claim();
    const aFirst = (await satori.balanceOf(A.address)) - aBefore;
    const skimFromA = (await rewards.unclaimedRewards(marketing)) - mktBefore;

    // INTENDED: every active round credited exactly once -> A's lapsed claim
    // equals the full sum of per-round delegator amounts (A is sole delegator),
    // NET of the referral-eager-credit 5% skim. The delegator's accrued share
    // is credited through _creditReward at claim, which diverts 5% to A's
    // referral or — since A has none — to MARKETING_FEE_RECIPIENT. The skim is
    // applied once on the aggregated multi-round accrual (sumAccrued), so the
    // expected net is delegSplitSum minus floor(delegSplitSum*500/10000). The tiny
    // tolerance still absorbs per-round rate quantization dust; it does NOT hide
    // the (much larger) skim, which is netted out of the expected value.
    const delegSplitNet = delegSplitSum - delegSplitSum * 500n / 10000n;
    expect(aFirst).to.be.closeTo(delegSplitNet, ethers.parseEther("0.001"));

    // Conservation: the 5% diverted from A's claim to the marketing bucket plus
    // A's net credit reconstructs the full gross delegator sum (A is the sole
    // delegator, so it is owed the entire per-round delegatorAmount each round).
    expect(aFirst + skimFromA).to.be.closeTo(delegSplitSum, ethers.parseEther("0.001"));

    // Second claim with no new activity must credit exactly zero — proves the
    // cursor advanced and no round is double-credited.
    const aMid = await satori.balanceOf(A.address);
    await satori.connect(A).claim();
    const aSecond = (await satori.balanceOf(A.address)) - aMid;
    expect(aSecond).to.equal(0n);
  });
});
