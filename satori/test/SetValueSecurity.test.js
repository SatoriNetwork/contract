/**
 * SET VALUE SECURITY TEST SUITE
 *
 * This test suite covers critical security vulnerabilities related to setValue operations.
 * These tests verify that:
 * 1. setValue can only be called once per round per stream
 * 2. Authority cannot change values after predictions are made
 * 3. setValue works correctly across different rounds
 * 4. Multiple streams don't interfere with each other
 * 5. Boundary values are handled correctly
 * 6. Only authorized addresses can call setValue
 *
 * WHY THESE TESTS ARE CRITICAL:
 * - setValue is the core mechanism for updating stream values
 * - Without proper protections, malicious authorities could:
 *   a) Change values multiple times per round to manipulate predictions
 *   b) Change values after seeing predictions to guarantee wins
 *   c) Set extreme values to break calculations
 *   d) Interfere with other streams' values
 *
 * ASSUMPTIONS:
 * - Test mode is enabled for rapid round advancement
 * - Simple streams use setValue, external streams use updateValue
 * - int128 is used for value storage (range: -2^127 to 2^127-1)
 */

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

// Every stream in this file is created through the 2-arg
// `createSimpleDataStream` overload, which defaults to a 1440-minute (one
// 24h round) cadence. setValue is therefore legal once per round with at
// least 23h30m of wall clock between writes. Every advance below is two
// rounds — comfortably past the cadence gate — so the "once per cadence"
// protections this suite pins are exercised at the default stream's rhythm.
// (Publicly, cadences down to 60 minutes are allowed since phase 6; this
// file deliberately stays on the default.)
const ROUND = 86400;                            // 24h — one round
const CADENCE_ROUNDS = 2;                       // advance two rounds per write
const CADENCE_SECONDS = ROUND * CADENCE_ROUNDS; // 48h between writes

// Helper to advance one full cadence period (the next moment setValue is legal)
async function advanceCadence() {
  await time.increase(CADENCE_SECONDS);
}

describe("setValue Security Tests", function () {
  let satori, voting, rewards, bounties, registry;
  let owner, authority1, authority2, alice, bob, attacker;
  let stream1, stream2;

  const UP = 1;
  const DOWN = 2;

  beforeEach(async function () {
    [owner, authority1, authority2, alice, bob, attacker] = await ethers.getSigners();

    // Deploy the restructured Satori stack via the shared fixture
    const fix = await deploySatoriFixture();
    ;({ satori, voting, rewards, registry, bounties } = fix);

    // Enable test mode for rapid round advancement

    // Create test streams with different authorities
    const tx1 = await satori.createSimpleDataStream("ETH/USD", authority1.address);
    stream1 = await getStreamIdFromTx(tx1, satori);

    const tx2 = await satori.createSimpleDataStream("BTC/USD", authority2.address);
    stream2 = await getStreamIdFromTx(tx2, satori);

    // Distribute tokens so alice and bob can both burn for a game and still
    // have plenty of prediction power left (power = balance + unclaimed).
    await satori.transfer(alice.address, ethers.parseEther("200"));
    await satori.transfer(bob.address, ethers.parseEther("200"));

    // Burn-backed voting: there is no threshold and no top-N cap any more, so a
    // single burn per game is all it takes to give it weight. alice buys s1 its
    // weight, bob buys s2 its weight; both keep 190 to predict with. (The old
    // dummy streams existed only to game the 50% eligibility threshold, which
    // no longer exists.)
    await voteFor(satori, alice, stream1);
    await voteFor(satori, bob, stream2);
  });

  describe("1. Double setValue Same Round", function () {
    /**
     * ATTACK: Call setValue twice in the same round
     * EXPECTED: Second call should fail
     * WHY: This is critical protection from Task 1 - prevents value manipulation
     */
    it("Should allow setValue once per round", async function () {
      // First setValue should succeed
      await registry.connect(authority1).setValue(stream1, 1000);

      const value = await registry.getValue(stream1);
      expect(value).to.equal(1000);
    });

    it("Should prevent setValue twice in same round", async function () {
      // IMPORTANT: The security check has a known limitation in round 0
      // because valueHour defaults to 0 (uninitialized) which matches round 0.
      // We advance off round 0 first to test the security check properly.
      await advanceCadence();

      // First setValue
      await registry.connect(authority1).setValue(stream1, 1000);

      // Second setValue in same round should fail
      await expect(
        registry.connect(authority1).setValue(stream1, 2000)
      ).to.be.revertedWithCustomError(registry, "CadenceRoundsNotElapsed");
    });

    it("Should allow setValue in different rounds", async function () {
      // Round 0: Set value
      await registry.connect(authority1).setValue(stream1, 1000);

      // Advance to round 1
      await advanceCadence();

      // Round 1: Should be able to set value again
      await registry.connect(authority1).setValue(stream1, 1100);

      const value = await registry.getValue(stream1);
      expect(value).to.equal(1100);
    });

    it("Should prevent multiple setValue attempts even with different values", async function () {
      // Advance off round 0 first (security check doesn't work in round 0)
      await advanceCadence();

      // First setValue
      await registry.connect(authority1).setValue(stream1, 1000);

      // Try with different values - all should fail
      await expect(
        registry.connect(authority1).setValue(stream1, 999)
      ).to.be.revertedWithCustomError(registry, "CadenceRoundsNotElapsed");

      await expect(
        registry.connect(authority1).setValue(stream1, 1001)
      ).to.be.revertedWithCustomError(registry, "CadenceRoundsNotElapsed");

      // Value should still be 1000
      const value = await registry.getValue(stream1);
      expect(value).to.equal(1000);
    });
  });

  describe("2. setValue After Predictions", function () {
    /**
     * ATTACK: Users predict, authority tries to change value to help/hurt predictors
     * EXPECTED: Should fail (once-per-round protection prevents this)
     * WHY: Authority shouldn't be able to manipulate after seeing predictions
     */
    it("Should prevent setValue after predictions are made", async function () {
      // Advance off round 0 first (security check doesn't work in round 0)
      await advanceCadence();

      // Authority sets initial value
      await registry.connect(authority1).setValue(stream1, 1000);

      // Users make predictions based on this value
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);
      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(DOWN) }]);

      // Authority tries to change value after seeing predictions
      await expect(
        registry.connect(authority1).setValue(stream1, 999)
      ).to.be.revertedWithCustomError(registry, "CadenceRoundsNotElapsed");

      // Value should still be 1000
      const value = await registry.getValue(stream1);
      expect(value).to.equal(1000);
    });

    it("Should allow predictions after setValue without blocking next round setValue", async function () {
      // Round 0: Set value and predict
      await registry.connect(authority1).setValue(stream1, 1000);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // Advance to round 1
      await advanceCadence();

      // Round 1: Should be able to set new value
      await registry.connect(authority1).setValue(stream1, 1100);

      const value = await registry.getValue(stream1);
      expect(value).to.equal(1100);
    });

    it("Should store prediction with correct direction", async function () {
      // Set value
      await registry.connect(authority1).setValue(stream1, 1000);

      // Predict
      const currentRound = await satori.getCurrentRound();
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // Check prediction stored correct direction. The pre-prediction value
      // is recoverable via registry.getValueAtRound(streamId, round) — the
      // Prediction struct itself no longer carries it.
      const prediction = await satori.predictions(alice.address, stream1, currentRound);
      expect(prediction.direction).to.equal(UP);
    });
  });

  describe("3. Multiple Streams setValue Isolation", function () {
    /**
     * TEST: Set values for multiple streams, verify no interference
     * EXPECTED: Each stream maintains independent state
     * WHY: Streams must be completely isolated
     */
    it("Should allow setValue on multiple streams in same round", async function () {
      // Set values for both streams
      await registry.connect(authority1).setValue(stream1, 1000);
      await registry.connect(authority2).setValue(stream2, 5000);

      // Verify both values
      expect(await registry.getValue(stream1)).to.equal(1000);
      expect(await registry.getValue(stream2)).to.equal(5000);
    });

    it("Should not interfere with each other's setValue limits", async function () {
      // Advance off round 0 first (security check doesn't work in round 0)
      await advanceCadence();

      // Stream 1: Set value once
      await registry.connect(authority1).setValue(stream1, 1000);

      // Stream 2: Should still be able to set value
      await registry.connect(authority2).setValue(stream2, 5000);

      // Stream 1: Second setValue should still fail
      await expect(
        registry.connect(authority1).setValue(stream1, 1100)
      ).to.be.revertedWithCustomError(registry, "CadenceRoundsNotElapsed");

      // Stream 2: Second setValue should also fail
      await expect(
        registry.connect(authority2).setValue(stream2, 5100)
      ).to.be.revertedWithCustomError(registry, "CadenceRoundsNotElapsed");
    });

    it("Should track valueHour independently for each stream", async function () {
      // Round 0: Set value for stream 1 only
      await registry.connect(authority1).setValue(stream1, 1000);

      // Advance to round 1
      await advanceCadence();

      // Round 1: Set value for stream 2 only
      await registry.connect(authority2).setValue(stream2, 5000);

      // Stream 1 can set again in round 1
      await registry.connect(authority1).setValue(stream1, 1100);

      // Stream 2 cannot set again in round 1
      await expect(
        registry.connect(authority2).setValue(stream2, 5100)
      ).to.be.revertedWithCustomError(registry, "CadenceRoundsNotElapsed");
    });

    it("Should allow predictions on different streams with different values", async function () {
      // Set different values
      await registry.connect(authority1).setValue(stream1, 1000);
      await registry.connect(authority2).setValue(stream2, 50000);

      // Predict on both
      const currentRound = await satori.getCurrentRound();
      await satori.connect(alice).predictMultipleWithPayloads([
        { gameId: stream1, payload: pack1(UP) },
        { gameId: stream2, payload: pack1(DOWN) }
      ]);

      // Verify predictions stored with their respective directions; the
      // per-stream value at prediction time is recoverable from the registry
      // (getValueAtHour — the ring is hour-keyed in phase 6) and is no
      // longer cached on each prediction.
      const pred1 = await satori.predictions(alice.address, stream1, currentRound);
      const pred2 = await satori.predictions(alice.address, stream2, currentRound);

      expect(pred1.direction).to.equal(UP);
      expect(pred2.direction).to.equal(DOWN);
      const hourNow = Math.floor(Number(await time.latest()) / 3600);
      expect(await registry.getValueAtHour(stream1, hourNow)).to.equal(1000);
      expect(await registry.getValueAtHour(stream2, hourNow)).to.equal(50000);
    });
  });

  describe("4. setValue with Zero and Edge Values", function () {
    /**
     * TEST: Edge cases for value setting
     * EXPECTED: Should handle all valid int128 values
     * WHY: Ensure no overflow/underflow or special case bugs
     */
    it("Should allow setValue to zero", async function () {
      await registry.connect(authority1).setValue(stream1, 0);
      expect(await registry.getValue(stream1)).to.equal(0);
    });

    it("Should allow negative values", async function () {
      await registry.connect(authority1).setValue(stream1, -1000);
      expect(await registry.getValue(stream1)).to.equal(-1000);
    });

    it("Should handle large positive int128 values", async function () {
      // Max int128: 2^127 - 1 = 170141183460469231731687303715884105727
      const maxInt128 = BigInt("170141183460469231731687303715884105727");
      await registry.connect(authority1).setValue(stream1, maxInt128);
      expect(await registry.getValue(stream1)).to.equal(maxInt128);
    });

    it("Should handle large negative int128 values", async function () {
      // Min int128: -2^127 = -170141183460469231731687303715884105728
      const minInt128 = BigInt("-170141183460469231731687303715884105728");
      await registry.connect(authority1).setValue(stream1, minInt128);
      expect(await registry.getValue(stream1)).to.equal(minInt128);
    });

    it("Should correctly detect UP prediction with negative to less negative", async function () {
      // Advance off round 0 to avoid the round 0 initialization bug
      await advanceCadence();
      const round1 = await satori.getCurrentRound();

      // Set initial value to -1000
      await registry.connect(authority1).setValue(stream1, -1000);

      // Alice predicts UP
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // Advance round
      await advanceCadence();
      const round2 = await satori.getCurrentRound();

      // Set value to -500 (higher than -1000, so UP is correct)
      await registry.connect(authority1).setValue(stream1, -500);

      // Verify value changed UP
      const change = await satori.getValueChange(stream1, round1, round2);
      expect(change).to.equal(1); // UP
    });

    it("Should correctly detect DOWN prediction with positive to negative", async function () {
      // Round 0: Value = 1000
      const round0 = await satori.getCurrentRound();
      await registry.connect(authority1).setValue(stream1, 1000);

      // Alice predicts DOWN
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(DOWN) }]);

      // Advance to round 1
      await advanceCadence();
      const round1 = await satori.getCurrentRound();

      // Round 1: Value = -500 (down from 1000)
      await registry.connect(authority1).setValue(stream1, -500);

      // Verify value changed DOWN
      const change = await satori.getValueChange(stream1, round0, round1);
      expect(change).to.equal(-1); // DOWN
    });
  });

  describe("5. Unauthorized setValue", function () {
    /**
     * ATTACK: Non-authority tries to call setValue
     * EXPECTED: Should fail with "Not stream authority"
     * WHY: Only the designated authority should control values
     */
    it("Should prevent non-authority from calling setValue", async function () {
      await expect(
        registry.connect(attacker).setValue(stream1, 1000)
      ).to.be.revertedWithCustomError(registry, "NotStreamProvider");
    });

    it("Should prevent wrong authority from setting value on another stream", async function () {
      // authority1 controls stream1, tries to set stream2
      await expect(
        registry.connect(authority1).setValue(stream2, 5000)
      ).to.be.revertedWithCustomError(registry, "NotStreamProvider");

      // authority2 controls stream2, tries to set stream1
      await expect(
        registry.connect(authority2).setValue(stream1, 1000)
      ).to.be.revertedWithCustomError(registry, "NotStreamProvider");
    });

    it("Should prevent owner from setting value on streams they don't control", async function () {
      // Owner is not the authority for stream1 or stream2
      await expect(
        registry.connect(owner).setValue(stream1, 1000)
      ).to.be.revertedWithCustomError(registry, "NotStreamProvider");
    });

    it("Should allow authority transfer and new authority can setValue", async function () {
      // Transfer authority from authority1 to authority2
      await registry.connect(authority1).setProvider(stream1, authority2.address);

      // Old authority cannot set value anymore
      await expect(
        registry.connect(authority1).setValue(stream1, 1000)
      ).to.be.revertedWithCustomError(registry, "NotStreamProvider");

      // New authority can set value
      await registry.connect(authority2).setValue(stream1, 1000);
      expect(await registry.getValue(stream1)).to.equal(1000);
    });
  });

  describe("6. setValue Boundary Conditions", function () {
    /**
     * TEST: Boundary conditions for setValue
     * EXPECTED: All edge cases handled correctly
     * WHY: Prevent off-by-one errors and edge case bugs
     */
    it("Should handle setValue at exact round boundary (right after endRound)", async function () {
      // Round 0: Set value
      await registry.connect(authority1).setValue(stream1, 1000);

      // End round 0
      await advanceCadence();

      // Immediately set value in round 1
      await registry.connect(authority1).setValue(stream1, 1100);

      expect(await registry.getValue(stream1)).to.equal(1100);
    });

    it("Should handle rapid setValue across multiple rounds", async function () {
      for (let i = 0; i < 5; i++) {
        const value = 1000 + i * 100;
        await registry.connect(authority1).setValue(stream1, value);
        expect(await registry.getValue(stream1)).to.equal(value);

        await advanceCadence();
      }
    });

    it("Should prevent setValue on non-existent stream", async function () {
      const fakeStreamId = 999;
      await expect(
        registry.connect(authority1).setValue(fakeStreamId, 1000)
      ).to.be.revertedWithCustomError(registry, "InvalidStreamId");
    });

    it("Should allow setValue with same value as previous day", async function () {
      // Advance to next day
      await advanceCadence();

      // Day 1: Set to 1000
      await registry.connect(authority1).setValue(stream1, 1000);

      // Advance to next day
      await advanceCadence();

      // Day 2: Set to 1000 again — a genuinely-unchanged reading is still a
      // valid daily update. Only the once-per-day + 23-hour cadence gates writes.
      await registry.connect(authority1).setValue(stream1, 1000);

      expect(await registry.getValue(stream1)).to.equal(1000);
    });
  });

  describe("7. setValue State Consistency", function () {
    /**
     * TEST: Verify setValue maintains consistent state
     * EXPECTED: All state variables updated correctly
     * WHY: Inconsistent state could lead to exploits
     */
    it("Should update both current and previous values correctly", async function () {
      // Advance to next day
      await advanceCadence();

      // Day 1: Set initial value (the ring records the write's HOUR)
      await registry.connect(authority1).setValue(stream1, 1000);
      const hour1 = Math.floor(Number(await time.latest()) / 3600);

      // Advance to next day
      await advanceCadence();

      // Day 2: Set new value
      await registry.connect(authority1).setValue(stream1, 1100);
      const hour2 = Math.floor(Number(await time.latest()) / 3600);

      // Current value should be 1100
      expect(await registry.getValue(stream1)).to.equal(1100);

      // Value at hour1 should still be 1000
      const valueAtHour1 = await registry.getValueAtHour(stream1, hour1);
      expect(valueAtHour1).to.equal(1000);

      // Value at hour2 should be 1100
      const valueAtHour2 = await registry.getValueAtHour(stream1, hour2);
      expect(valueAtHour2).to.equal(1100);
    });

    it("Should track valueHour correctly", async function () {
      // Initial write: the ring is hour-keyed (phase 6), so
      // getDataStreamInfo.valueHour carries the write's HOUR
      // (block.timestamp / 3600), not the pool round.
      await registry.connect(authority1).setValue(stream1, 1000);
      const initialHour = Math.floor(Number(await time.latest()) / 3600);

      const info = await registry.getDataStreamInfo(stream1);
      expect(info.valueHour).to.equal(initialHour);

      // Advance three cadence periods without setting a value
      await advanceCadence();
      await advanceCadence();
      await advanceCadence();

      // Set value again
      await registry.connect(authority1).setValue(stream1, 1300);
      const laterHour = Math.floor(Number(await time.latest()) / 3600);

      // Check valueHour updated to the new write's hour
      const info2 = await registry.getDataStreamInfo(stream1);
      expect(info2.valueHour).to.equal(laterHour);
      expect(info2.valueHour).to.be.greaterThan(initialHour);
    });

    it("Should emit StreamValueUpdated event with correct data", async function () {
      // First setValue - event emitted by registry, not satori. Its last
      // argument is the write's HOUR (phase 6: hour-keyed ring). Pin the
      // block timestamp so the expected hour is deterministic.
      const ts1 = Number(await time.latest()) + 1;
      await time.setNextBlockTimestamp(ts1);
      await expect(registry.connect(authority1).setValue(stream1, 1000))
        .to.emit(registry, "StreamValueUpdated")
        .withArgs(stream1, 0, 1000, Math.floor(ts1 / 3600));

      // Advance to next day
      await advanceCadence();

      // Second setValue should show oldValue = 1000
      const ts2 = Number(await time.latest()) + 1;
      await time.setNextBlockTimestamp(ts2);
      await expect(registry.connect(authority1).setValue(stream1, 1100))
        .to.emit(registry, "StreamValueUpdated")
        .withArgs(stream1, 1000, 1100, Math.floor(ts2 / 3600));
    });

    it("Should maintain history correctly across multiple setValue calls", async function () {
      // The ring holds 768 entries (phase 6), so all 5 writes below are
      // retained; each is keyed by the HOUR it landed in.
      const values = [1000, 1100, 1050, 1200, 1150];
      const hours = [];

      // Advance to next day
      await advanceCadence();

      for (let i = 0; i < values.length; i++) {
        await registry.connect(authority1).setValue(stream1, values[i]);
        hours.push(Math.floor(Number(await time.latest()) / 3600));
        await advanceCadence();
      }

      // Every write is still in the ring — exact-hour lookups return each one.
      for (let i = 0; i < values.length; i++) {
        expect(await registry.getValueAtHour(stream1, hours[i]))
          .to.equal(values[i], `value written at hour ${hours[i]}`);
      }
    });
  });
});
