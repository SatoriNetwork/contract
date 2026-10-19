const { expect } = require("chai");
const { deploySatoriFixtureNoFee, RAW_TOLERANCE, pack1, voteFor, VOTE } = require("./fixtures");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

// Helper function to extract streamId from DataStreamCreated event
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

// This stream is created the way a real user gets one: through the 2-arg
// overload, which now yields cadence 2 (daily — the finest a public stream may
// be). A cadence-2 stream accepts one value per 2-round period, so "next round"
// for the purposes of posting a value is TWO rounds on.
const ROUND = 86400;                              // 24h
const CADENCE_ROUNDS = 2;                         // daily

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
// (2 × 86400s cadence period − 1800s slack), causing a fragile
// CadenceGapNotElapsed() revert on the FIRST in-period setValue. Aligning here
// guarantees the gap is a near-full cadence period (~86400s) for every test.
async function alignToRoundBoundary() {
  const currentTime = await time.latest();
  const nextMidnight = Math.floor(currentTime / 86400) * 86400 + 86400;
  await time.increaseTo(nextMidnight + 1);
}

describe("Reward Distribution Accuracy", function () {
  let satori, rewards, bounties, lens, voting;
  let registry;
  let owner;
  let addr1;
  let addr2;
  let addr3;
  let addr4;

  beforeEach(async function () {
    [owner, addr1, addr2, addr3, addr4] = await ethers.getSigners();

    // Legacy platform fee deployed at 0 bps. NOTE: the senior "dev fee" now
    // lives on the immutable token and is carved out UNCONDITIONALLY (even in
    // the NoFee fixture), so the on-chain game gross is the residual
    // 720 − devRateNow (= 576 at genesis tier 1), not the legacy 720.
    const fix = await deploySatoriFixtureNoFee();
    ({ satori, rewards, registry, bounties, lens, voting, owner } = fix);
  });

  it("Should calculate and distribute rewards with mathematical accuracy", async function() {
    // Setup: Enable test mode

    const [alice, bob, carol, dave] = [addr1, addr2, addr3, addr4];

    // Create stream. The fixture initializes the DEFAULT stream at id 1 (as
    // production does), so this one lands at id 2 — captured from the event
    // rather than hardcoded.
    const tx = await satori.createSimpleDataStream("ETH/USD", owner.address);
    const streamId = await getStreamIdFromTx(tx, satori);

    // Snap to a round boundary so the initial setValue timestamp is aligned and
    // the first in-round setValue after advanceToNextRound clears the cadence
    // gap robustly (see alignToRoundBoundary()).
    await alignToRoundBoundary();

    // Set initial value
    await registry.setValue(streamId, 1000);

    // Make the game earn (any burnt weight > 0 does — no threshold, no cap).
    // The OWNER casts the burn, not a predictor: voting now DESTROYS the
    // voter's SATORI, and prediction power is balance + unclaimed, so a
    // predictor who voted would no longer hold the exact 1:2:3:4 stake this
    // test's arithmetic depends on. The weight is permanent, so one burn in
    // round 0 keeps the game earning for every round below.
    await voteFor(satori, owner, streamId);

    // Actor weights are derived from INITIAL_MINT so the reward math scales
    // with the bootstrap. 1:2:3:4 ratio: alice=1U, bob=2U, carol=3U, dave=4U;
    // sum=10U. UNIT = INITIAL_MINT/15 = 48 → totals fit under bootstrap even
    // after the owner's 10-ether burn.
    const INITIAL_MINT = await satori.INITIAL_MINT();
    const UNIT = INITIAL_MINT / 15n;
    await satori.transfer(alice.address, UNIT * 1n);

    await advanceToNextRound(); // production period 0 -> 1 (2 rounds)

    // Update value for round 1
    await registry.setValue(streamId, 1050);

    // Round 1 Predictions (prediction weight is now simply power × multiplier;
    // the old × WEIGHT_SCALE / totalVotes normalisation is gone, and it
    // cancelled anyway):
    // Alice: UP,   1U tokens, streak 0 -> weight = 1U * dustMultiplier
    // Bob:   UP,   2U tokens, streak 0 -> weight = 2U * dustMultiplier
    // Carol: DOWN, 3U tokens, streak 0 -> weight = 3U * dustMultiplier
    // Dave:  UP,   4U tokens, streak 0 -> weight = 4U * dustMultiplier
    // Total: 10U tokens (within initial supply)

    await satori.transfer(bob.address, UNIT * 2n);
    await satori.transfer(carol.address, UNIT * 3n);
    await satori.transfer(dave.address, UNIT * 4n);

    // No re-vote needed each round any more: burnt weight is permanent, so the
    // owner's round-0 burn still backs the game here and in every round below.
    const round1 = await satori.getCurrentRound();
    console.log(`\nRound 1 round: ${round1}`);
    console.log(`Stream value: 1050`);

    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(1) }]); // UP
    await satori.connect(bob).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(1) }]);   // UP
    await satori.connect(carol).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(2) }]); // DOWN
    await satori.connect(dave).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(1) }]);  // UP

    // Close round, outcome = UP (increase value)
    await advanceToNextRound(); // production period 1 -> 2 (2 rounds)
    await registry.setValue(streamId, 1100); // Value increased

    // A daily stream resolves a prediction from its own round's value against
    // the next value posted, so period 1's bets are settleable once period 2's
    // value lands; period 3's predictions are what actually triggers scoring.
    await advanceToNextRound(); // production period 2 -> 3 (2 rounds)
    await registry.setValue(streamId, 1200); // Update value for round 3

    // Round 3: Make predictions to trigger scoring of Round 1 predictions
    const round3 = await satori.getCurrentRound();
    console.log(`Round 3 round: ${round3}`);

    // All users make round 3 predictions to trigger scoring for all round 1 predictions
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(1) }]);
    console.log("After Alice round 3 prediction:");
    console.log(`  Alice unclaimedRewards: ${ethers.formatEther((await lens.getTotalClaimableRewards(alice.address))[0])}`);

    await satori.connect(bob).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(1) }]);
    console.log("After Bob round 3 prediction:");
    console.log(`  Alice unclaimedRewards: ${ethers.formatEther((await lens.getTotalClaimableRewards(alice.address))[0])}`);

    await satori.connect(carol).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(1) }]);
    console.log("After Carol round 3 prediction:");
    console.log(`  Alice unclaimedRewards: ${ethers.formatEther((await lens.getTotalClaimableRewards(alice.address))[0])}`);

    await satori.connect(dave).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(1) }]);
    console.log("After Dave round 3 prediction:");
    console.log(`  Alice unclaimedRewards: ${ethers.formatEther((await lens.getTotalClaimableRewards(alice.address))[0])}`);


    // v5: per-round claimable view is stubbed (returns 0 unconditionally);
    // surface the canonical per-user total instead so logs remain useful for
    // diagnostics. The actual assertion contract for this test lives further
    // down (proportional split between predictors).
    console.log(`\nChecking total claimable after round ${round1} scoring:`);
    const aliceTotalClaimable = (await lens.getTotalClaimableRewards(alice.address))[0];
    console.log(`Alice total claimable: ${ethers.formatEther(aliceTotalClaimable)}`);

    // Advance more rounds to ensure rewards become claimable
    await advanceToNextRound();
    await advanceToNextRound();
    await advanceToNextRound();

    console.log(`\nAfter advancing 3 more rounds:`);
    const aliceTotalClaimableAfter = (await lens.getTotalClaimableRewards(alice.address))[0];
    console.log(`Alice total claimable: ${ethers.formatEther(aliceTotalClaimableAfter)}`);

    // The round denominator is now ACCUMULATED, not locked: the first predictor
    // of each game in a round writes gameVotesAtRound[g][r] and adds it to
    // roundVoteTotal[r]. Only this game was predicted in round 1, so it is the
    // whole denominator and takes the entire round budget.
    const gameVotes = await voting.getGameVotesAtRound(streamId, round1);
    const roundTotal = await voting.roundVoteTotal(round1);
    console.log(`gameVotesAtRound[${streamId}][${round1}]: ${ethers.formatEther(gameVotes)}`);
    console.log(`roundVoteTotal[${round1}]: ${ethers.formatEther(roundTotal)}`);
    expect(gameVotes).to.equal(VOTE);
    expect(roundTotal).to.equal(VOTE);

    // Check if weight was recorded (per-direction now lives in SatoriRewards)
    const aliceWeightUp = await lens.userWeightByDirection(alice.address, streamId, round1, 1);
    const aliceWeightDown = await lens.userWeightByDirection(alice.address, streamId, round1, 2);
    console.log(`Alice weight (UP) for stream ${streamId} round ${round1}: ${aliceWeightUp}`);
    console.log(`Alice weight (DOWN) for stream ${streamId} round ${round1}: ${aliceWeightDown}`);

    // Check Alice's prediction state to see if it's scored
    const alicePred = await satori.predictions(alice.address, streamId, round1);
    console.log(`Alice prediction at round ${round1}: direction=${alicePred.direction}, scored=${alicePred.scored}`);

    // Correct predictors: Alice, Bob, Dave
    // Total correct weight: 1U + 2U + 4U = 7U
    // On-chain round pool (residual after the senior dev fee): 576 ether
    // at genesis tier 1 (was 720 before the dev fee moved to the token). The
    // WHOLE 576 is now distributable — the value-provider cut and the
    // first-predictor bonus reservation are both gone.

    // Expected rewards scale off the 576 residual pool (before the 5% skim):
    // Alice: (1 / 7) * 576 = 90.514285714... ether
    // Bob:   (2 / 7) * 576 = 181.028571428... ether
    // Dave:  (4 / 7) * 576 = 362.057142857... ether
    // Carol: 0 (incorrect prediction)

    // Claim rewards for Alice
    const aliceBalanceBefore = await satori.balanceOf(alice.address);
    console.log(`Alice balance before claim: ${ethers.formatEther(aliceBalanceBefore)}`);

    const aliceClaimable = (await lens.getTotalClaimableRewards(alice.address))[0];
    console.log(`Alice claimable: ${ethers.formatEther(aliceClaimable)}`);

    await satori.connect(alice).claim();
    const aliceBalanceAfter = await satori.balanceOf(alice.address);
    const aliceReward = aliceBalanceAfter - aliceBalanceBefore;
    console.log(`Alice reward claimed: ${ethers.formatEther(aliceReward)}`);

    // Claim rewards for Bob
    const bobBalanceBefore = await satori.balanceOf(bob.address);
    await satori.connect(bob).claim();
    const bobBalanceAfter = await satori.balanceOf(bob.address);
    const bobReward = bobBalanceAfter - bobBalanceBefore;

    // Claim rewards for Carol
    const carolBalanceBefore = await satori.balanceOf(carol.address);
    await satori.connect(carol).claim();
    const carolBalanceAfter = await satori.balanceOf(carol.address);
    const carolReward = carolBalanceAfter - carolBalanceBefore;

    // Claim rewards for Dave
    const daveBalanceBefore = await satori.balanceOf(dave.address);
    await satori.connect(dave).claim();
    const daveBalanceAfter = await satori.balanceOf(dave.address);
    const daveReward = daveBalanceAfter - daveBalanceBefore;

    // Calculate expected rewards with exact precision.
    // Weights are alice=1U, bob=2U, dave=4U; total correct = 7U.
    // The per-round payable budget IS the on-chain gross now: the reserved
    // first-predictor bonus is gone (so nothing is withheld) and there is no
    // value-provider cut (providers are not paid at all any more). The gross is
    // the RESIDUAL after the senior dev fee (moved to the immutable token; see
    // test/next/DevFee.test.js): gross = ROUND_REWARD_BUDGET − devRateNow
    // (offchainBudget = 0 here), so at genesis tier 1 gross = 720 − 144 = 576.
    // This game was the only one predicted in round 1, so it is the entire round
    // denominator and takes the whole 576. It is not the default game, so each
    // winner is paid its weight over BOTH sides' 10 units (B4): 1:2:4 tenths,
    // and carol's 3 tenths are not minted.
    // The hub's per-round emission, not the token's 1440 envelope.
    const gross = (await satori.emissionRateNow()) - (await satori.devRateNow());
    const payablePool = gross;
    const bothSidesWeight = UNIT * 10n;

    // Referral eager-credit model: every scoring reward is skimmed 5%
    // (REFERRAL_BPS = 500 bps) at CREDIT time and routed to the earner's
    // referral, or — for a zero/self referral, as here — to
    // MARKETING_FEE_RECIPIENT. The cut is floor(amount * 500 / 10000) per
    // credit; the earner nets amount − cut.
    const netScore = (raw) => raw - (raw * 500n) / 10000n; // subtract floor(raw*500/10000) skim

    // Raw (pre-skim) scoring shares: 1, 2 and 4 tenths of the payable pool.
    const aliceScore = (UNIT * 1n * payablePool) / bothSidesWeight;
    const bobScore = (UNIT * 2n * payablePool) / bothSidesWeight;
    const daveScore = (UNIT * 4n * payablePool) / bothSidesWeight;

    const expectedAliceReward = netScore(aliceScore);
    const expectedBobReward = netScore(bobScore);
    const expectedDaveReward = netScore(daveScore);
    const expectedCarolReward = 0n;

    // Verify rewards within the Side-A rawPower-quantization tolerance.
    // Pre-Side-A used a 1-wei tolerance; post-Side-A the floor is ~10⁹ wei
    // (rawPower rounded to nearest 2^30) and compounded rounding through
    // the share-of-pot math lifts the realistic bound to RAW_TOLERANCE.
    const tolerance = RAW_TOLERANCE;

    expect(aliceReward).to.be.closeTo(expectedAliceReward, tolerance);
    expect(bobReward).to.be.closeTo(expectedBobReward, tolerance);
    expect(daveReward).to.be.closeTo(expectedDaveReward, tolerance);
    expect(carolReward).to.equal(expectedCarolReward);

    // Conservation holds EXACTLY at the total level: the 5% skimmed from each
    // earner lands in the MARKETING_FEE_RECIPIENT bucket (zero/self referral),
    // so earners' claims + that bucket account for the winners' 7 tenths of
    // the round budget. Include the marketing bucket in the sum so the
    // invariant remains exact — documenting where the 5% went rather than
    // weakening the check.
    const marketingBucket = await rewards.unclaimedRewards(await rewards.marketingFeeRecipient());
    const totalDistributed = aliceReward + bobReward + carolReward + daveReward + marketingBucket;
    expect(totalDistributed).to.be.closeTo((payablePool * 7n) / 10n, RAW_TOLERANCE);

    // Log the results for verification
    console.log("\n=== Reward Distribution Results ===");
    console.log(`Alice reward: ${ethers.formatEther(aliceReward)} (expected: ${ethers.formatEther(expectedAliceReward)})`);
    console.log(`Bob reward: ${ethers.formatEther(bobReward)} (expected: ${ethers.formatEther(expectedBobReward)})`);
    console.log(`Carol reward: ${ethers.formatEther(carolReward)} (expected: ${ethers.formatEther(expectedCarolReward)})`);
    console.log(`Dave reward: ${ethers.formatEther(daveReward)} (expected: ${ethers.formatEther(expectedDaveReward)})`);
    console.log(`Marketing (referral skim) bucket: ${ethers.formatEther(marketingBucket)}`);
    console.log(`Total distributed (earners + marketing): ${ethers.formatEther(totalDistributed)} (expected: ${ethers.formatEther((payablePool * 7n) / 10n)})`);
    console.log(`Difference: ${totalDistributed - (payablePool)} wei`);
  });
});
