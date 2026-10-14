/**
 * MultiRoundIntegration.test.js
 *
 * Comprehensive multi-round integration tests that exercise the full
 * predict → score → claim lifecycle across many rounds. These tests
 * verify the scoring framework, streak accumulation/reset,
 * reward distribution, delegation transitions, bounty payouts, and
 * edge cases like intermittent prediction and mid-sequence changes.
 *
 * Each test deploys a fresh contract set and runs a deterministic
 * multi-round sequence to verify invariants.
 */

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture, pack1, voteFor } = require("./fixtures");

// ─── helpers ────────────────────────────────────────────────────────────

async function advanceRound() {
  // Advance a full 24 h round from current time — this also clears the
  // every-round stream's 84600s (23.5h) setValue gap.
  const t = await time.latest();
  const target = t + 86400;
  // Align to midnight boundary
  const midnight = Math.floor(target / 86400) * 86400 + 1;
  await time.increaseTo(Math.max(midnight, target));
}

// `createSimpleDataStream(name, provider)` hands out a 1440-minute stream —
// an EVERY-ROUND stream under 24h rounds. The BTC/ETH streams below can be
// written once per round, so every value push is spaced one round apart and a
// prediction lives in the round its value was written.
const CADENCE_ROUNDS = 1;

async function advanceCadence() {
  for (let i = 0; i < CADENCE_ROUNDS; i++) await advanceRound();
}

// The fixture now initializes the DEFAULT stream at id 1 (exactly as
// production deploys), so the first stream a test creates is id 2. Ids are
// captured from the creation events rather than hardcoded, and stashed here so
// the tiny helpers below stay one-liners at ~30 call sites.
let BTC_ID, ETH_ID;

async function streamIdFrom(satori, tx) {
  const rcpt = await (await tx).wait();
  for (const log of rcpt.logs) {
    try {
      const p = satori.interface.parseLog(log);
      if (p && p.name === "DataStreamCreated") return Number(p.args.streamId);
    } catch (e) {}
  }
  throw new Error("DataStreamCreated event missing");
}

async function setupStreams(satori, registry, owner) {
  BTC_ID = await streamIdFrom(satori, satori.createSimpleDataStream("BTC/USD", owner.address));
  ETH_ID = await streamIdFrom(satori, satori.createSimpleDataStream("ETH/USD", owner.address));
  // Set initial values then advance so the 23-hour gate is clear.
  await registry.setValue(BTC_ID, 65000);
  await registry.setValue(ETH_ID, 3500);
  await advanceCadence();
  return { btcId: BTC_ID, ethId: ETH_ID };
}

async function pushValues(registry, btcVal, ethVal) {
  await registry.setValue(BTC_ID, btcVal);
  await registry.setValue(ETH_ID, ethVal);
}

async function predictBoth(satori, user, btcDir, ethDir) {
  await satori.connect(user).predictMultipleWithPayloads([
    { gameId: BTC_ID, payload: pack1(btcDir) },
    { gameId: ETH_ID, payload: pack1(ethDir) },
  ]);
}

async function settle(satori, user) {
  await satori.settlePrediction(user.address, BTC_ID);
  await satori.settlePrediction(user.address, ETH_ID);
}

// Settle ONE leg and hand back its PredictionScored args (correct / streak /
// scaledWeight) so a test can assert the scoring outcome instead of merely
// asserting that settling did not revert.
async function settleScored(satori, user, gameId) {
  const rcpt = await (await satori.settlePrediction(user.address, gameId)).wait();
  for (const log of rcpt.logs) {
    try {
      const p = satori.interface.parseLog(log);
      if (p && p.name === "PredictionScored" && p.args.user === user.address) return p.args;
    } catch (e) {}
  }
  throw new Error(`PredictionScored not emitted for game ${gameId} — the leg never scored`);
}

// ─── test suites ────────────────────────────────────────────────────────

describe("Multi-Round Integration", function () {
  this.timeout(120_000);

  // ─── 1. basic multi-round predict → score → claim ──────────────────

  describe("10-round predict-score-claim lifecycle", function () {
    it("accumulates rewards and streaks across 10 correct predictions", async function () {
      const { satori, registry, rewards, lens, owner, signers } = await loadFixture(deploySatoriFixture);
      const [, alice] = signers;

      const { btcId, ethId } = await setupStreams(satori, registry, owner);
      await satori.transfer(alice.address, ethers.parseEther("200"));
      await voteFor(satori, alice, btcId);

      let btcVal = 65000;
      let ethVal = 3500;

      // Run 10 rounds: predict UP each round, BTC goes UP
      for (let r = 0; r < 10; r++) {
        await advanceCadence();
        btcVal = Math.floor(btcVal * 1.01);
        ethVal = Math.floor(ethVal * 1.01);
        await pushValues(registry, btcVal, ethVal);

        // Settle before predicting (scores previous round)
        if (r >= 2) await settle(satori, alice);

        await predictBoth(satori, alice, 1, 1); // UP, UP
      }

      // Push 2 more values to score the final predictions
      await advanceCadence();
      btcVal = Math.floor(btcVal * 1.01);
      ethVal = Math.floor(ethVal * 1.01);
      await pushValues(registry, btcVal, ethVal);
      await advanceCadence();
      btcVal = Math.floor(btcVal * 1.01);
      ethVal = Math.floor(ethVal * 1.01);
      await pushValues(registry, btcVal, ethVal);
      await settle(satori, alice);

      // Check streaks — should be non-zero for BTC (eligible stream)
      const btcStreak = await satori.streaks(alice.address, btcId);
      expect(btcStreak).to.be.gt(0, "BTC streak should be positive after correct predictions");

      // Check claimable
      const claimable = (await lens.getTotalClaimableRewards(alice.address))[0];
      expect(claimable).to.be.gt(0, "Should have claimable rewards");

      // Claim and verify balance increases
      const balBefore = await satori.balanceOf(alice.address);
      await satori.connect(alice)["claim()"]();
      const balAfter = await satori.balanceOf(alice.address);
      expect(balAfter).to.be.gt(balBefore, "Balance should increase after claiming");

      // Claimable should be zero after claim
      const claimableAfter = (await lens.getTotalClaimableRewards(alice.address))[0];
      expect(claimableAfter).to.equal(0, "No claimable after full claim");
    });
  });

  // ─── 2. streak reset on incorrect prediction ──────────────────────

  describe("streak reset mechanics", function () {
    it("resets streak to 0 on incorrect prediction", async function () {
      const { satori, registry, rewards, owner, signers } = await loadFixture(deploySatoriFixture);
      const [, alice] = signers;

      const { btcId } = await setupStreams(satori, registry, owner);
      await satori.transfer(alice.address, ethers.parseEther("200"));
      await voteFor(satori, alice, btcId);

      let btcVal = 65000;
      let ethVal = 3500;

      // 5 correct rounds (predict UP, value goes UP)
      for (let r = 0; r < 5; r++) {
        await advanceCadence();
        btcVal = Math.floor(btcVal * 1.02);
        ethVal = Math.floor(ethVal * 1.02);
        await pushValues(registry, btcVal, ethVal);
        if (r >= 2) await settle(satori, alice);
        await predictBoth(satori, alice, 1, 1);
      }

      // Score the pending ones
      await advanceCadence();
      btcVal = Math.floor(btcVal * 1.02);
      ethVal = Math.floor(ethVal * 1.02);
      await pushValues(registry, btcVal, ethVal);
      await advanceCadence();
      btcVal = Math.floor(btcVal * 1.02);
      ethVal = Math.floor(ethVal * 1.02);
      await pushValues(registry, btcVal, ethVal);
      await settle(satori, alice);

      const streakBefore = await satori.streaks(alice.address, btcId);
      expect(streakBefore).to.be.gt(0, "Should have a streak");

      // Now predict UP but value goes DOWN → wrong prediction
      await advanceCadence();
      btcVal = Math.floor(btcVal * 0.95); // DOWN
      ethVal = Math.floor(ethVal * 0.95);
      await pushValues(registry, btcVal, ethVal);
      await predictBoth(satori, alice, 1, 1); // predicts UP

      // Push 2 more values (both down) to score
      await advanceCadence();
      btcVal = Math.floor(btcVal * 0.95);
      ethVal = Math.floor(ethVal * 0.95);
      await pushValues(registry, btcVal, ethVal);
      await advanceCadence();
      btcVal = Math.floor(btcVal * 0.95);
      ethVal = Math.floor(ethVal * 0.95);
      await pushValues(registry, btcVal, ethVal);
      await settle(satori, alice);

      const streakAfter = await satori.streaks(alice.address, btcId);
      expect(streakAfter).to.equal(0, "Streak should reset to 0 on wrong prediction");
    });

    it("rebuilds streak after reset", async function () {
      const { satori, registry, rewards, owner, signers } = await loadFixture(deploySatoriFixture);
      const [, alice] = signers;

      const { btcId } = await setupStreams(satori, registry, owner);
      await satori.transfer(alice.address, ethers.parseEther("200"));
      await voteFor(satori, alice, btcId);

      let btcVal = 65000;
      let ethVal = 3500;

      // 3 correct, 1 wrong, 3 correct
      const directions = [1, 1, 1, 1, 1, 1, 1]; // always predict UP
      const trends =     [1.02, 1.02, 1.02, 0.95, 1.02, 1.02, 1.02]; // 4th goes down

      for (let r = 0; r < directions.length; r++) {
        await advanceCadence();
        btcVal = Math.floor(btcVal * trends[r]);
        ethVal = Math.floor(ethVal * trends[r]);
        await pushValues(registry, btcVal, ethVal);
        if (r >= 2) await settle(satori, alice);
        await predictBoth(satori, alice, directions[r], directions[r]);
      }

      // Flush remaining scores
      for (let i = 0; i < 2; i++) {
        await advanceCadence();
        btcVal = Math.floor(btcVal * 1.02);
        ethVal = Math.floor(ethVal * 1.02);
        await pushValues(registry, btcVal, ethVal);
      }
      await settle(satori, alice);

      // After wrong prediction at round 4, streak resets to 0.
      // Then correct predictions rebuild the streak from 0.
      // The exact value depends on settlement timing: a prediction resolves
      // against later values written, and each settle clears one.
      const streak = await satori.streaks(alice.address, btcId);
      expect(streak).to.be.gt(0, "Streak should have rebuilt after reset");
      expect(streak).to.be.lt(7, "Streak should be less than the full 7 rounds");
    });
  });

  // ─── 3. multi-user competition ─────────────────────────────────────

  describe("multi-user competition across rounds", function () {
    it("distributes rewards proportionally between competing predictors", async function () {
      const { satori, registry, rewards, lens, owner, signers } = await loadFixture(deploySatoriFixture);
      const [, alice, bob, carol] = signers;

      const { btcId } = await setupStreams(satori, registry, owner);

      // Give different amounts → different prediction power
      // 5:2:1 ratio derived from INITIAL_MINT (sum = 8U fits within bootstrap).
      const INITIAL_MINT = await satori.INITIAL_MINT();
      const UNIT = INITIAL_MINT / 9n;
      await satori.transfer(alice.address, UNIT * 5n);
      await satori.transfer(bob.address, UNIT * 2n);
      await satori.transfer(carol.address, UNIT);

      await voteFor(satori, alice, btcId);
      await voteFor(satori, bob, btcId);
      await voteFor(satori, carol, btcId);

      let btcVal = 65000;
      let ethVal = 3500;

      // 5 rounds, all predict correctly
      for (let r = 0; r < 5; r++) {
        await advanceCadence();
        btcVal = Math.floor(btcVal * 1.02);
        ethVal = Math.floor(ethVal * 1.02);
        await pushValues(registry, btcVal, ethVal);

        if (r >= 2) {
          await settle(satori, alice);
          await settle(satori, bob);
          await settle(satori, carol);
        }

        await predictBoth(satori, alice, 1, 1);
        await predictBoth(satori, bob, 1, 1);
        await predictBoth(satori, carol, 1, 1);
      }

      // Score remaining
      for (let i = 0; i < 2; i++) {
        await advanceCadence();
        btcVal = Math.floor(btcVal * 1.02);
        ethVal = Math.floor(ethVal * 1.02);
        await pushValues(registry, btcVal, ethVal);
      }
      await settle(satori, alice);
      await settle(satori, bob);
      await settle(satori, carol);

      const claimAlice = (await lens.getTotalClaimableRewards(alice.address))[0];
      const claimBob = (await lens.getTotalClaimableRewards(bob.address))[0];
      const claimCarol = (await lens.getTotalClaimableRewards(carol.address))[0];

      // Alice has 500, Bob 200, Carol 100 → Alice should get the most
      expect(claimAlice).to.be.gt(claimBob, "Alice (500) should earn more than Bob (200)");
      expect(claimBob).to.be.gt(claimCarol, "Bob (200) should earn more than Carol (100)");

      // All should have rewards
      expect(claimAlice).to.be.gt(0);
      expect(claimBob).to.be.gt(0);
      expect(claimCarol).to.be.gt(0);
    });

    it("only rewards correct predictors, not wrong ones", async function () {
      const { satori, registry, rewards, lens, owner, signers } = await loadFixture(deploySatoriFixture);
      const [, alice, bob] = signers;

      const { btcId } = await setupStreams(satori, registry, owner);
      await satori.transfer(alice.address, ethers.parseEther("200"));
      await satori.transfer(bob.address, ethers.parseEther("200"));
      await voteFor(satori, alice, btcId);
      await voteFor(satori, bob, btcId);

      let btcVal = 65000;
      let ethVal = 3500;

      // 5 rounds: Alice predicts UP (correct), Bob predicts DOWN (wrong)
      for (let r = 0; r < 5; r++) {
        await advanceCadence();
        btcVal = Math.floor(btcVal * 1.02);
        ethVal = Math.floor(ethVal * 1.02);
        await pushValues(registry, btcVal, ethVal);
        if (r >= 2) {
          await settle(satori, alice);
          await settle(satori, bob);
        }
        await predictBoth(satori, alice, 1, 1); // UP
        await predictBoth(satori, bob, 2, 2);   // DOWN (wrong)
      }

      for (let i = 0; i < 2; i++) {
        await advanceCadence();
        btcVal = Math.floor(btcVal * 1.02);
        ethVal = Math.floor(ethVal * 1.02);
        await pushValues(registry, btcVal, ethVal);
      }
      await settle(satori, alice);
      await settle(satori, bob);

      const claimAlice = (await lens.getTotalClaimableRewards(alice.address))[0];
      const claimBob = (await lens.getTotalClaimableRewards(bob.address))[0];

      expect(claimAlice).to.be.gt(0, "Alice (correct) should have rewards");
      expect(claimBob).to.equal(0, "Bob (wrong) should have zero rewards");

      expect(await satori.streaks(alice.address, btcId)).to.be.gt(0);
      expect(await satori.streaks(bob.address, btcId)).to.equal(0);
    });
  });

  // ─── 4. intermittent prediction ────────────────────────────────────

  describe("intermittent prediction (skip rounds)", function () {
    it("allows predicting after skipping rounds without breaking", async function () {
      const { satori, registry, rewards, owner, signers } = await loadFixture(deploySatoriFixture);
      const [, alice] = signers;

      const { btcId } = await setupStreams(satori, registry, owner);
      await satori.transfer(alice.address, ethers.parseEther("200"));
      await voteFor(satori, alice, btcId);

      let btcVal = 65000;
      let ethVal = 3500;

      // Predict round 1
      await advanceCadence();
      btcVal = Math.floor(btcVal * 1.02);
      ethVal = Math.floor(ethVal * 1.02);
      await pushValues(registry, btcVal, ethVal);
      await predictBoth(satori, alice, 1, 1);

      // Skip 5 rounds (just push values, no prediction)
      for (let i = 0; i < 5; i++) {
        await advanceCadence();
        btcVal = Math.floor(btcVal * 1.02);
        ethVal = Math.floor(ethVal * 1.02);
        await pushValues(registry, btcVal, ethVal);
      }

      // Settle the round-1 prediction (should be scorable since values exist)
      await settle(satori, alice);

      // Predict again after the gap
      await advanceCadence();
      btcVal = Math.floor(btcVal * 1.02);
      ethVal = Math.floor(ethVal * 1.02);
      await pushValues(registry, btcVal, ethVal);

      // Should not revert
      await expect(predictBoth(satori, alice, 1, 1)).to.not.be.reverted;
    });
  });

  // ─── 5. delegation mid-sequence ────────────────────────────────────

  describe("delegation changes during multi-round sequence", function () {
    it("delegator stops predicting, delegatee predicts on their behalf", async function () {
      const { satori, registry, rewards, owner, signers } = await loadFixture(deploySatoriFixture);
      const [, alice, bob] = signers;

      const { btcId } = await setupStreams(satori, registry, owner);
      await satori.transfer(alice.address, ethers.parseEther("200"));
      await satori.transfer(bob.address, ethers.parseEther("200"));
      await voteFor(satori, alice, btcId);
      await voteFor(satori, bob, btcId);

      let btcVal = 65000;
      let ethVal = 3500;

      // Round 1-2: Alice predicts for herself
      for (let r = 0; r < 2; r++) {
        await advanceCadence();
        btcVal = Math.floor(btcVal * 1.02);
        ethVal = Math.floor(ethVal * 1.02);
        await pushValues(registry, btcVal, ethVal);
        if (r >= 2) await settle(satori, alice);
        await predictBoth(satori, alice, 1, 1);
      }

      // Score pending
      await advanceCadence();
      btcVal = Math.floor(btcVal * 1.02);
      ethVal = Math.floor(ethVal * 1.02);
      await pushValues(registry, btcVal, ethVal);
      await advanceCadence();
      btcVal = Math.floor(btcVal * 1.02);
      ethVal = Math.floor(ethVal * 1.02);
      await pushValues(registry, btcVal, ethVal);
      await settle(satori, alice);

      // Alice delegates to Bob
      await satori.connect(alice).delegatePredictionPower(bob.address);

      // Alice can no longer predict
      await advanceCadence();
      btcVal = Math.floor(btcVal * 1.02);
      ethVal = Math.floor(ethVal * 1.02);
      await pushValues(registry, btcVal, ethVal);

      await expect(
        predictBoth(satori, alice, 1, 1)
      ).to.be.revertedWithCustomError(satori, "Delegated");

      // Bob can still predict for himself
      await expect(predictBoth(satori, bob, 1, 1)).to.not.be.reverted;
    });
  });

  // ─── 6. claim-to-address ───────────────────────────────────────────

  describe("claim to different address", function () {
    it("sends rewards to specified recipient", async function () {
      const { satori, registry, rewards, lens, owner, signers } = await loadFixture(deploySatoriFixture);
      const [, alice, bob] = signers;

      const { btcId } = await setupStreams(satori, registry, owner);
      await satori.transfer(alice.address, ethers.parseEther("200"));
      await voteFor(satori, alice, btcId);

      let btcVal = 65000;
      let ethVal = 3500;

      // 3 rounds of correct predictions
      for (let r = 0; r < 3; r++) {
        await advanceCadence();
        btcVal = Math.floor(btcVal * 1.02);
        ethVal = Math.floor(ethVal * 1.02);
        await pushValues(registry, btcVal, ethVal);
        if (r >= 2) await settle(satori, alice);
        await predictBoth(satori, alice, 1, 1);
      }

      // Score remaining
      for (let i = 0; i < 2; i++) {
        await advanceCadence();
        btcVal = Math.floor(btcVal * 1.02);
        ethVal = Math.floor(ethVal * 1.02);
        await pushValues(registry, btcVal, ethVal);
      }
      await settle(satori, alice);

      const claimable = (await lens.getTotalClaimableRewards(alice.address))[0];
      expect(claimable).to.be.gt(0);

      // Claim to Bob
      const bobBalBefore = await satori.balanceOf(bob.address);
      await satori.connect(alice)["claim(address)"](bob.address);
      const bobBalAfter = await satori.balanceOf(bob.address);

      expect(bobBalAfter - bobBalBefore).to.be.gt(0, "Bob should receive Alice's claimed rewards");
    });
  });

  // ─── 7. predict on multiple streams simultaneously ─────────────────

  describe("multi-stream prediction accuracy", function () {
    it("scores each stream independently (correct on one, wrong on other)", async function () {
      const { satori, registry, rewards, owner, signers } = await loadFixture(deploySatoriFixture);
      const [, alice] = signers;

      const { btcId, ethId } = await setupStreams(satori, registry, owner);
      await satori.transfer(alice.address, ethers.parseEther("200"));
      await voteFor(satori, alice, btcId);

      let btcVal = 65000;
      let ethVal = 3500;

      // Predict UP on both, but BTC goes UP and ETH goes DOWN
      await advanceCadence();
      btcVal = Math.floor(btcVal * 1.05); // UP
      ethVal = Math.floor(ethVal * 0.95); // DOWN
      await pushValues(registry, btcVal, ethVal);
      await predictBoth(satori, alice, 1, 1); // both UP

      // Push the resolving value, and one more so the streams keep moving
      await advanceCadence();
      btcVal = Math.floor(btcVal * 1.05);
      ethVal = Math.floor(ethVal * 0.95);
      await pushValues(registry, btcVal, ethVal);
      await advanceCadence();
      btcVal = Math.floor(btcVal * 1.05);
      ethVal = Math.floor(ethVal * 0.95);
      await pushValues(registry, btcVal, ethVal);
      await settle(satori, alice);

      // BTC streak should increment, ETH streak should be 0
      const btcStreak = await satori.streaks(alice.address, btcId);
      const ethStreak = await satori.streaks(alice.address, ethId);
      expect(btcStreak).to.be.gt(0, "BTC prediction was correct");
      expect(ethStreak).to.equal(0, "ETH prediction was wrong");
    });
  });

  // ─── 8. voting changes mid-sequence ────────────────────────────────

  describe("vote change during prediction sequence", function () {
    it("a later burn does not affect pending predictions", async function () {
      // Weight can no longer be MOVED off a game — a burn is permanent. The
      // equivalent hazard is a burn arriving mid-round AFTER a prediction was
      // taken: the frozen numerator for that (game, round) must not move.
      const { satori, registry, rewards, lens, voting, owner, signers } = await loadFixture(deploySatoriFixture);
      const [, alice, bob] = signers;

      const { btcId, ethId } = await setupStreams(satori, registry, owner);
      await satori.transfer(alice.address, ethers.parseEther("200"));
      await satori.transfer(bob.address, ethers.parseEther("200"));
      await voteFor(satori, alice, btcId);

      let btcVal = 65000;
      let ethVal = 3500;

      // Predict round 1 while BTC carries alice's weight
      await advanceCadence();
      btcVal = Math.floor(btcVal * 1.02);
      ethVal = Math.floor(ethVal * 1.02);
      await pushValues(registry, btcVal, ethVal);
      await predictBoth(satori, alice, 1, 1);

      const predictRound = await satori.getCurrentRound();
      const btcFrozen = await voting.getGameVotesAtRound(btcId, predictRound);
      expect(btcFrozen).to.be.gt(0n);

      // Bob buys ETH weight, and MORE BTC weight, after alice's prediction was
      // taken. (Alice herself cannot: predicting transfer-locks the balance a
      // burn would come out of.)
      await voteFor(satori, bob, ethId);
      await voteFor(satori, bob, btcId);

      // The live weight moved; the round's frozen numerator did not.
      expect(await voting.weightOf(btcId)).to.be.gt(btcFrozen);
      expect(await voting.getGameVotesAtRound(btcId, predictRound)).to.equal(btcFrozen);

      // Push values to score
      await advanceCadence();
      btcVal = Math.floor(btcVal * 1.02);
      ethVal = Math.floor(ethVal * 1.02);
      await pushValues(registry, btcVal, ethVal);
      await advanceCadence();
      btcVal = Math.floor(btcVal * 1.02);
      ethVal = Math.floor(ethVal * 1.02);
      await pushValues(registry, btcVal, ethVal);
      await settle(satori, alice);

      // Predictions made against the frozen BTC weight still score on BTC.
      const claimable = (await lens.getTotalClaimableRewards(alice.address))[0];
      expect(claimable).to.be.gt(0, "Should still earn rewards from BTC prediction");
    });
  });

  // ─── 9. long sequence: 20 rounds ──────────────────────────────────

  describe("20-round endurance test", function () {
    it("system remains consistent after 20 rounds of predictions and claims", async function () {
      const { satori, registry, rewards, lens, owner, signers } = await loadFixture(deploySatoriFixture);
      const [, alice, bob] = signers;

      const { btcId } = await setupStreams(satori, registry, owner);
      await satori.transfer(alice.address, ethers.parseEther("200"));
      await satori.transfer(bob.address, ethers.parseEther("200"));
      await voteFor(satori, alice, btcId);
      await voteFor(satori, bob, btcId);

      let btcVal = 65000;
      let ethVal = 3500;

      for (let r = 0; r < 20; r++) {
        await advanceCadence();
        btcVal = Math.floor(btcVal * 1.01);
        ethVal = Math.floor(ethVal * 1.01);
        await pushValues(registry, btcVal, ethVal);

        if (r >= 2) {
          await settle(satori, alice);
          await settle(satori, bob);
        }

        await predictBoth(satori, alice, 1, 1);
        await predictBoth(satori, bob, 1, 1);

        // Alice claims every 5 rounds
        if (r > 0 && r % 5 === 0) {
          const claimable = (await lens.getTotalClaimableRewards(alice.address))[0];
          if (claimable > 0) {
            await satori.connect(alice)["claim()"]();
          }
        }
      }

      // Final score flush
      for (let i = 0; i < 2; i++) {
        await advanceCadence();
        btcVal = Math.floor(btcVal * 1.01);
        ethVal = Math.floor(ethVal * 1.01);
        await pushValues(registry, btcVal, ethVal);
      }
      await settle(satori, alice);
      await settle(satori, bob);

      // Alice claimed periodically (increasing her prediction power), Bob never claimed
      const aliceClaimable = (await lens.getTotalClaimableRewards(alice.address))[0];
      const bobClaimable = (await lens.getTotalClaimableRewards(bob.address))[0];

      // Both should have some claimable (or Alice may have 0 if she just claimed)
      // The key invariant: claiming mid-run doesn't break the system
      expect(bobClaimable).to.be.gt(0, "Bob should have unclaimed rewards");

      // Both should have streaks
      expect(await satori.streaks(alice.address, btcId)).to.be.gt(0);
      expect(await satori.streaks(bob.address, btcId)).to.be.gt(0);

      // Final claim for both should work
      if (aliceClaimable > 0) await satori.connect(alice)["claim()"]();
      if (bobClaimable > 0) await satori.connect(bob)["claim()"]();

      expect((await lens.getTotalClaimableRewards(alice.address))[0]).to.equal(0);
      expect((await lens.getTotalClaimableRewards(bob.address))[0]).to.equal(0);
    });
  });

  // ─── 10. (removed) SATORI-native bounty tests — bounty surface lives on
  //          SatoriRewards now (see Bounty.test.js, BountyRecovery.test.js,
  //          BountyDelegation.test.js).

  // ─── 11. transfer mid-streak ───────────────────────────────────────

  describe("token transfer during active streak", function () {
    it("prediction power changes but streak persists", async function () {
      const { satori, registry, rewards, owner, signers } = await loadFixture(deploySatoriFixture);
      const [, alice, bob] = signers;

      const { btcId } = await setupStreams(satori, registry, owner);
      await satori.transfer(alice.address, ethers.parseEther("200"));
      await voteFor(satori, alice, btcId);

      let btcVal = 65000;
      let ethVal = 3500;

      // 3 correct rounds
      for (let r = 0; r < 3; r++) {
        await advanceCadence();
        btcVal = Math.floor(btcVal * 1.02);
        ethVal = Math.floor(ethVal * 1.02);
        await pushValues(registry, btcVal, ethVal);
        if (r >= 2) await settle(satori, alice);
        await predictBoth(satori, alice, 1, 1);
      }

      // Score to build streak
      await advanceCadence();
      btcVal = Math.floor(btcVal * 1.02);
      ethVal = Math.floor(ethVal * 1.02);
      await pushValues(registry, btcVal, ethVal);
      await advanceCadence();
      btcVal = Math.floor(btcVal * 1.02);
      ethVal = Math.floor(ethVal * 1.02);
      await pushValues(registry, btcVal, ethVal);
      await settle(satori, alice);

      const streakBefore = await satori.streaks(alice.address, btcId);
      expect(streakBefore).to.be.gt(0);

      // Transfer half tokens to Bob (doesn't reset streak)
      // Alice is locked from the last prediction, wait for unlock
      await advanceCadence();
      btcVal = Math.floor(btcVal * 1.02);
      ethVal = Math.floor(ethVal * 1.02);
      await pushValues(registry, btcVal, ethVal);

      await satori.connect(alice).transfer(bob.address, ethers.parseEther("50"));

      // Streak should be unchanged
      const streakAfter = await satori.streaks(alice.address, btcId);
      expect(streakAfter).to.equal(streakBefore, "Transfer should not reset streak");

      // Alice can still predict with remaining balance
      await expect(predictBoth(satori, alice, 1, 1)).to.not.be.reverted;
    });
  });

  // ─── 12. duplicate prediction guard ────────────────────────────────

  describe("prediction constraints", function () {
    it("rejects duplicate prediction in same round", async function () {
      const { satori, registry, rewards, owner, signers } = await loadFixture(deploySatoriFixture);
      const [, alice] = signers;

      await setupStreams(satori, registry, owner);
      await satori.transfer(alice.address, ethers.parseEther("200"));
      await voteFor(satori, alice, BTC_ID);

      await advanceCadence();
      await pushValues(registry, 66000, 3600);
      await predictBoth(satori, alice, 1, 1);

      // Try predicting again in same round
      await expect(
        predictBoth(satori, alice, 1, 1)
      ).to.be.revertedWithCustomError(satori, "AlreadyPredicted");
    });

    it("rejects prediction when value hasn't changed since last prediction", async function () {
      const { satori, registry, rewards, owner, signers } = await loadFixture(deploySatoriFixture);
      const [, alice] = signers;

      await setupStreams(satori, registry, owner);
      await satori.transfer(alice.address, ethers.parseEther("200"));
      await voteFor(satori, alice, BTC_ID);

      await advanceCadence();
      await pushValues(registry, 66000, 3600);
      await predictBoth(satori, alice, 1, 1);

      // Advance ONE round — the batch lock has expired, but nothing has
      // written a new value, so the value alice already predicted on is the
      // newest one there is.
      await advanceRound();

      await expect(
        predictBoth(satori, alice, 1, 1)
      ).to.be.revertedWithCustomError(satori, "StaleValue");
    });

    it("accepts batches larger than the previous 25-stream cap", async function () {
      // The historical 25-cap was removed. The caller is bounded only by
      // block gas limit; 26 distinct streams is well within that.
      const { satori, registry, rewards, owner, signers } = await loadFixture(deploySatoriFixture);
      const [, alice] = signers;

      // Ids 2..27: id 1 is the DEFAULT stream, whose provider is the hub — a
      // test cannot setValue on it, and it is not what this cap test is about.
      const ids = [];
      for (let i = 0; i < 26; i++) {
        ids.push(await streamIdFrom(satori, satori.createSimpleDataStream(`STREAM${i}`, owner.address)));
      }
      await satori.transfer(alice.address, ethers.parseEther("200"));

      // These 26 streams have never been written, so their cadence gate is
      // open — one round is enough.
      await advanceRound();
      for (const id of ids) {
        await registry.setValue(id, 1000 + id);
      }

      const requests = ids.map((id) => ({ gameId: id, payload: pack1(1) }));

      // Should succeed (no cap to trip).
      await expect(satori.connect(alice).predictMultipleWithPayloads(requests)).to.not.be.reverted;
    });
  });

  // ─── 13. claim delegation across rounds ────────────────────────────

  describe("claim delegation", function () {
    it("delegatee can claim on behalf of delegator", async function () {
      const { satori, registry, rewards, lens, owner, signers } = await loadFixture(deploySatoriFixture);
      const [, alice, bob] = signers;

      const { btcId } = await setupStreams(satori, registry, owner);
      await satori.transfer(alice.address, ethers.parseEther("200"));
      await voteFor(satori, alice, btcId);

      let btcVal = 65000;
      let ethVal = 3500;

      // Build claimable rewards
      for (let r = 0; r < 3; r++) {
        await advanceCadence();
        btcVal = Math.floor(btcVal * 1.02);
        ethVal = Math.floor(ethVal * 1.02);
        await pushValues(registry, btcVal, ethVal);
        if (r >= 2) await settle(satori, alice);
        await predictBoth(satori, alice, 1, 1);
      }
      for (let i = 0; i < 2; i++) {
        await advanceCadence();
        btcVal = Math.floor(btcVal * 1.02);
        ethVal = Math.floor(ethVal * 1.02);
        await pushValues(registry, btcVal, ethVal);
      }
      await settle(satori, alice);

      // Delegate claim to Bob
      await satori.connect(alice).delegateClaimAbility(bob.address);

      const claimable = (await lens.getTotalClaimableRewards(alice.address))[0];
      expect(claimable).to.be.gt(0);

      // Bob claims for Alice, sending to Alice
      const aliceBalBefore = await satori.balanceOf(alice.address);
      await satori.connect(bob).claimFor(alice.address, alice.address);
      const aliceBalAfter = await satori.balanceOf(alice.address);

      expect(aliceBalAfter).to.be.gt(aliceBalBefore, "Alice balance should increase from Bob's claim");
    });
  });

  // ─── 14. default stream (Predictions) ──────────────────────────────

  describe("default stream behavior", function () {
    it("default stream value tracks daily prediction count", async function () {
      const { satori, registry, rewards, owner, signers } = await loadFixture(deploySatoriFixture);
      const [, alice, bob] = signers;

      const defaultId = await satori.DEFAULT_STREAM_ID();

      // The default stream owns id 1, so BTC/ETH land at 2/3 — captured from the
      // creation events rather than assumed.
      const btc = await streamIdFrom(satori, satori.createSimpleDataStream("BTC/USD", owner.address));
      const eth = await streamIdFrom(satori, satori.createSimpleDataStream("ETH/USD", owner.address));
      expect(Number(defaultId)).to.be.lessThan(btc);
      await registry.setValue(btc, 65000);
      await registry.setValue(eth, 3500);
      await advanceCadence();

      await satori.transfer(alice.address, ethers.parseEther("200"));
      await satori.transfer(bob.address, ethers.parseEther("200"));
      await voteFor(satori, alice, btc);

      // Round 1: Alice predicts on BTC/ETH
      await advanceCadence();
      await registry.setValue(btc, 66000);
      await registry.setValue(eth, 3600);
      await satori.connect(alice).predictMultipleWithPayloads([
        { gameId: btc, payload: pack1(1) },
        { gameId: eth, payload: pack1(1) },
      ]);

      // Round 2: Bob predicts → flushDefaultStream writes round-1 count
      await advanceCadence();
      await registry.setValue(btc, 67000);
      await registry.setValue(eth, 3700);
      await satori.connect(bob).predictMultipleWithPayloads([
        { gameId: btc, payload: pack1(1) },
        { gameId: eth, payload: pack1(1) },
      ]);

      // The default stream should have been flushed
      const history = await registry.getHistory(defaultId);
      const count = Number(history[2]);
      expect(count).to.be.gt(0, "Default stream should have history after flush");
    });
  });

  // ─── 15. lock mechanics ────────────────────────────────────────────

  describe("lock mechanics across rounds", function () {
    it("user is locked until next round after predicting", async function () {
      const { satori, registry, rewards, owner, signers } = await loadFixture(deploySatoriFixture);
      const [, alice] = signers;

      await setupStreams(satori, registry, owner);
      await satori.transfer(alice.address, ethers.parseEther("200"));
      await voteFor(satori, alice, BTC_ID);

      await advanceCadence();
      await pushValues(registry, 66000, 3600);

      const roundBefore = await satori.getCurrentRound();
      await predictBoth(satori, alice, 1, 1);

      const lockedUntil = await satori.lockedUntil(alice.address);
      expect(lockedUntil).to.equal(Number(roundBefore) + 1, "Should be locked until next round");

      // Advance exactly ONE round → unlocked. The lock is a ROUND lock: it
      // clears in the very next round; no value push belongs here.
      await advanceRound();
      const lockedCheck = await satori.lockedUntil(alice.address);
      const currentRound = await satori.getCurrentRound();
      expect(Number(lockedCheck)).to.be.lte(Number(currentRound), "Should be unlocked in new round");
    });
  });

  // ─── 16. eligibility change mid-sequence ───────────────────────────

  describe("stream eligibility changes", function () {
    it("predictions on newly ineligible streams still score but at different weight", async function () {
      const { satori, registry, rewards, lens, voting, owner, signers } = await loadFixture(deploySatoriFixture);
      const [, alice, bob] = signers;

      const { btcId, ethId } = await setupStreams(satori, registry, owner);
      await satori.transfer(alice.address, ethers.parseEther("200"));
      await satori.transfer(bob.address, ethers.parseEther("200"));

      // Both vote BTC → eligible. NOBODY votes ETH → ETH is ineligible.
      await voteFor(satori, alice, btcId);
      await voteFor(satori, bob, btcId);

      let btcVal = 65000;
      let ethVal = 3500;

      // Predict on BOTH legs: one eligible (BTC), one ineligible (ETH).
      await advanceCadence();
      btcVal = Math.floor(btcVal * 1.02);
      ethVal = Math.floor(ethVal * 1.02);
      await pushValues(registry, btcVal, ethVal);
      // The premise is ASSERTED, not assumed: the two legs really do straddle
      // the eligibility line at PREDICTION time (P5 — a scenario nobody checks
      // is a scenario that silently stops happening).
      expect(await voting.isEligible(btcId)).to.equal(true, "BTC eligible at predict time");
      expect(await voting.isEligible(ethId)).to.equal(false, "ETH ineligible at predict time (nobody voted it)");
      await predictBoth(satori, alice, 1, 1);

      // Bob buys ETH weight AFTER the ETH leg was already taken, so ETH flips
      // eligible too late to matter for this round. (Burnt weight is permanent
      // and cannot be moved off BTC, and alice cannot burn at all right now —
      // predicting transfer-locks her balance.)
      await voteFor(satori, bob, ethId);
      expect(await voting.isEligible(btcId)).to.equal(true, "BTC keeps its burnt weight");
      expect(await voting.isEligible(ethId)).to.equal(true, "ETH only became eligible after the prediction");

      // Push values to score (values rise every round → both legs are correct)
      await advanceCadence();
      btcVal = Math.floor(btcVal * 1.02);
      ethVal = Math.floor(ethVal * 1.02);
      await pushValues(registry, btcVal, ethVal);
      await advanceCadence();
      btcVal = Math.floor(btcVal * 1.02);
      ethVal = Math.floor(ethVal * 1.02);
      await pushValues(registry, btcVal, ethVal);

      // P2 — the old body's only assertion was `streak >= 0` on a uint256, which
      // no contract behaviour can violate; the `claimable` read was discarded
      // without an expect. Assert the concrete documented outcome instead, off
      // the PredictionScored payload.
      const btcScore = await settleScored(satori, alice, btcId);
      const ethScore = await settleScored(satori, alice, ethId);

      // BOTH legs SCORE: a correct prediction advances the streak without
      // gating on eligibility (SatoriEngine "audit F16 — accepted, WAI";
      // A_scoring.md streak table: correct → streak++).
      expect(btcScore.correct).to.equal(true);
      expect(ethScore.correct).to.equal(true);
      expect(btcScore.streak).to.equal(1n);
      expect(ethScore.streak).to.equal(1n);
      expect(await satori.streaks(alice.address, btcId)).to.equal(1n);
      expect(await satori.streaks(alice.address, ethId)).to.equal(1n);

      // …but at DIFFERENT WEIGHT — the whole point of the test. A_predictions.md:
      // "Ineligible stream: still predict-able, but it receives zero prediction
      // power (thisPower = 0), so its SATORI weight is zero — no share of the
      // round budget."
      expect(ethScore.scaledWeight).to.equal(0n, "ineligible leg earns ZERO SATORI weight");
      expect(btcScore.scaledWeight).to.be.gt(0n, "eligible leg carries real weight");

      // So the payout is the whole residual round budget net of the 5% referral
      // skim — anchored on the budget, not on a bare `> 0`. BTC is the only game
      // recorded into the predict round (the ETH leg had zero weight, so it never
      // entered the denominator) and alice is its only predictor, so BTC's
      // allocation IS the whole budget. Nothing is reserved out of it any more:
      // the first-predictor bonus is gone.
      // The HUB's per-round emission, not the token's 1440 envelope: the
      // envelope is a ceiling the schedule mints under, so anchoring a payout
      // on it overstates the round by the difference.
      const budget = (await satori.emissionRateNow()) - (await satori.devRateNow());
      const claimable = (await lens.getTotalClaimableRewards(alice.address))[0];
      // `budget - floor(5%)`, not `floor(95%)`: the contract skims the cut and
      // pays the remainder, so the two differ by a wei whenever the budget is
      // not a clean multiple. It always was, at a round 1152.
      expect(claimable).to.equal(budget - (budget * 500n) / 10000n);
    });
  });
});
