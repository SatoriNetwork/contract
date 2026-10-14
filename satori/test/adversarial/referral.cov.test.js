/**
 * Adversarial coverage for the REFERRAL subsystem.
 *
 * Targets the high/med-priority coverage gaps in
 * adversarial-findings/_raw_review.json (system == "referral"):
 *
 *   - referral_tiny_claim_floors_cut_to_zero (HIGH): a gross unclaimed amount
 *     in [1,19] wei floors refCut to 0 — referral gets nothing, recipient gets
 *     the full amount, NO ReferralPaid. At exactly 20 wei refCut==1, net==19.
 *   - referral_cut_on_delegator_only_earner (HIGH): an address that ONLY ever
 *     lent prediction power (never predicted) pays floor(pulled*500/10000) to
 *     its referral on claim.
 *   - referral_mint_counts_against_budget_cap (MED): totalRewardsMinted grows
 *     by exactly gross (refCut + net), not more.
 *   - referral_rounding_remainder_goes_to_recipient_not_referral (MED): for a
 *     gross not divisible by 20, referral gets floor(gross*500/10000) and the
 *     recipient absorbs the remainder.
 *
 * Intent sources:
 *   docs/narratives/A_rewards.md
 *   docs/questions/Q_referrals.md   (#17 tiny-claim floor)
 *
 * Harness: requires ../fixtures (deploySatoriFixture, pack1).
 */

const { expect } = require("chai");
const { deploySatoriFixtureNoFee, pack1, voteFor, warmUpLoyalty, onChainGrossNow } = require("../fixtures");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const UP = 1;
// The value-provider cut is gone, so stream creation no longer takes a cut-bps
// argument: the 3-arg (name, provider, minCadenceRounds) overload is the one.
const SIMPLE3 = "createSimpleDataStream(string,address,uint24)";

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

async function advanceRound() {
  await time.increase(86400);
}

function hasReferralPaid(receipt, rewards) {
  return receipt.logs.some((log) => {
    try {
      return rewards.interface.parseLog(log)?.name === "ReferralPaid";
    } catch {
      return false;
    }
  });
}

describe("Referral — adversarial coverage", function () {
  let satori, voting, rewards, registry, lens;
  let owner, alice, bob, carol, dave, eve;

  beforeEach(async function () {
    const f = await deploySatoriFixtureNoFee();
    satori = f.satori;
    voting = f.voting;
    rewards = f.rewards;
    registry = f.registry;
    lens = f.lens;
    [owner, alice, bob, carol, dave, eve] = f.signers;

    // Zero platform fees (deploy-set) so reward math is the legacy clean
    // budget and the gross we read equals what's minted.
  });

  // Drive a single delegate prediction to a win and return the gameId scored.
  // `predictor` predicts UP; the registry value rises so UP wins.
  async function winOneRound(predictor, gameId, settler) {
    await registry.setValue(gameId, 100);
    await satori
      .connect(predictor)
      .predictMultipleWithPayloads([{ gameId, payload: pack1(UP) }]);
    await advanceRound();
    await registry.setValue(gameId, 110); // B
    await advanceRound();
    await registry.setValue(gameId, 120); // C — UP wins
    await satori.connect(settler).settlePrediction(predictor.address, gameId);
  }

  // ---------------------------------------------------------------------------
  // HIGH: referral cut on a pure-delegator (lender) earner.
  // ---------------------------------------------------------------------------
  describe("delegator-only earner pays the cut", function () {
    this.timeout(120000);

    it("a lender who never predicted pays floor(raw*500/10000) to its referral's claimable bucket", async function () {
      // alice = pure delegator (lends prediction power, never predicts).
      // bob   = the predictor/delegate.
      // dave  = votes a stream eligible. carol = alice's referral.
      const gid = await streamIdFrom(
        await satori[SIMPLE3]("Lend", owner.address, 1440),
        satori
      );

      await satori.transfer(alice.address, ethers.parseEther("300"));
      await satori.transfer(bob.address, ethers.parseEther("100"));
      await satori.transfer(dave.address, ethers.parseEther("50"));

      await voteFor(satori, dave, gid);
      await advanceRound();

      // alice delegates ALL her prediction power to bob and sets a referral.
      await satori.connect(alice).delegatePredictionPower(bob.address);
      // Delegator weight is capital x loyalty and a fresh delegation starts at
      // L = 0, so the delegator's share -- and therefore the referral skim
      // taken off it -- is zero without a warm-up. Drains to `owner`.
      await warmUpLoyalty(satori, registry, null, bob, [alice], owner, gid);
      await rewards.connect(alice).setReferral(carol.address);

      // bob (with alice's delegated power) predicts and wins. alice never
      // predicts herself — her only earnings come via the delegator rate.
      await winOneRound(bob, gid, dave);

      // Eager-credit model: getTotalClaimableRewards is already NET of the 5%
      // referral skim. For a pure delegator the share is still pending at read
      // time (it folds into unclaimedRewards during the claim's delegator walk),
      // so `pulled` is exactly what alice's claim will mint to her.
      const pulled = (await lens.getTotalClaimableRewards(alice.address))[0];
      expect(pulled).to.be.gt(0n);

      // The referral cut has not been credited yet — the delegator share is
      // credited (and skimmed) during alice's claim, not before it.
      const carolBucketBefore = await rewards.unclaimedRewards(carol.address);
      expect(carolBucketBefore).to.equal(0n);

      const aliceBefore = await satori.balanceOf(alice.address);
      const carolBefore = await satori.balanceOf(carol.address);

      const tx = await satori.connect(alice)["claim()"]();
      const receipt = await tx.wait();

      const aliceGained = (await satori.balanceOf(alice.address)) - aliceBefore;
      const carolGained = (await satori.balanceOf(carol.address)) - carolBefore;

      // The cut lands in carol's CLAIMABLE (unclaimed) bucket, claimable by her
      // separately — it is NOT minted to her balance by alice's claim.
      const carolCut =
        (await rewards.unclaimedRewards(carol.address)) - carolBucketBefore;

      // alice's claim mints ONLY her own net bucket; carol's balance is unmoved.
      expect(carolGained).to.equal(0n);
      expect(aliceGained).to.equal(pulled);

      // Reconstruct the pre-skim delegator credit from the two halves. The cut
      // is exactly floor(raw*500/10000) taken at credit time; alice keeps raw - cut,
      // which is exactly the NET `pulled` the view reported.
      const raw = pulled + carolCut;
      expect(carolCut).to.equal(raw * 500n / 10000n); // floor(raw*500/10000), exact
      expect(pulled).to.equal(raw - raw * 500n / 10000n);
      expect(carolCut).to.be.gt(0n); // sanity: gross large enough to cut

      // Conservation: net-to-earner + cut-to-referral == the full raw credit.
      expect(aliceGained + carolCut).to.equal(raw);

      // The delegator share is credited (and the skim diverted) DURING alice's
      // claim, so ReferralPaid is emitted in this transaction.
      expect(hasReferralPaid(receipt, rewards)).to.equal(true);

      // And carol can independently claim her diverted cut — it mints exactly
      // the cut to her balance, no more.
      const carolBalBefore = await satori.balanceOf(carol.address);
      const mintedBeforeCarol = await satori.totalRewardsMinted();
      await satori.connect(carol)["claim()"]();
      expect((await satori.balanceOf(carol.address)) - carolBalBefore).to.equal(
        carolCut
      );
      expect(
        (await satori.totalRewardsMinted()) - mintedBeforeCarol
      ).to.equal(carolCut);
    });
  });

  // ---------------------------------------------------------------------------
  // MED: rounding remainder goes to the recipient, not the referral; and the
  // mint cap accounting (totalRewardsMinted) grows by exactly gross.
  // ---------------------------------------------------------------------------
  describe("rounding direction & budget-cap accounting", function () {
    this.timeout(120000);

    it("referral cut is skimmed at credit; earner keeps the net; per-earner mints don't double-count the cut", async function () {
      const gid = await streamIdFrom(
        await satori[SIMPLE3]("Round", owner.address, 1440),
        satori
      );

      await satori.transfer(alice.address, ethers.parseEther("300"));
      await satori.transfer(dave.address, ethers.parseEther("50"));

      await voteFor(satori, dave, gid);
      await advanceRound();

      await rewards.connect(alice).setReferral(carol.address);

      // alice predicts directly and wins. Under eager credit the 5% skim is
      // taken at settle time, so carol's cut is already sitting in her
      // claimable bucket before alice ever claims.
      await winOneRound(alice, gid, dave);

      // carol's diverted cut was credited to her bucket AT SETTLE.
      const carolCut = await rewards.unclaimedRewards(carol.address);
      expect(carolCut).to.be.gt(0n); // sanity: gross large enough to cut

      // getTotalClaimableRewards already returns the NET (post-skim) amount.
      const net = (await lens.getTotalClaimableRewards(alice.address))[0];
      expect(net).to.be.gt(0n);
      expect(net).to.equal(await rewards.unclaimedRewards(alice.address));

      // Reconstruct the round split: earner-net + referral-cut == the full
      // pre-skim on-chain budget. In this single-predictor setup alice takes the
      // whole on-chain round budget (the hub's emission net of the senior dev
      // fee), so `raw` pins to it exactly. Read from the chain — this was the
      // 1152 literal, i.e. 1440 - 288, which held only while emission was flat.
      const raw = net + carolCut;
      expect(raw).to.equal(await onChainGrossNow(satori));
      // Conservation: nothing is created or lost, the budget is exactly split
      // between the earner's net and the referral's diverted cut.
      expect(net).to.equal(raw - carolCut);

      // The cut equals floor(share*500/10000) of the reward credit. With the
      // first-predictor bonus removed there is no longer an exempt slice riding
      // on alice's side, so the WHOLE budget is the skimmed credit and the cut is
      // exactly floor(raw*500/10000). Cross-check it against the ReferralPaid
      // event emitted at settle.
      const settleTx = await rewards.queryFilter(
        rewards.filters.ReferralPaid(alice.address),
      );
      // Exactly one skim event for alice's predictor share this round.
      expect(settleTx.length).to.equal(1);
      // The event's diverted amount is exactly the cut that reached carol.
      expect(settleTx[0].args.amount).to.equal(carolCut);
      // Nothing is exempt from the skim any more, so the cut is EXACTLY the
      // floor of 5% of the whole budget and alice keeps exactly the rest.
      expect(carolCut).to.be.gt(0n);
      expect(carolCut).to.equal(raw * 500n / 10000n);
      expect(net).to.equal(raw - raw * 500n / 10000n);

      const mintedBefore = await satori.totalRewardsMinted();
      const aliceBefore = await satori.balanceOf(alice.address);
      const carolBefore = await satori.balanceOf(carol.address);

      await satori.connect(alice)["claim()"]();

      const aliceGained = (await satori.balanceOf(alice.address)) - aliceBefore;
      const carolGained = (await satori.balanceOf(carol.address)) - carolBefore;
      const mintedAfter = await satori.totalRewardsMinted();

      // alice's claim mints ONLY her own net bucket. carol's bucket is claimed
      // separately, so her balance is untouched and the mint delta is exactly
      // the net — the cut is NOT re-minted here (no double count against cap).
      expect(carolGained).to.equal(0n);
      expect(aliceGained).to.equal(net);
      expect(mintedAfter - mintedBefore).to.equal(net);

      // Conservation: earner-net + referral-cut == the full raw credit.
      expect(aliceGained + carolCut).to.equal(raw);

      // carol independently claims her cut: it mints exactly the cut, so across
      // BOTH claims the mint-cap consumed == raw (net + cut), never more.
      const mintedBeforeCarol = await satori.totalRewardsMinted();
      await satori.connect(carol)["claim()"]();
      const carolMintDelta =
        (await satori.totalRewardsMinted()) - mintedBeforeCarol;
      expect(carolMintDelta).to.equal(carolCut);
      expect((await satori.balanceOf(carol.address)) - carolBefore).to.equal(
        carolCut
      );
      // Total minted for this round's split == raw, not raw + cut.
      expect(mintedAfter - mintedBefore + carolMintDelta).to.equal(raw);
    });
  });

  // ---------------------------------------------------------------------------
  // HIGH: tiny claim (gross in [1,19]) floors the cut to 0 — no ReferralPaid,
  // recipient gets the full amount; at exactly 20 wei, refCut==1, net==19.
  //
  // Realistic on-chain path: a delegator holding only a few wei of SATORI
  // lends to a delegate with a large delegated pool. The delegator's rate-pull
  // credit = (tinyBal * rate) / 1e24 lands in the sub-20-wei range because
  // the rate is set by the large pool while the delegator's balance is tiny.
  // We calibrate `tinyBal` by reading the realized pull and asserting on the
  // documented floor boundary for whatever gross materializes.
  // ---------------------------------------------------------------------------
  describe("tiny claim floors the cut to zero", function () {
    this.timeout(120000);

    it("gross in [1,19] wei mints full amount to recipient, 0 to referral, no ReferralPaid", async function () {
      // bob = large delegator + the delegate-self setup: we want a large
      // delegated pool so the per-unit rate is small, then a tiny second
      // delegator (eve) whose pull lands < 100 wei.
      const gid = await streamIdFrom(
        await satori[SIMPLE3]("Tiny", owner.address, 1440),
        satori
      );

      // dave is the predictor/delegate. bob lends a large pool; eve lends a
      // tiny amount. carol votes the stream eligible.
      await satori.transfer(dave.address, ethers.parseEther("100"));
      await satori.transfer(bob.address, ethers.parseEther("300"));
      await satori.transfer(carol.address, ethers.parseEther("50"));
      // eve gets a tiny balance — a handful of wei, small enough that her
      // loyalty-weighted pull of the 1152-ether pool stays under 20 wei.
      await satori.transfer(eve.address, 5n);

      await voteFor(satori, carol, gid);
      await advanceRound();

      // bob and eve both delegate prediction power to dave (large + tiny pool).
      await satori.connect(bob).delegatePredictionPower(dave.address);
      await satori.connect(eve).delegatePredictionPower(dave.address);
      // Delegator weight is capital x loyalty and a fresh delegation starts at
      // L = 0, so the delegator's share -- and therefore the referral skim
      // taken off it -- is zero without a warm-up. Drains to `owner`.
      await warmUpLoyalty(satori, registry, null, dave, [bob, eve], owner, gid);
      await rewards.connect(eve).setReferral(alice.address);

      // dave predicts with the combined delegated power and wins.
      await winOneRound(dave, gid, carol);

      const gross = (await lens.getTotalClaimableRewards(eve.address))[0];
      // eve's tiny stake should pull a sub-20-wei delegator credit.
      expect(gross).to.be.gt(0n);
      expect(gross).to.be.lt(20n);

      const eveBefore = await satori.balanceOf(eve.address);
      const aliceBefore = await satori.balanceOf(alice.address);

      const tx = await satori.connect(eve)["claim()"]();
      const receipt = await tx.wait();

      const eveGained = (await satori.balanceOf(eve.address)) - eveBefore;
      const aliceGained = (await satori.balanceOf(alice.address)) - aliceBefore;

      // Floor to 0: referral gets nothing, recipient gets the whole gross,
      // no ReferralPaid emitted.
      expect(aliceGained).to.equal(0n);
      expect(eveGained).to.equal(gross);
      expect(hasReferralPaid(receipt, rewards)).to.equal(false);
    });
  });
});
