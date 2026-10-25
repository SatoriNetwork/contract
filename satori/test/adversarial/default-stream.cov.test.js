// Adversarial COVERAGE for the default-stream subsystem.
//
// Targets the high/med-priority coverage gaps from
//   adversarial-findings/_raw_review.json -> systems[system=="default-stream"].
//
// BURN-VOTING REWRITE. The original file existed for the "Default Stream Cut &
// Top-Dog Guard" feedback loop: SatoriRewards.accrueDefaultStreamCut minted the
// default stream a 5% catch-up slice while it trailed the heap leader, and
// _computeReward deducted that same slice from the default's predictors. BOTH
// halves of that mechanism are gone — there is no value-provider cut, no
// default-stream cut, no getMaxWeightAtRound and no heap to be top dog of — so
// the four cut/guard tests were deleted rather than weakened.
//
// What REPLACED the loop is a derived weight, and it is the thing worth
// covering now: the default game (id 1) can never be voted on, and its weight is
// DERIVED as `totalBurnedWeight * 100 / 9900` floored at 1e18. That is 1% of a
// denominator that includes itself — but at the small burns these tests use (10
// and 20 ether) 1% is well under the 1e18 floor, so in practice the default sits
// ON its floor and its share of the denominator is `1e18 / (1e18 + Σ burns)`,
// not a fixed fraction. The tests below pin that floored share end-to-end, plus
// the denominator-integrity and provider-gating properties that outlived the cut.

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixtureNoFee, pack1, voteFor, onChainGrossNow } = require("../fixtures");

const UP = 1;
const DEFAULT_ID = 1;
// On-chain game gross per round. The dev fee is the token's senior carve-out,
// so the game pool is the residual (emission net of the fee) — READ FROM THE
// CHAIN, because the emission is the hub's decaying schedule now. This was
// `parseEther("1152")` = 1440 − 288, which held only while it was fixed.
// The old first-predictor bonus reservation (−0.44) is GONE: the full gross is
// distributable to predictors now, so this is the whole payable budget.
let BUDGET;
// The default's share of the denominator in the "derived 1%" test below. The 1%
// derivation (DEFAULT_SHARE_BPS = 100) is under the 1e18 floor at that test's
// 10-ether burn, so the default sits on its floor: 1e18 against a 10e18 user
// weight makes the denominator 11e18, and the default is exactly 1/11 of it.
const DEFAULT_SHARE_DIVISOR = 11n;

async function rewards_budget(satori, r) {
  const rewards = await ethers.getContractAt("SatoriRewards", await satori.satoriRewards());
  const ev = await rewards.queryFilter(rewards.filters.RoundBudgetFrozen(r), 0, "latest");
  return ev[0].args.budget;
}

async function advanceRound() {
  const t = await time.latest();
  await time.increaseTo(Math.floor(t / 86400) * 86400 + 86400 + 1);
}

async function streamIdFrom(tx, satori) {
  const r = await tx.wait();
  const ev = r.logs.find((l) => {
    try { return satori.interface.parseLog(l)?.name === "DataStreamCreated"; }
    catch { return false; }
  });
  return Number(satori.interface.parseLog(ev).args.streamId);
}

// Standard fixture wiring + zeroed platform fee (so the on-chain per-round
// budget is the clean residual after the senior dev fee, which is off-budget at
// the token). The fixture itself now calls initializeDefaultStream(), exactly as
// production does, so the default stream/game already occupies id 1 and the
// first stream a test creates is id 2.
async function setup() {
  const fix = await deploySatoriFixtureNoFee();
  BUDGET = await onChainGrossNow(fix.satori);
  return fix;
}

describe("default-stream COVERAGE: derived weight, denominator integrity, provider gating", function () {
  this.timeout(120000);

  // GAP (high): the default game is a Sentiment game, so it pays pari-mutuel: a side
  // is paid out of the OTHER side's weight. A crowd that all leans the same way
  // draws nothing, and nothing is skimmed on the way (no cut, no bonus).
  it("pays nothing when nobody opposes the winning side, and mints nothing for it", async function () {
    const { satori, voting, signers, lens, registry } = await setup();
    const [, alice, bob] = signers;
    await satori.transfer(alice.address, ethers.parseEther("10"));
    await satori.transfer(bob.address, ethers.parseEther("10"));

    await advanceRound();
    const r1 = await satori.getCurrentRound();
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: DEFAULT_ID, payload: pack1(UP) }]);
    await satori.connect(bob).predictMultipleWithPayloads([{ gameId: DEFAULT_ID, payload: pack1(UP) }]);
    // Nobody opposes: alice's UP is right (bob's flow came after her), but there
    // is no DOWN weight to pay her from.
    await time.increase(25 * 3600);
    await registry.updateValue(DEFAULT_ID);

    expect(await voting.getGameVotesAtRound(DEFAULT_ID, r1)).to.equal(await voting.defaultDerivedWeight());
    const claimableBefore = await getClaimable(lens, alice.address);
    const marketingBefore = await getMarketingBucket(satori);
    const engine = await ethers.getContractAt("SatoriEngine", await satori.engine());
    await satori.settlePrediction(alice.address, DEFAULT_ID);
    const scored = (await engine.queryFilter(engine.filters.PredictionScored(alice.address)))
      .filter((e) => Number(e.args[1]) === DEFAULT_ID);
    expect(scored.length).to.equal(1);
    expect(scored[0].args.correct).to.equal(true);
    expect(await getClaimable(lens, alice.address)).to.equal(claimableBefore);
    expect(await getMarketingBucket(satori)).to.equal(marketingBefore);
  });

  // GAP (high): the default's FLOORED share of the round. With one user game
  // carrying 10 burnt weight the default's 1% derivation (10 * 100/9900 ~ 0.101)
  // is under the 1e18 floor, so it sits ON its floor: weight 1, denominator 11,
  // and the default is exactly 1/11 of it. That share is the game's slice P, the
  // most the pari-mutuel can pay out of it.
  it("gives the default exactly its floored 1/11 share of the round denominator", async function () {
    const { satori, voting, registry, signers } = await setup();
    const [owner, alice, bob, voter] = signers;
    await satori.transfer(alice.address, ethers.parseEther("20"));
    await satori.transfer(bob.address, ethers.parseEther("20"));
    await satori.transfer(voter.address, ethers.parseEther("20"));

    const user = await streamIdFrom(await satori.createSimpleDataStream("User", owner.address), satori);
    await voteFor(satori, voter, user, ethers.parseEther("10"));
    expect(await voting.weightOf(user)).to.equal(ethers.parseEther("10"));
    expect(await voting.defaultDerivedWeight()).to.equal(ethers.parseEther("1"));

    // R1: BOTH the user game and the default are predicted, so both enter the
    // round's accumulated denominator.
    await advanceRound();
    const r1 = await satori.getCurrentRound();
    await registry.setValue(user, 100);
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: DEFAULT_ID, payload: pack1(UP) }]);
    await satori.connect(bob).predictMultipleWithPayloads([{ gameId: user, payload: pack1(UP) }]);
    await advanceRound();

    const dv = await voting.getGameVotesAtRound(DEFAULT_ID, r1);
    const total = await voting.roundDenominator(r1);
    expect(dv).to.equal(ethers.parseEther("1"));    // on the floor
    expect(total).to.equal(ethers.parseEther("11")); // 10 burnt + 1 floored
    expect(dv * DEFAULT_SHARE_DIVISOR).to.equal(total);
    // The slice the default game may pay out of: the round budget at that share.
    const frozen = await rewards_budget(satori, r1);
    expect((frozen * dv) / total).to.equal(frozen / DEFAULT_SHARE_DIVISOR);
  });

  // GAP (med): default_activeVotes_counted_once_per_round.
  // The old mechanism folded the default into the denominator through
  // accrueDefaultStreamCut, and the risk was a second, defensive path
  // double-counting it. The accumulator replaced both paths with ONE branch in
  // recordGameVotesForRound, so the property is now directly checkable: every
  // game that was predicted appears in the round's participating set exactly
  // once, and Σ numerators == the denominator, however many predictors show up.
  it("counts every game — the default included — exactly once in the round denominator", async function () {
    const { satori, voting, registry, signers } = await setup();
    const [owner, alice, carol, dave, erin] = signers;
    await satori.transfer(alice.address, ethers.parseEther("40"));
    await satori.transfer(carol.address, ethers.parseEther("20"));
    await satori.transfer(dave.address, ethers.parseEther("20"));
    await satori.transfer(erin.address, ethers.parseEther("20"));

    // Two user games, both burnt to 10 -> total burnt 20. The default's 1%
    // derivation of that (20 * 100/9900 ≈ 0.202) is under the 1e18 floor, so the
    // default sits ON its floor at weight 1.
    const a = await streamIdFrom(await satori.createSimpleDataStream("A", owner.address), satori);
    const b = await streamIdFrom(await satori.createSimpleDataStream("B", owner.address), satori);
    await voteFor(satori, carol, a, ethers.parseEther("10"));
    await voteFor(satori, dave, b, ethers.parseEther("10"));
    expect(await voting.defaultDerivedWeight()).to.equal(ethers.parseEther("1"));

    await advanceRound();
    const r = await satori.getCurrentRound();
    await registry.setValue(a, 100);
    await registry.setValue(b, 100);

    // alice predicts BOTH user games in one batch; erin predicts the default.
    await satori.connect(alice).predictMultipleWithPayloads([
      { gameId: a, payload: pack1(UP) },
      { gameId: b, payload: pack1(UP) },
    ]);
    await satori.connect(erin).predictMultipleWithPayloads([{ gameId: DEFAULT_ID, payload: pack1(UP) }]);

    // More predictors on the SAME games must not re-add anything.
    await satori.connect(carol).predictMultipleWithPayloads([{ gameId: a, payload: pack1(UP) }]);
    await satori.connect(dave).predictMultipleWithPayloads([{ gameId: DEFAULT_ID, payload: pack1(UP) }]);

    const participating = await voting.getEligibleGamesAtRound(r);
    const ids = participating.map(Number);
    expect(new Set(ids).size, "no game recorded twice").to.equal(ids.length);
    expect(ids.filter((g) => g === DEFAULT_ID).length, "default counted exactly once").to.equal(1);
    expect(ids.sort((x, y) => x - y)).to.deep.equal([DEFAULT_ID, a, b].sort((x, y) => x - y));

    // Σ numerators == denominator, exactly (the two are written in one branch).
    let sum = 0n;
    for (const g of ids) sum += await voting.getGameVotesAtRound(g, r);
    await advanceRound();
    const denom = await voting.roundDenominator(r);
    expect(sum).to.equal(denom);
    expect(denom).to.equal(ethers.parseEther("21")); // 10 + 10 + 1 floored default
  });

  // GAP (med): the denominator may not be read while the round is still open.
  // The accumulator grows as each game's first predictor arrives, so a mid-round
  // read is a PARTIAL sum and every share computed against it would be too big.
  // (This is the accumulator's replacement for the old round-totals lock.)
  it("refuses to serve the denominator for a round that is still open", async function () {
    const { satori, voting } = await setup();
    const r = await satori.getCurrentRound();
    await expect(voting.roundDenominator(r))
      .to.be.revertedWithCustomError(voting, "RoundNotFinal");
    await advanceRound();
    await expect(voting.roundDenominator(r)).to.not.be.reverted;
  });

  // GAP (med): the default stream's value is written by the core alone.
  // setValue() never runs for the default stream (its provider is the hub), so
  // no external caller can inject a value and manufacture a win on it.
  it("setValue on the default stream reverts for any external caller", async function () {
    const { registry, signers } = await setup();
    const [owner, alice] = signers;
    await expect(registry.connect(owner).setValue(DEFAULT_ID, 5))
      .to.be.revertedWithCustomError(registry, "NotStreamProvider");
    await expect(registry.connect(alice).setValue(DEFAULT_ID, 5))
      .to.be.revertedWithCustomError(registry, "NotStreamProvider");
  });

  // The default game is structurally unpurchasable and unkillable: its weight is
  // derived, so buying it would double-count, and disabling it would erase the
  // protocol's baseline game. Both are hard reverts, not conventions.
  it("the default game can be neither voted on nor disabled", async function () {
    const { satori, voting, signers } = await setup();
    const [owner, alice] = signers;
    await satori.transfer(alice.address, ethers.parseEther("20"));
    await expect(satori.connect(alice).vote(DEFAULT_ID, ethers.parseEther("1")))
      .to.be.revertedWithCustomError(voting, "CannotVoteDefault");
    // owner is the rewards admin in the fixture, so this is the authorized caller
    // failing on the default-specific guard, not on the role check.
    await expect(voting.connect(owner).setGameApproved(DEFAULT_ID, false))
      .to.be.revertedWithCustomError(voting, "CannotSetDefaultApproval");
  });
});

// Read a user's total claimable SATORI from the read-only rewards lens
// (getTotalClaimableRewards moved from SatoriRewards to SatoriRewardsLens;
// the fixture deploys and returns the lens).
async function getClaimable(lens, who) {
  return lens.getTotalClaimableRewards(who).then((r) => r[0]);
}

// Eager-credit skim (referral-eager-credit): every reward credit routes
// REFERRAL_BPS (5%) into the earner's referrer bucket, or — for an unset/self
// referral, which is the case for every earner in these tests — into
// MARKETING_FEE_RECIPIENT's unclaimedRewards bucket. Reading that bucket's
// delta lets us reconstruct the gross (pre-skim) reward so conservation stays
// EXACT: earner_net + marketing_cut == original_amount.
async function getMarketingBucket(satori) {
  const rewardsAddr = await satori.satoriRewards();
  const rewards = await ethers.getContractAt("SatoriRewards", rewardsAddr);
  const marketing = await rewards.marketingFeeRecipient();
  return rewards.unclaimedRewards(marketing);
}
