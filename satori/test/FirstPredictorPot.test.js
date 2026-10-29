/**
 * PER-ROUND BUDGET (item 8)
 *
 * Each round's payable on-chain budget is the WHOLE gross: 720 − devFee −
 * off-chain share, snapshotted at the round's first action. Per-game allocation
 * = budget × gameVotesAtRound/roundVoteTotal, and predictors split all of it.
 *
 * Two reservations that used to come off the top are gone:
 *   - the first-predictor-of-the-round bonus (item 7) — deleted outright, along
 *     with the three tests that covered it;
 *   - the value-provider cut (item 6) — providers are not paid at all any more,
 *     so the reconciliation test that split the budget between a provider and
 *     the predictors went with it.
 * What survives is the conservation property itself, now in its simplest form:
 * a solo predictor on the only game predicted that round collects the entire
 * round gross.
 *
 * With the merkle dial unset (deployStack), gross = emission − the dev fee,
 * and budget == gross. (The platform fee moved to the immutable token; its
 * schedule/recipient live in test/next/DevFee.test.js.)
 */

const { expect } = require("chai");
const { deploySatoriFixtureNoFee, RAW_TOLERANCE, pack1, VOTE, onChainGrossNow } = require("./fixtures");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const UP = 1;
// The per-stream value-provider cut is gone, so the 3-arg cadence-only overload
// is the whole createSimpleDataStream signature now.
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

describe("Per-round budget (item 8)", function () {
  let satori, voting, rewards, registry, lens;
  let owner, alice, bob, carol, platform;
  // The on-chain round gross, read from the chain (was the 1440 − 288 literal).
  let GROSS;

  beforeEach(async function () {
    [owner, alice, bob, carol, platform] = await ethers.getSigners();
    const fix = await deploySatoriFixtureNoFee();
    ({ satori, voting, rewards, registry, lens } = fix);
    GROSS = await onChainGrossNow(satori);
    await satori.transfer(alice.address, ethers.parseEther("100"));
    await satori.transfer(bob.address, ethers.parseEther("100"));
    await satori.transfer(carol.address, ethers.parseEther("100"));
    await advanceRound();
  });

  it("predicting credits nothing up front — the whole budget flows through scoring", async function () {
    const sid = await streamIdFrom(await satori[SIMPLE3]("S", owner.address, 1440), satori);
    await registry.setValue(sid, 100);
    await satori.connect(alice).vote(sid, VOTE);
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: sid, payload: pack1(UP) }]);
    // No first-predictor bonus: being first to predict in a round buys nothing.
    expect((await lens.getTotalClaimableRewards(alice.address))[0]).to.equal(0n);
  });

  it("a solo predictor collects the FULL round gross at zero fees", async function () {
    const sid = await streamIdFrom(await satori[SIMPLE3]("S", owner.address, 1440), satori);
    await registry.setValue(sid, 100);
    await satori.connect(alice).vote(sid, VOTE);
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: sid, payload: pack1(UP) }]);
    await advanceRound();
    await registry.setValue(sid, 110);
    await advanceRound();
    await registry.setValue(sid, 120);
    await satori.settlePrediction(alice.address, sid);

    const before = await satori.balanceOf(alice.address);
    await satori.connect(alice).claim();
    // Eager referral skim: the predictor pool is credited through _creditReward,
    // so part of it lands in the marketing bucket (alice has no referral).
    // Counting that back in, conservation is exact — and the pool is now the
    // ENTIRE gross, with nothing held back for a bonus or a provider.
    const aliceMinted = (await satori.balanceOf(alice.address)) - before;
    const marketing = await rewards.marketingFeeRecipient();
    const marketingCut = await rewards.unclaimedRewards(marketing);
    expect(aliceMinted + marketingCut).to.be.closeTo(GROSS, RAW_TOLERANCE);
  });

  it("only games actually predicted enter the round denominator", async function () {
    const s1 = await streamIdFrom(await satori[SIMPLE3]("S1", owner.address, 1440), satori);
    const s2 = await streamIdFrom(await satori[SIMPLE3]("S2", owner.address, 1440), satori);
    await registry.setValue(s1, 100);
    await registry.setValue(s2, 100);
    // Equal weight on both games, but only s1 is ever predicted.
    await satori.connect(alice).vote(s1, VOTE);
    await satori.connect(bob).vote(s2, VOTE);

    const round = await satori.getCurrentRound();
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: s1, payload: pack1(UP) }]);

    expect(await voting.getGameVotesAtRound(s1, round)).to.equal(VOTE);
    expect(await voting.getGameVotesAtRound(s2, round)).to.equal(0n);
    await advanceRound();
    // s2's unspent weight never dilutes s1: the denominator is s1 alone.
    expect(await voting.roundDenominator(round)).to.equal(VOTE);
  });
});
