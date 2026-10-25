/**
 * ADVERSARIAL — OLD SUBSYSTEMS UNDER THE NEW EMISSION MODEL
 * ========================================================
 *
 * Round 1 exercised each NEW feature in isolation (referral skim; off-chain
 * dial / Merkle lanes; predict-logic module; airdrop; a cross-feature e2e).
 * This suite attacks the SEAMS: does every PRE-EXISTING subsystem still behave
 * correctly when the dial is live (offchainBudget > 0 → on-chain gross scaled
 * DOWN), a Merkle root is banking reserve, and the referral skim is diverting
 * 5%?
 *
 * The single load-bearing question for most attacks: every derived on-chain
 * quantity (the predictor pools) is supposed to RE-BASE to the round's FROZEN
 * on-chain gross (`TOKENS_PER_ROUND − devRateNow − offchainBudget`, i.e. the
 * residual after the senior dev fee, minus the dial), not to the
 * raw `TOKENS_PER_ROUND`. (The platform fee no longer re-bases here — it moved
 * to the immutable token as a senior, off-budget dev fee; see
 * test/next/DevFee.test.js.) If any subsystem forgot to re-base, conservation to
 * gross breaks — the round either over-mints (breaks the lane cap) or strands
 * wei.
 *
 * Angle scoping vs round 1: round-1 files (referral-break / dial-merkle-break /
 * cross-feature-break / predict-module-break / airdrop-break) tested the new
 * features standalone; cross-feature-break's ATTACK 5 checked delegator-skim
 * CONSERVATION at a single point. Here we go at the *interaction math* of each
 * OLD subsystem with the dial+skim: predictor-pool conservation TO GROSS,
 * delegate/delegator DOUBLE-independent-skim, bounty referral-EXEMPTION under a
 * live dial, and burn-vote weight math being invariant to the dial.
 *
 * ---------------------------------------------------------------------------
 * MIGRATION NOTE (burn voting). Three seams were DELETED, not weakened, because
 * their whole subject was removed from the protocol:
 *
 *   SEAM 2 (already gone) — the platform fee's per-round re-base; the fee moved
 *     to the immutable SatoriToken (test/next/DevFee.test.js).
 *   SEAM 4 — the default-stream ADDITIVE cut and its top-dog guard
 *     (`accrueDefaultStreamCut`, `getMaxWeightAtRound`). The default game no
 *     longer takes a cut of anything: its weight is DERIVED (20% of every other
 *     game's burnt weight, floored at 1e18), it cannot be voted on, and nothing
 *     is minted to the core on flush. There is no additive mint left to bound
 *     against the lane ceiling, and no guard to fire.
 *   SEAM 5 — the first-predictor bonus at extreme dial. The bonus and its
 *     budget reservation were both removed, so the payable round budget IS the
 *     on-chain gross and there is nothing to re-base or vanish. (The dial's
 *     effect on the pool itself is still covered by SEAM 1 and SEAM 7.)
 *
 * The provider cut is likewise gone (value providers are not paid at all), so
 * SEAM 1's conservation identity dropped its Σ(cuts) term — the FULL gross now
 * reaches predictors, which makes the identity strictly tighter than before.
 *
 * Convention: any real bug is encoded as it.skip("BUG: ...") with a repro so
 * the suite stays green. Everything else must pass.
 */

const { expect } = require("chai");
const {
  deploySatoriFixture,
  deploySatoriFixtureNoFee,
  deploySatoriFixtureWithFeeBps,
  RAW_TOLERANCE,
  pack1,
  warmUpStreak,
  VOTE,
  voteFor,
  voteRatio,
  } = require("../fixtures");
const {
  TEST_MARKETING_FEE_RECIPIENT,
  deployMerkleProxied,
} = require("../next/splitFixture");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const UP = 1;
// The old 4-arg overload carried the (now removed) valueProviderCutBps param.
const SIMPLE3 = "createSimpleDataStream(string,address,uint24)";
const TOKENS_PER_ROUND = ethers.parseEther("1440");
const MARKETING = TEST_MARKETING_FEE_RECIPIENT;
const REFERRAL_BPS = 500n;

const E = (n) => ethers.parseEther(String(n));
const referralCut = (amount) => (amount * REFERRAL_BPS) / 10000n; // floor(amount*500/10000)
const netOfCut = (amount) => amount - referralCut(amount);

// The per-round emission net of the senior dev fee — the RESIDUAL general lane
// the dial splits. The fee (a flat 15%) is carved FIRST on the immutable token
// (see test/next/DevFee.test.js) and can NEVER be dialed away.
//
// READ FROM THE HUB. This file used to write it out as 1152 (= 1440 − 288); the
// emission is the hub's decaying schedule now, so every dial figure below is
// expressed as a FRACTION of the residual rather than as a token literal.
let RESIDUAL;
let MAX_OFFCHAIN; // deepest legal dial → gross floor = 1 wei
async function loadResidual(satori) {
  RESIDUAL = (await satori.emissionRateNow()) - (await satori.devRateNow());
  MAX_OFFCHAIN = RESIDUAL - 1n;
}
// On-chain game gross when the dial routes `offchain` off-chain.
const grossOf = (offchain) => RESIDUAL - offchain;
// The dial that leaves `num/den` of the residual on-chain.
const dialLeaving = (num, den) => RESIDUAL - (RESIDUAL * num) / den;
// The PAYABLE round budget IS the on-chain gross: the first-predictor bonus
// that used to be reserved out of it was removed, and the platform fee moved
// off-budget to the token. Kept as a named function so the (now trivial)
// re-base relationship stays greppable.
const budgetOf = (gross) => gross;

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

function referralPaidEvents(receipt, rewards) {
  const out = [];
  for (const log of receipt.logs) {
    try {
      const p = rewards.interface.parseLog(log);
      if (p && p.name === "ReferralPaid") out.push(p.args);
    } catch {}
  }
  return out;
}

// Bare stack with a parameterised platform-fee bps and a merkle contract wired
// so the dial actually banks reserve (setOffchainBudget mirrors into core's
// merkle-reserve accumulator, which we can then observe). The default stream is
// initialised by the shared fixture itself (exactly as production deploys), so
// game id 1 is the default game and the first stream a test creates is id 2.
async function deployStack(platform, { feeBps = 0 } = {}) {
  // Restructured stack: SatoriToken (ERC20) + SatoriEngine (UUPS proxy) +
  // SatoriHub (ISatoriCore facade) + the existing children, wired by the shared
  // fixture and exposed as a monolith-shaped `satori` shim whose getAddress()
  // resolves to the HUB. The rewards admin is the deployer/owner (signer[0]),
  // matching this file's `owner` handle used to drive setOffchainBudget. The
  // platform-fee bps is chosen from the fee-variant fixtures.
  const fix =
    feeBps === 2000 ? await deploySatoriFixture()
    : feeBps === 0 ? await deploySatoriFixtureNoFee()
    : await deploySatoriFixtureWithFeeBps(feeBps);
  const { satori, voting, rewards, registry, games, bounties, lens } = fix;
  const addr = await satori.getAddress();

  // Merkle wiring (optional consumers). Not every test uses it, but wiring it
  // is harmless and lets the dial-under-old-subsystem tests observe the
  // reserve ceiling move.
  let merkle;
  try {
    merkle = await deployMerkleProxied(platform.address, fix.token.target);
    await merkle.setSatoriCore(addr);
    await satori.setSatoriMerkle(await merkle.getAddress());
  } catch (e) {
    merkle = undefined; // merkle wiring is best-effort; tests that need it assert on it
  }

  return { satori, voting, rewards, registry, games, bounties, merkle, lens };
}

// ===========================================================================
// SEAM 1 — PREDICTOR POOLS conservation UNDER A LIVE DIAL
//
// The headline safety identity is:
//   Σ(predictor credits) + Σ(referral skims) == the round's on-chain gross.
// Round 1 only ever proved this at offchainBudget==0 (gross == the residual). Here we
// re-run the SAME topology with the dial LIVE and assert the sum collapses to
// the *shrunk frozen gross*, not to 1440. If a predictor pool were still sized
// off TOKENS_PER_ROUND instead of the frozen gross, this sum would overshoot
// (an over-mint against the on-chain lane).
//
// It is tighter than the pre-burn-voting version of this seam: with the
// value-provider cut removed, there is no Σ(cuts) term absorbing part of the
// gross — every last wei of the round has to land in a predictor's or the
// marketing bucket.
// ===========================================================================
describe("SEAM 1: predictor-pool conservation re-bases to the shrunk gross", function () {
  this.timeout(180000);
  let satori, voting, rewards, registry, lens;
  let owner, alice, bob, carol, dave, eve, platform;

  // Leave 7/12 of the residual on-chain (what the old E(480) dial did to 1152).
  let OFFCHAIN, GROSS;

  beforeEach(async function () {
    [owner, alice, bob, carol, dave, eve, platform] = await ethers.getSigners();
    ({ satori, voting, rewards, registry, lens } = await deployStack(platform, { feeBps: 0 }));
    await loadResidual(satori);
    OFFCHAIN = dialLeaving(7n, 12n);
    GROSS = grossOf(OFFCHAIN);
    for (const s of [alice, bob, carol, dave, eve]) {
      await satori.transfer(s.address, E(100));
    }
    // Dial live for FUTURE rounds. Set before any round is touched so the
    // producing round freezes the shrunk gross.
    await rewards.connect(owner).setOffchainBudget(OFFCHAIN);
    await advanceRound();
  });

  it("Σ(predictor pools)+Σ(skims) == the frozen SHRUNK gross, NOT the full emission, with the dial live", async function () {
    // Games A and B will both be predicted; C carries burnt weight but is never
    // predicted, so it never enters the round denominator at all.
    const A = await streamIdFrom(await satori[SIMPLE3]("A", owner.address, 1440), satori);
    const B = await streamIdFrom(await satori[SIMPLE3]("B", owner.address, 1440), satori);
    const C = await streamIdFrom(await satori[SIMPLE3]("C", owner.address, 1440), satori);

    // Equal burnt weight on all three (10 each) — the denominator will still be
    // only A + B, because C is never predicted.
    await voteFor(satori, alice, A);
    await voteFor(satori, bob, B);
    await voteFor(satori, carol, C);
    expect(await voting.weightOf(A)).to.equal(VOTE);
    expect(await voting.weightOf(B)).to.equal(VOTE);
    expect(await voting.weightOf(C)).to.equal(VOTE);

    // Round R-1: seed values for A, B, C (nobody predicts yet).
    await registry.setValue(A, 100);
    await registry.setValue(B, 100);
    await registry.setValue(C, 100);
    await advanceRound(); // -> R

    // Round R: A and B produce and are predicted; C stays quiet.
    const mktBefore = await rewards.unclaimedRewards(MARKETING);
    await registry.setValue(A, 110);
    await registry.setValue(B, 110);

    await satori.connect(dave).predictMultipleWithPayloads([{ gameId: A, payload: pack1(UP) }]);
    await satori.connect(eve).predictMultipleWithPayloads([{ gameId: A, payload: pack1(UP) }]);
    await satori.connect(bob).predictMultipleWithPayloads([{ gameId: B, payload: pack1(UP) }]);
    const roundR = await satori.getCurrentRound();

    await advanceRound();
    await registry.setValue(A, 120);
    await registry.setValue(B, 120);
    await advanceRound();
    await registry.setValue(A, 130);
    await registry.setValue(B, 130);
    await satori.settlePrediction(dave.address, A);
    await satori.settlePrediction(eve.address, A);
    await satori.settlePrediction(bob.address, B);

    // The denominator is ACCUMULATED from the games actually predicted in R:
    // A and B only. C's burnt weight is real but never joined the round.
    const denom = await voting.roundDenominator(roundR);
    expect(await voting.getGameVotesAtRound(A, roundR)).to.equal(VOTE);
    expect(await voting.getGameVotesAtRound(B, roundR)).to.equal(VOTE);
    expect(await voting.getGameVotesAtRound(C, roundR)).to.equal(0n);
    expect(denom).to.equal(VOTE * 2n);

    // Budget RE-BASED to the shrunk gross (the budget IS the gross now):
    const budget = budgetOf(GROSS);
    const poolA = (budget * VOTE) / denom; // == floor(budget/2)
    const poolB = (budget * VOTE) / denom; // == floor(budget/2)
    // Integer division STRANDS, it never creates: an odd budget leaves one wei
    // unallocated. The old 672e18 gross was even, so this read as exact
    // equality; the hub's emission is not a round number and the wei showed up.
    expect(poolA + poolB).to.equal(budget - (budget % 2n));

    const daveClaim = (await lens.getTotalClaimableRewards(dave.address))[0];
    const eveClaim = (await lens.getTotalClaimableRewards(eve.address))[0];
    const bobClaim = (await lens.getTotalClaimableRewards(bob.address))[0];

    // dave + eve split A's pool (each skimmed 5% individually); bob takes B's.
    expect(daveClaim + eveClaim).to.be.closeTo(netOfCut(poolA), RAW_TOLERANCE);
    expect(bobClaim).to.be.closeTo(netOfCut(poolB), RAW_TOLERANCE);

    // Nobody set a referral, so every skim landed in the marketing bucket. That
    // delta is the EXACT total diverted (no provider cut exists to add more).
    const roundRSkim = (await rewards.unclaimedRewards(MARKETING)) - mktBefore;
    expect(roundRSkim).to.be.gt(0n);

    // HEADLINE: everything credited for round R sums to the SHRUNK gross, not
    // the full emission. If any pool had been sized off TOKENS_PER_ROUND, this
    // would overshoot it.
    const totalCredited = daveClaim + eveClaim + bobClaim + roundRSkim;
    expect(totalCredited).to.be.closeTo(GROSS, RAW_TOLERANCE);
    // And provably strictly LESS than the un-dialed residual (the dial shrank it).
    expect(totalCredited).to.be.lt(RESIDUAL);
    // The on-chain lane ceiling was never breached.
    expect(await satori.onChainMinted()).to.be.lte(await satori.onChainRewardCeiling());
  });
});

// ===========================================================================
// SEAM 2 — REMOVED. platform fee moved to immutable token (see
// test/next/DevFee.test.js).
//
// This seam pinned the PLATFORM FEE's per-round re-base to the frozen on-chain
// gross and its referral-exemption, via rewards.accrueProtocolFee() /
// rewards.PLATFORM_FEE_RECIPIENT(). The platform fee is no longer accrued in
// SatoriRewards at all — it moved into the immutable SatoriToken as a senior,
// self-accruing dev fee, is OFF-budget (never part of any reward split), and no
// longer re-bases to the dial. accrueProtocolFee() and rewards'
// PLATFORM_FEE_RECIPIENT() no longer exist. The dev fee's schedule + immutable
// recipient are covered by test/next/DevFee.test.js, so both tests here (which
// asserted specifically on the now-removed in-rewards fee behavior) are dropped.
// ===========================================================================

// ===========================================================================
// SEAM 3 — PREDICTION DELEGATION under the dial + skim: TWO INDEPENDENT skims
// (delegate's own share at score time; delegator's pull share at claim time),
// with the whole reward pool sized off the shrunk gross. Conservation to the
// pre-skim reward must hold, and neither share may be skimmed twice.
//
// Round 1's cross-feature ATTACK 5 checked only that the DELEGATOR's own claim
// conserves (net+cut==gross-of-that-share). Here we prove the DUAL-skim seam:
// the delegate's own portion and the delegator's portion are skimmed
// SEPARATELY and each exactly once, so the referral-diversion is neither
// double-applied nor skipped when a reward is SPLIT across a delegation
// boundary under a live dial.
//
// (Prediction delegation is untouched by the burn-voting refactor — it is VOTE
// delegation that was removed.)
// ===========================================================================
describe("SEAM 3: delegation split pays TWO independent 5% skims under the dial (no double, no skip)", function () {
  this.timeout(180000);
  let satori, rewards, registry, lens, owner, signers, platform;

  beforeEach(async function () {
    signers = await ethers.getSigners();
    [owner, , , , , , , platform] = signers;
    ({ satori, rewards, registry, lens } = await deployStack(signers[9], { feeBps: 0 }));
    await loadResidual(satori);
  });

  it("delegate own-share skim (score-time) + delegator pull-share skim (claim-time) each fire exactly once", async function () {
    const delegator = signers[1];
    const delegate = signers[2];
    const delRef = signers[3]; // delegator's referral
    const dgtRef = signers[4]; // delegate's referral
    const voter = signers[5];

    await rewards.connect(owner).setOffchainBudget(dialLeaving(23n, 48n)); // dial live → gross 23/48 of the residual

    await satori.transfer(delegator.address, E(60));
    await satori.transfer(delegate.address, E(10));
    await satori.transfer(voter.address, E(20));

    const s = await streamIdFrom(await satori[SIMPLE3]("S", owner.address, 1440), satori);
    // Burn voting: the voter destroys 10 SATORI to give `s` its weight. `s` is
    // the only game with weight, so it is the whole round denominator.
    await voteFor(satori, voter, s);
    await advanceRound();

    await satori.connect(delegator).delegatePredictionPower(delegate.address);
    await time.increase(86400);
    await rewards.connect(delegator).setReferral(delRef.address);
    await rewards.connect(delegate).setReferral(dgtRef.address);

    await registry.setValue(s, 100);
    // Delegate predicts, carrying own power + delegated power.
    const scoreTx = await settleDelegateWin(satori, registry, delegate, voter, s);

    // The delegate's OWN share was skimmed at score time → dgtRef got a cut.
    const dgtRefBucket = await rewards.unclaimedRewards(dgtRef.address);
    expect(dgtRefBucket).to.be.gt(0n); // proof the own-share skim fired

    // Exactly ONE ReferralPaid whose payer is the delegate (own share), and its
    // dest is the delegate's referral.
    const dgtPaid = scoreTx.filter(
      (e) => (e.earner ?? e[0]) === delegate.address
    );
    expect(dgtPaid.length).to.equal(1);
    expect(dgtPaid[0].referral ?? dgtPaid[0][1]).to.equal(dgtRef.address);

    // Now the DELEGATOR claims. Their pull-share is skimmed at claim time →
    // delRef gets a cut. Reconstruct: net minted + cut == the gross pull-share.
    const netView = (await lens.getTotalClaimableRewards(delegator.address))[0];
    expect(netView).to.be.gt(0n);
    const delRefBefore = await rewards.unclaimedRewards(delRef.address);
    const balBefore = await satori.balanceOf(delegator.address);
    const claimTx = await (await satori.connect(delegator)["claim()"]()).wait();
    const minted = (await satori.balanceOf(delegator.address)) - balBefore;
    const delCut = (await rewards.unclaimedRewards(delRef.address)) - delRefBefore;

    // View matched the mint; conservation of the pull-share across the skim.
    expect(minted).to.equal(netView);
    const pullGross = minted + delCut;
    expect(delCut).to.equal((pullGross * 500n) / 10000n);
    expect(minted).to.equal(pullGross - (pullGross * 500n) / 10000n);

    // Exactly ONE claim-time ReferralPaid whose payer is the DELEGATOR (not the
    // delegate — no double-skim on the same wei), routed to the delegator's ref.
    const delPaid = referralPaidEvents(claimTx, rewards).filter(
      (e) => (e.earner ?? e[0]) === delegator.address
    );
    expect(delPaid.length).to.equal(1);
    expect(delPaid[0].referral ?? delPaid[0][1]).to.equal(delRef.address);

    // Cross-check: the delegate's referral bucket did NOT grow during the
    // delegator's claim (the pull-share skim goes to the DELEGATOR's ref only).
    expect(await rewards.unclaimedRewards(dgtRef.address)).to.equal(dgtRefBucket);
  });

  it("THREE-WAY conservation: delegate-net + delegate-skim + delegator-net + delegator-skim == the whole pre-skim reward (no double, no loss), dial live", async function () {
    // Same topology but with NO referrals on either party, so BOTH the delegate's
    // own-share skim AND the delegator's pull-share skim route to the SAME
    // marketing bucket. We reconstruct the FULL pre-skim reward two ways and
    // assert they match: (delegate net) + (delegator net) + (marketing skim from
    // BOTH sides) == the total reward the round produced off the SHRUNK gross.
    // A double-application would inflate the marketing side; a skip would deflate
    // it — either way this identity would break.
    const delegator = signers[1];
    const delegate = signers[2];
    const voter = signers[5];

    await rewards.connect(owner).setOffchainBudget(E(600)); // gross 552, dial live

    await satori.transfer(delegator.address, E(60));
    await satori.transfer(delegate.address, E(10));
    await satori.transfer(voter.address, E(20));

    const s = await streamIdFrom(await satori[SIMPLE3]("S", owner.address, 1440), satori);
    await voteFor(satori, voter, s);
    await advanceRound();

    await satori.connect(delegator).delegatePredictionPower(delegate.address);
    // No referrals set → both skims land in the marketing bucket.

    const mktBefore = await rewards.unclaimedRewards(MARKETING);
    await registry.setValue(s, 100);
    await settleDelegateWin(satori, registry, delegate, voter, s);

    // Delegate's own net share (already credited at score time, net of its skim).
    const delegateNet = await rewards.unclaimedRewards(delegate.address);
    // Delegator's pull-share net (view is post-skim).
    const delegatorNet = (await lens.getTotalClaimableRewards(delegator.address))[0];
    // Realize the delegator's claim so its skim lands in marketing too.
    await satori.connect(delegator)["claim()"]();
    const mktAfter = await rewards.unclaimedRewards(MARKETING);
    const bothSkims = mktAfter - mktBefore;

    // The total reward the round produced (pre-skim) reconstructs exactly from
    // the two net shares plus the two skims — nothing minted twice, nothing lost.
    const totalPreSkim = delegateNet + delegatorNet + bothSkims;
    expect(totalPreSkim).to.be.gt(0n);

    // Independent upper bound: the reward earned can never exceed the round's
    // whole on-chain GROSS sized off the SHRUNK dial (552 == the payable
    // budget). If any share had been sized off TOKENS_PER_ROUND, this would
    // overshoot 552.
    const gross = grossOf(E(600)); // 552
    expect(totalPreSkim).to.be.lte(gross + RAW_TOLERANCE);
    // There is no skim-exempt component any more (the first-predictor bonus is
    // gone), so the skimmed base is the WHOLE reward. This proves the skim is
    // applied EXACTLY once over the whole split (delegate + delegator), never
    // doubled, never skipped.
    expect(bothSkims).to.be.closeTo((totalPreSkim * 500n) / 10000n, RAW_TOLERANCE);
  });
});

// Drive a delegate's UP win on `gameId` under an already-live dial, settled by
// `settler`. Returns the parsed ReferralPaid events from the settle receipt
// (where score-time credit fires).
async function settleDelegateWin(satori, registry, delegate, settler, gameId) {
  await satori
    .connect(delegate)
    .predictMultipleWithPayloads([{ gameId, payload: pack1(UP) }]);
  await advanceRound();
  await registry.setValue(gameId, 110);
  await advanceRound();
  await registry.setValue(gameId, 120); // UP wins
  const rewardsIface = (await ethers.getContractFactory("SatoriRewards")).interface;
  const tx = await satori.connect(settler).settlePrediction(delegate.address, gameId);
  const rc = await tx.wait();
  const out = [];
  for (const log of rc.logs) {
    try {
      const p = rewardsIface.parseLog(log);
      if (p && p.name === "ReferralPaid") out.push(p.args);
    } catch {}
  }
  return out;
}

// ===========================================================================
// SEAM 4 — DELETED (default-stream additive cut + top-dog guard).
//
// This seam bounded `accrueDefaultStreamCut`'s ADDITIVE `_rewardMint` to the
// core against the on-chain lane ceiling under a live dial, and asserted the
// top-dog guard (`getGameVotesAtRound(1, r) >= getMaxWeightAtRound(r)`) still
// fired off the shrunk gross. Under burn voting the default game takes NO cut
// at all: its weight is DERIVED (20% of every other game's burnt weight,
// floored at 1e18), `vote(1, ...)` reverts `CannotVoteDefault`, nothing is
// minted to the core on flush, and `getMaxWeightAtRound` no longer exists.
// There is no additive mint left to bound and no guard left to fire, so both
// cases were removed rather than reinterpreted. The derived-weight rule itself
// is covered by test/DefaultStream.test.js.
// ===========================================================================

// ===========================================================================
// SEAM 5 — DELETED (first-predictor bonus at extreme dial).
//
// This seam drove the bonus (`gross*0.5e18/720e18`) to its vanishing point at
// the deepest legal dial and proved reserved==credited==0. The bonus and its
// reservation in `_computeRoundBudget` were both removed — the payable budget
// IS the on-chain gross — so there is nothing left to re-base or floor to zero.
// SEAM 7's deepest-dial case still proves a full predict→settle cycle survives
// a 1-wei gross without reverting.
// ===========================================================================

// ===========================================================================
// SEAM 6 — BOUNTIES stay referral-EXEMPT under a live dial. Bounty payouts live
// entirely in ERC20-token space (bountyStake / unclaimedBounty), never routing
// through _creditReward, so no dial or skim can touch them. We prove a REAL
// bounty win pays out in the bounty ERC20 and moves NEITHER the SATORI
// marketing bucket NOR any SATORI referral bucket, with the dial live.
//
// Round 1's referral suite proved bounty exemption at dial 0. Here: dial live.
// ===========================================================================
describe("SEAM 6: a real bounty win stays referral-exempt (ERC20 space) with the dial live", function () {
  this.timeout(200000);
  let satori, voting, rewards, registry, games, bounties, owner, signers, platform;

  beforeEach(async function () {
    signers = await ethers.getSigners();
    [owner, , , , , , , platform] = signers;
    ({ satori, voting, rewards, registry, games, bounties } = await deployStack(platform, {
      feeBps: 2000, // 20% platform fee → bounty fee is HALF that (10%), so the
                    // ERC20 bounty-fee lane is non-zero and observable.
    }));
    await loadResidual(satori);
    // Align to a round boundary before any setValue so the registry's cadence
    // TIMESTAMP guard (minWaitTime ≈ 23.5h for an every-round stream) reliably
    // clears between the resolve-round updates.
    await advanceRound();
  });

  it("a real bounty win credits ERC20 space (bountyStake + fee), NOT any SATORI referral/marketing bucket, dial live", async function () {
    const staker = signers[1];
    const funder = signers[2];
    const voter = signers[3];
    const bref = signers[4]; // staker's SATORI referral
    const POT = E(1000);
    const RATE = E(200);

    await rewards.connect(owner).setOffchainBudget(dialLeaving(7n, 12n)); // dial → gross 7/12 of the residual
    // NEW timing: a dial set in round R freezes R at the OLD dial and only takes
    // effect from R+1. Advance one round so the dial is actually LIVE for the
    // round in which the staker predicts (predictRound below); otherwise that
    // round's predictor pool would still re-base to the unshrunk gross and
    // the ordinary SATORI referral skim (5% of the pool) would exceed 40.
    await advanceRound();
    await satori.transfer(staker.address, E(100));
    await satori.transfer(voter.address, E(100));
    // Give the staker a SATORI referral. If a bounty win (wrongly) routed through
    // _creditReward, 5% of the BOUNTY (in the bounty ERC20's units) could not even
    // be expressed in SATORI — but a leak would show as an inflated SATORI ref
    // bucket. It must stay purely the ordinary SATORI predictor skim.
    await rewards.connect(staker).setReferral(bref.address);

    // Mock ERC20 bounty token: MockERC20(name, symbol) + separate mint().
    const M = await ethers.getContractFactory("MockERC20");
    const token = await M.deploy("Bounty", "BTY");
    await token.waitForDeployment();
    const tokenAddr = await token.getAddress();

    // A weighted game at the every-round cadence (1440 minutes = one 24h round)
    // so the resolve setValues are never cadence-gapped; the wrapper
    // auto-creates its binary game (gameId==s).
    const s = await streamIdFrom(await satori[SIMPLE3]("S", owner.address, 1440), satori);
    await voteFor(satori, voter, s); // burn 10 SATORI → s is the only weighted game
    // audit C-2: streak 0 takes no bounty boost — warm the staker up before funding
    await warmUpStreak(satori, registry, owner, staker, s);

    // Fund a bounty on game s. Posting a NON-SATORI bounty (the first fund of a
    // (game, token) pair) now charges an upfront SATORI burn == bountyBurn(),
    // pulled from the funder via chargeBountyBurn. The funder makes exactly ONE
    // first-fund here, so give it exactly one bountyBurn() of SATORI (from owner,
    // who holds the initial supply). Read the getter at point of use — it grows
    // with protocol age.
    await satori.transfer(funder.address, await satori.bountyBurn());
    await token.mint(funder.address, E(100000));
    await token.connect(funder).approve(await bounties.getAddress(), E(100000));
    await bounties.connect(funder).fundBounty(s, tokenAddr, POT, RATE);

    // Staker stakes the bounty token so their winning prediction earns a share.
    await token.mint(staker.address, E(300));
    await token.connect(staker).approve(await bounties.getAddress(), E(300));
    await bounties.connect(staker).stakeBountyToken(tokenAddr, E(300));

    const mktBefore = await rewards.unclaimedRewards(MARKETING);
    const brefBefore = await rewards.unclaimedRewards(bref.address);
    const stakeBefore = await bounties.bountyStake(staker.address, tokenAddr);

    // Drive a winning boosted prediction (applyBoost auto-snapshots the stake).
    await registry.setValue(s, 100);
    const predictRound = Number(await satori.getCurrentRound());
    await satori.connect(staker).predictMultipleWithPayloads([{ gameId: s, payload: pack1(UP) }]);
    await advanceRound();
    await registry.setValue(s, 110);
    await advanceRound();
    await registry.setValue(s, 120); // UP wins
    const settleRc = await (await satori.settlePrediction(staker.address, s)).wait();

    // (1) The bounty win landed ENTIRELY in ERC20 space: the staker's bountyStake
    // grew. The old bounty PAYOUT fee is REMOVED — winners now take the FULL
    // dripped share and the fee recipient receives ZERO bounty tokens.
    const stakeEarned = (await bounties.bountyStake(staker.address, tokenAddr)) - stakeBefore;
    const dripped = await bounties.roundBountyPot(s, predictRound, tokenAddr);
    expect(dripped).to.equal(RATE); // virgin pool dripped RATE
    expect(stakeEarned).to.be.closeTo(dripped, E("0.01")); // winner takes the FULL share (ERC20 conservation)
    expect(stakeEarned).to.be.gt(0n); // a real win happened

    // (2) The bounty win did NOT emit a ReferralPaid FROM the bounty: any
    // ReferralPaid in the settle receipt is the ordinary SATORI predictor skim,
    // whose `cut` is at most 5% of the (shrunk) SATORI predictor pool — a SATORI
    // amount, never anything like the bounty's 200-token drip. Prove the staker's
    // SATORI referral bucket grew ONLY by the tiny ordinary predictor skim, i.e.
    // it is NOWHERE NEAR any slice of the 200-token bounty drip.
    const brefAfter = await rewards.unclaimedRewards(bref.address);
    const satoriRefSkim = brefAfter - brefBefore;
    // Ordinary predictor pool ≤ the shrunk gross for one game; 5% of that is a
    // rounding error beside the 200-token bounty drip.
    expect(satoriRefSkim).to.be.lt(grossOf(dialLeaving(7n, 12n)) / 20n + 1n);

    // (3) The SATORI marketing bucket did not absorb any bounty value either.
    const mktAfter = await rewards.unclaimedRewards(MARKETING);
    expect(mktAfter - mktBefore).to.be.lt(E(5));

    // (4) Positive proof the bounty ERC20 is quarantined from SATORI: the bounty
    // token balances of the SATORI rewards contract stay ZERO — bounty value
    // lives only in the bounties contract's custody and users' bountyStake.
    expect(await token.balanceOf(await rewards.getAddress())).to.equal(0n);

    // (5) The predictor's winnings COMPOUND into their bountyStake (ERC20 units),
    // not unclaimedRewards — so they are recovered via unstake (once unlocked),
    // never via a SATORI claim. We assert the structural invariant:
    // a SATORI claim by the staker mints SATORI only and never touches the bounty
    // ERC20 custody.
    const mktPreClaim = await rewards.unclaimedRewards(MARKETING);
    const brefPreClaim = await rewards.unclaimedRewards(bref.address);
    const bountiesErc20Before = await token.balanceOf(await bounties.getAddress());
    const satBalBefore = await satori.balanceOf(staker.address);
    // The staker's ordinary SATORI predictor win is claimable in SATORI. Claiming
    // it mints SATORI and leaves the bounty ERC20 custody untouched.
    await satori.connect(staker)["claim()"]();
    const satMinted = (await satori.balanceOf(staker.address)) - satBalBefore;
    expect(satMinted).to.be.gt(0n); // SATORI predictor win paid in SATORI
    // The bounty ERC20 custody is UNCHANGED by the SATORI claim (fully decoupled).
    expect(await token.balanceOf(await bounties.getAddress())).to.equal(bountiesErc20Before);
    // No new SATORI marketing/referral movement beyond what already happened at
    // score time (claim just mints the already-net bucket; the skim was taken
    // at credit time, so these buckets don't move on claim).
    expect(await rewards.unclaimedRewards(MARKETING)).to.equal(mktPreClaim);
    expect(await rewards.unclaimedRewards(bref.address)).to.equal(brefPreClaim);
    expect(settleRc.status).to.equal(1);
  });
});

// ===========================================================================
// SEAM 7 — BURN-VOTE WEIGHT / ELIGIBILITY math is INVARIANT to the dial. The
// dial scales the REWARD magnitude, not the vote-share denominators. So the
// SAME set of games earns, the SAME allocation FRACTIONS apply, and the pool
// shrinking toward zero at extreme dial never reverts, never divides by zero,
// and never mis-attributes weight. We prove: (a) at extreme dial (gross ~1 wei)
// a normal predict→settle cycle does not revert and mints only dust; (b) the
// per-round participating set and per-game weights are identical to what they
// would be at dial 0 (dial-independence of getEligibleGamesAtRound /
// getGameVotesAtRound).
//
// (The old "top-N" framing is gone with the heap: there is no threshold, no
// top-N and no cap — every enabled game with burnt weight earns in proportion.
// The property under test is unchanged: the dial must not perturb any of it.)
// ===========================================================================
describe("SEAM 7: burn-vote weight + allocation math is dial-invariant and safe as the pool → 0", function () {
  this.timeout(200000);
  let satori, voting, rewards, registry, lens, owner, signers, platform;

  beforeEach(async function () {
    signers = await ethers.getSigners();
    [owner, , , , , , , platform] = signers;
    ({ satori, voting, rewards, registry, lens } = await deployStack(platform, { feeBps: 0 }));
    await loadResidual(satori);
  });

  it("at the deepest legal dial (gross 1 wei), a full predict→settle cycle does not revert and re-bases to the shrunk gross (pool scaled down, not broken)", async function () {
    const p = signers[1];
    const voter = signers[2];
    await satori.transfer(p.address, E(50));
    await satori.transfer(voter.address, E(50));

    // The senior dev fee bounds the dial below the residual; the dial routes only
    // that residual off-chain, so the deepest legal dial shrinks the on-chain
    // gross to 1 wei (the fee's 15% is untouchable — see
    // test/next/DevFee.test.js). The pool re-bases DOWN to that gross; the cycle
    // must still not revert and stay cap-safe.
    await rewards.connect(owner).setOffchainBudget(MAX_OFFCHAIN); // gross 1 wei
    const GROSS = grossOf(MAX_OFFCHAIN); // 1 wei
    const s = await streamIdFrom(await satori[SIMPLE3]("S", owner.address, 1440), satori);
    await voteFor(satori, voter, s);
    await advanceRound();

    await registry.setValue(s, 100);
    // Must NOT revert at the shrunk budget (allocation scales down cleanly).
    await satori.connect(p).predictMultipleWithPayloads([{ gameId: s, payload: pack1(UP) }]);
    await advanceRound();
    await registry.setValue(s, 110);
    await advanceRound();
    await registry.setValue(s, 120);
    await satori.connect(voter).settlePrediction(p.address, s); // must not revert

    // The predictor's SATORI pool for the round re-based to the SHRUNK gross: it
    // is bounded by that gross (never the un-dialed 1440) and strictly smaller than
    // a full-gross round would pay — the dial genuinely shrank the pool. The claim
    // never breaches the on-chain lane ceiling.
    const claim = (await lens.getTotalClaimableRewards(p.address))[0];
    expect(claim).to.be.lte(GROSS);            // re-based to the shrunk gross, not 1440
    expect(claim).to.be.lt(TOKENS_PER_ROUND);  // the dial genuinely shrank the pool
    const onChainMinted = await satori.onChainMinted();
    const ceiling = await satori.onChainRewardCeiling();
    expect(onChainMinted).to.be.lte(ceiling);
  });

  it("the participating-game set and per-game burnt weights are IDENTICAL under a live dial and under no dial (dial affects reward magnitude only)", async function () {
    // Build the SAME topology twice: once dial-off, once dial-on, and compare
    // the per-round vote record the reward math reads. Because the dial only
    // scales magnitude, the sets and weights must match byte-for-byte.
    async function snapshotEligibility(offchain) {
      const [o, , , , , , , plat] = signers;
      const stack = await deployStack(plat, { feeBps: 0 });
      const { satori: sat, voting: vt, rewards: rw, registry: rg } = stack;
      const va = signers[1];
      await sat.transfer(va.address, E(30));
      if (offchain > 0n) await rw.connect(o).setOffchainBudget(offchain);

      const A = await streamIdFrom(await sat[SIMPLE3]("A", o.address, 1440), sat);
      const B = await streamIdFrom(await sat[SIMPLE3]("B", o.address, 1440), sat);
      const C = await streamIdFrom(await sat[SIMPLE3]("C", o.address, 1440), sat);
      // Burn in a 3:2:1 ratio — 6 SATORI total, leaving va plenty of prediction
      // power (power = balance + unclaimed, and burning destroys balance).
      await voteRatio(sat, va, [[A, 3], [B, 2], [C, 1]]);
      // Every game needs a fresh value this round to be predictable at all.
      await rg.setValue(A, 100);
      await rg.setValue(B, 100);
      await rg.setValue(C, 100);
      // One tx recording all three games into this round's participating set.
      await sat.connect(va).predictMultipleWithPayloads([
        { gameId: A, payload: pack1(UP) },
        { gameId: B, payload: pack1(UP) },
        { gameId: C, payload: pack1(UP) },
      ]);
      const round = await sat.getCurrentRound();
      await advanceRound();
      const elig = await vt.getEligibleGamesAtRound(round);
      const wA = await vt.getGameVotesAtRound(A, round);
      const wB = await vt.getGameVotesAtRound(B, round);
      const wC = await vt.getGameVotesAtRound(C, round);
      const denom = await vt.roundDenominator(round);
      return {
        elig: [...elig].map(Number).sort((x, y) => x - y),
        wA, wB, wC, denom,
      };
    }

    const off = await snapshotEligibility(0n);
    const on = await snapshotEligibility(dialLeaving(7n, 120n)); // aggressive dial → gross 7/120 of the residual

    // Sanity: the burns really did land in the 3:2:1 ratio.
    expect(off.wA).to.equal(E(3));
    expect(off.wB).to.equal(E(2));
    expect(off.wC).to.equal(E(1));
    expect(off.denom).to.equal(E(6));

    // Same participating set, same per-game weights, same denominator: the dial
    // did not perturb the burn-vote math at all.
    expect(on.elig).to.deep.equal(off.elig);
    expect(on.wA).to.equal(off.wA);
    expect(on.wB).to.equal(off.wB);
    expect(on.wC).to.equal(off.wC);
    expect(on.denom).to.equal(off.denom);
  });
});
