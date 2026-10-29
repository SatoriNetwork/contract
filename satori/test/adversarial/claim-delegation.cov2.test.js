// Adversarial COVERAGE — SECOND ROUND — for the claim-delegation subsystem.
//
// Round 1 (claim-delegation.cov.test.js) covered: owner-referral routing on
// the delegated path, zero-balance no-op, recipient==0 BadInput (rewards +
// bounty), withdrawBountyFor Unauthorized / ClaimDelegatedAway, self-claim
// lockout + same-round revoke, pointer independence.
//
// This file targets the REMAINING med-priority edges not yet exercised, plus
// the IMMUTABLE platform-fee-recipient contract change (post-audit):
//
//  - Owner's referral SELF-pointer is an opt-out on the DELEGATED path:
//    refCut skipped entirely, no ReferralPaid, recipient gets the full gross.
//    (Round 1 only tested a real third-party referrer.)
//  - Re-pointing the claim delegate is immediate with NO cooldown: a stale
//    (previous) delegate's claimFor reverts Unauthorized, the new delegate's
//    claimFor succeeds in the SAME round. (Round 1 tested revoke-to-self; this
//    is delegate->delegate rotation, the other immediacy edge.)
//  - claimFor is idempotent: a second delegated claim after the bucket is
//    drained is a clean no-op (RewardsClaimed amount 0, no mint, no
//    ReferralPaid) — conservation on the delegated path.
//  - delegateClaimAbility(self) when NO delegate was ever set is a harmless
//    no-op that leaves the owner able to self-claim (idempotent revoke).
//  - IMMUTABLE fee recipient (current code): PLATFORM_FEE_RECIPIENT is a
//    constructor-set immutable baked in at deploy (non-zero) — the
//    recipient is fixed once and unchangeable thereafter. There is NO
//    setter and NO wire path: setPlatformFeeRecipient does not exist, the
//    feeSlot() getter exposes only (bps, lastAccrualRound), and admin can
//    only REDUCE the rate / transfer admin — it canNOT redirect the fee.
//
// All assertions reflect the DOCUMENTED intent. Where the code disagrees with
// intent the case is relocated to adversarial-findings/ as a kept failing repro.

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture, pack1 , voteFor } = require("../fixtures");
const { TEST_PLATFORM_FEE_RECIPIENT } = require("../next/splitFixture");

const UP = 1;

async function advanceOneDay() { await time.increase(86400); }

// Build claimable SATORI rewards for `who` on `stream` by predicting a correct
// UP move and letting the round score. Leaves a non-zero unclaimedRewards[who]
// with no prediction delegation, so unclaimedRewards is the exact gross.
async function buildRewards(satori, registry, who, stream) {
  await registry.setValue(stream, 100);
  await satori.connect(who).predictMultipleWithPayloads([{ gameId: stream, payload: pack1(UP) }]);
  await advanceOneDay();
  await registry.setValue(stream, 150); // UP -> correct
  await advanceOneDay();
  await registry.setValue(stream, 200);
  // Score without predicting this round, so a claim may go elsewhere.
  await satori.settlePrediction(who.address, stream);
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

describe("[adv-cov2] claim-delegation", function () {
  this.timeout(120000);

  let satori, voting, rewards, bounties, registry, owner, signers;
  let alice, bob, carol, dave, refA;
  let stream1;

  beforeEach(async function () {
    const fix = await loadFixture(deploySatoriFixture);
    ({ satori, voting, rewards, bounties, registry, owner, signers } = fix);
    [, alice, bob, carol, dave, refA] = signers;

    const INITIAL_MINT = await satori.INITIAL_MINT();
    await satori.transfer(alice.address, (INITIAL_MINT * 45n) / 100n);
    await satori.transfer(bob.address, (INITIAL_MINT * 225n) / 1000n);
    await satori.transfer(carol.address, (INITIAL_MINT * 135n) / 1000n);
    await satori.transfer(dave.address, (INITIAL_MINT * 9n) / 100n);

    // Admin-created sub-round (720-minute) stream: the stream is scaffolding
    // here (the subject is claim delegation), so keep the fast rhythm. `satori`
    // is connected to `owner`, who is rewards.admin() and so exempt from the
    // public round-length floor.
    const tx1 = await satori["createSimpleDataStream(string,address,uint24)"]("Stream 1", owner.address, 720);
    stream1 = await getStreamId(tx1, satori);

    await voteFor(satori, alice, stream1);
    await voteFor(satori, bob, stream1);
    await advanceOneDay();
  });

  // -------------------------------------------------------------------------
  // MED: an unreferred earner's bucket is already NET (the 1% was skimmed to
  //      marketing at credit time), so the delegated claim mints it whole with
  //      no further cut and no ReferralPaid at claim. (There is no self-referral
  //      opt-out anymore — everyone pays the 1%, at credit time.)
  // -------------------------------------------------------------------------
  describe("unreferred earner, delegated claim path", function () {
    it("delegate claim mints the full (already-net) bucket, no ReferralPaid at claim", async function () {
      // alice sets NO referral; her 1% already went to marketing at settle, so
      // unclaimedRewards[alice] is net. The delegated claim takes nothing more.
      await buildRewards(satori, registry, alice, stream1);
      await satori.connect(alice).delegateClaimAbility(bob.address);

      const gross = await rewards.unclaimedRewards(alice.address);
      expect(gross).to.be.gt(0n);

      const carolBefore = await satori.balanceOf(carol.address);
      const supplyBefore = await satori.totalSupply();
      const round = await satori.getCurrentRound();

      const tx = satori.connect(bob)["claimFor(address,address)"](alice.address, carol.address);

      await expect(tx)
        .to.emit(rewards, "RewardsClaimed")
        .withArgs(alice.address, carol.address, gross, round);
      await expect(tx).to.not.emit(rewards, "ReferralPaid");

      // Recipient received the FULL net bucket (no 1% AT CLAIM — already skimmed).
      expect((await satori.balanceOf(carol.address)) - carolBefore).to.equal(gross);
      // Only alice's net bucket is minted here; the marketing cut sits unclaimed.
      expect((await satori.totalSupply()) - supplyBefore).to.equal(gross);
    });
  });

  // -------------------------------------------------------------------------
  // MED: re-pointing the delegate is immediate (no cooldown) — delegate
  //      rotation. Stale delegate is locked out, new delegate succeeds.
  // -------------------------------------------------------------------------
  describe("delegate rotation immediacy (no cooldown)", function () {
    it("after re-delegate bob->carol, bob's claimFor reverts Unauthorized and carol's succeeds same round", async function () {
      await buildRewards(satori, registry, alice, stream1);

      await satori.connect(alice).delegateClaimAbility(bob.address);
      // Rotate to carol in the same round — pure pointer overwrite, no cooldown.
      await satori.connect(alice).delegateClaimAbility(carol.address);

      // Pointer reflects the rotation immediately.
      expect(await rewards.claimDelegateInfo(alice.address)).to.equal(carol.address);

      // Stale delegate (bob) can no longer claim.
      await expect(
        satori.connect(bob)["claimFor(address,address)"](alice.address, bob.address)
      ).to.be.revertedWithCustomError(rewards, "Unauthorized");

      // New delegate (carol) claims in the SAME round to dave.
      const gross = await rewards.unclaimedRewards(alice.address);
      expect(gross).to.be.gt(0n);
      const daveBefore = await satori.balanceOf(dave.address);

      await expect(
        satori.connect(carol)["claimFor(address,address)"](alice.address, dave.address)
      ).to.not.be.reverted;

      expect((await satori.balanceOf(dave.address)) - daveBefore).to.equal(gross);
    });
  });

  // -------------------------------------------------------------------------
  // MED: claimFor idempotency — second delegated claim after drain is a no-op.
  // -------------------------------------------------------------------------
  describe("delegated claim idempotency", function () {
    it("a second claimFor after the bucket is drained mints nothing and emits amount 0", async function () {
      await rewards.connect(alice).setReferral(refA.address);
      await buildRewards(satori, registry, alice, stream1);
      await satori.connect(alice).delegateClaimAbility(bob.address);

      const gross = await rewards.unclaimedRewards(alice.address);
      expect(gross).to.be.gt(0n);

      // First claim drains the bucket.
      await satori.connect(bob)["claimFor(address,address)"](alice.address, bob.address);
      expect(await rewards.unclaimedRewards(alice.address)).to.equal(0n);

      const supplyBefore = await satori.totalSupply();
      const refABefore = await satori.balanceOf(refA.address);
      const carolBefore = await satori.balanceOf(carol.address);
      const round = await satori.getCurrentRound();

      // Second claim: clean no-op.
      const tx = satori.connect(bob)["claimFor(address,address)"](alice.address, carol.address);
      await expect(tx)
        .to.emit(rewards, "RewardsClaimed")
        .withArgs(alice.address, carol.address, 0n, round);
      await expect(tx).to.not.emit(rewards, "ReferralPaid");

      expect(await satori.totalSupply()).to.equal(supplyBefore);
      expect(await satori.balanceOf(refA.address)).to.equal(refABefore);
      expect(await satori.balanceOf(carol.address)).to.equal(carolBefore);
    });
  });

  // -------------------------------------------------------------------------
  // MED: delegateClaimAbility(self) with no prior delegate is a harmless no-op.
  // -------------------------------------------------------------------------
  describe("idempotent revoke when never delegated", function () {
    it("self-delegate with no delegate set leaves owner able to self-claim", async function () {
      await buildRewards(satori, registry, alice, stream1);

      // No delegate was ever set. Revoking to self is a no-op overwrite.
      await satori.connect(alice).delegateClaimAbility(alice.address);
      expect(await rewards.claimDelegateInfo(alice.address)).to.equal(alice.address);

      const gross = await rewards.unclaimedRewards(alice.address);
      expect(gross).to.be.gt(0n);
      const before = await satori.balanceOf(alice.address);

      // Self-pointer is treated as no-delegation by the auth check: self-claim
      // must succeed (no ClaimDelegatedAway).
      await expect(satori.connect(alice)["claim()"]()).to.not.be.reverted;
      expect((await satori.balanceOf(alice.address)) - before).to.equal(gross);
    });
  });

  // -------------------------------------------------------------------------
  // CONTRACT CHANGE: platform-fee recipient is IMMUTABLE post-deploy.
  // -------------------------------------------------------------------------
  describe("immutable platform-fee recipient", function () {
    it("rewards exposes no platform-fee recipient and no setter", async function () {
      // platform fee moved to immutable token (see test/next/DevFee.test.js): the
      // recipient is now the token's immutable PLATFORM_FEE_RECIPIENT (set once at
      // deploy) — rewards no longer carries it.
      // No setter exists for either the recipient or any wire path.
      expect(rewards.interface.fragments.some(
        (f) => f.type === "function" && f.name === "setPlatformFeeRecipient"
      )).to.equal(false);
      expect(rewards.setPlatformFeeRecipient).to.equal(undefined);
      expect(rewards.interface.fragments.some(
        (f) => f.type === "function" && f.name === "wireFeeRecipient"
      )).to.equal(false);
      expect(rewards.wireFeeRecipient).to.equal(undefined);
    });

    // (Removed 2026-08-31 with the getter it pinned. `feeSlot` was dead storage
    //  kept only to hold slots in an already-deployed proxy; this tree targets a
    //  fresh deployment, so both are gone.)

  });
});
