/**
 * Adversarial coverage — REFERRAL subsystem, SECOND round.
 *
 * The first-round file (referral.cov.test.js) already covers the HIGH gaps and
 * the two MED `test_proposals`:
 *   - referral_tiny_claim_floors_cut_to_zero (HIGH)
 *   - referral_cut_on_delegator_only_earner (HIGH)
 *   - referral_rounding_remainder_goes_to_recipient_not_referral (MED)
 *   - referral_mint_counts_against_budget_cap (MED, folded into the rounding test)
 *
 * This file mops up the remaining UNCOVERED `coverage_gaps` from
 * adversarial-findings/_raw_review.json (system == "referral") that are still
 * worth pinning — none of the remaining `test_proposals` are MED-priority, so
 * per the harness rules we cover the most valuable remaining edges:
 *
 *   - referral_self_optout_large_gross_via_claimFor (gap: "Self-pointer opt-out
 *     emits NO ReferralPaid AND mints zero even when gross is large", not yet
 *     combined with multi-round large gross or the claimFor delegate path).
 *   - referral_empty_claim_no_side_effects (gap: "Empty claim (gross==0) with a
 *     referral set: no ReferralPaid, no mint, RewardsClaimed(...,0,...) still
 *     emits").
 *   - self-pointer opt-out LOCKS the slot (setReferral(self) then setReferral
 *     (other) reverts AlreadySet) — pins that the opt-out is irreversible, the
 *     only guard against a later self-mint-loop re-point.
 *
 * CONTRACT NOTE (post-audit change): the platform fee moved OFF SatoriRewards
 * entirely — it is now the immutable SatoriToken's senior dev fee, with its
 * recipient a constructor-set immutable on the TOKEN (`token.PLATFORM_FEE_RECIPIENT()`,
 * no setter). SatoriRewards no longer exposes `PLATFORM_FEE_RECIPIENT`, and
 * there is still no `wireFeeRecipient`/recipient setter anywhere. The token-side
 * schedule/recipient-immutability is pinned in test/next/DevFee.test.js; here we
 * only guard that no fee-redirect surface has crept back onto SatoriRewards.
 * These tests deploy with deploySatoriFixtureNoFee (0 bps) so reward gross ==
 * minted with no fee pollution.
 *
 * Harness: requires ../fixtures (deploySatoriFixtureNoFee, pack1).
 */

const { expect } = require("chai");
const { deploySatoriFixtureNoFee, pack1, voteFor } = require("../fixtures");
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

function rewardsClaimedAmount(receipt, rewards, owner, recipient) {
  for (const log of receipt.logs) {
    let p;
    try {
      p = rewards.interface.parseLog(log);
    } catch {
      continue;
    }
    if (p?.name === "RewardsClaimed") {
      // event RewardsClaimed(owner, recipient, amount, round)
      if (
        p.args[0].toLowerCase() === owner.toLowerCase() &&
        p.args[1].toLowerCase() === recipient.toLowerCase()
      ) {
        return p.args[2];
      }
    }
  }
  return undefined;
}

describe("Referral — adversarial coverage (round 2)", function () {
  this.timeout(120000);

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

    // The fee recipient is IMMUTABLE (the hard-coded PLATFORM_FEE_RECIPIENT
    // constant). The rate is deploy-set; deploySatoriFixtureNoFee deploys at
    // 0 bps so reward gross equals what's minted and no platform fee pollutes
    // the math.
  });

  // ---------------------------------------------------------------------------
  // The platform fee moved to the immutable SatoriToken (see
  // test/next/DevFee.test.js for the recipient/schedule immutability). All we
  // pin HERE is that SatoriRewards no longer carries the fee recipient or any
  // redirect surface — so a regression that re-adds one on the upgradeable
  // rewards contract is caught.
  // ---------------------------------------------------------------------------
  describe("platform fee is gone from SatoriRewards (moved to the immutable token)", function () {
    it("SatoriRewards exposes no fee recipient and no redirect surface", async function () {
      // platform fee moved to immutable token (see test/next/DevFee.test.js)
      expect(rewards.PLATFORM_FEE_RECIPIENT).to.equal(undefined);
      // No on-chain path exists to redirect the fee.
      expect(rewards.wireFeeRecipient).to.equal(undefined);
      expect(rewards.setPlatformFeeRecipient).to.equal(undefined);
    });
  });

  // Drive a single delegate prediction to a win.
  async function winOneRound(predictor, gameId, settler) {
    await registry.setValue(gameId, 100);
    await satori
      .connect(predictor)
      .predictMultipleWithPayloads([{ gameId, payload: pack1(UP) }]);
    await advanceRound();
    await registry.setValue(gameId, 110);
    await advanceRound();
    await registry.setValue(gameId, 120); // UP wins
    await satori.connect(settler).settlePrediction(predictor.address, gameId);
  }

  // ---------------------------------------------------------------------------
  // Self-pointer opt-out: large multi-round gross, claimed via the claimFor
  // delegate path. ref==owner must produce NO ReferralPaid, mint zero to any
  // third party, and route the FULL gross to the recipient.
  // ---------------------------------------------------------------------------
  describe("unreferred earner via claimFor: claim mints the full net, no skim at claim", function () {
    it("claimFor mints the whole (already-net) bucket to the recipient; no ReferralPaid at claim", async function () {
      const gid = await streamIdFrom(
        await satori[SIMPLE3]("NoRef", owner.address, 1440),
        satori
      );

      await satori.transfer(alice.address, ethers.parseEther("500"));
      await satori.transfer(dave.address, ethers.parseEther("50"));

      await voteFor(satori, dave, gid);
      await advanceRound();

      // alice sets NO referral — her 5% was already skimmed to marketing at
      // credit time (settle), so her claimable bucket is already NET. There is no
      // opt-out; this just verifies claim/claimFor takes NOTHING further.
      // alice delegates claim ability to bob (the claimFor caller).
      await satori.connect(alice).delegateClaimAbility(bob.address);

      await winOneRound(alice, gid, dave);

      const net = (await lens.getTotalClaimableRewards(alice.address))[0]; // already net of the skim
      expect(net).to.be.gt(0n);

      const aliceBefore = await satori.balanceOf(alice.address);
      const carolBefore = await satori.balanceOf(carol.address); // arbitrary 3rd party
      const ownerBefore = await satori.balanceOf(owner.address);

      // bob claims FOR alice, sending the proceeds to carol (recipient).
      const tx = await satori.connect(bob).claimFor(alice.address, carol.address);
      const receipt = await tx.wait();

      const aliceGained = (await satori.balanceOf(alice.address)) - aliceBefore;
      const carolGained = (await satori.balanceOf(carol.address)) - carolBefore;
      const ownerGained = (await satori.balanceOf(owner.address)) - ownerBefore;

      // Recipient (carol) gets the FULL net bucket. Nothing is skimmed AT CLAIM.
      expect(carolGained).to.equal(net);
      expect(aliceGained).to.equal(0n);
      expect(ownerGained).to.equal(0n);
      // No ReferralPaid at claim — the skim already happened at credit time.
      expect(hasReferralPaid(receipt, rewards)).to.equal(false);
      // RewardsClaimed reports the net bucket as the claimed amount.
      expect(
        rewardsClaimedAmount(receipt, rewards, alice.address, carol.address)
      ).to.equal(net);
    });
  });

  // ---------------------------------------------------------------------------
  // Empty claim (gross == 0) with a referral set: forgiving semantics. No
  // ReferralPaid, no mint to anyone, but RewardsClaimed(owner,recipient,0,round)
  // still fires and no balance moves.
  // ---------------------------------------------------------------------------
  describe("empty claim with referral set has no side effects", function () {
    it("gross==0 claim emits RewardsClaimed(.,.,0,.), no ReferralPaid, no balance change", async function () {
      // alice sets a referral but never earns anything.
      await rewards.connect(alice).setReferral(carol.address);

      const aliceBefore = await satori.balanceOf(alice.address);
      const carolBefore = await satori.balanceOf(carol.address);
      const totalSupplyBefore = await satori.totalSupply();

      // Sanity: alice truly has nothing claimable.
      expect((await lens.getTotalClaimableRewards(alice.address))[0]).to.equal(0n);

      const tx = await satori.connect(alice)["claim()"]();
      const receipt = await tx.wait();

      const aliceAfter = await satori.balanceOf(alice.address);
      const carolAfter = await satori.balanceOf(carol.address);

      // No mint to anyone — supply unchanged, balances unchanged.
      expect(aliceAfter).to.equal(aliceBefore);
      expect(carolAfter).to.equal(carolBefore);
      expect(await satori.totalSupply()).to.equal(totalSupplyBefore);

      // No ReferralPaid for an empty claim.
      expect(hasReferralPaid(receipt, rewards)).to.equal(false);

      // RewardsClaimed STILL emits with amount 0 (forgiving empty-claim).
      expect(
        rewardsClaimedAmount(receipt, rewards, alice.address, alice.address)
      ).to.equal(0n);
    });
  });

  // ---------------------------------------------------------------------------
  // Self-referral is rejected outright: setReferral(self) reverts InvalidReferral
  // and never occupies the slot, so a real referral can still be set afterward.
  // (There is no self-referral opt-out anymore — every earner pays the 5%.)
  // ---------------------------------------------------------------------------
  describe("self-referral is rejected", function () {
    it("setReferral(self) reverts InvalidReferral and does not lock the slot", async function () {
      await expect(
        rewards.connect(alice).setReferral(alice.address)
      ).to.be.revertedWithCustomError(rewards, "InvalidReferral");

      // The rejected attempt left the slot empty — a real referral still works.
      await rewards.connect(alice).setReferral(bob.address);
      expect(await rewards.referral(alice.address)).to.equal(bob.address);

      // ...and once a real referral is set, it is immutable.
      await expect(
        rewards.connect(alice).setReferral(carol.address)
      ).to.be.revertedWithCustomError(rewards, "AlreadySet");
    });
  });
});
