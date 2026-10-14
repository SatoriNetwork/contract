// Adversarial COVERAGE for the claim-delegation subsystem.
//
// Targets the high/med-priority coverage gaps from the raw review:
//  - claimFor must honor the OWNER's referral (not delegate's / recipient's),
//    refCut == totalRewards/100, minted to owner's referrer, ReferralPaid(owner,..)
//  - claimFor recipient==address(0) reverts BadInput
//  - claimFor for zero-unclaimed owner is a clean no-op (RewardsClaimed(.,.,0,.),
//    no mint, no spurious ReferralPaid)
//  - owner self-claim blocked ClaimDelegatedAway while delegated; revoke +
//    self-claim immediately (same round, no cooldown)
//  - independence of the three delegation pointers + balance/lock state
//
// All assertions reflect the DOCUMENTED intent in
// docs/narratives/A_claim_delegation.md. Where the code disagrees with intent
// the case is relocated to adversarial-findings/ as a kept failing repro.

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture, pack1 , voteFor } = require("../fixtures");

const UP = 1;

async function advanceOneDay() { await time.increase(86400); }

// Build claimable SATORI rewards for `who` on `stream` by predicting a
// correct UP move and letting the round score. Leaves a non-zero
// unclaimedRewards[who] with no prediction delegation involved, so
// _accrueDelegatorRewards is a no-op.
//
// Eager-credit model: the 1% referral skim is taken at SCORE (credit) time,
// not at claim. The scoring of the correct prediction is triggered by the
// final `predictMultipleWithPayloads` below, so that tx is the one that emits
// `ReferralPaid` and lands the cut in the destination's UNCLAIMED bucket. It
// is returned so referral-mechanic tests can assert on the credit-time event.
// After this runs `unclaimedRewards[who]` is already NET of the 1% skim.
async function buildRewards(satori, registry, who, stream) {
  await registry.setValue(stream, 100);
  await satori.connect(who).predictMultipleWithPayloads([{ gameId: stream, payload: pack1(UP) }]);
  await advanceOneDay();
  await registry.setValue(stream, 150); // UP -> correct
  await advanceOneDay();
  await registry.setValue(stream, 200);
  // This settle/score tx is where eager credit + the referral skim happen.
  return satori.connect(who).predictMultipleWithPayloads([{ gameId: stream, payload: pack1(UP) }]);
}

async function getStreamId(tx, satori) {
  const rcpt = await tx.wait();
  for (const log of rcpt.logs) {
    try {
      const p = satori.interface.parseLog(log);
      if (p && p.name === "DataStreamCreated") return p.args.streamId;
    } catch (e) {}
  }
  throw new Error("DataStreamCreated not found");
}

describe("[adv-cov] claim-delegation", function () {
  let satori, voting, rewards, bounties, registry, owner, signers;
  let alice, bob, carol, dave, refA, refB;
  let stream1;

  beforeEach(async function () {
    const fix = await loadFixture(deploySatoriFixture);
    ({ satori, voting, rewards, bounties, registry, owner, signers } = fix);
    [, alice, bob, carol, dave, refA, refB] = signers;

    const INITIAL_MINT = await satori.INITIAL_MINT();
    await satori.transfer(alice.address, (INITIAL_MINT * 45n) / 100n);
    await satori.transfer(bob.address, (INITIAL_MINT * 225n) / 1000n);
    await satori.transfer(carol.address, (INITIAL_MINT * 135n) / 1000n);
    await satori.transfer(dave.address, (INITIAL_MINT * 9n) / 100n);

    // Admin-created sub-round (720-minute) stream: the stream is scaffolding
    // here (the subject is claim delegation), so keep the fast rhythm the rest
    // of this file is written against. `satori` is connected to `owner`, who is
    // rewards.admin() and therefore exempt from the public round-length floor.
    const tx1 = await satori["createSimpleDataStream(string,address,uint24)"]("Stream 1", owner.address, 720);
    stream1 = await getStreamId(tx1, satori);

    // Establish eligibility: burn voting gives s1's game permanent weight, and
    // any game with weight > 0 is eligible. 10 SATORI each, out of balances of
    // 324 / 162, so both keep plenty of prediction power.
    await voteFor(satori, alice, stream1);
    await voteFor(satori, bob, stream1);

    // Advance one round so the stream has previousVotes for eligibility.
    await advanceOneDay();
  });

  // -------------------------------------------------------------------------
  // HIGH: claimFor honors the OWNER's referral
  // -------------------------------------------------------------------------
  describe("referral routing on the delegated path", function () {
    // (Title said "1%" — REFERRAL_BPS is 500, i.e. 5%, which is what the body
    // now asserts against the round budget. Renamed so the title stops lying.)
    it("uses the OWNER's referral: 5% skimmed at credit to owner's referrer, net delegated to recipient", async function () {
      this.timeout(120000);

      // Both alice (owner) and bob (delegate) register referrals. The delegate's
      // referral must be IGNORED; only the owner's referral takes the cut.
      await rewards.connect(alice).setReferral(refA.address);
      await rewards.connect(bob).setReferral(refB.address);

      const refAUnclBefore = await rewards.unclaimedRewards(refA.address);
      const refBUnclBefore = await rewards.unclaimedRewards(refB.address);

      // Eager-credit model: the skim is taken at SCORE time, not at claim.
      // The scoring tx is the one that emits ReferralPaid and lands the cut in
      // the OWNER referrer's UNCLAIMED bucket.
      //
      // buildRewards is inlined here (with an explicit settlePrediction as the
      // scoring tx instead of a second predict) for ONE reason: the conservation
      // check below needs the bucket deltas of a SINGLE credit event, so the
      // scoring tx must be isolated from anything else that touches a bucket.
      await registry.setValue(stream1, 100);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);
      await advanceOneDay();
      await registry.setValue(stream1, 150); // UP -> correct
      await advanceOneDay();
      await registry.setValue(stream1, 200);

      // Snapshot immediately before the credit event (still zero — nothing has
      // been credited to alice yet).
      const aliceBefore = await rewards.unclaimedRewards(alice.address);
      const scoreTx = await satori.connect(alice).settlePrediction(alice.address, stream1);

      // Reconstruct the split from the on-chain buckets: what landed in alice's
      // (net) bucket, and the cut that went to her referrer's bucket.
      const net = await rewards.unclaimedRewards(alice.address);
      expect(net).to.be.gt(0n);
      const netCredited = net - aliceBefore; // earner's share of THIS credit
      const expectedCut = (await rewards.unclaimedRewards(refA.address)) - refAUnclBefore;
      expect(expectedCut).to.be.gt(0n);

      // CONSERVATION — the load-bearing property of _creditReward: the skim is a
      // redistribution WITHIN one credit event, never an inflation
      // (docs/narratives/A_rewards.md:139). The old line here was
      // `expect(net + expectedCut).to.equal(gross)` where `gross` had been DEFINED
      // as `net + expectedCut` twenty lines earlier — x == x, which stayed green
      // even for a `_creditReward` that credited the earner the FULL amount and
      // the referrer a cut on top (P1). Anchor it on an INDEPENDENT value: alice
      // is the only predictor on the only game carrying burnt weight, so this credit
      // is the whole payable round budget — 1440 − devRateNow (dial 0) = 1152 SATORI.
      // The first-predictor bonus reservation and the value-provider cut are BOTH
      // GONE, so the FULL on-chain gross is now distributable to predictors.
      const roundGross = (await satori.emissionRateNow()) - (await satori.devRateNow());
      const grossCredit = roundGross; // payable budget for the round
      expect(netCredited + expectedCut, "earner net + referrer cut == the credited amount")
        .to.equal(grossCredit);
      expect(expectedCut, "the cut is REFERRAL_BPS (5%) of that same amount")
        .to.equal((grossCredit * 500n) / 10000n);

      // The cut was emitted + credited at SCORE time to the OWNER's referrer,
      // routed by the owner's referral (refA), never the delegate's (refB).
      await expect(scoreTx)
        .to.emit(rewards, "ReferralPaid")
        .withArgs(alice.address, refA.address, expectedCut, await satori.getCurrentRound(),
          await rewards.unclaimedRewards(refA.address));
      // Delegate's referrer bucket is untouched by the OWNER's earnings.
      expect(await rewards.unclaimedRewards(refB.address)).to.equal(refBUnclBefore);

      await satori.connect(alice).delegateClaimAbility(bob.address);

      const refABalBefore = await satori.balanceOf(refA.address);
      const refBBalBefore = await satori.balanceOf(refB.address);
      const carolBefore = await satori.balanceOf(carol.address);

      // bob (delegate) claims for alice, sending the already-net bucket to carol
      // (third party). Claim no longer skims, so it emits NO ReferralPaid: it
      // simply mints alice's whole net bucket to the recipient.
      const claimTx = satori.connect(bob)["claimFor(address,address)"](alice.address, carol.address);
      await expect(claimTx).to.not.emit(rewards, "ReferralPaid");
      await expect(claimTx)
        .to.emit(rewards, "RewardsClaimed")
        .withArgs(alice.address, carol.address, net, await satori.getCurrentRound());

      // Recipient (carol) got the full net; the 1% already sits in refA's
      // UNCLAIMED bucket (refA must claim it separately — no mint to its balance
      // on alice's claim). Delegate's referrer got NOTHING, anywhere.
      expect((await satori.balanceOf(carol.address)) - carolBefore).to.equal(net);
      expect(await satori.balanceOf(refA.address)).to.equal(refABalBefore);
      expect(await satori.balanceOf(refB.address)).to.equal(refBBalBefore);
      expect(await rewards.unclaimedRewards(refA.address)).to.equal(refAUnclBefore + expectedCut);

      // refA can now claim its skimmed cut to its OWN balance, confirming the
      // cut was genuinely credited (not lost). Conservation itself is asserted
      // above, against the independent round budget.
      await satori.connect(refA)["claim()"]();
      expect((await satori.balanceOf(refA.address)) - refABalBefore).to.equal(expectedCut);
    });
  });

  // -------------------------------------------------------------------------
  // MED: zero-unclaimed claimFor is a clean no-op
  // -------------------------------------------------------------------------
  describe("zero-balance delegated claim", function () {
    it("emits RewardsClaimed(owner,recipient,0,round), mints nothing, no ReferralPaid", async function () {
      // Owner has an OWNER referral set, but zero unclaimed -> no spurious mint.
      await rewards.connect(alice).setReferral(refA.address);
      await satori.connect(alice).delegateClaimAbility(bob.address);

      expect(await rewards.unclaimedRewards(alice.address)).to.equal(0n);

      const refABefore = await satori.balanceOf(refA.address);
      const bobBefore = await satori.balanceOf(bob.address);
      const supplyBefore = await satori.totalSupply();

      const round = await satori.getCurrentRound();
      const tx = satori.connect(bob)["claimFor(address,address)"](alice.address, bob.address);

      await expect(tx)
        .to.emit(rewards, "RewardsClaimed")
        .withArgs(alice.address, bob.address, 0n, round);
      await expect(tx).to.not.emit(rewards, "ReferralPaid");

      expect(await satori.balanceOf(refA.address)).to.equal(refABefore);
      expect(await satori.balanceOf(bob.address)).to.equal(bobBefore);
      expect(await satori.totalSupply()).to.equal(supplyBefore);
    });
  });

  // -------------------------------------------------------------------------
  // MED: recipient == address(0) reverts BadInput (rewards path)
  // -------------------------------------------------------------------------
  describe("zero recipient guard", function () {
    it("claimFor(owner, address(0)) reverts BadInput", async function () {
      this.timeout(120000);
      await buildRewards(satori, registry, alice, stream1);
      await satori.connect(alice).delegateClaimAbility(bob.address);

      await expect(
        satori.connect(bob)["claimFor(address,address)"](alice.address, ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(rewards, "BadInput");
    });
  });

  // -------------------------------------------------------------------------
  // MED: self-claim blocked while delegated; revoke + self-claim immediate
  // -------------------------------------------------------------------------
  describe("self-claim lockout and immediate revoke", function () {
    it("owner self-claim reverts ClaimDelegatedAway while a delegate is set", async function () {
      this.timeout(120000);
      await buildRewards(satori, registry, alice, stream1);
      await satori.connect(alice).delegateClaimAbility(bob.address);

      await expect(
        satori.connect(alice)["claim()"]()
      ).to.be.revertedWithCustomError(rewards, "ClaimDelegatedAway");
    });

    it("owner can revoke and immediately self-claim in the same round (no cooldown)", async function () {
      this.timeout(120000);
      await buildRewards(satori, registry, alice, stream1);
      await satori.connect(alice).delegateClaimAbility(bob.address);

      // Revoke (self-delegate) then self-claim immediately, no round advance.
      await satori.connect(alice).delegateClaimAbility(alice.address);

      const gross = await rewards.unclaimedRewards(alice.address);
      expect(gross).to.be.gt(0n);
      const before = await satori.balanceOf(alice.address);

      await expect(satori.connect(alice)["claim()"]()).to.not.be.reverted;

      // No referral set -> alice receives the full gross.
      expect((await satori.balanceOf(alice.address)) - before).to.equal(gross);
    });

    it("a stale delegate's claimFor reverts Unauthorized after the owner revokes", async function () {
      this.timeout(120000);
      await buildRewards(satori, registry, alice, stream1);
      await satori.connect(alice).delegateClaimAbility(bob.address);
      // owner revokes
      await satori.connect(alice).delegateClaimAbility(alice.address);

      // bob's in-flight claim now lands after revoke -> Unauthorized.
      await expect(
        satori.connect(bob)["claimFor(address,address)"](alice.address, bob.address)
      ).to.be.revertedWithCustomError(rewards, "Unauthorized");
    });
  });

  // -------------------------------------------------------------------------
  // MED: independence of the delegation pointers + balance/lock
  // (Vote delegation no longer exists — voting is burn-backed, so there is no
  // vote pointer left to be independent of. Prediction + claim delegation do
  // still exist and their independence is what this pins.)
  // -------------------------------------------------------------------------
  describe("delegation pointer independence", function () {
    it("setting a claim delegate does not touch prediction delegation, balance, or lock", async function () {
      // Snapshot the unrelated state before.
      const predBefore = await rewards.predictionDelegateInfo(alice.address);
      const balBefore = await satori.balanceOf(alice.address);
      const lockBefore = await satori.lockedUntil(alice.address);

      await satori.connect(alice).delegateClaimAbility(bob.address);

      // Only the claim pointer moved.
      expect(await rewards.claimDelegateInfo(alice.address)).to.equal(bob.address);

      const predAfter = await rewards.predictionDelegateInfo(alice.address);
      expect(predAfter.delegate).to.equal(predBefore.delegate);
      expect(predAfter.power).to.equal(predBefore.power);

      // Balance and lock untouched (no balance lock on claim delegation).
      expect(await satori.balanceOf(alice.address)).to.equal(balBefore);
      expect(await satori.lockedUntil(alice.address)).to.equal(lockBefore);
    });

    it("a claim delegate does NOT gain prediction-power authority over the owner", async function () {
      // alice delegates only claim ability to bob.
      await satori.connect(alice).delegateClaimAbility(bob.address);

      // bob must not be able to predict using alice's power: bob predicting
      // spends bob's own power, never alice's. Assert alice's prediction
      // delegate pointer is still empty (no prediction authority granted).
      const pred = await rewards.predictionDelegateInfo(alice.address);
      expect(pred.delegate).to.equal(ethers.ZeroAddress);
    });
  });
});
