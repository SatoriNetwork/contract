const { expect } = require("chai");
const { deploySatoriFixtureNoFee, pack1 , warmUpStreak, voteFor, onChainGrossNow } = require("./fixtures");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

async function getStreamIdFromTx(tx, satoriContract) {
  const receipt = await tx.wait();
  const event = receipt.logs.find(log => {
    try {
      const parsed = satoriContract.interface.parseLog(log);
      return parsed && parsed.name === 'DataStreamCreated';
    } catch {
      return false;
    }
  });
  if (!event) throw new Error("DataStreamCreated event not found");
  const parsed = satoriContract.interface.parseLog(event);
  return parsed.args.streamId;
}

// The stream here is created the way a real user gets one: through the 2-arg
// overload, which yields a 1440-minute (every-round) stream. This file keeps
// its historical rhythm of one value write per 2-round period — comfortably
// past the stream's ~23.5h write gap.
const ROUND = 86400;                              // 24h
const CADENCE_ROUNDS = 2;                         // write spacing, in rounds

async function advanceToNextRound() {
  const currentTime = await time.latest();
  const nextBoundary = Math.floor(currentTime / ROUND) * ROUND + ROUND;
  await time.increaseTo(nextBoundary + 1);
  await time.increase(ROUND * (CADENCE_ROUNDS - 1));
}

// Snap the clock to just after a round boundary so a subsequent cadence-guarded
// setValue records a boundary-aligned lastUpdateTimestamp. Without this the
// initial setValue timestamp lands at an arbitrary offset into the round
// (dependent on accumulated chain time across the test suite); after one
// advanceToNextRound the elapsed gap can dip below the 84600s cadence window
// (1440min × 60 − 1800s slack), causing a fragile CadenceGapNotElapsed()
// revert on the FIRST in-period setValue. Aligning here guarantees the gap is
// at least a near-full round (~86400s) for every test.
async function alignToRoundBoundary() {
  const currentTime = await time.latest();
  const nextMidnight = Math.floor(currentTime / 86400) * 86400 + 86400;
  await time.increaseTo(nextMidnight + 1);
}

describe("RewardProportional - O(1) accumulated factor", function () {
  let satori, rewards, bounties, registry;
  let owner, alice, bob, carol;
  let streamId;
  // The on-chain round pool, read from the chain rather than written out as the
  // old 1440 − 288 = 1152. Emission is the hub's decaying schedule now.
  let GROSS;

  beforeEach(async function () {
    // Legacy platform fee at 0 bps. The senior dev fee now lives on the immutable
    // token and is carved out UNCONDITIONALLY, so the on-chain round pool is the
    // residual emissionRateNow − devRateNow (see DevFee.test.js).
    const fix = await deploySatoriFixtureNoFee();
    ({ satori, rewards, bounties, registry } = fix);
    [owner, alice, bob, carol] = fix.signers;
    GROSS = await onChainGrossNow(satori);

    // Give tokens: alice=100, bob=200, carol=300
    await satori.transfer(alice.address, ethers.parseEther("100"));
    await satori.transfer(bob.address, ethers.parseEther("200"));
    await satori.transfer(carol.address, ethers.parseEther("300"));

    // Create stream and make it eligible
    const tx = await satori.createSimpleDataStream("ETH/USD", owner.address);
    streamId = await getStreamIdFromTx(tx, registry);
    // audit C-2: streak 0 pays a FLAT dust identical for every holder, so
    // proportionality-by-holdings only exists at streak >= 1. Warm up first.
    // Last arg is the stream's cadence: the warm-up must space its own writes
    // by a full cadence period too, or it trips the registry's cadence guard.
    await warmUpStreak(satori, registry, owner, [alice, bob, carol], streamId, 1000, CADENCE_ROUNDS);

    // Snap to a round boundary so the initial setValue timestamp is aligned and
    // the first in-round setValue after advanceToNextRound clears the cadence
    // gap robustly (see alignToRoundBoundary()).
    await alignToRoundBoundary();
    await registry.setValue(streamId, 1000);
    // OWNER buys the stream's weight, not one of the three predictors: voting
    // BURNS, and this test's whole point is that the three predict with an exact
    // 100 : 200 : 300 of power. A burn by alice would quietly make it 90 : 200 : 300.
    // Weight is permanent, so this single burn covers every round below.
    await voteFor(satori, owner, streamId);

    // Round 0 -> 1
    await advanceToNextRound();
  });

  it("3 predictors with weights [100, 200, 300] share alloc proportionally", async function () {
    // Round 1: all 3 predict UP (value will go up)
    await registry.setValue(streamId, 1050);

    const round1 = await satori.getCurrentRound();

    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(1) }]); // UP
    await satori.connect(bob).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(1) }]);   // UP
    await satori.connect(carol).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(1) }]); // UP

    // Round 1 -> 2: value increases (UP correct)
    await advanceToNextRound();
    await registry.setValue(streamId, 1100);

    // Round 2 -> 3: scoring triggered by round 3 predictions
    await advanceToNextRound();
    await registry.setValue(streamId, 1200);

    // Trigger scoring by making round 3 predictions
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(1) }]);
    await satori.connect(bob).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(1) }]);
    await satori.connect(carol).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(1) }]);

    // Claim rewards and verify proportional split
    const aliceBalBefore = await satori.balanceOf(alice.address);
    const bobBalBefore = await satori.balanceOf(bob.address);
    const carolBalBefore = await satori.balanceOf(carol.address);

    await satori.connect(alice)['claim()']();
    await satori.connect(bob)['claim()']();
    await satori.connect(carol)['claim()']();

    const aliceReward = (await satori.balanceOf(alice.address)) - aliceBalBefore;
    const bobReward = (await satori.balanceOf(bob.address)) - bobBalBefore;
    const carolReward = (await satori.balanceOf(carol.address)) - carolBalBefore;

    const totalReward = aliceReward + bobReward + carolReward;

    // Weights: alice=100, bob=200, carol=300 (token balances at prediction time)
    // Total weight: 600
    // alice: 100/600 = 16.67%, bob: 200/600 = 33.33%, carol: 300/600 = 50%
    // But there's also a weight scaling factor from WEIGHT_SCALE, so use ratios

    console.log(`Alice reward: ${ethers.formatEther(aliceReward)}`);
    console.log(`Bob reward:   ${ethers.formatEther(bobReward)}`);
    console.log(`Carol reward: ${ethers.formatEther(carolReward)}`);
    console.log(`Total:        ${ethers.formatEther(totalReward)}`);

    // Each should have received something
    expect(aliceReward).to.be.gt(0n);
    expect(bobReward).to.be.gt(0n);
    expect(carolReward).to.be.gt(0n);

    // Bob should have ~2x Alice's reward. Every payout here is pure proportional
    // scoring now — there is no flat first-predictor add-on to strip out first.
    const bobToAliceRatio = (bobReward * 1000n) / aliceReward;
    expect(bobToAliceRatio).to.be.closeTo(2000n, 10n); // 2.0x within 1%

    // Carol should have ~3x Alice's reward.
    const carolToAliceRatio = (carolReward * 1000n) / aliceReward;
    expect(carolToAliceRatio).to.be.closeTo(3000n, 10n); // 3.0x within 1%

    // This stream is the only game predicted in the scored round, so it takes the
    // WHOLE on-chain round budget. The dev fee moved to the immutable token (see
    // DevFee.test.js), so that budget is the residual gross 1152 (= 1440 − 288
    // dev), and nothing is reserved out of it any more — the first-predictor
    // bonus is gone, so the scored pool IS 1152.
    //
    // Referral-eager-credit model: every reward credit loses 5% at settle. The
    // three predictors have no referral, so each skim is routed to
    // MARKETING_FEE_RECIPIENT's UNCLAIMED bucket — it is NOT minted into their
    // balances at claim. So the users' claimed balances are net and the skimmed
    // remainder sits in the marketing bucket. Conservation holds EXACTLY at the
    // total level: Σ(user net) + marketing bucket == the round budget.
    const marketingRecipient = await rewards.marketingFeeRecipient();
    const marketingBucket = await rewards.unclaimedRewards(marketingRecipient);
    const conservedTotal = totalReward + marketingBucket;

    const EXPECTED_TOTAL = GROSS;
    expect(conservedTotal).to.be.lte(EXPECTED_TOTAL);
    expect(conservedTotal).to.be.closeTo(EXPECTED_TOTAL, ethers.parseEther("1")); // within 1 token
  });

  it("Total minted never exceeds alloc", async function () {
    // Round 1: all 3 predict UP
    await registry.setValue(streamId, 1050);

    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(1) }]);
    await satori.connect(bob).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(1) }]);
    await satori.connect(carol).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(1) }]);

    // Advance rounds and trigger scoring
    await advanceToNextRound();
    await registry.setValue(streamId, 1100);

    await advanceToNextRound();
    await registry.setValue(streamId, 1200);

    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(1) }]);
    await satori.connect(bob).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(1) }]);
    await satori.connect(carol).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(1) }]);

    const ownerBalBefore = await satori.balanceOf(owner.address);
    const aliceBalBefore = await satori.balanceOf(alice.address);
    const bobBalBefore = await satori.balanceOf(bob.address);
    const carolBalBefore = await satori.balanceOf(carol.address);

    await satori.connect(alice)['claim()']();
    await satori.connect(bob)['claim()']();
    await satori.connect(carol)['claim()']();

    const aliceReward = (await satori.balanceOf(alice.address)) - aliceBalBefore;
    const bobReward = (await satori.balanceOf(bob.address)) - bobBalBefore;
    const carolReward = (await satori.balanceOf(carol.address)) - carolBalBefore;

    const totalMinted = aliceReward + bobReward + carolReward;

    // One round's scored pool is the whole residual gross 1152 (the dev fee is
    // off-budget on the token — see DevFee.test.js — and nothing else is reserved
    // out of it now that the first-predictor bonus is gone). Nothing else pays in
    // this scenario, so the claimed total is bounded by that single round's pool
    // and is never an over-mint.
    expect(totalMinted).to.be.lte(GROSS);
  });

  it("Proportional division is correct regardless of scoring order", async function () {
    // Run the scenario twice - once with abc order, once with cba order
    // Both should give same proportions

    // Round 1: predict
    await registry.setValue(streamId, 1050);

    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(1) }]);
    await satori.connect(bob).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(1) }]);
    await satori.connect(carol).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(1) }]);

    await advanceToNextRound();
    await registry.setValue(streamId, 1100);

    await advanceToNextRound();
    await registry.setValue(streamId, 1200);

    // Trigger scoring in carol->bob->alice order (reverse of weights)
    await satori.connect(carol).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(1) }]);
    await satori.connect(bob).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(1) }]);
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(1) }]);

    const aliceBalBefore = await satori.balanceOf(alice.address);
    const bobBalBefore = await satori.balanceOf(bob.address);
    const carolBalBefore = await satori.balanceOf(carol.address);

    await satori.connect(alice)['claim()']();
    await satori.connect(bob)['claim()']();
    await satori.connect(carol)['claim()']();

    const aliceReward = (await satori.balanceOf(alice.address)) - aliceBalBefore;
    const bobReward = (await satori.balanceOf(bob.address)) - bobBalBefore;
    const carolReward = (await satori.balanceOf(carol.address)) - carolBalBefore;

    // Ratios should still hold regardless of scoring order. Nothing to strip:
    // being a round's first predictor carries no premium any more, so every
    // payout here is pure proportional scoring.
    const bobToAlice = (bobReward * 1000n) / aliceReward;
    const carolToAlice = (carolReward * 1000n) / aliceReward;

    expect(bobToAlice).to.be.closeTo(2000n, 10n);
    expect(carolToAlice).to.be.closeTo(3000n, 10n);
  });
});
