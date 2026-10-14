/**
 * ADVERSARIAL COVERAGE — round-budget conservation (ROUND 2, med gaps)
 *
 * HISTORY: this file used to cover the flat first-predictor bonus. That bonus is
 * GONE — `creditFirstPredictorBonus` and its upfront budget reservation were both
 * removed, so `_computeRoundBudget(gross) == gross` and the FULL on-chain gross is
 * distributable to predictors. The two `it`s whose entire subject was the bonus
 * were deleted with it; what remains is the surrounding coverage that still holds.
 *
 * The platform fee has MOVED OUT of the (upgradeable) rewards child and INTO the
 * immutable SatoriToken as a static, senior, self-accruing dev fee. It is no
 * longer part of ANY reward split (predictor/delegator) and no longer carved from
 * a round's budget — it accrues OFF-BUDGET at the token, to the token's
 * constructor-set immutable PLATFORM_FEE_RECIPIENT. The schedule/recipient-
 * immutability of that dev fee is covered by test/next/DevFee.test.js; this file
 * no longer asserts on any rewards-side fee.
 *
 *   [med] Conservation of the scored round's budget: with the fee off-budget AND
 *         no bonus reservation, Σ predictorPool (net of the 5% referral skim,
 *         re-homed to marketing) == the gross — no fee term, no bonus term.
 *   [med] The rewards child holds NO fee recipient and NO redirect path (feeSlot
 *         is retained inert).
 *
 * Intent sources: docs/narratives/A_rewards.md and
 * docs/design/immutable-dev-fee.md (fee moved to the immutable token).
 */

const { expect } = require("chai");
const { deploySatoriFixtureWithFeeBps, RAW_TOLERANCE, pack1, VOTE, onChainGrossNow } = require("../fixtures");
const { TEST_MARKETING_FEE_RECIPIENT } = require("../next/splitFixture");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const UP = 1;
// The stream-level valueProviderCutBps parameter is gone (providers are not paid
// at all any more), so the widest simple-stream overload is 3-arg.
const SIMPLE3 = "createSimpleDataStream(string,address,uint24)";
const TOKENS_PER_ROUND = ethers.parseEther("1440");
// On-chain game GROSS = the RESIDUAL after the senior dev fee (288, carved out
// at the immutable SatoriToken, OFF the reward budget — see test/next/DevFee.test.js).
// With offchainBudget == 0: gross = the emission net of the senior dev fee.
// The whole of it is now the payable predictor budget: nothing is reserved.
// READ FROM THE CHAIN. Was `parseEther("1152")` — 1440 less a 288 dev fee —
// which held only while emission was a fixed 1440.
let GROSS;
// Referral eager-credit era: 5% (REFERRAL_BPS) is skimmed from every reward
// credit at CREDIT time and parked in the destination's unclaimedRewards bucket.
// bob has no referral, so his 5% routes to the constructor-set immutable
// MARKETING_FEE_RECIPIENT. Conservation holds at the total level:
// earner_net + marketing_cut == the gross.
const REFERRAL_BPS = 500n;
const skimCut = (amount) => (amount * REFERRAL_BPS) / 10000n; // floor
const netOfSkim = (amount) => amount - skimCut(amount);

async function advanceRound() {
  const t = await time.latest();
  await time.increaseTo(Math.floor(t / 86400) * 86400 + 86400 + 1);
}

async function streamIdFrom(tx, satori) {
  const r = await tx.wait();
  const ev = r.logs.find(l => {
    try { return satori.interface.parseLog(l)?.name === "DataStreamCreated"; }
    catch { return false; }
  });
  return satori.interface.parseLog(ev).args.streamId;
}

// Deploy the restructured stack. The platform fee no longer lives on the
// rewards child (it moved to the immutable token as an off-budget dev fee), so
// `feeBps` is inert here — kept only for call-site compatibility.
async function deployStack(admin, feeBps) {
  const fix = await deploySatoriFixtureWithFeeBps(feeBps);
  return { satori: fix.satori, voting: fix.voting, rewards: fix.rewards, registry: fix.registry, lens: fix.lens };
}

describe("[adv-cov2] round-budget conservation (platform-fee-moved-to-token era)", function () {
  this.timeout(120000);
  let satori, voting, rewards, registry, lens;
  let owner, alice, bob, carol, admin;

  describe("[med] conservation of the scored round's budget (platform fee is OFF-BUDGET at the token)", function () {
    beforeEach(async function () {
      [owner, alice, bob, carol, admin] = await ethers.getSigners();
      ({ satori, voting, rewards, registry, lens } = await deployStack(admin, 1200));
      GROSS = await onChainGrossNow(satori);
      await satori.transfer(alice.address, ethers.parseEther("100"));
      await satori.transfer(bob.address, ethers.parseEther("100"));
    });

    // platform fee moved to immutable token (see test/next/DevFee.test.js): the
    // former "PLATFORM_FEE_RECIPIENT is a constructor-set immutable on rewards"
    // it() is dropped — the rewards child no longer holds any fee recipient.

    it("Σ predictorPool == the on-chain gross (platform fee off-budget, nothing reserved for a bonus)", async function () {
      await advanceRound();

      // id 1 is the default game; the first stream this test creates is id 2.
      await streamIdFrom(await satori[SIMPLE3]("throwaway", owner.address, 720), satori);
      const sid = await streamIdFrom(await satori[SIMPLE3]("paid", owner.address, 720), satori);

      // Round R: burn weight for the game, bob first+sole predict.
      await registry.setValue(sid, 100);
      await satori.connect(alice).vote(sid, VOTE);
      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: sid, payload: pack1(UP) }]);
      await advanceRound();
      await registry.setValue(sid, 110);
      await advanceRound();
      await registry.setValue(sid, 120);
      await satori.settlePrediction(bob.address, sid);

      // The platform/dev fee is no longer carved from the reward split — it lives
      // in the immutable SatoriToken and accrues OFF-BUDGET (it is carved from the
      // on-chain gross once: 1440 → 1152). The on-chain round budget IS that gross
      // in full: no fee term and no bonus reservation.
      // `sid` is the only game recorded for the round, so it takes the whole
      // denominator; the 5% referral cut is skimmed from bob's credit, so bob nets
      // 1152 − 5% and the skimmed 57.6 parks on MARKETING.
      const expectedPool = GROSS;
      const expectedBobNet = netOfSkim(expectedPool);
      expect((await lens.getTotalClaimableRewards(bob.address))[0])
        .to.be.closeTo(expectedBobNet, RAW_TOLERANCE);

      // The skimmed 5% of bob's pool lands claimable on MARKETING_FEE_RECIPIENT
      // (bob has no referral). Reading its bucket documents where the cut went.
      const marketing = await rewards.marketingFeeRecipient();
      const marketingCut = (await lens.getTotalClaimableRewards(marketing))[0];
      expect(marketingCut).to.be.closeTo(skimCut(expectedPool), RAW_TOLERANCE);

      // Σ parts = whole, EXACTLY: bob's net pool + the skimmed marketing cut ==
      // 1152 (the on-chain gross). The 5% is not lost — it is re-homed to the
      // marketing bucket, so the round budget is still fully accounted. There is
      // NO fee term: the platform fee is off-budget at the immutable token
      // (1152 + 288 == 1440, conserved overall).
      const bobNet = (await lens.getTotalClaimableRewards(bob.address))[0];
      expect(bobNet + marketingCut).to.be.closeTo(GROSS, RAW_TOLERANCE);
    });

    // DELETED (burn-voting refactor): "the first-predictor bonus is credited
    // independently". `creditFirstPredictorBonus` no longer exists — there is no
    // flat, outcome-independent credit at predict time to observe.
  });


  describe("[med] no rewards-side fee (fee moved to token)", function () {
    beforeEach(async function () {
      [owner, alice, bob, carol, admin] = await ethers.getSigners();
      ({ satori, voting, rewards, registry, lens } = await deployStack(admin, 1200));
      await satori.transfer(alice.address, ethers.parseEther("100"));
    });

    it("the rewards child holds NO fee recipient and NO redirect path; feeSlot is inert", async function () {
      // platform fee moved to immutable token (see test/next/DevFee.test.js): the
      // rewards child no longer exposes a fee recipient or any redirect function.
      expect(typeof rewards.PLATFORM_FEE_RECIPIENT).to.equal("undefined");
      expect(typeof rewards.wireFeeRecipient).to.equal("undefined");
      expect(typeof rewards.setPlatformFeeRecipient).to.equal("undefined");
      // feeSlot was removed 2026-08-31 with the rest of the dead fee storage.
      // Asserting its ABSENCE is strictly stronger than asserting it read (0,0):
      // there is no fee surface on rewards left to be inert.
      expect(rewards.feeSlot).to.equal(undefined);
      // The marketing recipient (the live 5% referral sink) IS a rewards immutable.
      expect((await rewards.marketingFeeRecipient()).toLowerCase())
        .to.equal(TEST_MARKETING_FEE_RECIPIENT.toLowerCase());
    });

    it("predicting credits NOTHING up front — the whole payout is market reward", async function () {
      await advanceRound();
      // id 1 is the default game; the first stream this test creates is id 2.
      await streamIdFrom(await satori[SIMPLE3]("throwaway", owner.address, 720), satori);
      const sid = await streamIdFrom(await satori[SIMPLE3]("s", owner.address, 720), satori);
      await registry.setValue(sid, 100);
      await satori.connect(alice).vote(sid, VOTE);
      const before = (await lens.getTotalClaimableRewards(alice.address))[0];
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: sid, payload: pack1(UP) }]);
      // The flat first-predictor bonus is gone: making a prediction credits zero.
      // Everything a predictor earns now comes from settling a CORRECT call.
      expect(((await lens.getTotalClaimableRewards(alice.address))[0]) - before).to.equal(0n);
    });
  });
});
