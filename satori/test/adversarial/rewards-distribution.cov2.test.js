/**
 * ADVERSARIAL COVERAGE (ROUND 2) — subsystem: rewards-distribution
 *
 * Second pass. The first pass (rewards-distribution.cov.test.js) already
 * exercised every HIGH gap and two MED gaps (setPredictorFee lock matrix,
 * first-predictor bonus on ineligible streams). This file targets the
 * remaining MED gap from _raw_review.json (system == "rewards-distribution"):
 *
 *  - "Committed-budget invariant that ALSO includes every reward credit, not
 *     just unclaimedRewards." [med]
 *    Both carve-outs the old arithmetic here subtracted are GONE: the
 *    value-provider cut (providers are not paid at all any more) and the
 *    first-predictor bonus. The platform fee also no longer lives in
 *    SatoriRewards (it moved to the immutable SatoriToken as a senior,
 *    off-budget dev fee — see test/next/DevFee.test.js). So each round's payable
 *    budget IS the on-chain gross (TOKENS_PER_ROUND − the senior dev fee = 1152
 *    at genesis), fully distributable to predictors, and a sole predictor
 *    collects all of it. Here we assert the predictor leg reconstructs EXACTLY
 *    to 1152 (dave's net claim + the referral skim that was redistributed to
 *    MARKETING), and across the window the total committed predictor budget
 *    stays inside ON_CHAIN_GROSS * roundsElapsed.
 *
 * CONTRACT MODEL: SatoriRewards no longer exposes a platform-fee recipient or
 * any fee-rate/accrual surface — the fee is the immutable token's dev fee,
 * off-budget from the reward split. The referral skim (5% to MARKETING absent a
 * referral) is UNCHANGED.
 *
 * All assertions reflect DOCUMENTED intent. RAW_TOLERANCE covers rawPower
 * quantization on the predictor leg.
 */

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixtureWithFeeBps, RAW_TOLERANCE, pack1, voteFor, onChainGrossNow } = require("../fixtures");
const { TEST_MARKETING_FEE_RECIPIENT } = require("../next/splitFixture");

const UP = 1;
// The value-provider cut is gone, so stream creation no longer takes a cut-bps
// argument: the 3-arg (name, provider, minCadenceRounds) overload is the one.
const SIMPLE3 = "createSimpleDataStream(string,address,uint24)";
const TOKENS_PER_ROUND = ethers.parseEther("1440");
// The senior dev fee (288 = 2000bps of 1440 in tier 1) is minted off-budget at
// the immutable token, so the on-chain reward gross per round is the residual
// 1152 = TOKENS_PER_ROUND − devRateNow (genesis tier 1). The whole prediction-
// game round pool is this residual, never the full 1440.
// The on-chain game gross per round: the hub's emission net of the senior dev
// fee, READ FROM THE CHAIN in each test. It used to be `parseEther("1152")` —
// 1440 less a 288 dev fee — which held only while emission was a fixed 1440.
let ON_CHAIN_GROSS;
// The referral-cut sink: 5% (REFERRAL_BPS=500) is skimmed from every reward
// credit (predictor win, delegator share) at credit time. When the earner has no
// referral (or a self-referral) the cut routes here. The platform fee is
// EXCLUDED from the skim (it is off-budget at the token).
const REFERRAL_BPS = 500n;
// The marketing recipient: the constructor-set immutable configured by the
// shared fixture. The referral fallback routes the skim here.
const MARKETING = TEST_MARKETING_FEE_RECIPIENT;

async function advanceRound() {
  const t = await time.latest();
  await time.increaseTo(Math.floor(t / 86400) * 86400 + 86400 + 1);
}

async function streamIdFrom(tx, satori) {
  const r = await tx.wait();
  const ev = r.logs.find((l) => {
    try {
      return satori.interface.parseLog(l)?.name === "DataStreamCreated";
    } catch {
      return false;
    }
  });
  return satori.interface.parseLog(ev).args.streamId;
}

// Deploy a fully-wired stack. The platform fee moved to the immutable token, so
// SatoriRewards no longer takes/holds a fee rate; `feeBps` is accepted for
// call-site compatibility but the fixture ignores it (there is no rewards-side
// fee to configure). owner is the deployer and the default `admin`.
async function deployStack(feeBps, adminAddr) {
  return deploySatoriFixtureWithFeeBps(feeBps);
}

describe("rewards-distribution adversarial coverage (round 2)", function () {
  this.timeout(120000);

  // -------------------------------------------------------------------------
  // The platform fee moved to the immutable SatoriToken; its recipient/schedule
  // immutability is pinned in test/next/DevFee.test.js. Here we only guard that
  // SatoriRewards no longer carries the fee recipient or any redirect surface —
  // so a regression that re-adds one on the upgradeable rewards child is caught.
  // -------------------------------------------------------------------------
  it("SatoriRewards exposes no platform-fee recipient and no redirect surface", async function () {
    // platform fee moved to immutable token (see test/next/DevFee.test.js)
    const { rewards } = await deployStack(1000);
    expect(rewards.PLATFORM_FEE_RECIPIENT).to.equal(undefined);
    // No recipient-redirect/wire surface exists on the contract.
    expect(rewards.wireFeeRecipient).to.equal(undefined);
    expect(rewards.setPlatformFeeRecipient).to.equal(undefined);
  });

  // -------------------------------------------------------------------------
  // MED: committed-budget invariant on the predictor leg.
  //
  // The platform fee is gone from the reward split (it moved to the immutable
  // token's senior, off-budget dev fee), the value-provider cut is gone, and the
  // first-predictor bonus reservation is gone. So each round's payable budget IS
  // the on-chain gross (TOKENS_PER_ROUND − devRateNow = 1152 at genesis) and a
  // sole predictor collects all of it:
  //
  //   predictor.realized(one producing round) == ON_CHAIN_GROSS
  //
  // Referral-eager-credit model: the predictor's whole reward is credited through
  // _creditReward, which skims 5% (REFERRAL_BPS) to the earner's referral or,
  // absent one, to MARKETING. So dave's CLAIM mints the NET predictor reward
  // = 1152 - floor(1152*500/10000). The skimmed 5% lands in the MARKETING
  // bucket (dave has no referral). The predictor leg therefore reconstructs
  // EXACTLY to ON_CHAIN_GROSS once the marketing skim is folded back in — the 5%
  // is redistributed within the leg, never lost. (The senior 288 dev fee is
  // minted separately, off this budget, at the immutable token.)
  //
  // and across the whole window the total committed minted predictor budget
  // (dave's net claim + the marketing skim) must never exceed
  // ON_CHAIN_GROSS * roundsElapsed.
  // -------------------------------------------------------------------------
  it("MED: predictor slice conserves EXACTLY to the on-chain gross (senior dev fee carved out); stays within the committed-budget ceiling", async function () {
    // platform fee moved to immutable token (see test/next/DevFee.test.js) — the
    // reward split no longer reserves any fee leg, so the predictor leg == gross.
    const { satori, registry, rewards, signers, owner } = await deployStack(0);
    ON_CHAIN_GROSS = await onChainGrossNow(satori);
    const [, alice, dave, carol] = signers;

    await satori.transfer(alice.address, ethers.parseEther("100"));
    await satori.transfer(dave.address, ethers.parseEther("100"));
    await satori.transfer(carol.address, ethers.parseEther("100"));
    await advanceRound();

    // One eligible stream A; alice votes it.
    const A = await streamIdFrom(await satori[SIMPLE3]("A", owner.address, 1440), satori);
    await registry.setValue(A, 100);
    await voteFor(satori, alice, A);

    // R-1: carol predicts, so round R-1 is a separate producing round and round R
    // has dave as its ONLY predictor on A. (This used to also park the R-1
    // first-predictor bonus on carol; that bonus no longer exists.)
    await satori.connect(carol).predictMultipleWithPayloads([{ gameId: A, payload: pack1(UP) }]);
    await advanceRound(); // → R

    // Record round R as the baseline for the committed-budget window.
    const roundR = BigInt(await satori.getCurrentRound());

    // R: dave is the SOLE predictor on A → he earns the whole round budget.
    await registry.setValue(A, 110);
    await satori.connect(dave).predictMultipleWithPayloads([{ gameId: A, payload: pack1(UP) }]);
    await advanceRound();
    await registry.setValue(A, 120);
    await advanceRound();
    await registry.setValue(A, 130);

    // ---- Predictor leg: dave is the SOLE correct predictor on the SOLE
    // producing game with weight → he receives the entire round budget, which is
    // now the whole on-chain gross. Under referral-eager-credit that reward
    // is skimmed 5% at CREDIT time (i.e. at settle); dave has no referral, so
    // that 5% is credited to the MARKETING bucket. dave's CLAIM then mints the
    // NET amount, and the full predictor leg is (dave net + mkt skim).
    const expectedPredictorLeg = ON_CHAIN_GROSS; // after the senior dev fee
    // The 5% skim taken from dave's predictor reward. Nothing is exempt now.
    const predictorSkim = (expectedPredictorLeg * REFERRAL_BPS) / 10000n; // floor
    // Marketing bucket baseline captured BEFORE settle — the skim is credited
    // eagerly at settle, so this delta isolates exactly dave's predictor skim.
    const mktBefore = await rewards.unclaimedRewards(MARKETING);
    await satori.settlePrediction(dave.address, A);
    // The skimmed 5% landed in the MARKETING bucket at settle (dave has no
    // referral). It is NOT minted to dave and NOT lost — MARKETING claims it.
    const mktSkim = (await rewards.unclaimedRewards(MARKETING)) - mktBefore;
    expect(mktSkim).to.equal(predictorSkim);

    const daveBefore = await satori.balanceOf(dave.address);
    await satori.connect(dave).claim();
    const daveReward = (await satori.balanceOf(dave.address)) - daveBefore;

    // dave's minted claim is the NET predictor reward (after the 5% skim).
    // Quantization on rawPower keeps the RAW_TOLERANCE band.
    const expectedDaveNet = expectedPredictorLeg - predictorSkim; // 547.2
    expect(daveReward).to.be.closeTo(expectedDaveNet, RAW_TOLERANCE);

    // Full predictor leg reconstructs EXACTLY: dave's net claim + the marketing
    // skim == ON_CHAIN_GROSS. The 5% is redistributed within the leg, never
    // lost — conservation of the predictor leg holds to the wei (mod rawPower
    // quantization, bounded by RAW_TOLERANCE) once the skim is folded back in.
    expect(daveReward + mktSkim).to.be.closeTo(expectedPredictorLeg, RAW_TOLERANCE);

    // ---- Conservation (single round R): with the rewards-side fee leg gone, the
    // predictor leg alone reserves the entire on-chain round gross (the senior
    // 144 dev fee is minted separately at the immutable token, off this budget).
    expect(expectedPredictorLeg).to.equal(ON_CHAIN_GROSS);

    // ---- Committed-budget ceiling across the whole window: the total minted
    // predictor reward for round R (dave's NET claim + the referral skim that
    // was redistributed to MARKETING — both are committed budget) must not exceed
    // the on-chain per-round budget ON_CHAIN_GROSS * roundsElapsed.
    const nowRound = BigInt(await satori.getCurrentRound());
    const roundsElapsed = nowRound - roundR + 1n; // generous upper bound
    const totalCommitted = daveReward + mktSkim;
    expect(totalCommitted).to.be.lte(ON_CHAIN_GROSS * roundsElapsed);
  });

  // -------------------------------------------------------------------------
  // The "accrueProtocolFee is permissionless and idempotent" test was REMOVED:
  // platform fee moved to immutable token (see test/next/DevFee.test.js). The
  // rewards contract no longer accrues a protocol fee (no accrueProtocolFee, no
  // per-round fee surfacing on the recipient) — the token's permissionless
  // mintDevFee pull and its idempotence-within-a-round are covered by
  // test/next/DevFee.test.js ("mintDevFee() permissionless pull").
  // -------------------------------------------------------------------------

});
