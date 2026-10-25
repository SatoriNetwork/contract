/**
 * Delegator delta-claim: the per-round rate-share walk no longer halts when
 * the delegate has a pending prediction in a round. Instead:
 *
 *   - The cursor walks the round, credits the rate-as-of-now, and (if the
 *     round still has pending predictions when crossed) records a small
 *     openRounds entry (round, banked-rate).
 *   - Subsequent claims replay openRounds: if the rate has grown (because
 *     more of the delegate's round-r predictions have since scored), the
 *     delegator collects the delta. When the round's counter reaches 0,
 *     the entry pops.
 *
 * Net effect: a dark stream no longer freezes anyone — the delegator collects
 * what's scored now and the delta later. Subsequent rounds are not held up
 * behind the stuck round.
 *
 * Note on test scaffolding: voting BURNS SATORI to buy a game permanent
 * weight, so any holder can back any number of games. The two streams are still
 * voted by two different actors (carol, dave) so each burn is easy to attribute,
 * and the burns are equal so the two games share the round denominator 50/50.
 */

const { expect } = require("chai");
const { deploySatoriFixtureNoFee, pack1, VOTE, RAW_TOLERANCE } = require("./fixtures");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const UP = 1;
// The 4-arg overload carried a per-stream value-provider cut; providers are
// no longer paid at all, so the cadence-only 3-arg form is the whole signature.
const SIMPLE3 = "createSimpleDataStream(string,address,uint24)";

async function streamIdFrom(tx, satori) {
  const r = await tx.wait();
  const ev = r.logs.find(l => {
    try { return satori.interface.parseLog(l)?.name === "DataStreamCreated"; }
    catch { return false; }
  });
  return satori.interface.parseLog(ev).args.streamId;
}

async function advanceRound() {
  const t = await time.latest();
  await time.increaseTo(Math.floor(t / 86400) * 86400 + 86400 + 1);
}

describe("Delegator delta-claim (no halt on pending rounds)", function () {
  let satori, voting, rewards, registry;
  let owner, alice, bob, carol, dave, platform;
  let quickId, slowId;

  beforeEach(async function () {
    [owner, alice, bob, carol, dave, platform] = await ethers.getSigners();

    const fix = await deploySatoriFixtureNoFee();
    ({ satori, voting, rewards, registry } = fix);

    // alice: 450 (delegator), bob: 150 (delegate/predictor). carol + dave:
    // small holdings whose only job is to vote streams eligible. Total
    // transfers must fit in INITIAL_MINT (720 ether). The 450/150 split keeps
    // alice the clear majority even after bob's unclaimed R1 winnings (which
    // count toward his ownPower) grow him at the 24h-round reward scale.
    await satori.transfer(alice.address, ethers.parseEther("450"));
    await satori.transfer(bob.address, ethers.parseEther("150"));
    await satori.transfer(carol.address, ethers.parseEther("50"));
    await satori.transfer(dave.address, ethers.parseEther("50"));

    quickId = await streamIdFrom(await satori[SIMPLE3]("Quick", owner.address, 1440), satori);
    slowId  = await streamIdFrom(await satori[SIMPLE3]("Slow",  owner.address, 1440), satori);

    // Equal burns on both streams, from two different holders, so each game
    // carries the same weight. alice is the delegator — she burns nothing, so
    // her full 400 stays available as prediction power.
    await satori.connect(carol).vote(quickId, VOTE);
    await satori.connect(dave).vote(slowId, VOTE);

    await advanceRound();
  });

  it("collects share of a pending round immediately, then the delta when it closes", async function () {
    await satori.connect(alice).delegatePredictionPower(bob.address);
    await time.increase(86400);

    // R0 (delegation round): bob predicts Slow. Slow will be left silent so
    // its slot stays pending. count[bob][R0] = 1.
    await registry.setValue(slowId, 100);
    await satori.connect(bob).predictMultipleWithPayloads([{ gameId: slowId, payload: pack1(UP) }]);

    // R1: bob predicts Quick. count[bob][R1] = 1.
    await advanceRound();
    await registry.setValue(quickId, 100);
    await satori.connect(bob).predictMultipleWithPayloads([{ gameId: quickId, payload: pack1(UP) }]);

    // Score R1's Quick prediction.
    await advanceRound();
    await registry.setValue(quickId, 110);  // Quick B
    await advanceRound();
    await registry.setValue(quickId, 120);  // Quick C
    await satori.connect(carol).settlePrediction(bob.address, quickId);
    // rate[bob][R1] += quick's delegator slice. R1 fully closed.
    // R0 still has slow pending (count[bob][R0] = 1).

    // First claim: under the old halt this would stop at R0 (slow pending)
    // and never reach R1's rate. Under the new behavior the cursor records
    // an openRound(R0, banked=0) and continues to R1 — alice gets Quick's
    // share immediately.
    const aliceBefore1 = await satori.balanceOf(alice.address);
    await satori.connect(alice)["claim()"]();
    const aliceAfter1 = await satori.balanceOf(alice.address);
    const credit1 = aliceAfter1 - aliceBefore1;
    expect(credit1).to.be.gt(0n);

    // Idempotency: a repeat claim with no new scoring yields nothing.
    await satori.connect(alice)["claim()"]();
    expect((await satori.balanceOf(alice.address)) - aliceAfter1).to.equal(0n);

    // A few empty rounds — cursor must not stall behind R0.
    for (let i = 0; i < 3; i++) await advanceRound();

    // Now Slow finally scores. rate[bob][R0] grows from 0 to slow's slice.
    await registry.setValue(slowId, 110);  // Slow B
    await advanceRound();
    await registry.setValue(slowId, 120);  // Slow C
    await satori.connect(carol).settlePrediction(bob.address, slowId);
    // count[bob][R0] = 0 → R0 closed.

    // Second claim: replay openRounds finds (R0, banked=0); currentRate > 0
    // → credit the delta, pop the entry. Alice gets Slow's share.
    const aliceBefore2 = await satori.balanceOf(alice.address);
    await satori.connect(alice)["claim()"]();
    const aliceAfter2 = await satori.balanceOf(alice.address);
    const credit2 = aliceAfter2 - aliceBefore2;
    expect(credit2).to.be.gt(0n);

    // Final idempotency: nothing left.
    await satori.connect(alice)["claim()"]();
    expect((await satori.balanceOf(alice.address)) - aliceAfter2).to.equal(0n);
  });

  it("cursor does not stall — a later round's rate-share is claimable even while an earlier round still has a pending prediction", async function () {
    await satori.connect(alice).delegatePredictionPower(bob.address);
    await time.increase(86400);

    // R0: bob predicts Slow (will stay pending forever). count[bob][R0] = 1.
    await registry.setValue(slowId, 100);
    await satori.connect(bob).predictMultipleWithPayloads([{ gameId: slowId, payload: pack1(UP) }]);

    // R1: bob predicts Quick. Score it.
    //
    // Capture the power split AT PREDICT TIME. The alice/bob takes used to be
    // pinned as two literals; they are a fixed point of this split, and the
    // split moves with the emission (alice's stake is a fixed 100 SATORI while
    // bob's own power grows with his unclaimed take, which scales with the
    // round pool). So compute the expectation from the same inputs the contract
    // splits on, rather than from numbers that were only true at 1152/round.
    const splits = [];
    const capturePower = async () => {
      const own = (await satori.balanceOf(bob.address))
                + (await rewards.unclaimedRewards(bob.address));
      const total = await rewards.getPredictionPower(bob.address);
      splits.push({ own, total });
    };
    await advanceRound();
    await registry.setValue(quickId, 100);
    await capturePower();
    await satori.connect(bob).predictMultipleWithPayloads([{ gameId: quickId, payload: pack1(UP) }]);
    await advanceRound();
    await registry.setValue(quickId, 110);
    await advanceRound();
    await registry.setValue(quickId, 120);
    await satori.connect(carol).settlePrediction(bob.address, quickId);
    // rate[bob][R1] populated. R0 still has slow pending.

    // Empty rounds.
    await advanceRound();
    await advanceRound();

    // R5: bob predicts Quick AGAIN. Old halt would have stopped at R0 and
    // never reached R5; the new walk records (R0, banked=0) and continues.
    await registry.setValue(quickId, 200);
    await capturePower();
    await satori.connect(bob).predictMultipleWithPayloads([{ gameId: quickId, payload: pack1(UP) }]);

    // Score R5's Quick prediction.
    await advanceRound();
    await registry.setValue(quickId, 220);
    await advanceRound();
    await registry.setValue(quickId, 240);
    await satori.connect(carol).settlePrediction(bob.address, quickId);

    // Alice's claim must collect BOTH R1's and R5's shares.
    const aliceBefore = await satori.balanceOf(alice.address);
    await satori.connect(alice)["claim()"]();
    const aliceGained = (await satori.balanceOf(alice.address)) - aliceBefore;
    expect(aliceGained).to.be.gt(0n);

    // alice, the majority delegator, out-earns bob the delegate. The
    // first-predictor bonus no longer exists, so bob's gross is pure scoring
    // and nothing has to be stripped before comparing. Both takes are still
    // pinned exactly rather than bounded by a ratio — but DERIVED from the
    // captured power splits, because the split is not a constant any more.
    const bobBefore = await satori.balanceOf(bob.address);
    await satori.connect(bob)["claim()"]();
    const bobGained = (await satori.balanceOf(bob.address)) - bobBefore;

    // Each of the two scored rounds paid the WHOLE on-chain gross: bob predicted
    // the only game that joined that round's denominator.
    const gross = (await satori.emissionRateNow()) - (await satori.devRateNow());
    const feeBps = BigInt(await rewards.effectivePredictorFee(bob.address));
    const net = (x) => x - (x * 500n) / 10000n; // the 5% eager referral skim
    let aliceExpected = 0n, bobExpected = 0n;
    expect(splits.length).to.equal(2);
    for (const { own, total } of splits) {
      const delegatedReward = (gross * (total - own)) / total;
      const bonus = (delegatedReward * feeBps) / 10000n;
      aliceExpected += net(delegatedReward - bonus);
      bobExpected += net(gross - delegatedReward) + net(bonus);
    }
    expect(aliceGained).to.be.closeTo(aliceExpected, RAW_TOLERANCE);
    expect(bobGained).to.be.closeTo(bobExpected, RAW_TOLERANCE);
    // Conservation: nothing beyond the two scored rounds' net pool is minted.
    expect(aliceGained + bobGained).to.be.closeTo(net(gross) * 2n, RAW_TOLERANCE);
    expect(aliceGained).to.be.gt(bobGained);
  });
});
