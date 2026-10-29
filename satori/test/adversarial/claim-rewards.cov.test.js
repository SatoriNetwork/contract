/**
 * Adversarial COVERAGE — claim-rewards subsystem.
 *
 * Targets the high/med-priority coverage_gaps from
 * adversarial-findings/_raw_review.json (system == "claim-rewards") that are
 * NOT already pinned by an existing test and NOT the already-confirmed
 * dropped-payout finding (covered by adv_10_claim-rewards.test.js).
 *
 * Gaps covered here (all asserting DOCUMENTED INTENT, all expected GREEN):
 *
 *  A. per-round boosted-token list maintenance + unstake-gate semantics (med).
 *     rewards.md:90 says predictor bounty stake auto-compounds and unstake
 *     converts back to liquid; the v6 design (SatoriBounties.sol and
 *     the BountyUnstakeStakeLocked header) pins that `boostedTokensInRound` is a
 *     TELEMETRY list — the DEDUP'd set of distinct bounty tokens the user
 *     snapshotted in a round, appended in applyBoost at predict time and cleared
 *     only once ALL of the user's predictions for that round finalize — while the
 *     ACTUAL unstake gate is the per-token round lock `stakeLockedUntil`, NOT the
 *     list. These tests pin that contract: the list is maintained correctly
 *     (one entry per distinct token, deduped, untouched by unstake, cleared on
 *     full settle), and the round lock (not the list) is what gates unstake.
 *
 *  B. Claimable view vs recipient/referral routed parity WITH a referral set
 *     (med). rewards.md:78-80,114-128 + ECONOMIC_CLAIMS, under EAGER CREDIT:
 *     the 5% referral cut is skimmed at CREDIT time (per reward credit, floored),
 *     credited straight to the referral's own `unclaimedRewards` bucket, and
 *     `ReferralPaid` is emitted THEN — not at the referred user's claim.
 *     `getTotalClaimableRewards` therefore returns the NET (already-skimmed)
 *     bucket; the referred user's claim mints their full net bucket and routes
 *     NOTHING to the referral, who claims their accumulated cut separately.
 *     Conservation still holds exactly at the total level:
 *     `alice_net_bucket + referral_cut_bucket == gross`, where `gross` is the
 *     pre-skim total reconstructed from both buckets. The ClaimableBreakdownAccuracy
 *     parity test never sets a referral, so this routing is unpinned for the
 *     breakdown/view path.
 *
 *  C. claimFor referral attribution (med, intent rewards.md:126): the referral
 *     is read from the OWNER, not from the calling claim delegate. Under eager
 *     credit the owner's cut is credited to the OWNER's referral's bucket at
 *     earn time; the delegate's referral never receives anything.
 */

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture, pack1 , warmUpStreak, voteFor } = require("../fixtures");
const { onChainGrossOf } = require("../helpers/onChainGross");

const UP = 1;

async function deployMockToken(symbol = "USDC") {
  const M = await ethers.getContractFactory("MockERC20");
  const t = await M.deploy(symbol, symbol);
  await t.waitForDeployment();
  return t;
}

async function advanceOneDay() { await time.increase(86400); }

// Membership check: is `tokenAddr` in the user's dedup'd boosted-token list
// for `round`? Replaces the old per-(user,token) pending boolean.
async function boostedInRound(bounties, user, tokenAddr, round) {
  const n = await bounties.boostedTokenCountInRound(user.address, round);
  for (let i = 0n; i < n; i++) {
    const t = await bounties.boostedTokensInRound(user.address, round, i);
    if (t.toLowerCase() === tokenAddr.toLowerCase()) return true;
  }
  return false;
}

// `signer` must be the protocol ADMIN (the fixture's owner): these streams are
// scaffolding for the claim/bounty assertions below, so they stay on the fast
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

// ===========================================================================
// A. boostedTokensInRound telemetry + round-lock unstake gate
// ===========================================================================
describe("claim-rewards.cov A: boostedTokensInRound telemetry & round-lock unstake gate", function () {
  this.timeout(120000);

  let satori, rewards, bounties, registry;
  let alice, funder, authority;
  let s1, usd, usdAddr;

  beforeEach(async function () {
    const fix = await loadFixture(deploySatoriFixture);
    ({ satori, rewards, bounties, registry } = fix);
    [, alice, , funder, authority] = fix.signers;

    await satori.transfer(alice.address, ethers.parseEther("100"));
    await satori.transfer(authority.address, (await satori.streamBurn()) * 2n);

    s1 = await createStream(satori, fix.owner, "S1", authority.address);

    // audit C-2: a bounty boost needs a non-zero multiplier, so streak >= 1

    await warmUpStreak(satori, registry, authority, [alice], s1);
    // Burn voting: one 10-SATORI burn buys s1's game PERMANENT weight, so the
    // game stays eligible for every round below without re-voting.
    await voteFor(satori, alice, s1);

    usd = await deployMockToken("USDC");
    usdAddr = await usd.getAddress();

    await usd.mint(funder.address, ethers.parseEther("10000"));
    await usd.connect(funder).approve(await bounties.getAddress(), ethers.parseEther("10000"));
    // Posting a NON-SATORI bounty (first fund of this game+token pair) now charges
    // an upfront bountyBurn in SATORI from the funder; fund the funder for it.
    await satori.transfer(funder.address, await satori.bountyBurn());
    await bounties.connect(funder).fundBounty(
      s1, usdAddr, ethers.parseEther("1000"), ethers.parseEther("200")
    );

    await usd.mint(alice.address, ethers.parseEther("100"));
    await usd.connect(alice).approve(await bounties.getAddress(), ethers.parseEther("100"));
    await bounties.connect(alice).stakeBountyToken(usdAddr, ethers.parseEther("100"));
  });

  it("a boosted prediction appends the token to the round list (count 1) and arms the round lock at R+1", async function () {
    // Before any boosted predict the round list is empty for the upcoming round.
    const r0 = await satori.getCurrentRound();
    expect(await bounties.boostedTokenCountInRound(alice.address, r0)).to.equal(0n);

    await registry.connect(authority).setValue(s1, 100); // anchor A
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: s1, payload: pack1(UP) }]);
    const r = await satori.getCurrentRound();

    // Round list got one distinct token appended (SatoriBounties.applyBoost).
    expect(await bounties.boostedTokenCountInRound(alice.address, r)).to.equal(1n);
    expect(await boostedInRound(bounties, alice, usdAddr, r)).to.equal(true);
    // The ACTUAL unstake gate is the round lock, set to R+1.
    expect(await bounties.stakeLockedUntil(alice.address, usdAddr)).to.equal(r + 1n);
  });

  it("unstake is gated by the round lock, NOT by the round list: blocked at R, allowed at R+1 even while the list still holds the token", async function () {
    await registry.connect(authority).setValue(s1, 100);
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: s1, payload: pack1(UP) }]);
    const r = await satori.getCurrentRound();

    // While still in round R, unstake reverts with the round-lock error
    // (not anything related to the boosted-token list).
    await expect(
      bounties.connect(alice).unstakeBountyToken(usdAddr, ethers.parseEther("100"), alice.address)
    ).to.be.revertedWithCustomError(bounties, "StakeLocked");

    // Advance to R+1. The prediction is still unsettled, so the round list
    // STILL holds the token (count 1). Per the v6 design the round lock is the
    // only gate, so unstake must now succeed despite the list being non-empty.
    await advanceOneDay();
    expect(await bounties.boostedTokenCountInRound(alice.address, r)).to.equal(1n);

    await expect(
      bounties.connect(alice).unstakeBountyToken(usdAddr, ethers.parseEther("100"), alice.address)
    ).to.not.be.reverted;
    expect(await bounties.bountyStake(alice.address, usdAddr)).to.equal(0n);
    // Unstake does not touch the round list — payout reads the snapshot, not live stake.
    expect(await bounties.boostedTokenCountInRound(alice.address, r)).to.equal(1n);
    expect(await boostedInRound(bounties, alice, usdAddr, r)).to.equal(true);
  });

  it("settling the round's only prediction clears the round list back to empty (count 0)", async function () {
    await registry.connect(authority).setValue(s1, 100); // A
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: s1, payload: pack1(UP) }]);
    const r = await satori.getCurrentRound();
    expect(await bounties.boostedTokenCountInRound(alice.address, r)).to.equal(1n);

    // Drive the prediction to score: B then C, UP correct (C > B > A).
    await advanceOneDay();
    await registry.connect(authority).setValue(s1, 110); // B
    await advanceOneDay();
    await registry.connect(authority).setValue(s1, 120); // C
    await satori.settlePrediction(alice.address, s1);

    // Single prediction in the round -> settling it fully settles the round,
    // so clearRoundBountyList empties the list (SatoriBounties.clearRoundBountyList).
    expect(await bounties.boostedTokenCountInRound(alice.address, r)).to.equal(0n);
    expect(await boostedInRound(bounties, alice, usdAddr, r)).to.equal(false);
  });
});

// ===========================================================================
// B. Claimable view <-> recipient/referral minted parity WITH a referral set
// ===========================================================================
describe("claim-rewards.cov B: claimable view matches recipient+referral minted with a referral set", function () {
  this.timeout(120000);

  let satori, rewards, lens, registry;
  let alice, refAddr, authority;
  let s1;

  beforeEach(async function () {
    const fix = await loadFixture(deploySatoriFixture);
    ({ satori, rewards, lens, registry } = fix);
    [, alice, refAddr, , authority] = fix.signers;

    await satori.transfer(alice.address, ethers.parseEther("400"));
    await satori.transfer(authority.address, (await satori.streamBurn()) * 2n);

    s1 = await createStream(satori, fix.owner, "S1", authority.address);

    // audit C-2: a bounty boost needs a non-zero multiplier, so streak >= 1

    await warmUpStreak(satori, registry, authority, [alice], s1);
    // Burn voting: one 10-SATORI burn buys s1's game PERMANENT weight, so the
    // game stays eligible for every round below without re-voting.
    await voteFor(satori, alice, s1);
    await advanceOneDay();
  });

  // Drive a single winning prediction so unclaimedRewards[alice] > 0.
  async function earn() {
    await registry.connect(authority).setValue(s1, 100); // A
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: s1, payload: pack1(UP) }]);

    await advanceOneDay();
    await registry.connect(authority).setValue(s1, 150); // B
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: s1, payload: pack1(UP) }]);

    await advanceOneDay();
    await registry.connect(authority).setValue(s1, 200); // C — scores the R prediction
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: s1, payload: pack1(UP) }]);
  }

  it("eager credit routes the 5% cut to the referral's bucket at settle; claim mints alice's full net; net + refCut == gross; ReferralPaid fired at credit time", async function () {
    await rewards.connect(alice).setReferral(refAddr.address);

    // Under eager credit the referral cut is emitted at SETTLE time, not at
    // claim time. Capturing every ReferralPaid to (alice -> refAddr) during
    // earn lets us pin the credit-time semantics AND cross-check the bucket.
    let emittedCut = 0n;
    const filter = rewards.filters.ReferralPaid(alice.address, refAddr.address);
    const fromBlock = await ethers.provider.getBlockNumber();
    await earn();
    const events = await rewards.queryFilter(filter, fromBlock);
    expect(events.length).to.be.gt(0, "ReferralPaid must be emitted at credit/settle time");
    for (const ev of events) emittedCut += ev.args.amount;

    // View returns the NET bucket (already skimmed at credit time).
    const aliceNet = (await lens.getTotalClaimableRewards(alice.address))[0];
    expect(aliceNet).to.be.gt(0n, "alice should have net rewards after the skim");
    expect(aliceNet).to.equal(await rewards.unclaimedRewards(alice.address));

    // The referral cut sits in the referral's OWN bucket, claimable separately.
    const refCut = await rewards.unclaimedRewards(refAddr.address);
    expect(refCut).to.be.gt(0n, "cut must be non-trivial for a meaningful parity check");
    // The events sum exactly to the accrued cut bucket (nothing else feeds it).
    expect(emittedCut).to.equal(refCut);

    // Conservation against an INDEPENDENT gross.
    //
    // WHY THIS IS NOT `const gross = aliceNet + refCut`: with `aliceMinted ==
    // aliceNet` and `refMintedOwn == refCut` already pinned below, comparing
    // `aliceMinted + refMintedOwn` to a gross DEFINED as `aliceNet + refCut`
    // reduces to `x == x` (P1 self-referential conservation) — unreachable-to-
    // fail, and blind to the exact escape A_rewards.md:139 forbids (crediting the
    // earner the full amount AND paying the referral on top). So the gross is
    // anchored on the ROUND BUDGET, read live off the token's own dev rate:
    // onChainGross = residual - residual * offchainShareBps / 10000, ALL of which
    // is now distributable to predictors: the first-predictor bonus reservation
    // and the value-provider cut were both removed, so the whole on-chain gross
    // is the single skimmable pool that alice — the sole predictor — wins.
    // From the HUB's schedule. The token's 1440 is the outer envelope, not the
    // rate — sizing a pool from it over-states the round.
    const onChainGross = (await onChainGrossOf(satori, rewards));
    const roundPool = onChainGross; // the SKIMMED base == the whole gross
    const gross = roundPool;
    expect(roundPool).to.be.gt(0n); // the anchor itself must be non-trivial

    // The cut is a true floored 5% of the SKIMMED base.
    expect(refCut).to.equal((roundPool * 500n) / 10000n);

    const aliceBefore = await satori.balanceOf(alice.address);
    const refBefore = await satori.balanceOf(refAddr.address);

    // Alice's claim mints her WHOLE net bucket and routes NOTHING to the
    // referral (the cut was already credited eagerly). No ReferralPaid here.
    await expect(satori.connect(alice)["claim()"]())
      .to.not.emit(rewards, "ReferralPaid");

    const aliceMinted = (await satori.balanceOf(alice.address)) - aliceBefore;
    const refMintedOnAliceClaim = (await satori.balanceOf(refAddr.address)) - refBefore;

    expect(aliceMinted).to.equal(aliceNet, "alice is minted her full net bucket");
    expect(refMintedOnAliceClaim).to.equal(0n, "referral gets nothing at the referred user's claim");

    // The referral claims its own accrued cut separately.
    const refBeforeOwn = await satori.balanceOf(refAddr.address);
    await satori.connect(refAddr)["claim()"]();
    const refMintedOwn = (await satori.balanceOf(refAddr.address)) - refBeforeOwn;
    expect(refMintedOwn).to.equal(refCut, "referral claims exactly its accrued 5% cut");

    // Redistribution, not inflation: total minted across recipient + referral
    // equals the budget-derived gross exactly — no more, no less.
    expect(aliceMinted + refMintedOwn).to.equal(gross);
  });

  it("no referral set: the 5% still skims to marketing at credit time; alice's claim mints her full net; net + marketingCut == gross", async function () {
    const marketing = await rewards.marketingFeeRecipient();
    const mktBefore = await rewards.unclaimedRewards(marketing);

    // With no referral the skim routes to MARKETING_FEE_RECIPIENT, and
    // ReferralPaid(alice, marketing, cut) is emitted at each credit/settle.
    const filter = rewards.filters.ReferralPaid(alice.address, marketing);
    const fromBlock = await ethers.provider.getBlockNumber();
    await earn();
    const events = await rewards.queryFilter(filter, fromBlock);
    expect(events.length).to.be.gt(0, "skim must route to marketing when no referral is set");
    let emittedCut = 0n;
    for (const ev of events) emittedCut += ev.args.amount;

    // The marketing bucket grew by exactly the sum of those emitted cuts.
    const marketingCut = (await rewards.unclaimedRewards(marketing)) - mktBefore;
    expect(marketingCut).to.be.gt(0n, "the 5% must still be skimmed to marketing");
    expect(marketingCut).to.equal(emittedCut);

    // View returns alice's NET bucket (already skimmed).
    const net = (await lens.getTotalClaimableRewards(alice.address))[0];
    expect(net).to.be.gt(0n);
    expect(net).to.equal(await rewards.unclaimedRewards(alice.address));

    const before = await satori.balanceOf(alice.address);
    await satori.connect(alice)["claim()"]();
    const minted = (await satori.balanceOf(alice.address)) - before;
    // Alice is minted her whole net bucket — nothing extra, nothing withheld.
    expect(minted).to.equal(net);

    // Conservation: net + marketingCut reconstructs the pre-skim gross. The cut
    // is the sum of per-credit 5% floors, so it never exceeds gross*500/10000.
    const gross = net + marketingCut;
    expect(marketingCut).to.be.lte(gross * 500n / 10000n);
  });
});

// ===========================================================================
// C. claimFor reads the referral from the OWNER, not the calling delegate
// ===========================================================================
describe("claim-rewards.cov C: claimFor referral attribution is owner-scoped", function () {
  this.timeout(120000);

  let satori, rewards, lens, registry;
  let alice, ownerRef, delegateRef, claimDelegate, authority;
  let s1;

  beforeEach(async function () {
    const fix = await loadFixture(deploySatoriFixture);
    ({ satori, rewards, lens, registry } = fix);
    [, alice, ownerRef, delegateRef, claimDelegate, authority] = fix.signers;

    await satori.transfer(alice.address, ethers.parseEther("400"));
    await satori.transfer(authority.address, (await satori.streamBurn()) * 2n);

    s1 = await createStream(satori, fix.owner, "S1", authority.address);

    // audit C-2: a bounty boost needs a non-zero multiplier, so streak >= 1

    await warmUpStreak(satori, registry, authority, [alice], s1);
    // Burn voting: one 10-SATORI burn buys s1's game PERMANENT weight, so the
    // game stays eligible for every round below without re-voting.
    await voteFor(satori, alice, s1);
    await advanceOneDay();
  });

  async function earn() {
    await registry.connect(authority).setValue(s1, 100);
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: s1, payload: pack1(UP) }]);

    await advanceOneDay();
    await registry.connect(authority).setValue(s1, 150);
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: s1, payload: pack1(UP) }]);

    await advanceOneDay();
    await registry.connect(authority).setValue(s1, 200);
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: s1, payload: pack1(UP) }]);
  }

  it("the OWNER's referral accrues the cut (at credit time); the claim delegate's referral is irrelevant on claimFor", async function () {
    // Owner (alice) sets her referral; the claim delegate sets a DIFFERENT
    // referral. The delegate must not be able to redirect alice's cut.
    await rewards.connect(alice).setReferral(ownerRef.address);
    await rewards.connect(claimDelegate).setReferral(delegateRef.address);

    // Alice delegates claim ability to claimDelegate.
    await satori.connect(alice).delegateClaimAbility(claimDelegate.address);

    await earn();

    // Under eager credit the cut was already skimmed at settle to the OWNER's
    // referral bucket, keyed off alice's referral (ownerRef) — NOT the delegate's.
    const aliceNet = (await lens.getTotalClaimableRewards(alice.address))[0];
    expect(aliceNet).to.be.gt(0n);
    expect(aliceNet).to.equal(await rewards.unclaimedRewards(alice.address));

    const ownerRefCut = await rewards.unclaimedRewards(ownerRef.address);
    expect(ownerRefCut).to.be.gt(0n, "owner's referral accrued the 5% cut");
    // The delegate's referral is completely unrelated to alice's earnings.
    expect(await rewards.unclaimedRewards(delegateRef.address)).to.equal(0n);

    const ownerRefBefore = await satori.balanceOf(ownerRef.address);
    const delegateRefBefore = await satori.balanceOf(delegateRef.address);
    const recipientBefore = await satori.balanceOf(alice.address);

    // Claim delegate triggers the claim, paying alice. This mints ONLY alice's
    // own net bucket; neither referral is paid at this claim (the cut was
    // credited eagerly and each bucket is claimed by its owner).
    await satori.connect(claimDelegate).claimFor(alice.address, alice.address);

    const ownerRefMinted = (await satori.balanceOf(ownerRef.address)) - ownerRefBefore;
    const delegateRefMinted = (await satori.balanceOf(delegateRef.address)) - delegateRefBefore;
    const recipientMinted = (await satori.balanceOf(alice.address)) - recipientBefore;

    // The delegate's referral got nothing; alice's claimFor mints alice's net.
    expect(delegateRefMinted).to.equal(0n);
    expect(ownerRefMinted).to.equal(0n, "referral is not paid at the referred user's claim");
    expect(recipientMinted).to.equal(aliceNet);

    // The owner's referral claims its own accrued cut separately, and it is
    // exactly the amount that was skimmed off alice's earnings.
    const ownerRefBeforeOwn = await satori.balanceOf(ownerRef.address);
    await satori.connect(ownerRef)["claim()"]();
    const ownerRefMintedOwn = (await satori.balanceOf(ownerRef.address)) - ownerRefBeforeOwn;
    expect(ownerRefMintedOwn).to.equal(ownerRefCut);
    // The delegate's referral never earned anything to claim.
    expect((await lens.getTotalClaimableRewards(delegateRef.address))[0]).to.equal(0n);

    // Conservation: alice's net + the owner-referral cut reconstruct the gross.
    // Same P1 fix as section B — `gross` used to be defined as
    // `aliceNet + ownerRefCut`, which made the line below `x == x` once
    // `recipientMinted == aliceNet` and `ownerRefMintedOwn == ownerRefCut` were
    // pinned above. Anchor it on the round budget instead.
    // From the HUB's schedule. The token's 1440 is the outer envelope, not the
    // rate — sizing a pool from it over-states the round.
    const onChainGross = (await onChainGrossOf(satori, rewards));
    // No first-predictor bonus and no value-provider cut any more: the whole
    // on-chain gross is the skimmable pool alice wins as sole predictor.
    const roundPool = onChainGross;
    const gross = roundPool;
    expect(roundPool).to.be.gt(0n);
    expect(ownerRefCut).to.equal((roundPool * 500n) / 10000n);
    expect(recipientMinted + ownerRefMintedOwn).to.equal(gross);
  });
});
