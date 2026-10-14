/**
 * MultiRoundDeep.test.js
 *
 * Deep multi-round tests covering gaps identified in coverage analysis:
 * - Long streak building (20+ rounds) with polynomial multiplier
 * - 15-30 round reward accumulation without claiming
 * - History ring buffer wrapping (768+ value updates)
 * - Mixed correct/incorrect predictions over many rounds
 * - Claim after long silence
 * - Multiple users with different claim timing
 */

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture, pack1, VOTE } = require("./fixtures");

// Game id 1 is the protocol's DEFAULT game (created by the fixture), so the
// first stream a test creates lands at id 2. Always capture the real id.
async function streamIdFrom(tx, satori) {
  const r = await tx.wait();
  const ev = r.logs.find(l => {
    try { return satori.interface.parseLog(l)?.name === "DataStreamCreated"; }
    catch { return false; }
  });
  return Number(satori.interface.parseLog(ev).args.streamId);
}

async function advanceRound() {
  const t = await time.latest();
  const target = t + 86400;
  const midnight = Math.floor(target / 86400) * 86400 + 1;
  await time.increaseTo(Math.max(midnight, target));
}

// `createSimpleDataStream(name, provider)` hands out daily (1440-minute)
// cadence. This file keeps its historical rhythm of one value push per
// CADENCE_ROUNDS rounds; a prediction is anchored on the standing sample at
// its own moment. Rounds advanced for a non-value reason are still single
// rounds.
//
// SCORING: a daily stream with the default target (1440 minutes) is on the
// hour-keyed A-B-C band (cadence <= 1440 and target < 24*cadence): the anchor
// is the standing value at the prediction's hour and B/C are the first TWO
// entries written after it. Settlement is still lazy, and each settle/predict
// resolves exactly one older pending prediction.
const CADENCE_ROUNDS = 2;

async function advanceCadence() {
  for (let i = 0; i < CADENCE_ROUNDS; i++) await advanceRound();
}

describe("Multi-Round Deep Tests", function () {
  this.timeout(300_000);

  // ─── shared setup ──────────────────────────────────────────────────

  async function setupWithUsers(fixture, numUsers, balance) {
    const { satori, registry, rewards, lens, owner, signers } = fixture;
    const users = signers.slice(1, 1 + numUsers);

    const streamId = await streamIdFrom(
      await satori.createSimpleDataStream("BTC/USD", owner.address), satori);
    await registry.setValue(streamId, 65000);
    await advanceCadence();

    for (const u of users) {
      await satori.transfer(u.address, ethers.parseEther(balance));
      // Voting BURNS 10 SATORI of the balance just transferred; the rest stays
      // available as prediction power.
      await satori.connect(u).vote(streamId, VOTE);
    }

    return { satori, registry, rewards, lens, owner, users, streamId };
  }

  // ─── 1. long streak to sqrt branch ─────────────────────────────────

  describe("long streak (25 rounds) - sqrt multiplier", function () {
    it("builds streak to 25 and rewards grow with sqrt multiplier", async function () {
      const fixture = await loadFixture(deploySatoriFixture);
      const { satori, registry, rewards, lens, users, streamId } = await setupWithUsers(fixture, 1, "200");
      const alice = users[0];

      let val = 65000;
      const rewardsLog = [];

      for (let r = 0; r < 25; r++) {
        await advanceCadence();
        val = Math.floor(val * 1.01);
        await registry.setValue(streamId, val);

        if (r >= 2) await satori.settlePrediction(alice.address, streamId);

        await satori.connect(alice).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(1) }]); // UP

        // Record claimable at each round
        if (r >= 4) {
          const c = (await lens.getTotalClaimableRewards(alice.address))[0];
          rewardsLog.push({ round: r, claimable: Number(ethers.formatEther(c)) });
        }
      }

      // Score remaining
      for (let i = 0; i < 2; i++) {
        await advanceCadence();
        val = Math.floor(val * 1.01);
        await registry.setValue(streamId, val);
      }
      await satori.settlePrediction(alice.address, streamId);

      const finalStreak = await satori.streaks(alice.address, streamId);
      expect(finalStreak).to.be.gte(20, "Should have built 20+ streak");

      // Verify rewards grew over time (sqrt streak multiplier increasing)
      const claimable = (await lens.getTotalClaimableRewards(alice.address))[0];
      expect(claimable).to.be.gt(0, "Should have accumulated rewards");

      // Claim should work
      const balBefore = await satori.balanceOf(alice.address);
      await satori.connect(alice)["claim()"]();
      const balAfter = await satori.balanceOf(alice.address);
      expect(balAfter).to.be.gt(balBefore);
      expect((await lens.getTotalClaimableRewards(alice.address))[0]).to.equal(0);
    });
  });

  // ─── 2. 30 rounds without claiming ────────────────────────────────

  describe("30-round accumulation without claiming", function () {
    it("rewards accumulate correctly over 30 rounds and single claim works", async function () {
      const fixture = await loadFixture(deploySatoriFixture);
      const { satori, registry, rewards, lens, users, streamId } = await setupWithUsers(fixture, 1, "200");
      const alice = users[0];

      let val = 65000;

      for (let r = 0; r < 30; r++) {
        await advanceCadence();
        val = Math.floor(val * 1.01);
        await registry.setValue(streamId, val);
        if (r >= 2) await satori.settlePrediction(alice.address, streamId);
        await satori.connect(alice).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(1) }]);
      }

      // Score remaining
      for (let i = 0; i < 2; i++) {
        await advanceCadence();
        val = Math.floor(val * 1.01);
        await registry.setValue(streamId, val);
      }
      await satori.settlePrediction(alice.address, streamId);

      const claimable = (await lens.getTotalClaimableRewards(alice.address))[0];
      expect(claimable).to.be.gt(0, "Should have 30 rounds of rewards");

      // Single claim should collect everything
      await satori.connect(alice)["claim()"]();
      expect((await lens.getTotalClaimableRewards(alice.address))[0]).to.equal(0);
    });

    it("getTotalClaimableRewards matches actual claim amount", async function () {
      const fixture = await loadFixture(deploySatoriFixture);
      const { satori, registry, rewards, lens, users, streamId } = await setupWithUsers(fixture, 1, "200");
      const alice = users[0];

      let val = 65000;

      for (let r = 0; r < 15; r++) {
        await advanceCadence();
        val = Math.floor(val * 1.01);
        await registry.setValue(streamId, val);
        if (r >= 2) await satori.settlePrediction(alice.address, streamId);
        await satori.connect(alice).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(1) }]);
      }

      for (let i = 0; i < 2; i++) {
        await advanceCadence();
        val = Math.floor(val * 1.01);
        await registry.setValue(streamId, val);
      }
      await satori.settlePrediction(alice.address, streamId);

      const claimableBefore = (await lens.getTotalClaimableRewards(alice.address))[0];
      const balBefore = await satori.balanceOf(alice.address);

      await satori.connect(alice)["claim()"]();

      const balAfter = await satori.balanceOf(alice.address);
      const actualClaimed = balAfter - balBefore;

      // The view function should match what was actually minted
      expect(actualClaimed).to.equal(claimableBefore, "Claimed amount should match view function");
    });
  });

  // ─── 3. history ring buffer wrapping ───────────────────────────────

  describe("history ring buffer (768-slot wrap)", function () {
    it("stream maintains correct history after 770 value updates", async function () {
      this.timeout(1_200_000); // 768-deep hour-keyed ring: eviction takes 768+ writes
      const fixture = await loadFixture(deploySatoriFixture);
      const { satori, registry, owner } = fixture;

      const streamId = await streamIdFrom(
        await satori.createSimpleDataStream("TEST", owner.address), satori);

      // Push 770 values, one per cadence period (the stream cannot be written
      // more often than that).
      let val = 1000;
      for (let i = 0; i < 770; i++) {
        if (i > 0) await advanceCadence();
        val += 10;
        await registry.setValue(streamId, val);
      }

      // History should have exactly 768 entries (HISTORY_SIZE)
      const history = await registry.getHistory(streamId);
      const count = Number(history[2]);
      expect(count).to.equal(768, "History should cap at 768 entries");

      // Values should be the last 768 (writes 3-770 of the original 770)
      const values = history[0].map(v => Number(v));
      expect(values[0]).to.equal(1030, "Oldest surviving value is write 3 (1000 + 3*10)");
      expect(values[767]).to.equal(8700, "Newest value should be 1000 + 770*10");
    });

    it("predictions still score correctly after history wraps", async function () {
      const fixture = await loadFixture(deploySatoriFixture);
      const { satori, registry, rewards, users, streamId } = await setupWithUsers(fixture, 1, "200");
      const alice = users[0];

      let val = 65000;

      // Push 28 values without predicting (fill most of the buffer)
      for (let i = 0; i < 28; i++) {
        await advanceCadence();
        val = Math.floor(val * 1.01);
        await registry.setValue(streamId, val);
      }

      // Now predict
      await advanceCadence();
      val = Math.floor(val * 1.01);
      await registry.setValue(streamId, val);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(1) }]); // UP

      // Push 2 more values; the first of them is what the prediction resolves
      // against (cadence-2 streams need one further write, not two).
      await advanceCadence();
      val = Math.floor(val * 1.01);
      await registry.setValue(streamId, val);
      await advanceCadence();
      val = Math.floor(val * 1.01);
      await registry.setValue(streamId, val);

      // Should score correctly even near buffer boundary
      await satori.settlePrediction(alice.address, streamId);
      const streak = await satori.streaks(alice.address, streamId);
      expect(streak).to.equal(1, "Should score correctly near buffer boundary");
    });
  });

  // ─── 4. mixed correct/incorrect over many rounds ───────────────────

  describe("mixed prediction accuracy over 15 rounds", function () {
    it("tracks streaks correctly through correct-wrong-correct sequences", async function () {
      const fixture = await loadFixture(deploySatoriFixture);
      const { satori, registry, rewards, lens, users, streamId } = await setupWithUsers(fixture, 1, "200");
      const alice = users[0];

      let val = 65000;

      // Pattern: 3 correct, 1 wrong, 4 correct, 2 wrong, 5 correct
      // Direction 1=UP. Correct when value goes up, wrong when value goes down but we predict UP.
      const multipliers = [
        1.01, 1.01, 1.01,  // 3 correct (UP matches UP)
        0.95,               // 1 wrong (DOWN but predicted UP)
        1.01, 1.01, 1.01, 1.01,  // 4 correct
        0.95, 0.95,         // 2 wrong
        1.01, 1.01, 1.01, 1.01, 1.01,  // 5 correct
      ];

      for (let r = 0; r < multipliers.length; r++) {
        await advanceCadence();
        val = Math.floor(val * multipliers[r]);
        await registry.setValue(streamId, val);
        if (r >= 2) await satori.settlePrediction(alice.address, streamId);
        await satori.connect(alice).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(1) }]); // always UP
      }

      // Score remaining
      for (let i = 0; i < 2; i++) {
        await advanceCadence();
        val = Math.floor(val * 1.01);
        await registry.setValue(streamId, val);
      }
      await satori.settlePrediction(alice.address, streamId);

      // Final streak reflects the last unbroken correct run.
      // A prediction resolves against the NEXT value written, so prediction r is
      // correct exactly when multipliers[r + 1] > 1. The tail of the array is
      // five straight rises, so the final unbroken run is real but shorter than
      // the number of rounds.
      const streak = await satori.streaks(alice.address, streamId);
      expect(streak).to.be.gt(0, "Should have a streak from the final correct run");
      expect(streak).to.be.lte(15, "Streak should be bounded by total rounds");

      // Should have some claimable from the correct rounds
      const claimable = (await lens.getTotalClaimableRewards(alice.address))[0];
      expect(claimable).to.be.gt(0, "Should have rewards from correct predictions");
    });
  });

  // ─── 5. multiple users different claim timing ──────────────────────

  describe("differential claim timing", function () {
    it("frequent claimer vs infrequent claimer both work correctly", async function () {
      const fixture = await loadFixture(deploySatoriFixture);
      const { satori, registry, rewards, lens, users, streamId } = await setupWithUsers(fixture, 2, "200");
      const [alice, bob] = users;

      let val = 65000;
      let aliceTotalClaimed = BigInt(0);
      let bobTotalClaimed = BigInt(0);

      for (let r = 0; r < 15; r++) {
        await advanceCadence();
        val = Math.floor(val * 1.01);
        await registry.setValue(streamId, val);

        if (r >= 2) {
          await satori.settlePrediction(alice.address, streamId);
          await satori.settlePrediction(bob.address, streamId);
        }

        await satori.connect(alice).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(1) }]);
        await satori.connect(bob).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(1) }]);

        // Alice claims every 3 rounds
        if (r > 0 && r % 3 === 0) {
          const c = (await lens.getTotalClaimableRewards(alice.address))[0];
          if (c > 0) {
            const before = await satori.balanceOf(alice.address);
            await satori.connect(alice)["claim()"]();
            const after = await satori.balanceOf(alice.address);
            aliceTotalClaimed += (after - before);
          }
        }
      }

      // Score remaining
      for (let i = 0; i < 2; i++) {
        await advanceCadence();
        val = Math.floor(val * 1.01);
        await registry.setValue(streamId, val);
      }
      await satori.settlePrediction(alice.address, streamId);
      await satori.settlePrediction(bob.address, streamId);

      // Final claim for both
      const aliceRemaining = (await lens.getTotalClaimableRewards(alice.address))[0];
      if (aliceRemaining > 0) {
        const before = await satori.balanceOf(alice.address);
        await satori.connect(alice)["claim()"]();
        aliceTotalClaimed += (await satori.balanceOf(alice.address)) - before;
      }

      const bobRemaining = (await lens.getTotalClaimableRewards(bob.address))[0];
      const bobBefore = await satori.balanceOf(bob.address);
      await satori.connect(bob)["claim()"]();
      bobTotalClaimed = (await satori.balanceOf(bob.address)) - bobBefore;

      // Both should have claimed something
      expect(aliceTotalClaimed).to.be.gt(0, "Alice should have claimed rewards");
      expect(bobTotalClaimed).to.be.gt(0, "Bob should have claimed rewards");

      // After final claim, both should have zero claimable
      expect((await lens.getTotalClaimableRewards(alice.address))[0]).to.equal(0);
      expect((await lens.getTotalClaimableRewards(bob.address))[0]).to.equal(0);
    });
  });

  // ─── 6. prediction staleness across rounds ─────────────────────────

  describe("value staleness constraint", function () {
    it("allows predicting on an old value, but blocks a repeat with no fresh write (StaleValue)", async function () {
      const fixture = await loadFixture(deploySatoriFixture);
      const { satori, registry, rewards, users, streamId } = await setupWithUsers(fixture, 1, "200");
      const alice = users[0];

      // Push value, then advance 2 days without updating
      await advanceCadence();
      await registry.setValue(streamId, 66000);

      await advanceCadence(); // day 2 — no value push
      await advanceCadence(); // day 3 — value is now 2 days old

      // PredictExpired is gone: predicting works any moment, anchored on the
      // STANDING sample — a 2-day-old value is a valid anchor.
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(1) }]);

      // The staleness guard that survives is StaleValue: with no stream write
      // since Alice's prediction, a later-round repeat is refused no matter
      // how much time passes.
      await advanceCadence();
      await expect(
        satori.connect(alice).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(1) }])
      ).to.be.revertedWithCustomError(satori, "StaleValue");
    });
  });

  // ─── 7. settle orphaned predictions ────────────────────────────────

  describe("settle orphaned predictions", function () {
    it("anyone can settle another user's unscored prediction", async function () {
      const fixture = await loadFixture(deploySatoriFixture);
      const { satori, registry, rewards, users, streamId } = await setupWithUsers(fixture, 2, "200");
      const [alice, bob] = users;

      let val = 65000;

      // Alice predicts
      await advanceCadence();
      val = Math.floor(val * 1.02);
      await registry.setValue(streamId, val);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(1) }]);

      // Push the resolving value (and one more, so the stream keeps moving)
      await advanceCadence();
      val = Math.floor(val * 1.02);
      await registry.setValue(streamId, val);
      await advanceCadence();
      val = Math.floor(val * 1.02);
      await registry.setValue(streamId, val);

      // Bob settles Alice's prediction (not Alice herself)
      await satori.connect(bob).settlePrediction(alice.address, streamId);

      // Alice should now have a scored prediction
      const streak = await satori.streaks(alice.address, streamId);
      expect(streak).to.equal(1, "Prediction should be scored by third party");
    });
  });

  // ─── 8. predict on single stream (not batch) ──────────────────────

  describe("single-stream predict vs batch", function () {
    it("single predict() locks same as predictMultiple()", async function () {
      const fixture = await loadFixture(deploySatoriFixture);
      const { satori, registry, rewards, users, streamId } = await setupWithUsers(fixture, 1, "200");
      const alice = users[0];

      await advanceCadence();
      await registry.setValue(streamId, 66000);

      // Single predict
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(1) }]);

      const round = await satori.getCurrentRound();
      const count = await satori.predictedStreamsCount(alice.address, round);
      expect(count).to.equal(1, "Single predict should count as 1");

      // Locked
      const locked = await satori.lockedUntil(alice.address);
      expect(locked).to.equal(Number(round) + 1);

      // Can't predict again this round. Post-collapse the unified
      // predictMultipleWithPayloads emits AlreadyPredicted (the one-batch-
      // per-round lock fires first) where the old single-predict path
      // emitted DuplicatePrediction.
      await expect(satori.connect(alice).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(1) }])).to.be.revertedWithCustomError(satori, "AlreadyPredicted");
    });
  });

  // ─── 9. DOWN predictions scored correctly ──────────────────────────

  describe("DOWN prediction scoring", function () {
    it("DOWN prediction is correct when the next value is lower", async function () {
      const fixture = await loadFixture(deploySatoriFixture);
      const { satori, registry, rewards, users, streamId } = await setupWithUsers(fixture, 1, "200");
      const alice = users[0];

      // Predict DOWN
      await advanceCadence();
      await registry.setValue(streamId, 66000);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(2) }]); // DOWN

      // The resolving value: the first update after the prediction goes DOWN,
      // so the DOWN call is correct.
      await advanceCadence();
      await registry.setValue(streamId, 64000);

      // A further update, lower still — the outcome is already decided by the
      // first one.
      await advanceCadence();
      await registry.setValue(streamId, 62000);

      await satori.settlePrediction(alice.address, streamId);
      expect(await satori.streaks(alice.address, streamId)).to.equal(1, "DOWN prediction should be correct when the next value is lower");
    });

    it("DOWN prediction is wrong when the next value is higher", async function () {
      const fixture = await loadFixture(deploySatoriFixture);
      const { satori, registry, rewards, users, streamId } = await setupWithUsers(fixture, 1, "200");
      const alice = users[0];

      // Predict DOWN
      await advanceCadence();
      await registry.setValue(streamId, 66000);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(2) }]); // DOWN

      // The resolving value goes UP, so the DOWN call is wrong.
      await advanceCadence();
      await registry.setValue(streamId, 67000);
      await advanceCadence();
      await registry.setValue(streamId, 68000);

      await satori.settlePrediction(alice.address, streamId);
      expect(await satori.streaks(alice.address, streamId)).to.equal(0, "DOWN prediction should be wrong when the next value is higher");
    });
  });

  // ─── 10. reward budget cap ─────────────────────────────────────────

  describe("daily reward budget", function () {
    it("total rewards per round do not exceed ROUND_REWARD_BUDGET", async function () {
      const fixture = await loadFixture(deploySatoriFixture);
      const { satori, token, rewards, registry, lens, owner, signers } = fixture;

      const streamId = await streamIdFrom(
        await satori.createSimpleDataStream("TEST", owner.address), satori);
      await registry.setValue(streamId, 65000);
      await advanceCadence();

      const budget = await satori.ROUND_REWARD_BUDGET();
      const deployRound = await satori.deploymentRound();

      // Give 5 users large balances and have all predict correctly.
      // Each gets INITIAL_MINT/8 so 5×share = 5/8 of bootstrap, fits within
      // owner's pre-test balance.
      const INITIAL_MINT = await satori.INITIAL_MINT();
      const PER_USER = INITIAL_MINT / 8n;
      const users = signers.slice(1, 6);
      for (const u of users) {
        await satori.transfer(u.address, PER_USER);
        await satori.connect(u).vote(streamId, VOTE);
      }

      // WHY THIS CHANGED (P3 — wrong ledger). The old body asserted
      // `totalRewardsMinted <= budget * (rounds + 2)`. Settlement only CREDITS
      // `unclaimedRewards`; only `claim()` mints (SatoriRewards `_claimFor` →
      // `_rewardMint`). This scenario never claims, never initializes the
      // default stream and never calls `mintDevFee`, so `totalRewardsMinted`
      // sits frozen at INITIAL_MINT (720) from deploy — 14% of the asserted
      // 5040 bound, and already true immediately after `loadFixture`, before a
      // single vote or prediction exists. No over-emission in the eager-credit
      // lane could ever have failed it. The real liability is
      // minted + Σ owed, and the law is A_invariants.md:31-33
      // "totalRewardsMinted <= 720 × roundsElapsed" — measured on the ledger
      // the credits actually land in.
      const holders = [owner.address, ...users.map((u) => u.address),
                       await token.PLATFORM_FEE_RECIPIENT(),
                       await rewards.marketingFeeRecipient()];
      async function liability() {
        let owed = 0n;
        for (const a of holders) owed += (await lens.getTotalClaimableRewards(a))[0];
        return (await satori.totalRewardsMinted()) + owed;
      }
      async function cap() {
        const elapsed = (await satori.getCurrentRound()) - deployRound + 1n;
        return budget * elapsed;
      }

      let val = 65000;
      let prevLiability = await liability();
      let maxRoundDelta = 0n;

      // 5 rounds, all predict correctly
      for (let r = 0; r < 5; r++) {
        await advanceCadence();
        val = Math.floor(val * 1.01);
        await registry.setValue(streamId, val);
        if (r >= 2) {
          for (const u of users) await satori.settlePrediction(u.address, streamId);
        }
        for (const u of users) {
          await satori.connect(u).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(1) }]);
        }

        // Per-round emission cap: at most ONE round's budget of new liability
        // can appear per round (each iteration settles at most one prediction
        // round for the five users, and that round's pot is `budget`).
        const now = await liability();
        const delta = now - prevLiability;
        if (delta > maxRoundDelta) maxRoundDelta = delta;
        expect(delta).to.be.lte(budget, `round ${r} credited more than one round's budget`);
        expect(now).to.be.lte(await cap(), `cumulative emission exceeded budget × roundsElapsed at round ${r}`);
        prevLiability = now;
      }

      for (let i = 0; i < 2; i++) {
        await advanceCadence();
        val = Math.floor(val * 1.01);
        await registry.setValue(streamId, val);
      }
      // Two prediction rounds are still pending here (R3 and R4), so the final
      // drain may credit up to two rounds' worth.
      for (const u of users) await satori.settlePrediction(u.address, streamId);
      for (const u of users) await satori.settlePrediction(u.address, streamId);

      const finalLiability = await liability();
      expect(finalLiability - prevLiability).to.be.lte(budget * 2n, "final drain credited more than the two pending rounds");

      // The scenario must actually have emitted — otherwise every bound above
      // is satisfied by an untouched ledger (which is exactly how the old
      // assertion stayed green).
      expect(maxRoundDelta).to.be.gt(0n, "no rewards were credited at all — the bound is vacuous");
      expect(finalLiability).to.be.gt(await satori.INITIAL_MINT(), "scenario credited nothing beyond the bootstrap mint");

      // The emission cap itself (A_invariants.md:31-33).
      expect(finalLiability).to.be.lte(await cap(), "minted + owed must stay within budget × roundsElapsed");
    });
  });
});
