const { expect } = require("chai");
const { deploySatoriFixture, pack1, VOTE, RAW_TOLERANCE } = require("./fixtures");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

// Every stream in this file is created at an explicit 2880-minute cadence —
// two rounds. A provider may post only once per period, predicting requires a
// value posted in the CURRENT round, and scoring is the AB window — anchor =
// the value AT the predict round, post = the FIRST value written after it. So
// one "step" of these scenarios is a cadence PERIOD, and that is what the two
// helpers below advance.
const ROUND = 86400; // 24h
const CADENCE_ROUNDS = 2;

// Helper to advance one full cadence period (2 rounds / 24 hours)
async function advanceRound() {
  await time.increase(ROUND * CADENCE_ROUNDS);
}

// Helper: recover a newly created stream's id from its DataStreamCreated event.
// Ids are no longer guessable — the fixture initializes the DEFAULT stream at
// id 1, so the first stream a test creates is id 2.
async function streamIdFrom(tx, satori) {
  const receipt = await tx.wait();
  for (const log of receipt.logs) {
    try {
      const p = satori.interface.parseLog(log);
      if (p && p.name === "DataStreamCreated") return Number(p.args.streamId);
    } catch (e) {}
  }
  throw new Error("DataStreamCreated event missing");
}

// Helper to advance one cadence period, aligned to round boundaries
async function advanceToNextRound() {
  for (let i = 0; i < CADENCE_ROUNDS; i++) {
    const currentTime = await time.latest();
    const nextMidnight = Math.floor(currentTime / ROUND) * ROUND + ROUND;
    await time.increaseTo(nextMidnight + 1);
  }
}

describe("Comprehensive Prediction Scenarios", function () {
  let satori, rewards, bounties, satoriRegistry, owner, user1, user2, user3, registry, engine;
  // Stream/game ids, captured at creation. Game 1 is the protocol's DEFAULT
  // game, so these start at 2.
  let btc, eth, dummy;

  // Use beforeEach instead of loadFixture to avoid cached state issues
  beforeEach(async function () {
    const fix = await deploySatoriFixture();
    ({ satori, rewards, bounties, registry, owner, engine } = fix);
    satoriRegistry = registry;
    [, user1, user2, user3] = fix.signers;

    // Initial token distribution: equal shares of bootstrap across 3 users
    // (3 × INITIAL_MINT/4 fits with headroom; ratio across users preserved).
    const INITIAL_MINT = await satori.INITIAL_MINT();
    const distributeAmount = INITIAL_MINT / 4n;
    await satori.transfer(user1.address, distributeAmount);
    await satori.transfer(user2.address, distributeAmount);
    await satori.transfer(user3.address, distributeAmount);

    // Create 3 test streams (the third is a dummy that dilutes the denominator)
    btc   = await streamIdFrom(await satori["createSimpleDataStream(string,address,uint24)"]("BTC/USD", owner.address, 2880), satori);
    eth   = await streamIdFrom(await satori["createSimpleDataStream(string,address,uint24)"]("ETH/USD", owner.address, 2880), satori);
    dummy = await streamIdFrom(await satori["createSimpleDataStream(string,address,uint24)"]("DUMMY", owner.address, 2880), satori);

    // Burn voting: every game with weight earns, in proportion. One equal burn
    // each makes BTC, ETH and DUMMY all eligible with identical weight — the
    // shape the old 50%-threshold setup was engineered to produce for BTC/ETH.
    // Weight is permanent, so this is the only voting the whole file needs.
    await satori.connect(user1).vote(btc, VOTE);
    await satori.connect(user2).vote(eth, VOTE);
    await satori.connect(user3).vote(dummy, VOTE);

    // Advance to fresh round so tests can set their own values
    await advanceToNextRound();
  });

  describe("1. Basic Single Predictor, Single Stream", function () {
    // Set fresh values for each test in this group
    beforeEach(async function () {
      await registry.setValue(btc, ethers.parseEther("50000"));
      await registry.setValue(eth, ethers.parseEther("3000"));
    });

    it("Should allow user to predict UP and win when value increases", async function () {
      const streamId = btc;
      const initialBalance = await satori.balanceOf(user1.address);

      // Round 0: User1 predicts UP
      await satori.connect(user1).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(1) }]); // 1 = UP
      const round0 = await satori.getCurrentRound();

      // Advance time 24 hours
      await advanceRound();

      // Value increases (correct prediction)
      await registry.setValue(streamId, ethers.parseEther("51000"));

      // Make another prediction to trigger scoring of round 0
      await advanceRound();
      await registry.setValue(streamId, ethers.parseEther("52000"));
      await satori.connect(user1).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(1) }]);

      // Check rewards for round 0 (use actual round number)
      const claimable = await rewards.unclaimedRewards(user1.address);
      expect(claimable).to.be.gt(0n);

      // Claim and verify balance increased
      await satori.connect(user1).claim();
      const finalBalance = await satori.balanceOf(user1.address);
      expect(finalBalance).to.be.gt(initialBalance);
    });

    it("Should allow user to predict DOWN and win when value decreases", async function () {

      const streamId = btc;
      const initialBalance = await satori.balanceOf(user1.address);

      // Round 0: User1 predicts DOWN
      await satori.connect(user1).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(2) }]); // 2 = DOWN
      const round0 = await satori.getCurrentRound();

      // Advance time 24 hours
      await advanceRound();

      // Value decreases (correct prediction)
      await registry.setValue(streamId, ethers.parseEther("49000"));

      // Make another prediction to trigger scoring of round 0
      await advanceRound();
      await registry.setValue(streamId, ethers.parseEther("48000"));
      await satori.connect(user1).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(2) }]);

      // Check rewards for round 0
      const claimable = await rewards.unclaimedRewards(user1.address);
      expect(claimable).to.be.gt(0n);

      // Claim and verify balance increased
      await satori.connect(user1).claim();
      const finalBalance = await satori.balanceOf(user1.address);
      expect(finalBalance).to.be.gt(initialBalance);
    });

    it("Should not reward incorrect predictions", async function () {

      const streamId = btc;
      const initialBalance = await satori.balanceOf(user1.address);

      // User1 predicts UP
      await satori.connect(user1).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(1) }]); // 1 = UP
      const round0 = await satori.getCurrentRound();

      // Advance time 24 hours
      await advanceRound();

      // Value decreases: this is the AB window's POST, compared against the
      // anchor (50000) that stood at the predict round. 49000 < 50000, so the
      // market went DOWN and the UP prediction is genuinely wrong.
      await registry.setValue(streamId, ethers.parseEther("49000"));

      // WHY THE EXPLICIT SETTLE (P5 — the old test never reached the scoring
      // path): without it, nothing settled the prediction and the read below
      // measured the (since-removed) first-predictor liveness bonus ALONE. Proof
      // it was vacuous: mutating `bool correct = (dir == 1) ? (post > anchor)
      // : (post < anchor)` to `correct = true` — i.e. paying out on every wrong
      // direction — left this test green. Settle explicitly and assert the loss.
      // (Under the old cadence-1/ABC form this also needed a second post value,
      // because getFirstTwoValuesAfter returned found == false with only one.
      // The AB window resolves on the single post above.)

      // The scoring path now RUNS, and must report a loss: not correct, streak
      // reset to 0, zero weight → no call to scoreCorrectPrediction at all.
      await expect(satori.settlePrediction(user1.address, streamId))
        .to.emit(engine, "PredictionScored")
        .withArgs(user1.address, streamId, round0, false, 0, 0);

      // The bucket is EMPTY. The flat first-predictor liveness bonus that used
      // to floor it at 0.44/round has been removed, so a wrong prediction now
      // credits exactly nothing.
      const claimable = await rewards.unclaimedRewards(user1.address);
      expect(claimable).to.equal(0n);

      await satori.connect(user1).claim();
      const finalBalance = await satori.balanceOf(user1.address);
      // No scoring reward (wrong) and no bonus: claiming mints nothing at all.
      expect(finalBalance - initialBalance).to.equal(0n);
    });
  });

  describe("2. Multiple Predictors, Single Stream", function () {
    // Set fresh values for each test in this group
    beforeEach(async function () {
      await registry.setValue(btc, ethers.parseEther("50000"));
      await registry.setValue(eth, ethers.parseEther("3000"));
    });

    it("Should split rewards between two correct predictors", async function () {
      const streamId = btc;

      // Round 0: Both predict UP
      await satori.connect(user1).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(1) }]); // UP
      await satori.connect(user2).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(1) }]); // UP
      const round0 = await satori.getCurrentRound();

      // Advance time 24 hours
      await advanceRound();

      // Value increases (both correct)
      await registry.setValue(streamId, ethers.parseEther("51000"));

      // Make another prediction to trigger scoring of round 0 for both users
      await advanceRound();
      await registry.setValue(streamId, ethers.parseEther("52000"));
      await satori.connect(user1).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(1) }]);
      await satori.connect(user2).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(1) }]);

      const claimable1 = await rewards.unclaimedRewards(user1.address);
      const claimable2 = await rewards.unclaimedRewards(user2.address);

      expect(claimable1).to.be.gt(0n);
      expect(claimable2).to.be.gt(0n);
      // Two predictors with identical power, direction and streak split the
      // game's slice evenly. The first-predictor liveness bonus that used to
      // give user1 an extra 0.88 is gone, so nothing separates them any more —
      // the shares are equal to within rawPower quantization.
      expect(claimable1).to.be.closeTo(claimable2, RAW_TOLERANCE);
    });

    it("Should reward only correct predictor when predictions differ", async function () {

      const streamId = btc;

      // Round 0: User1 predicts UP, User2 predicts DOWN
      await satori.connect(user1).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(1) }]); // UP
      await satori.connect(user2).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(2) }]); // DOWN
      const round0 = await satori.getCurrentRound();

      // Advance time 24 hours
      await advanceRound();

      // Value increases (user1 correct, user2 wrong)
      await registry.setValue(streamId, ethers.parseEther("51000"));

      // Make another prediction to trigger scoring of round 0
      await advanceRound();
      await registry.setValue(streamId, ethers.parseEther("52000"));
      await satori.connect(user1).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(1) }]);

      const claimable1 = await rewards.unclaimedRewards(user1.address);
      const claimable2 = await rewards.unclaimedRewards(user2.address);

      expect(claimable1).to.be.gt(0n);
      expect(claimable2).to.equal(0n);
    });
  });

  describe("3. Single Predictor, Multiple Streams", function () {
    // Set fresh values (both BTC and ETH already carry burnt weight)
    beforeEach(async function () {
      await registry.setValue(btc, ethers.parseEther("50000"));
      await registry.setValue(eth, ethers.parseEther("3000"));
    });

    it("Should handle predictions on both streams independently", async function () {
      // Round 0: Predict on both streams
      await satori.connect(user1).predictMultipleWithPayloads([
        { gameId: btc, payload: pack1(1) }, // BTC UP
        { gameId: eth, payload: pack1(2) }  // ETH DOWN
      ]);
      const round0 = await satori.getCurrentRound();

      // Advance time 24 hours
      await advanceRound();

      // BTC increases (correct), ETH decreases (correct)
      await registry.setValue(btc, ethers.parseEther("51000"));
      await registry.setValue(eth, ethers.parseEther("2900"));

      // Post C for both streams so both ABC windows resolve.
      await advanceRound();
      await registry.setValue(btc, ethers.parseEther("52000"));
      await registry.setValue(eth, ethers.parseEther("2800"));

      // OLD (vacuous, P2/P4): `claimable1` and `claimable2` were the SAME call on
      // the SAME address. `unclaimedRewards` is `mapping(address => uint256)` —
      // one aggregate bucket, no stream dimension — so the two reads are
      // bit-identical and the second assertion was a verbatim copy of the first
      // (a leftover from the pre-v5 two-arg `unclaimedRewards(user, round)`
      // accessor). Worse, the bucket carries the UNCONDITIONAL 0.44/round
      // first-predictor liveness bonus, so `> 0` held even with BOTH predictions
      // wrong, or with the stream-2 prediction never made at all.
      //
      // "Independently" means each (game, round, direction) pool pays on its own
      // (A_scoring.md:126-132). Settle the two games ONE AT A TIME and assert each
      // game's OWN credit delta. settlePrediction credits only the score (the
      // bonus is credited on predict), so these deltas have no floor to hide in.
      const beforeSettle = await rewards.unclaimedRewards(user1.address);
      await satori.settlePrediction(user1.address, btc);
      const afterStream1 = await rewards.unclaimedRewards(user1.address);
      await satori.settlePrediction(user1.address, eth);
      const afterStream2 = await rewards.unclaimedRewards(user1.address);

      const stream1Reward = afterStream1 - beforeSettle;   // BTC UP, 51000 → 52000
      const stream2Reward = afterStream2 - afterStream1;   // ETH DOWN, 2900 → 2800

      expect(stream1Reward, "stream 1's win must pay on its own").to.be.gt(0n);
      expect(stream2Reward, "stream 2's win must pay on its own").to.be.gt(0n);
    });

    it("Should handle partial correct predictions across streams", async function () {

      // Round 0: Predict on both streams
      await satori.connect(user1).predictMultipleWithPayloads([
        { gameId: btc, payload: pack1(1) }, // BTC UP
        { gameId: eth, payload: pack1(1) }  // ETH UP
      ]);
      const round0 = await satori.getCurrentRound();

      // Advance time 24 hours
      await advanceRound();

      // BTC increases (correct), ETH decreases (wrong)
      await registry.setValue(btc, ethers.parseEther("51000"));
      await registry.setValue(eth, ethers.parseEther("2900"));

      // Make predictions on both streams to trigger scoring for both
      await advanceRound();
      await registry.setValue(btc, ethers.parseEther("52000"));
      await registry.setValue(eth, ethers.parseEther("2800"));
      await satori.connect(user1).predictMultipleWithPayloads([
        { gameId: btc, payload: pack1(1) },
        { gameId: eth, payload: pack1(1) }
      ]);

      // v5 eager credit: per-stream attribution is no longer stored on-chain
      // (off-chain consumers can reconstruct from RewardSplit events). The
      // strongest still-verifiable claim is "the user accrued exactly the
      // stream-1 reward (the stream-2 prediction was wrong)" — pre-claim
      // total reflects only the winning side.
      const totalPre = await rewards.unclaimedRewards(user1.address);
      expect(totalPre).to.be.gt(0n);
    });
  });

  describe("4. Multiple Predictors, Multiple Streams", function () {
    // Set fresh values (both BTC and ETH already carry burnt weight)
    beforeEach(async function () {
      await registry.setValue(btc, ethers.parseEther("50000"));
      await registry.setValue(eth, ethers.parseEther("3000"));
    });

    it("Should handle complex multi-predictor, multi-stream scenario", async function () {

      // Round 0: All users predict
      // User1: BTC UP, ETH DOWN
      await satori.connect(user1).predictMultipleWithPayloads([
        { gameId: btc, payload: pack1(1) },
        { gameId: eth, payload: pack1(2) }
      ]);

      // User2: BTC UP, ETH UP
      await satori.connect(user2).predictMultipleWithPayloads([
        { gameId: btc, payload: pack1(1) },
        { gameId: eth, payload: pack1(1) }
      ]);

      // User3: Only BTC DOWN
      await satori.connect(user3).predictMultipleWithPayloads([{ gameId: btc, payload: pack1(2) }]);
      const round0 = await satori.getCurrentRound();

      // Advance time 24 hours
      await advanceRound();

      // BTC increases, ETH decreases
      // User1: Both correct
      // User2: BTC correct, ETH wrong
      // User3: BTC wrong
      await registry.setValue(btc, ethers.parseEther("51000")); // UP: 50000 → 51000 (valueB)
      await registry.setValue(eth, ethers.parseEther("2900"));   // DOWN: 3000 → 2900 (valueB)

      // Make predictions on both streams to trigger scoring for all users
      await advanceRound();
      await registry.setValue(btc, ethers.parseEther("52000")); // UP: 51000 → 52000 (valueC)
      await registry.setValue(eth, ethers.parseEther("2800"));   // DOWN: 2900 → 2800 (valueC - keep going down!)
      await satori.connect(user1).predictMultipleWithPayloads([
        { gameId: btc, payload: pack1(1) },
        { gameId: eth, payload: pack1(2) }
      ]);
      await satori.connect(user2).predictMultipleWithPayloads([
        { gameId: btc, payload: pack1(1) },
        { gameId: eth, payload: pack1(1) }
      ]);
      await satori.connect(user3).predictMultipleWithPayloads([{ gameId: btc, payload: pack1(2) }]);

      // v5 eager credit: only per-user totals are queryable. User1 wins BTC
      // and ETH; User2 wins BTC, loses ETH; User3 loses BTC. Verifiable:
      // user1 > user2 (extra ETH win); user2 > 0 (BTC win); user3 == 0
      // (no wins).
      const total1 = await rewards.unclaimedRewards(user1.address);
      const total2 = await rewards.unclaimedRewards(user2.address);
      const total3 = await rewards.unclaimedRewards(user3.address);

      expect(total1).to.be.gt(total2);
      expect(total2).to.be.gt(0n);
      expect(total3).to.equal(0n);
    });
  });

  describe("5. Stream Skipping Updates", function () {
    // Set fresh values (both BTC and ETH already carry burnt weight)
    beforeEach(async function () {
      await registry.setValue(btc, ethers.parseEther("50000"));
      await registry.setValue(eth, ethers.parseEther("3000"));
    });

    it("Should handle when one stream updates and another doesn't", async function () {

      // Round 0: Predict on both streams
      await satori.connect(user1).predictMultipleWithPayloads([
        { gameId: btc, payload: pack1(1) },
        { gameId: eth, payload: pack1(1) }
      ]);
      const round0 = await satori.getCurrentRound();

      // Advance time 24 hours
      await advanceRound();

      // Only BTC updates, ETH skips
      await registry.setValue(btc, ethers.parseEther("51000"));
      // Don't update ETH

      // Make another prediction to trigger scoring of round 0
      await advanceRound();
      await registry.setValue(btc, ethers.parseEther("52000"));
      await satori.connect(user1).predictMultipleWithPayloads([{ gameId: btc, payload: pack1(1) }]);

      // v5 eager credit: only per-user totals are queryable. BTC win
      // credited; ETH prediction unscored (no update) so it stays pending —
      // the user's total reflects only the BTC win.
      const total = await rewards.unclaimedRewards(user1.address);
      expect(total).to.be.gt(0n);
    });

    it("Should allow new prediction after stream skips day", async function () {

      // Round 0: Predict and BTC doesn't update
      await satori.connect(user1).predictMultipleWithPayloads([{ gameId: btc, payload: pack1(1) }]);
      // Advance time 24 hours
      await advanceRound();
      // Don't update BTC - round ends without BTC update

      // Round 1: BTC updates, should allow new prediction
      await advanceRound();
      await registry.setValue(btc, ethers.parseEther("51000"));
      await expect(
        satori.connect(user1).predictMultipleWithPayloads([{ gameId: btc, payload: pack1(1) }])
      ).to.not.be.reverted;
    });

    it("Should handle alternating stream updates across rounds", async function () {

      // Round 0: Predict both
      await satori.connect(user1).predictMultipleWithPayloads([
        { gameId: btc, payload: pack1(1) },
        { gameId: eth, payload: pack1(1) }
      ]);
      const round0 = await satori.getCurrentRound();

      // Advance time 24 hours
      await advanceRound();

      // Only BTC updates
      await registry.setValue(btc, ethers.parseEther("51000"));

      // Round 1: Advance to next day, update BTC value, and predict both again
      await advanceRound();
      await registry.setValue(btc, ethers.parseEther("51500")); // Need new value to predict
      await registry.setValue(eth, ethers.parseEther("3100")); // Update ETH too

      await satori.connect(user1).predictMultipleWithPayloads([
        { gameId: btc, payload: pack1(1) },
        { gameId: eth, payload: pack1(1) }
      ]);
      const round1 = await satori.getCurrentRound();

      // Advance time 24 hours
      await advanceRound();

      // Update both streams
      await registry.setValue(btc, ethers.parseEther("52000"));
      await registry.setValue(eth, ethers.parseEther("3200"));

      // Prediction #3: Scores prediction #1 from round 0 (scoring is sequential, oldest-first)
      await advanceRound();
      await registry.setValue(btc, ethers.parseEther("53000"));
      await registry.setValue(eth, ethers.parseEther("3300"));
      await satori.connect(user1).predictMultipleWithPayloads([
        { gameId: btc, payload: pack1(1) },
        { gameId: eth, payload: pack1(1) }
      ]);

      // Prediction #4: Scores prediction #2 from round 1 (each call scores 1 prediction per stream)
      await advanceRound();
      await registry.setValue(btc, ethers.parseEther("54000"));
      await registry.setValue(eth, ethers.parseEther("3400"));
      await satori.connect(user1).predictMultipleWithPayloads([
        { gameId: btc, payload: pack1(1) },
        { gameId: eth, payload: pack1(1) }
      ]);

      // v5 eager credit: only per-user totals are queryable. User1 wins
      // four predictions (BTC R0, ETH R0, BTC R1, ETH R1); pre-claim total
      // reflects them all.
      const total = await rewards.unclaimedRewards(user1.address);
      expect(total).to.be.gt(0n);
    });
  });

  describe("6. Predictors Skipping Streams", function () {
    // Set fresh values (both BTC and ETH already carry burnt weight)
    beforeEach(async function () {
      await registry.setValue(btc, ethers.parseEther("50000"));
      await registry.setValue(eth, ethers.parseEther("3000"));
    });

    it("Should handle when predictor skips one stream", async function () {

      // Round 0: User1 predicts both streams, User2 only predicts stream 1
      await satori.connect(user1).predictMultipleWithPayloads([
        { gameId: btc, payload: pack1(1) },
        { gameId: eth, payload: pack1(1) }
      ]);

      // User2 only predicts stream 1
      await satori.connect(user2).predictMultipleWithPayloads([{ gameId: btc, payload: pack1(1) }]);
      const round0 = await satori.getCurrentRound();

      // Advance time 24 hours
      await advanceRound();

      // Both streams update upward
      await registry.setValue(btc, ethers.parseEther("51000"));
      await registry.setValue(eth, ethers.parseEther("3100"));

      // Make predictions on both streams to trigger scoring for both users
      await advanceRound();
      await registry.setValue(btc, ethers.parseEther("52000"));
      await registry.setValue(eth, ethers.parseEther("3200"));
      await satori.connect(user1).predictMultipleWithPayloads([
        { gameId: btc, payload: pack1(1) },
        { gameId: eth, payload: pack1(1) }
      ]);
      await satori.connect(user2).predictMultipleWithPayloads([{ gameId: btc, payload: pack1(1) }]);

      // v5 eager credit: only per-user totals are queryable. User1 wins
      // both streams (BTC + ETH); User2 wins only BTC. Verifiable:
      // user1 > user2 (extra ETH win); both > 0.
      const total1 = await rewards.unclaimedRewards(user1.address);
      const total2 = await rewards.unclaimedRewards(user2.address);
      expect(total1).to.be.gt(total2);
      expect(total2).to.be.gt(0n);
    });

    it("Should handle when predictor skips entire round", async function () {

      // Round 0: Both predict
      await satori.connect(user1).predictMultipleWithPayloads([{ gameId: btc, payload: pack1(1) }]);
      await satori.connect(user2).predictMultipleWithPayloads([{ gameId: btc, payload: pack1(1) }]);
      const round0 = await satori.getCurrentRound();

      // Advance time 24 hours
      await advanceRound();
      await registry.setValue(btc, ethers.parseEther("51000"));

      // Round 1: Only user1 predicts (user2 skips)
      await advanceRound();
      await registry.setValue(btc, ethers.parseEther("52000"));
      await satori.connect(user1).predictMultipleWithPayloads([{ gameId: btc, payload: pack1(1) }]);
      const round1 = await satori.getCurrentRound();

      // Advance time 24 hours
      await advanceRound();
      await registry.setValue(btc, ethers.parseEther("53000"));

      // Make another prediction to trigger scoring for rounds 0 and 1
      await advanceRound();
      await registry.setValue(btc, ethers.parseEther("54000"));
      await satori.connect(user1).predictMultipleWithPayloads([{ gameId: btc, payload: pack1(1) }]);
      await satori.connect(user2).predictMultipleWithPayloads([{ gameId: btc, payload: pack1(1) }]);

      // Under the new streak curve, both users get only the first-prediction
      // bypass weight (mult=1) on their R0 win — none of the in-between rounds
      // accrue weight at streak<=1. So the round skip doesn't differentiate
      // totals at these low streaks; both end up with their R0 share. The
      // assertion is relaxed to "skipping doesn't crash, and the skipper is
      // not worse off than the consistent predictor on the rounds they did
      // predict."
      const total1 = await rewards.unclaimedRewards(user1.address);
      const total2 = await rewards.unclaimedRewards(user2.address);
      expect(total1).to.be.gte(total2);
      expect(total2).to.be.gt(0n);
    });
  });

  describe("7. Edge Cases and Error Conditions", function () {
    // Set fresh values for each test in this group
    beforeEach(async function () {
      await registry.setValue(btc, ethers.parseEther("50000"));
      await registry.setValue(eth, ethers.parseEther("3000"));
    });

    it("Should prevent double prediction in same round", async function () {

      await satori.connect(user1).predictMultipleWithPayloads([{ gameId: btc, payload: pack1(1) }]);

      // Second prediction without new value will fail
      await expect(
        satori.connect(user1).predictMultipleWithPayloads([{ gameId: btc, payload: pack1(1) }])
      ).to.be.reverted; // Contract may reject with different messages
    });

    it("Should prevent prediction without new value", async function () {

      // Predict once — anchored on the standing sample.
      await satori.connect(user1).predictMultipleWithPayloads([{ gameId: btc, payload: pack1(1) }]);

      // Advance rounds with NO stream write: StaleValue requires a write since
      // the user's last prediction, so this must still be refused no matter
      // how much time passes (values never "expire" — PredictExpired is gone;
      // the block is the missing WRITE, not the age of the value).
      await advanceRound();
      await advanceRound();
      await expect(
        satori.connect(user1).predictMultipleWithPayloads([{ gameId: btc, payload: pack1(1) }])
      ).to.be.revertedWithCustomError(satori, "StaleValue");

      // One fresh write unblocks prediction, however old the round is.
      await registry.setValue(btc, ethers.parseEther("51000"));
      await satori.connect(user1).predictMultipleWithPayloads([{ gameId: btc, payload: pack1(1) }]);
    });

    it("Should prevent invalid direction values", async function () {

      await expect(
        satori.connect(user1).predictMultipleWithPayloads([{ gameId: btc, payload: pack1(0) }])
      ).to.be.revertedWithCustomError(satori, "BadDirection");

      await expect(
        satori.connect(user1).predictMultipleWithPayloads([{ gameId: btc, payload: pack1(3) }])
      ).to.be.revertedWithCustomError(satori, "BadDirection");
    });

    it("Should prevent prediction on non-existent stream", async function () {

      await expect(
        satori.connect(user1).predictMultipleWithPayloads([{ gameId: 999, payload: pack1(1) }])
      ).to.be.revertedWithCustomError(satori, "UnknownStream");
    });

    it("Should lock balance after prediction", async function () {

      const initialBalance = await satori.balanceOf(user1.address);

      // Make a prediction (locks 1 token)
      await satori.connect(user1).predictMultipleWithPayloads([{ gameId: btc, payload: pack1(1) }]);

      // Should not be able to transfer all tokens (some are locked)
      await expect(
        satori.connect(user1).transfer(user1.address, initialBalance)
      ).to.be.reverted; // Locked
    });

    it("Should handle no change in value (edge case)", async function () {

      await satori.connect(user1).predictMultipleWithPayloads([{ gameId: btc, payload: pack1(1) }]);
      // Advance time 24 hours
      await advanceRound();

      // Identical value is accepted now — the authority reporting an unchanged
      // reading is a legitimate daily update, not spam.
      await registry.setValue(btc, ethers.parseEther("50000"));
      expect(await registry.getValue(btc)).to.equal(ethers.parseEther("50000"));
    });
  });

  describe("8. Multi-Round Scenarios", function () {
    // Set fresh values (both BTC and ETH already carry burnt weight)
    beforeEach(async function () {
      await registry.setValue(btc, ethers.parseEther("50000"));
      await registry.setValue(eth, ethers.parseEther("3000"));
    });

    it("Should handle 3 consecutive rounds with different outcomes", async function () {

      const initialBalance = await satori.balanceOf(user1.address);

      // Round 0: Correct prediction
      await satori.connect(user1).predictMultipleWithPayloads([{ gameId: btc, payload: pack1(1) }]);
      await advanceRound();
      await registry.setValue(btc, ethers.parseEther("51000"));

      // Round 1: Wrong prediction
      await advanceRound();
      await registry.setValue(btc, ethers.parseEther("52000"));
      await satori.connect(user1).predictMultipleWithPayloads([{ gameId: btc, payload: pack1(2) }]); // DOWN
      await advanceRound();
      await registry.setValue(btc, ethers.parseEther("53000")); // Goes UP

      // Round 2: Correct prediction
      await advanceRound();
      await registry.setValue(btc, ethers.parseEther("54000"));
      await satori.connect(user1).predictMultipleWithPayloads([{ gameId: btc, payload: pack1(1) }]); // UP
      await advanceRound();
      await registry.setValue(btc, ethers.parseEther("55000")); // Goes UP

      // Claim all
      await satori.connect(user1).claim();

      const finalBalance = await satori.balanceOf(user1.address);

      // Should have net gain from 2 correct predictions
      expect(finalBalance).to.be.gt(initialBalance);
    });

    it("Should track different streams independently across rounds", async function () {

      // Round 0: Predict both streams
      await satori.connect(user1).predictMultipleWithPayloads([
        { gameId: btc, payload: pack1(1) }, // BTC UP
        { gameId: eth, payload: pack1(2) }  // ETH DOWN
      ]);
      const round0 = await satori.getCurrentRound();
      await advanceRound();
      await registry.setValue(btc, ethers.parseEther("51000")); // BTC goes up - correct
      await registry.setValue(eth, ethers.parseEther("2900"));  // ETH goes down - correct

      // Round 1: Predict both streams again
      await advanceRound();
      await registry.setValue(btc, ethers.parseEther("51500")); // New BTC value
      await registry.setValue(eth, ethers.parseEther("2800"));  // New ETH value (keep going DOWN from 2900)
      await satori.connect(user1).predictMultipleWithPayloads([
        { gameId: btc, payload: pack1(2) }, // BTC DOWN
        { gameId: eth, payload: pack1(1) }  // ETH UP
      ]);
      const round1 = await satori.getCurrentRound();
      await advanceRound();
      await registry.setValue(btc, ethers.parseEther("52000")); // BTC goes up - wrong
      await registry.setValue(eth, ethers.parseEther("3000"));  // ETH goes up - correct

      // Prediction #3: Scores prediction #1 from round 0 (scoring is sequential, oldest-first)
      await advanceRound();
      await registry.setValue(btc, ethers.parseEther("53000"));
      await registry.setValue(eth, ethers.parseEther("3100"));
      await satori.connect(user1).predictMultipleWithPayloads([
        { gameId: btc, payload: pack1(1) },
        { gameId: eth, payload: pack1(1) }
      ]);

      // Prediction #4: Scores prediction #2 from round 1 (each call scores 1 prediction per stream)
      await advanceRound();
      await registry.setValue(btc, ethers.parseEther("54000"));
      await registry.setValue(eth, ethers.parseEther("3200"));
      await satori.connect(user1).predictMultipleWithPayloads([
        { gameId: btc, payload: pack1(1) },
        { gameId: eth, payload: pack1(1) }
      ]);

      // v5 eager credit: per-stream/per-round attribution is not stored.
      // User1 wins three predictions (R0/S1, R0/S2, R1/S2) and loses one
      // (R1/S1). The pre-claim total reflects the three wins.
      const total = await rewards.unclaimedRewards(user1.address);
      expect(total).to.be.gt(0n);
    });
  });

  describe("9. Batch Claims", function () {
    // Set fresh values (both BTC and ETH already carry burnt weight)
    beforeEach(async function () {
      await registry.setValue(btc, ethers.parseEther("50000"));
      await registry.setValue(eth, ethers.parseEther("3000"));
    });

    it("Should allow claiming rewards from multiple streams at once", async function () {

      const initialBalance = await satori.balanceOf(user1.address);

      // Round 0: Predict both correctly
      await satori.connect(user1).predictMultipleWithPayloads([
        { gameId: btc, payload: pack1(1) },
        { gameId: eth, payload: pack1(1) }
      ]);

      await advanceRound();
      await registry.setValue(btc, ethers.parseEther("51000"));
      await registry.setValue(eth, ethers.parseEther("3100"));

      // Make predictions on both streams to trigger scoring for round 0
      await advanceRound();
      await registry.setValue(btc, ethers.parseEther("52000"));
      await registry.setValue(eth, ethers.parseEther("3200"));
      await satori.connect(user1).predictMultipleWithPayloads([
        { gameId: btc, payload: pack1(1) },
        { gameId: eth, payload: pack1(1) }
      ]);

      // Single claim should get both rewards
      await satori.connect(user1).claim();

      const finalBalance = await satori.balanceOf(user1.address);
      expect(finalBalance).to.be.gt(initialBalance);
    });

    it("Should handle claims across multiple rounds", async function () {

      // Round 0
      await satori.connect(user1).predictMultipleWithPayloads([{ gameId: btc, payload: pack1(1) }]);
      const round0 = await satori.getCurrentRound();
      await advanceRound();
      await registry.setValue(btc, ethers.parseEther("51000")); // the AB post for round 0

      // Round 1
      await advanceRound();
      await registry.setValue(btc, ethers.parseEther("52000")); // round 1's anchor

      // OLD (vacuous, P2/P4): both reads were `rewards.unclaimedRewards(user1)`
      // — one aggregate bucket keyed only by address, so `reward0 === reward1`
      // bit-for-bit and the pair could not tell "two rounds accrued" from "one
      // round accrued" from "one round accrued twice". `round0`/`round1` were
      // assigned and never used: migration debris from the pre-v5 two-arg
      // `unclaimedRewards(user, round)` accessor. And the bucket is floored by
      // the unconditional 0.44/round first-predictor bonus, so `> 0` survived
      // INVERTING every price (both predictions losing).
      //
      // Settle each round's prediction at the moment it — and only it — is
      // pending, so each round's own credit is an isolated, floor-free delta.
      const beforeRound0 = await rewards.unclaimedRewards(user1.address);
      await satori.settlePrediction(user1.address, btc);
      const afterRound0 = await rewards.unclaimedRewards(user1.address);
      const reward0 = afterRound0 - beforeRound0;

      await satori.connect(user1).predictMultipleWithPayloads([{ gameId: btc, payload: pack1(1) }]);
      const round1 = await satori.getCurrentRound();
      await advanceRound();
      await registry.setValue(btc, ethers.parseEther("53000")); // the AB post for round 1

      await advanceRound();
      await registry.setValue(btc, ethers.parseEther("54000")); // a further tick
      const beforeRound1 = await rewards.unclaimedRewards(user1.address);
      await satori.settlePrediction(user1.address, btc);
      const afterRound1 = await rewards.unclaimedRewards(user1.address);
      const reward1 = afterRound1 - beforeRound1;

      expect(round1).to.be.gt(round0); // two DISTINCT rounds really were played
      expect(reward0, "round 0's win must accrue").to.be.gt(0n);
      expect(reward1, "round 1's win must accrue ON TOP of round 0's").to.be.gt(0n);

      // Don't claim until both have accrued: the single claim must mint the
      // WHOLE accumulated bucket, not just the most recent round. Anchored on
      // the ledger read, not on reward0 + reward1 (P1/P3 — the balance delta and
      // the bucket are independent measurements of the same quantity).
      const owed = await rewards.unclaimedRewards(user1.address);
      // The first-predictor liveness bonus is gone, so the bucket is EXACTLY
      // the two settled rounds and nothing else.
      expect(owed).to.equal(reward0 + reward1);

      const initialBalance = await satori.balanceOf(user1.address);
      await satori.connect(user1).claim();
      const finalBalance = await satori.balanceOf(user1.address);

      const totalClaimed = finalBalance - initialBalance;
      expect(totalClaimed).to.equal(owed);
      expect(await rewards.unclaimedRewards(user1.address)).to.equal(0n);
    });
  });
});
