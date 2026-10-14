const { expect } = require("chai");
const { deploySatoriFixture } = require("./fixtures");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

// The lazy value/round tracking under test is driven by registry writes, so the
// streams below are the ones a real public user gets: the 2-arg
// `createSimpleDataStream` overload, which now defaults to cadence 2 (daily —
// the finest a non-admin may create). One cadence period is therefore TWO rounds
// / 24h, and consecutive writes to the same stream must be that far apart.
const ROUND = 86400;                            // 24h — one round
const CADENCE_ROUNDS = 2;                       // daily
const CADENCE_SECONDS = ROUND * CADENCE_ROUNDS; // 24h — one cadence period

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

describe("Lazy Value Tracking Optimization", function () {
  let satori;
  let registry;
  let owner;
  let authority1;
  let authority2;
  let user1;

  beforeEach(async function () {
    [owner, authority1, authority2, user1] = await ethers.getSigners();

    const fix = await deploySatoriFixture();
    satori = fix.satori;
    registry = fix.registry;
  });

  describe("Round-Aware Value Updates", function () {
    let stream1;

    beforeEach(async function () {
      const tx = await satori.createSimpleDataStream(
        "Test Stream",
        authority1.address
      );
      stream1 = await getStreamIdFromTx(tx, satori);
    });

    it("Should track which round a value belongs to", async function () {
      // Set initial value
      await registry.connect(authority1).setValue(stream1, 100);

      // Get stream info - should show round 0
      const info = await registry.getDataStreamInfo(stream1);
      expect(info[3]).to.equal(100n); // value

      // Move on one full cadence period (2 rounds)
      const currentTime = await time.latest();
      const tomorrowMidnight = Math.floor(currentTime / 86400) * 86400 + 86400;
      await time.setNextBlockTimestamp(tomorrowMidnight + 1);
      await time.increase(CADENCE_SECONDS);

      // Update value in the next cadence period
      await registry.connect(authority1).setValue(stream1, 150);

      // Should now show the later round
      const info2 = await registry.getDataStreamInfo(stream1);
      expect(info2[3]).to.equal(150n); // value (position shifted after §3.4 target removal)
    });

    it("Should store previous value when updating in a new round", async function () {
      // Set value in round 0
      await registry.connect(authority1).setValue(stream1, 100);
      const round0 = await satori.getCurrentRound();

      // Move on one full cadence period (2 rounds)
      const currentTime = await time.latest();
      const tomorrowMidnight = Math.floor(currentTime / 86400) * 86400 + 86400;
      await time.setNextBlockTimestamp(tomorrowMidnight + 1);
      await time.increase(CADENCE_SECONDS);

      // Update value a cadence later - should store 100 as previous
      await registry.connect(authority1).setValue(stream1, 150);
      const round1 = await satori.getCurrentRound();

      // Check that it remembers the previous value
      const change = await satori.getValueChange(stream1, round0, round1);
      expect(change).to.equal(1); // UP from 100 to 150
    });

    it("Should prevent multiple value updates in same day", async function () {
      // Set initial value
      await registry.connect(authority1).setValue(stream1, 100);

      // Attempt to update again in same day should fail
      await expect(
        registry.connect(authority1).setValue(stream1, 200)
      ).to.be.revertedWithCustomError(registry, "CadenceRoundsNotElapsed");
    });

    it("Should handle multiple rounds without updates", async function () {
      // Set value in round 0
      await registry.connect(authority1).setValue(stream1, 100);
      const round0 = await satori.getCurrentRound();

      // Skip to round 3 without updating
      const currentTime = await time.latest();
      const midnight1 = Math.floor(currentTime / 86400) * 86400 + 86400;

      await time.setNextBlockTimestamp(midnight1 + 1);
      await time.increase(86400); // Round 1

      await time.setNextBlockTimestamp(midnight1 + 86400 + 1);
      await time.increase(86400); // Round 2

      await time.setNextBlockTimestamp(midnight1 + 86400 * 2 + 1);
      await time.increase(86400); // Round 3

      // Update in round 3
      await registry.connect(authority1).setValue(stream1, 150);
      const round3 = await satori.getCurrentRound();

      // Should compare to round 0 value (100)
      const change = await satori.getValueChange(stream1, round0, round3);
      expect(change).to.equal(1); // UP from 100 to 150
    });
  });

  describe("Lazy Evaluation of Value Changes", function () {
    let stream1;
    let stream2;

    beforeEach(async function () {
      let tx;

      tx = await satori.createSimpleDataStream(
        "Stream 1",
        authority1.address
      );
      stream1 = await getStreamIdFromTx(tx, satori);

      tx = await satori.createSimpleDataStream(
        "Stream 2",
        authority2.address
      );
      stream2 = await getStreamIdFromTx(tx, satori);

      // Set initial values
      await registry.connect(authority1).setValue(stream1, 100);
      await registry.connect(authority2).setValue(stream2, 200);
    });

    it("Should determine UP movement lazily", async function () {
      // Capture initial round
      const round0 = await satori.getCurrentRound();

      // Move on one full cadence period (2 rounds) so stream1 may be rewritten
      const currentTime = await time.latest();
      const tomorrowMidnight = Math.floor(currentTime / 86400) * 86400 + 86400;
      await time.setNextBlockTimestamp(tomorrowMidnight + 1);
      await time.increase(CADENCE_SECONDS);

      // Update only stream1
      await registry.connect(authority1).setValue(stream1, 150);
      const round1 = await satori.getCurrentRound();

      // Move on one more round. No value write follows, so this is NOT a cadence
      // step — it only proves the lazy views still answer from a later round.
      // (No setNextBlockTimestamp anchor here: the cadence advance above already
      // carried the clock past `tomorrowMidnight + 86400`.)
      await time.increase(ROUND);

      // Check changes - should work even though stream2 wasn't updated
      const change1 = await satori.getValueChange(stream1, round0, round1);
      expect(change1).to.equal(1); // UP

      const change2 = await satori.getValueChange(stream2, round0, round1);
      expect(change2).to.equal(0); // NO CHANGE (still 200)
    });

    it("Should handle streams that haven't been updated for multiple rounds", async function () {
      // NOTE: Initial values are set in round 0 by beforeEach.
      // Both streams are cadence 2, so every rewrite below is one full cadence
      // period (2 rounds) after the previous write to that same stream.
      const currentTime = await time.latest();
      const midnight = Math.floor(currentTime / 86400) * 86400 + 86400;

      // Cadence 1 - advance a full cadence period past the round-0 writes
      await time.setNextBlockTimestamp(midnight + 1);
      await time.increase(CADENCE_SECONDS);
      // Update values (must be different from the round-0 values)
      await registry.connect(authority1).setValue(stream1, 110);
      await registry.connect(authority2).setValue(stream2, 210);
      const round1 = await satori.getCurrentRound();

      // Cadence 2 - no writes; both streams simply go stale for a period
      await time.increase(CADENCE_SECONDS);

      // Cadence 3 - only update stream1
      await time.increase(CADENCE_SECONDS);
      await registry.connect(authority1).setValue(stream1, 80); // DOWN
      const round3 = await satori.getCurrentRound();

      // Cadence 4 - don't update either
      await time.increase(CADENCE_SECONDS);

      // Cadence 5 - update stream2
      await time.increase(CADENCE_SECONDS);
      await registry.connect(authority2).setValue(stream2, 250); // UP
      const round5 = await satori.getCurrentRound();

      // Check changes (now using rounds 1->3 and 1->5)
      const change1 = await satori.getValueChange(stream1, round1, round3);
      expect(change1).to.equal(-1); // DOWN from 110 to 80

      const change2 = await satori.getValueChange(stream2, round1, round5);
      expect(change2).to.equal(1); // UP from 210 to 250
    });
  });

  describe("Edge Cases", function () {
    let stream1;

    beforeEach(async function () {
      const tx = await satori.createSimpleDataStream(
        "Test Stream",
        authority1.address
      );
      stream1 = await getStreamIdFromTx(tx, satori);
    });

    it("Should allow only one value update per day", async function () {
      // First update in the day
      await registry.connect(authority1).setValue(stream1, 100);

      // Second update in same day should fail
      await expect(
        registry.connect(authority1).setValue(stream1, 200)
      ).to.be.revertedWithCustomError(registry, "CadenceRoundsNotElapsed");

      // First value should be retained
      const info = await registry.getDataStreamInfo(stream1);
      expect(info[3]).to.equal(100n); // value
    });

    it("Should handle first value set after multiple rounds", async function () {
      // Capture initial round
      const round0 = await satori.getCurrentRound();

      // End multiple rounds without setting any value
      const currentTime = await time.latest();
      const midnight = Math.floor(currentTime / 86400) * 86400 + 86400;

      await time.setNextBlockTimestamp(midnight + 1);
      await time.increase(86400); // Round 1

      await time.setNextBlockTimestamp(midnight + 86400 + 1);
      await time.increase(86400); // Round 2

      // Set first value in round 2
      await registry.connect(authority1).setValue(stream1, 100);
      const round2 = await satori.getCurrentRound();

      const info = await registry.getDataStreamInfo(stream1);
      expect(info[3]).to.equal(100n); // value

      // Stream went from 0 (default) to 100
      const change = await satori.getValueChange(stream1, round0, round2);
      expect(change).to.equal(1); // UP (0 to 100 is an increase)
    });
  });
});
