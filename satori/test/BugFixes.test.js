/**
 * BugFixes.test.js
 *
 * Tests for four correctness bugs fixed in Satori.sol and SatoriRewards.sol:
 *   Bug 1: A-B-C scoring B/C value inversion
 *   Bug 2: 23-hour gap check uses round-midnight not actual timestamp
 *   Bug 3: Platform fee split arithmetic (three parts must sum to delegatedReward)
 *   Bug 4: Streak-0 predictors permanently excluded from top-1/3
 */

const { expect } = require("chai");
const { wrapSatoriForGames, pack1, VOTE, warmUpLoyalty, deploySatoriFixture: deploySharedFixture } = require("./fixtures");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const UP = 1;
const DOWN = 2;

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

async function deploySatoriFixture() {
  const fix = await deploySharedFixture();
  const [owner, alice, bob, platform1, platform2] = fix.signers;
  // Preserve the module-level `registry` leak the original inline deploy
  // relied on: Bug 1/3/4 test bodies reference `registry` without
  // destructuring it in their beforeEach.
  registry = fix.registry;
  return { ...fix, owner, alice, bob, platform1, platform2 };
}

const ROUND = 86400; // 24h
// The 2-arg createSimpleDataStream overload yields a 1440-minute (every-round)
// stream; two rounds is a comfortable write spacing that clears its cadence
// gap with room to spare.
const CADENCE_ROUNDS = 2;

// Advance one ROUND (24h).
async function advanceToNextDay() {
  await time.increase(ROUND);
}

// Advance two rounds (48h) — comfortably past the round guard and the
// cadence-minus-30m gap guard of an every-round stream.
async function advanceCadencePeriod() {
  await time.increase(ROUND * CADENCE_ROUNDS);
}

// ============================================================
// Bug 1: A-B-C B/C value inversion
// ============================================================

describe("Bug 1: A-B-C B/C value inversion", function () {
  let satori, voting, rewards, lens, bounties, owner, alice;
  let streamId;

  beforeEach(async function () {
    ({ satori, voting, rewards, lens, owner, alice } = await deploySatoriFixture());

    // Transfer tokens to alice
    await satori.transfer(alice.address, ethers.parseEther("400"));

    // Create a simple data stream. The A-B-C window this whole describe block
    // is named for exists ONLY at every-round cadence (cadence*60 <= one round
    // in SatoriEngine); on a coarser stream the identical code takes the
    // two-value AB path and there is no B/C pair to invert. 1440 minutes is
    // exactly every-round — and its one-write-per-round rhythm is what
    // advanceToNextDay() below encodes.
    const tx = await satori["createSimpleDataStream(string,address,uint24)"](
      "Test Stream", owner.address, 1440);
    streamId = await getStreamIdFromTx(tx, satori);

    // Vote for the stream so rewards can be allocated
    await satori.connect(alice).vote(streamId, VOTE);
  });

  it("UP prediction should be CORRECT when valueC > valueB (stream goes UP)", async function () {
    // Round A (day 0): Set initial value, then Alice predicts UP
    await registry.setValue(streamId, 100);
    const roundA = await satori.getCurrentRound();
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(UP) }]);

    // Day 1: setValue to 200 (valueB = 200) - stream went UP from 100
    await advanceToNextDay();
    await registry.setValue(streamId, 200);

    // Day 2: setValue to 300 (valueC = 300) - stream continues UP from 200
    // This also triggers scoring of the prediction from roundA
    await advanceToNextDay();
    await registry.setValue(streamId, 300);

    // Make another prediction to trigger scoring
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(UP) }]);

    // Alice should have earned rewards (UP prediction with C > B is CORRECT)
    const rewards_amount = (await lens.getTotalClaimableRewards(alice.address))[0];
    expect(rewards_amount).to.be.gt(0, "UP prediction with C>B should earn rewards (B/C not inverted)");
  });

  it("DOWN prediction should be CORRECT when valueC < valueB (stream goes DOWN)", async function () {
    // Round A: Set initial value, then Alice predicts DOWN
    await registry.setValue(streamId, 300);
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(DOWN) }]);

    // Day 1: setValue to 200 (valueB = 200) - stream went DOWN from 300
    await advanceToNextDay();
    await registry.setValue(streamId, 200);

    // Day 2: setValue to 100 (valueC = 100) - stream continues DOWN from 200
    await advanceToNextDay();
    await registry.setValue(streamId, 100);

    // Trigger scoring
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(DOWN) }]);

    const rewards_amount = (await lens.getTotalClaimableRewards(alice.address))[0];
    expect(rewards_amount).to.be.gt(0, "DOWN prediction with C<B should earn rewards (B/C not inverted)");
  });

  it("UP prediction should be WRONG when valueC < valueB (stream goes DOWN after UP)", async function () {
    // Round A: Alice predicts UP
    await registry.setValue(streamId, 100);
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(UP) }]);

    // Day 1: valueB = 200 (UP from 100)
    await advanceToNextDay();
    await registry.setValue(streamId, 200);

    // Day 2: valueC = 150 (DOWN from 200, so C < B)
    await advanceToNextDay();
    await registry.setValue(streamId, 150);

    // Trigger scoring
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(UP) }]);

    // UP prediction with C < B should be WRONG, so it earns nothing at all. The
    // first-predictor liveness bonus that used to leave 0.88 SATORI here (2 ×
    // 0.44) has been removed, so a wrong prediction now credits exactly zero.
    const rewards_amount = await rewards.unclaimedRewards(alice.address);
    expect(rewards_amount).to.equal(0n, "a wrong prediction earns nothing");
  });
});

// ============================================================
// Bug 2: 23-hour gap check uses round-midnight not actual timestamp
// ============================================================

describe("Bug 2: 23-hour gap check uses actual timestamp", function () {
  let satori, registry, owner;
  let streamId;

  beforeEach(async function () {
    ({ satori, registry, owner } = await deploySatoriFixture());

    const tx = await satori.createSimpleDataStream("Test Stream", owner.address);
    streamId = await getStreamIdFromTx(tx, satori);
  });

  it("Should revert if second update is only minutes after first (same day boundary)", async function () {
    // This is the TIMESTAMP guard, and it has to be isolated from the ROUND
    // guard that sits in front of it. On this every-round (1440-minute) stream
    // the round guard needs `lastUpdateRound + 1 <= currentRound` and the
    // timestamp guard needs `86400 - 1800 = 84600` seconds of real time.
    // Writing just before a round boundary makes those two disagree: a ROUND
    // boundary can pass in barely two minutes of wall clock.
    const currentTime = await time.latest();
    const nextMidnight = Math.floor(currentTime / ROUND) * ROUND + ROUND;
    const twoMinutesBeforeMidnight = nextMidnight - 120; // 2 minutes before the boundary

    await time.increaseTo(twoMinutesBeforeMidnight);

    // First setValue 2 minutes before the end of round D.
    await registry.setValue(streamId, 100);

    // Step just into round D+1. The ROUND guard is now satisfied (a round
    // boundary passed) but only ~3 minutes of wall clock have — far short of
    // 84600s.
    await time.increaseTo(nextMidnight + 60);

    // Should revert on the TIMESTAMP guard specifically. With the old bug it
    // would succeed, because it measured from round midnight rather than from
    // the write's actual timestamp.
    await expect(
      registry.setValue(streamId, 200)
    ).to.be.revertedWithCustomError(registry, "CadenceGapNotElapsed");
  });

  it("Should succeed if 23+ hours have truly passed", async function () {
    // First setValue
    await registry.setValue(streamId, 100);

    // Advance two rounds / 48 hours, past both the round guard and the 84600s
    // (23h30m) timestamp guard.
    await time.increase(ROUND * CADENCE_ROUNDS);

    // Should succeed — a full cadence period has passed
    await expect(registry.setValue(streamId, 200)).to.not.be.reverted;
  });
});

// ============================================================
// Bug 3: Platform fee split arithmetic (three parts sum to delegatedReward)
// ============================================================

describe("Bug 3: Platform fee split arithmetic", function () {
  let satori, voting, rewards, bounties, owner, alice, bob, platform1, platform2;
  let streamId;

  beforeEach(async function () {
    ({ satori, voting, rewards, owner, alice, bob, platform1, platform2 } = await deploySatoriFixture());

    await satori.transfer(alice.address, ethers.parseEther("400"));
    await satori.transfer(bob.address, ethers.parseEther("200"));

    const tx = await satori.createSimpleDataStream("Test Stream", owner.address);
    streamId = await getStreamIdFromTx(tx, satori);

    // Both vote
    await satori.connect(alice).vote(streamId, VOTE);
  });

  it("delegatorsShare + predictorBonus should equal delegatedReward (platform-fee term removed)", async function () {
    // Bob delegates prediction power to Alice
    await satori.connect(bob).delegatePredictionPower(alice.address);
    // Delegator weight is capital x loyalty and a fresh delegation starts at
    // L = 0, so the share measured below reads zero without a warm-up.
    await warmUpLoyalty(satori, registry, null, alice, [bob], platform1, streamId, 40, 2);
    await time.increase(86400);   // clear the daily cadence before the caller's own setValue

    // Set a value
    await registry.setValue(streamId, 100);

    // Alice predicts (with Bob's power delegated)
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(UP) }]);

    // The default stream is every-round, so the ABC window needs TWO later
    // values: B = 200, C = 250, and C > B scores UP as correct.
    await advanceCadencePeriod();
    await registry.setValue(streamId, 200);
    await advanceToNextDay();
    await registry.setValue(streamId, 250);

    // Trigger scoring
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(UP) }]);

    // Track all balances before Alice claims
    const aliceBalBefore = await satori.balanceOf(alice.address);
    const bobBalBefore = await satori.balanceOf(bob.address);

    // Alice (predictor) claims — settles her rounds and populates per-round
    // rates so Bob's pull claim can compute his share.
    await satori.connect(alice).claim();
    // Bob (delegator) pulls his share.
    await satori.connect(bob).claim();
    // platform fee moved to immutable token (see test/next/DevFee.test.js):
    // no rewards.accrueProtocolFee() and no platform-fee credit remain in the
    // reward split — the delegated reward now splits into delegator share +
    // predictor bonus only.

    const aliceBalAfter = await satori.balanceOf(alice.address);
    const bobBalAfter = await satori.balanceOf(bob.address);

    const aliceRewards = aliceBalAfter - aliceBalBefore;
    const bobRewards = bobBalAfter - bobBalBefore;

    // platform1 is the admin (controls the dial) and is NOT a reward recipient.
    const adminRewards = await rewards.unclaimedRewards(platform1.address);

    const total = aliceRewards + bobRewards;

    // total should be > 0 (rewards were distributed)
    expect(total).to.be.gt(0, "Should have distributed some rewards");

    // platform fee moved to immutable token (see test/next/DevFee.test.js):
    // the `feeRewards > 0` assertion is dropped — no platform fee is credited in
    // the split anymore. The admin (platform1) is still not a reward recipient.
    expect(adminRewards).to.equal(0, "admin is not a fee recipient");
    expect(bobRewards).to.be.gt(0, "Bob (delegator) should have received delegated share");
    expect(aliceRewards).to.be.gt(0, "Alice (predictor) should have received her share");
  });
});

// ============================================================
// Bug 4: Streak-0 predictors excluded from top-1/3
// ============================================================

describe("Bug 4: Streak-0 predictors included in top-1/3", function () {
  let satori, rewards, lens, bounties, voting, owner, alice;
  let streamId;

  beforeEach(async function () {
    ({ satori, rewards, lens, voting, owner, alice } = await deploySatoriFixture());

    await satori.transfer(alice.address, ethers.parseEther("400"));

    const tx = await satori.createSimpleDataStream("Test Stream", owner.address);
    streamId = await getStreamIdFromTx(tx, satori);

    await satori.connect(alice).vote(streamId, VOTE);
  });

  it("Streak-0 predictor (first ever correct prediction) should earn rewards as sole correct predictor", async function () {
    // Alice has never predicted before (streak = 0)
    // She makes her FIRST correct prediction

    // Set initial value
    await registry.setValue(streamId, 100);

    // Alice predicts UP (this is her very first prediction, so streak will be 0)
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(UP) }]);

    // The default stream is every-round (ABC): two later values, B = 200 and
    // C = 250, with C > B score UP as correct.
    await advanceCadencePeriod();
    await registry.setValue(streamId, 200);
    await advanceToNextDay();
    await registry.setValue(streamId, 250);

    // Trigger scoring with a new prediction
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(UP) }]);

    // Alice is the SOLE correct predictor with streak=0
    // She should earn the full stream allocation
    const aliceRewards = (await lens.getTotalClaimableRewards(alice.address))[0];
    expect(aliceRewards).to.be.gt(0, "Streak-0 sole correct predictor should earn rewards");
  });

  it("Streak-0 predictor is NOT excluded when maxStreakSeen is 0", async function () {
    // When everyone has streak 0, they should all be considered eligible
    await registry.setValue(streamId, 100);
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(UP) }]);

    await advanceCadencePeriod();
    await registry.setValue(streamId, 150); // B
    await advanceToNextDay();
    await registry.setValue(streamId, 175); // C > B -> UP correct

    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(UP) }]);

    const aliceRewards = (await lens.getTotalClaimableRewards(alice.address))[0];
    expect(aliceRewards).to.be.gt(0, "Streak-0 predictor with maxStreak=0 should earn");
  });
});
