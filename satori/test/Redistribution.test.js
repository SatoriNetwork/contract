/**
 * QUIET-GAME REDISTRIBUTION
 *
 * A round's budget is split among the games that actually PARTICIPATED that
 * round — i.e. the games a fresh value was posted for and someone predicted on.
 * Under burn voting the round denominator is ACCUMULATED: the first predictor of
 * game g in round r writes `gameVotesAtRound[g][r]` and adds it to
 * `roundVoteTotal[r]`. A game that carries burnt weight but stayed quiet never
 * enters the denominator at all, so its notional slice is not stranded — it is
 * simply never part of the divisor, and the producers split the whole budget.
 *
 * Two games carry EQUAL burnt weight. In the first test only one produces, and
 * its solo predictor must earn the WHOLE on-chain gross (at zero fees,
 * after the senior 288 dev fee carved at the immutable token), not half — proof
 * the quiet game's ~576 slice went to the producer rather than going unminted.
 * In the second test both produce and each takes exactly its own half.
 *
 * Note the default game (id 1) also carries derived weight, but nobody predicts
 * on it here, so it never joins the denominator either — same mechanism.
 */

const { expect } = require("chai");
const { deploySatoriFixtureNoFee, RAW_TOLERANCE, pack1, voteFor, VOTE, onChainGrossNow } = require("./fixtures");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const UP = 1;
const SIMPLE3 = "createSimpleDataStream(string,address,uint24)";

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

describe("Quiet-game redistribution", function () {
  let satori, voting, rewards, registry;
  let owner, alice, bob, carol, dave, platform;
  // The on-chain round gross, read from the chain (was the 1440 − 288 literal).
  let GROSS;

  beforeEach(async function () {
    [owner, alice, bob, carol, dave, platform] = await ethers.getSigners();
    const fix = await deploySatoriFixtureNoFee();
    ({ satori, voting, rewards, registry } = fix);
    owner = fix.owner;
    GROSS = await onChainGrossNow(satori);
    await satori.transfer(alice.address, ethers.parseEther("100"));
    await satori.transfer(bob.address, ethers.parseEther("100"));
    await satori.transfer(carol.address, ethers.parseEther("100"));
    await satori.transfer(dave.address, ethers.parseEther("100"));
    await advanceRound();
  });

  it("a quiet weighted game's slice goes to the producer, not unminted", async function () {
    // Game id 1 is the default (created by the fixture), so A and B land at 2/3.
    const A = await streamIdFrom(await satori[SIMPLE3]("A", owner.address, 1440), satori);
    const B = await streamIdFrom(await satori[SIMPLE3]("B", owner.address, 1440), satori);

    // Equal burnt weight on both, so a naive "all weighted games share" split
    // would give A only half. Weight is permanent — no re-vote needed later.
    await voteFor(satori, alice, A);   // A: 10
    await voteFor(satori, bob, B);     // B: 10
    expect(await voting.weightOf(A)).to.equal(VOTE);
    expect(await voting.weightOf(B)).to.equal(VOTE);

    await advanceRound();              // → the producing round R

    // R: only A produces; B stays quiet, so B never enters R's denominator.
    await registry.setValue(A, 110);
    const R = await satori.getCurrentRound();
    await satori.connect(dave).predictMultipleWithPayloads([{ gameId: A, payload: pack1(UP) }]);

    // The denominator holds A alone — B's equal weight is simply not in it.
    expect(await voting.getGameVotesAtRound(A, R)).to.equal(VOTE);
    expect(await voting.getGameVotesAtRound(B, R)).to.equal(0);
    expect(await voting.roundVoteTotal(R)).to.equal(VOTE);

    await advanceRound();
    await registry.setValue(A, 120);
    await advanceRound();
    await registry.setValue(A, 130);
    await satori.settlePrediction(dave.address, A);

    const before = await satori.balanceOf(dave.address);
    await satori.connect(dave).claim();
    // A's slice = GROSS × 10/10 = the WHOLE gross, not GROSS × 10/20.
    // (GROSS = the residual on-chain gross after the senior dev fee carved
    // at the token. There is no first-predictor bonus and no provider cut any
    // more, so the full gross is the predictor pool.)
    //
    // Referral model: the 5% referral cut is skimmed from the reward at CREDIT
    // time. dave has no referral, so the cut routes to MARKETING_FEE_RECIPIENT's
    // unclaimed bucket. dave mints GROSS − GROSS × 500/10000, and the
    // marketing bucket holds the 5% cut. Conservation holds at the total
    // level: dave_minted + marketing_cut == GROSS.
    const marketing = await rewards.marketingFeeRecipient();
    const marketingCut = await rewards.unclaimedRewards(marketing);
    const daveMinted = (await satori.balanceOf(dave.address)) - before;
    expect(daveMinted).to.be.closeTo(GROSS - (GROSS * 500n) / 10000n, RAW_TOLERANCE);
    expect(daveMinted + marketingCut).to.be.closeTo(GROSS, RAW_TOLERANCE);
  });

  it("when both weighted games produce, each gets only its own half (no redistribution)", async function () {
    const A = await streamIdFrom(await satori[SIMPLE3]("A", owner.address, 1440), satori);
    const B = await streamIdFrom(await satori[SIMPLE3]("B", owner.address, 1440), satori);

    await voteFor(satori, alice, A);   // A: 10
    await voteFor(satori, bob, B);     // B: 10
    await advanceRound();              // → R

    // R: BOTH produce; dave predicts A, carol predicts B.
    await registry.setValue(A, 110);
    await registry.setValue(B, 110);
    const R = await satori.getCurrentRound();
    await satori.connect(dave).predictMultipleWithPayloads([{ gameId: A, payload: pack1(UP) }]);
    await satori.connect(carol).predictMultipleWithPayloads([{ gameId: B, payload: pack1(UP) }]);

    // Both games joined the denominator, so it is the full 20.
    expect(await voting.roundVoteTotal(R)).to.equal(VOTE * 2n);

    await advanceRound();
    await registry.setValue(A, 120);
    await registry.setValue(B, 120);
    await advanceRound();
    await registry.setValue(A, 130);
    await registry.setValue(B, 130);
    await satori.settlePrediction(dave.address, A);
    await satori.settlePrediction(carol.address, B);

    const dBefore = await satori.balanceOf(dave.address);
    const cBefore = await satori.balanceOf(carol.address);
    await satori.connect(dave).claim();
    await satori.connect(carol).claim();
    // Denominator = 20 (both), so each game's slice is half the gross. Each is
    // the solo predictor of its own game, so each takes the whole slice,
    // skimmed 5% at credit.
    const half = GROSS / 2n;
    const halfNet = half - (half * 500n) / 10000n;
    const daveMinted = (await satori.balanceOf(dave.address)) - dBefore;
    const carolMinted = (await satori.balanceOf(carol.address)) - cBefore;
    expect(daveMinted).to.be.closeTo(halfNet, RAW_TOLERANCE);
    expect(carolMinted).to.be.closeTo(halfNet, RAW_TOLERANCE);
    // Conservation: both earners' minted balances plus the 5% cuts that landed
    // in the marketing bucket sum to the full on-chain gross.
    const marketing = await rewards.marketingFeeRecipient();
    const marketingCut = await rewards.unclaimedRewards(marketing);
    expect(daveMinted + carolMinted + marketingCut).to.be.closeTo(GROSS, RAW_TOLERANCE);
  });
});
