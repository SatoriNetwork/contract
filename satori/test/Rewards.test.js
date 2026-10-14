const { expect } = require("chai");
const { deploySatoriFixture, pack1, voteFor } = require("./fixtures");
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

// Helper to advance to next day and call endRound
async function advanceToNextRound() {
  const currentTime = await time.latest();
  const nextMidnight = Math.floor(currentTime / 86400) * 86400 + 86400;
  await time.increaseTo(nextMidnight + 1);
  await time.increase(86400);
}

describe("Reward System", function () {
  let satori, voting, rewards, bounties, registry, lens;
  let owner;
  let alice;
  let bob;
  let carol;

  let stream1, stream2, stream3;

  // Prediction directions
  const UP = 1;
  const DOWN = 2;

  beforeEach(async function () {
    [owner, alice, bob, carol] = await ethers.getSigners();

    // Restructured Satori stack via shared fixture (2000 bps platform fee).
    const fix = await deploySatoriFixture();
    ;({ satori, voting, rewards, bounties, registry, lens, owner } = fix);

    // Create test streams. Every scoring assertion below is written against the
    // A-B-C framework (score a prediction from the TWO values that follow it),
    // and only a cadence-1 (every-round) stream is scored that way — a stream at
    // cadence >= 2 resolves from the anchor value and the single next value.
    // A cadence-1 stream is admin-only, and `owner` (signers[0]) is the rewards
    // admin here, so these are admin-created every-round streams.
    const tx1 = await satori["createSimpleDataStream(string,address,uint24)"]("Stream 1", owner.address, 720);
    stream1 = await getStreamIdFromTx(tx1, satori);

    const tx2 = await satori["createSimpleDataStream(string,address,uint24)"]("Stream 2", owner.address, 720);
    stream2 = await getStreamIdFromTx(tx2, satori);

    const tx3 = await satori["createSimpleDataStream(string,address,uint24)"]("Stream 3", owner.address, 720);
    stream3 = await getStreamIdFromTx(tx3, satori);

    // Give users tokens. 3 streams created above consumed 42 SATORI from
    // the 720 INITIAL_MINT; cap distribution so the deployer keeps a buffer.
    await satori.transfer(alice.address, ethers.parseEther("180"));
    await satori.transfer(bob.address, ethers.parseEther("90"));
    await satori.transfer(carol.address, ethers.parseEther("270"));

    // DAVE is the sole burner for all three streams. Voting now BURNS the
    // voter's tokens, and this file's reward assertions are expressed as exact
    // ratios of alice : bob : carol holdings (180 : 90 : 270) — having any of
    // them buy weight would quietly shift those ratios. Concentrating the burns
    // on a fourth account keeps the three predictors' power exactly as funded,
    // and gives all three streams EQUAL weight so a round they share splits
    // evenly. The weight is permanent, so this one pass covers every round.
    const signers = await ethers.getSigners();
    const dave = signers[4];
    await satori.transfer(dave.address, ethers.parseEther("100"));

    await voteFor(satori, dave, stream1);
    await voteFor(satori, dave, stream2);
    await voteFor(satori, dave, stream3);

    // Advance one round so streams have stable eligibility
    await advanceToNextRound();
  });

  describe("Basic Reward Calculation", function () {
    it("Should calculate correct reward for single predictor", async function () {
      // R1: Alice predicts Stream 1
      await registry.setValue(stream1, 100);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);


      // R2: Value changes, predict again
      await advanceToNextRound();
      await registry.setValue(stream1, 150); // UP
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // R3: Score R1 (should be correct: 100→150 = UP)
      await advanceToNextRound();
      const round3 = await satori.getCurrentRound();
      await registry.setValue(stream1, 200);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // Check streak incremented (weight might not be directly checkable)
      const streak = await satori.streaks(alice.address, stream1);
      expect(streak).to.equal(1);

      // Claim reward
      const balanceBefore = await satori.balanceOf(alice.address);
      await satori.connect(alice)['claim()']();
      const balanceAfter = await satori.balanceOf(alice.address);

      // Alice should receive some reward
      expect(balanceAfter).to.be.gt(balanceBefore);
    });

    it("Should give zero reward for incorrect prediction", async function () {
      // A-B-C Framework: Prediction scored using B and C (values AFTER prediction)
      // For incorrect: Need C < B with UP prediction, or C > B with DOWN prediction

      // R1: Alice predicts UP at value 100
      await registry.setValue(stream1, 100);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // R2: Set B = 150 (first value after prediction)
      await advanceToNextRound();
      await registry.setValue(stream1, 150); // B = 150

      // R3: Set C = 120 (second value after prediction)
      // C < B = DOWN movement, Alice predicted UP = INCORRECT
      await advanceToNextRound();
      await registry.setValue(stream1, 120); // C = 120
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]); // Triggers scoring of R1

      // Check streak reset (incorrect prediction)
      const streak = await satori.streaks(alice.address, stream1);
      expect(streak).to.equal(0);

      // Cannot claim (no weight) - with new claim() there's just nothing to claim
      const balanceBefore = await satori.balanceOf(alice.address);
      await satori.connect(alice)['claim()']();
      const balanceAfter = await satori.balanceOf(alice.address);

      // Nothing at all is minted: the prediction was wrong, and being a round's
      // first predictor no longer carries a liveness bonus.
      expect(balanceAfter).to.equal(balanceBefore);
    });

    it("Should increase reward with streak", async function () {
      // Under the new curve (no +1 lookahead, first-prediction bypass):
      //   R1 commit: state.count==0 → bypass mult=1 (faucet)
      //   R2 commit: streak=0, not first → mult=0
      //   R3 commit: streak=1 (R1 just scored), not first → dust mult=1 (streak<threshold)
      //   R4 commit: streak=2 (R2 just scored) → thr-2 ramp mult(2)=√2×10=14 (below the floor-4 bar)
      // R4's commit weight should exceed R1's commit weight.

      // R1: first prediction → bypass mult=1
      const dateR1 = await satori.getCurrentRound();
      await registry.setValue(stream1, 100);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // R2: B for R1.
      await advanceToNextRound();
      await registry.setValue(stream1, 150);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // R3: C for R1 — R1 scored (streak→1). R3 commit at dust mult=1 (streak<threshold).
      await advanceToNextRound();
      await registry.setValue(stream1, 200);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // R4: C for R2 — R2 scored (streak→2). R4 commit at the thr-2 ramp
      // mult(2)=√2×10=14 (streak 2 is 2 below the floor-4 bar). First graded-ramp weight above raw dust.
      await advanceToNextRound();
      const dateR4 = await satori.getCurrentRound();
      await registry.setValue(stream1, 250);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      const weightR1 = await lens.userWeightByDirection(alice.address, stream1, dateR1, UP);
      const weightR4 = await lens.userWeightByDirection(alice.address, stream1, dateR4, UP);

      // R4 (ramp mult=12) > R1 (bypass mult=1).
      expect(weightR4).to.be.gt(weightR1);
    });
  });

  describe("Streak Tracking", function () {
    it("Should start streak at 0", async function () {
      const streak = await satori.streaks(alice.address, stream1);
      expect(streak).to.equal(0);
    });

    it("Should increment streak on correct prediction", async function () {
      // Make 3 correct predictions in a row
      for (let i = 0; i < 5; i++) {
        await registry.setValue(stream1, 100 + i * 50);
        await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);
        await advanceToNextRound();
      }

      // After 5 rounds, first 3 predictions should be scored
      // All were correct (UP predictions, values increasing)
      const streak = await satori.streaks(alice.address, stream1);
      expect(streak).to.equal(3); // R0, R1, R2 scored correctly
    });

    it("Should reset streak on incorrect prediction", async function () {
      // R1: First prediction (will be correct)
      await registry.setValue(stream1, 100);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // R2: B for R1
      await advanceToNextRound();
      await registry.setValue(stream1, 150); // B = 150
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]); // R2 prediction

      // R3: C for R1 (scores R1 as correct), B for R2
      await advanceToNextRound();
      await registry.setValue(stream1, 200); // C = 200 for R1
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);
      // R1 scoring: B=150, C=200, C>B=UP, predicted UP = CORRECT, streak = 1

      let streak = await satori.streaks(alice.address, stream1);
      expect(streak).to.equal(1);

      // R4: C for R2 (scores R2 as incorrect)
      // C < B = DOWN, but predicted UP = INCORRECT
      await advanceToNextRound();
      await registry.setValue(stream1, 180); // C = 180 for R2
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);
      // R2 scoring: B=200, C=180, C<B=DOWN, predicted UP = INCORRECT, streak = 0

      streak = await satori.streaks(alice.address, stream1);
      expect(streak).to.equal(0);
    });

    it("Should track streaks independently per stream", async function () {
      // Use stream1 and stream3 (both eligible: s1=310, s3=300, total=710, threshold=355).
      // Start parallel predictions on two streams
      // R1: Predict both streams UP
      await registry.setValue(stream1, 100);
      await registry.setValue(stream3, 100);
      await satori.connect(alice).predictMultipleWithPayloads([
        { gameId: stream1, payload: pack1(UP) },
        { gameId: stream3, payload: pack1(UP) }
      ]);

      // R2: Set B values for both streams
      await advanceToNextRound();
      await registry.setValue(stream1, 150); // B for stream1
      await registry.setValue(stream3, 150); // B for stream3
      await satori.connect(alice).predictMultipleWithPayloads([
        { gameId: stream1, payload: pack1(UP) },
        { gameId: stream3, payload: pack1(UP) }
      ]);

      // R3: Set C values - stream1 correct, stream3 incorrect
      await advanceToNextRound();
      await registry.setValue(stream1, 200); // C=200 > B=150 = UP (correct)
      await registry.setValue(stream3, 120); // C=120 < B=150 = DOWN (incorrect, predicted UP)
      await satori.connect(alice).predictMultipleWithPayloads([
        { gameId: stream1, payload: pack1(UP) },
        { gameId: stream3, payload: pack1(UP) }
      ]);

      const streak1 = await satori.streaks(alice.address, stream1);
      const streak3 = await satori.streaks(alice.address, stream3);

      // Stream1: B=150, C=200, C>B=UP, predicted UP = CORRECT, streak = 1
      expect(streak1).to.equal(1);
      // Stream3: B=150, C=120, C<B=DOWN, predicted UP = INCORRECT, streak = 0
      expect(streak3).to.equal(0);
    });
  });

  describe("Prediction Power Division", function () {
    it("Should divide power among multiple streams predicted", async function () {
      // Use stream1 and stream3 (both eligible: s1=310, s3=300, total=710, threshold=355).
      const currentDate = await satori.getCurrentRound();
      await registry.setValue(stream1, 100);
      await registry.setValue(stream3, 100);

      await satori.connect(alice).predictMultipleWithPayloads([
        { gameId: stream1, payload: pack1(UP) },
        { gameId: stream3, payload: pack1(UP) }
      ]);

      // Check stream count for current round
      const streamCount = await satori.predictedStreamsCount(alice.address, currentDate);
      expect(streamCount).to.equal(2);

      // Prediction power should be divided: power / 2 for each stream
      // Note: rawPredictionPower is NOT divided, but effective power is calculated at scoring
    });

    it("Should use full power when predicting single stream", async function () {
      const currentDate = await satori.getCurrentRound();
      await registry.setValue(stream1, 100);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      const streamCount = await satori.predictedStreamsCount(alice.address, currentDate);
      expect(streamCount).to.equal(1);

      // Full power (1000 tokens) used for this stream
    });

    it("Should calculate effective power correctly at scoring", async function () {
      // Use stream1 and stream3 (both eligible: s1=310, s3=300, total=710, threshold=355).
      // Alice predicts 2 streams in R1 — first prediction so multiplier = 1.
      const dateR1 = await satori.getCurrentRound();
      await registry.setValue(stream1, 100);
      await registry.setValue(stream3, 100);
      await satori.connect(alice).predictMultipleWithPayloads([
        { gameId: stream1, payload: pack1(UP) },
        { gameId: stream3, payload: pack1(UP) }
      ]);

      // Check weights at R1 — both streams should have equal weight, both > 0,
      // and the per-stream rawPower committed should be the divided portion
      // (predictionPower / streamCount). Querying before any further predicts
      // keeps the R1 record in the packed 2-slot ring.
      const weight1 = await lens.userWeightByDirection(alice.address, stream1, dateR1, UP);
      const weight3 = await lens.userWeightByDirection(alice.address, stream3, dateR1, UP);

      expect(weight1).to.equal(weight3);
      expect(weight1).to.be.gt(0);
    });
  });

  describe("Multiple Predictors", function () {
    it("Should split rewards proportionally by weight", async function () {
      // Alice: 1000 tokens, Bob: 500 tokens
      // Both predict correctly with streak = 1
      // Alice should get 2x Bob's reward

      await registry.setValue(stream1, 100);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);
      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // R2: B value
      await advanceToNextRound();
      await registry.setValue(stream1, 150); // B
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);
      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // R3: C value (scores R1)
      await advanceToNextRound();
      await registry.setValue(stream1, 200); // C > B = UP (correct)
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);
      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // Claim rewards
      const aliceBalanceBefore = await satori.balanceOf(alice.address);
      const bobBalanceBefore = await satori.balanceOf(bob.address);

      await satori.connect(alice)['claim()']();
      await satori.connect(bob)['claim()']();

      const aliceBalanceAfter = await satori.balanceOf(alice.address);
      const bobBalanceAfter = await satori.balanceOf(bob.address);

      const aliceReward = aliceBalanceAfter - aliceBalanceBefore;
      const bobReward = bobBalanceAfter - bobBalanceBefore;

      // Alice should get exactly 2x Bob's reward (180 vs 90 tokens of power).
      // Nothing to subtract: predicting first in a round carries no premium now,
      // and neither of them burned any tokens, so their power is as funded.
      expect(aliceReward).to.be.closeTo(bobReward * 2n, ethers.parseEther("0.01"));
    });

    it("Should favor higher streak with proportional rewards", async function () {
      // Build Bob's streak to 2
      // R1: Bob predicts
      await registry.setValue(stream1, 100);
      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // R2: B for Bob's R1
      await advanceToNextRound();
      await registry.setValue(stream1, 150);
      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // R3: C for Bob's R1 (scores as correct, streak = 1)
      await advanceToNextRound();
      await registry.setValue(stream1, 200); // C > B = UP (correct)
      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // R4: C for Bob's R2 (scores as correct, streak = 2)
      await advanceToNextRound();
      await registry.setValue(stream1, 250); // C > B = UP (correct)
      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // Now Bob has streak = 2

      // R5: Both Alice (first prediction, streak=0) and Bob (streak=2) predict
      await advanceToNextRound();
      const date_R5 = await satori.getCurrentRound();
      await registry.setValue(stream1, 300);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);
      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // R6: B for both R5 predictions
      await advanceToNextRound();
      await registry.setValue(stream1, 350);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);
      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // R7: C for R5 predictions (scores both as correct)
      // Alice: streak was 0 (first prediction), weight ∝ 1000 × 1
      // Bob: streak was 2, weight ∝ 500 × √2×10=14 (thr-2 ramp, below the floor-4 bar)
      await advanceToNextRound();
      await registry.setValue(stream1, 400); // C > B = UP (correct)
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);
      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // Check weights at R6 — Alice's R6 multiplier is 0 (streak=0, not first);
      // Bob's R6 multiplier is the streak-curve value for his accumulated
      // streak. Bob's weight > 0 while Alice's is 0 — the streak preference
      // is reflected. (R5 records were overwritten in the 2-slot ring when
      // R7's prediction landed.)
      // advanceToNextRound advances by 2 rounds (helper bumps half-day twice).
      const date_R6 = date_R5 + 2n;
      const aliceWeight = await lens.userWeightByDirection(alice.address, stream1, date_R6, UP);
      const bobWeight = await lens.userWeightByDirection(bob.address, stream1, date_R6, UP);

      expect(bobWeight).to.be.gt(aliceWeight);
    });
  });

  describe("Vote Weight Distribution", function () {
    it("Should allocate rewards proportional to prediction power on same stream", async function () {
      // Test: Alice (1000) and Bob (500) both predict on stream1
      // They should split rewards 2:1 based on their prediction power

      // Both vote for and predict stream1
      // stream1 has 1500 total votes, is eligible

      // Make predictions
      await registry.setValue(stream1, 100);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);
      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      await advanceToNextRound();
      await registry.setValue(stream1, 150);  // UP (correct)
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);
      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      await advanceToNextRound();
      await registry.setValue(stream1, 200);

      // Score the round-1 predictions so there's an actual scoring reward to
      // compare (previously this checked unclaimedRewards before any scoring).
      await satori.settlePrediction(alice.address, stream1);
      await satori.settlePrediction(bob.address, stream1);

      const aliceRewardCalc = await rewards.unclaimedRewards(alice.address);
      const bobRewardCalc = await rewards.unclaimedRewards(bob.address);

      // Alice should get exactly 2x Bob's scoring reward (180 vs 90 power).
      // Nothing to subtract: there is no first-predictor add-on any more, and
      // neither of them burned, so their power is exactly as funded.
      expect(aliceRewardCalc).to.be.closeTo(bobRewardCalc * 2n, ethers.parseEther("0.01"));
    });
  });

  describe("Claiming Mechanics", function () {
    it("Should allow claiming after prediction scored", async function () {
      await registry.setValue(stream1, 100);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      await advanceToNextRound();
      await registry.setValue(stream1, 150);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      await advanceToNextRound();
      await registry.setValue(stream1, 200);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // Should be able to claim now
      await expect(satori.connect(alice)['claim()']())
        .to.emit(rewards, "RewardsClaimed");
    });

    it("Should prevent claiming before scoring", async function () {
      await registry.setValue(stream1, 100);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // Try to claim immediately (not scored yet) - with new claim() there's just nothing to claim
      const balanceBefore = await satori.balanceOf(alice.address);
      await satori.connect(alice)['claim()']();
      const balanceAfter = await satori.balanceOf(alice.address);

      // Nothing is claimable before scoring — not even a first-predictor
      // liveness bonus, which no longer exists.
      expect(balanceAfter).to.equal(balanceBefore);
    });

    it("Should prevent double claiming", async function () {
      await registry.setValue(stream1, 100);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      await advanceToNextRound();
      await registry.setValue(stream1, 150);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      await advanceToNextRound();
      await registry.setValue(stream1, 200);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // Claim once
      await satori.connect(alice)['claim()']();

      // Try to claim again - with new claim() there's just nothing left to claim
      const balanceBefore = await satori.balanceOf(alice.address);
      await satori.connect(alice)['claim()']();
      const balanceAfter = await satori.balanceOf(alice.address);

      // Balance should not increase since all rewards were already claimed
      expect(balanceAfter).to.equal(balanceBefore);
    });

    it("Should mint correct amount of tokens", async function () {
      await registry.setValue(stream1, 100);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      await advanceToNextRound();
      await registry.setValue(stream1, 150);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      await advanceToNextRound();
      await registry.setValue(stream1, 200);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      const balanceBefore = await satori.balanceOf(alice.address);
      const claimable = (await lens.getTotalClaimableRewards(alice.address))[0];

      await satori.connect(alice)['claim()']();

      const balanceAfter = await satori.balanceOf(alice.address);
      const received = balanceAfter - balanceBefore;

      expect(received).to.equal(claimable);
    });

    it("Should claim all rewards at once with new claim() function", async function () {
      // Make predictions in R1, R2, R3
      for (let i = 0; i < 5; i++) {
        await registry.setValue(stream1, 100 + i * 50);
        await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);
        await advanceToNextRound();
      }

      // Claim all rewards at once
      const balanceBefore = await satori.balanceOf(alice.address);
      await satori.connect(alice)['claim()']();
      const balanceAfter = await satori.balanceOf(alice.address);

      // Should receive rewards from all correct predictions
      expect(balanceAfter).to.be.gt(balanceBefore);
    });
  });

  describe("View Functions", function () {
    it("Should return correct claimable amount", async function () {
      await registry.setValue(stream1, 100);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      await advanceToNextRound();
      await registry.setValue(stream1, 150);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      await advanceToNextRound();
      await registry.setValue(stream1, 200);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      const claimable = (await lens.getTotalClaimableRewards(alice.address))[0];
      expect(claimable).to.be.gt(0);
    });

    it("Should return 0 for already claimed", async function () {
      await registry.setValue(stream1, 100);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      await advanceToNextRound();
      await registry.setValue(stream1, 150);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      await advanceToNextRound();
      await registry.setValue(stream1, 200);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      await satori.connect(alice)['claim()']();

      const claimable = await rewards.unclaimedRewards(alice.address);
      expect(claimable).to.equal(0);
    });

    it("Should return correct streak", async function () {
      // Make 3 correct predictions
      for (let i = 0; i < 5; i++) {
        await registry.setValue(stream1, 100 + i * 50);
        await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);
        await advanceToNextRound();
      }

      const streak = await satori.streaks(alice.address, stream1);
      expect(streak).to.equal(3);
    });
  });

  describe("Edge Cases", function () {
    it("Should handle stream with zero correct predictions", async function () {
      // Alice predicts wrong
      const roundR1 = await satori.getCurrentRound();
      await registry.setValue(stream1, 100);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      await advanceToNextRound();
      await registry.setValue(stream1, 50); // DOWN
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      await advanceToNextRound();
      await registry.setValue(stream1, 25);
      const unclaimedBefore = await rewards.unclaimedRewards(alice.address);
      // This third predict scores R1: B=50 → C=25 is DOWN, she called UP → WRONG.
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // The old assertion read `totalWeightByDirection(stream1, 1, UP)` — the
      // round argument was the LITERAL 1, but rounds are
      // block.timestamp / TIME_UNIT_SECONDS (~41,000 on a Hardhat node), so
      // `totalWeightPacked[stream1][1]` is a slot no code path can write. It
      // returned 0 unconditionally and would have passed with arbitrarily
      // large committed weight. It also asserted the wrong quantity: the
      // accumulator records weight COMMITTED AT PREDICT TIME regardless of
      // correctness (see SatoriPredictTimeTotals.test.js), so it is never a
      // proxy for "zero correct predictions".
      //
      // At the REAL round the UP denominator is non-zero — alice did commit —
      // while DOWN, which nobody touched, is the side that stays empty.
      expect(await lens.totalWeightByDirection(stream1, roundR1, UP)).to.be.gt(0);
      expect(await lens.totalWeightByDirection(stream1, roundR1, DOWN)).to.equal(0);

      // The property the test is named for: nothing scored correct, so the
      // streak stays 0 and NOTHING at all is credited. There is no longer an
      // unconditional first-predictor bonus that a bare `credited > 0` could
      // have passed on, so the exact-zero match is the whole statement.
      expect(await satori.streaks(alice.address, stream1)).to.equal(0);
      const credited = (await rewards.unclaimedRewards(alice.address)) - unclaimedBefore;
      expect(credited).to.equal(0n);
    });

    it("Should handle minimum balance (1 wei)", async function () {
      // Give carol just 1 wei
      const carolBalance = await satori.balanceOf(carol.address);
      await satori.connect(carol).transfer(owner.address, carolBalance - 1n);

      await registry.setValue(stream1, 100);
      await satori.connect(carol).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // Should work with 1 wei prediction power
    });
  });
});
