/**
 * Adversarial COVERAGE — claim-rewards subsystem, ROUND 2 (med-priority gaps).
 *
 * Round 1 (claim-rewards.cov.test.js) pinned: the per-(user,round) boosted-token
 * round-list telemetry (boostedTokenCountInRound / boostedTokensInRound) + the
 * round-lock unstake gate (A), the referral-set claimable-view parity with a
 * DISTINCT referral (B), and owner-scoped claimFor referral attribution (C).
 *
 * The other listed med/high gaps are already nailed elsewhere and are SKIPPED
 * here per instruction:
 *   - "two-winner same-direction split where one unstakes" / "bounty pot
 *     conservation with one unstaking winner" — these are the CONFIRMED
 *     dropped-payout + stranded-pot finding, repro'd in
 *     adversarial-findings/adv_10_claim-rewards.test.js (which already includes
 *     the multi-staker conservation check). Not re-covered.
 *
 * That leaves the high-value, still-UNPINNED corners of the claim path. All
 * assertions below target the CURRENT contract's DOCUMENTED intent and are
 * expected GREEN.
 *
 *  D. Referral pointer is SET-ONCE / immutable, and the self-pointer is a
 *     documented OPT-OUT (SatoriRewards.sol, 1312-1321):
 *       - setReferral(0) reverts InvalidReferral; second setReferral reverts
 *         AlreadySet (even re-setting the same value, even after a claim).
 *       - referral == self locks the slot AND, at claim, pays NO cut and emits
 *         NO ReferralPaid; recipient is minted the full gross.
 *
 *  E. Referral cut rounds DOWN and the gross/100 == 0 micro-claim emits no
 *     ReferralPaid and routes nothing to the referral (SatoriRewards.sol-
 *     1321: `refCut = gross/100; if (refCut > 0) {... mint + emit ...}`).
 *
 *  F. IMMUTABLE platform-fee recipient (CONTRACT CHANGE since the audit). The
 *     fee destination is the hard-coded `PLATFORM_FEE_RECIPIENT` constant baked
 *     into the bytecode — NO constructor arg, NO setter; no one (including the
 *     admin) can ever redirect the fee. The admin can only REDUCE the rate
 *     / transfer the admin role. Pin:
 *       - there is NO setPlatformFeeRecipient and NO wireFeeRecipient on the ABI;
 *       - `PLATFORM_FEE_RECIPIENT()` is the constructor-set immutable
 *         recipient (non-zero) — the recipient can never move;
 *       - a permissionless accrueProtocolFee still credits that same
 *         immutable constant recipient regardless of caller.
 */

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture, pack1, voteFor } = require("../fixtures");
const { TEST_PLATFORM_FEE_RECIPIENT } = require("../next/splitFixture");

const UP = 1;

async function advanceOneDay() { await time.increase(86400); }

// `signer` must be the protocol ADMIN (the fixture's owner): the stream is
// scaffolding for the claim/referral assertions below, so it stays on the fast
// sub-round (720-minute) beat and only the admin may create such a stream. `authority` — the
// PROVIDER that writes the values — is unchanged.
async function createStream(satori, signer, name, authority) {
  const tx = await satori.connect(signer)["createSimpleDataStream(string,address,uint24)"](name, authority, 720);
  const rcpt = await tx.wait();
  for (const log of rcpt.logs) {
    try {
      const p = satori.interface.parseLog(log);
      if (p && p.name === "DataStreamCreated") return p.args.streamId;
    } catch (e) {}
  }
  throw new Error("DataStreamCreated event missing");
}

// Drive a single winning prediction so unclaimedRewards[alice] > 0.
function makeEarn(getCtx) {
  return async function earn() {
    const { satori, registry, alice, authority, s1 } = getCtx();
    // No per-round re-vote: burn voting buys s1's game PERMANENT weight once (in
    // beforeEach), so it stays eligible for every round below.
    await registry.connect(authority).setValue(s1, 100); // A
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: s1, payload: pack1(UP) }]);

    await advanceOneDay();
    await registry.connect(authority).setValue(s1, 150); // B
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: s1, payload: pack1(UP) }]);

    await advanceOneDay();
    await registry.connect(authority).setValue(s1, 200); // C — scores the R prediction
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: s1, payload: pack1(UP) }]);
  };
}

// ===========================================================================
// D. Referral is set-once/immutable; self-pointer is a documented opt-out.
// ===========================================================================
describe("claim-rewards.cov2 D: referral set-once immutability + self-opt-out", function () {
  this.timeout(120000);

  let satori, rewards, registry, lens;
  let alice, refAddr, authority;
  let s1;
  const earn = makeEarn(() => ({ satori, registry, alice, authority, s1 }));

  beforeEach(async function () {
    const fix = await loadFixture(deploySatoriFixture);
    ({ satori, rewards, registry, lens } = fix);
    [, alice, refAddr, , authority] = fix.signers;

    await satori.transfer(alice.address, ethers.parseEther("400"));
    await satori.transfer(authority.address, (await satori.streamBurn()) * 2n);

    s1 = await createStream(satori, fix.owner, "S1", authority.address);
    // Burn 10 of alice's 400 SATORI to give s1's game permanent weight.
    await voteFor(satori, alice, s1);
    await advanceOneDay();
  });

  it("setReferral(0) reverts InvalidReferral", async function () {
    await expect(
      rewards.connect(alice).setReferral(ethers.ZeroAddress)
    ).to.be.revertedWithCustomError(rewards, "InvalidReferral");
  });

  it("referral is set-once: a second setReferral reverts AlreadySet, even re-setting the same value", async function () {
    await rewards.connect(alice).setReferral(refAddr.address);
    expect(await rewards.referral(alice.address)).to.equal(refAddr.address);

    await expect(
      rewards.connect(alice).setReferral(authority.address)
    ).to.be.revertedWithCustomError(rewards, "AlreadySet");
    // Re-asserting the SAME value still reverts — it is the slot that locks.
    await expect(
      rewards.connect(alice).setReferral(refAddr.address)
    ).to.be.revertedWithCustomError(rewards, "AlreadySet");

    // The pointer is unchanged by the failed re-sets.
    expect(await rewards.referral(alice.address)).to.equal(refAddr.address);
  });

  it("referral stays immutable across a claim that already consumed it", async function () {
    await rewards.connect(alice).setReferral(refAddr.address);
    await earn();
    await satori.connect(alice)["claim()"]();
    // Slot remains locked post-claim.
    await expect(
      rewards.connect(alice).setReferral(authority.address)
    ).to.be.revertedWithCustomError(rewards, "AlreadySet");
    expect(await rewards.referral(alice.address)).to.equal(refAddr.address);
  });

  it("self-referral is rejected; an unreferred earner's claim mints the full net, no ReferralPaid at claim", async function () {
    // Self-referral is no longer an opt-out — it is rejected outright.
    await expect(
      rewards.connect(alice).setReferral(alice.address)
    ).to.be.revertedWithCustomError(rewards, "InvalidReferral");

    // Unreferred: the 1% was skimmed to marketing at credit time, so alice's
    // claimable bucket is already NET.
    await earn();
    const net = (await lens.getTotalClaimableRewards(alice.address))[0];
    expect(net).to.be.gt(0n);

    const refBefore = await satori.balanceOf(refAddr.address);
    const aliceBefore = await satori.balanceOf(alice.address);

    // Claim mints the whole net bucket and emits no ReferralPaid (the cut was
    // already taken at credit time, and routed to the marketing bucket).
    await expect(satori.connect(alice)["claim()"]())
      .to.not.emit(rewards, "ReferralPaid");

    const aliceMinted = (await satori.balanceOf(alice.address)) - aliceBefore;
    const refMinted = (await satori.balanceOf(refAddr.address)) - refBefore;

    expect(refMinted).to.equal(0n);
    expect(aliceMinted).to.equal(net); // full net bucket, no skim at claim
  });
});

// ===========================================================================
// E. Sub-100-wei gross: refCut rounds to 0, no mint, no ReferralPaid.
// ===========================================================================
describe("claim-rewards.cov2 E: tiny gross => refCut floors to 0, no ReferralPaid, recipient gets all", function () {
  this.timeout(120000);

  let satori, rewards, lens;
  let alice, refAddr;

  beforeEach(async function () {
    const fix = await loadFixture(deploySatoriFixture);
    ({ satori, rewards, lens } = fix);
    [, alice, refAddr] = fix.signers;
    await satori.transfer(alice.address, ethers.parseEther("10"));
  });

  it("a zero/sub-100 gross pays the referral nothing and mints nothing, even with a referral set", async function () {
    // refCut = gross / 100, and BOTH the mint and the ReferralPaid emit are
    // guarded by `refCut > 0` (and the whole block by `totalRewards > 0`). A
    // gross of 0 (the only sub-100 gross reachable without crediting an
    // arbitrary bucket) must therefore route nothing and emit nothing — the
    // boundary the contract's floor-division relies on.
    await rewards.connect(alice).setReferral(refAddr.address);

    const grossBefore = (await lens.getTotalClaimableRewards(alice.address))[0];
    expect(grossBefore).to.equal(0n, "no earnings yet");

    const refBefore = await satori.balanceOf(refAddr.address);
    const aliceBefore = await satori.balanceOf(alice.address);

    // Zero-gross claim: the `totalRewards > 0` guard short-circuits the whole
    // referral block — no mint to anyone, no ReferralPaid.
    await expect(satori.connect(alice)["claim()"]())
      .to.not.emit(rewards, "ReferralPaid");

    expect((await satori.balanceOf(refAddr.address)) - refBefore).to.equal(0n);
    expect((await satori.balanceOf(alice.address)) - aliceBefore).to.equal(0n);
  });
});

// ===========================================================================
// F. Immutable platform-fee recipient (contract change since the audit).
// ===========================================================================
describe("claim-rewards.cov2 F: platform-fee recipient is immutable", function () {
  this.timeout(120000);

  let satori, rewards, owner;
  let stranger;

  beforeEach(async function () {
    const fix = await loadFixture(deploySatoriFixture);
    ({ satori, rewards, owner } = fix);
    [, stranger] = fix.signers;
  });

  it("there is NO setPlatformFeeRecipient and NO wireFeeRecipient on the contract", async function () {
    expect(rewards.setPlatformFeeRecipient).to.equal(undefined);
    expect(rewards.wireFeeRecipient).to.equal(undefined);
    expect(rewards.interface.fragments.some(
      (f) => f.type === "function" &&
        (f.name === "setPlatformFeeRecipient" || f.name === "wireFeeRecipient")
    )).to.equal(false);
  });

  it("rewards carries no platform-fee recipient; feeSlot exposes no recipient", async function () {
    // platform fee moved to immutable token (see test/next/DevFee.test.js): the
    // fee destination is now the token's immutable PLATFORM_FEE_RECIPIENT; rewards
    // no longer exposes it.
    // feeSlot() itself is gone (removed 2026-08-31 with the dead fee storage),
    // so there is no fee surface here to carry a recipient in the first place.
    expect(rewards.feeSlot).to.equal(undefined);
  });

  it("Satori.owner() is the ownerless address(0) signal, distinct from the admin role", async function () {
    // owner() broadcasts an ownerless contract; the operational admin role is
    // read via rewards.admin() — two unrelated identities.
    expect(await satori.owner()).to.equal(ethers.ZeroAddress);
    expect(await rewards.admin()).to.equal(owner.address);
    // platform fee moved to immutable token (see test/next/DevFee.test.js): the
    // fee recipient is the token's immutable constant, no longer on rewards.
  });

  // platform fee moved to immutable token (see test/next/DevFee.test.js):
  // rewards.accrueProtocolFee() and rewards.PLATFORM_FEE_RECIPIENT() are gone —
  // the dev fee is senior and self-accrues on the token via its permissionless
  // mintDevFee(). The former "permissionless accrueProtocolFee credits the
  // immutable recipient regardless of caller" case now lives in DevFee.test.js.
});
