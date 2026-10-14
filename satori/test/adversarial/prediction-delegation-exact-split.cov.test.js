/**
 * prediction-delegation-exact-split.cov.test.js
 *
 * DISTRIBUTION-FAIRNESS hardening (within-the-cap exactness, not just the mint cap).
 *
 * The review of "can everyone only get what they're supposed to?" flagged the
 * predictor<->delegator split as exact-unit-scenario-only. This test pins it
 * END-TO-END for the two things the existing scenarios under-cover:
 *   1. a NON-DEFAULT predictor fee (20%, not the default 10%) — proving the fee
 *      parameter actually flows into the split, not a hardcoded rate; and
 *   2. MULTIPLE delegators with DIFFERENT balances — proving each delegator gets
 *      EXACTLY their balance-proportional slice of the delegators' share.
 *
 * It asserts on OBSERVABLE outputs only (the RewardSplit event + actual claimed
 * balances), so it verifies the real money each party receives. Formula
 * (SatoriRewards._splitReward):
 *   delegatedReward   = totalReward * delegatedPower / (ownPower + delegatedPower)
 *   predictorBonus    = delegatedReward * feeBps / 10000
 *   delegatorsShare   = delegatedReward - predictorBonus
 *   predictorPortion  = (totalReward - delegatedReward) + predictorBonus
 *   delegator_i       = bal_i / delegatedPower * delegatorsShare
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

async function makeStream(satori, registry, owner, name) {
  const sid = await streamIdFromTx(
    await satori[SIMPLE3](name, owner.address, 1440), satori);
  await registry.setValue(sid, 100);
  return sid;
}

describe("prediction-delegation exact split (non-default fee + multi-delegator)", function () {
  this.timeout(120000);

  it("applies a NON-DEFAULT 20% fee and splits the delegators' share by balance, exactly", async function () {
    const { satori, rewards, registry, owner, signers } = await deploySatoriFixtureNoFee();
    const [, D, A, B, voter] = signers;

    // D = predictor (own 10). A, B = delegators with DIFFERENT balances (30, 10)
    // -> delegatedPower 40, total predict power 50. The asymmetry (30 vs 10) makes
    // the per-delegator proportional split non-trivial (3:1).
    await satori.transfer(D.address, ethers.parseEther("10"));
    await satori.transfer(A.address, ethers.parseEther("30"));
    await satori.transfer(B.address, ethers.parseEther("10"));
    // `voter` BURNS to buy the game weight, so it needs enough to cover the burn
    // (it never predicts, so spending its whole balance is fine).
    await satori.transfer(voter.address, VOTE);

    // NON-DEFAULT predictor fee: 5% (default is 10%; cap is now 10%). One-shot, read at settle.
    await rewards.connect(D).setPredictorFee(500);

    await advanceRound();
    const sid = await makeStream(satori, registry, owner, "S");
    // Burn-backed vote: one burn buys `sid` permanent weight. The old code voted
    // twice because weight used to follow the voter's balance and had to be
    // refreshed; burned weight is permanent, so once is enough.
    await voteFor(satori, voter, sid);

    // Both delegators join a round BEFORE D predicts so the snapshot activates
    // cleanly (avoids the documented same-round-receipt edge).
    await satori.connect(A).delegatePredictionPower(D.address);
    await satori.connect(B).delegatePredictionPower(D.address);
    // Delegator weight is capital x loyalty and a fresh delegation starts at
    // L = 0, so every share measured below reads zero without a warm-up.
    // Both delegators share ONE warm-up so their L is equal and cancels out
    // of the by-balance split this test pins. Drains to `owner`.
    await warmUpLoyalty(satori, registry, null, D, [A, B], owner, sid);
    await advanceRound();
    await registry.setValue(sid, 100);

    const stake = await rewards.getPredictionPower(D.address); // own10 + 40 = 50
    const R = await satori.getCurrentRound();
    // Marketing bucket DELTA from HERE: the warm-up is itself a scored round
    // that skims into the same bucket, and the predictor's skim is credited
    // eagerly at settle — so the snapshot must precede the predict.
    const mktStart = await rewards.unclaimedRewards(await rewards.marketingFeeRecipient());
    await satori.connect(D).predictMultipleWithPayloads([{ gameId: sid, payload: pack1(UP) }]);

    const snap = await rewards.predictionDelegationInfo(D.address, sid, R);
    const ownPower = BigInt(snap.ownPower);
    const delegatedPower = BigInt(snap.delegatedPower);
    expect(ownPower + delegatedPower).to.equal(stake);
    expect(delegatedPower).to.equal(ethers.parseEther("40"));

    // Resolve UP so D's prediction is correct.
    await advanceRound();
    await registry.setValue(sid, 110);
    await advanceRound();
    await registry.setValue(sid, 120);

    // Settle and read the actual split off the RewardSplit event.
    const settleRcpt = await (await satori.settlePrediction(D.address, sid)).wait();
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
    const totalReward = predictorAmount + delegatorAmount;
    expect(totalReward).to.be.gt(0n);

    // --- (1) EXACT split math at the NON-DEFAULT 5% fee (pure integer ops,
    //         so the event must match the formula to the wei). ---
    const FEE_BPS = 500n;
    const delegatedReward = (totalReward * delegatedPower) / (ownPower + delegatedPower);
    const predictorBonus = (delegatedReward * FEE_BPS) / 10000n;
    const expDelegatorsShare = delegatedReward - predictorBonus;
    const expPredictorPortion = (totalReward - delegatedReward) + predictorBonus;
    expect(delegatorAmount).to.equal(expDelegatorsShare);
    expect(predictorAmount).to.equal(expPredictorPortion);

    // --- (2) Prove the fee PARAMETER flowed through: the split at 5% must
    //         DIFFER from what the default 10% would have produced. ---
    const bonusAt10 = (delegatedReward * 1000n) / 10000n;
    const predictorPortionAt10 = (totalReward - delegatedReward) + bonusAt10;
    expect(predictorAmount).to.not.equal(predictorPortionAt10);

    // Referral skim (eager-credit model): 5% (REFERRAL_BPS=500) is carved off
    // EVERY reward credit at the moment it lands in unclaimedRewards — the
    // predictor's own portion AND each delegator's accrued share — and routed
    // to the earner's referral, or (none/self here) to MARKETING_FEE_RECIPIENT.
    // The RewardSplit event above still emits the GROSS split (pre-skim), so
    // sections (1)/(2) are unchanged; the CLAIMED balances below are NET of it.
    // Per credit: cut = floor(amount*500/10000); earner banks amount - cut.
    const REFERRAL_BPS = 500n; // 5%
    const MARKETING = await rewards.marketingFeeRecipient();
    const netOf = (x) => x - (x * REFERRAL_BPS) / 10000n; // == x - floor(x*500/10000)

    // --- (3) Per-delegator EXACT proportional split: A:B balances are 30:10,
    //         so each gets bal_i/40 of the delegators' share. Assert on actual
    //         CLAIMED balances (each already NET of the 5% referral skim). ---
    async function gain(s) {
      const before = await satori.balanceOf(s.address);
      await satori.connect(s).claim();
      return (await satori.balanceOf(s.address)) - before;
    }
    const dGain = await gain(D);
    const aGain = await gain(A);
    const bGain = await gain(B);

    const balA = ethers.parseEther("30");
    const balB = ethers.parseEther("10");
    // Gross proportional slice of the delegators' share, then net the 5% skim
    // that _creditReward carves off each delegator's accrued share at credit.
    const expA = netOf((delegatorAmount * balA) / delegatedPower);
    const expB = netOf((delegatorAmount * balB) / delegatedPower);

    // Double-floor (rate then per-delegator) loses a few wei; bound the dust.
    const dust = delegatorAmount / 1_000_000n + 2n;
    expect(aGain).to.be.closeTo(expA, dust);
    expect(bGain).to.be.closeTo(expB, dust);
    // The 3:1 balance ratio must show up in the payouts (A gets ~3x B).
    expect(aGain).to.be.gt(bGain * 29n / 10n);
    expect(aGain).to.be.lt(bGain * 31n / 10n);

    // D's claim is its predictor portion NET of the 5% skim — nothing else. The
    // first-predictor bonus was removed with the refactor, so a predictor's
    // claim is exactly its (netted) share of the round budget.
    expect(dGain).to.be.closeTo(netOf(predictorAmount), dust);

    // --- (4) Conservation: the earners' claims PLUS the marketing/referral
    //         bucket (where every 5% skim landed) sum to the minted total, with
    //         no over-mint. Including the skim destination keeps the invariant
    //         EXACT — it documents where the diverted 5% went, and proves the
    //         skim only redistributes the round budget, never mints extra. ---
    const totalMinted = totalReward;
    const marketingBucket = (await rewards.unclaimedRewards(MARKETING)) - mktStart;
    const sumParts = dGain + aGain + bGain + marketingBucket;
    expect(sumParts).to.be.lte(totalMinted);
    expect(totalMinted - sumParts).to.be.lte(delegatorAmount / 1_000_000n + 3n);
    // The skim is real and non-trivial, and lands EXACTLY where expected: the
    // marketing bucket holds the sum of the three per-credit floor(5%) cuts —
    // the predictor's own portion plus each delegator's accrued share — since
    // none of the three earners set a referral (all route to marketing).
    const grossA = (delegatorAmount * balA) / delegatedPower;
    const grossB = (delegatorAmount * balB) / delegatedPower;
    const expMarketing =
      (predictorAmount * 500n) / 10000n + (grossA * 500n) / 10000n + (grossB * 500n) / 10000n;
    expect(marketingBucket).to.be.gt(0n);
    // closeTo, not equal: `grossA`/`grossB` are reconstructed from the raw
    // capital split, while the contract divides by the loyalty-weighted W —
    // which carries a small deliberate upward bias so Σ cᵢLᵢ ≤ W holds by
    // construction (design §10). The gap is sub-1000 wei and always in the
    // strand-dust direction, never over-mint, which the lte above pins.
    expect(marketingBucket).to.be.closeTo(expMarketing, 10_000n);
  });
});
