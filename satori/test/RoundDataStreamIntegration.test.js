const { expect } = require("chai");
const { deploySatoriFixture } = require("./fixtures");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

// Registry value mechanics are the subject here, so the streams below are the
// ones a real public user gets: the 2-arg `createSimpleDataStream` overload,
// which now defaults to cadence 2 (daily — the finest a non-admin may create).
// One cadence period is therefore TWO rounds / 24h. Advances that precede a
// REWRITE of a stream use CADENCE_SECONDS; advances that merely roll the round
// forward (no write follows) stay at one ROUND.
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

describe("Round-DataStream Integration", function () {
  let satori;
  let registry;
  let owner;
  let authority1;
  let authority2;
  let user1;

  beforeEach(async function () {
    const fix = await deploySatoriFixture();
    ({ satori, registry, owner } = fix);
    [, authority1, authority2, user1] = fix.signers;
  });

  describe("DataStream Lazy Evaluation", function () {
    let stream1;
    let stream2;

    beforeEach(async function () {
      // Create two datastreams
      let tx;

      tx = await satori.createSimpleDataStream(
        "BTC/USD",
        authority1.address
      );
      stream1 = await getStreamIdFromTx(tx, satori);

      tx = await satori.createSimpleDataStream(
        "ETH/USD",
        authority2.address
      );
      stream2 = await getStreamIdFromTx(tx, satori);

      // Set initial values
      const round0 = await satori.getCurrentRound();
      await registry.connect(authority1).setValue(stream1, 50000);
      await registry.connect(authority2).setValue(stream2, 3000);

      // Store round0 for tests to use
      this.round0 = round0;
    });

    it("Should track values lazily without snapshots", async function () {
      // Move to after midnight
      const currentTime = await time.latest();
      const tomorrowMidnight = Math.floor(currentTime / 86400) * 86400 + 86400;
      await time.setNextBlockTimestamp(tomorrowMidnight + 1);

      // Advance a full cadence period (2 rounds) so both streams may be rewritten
      await time.increase(CADENCE_SECONDS);

      // Update values one cadence on
      const round1 = await satori.getCurrentRound();
      await registry.connect(authority1).setValue(stream1, 55000);
      await registry.connect(authority2).setValue(stream2, 2800);

      // Values are tracked lazily - check change from round 0 to 1
      const change1 = await satori.getValueChange(stream1, this.round0, round1);
      const change2 = await satori.getValueChange(stream2, this.round0, round1);

      expect(change1).to.equal(1); // UP from 50000 to 55000
      expect(change2).to.equal(-1); // DOWN from 3000 to 2800
    });

    it("Should track value changes between rounds", async function () {
      // End first round
      const currentTime = await time.latest();
      const tomorrowMidnight = Math.floor(currentTime / 86400) * 86400 + 86400;
      await time.setNextBlockTimestamp(tomorrowMidnight + 1);
      await time.increase(CADENCE_SECONDS); // one cadence period (2 rounds)

      // Update values one cadence on
      const round1 = await satori.getCurrentRound();
      await registry.connect(authority1).setValue(stream1, 55000); // Up 10%
      await registry.connect(authority2).setValue(stream2, 2800);  // Down

      // Check if values went up or down from round 0 to 1
      const change1 = await satori.getValueChange(stream1, this.round0, round1);
      const change2 = await satori.getValueChange(stream2, this.round0, round1);

      expect(change1).to.equal(1); // 1 = UP
      expect(change2).to.equal(-1); // -1 = DOWN
    });

    it("Should handle streams with no value change", async function () {
      // End first round
      const currentTime = await time.latest();
      const tomorrowMidnight = Math.floor(currentTime / 86400) * 86400 + 86400;
      await time.setNextBlockTimestamp(tomorrowMidnight + 1);
      await time.increase(86400);

      // Capture round 1
      const round1 = await satori.getCurrentRound();
      // Don't update stream1 value (stays at 50000)

      // End second round
      await time.setNextBlockTimestamp(tomorrowMidnight + 86400 + 1);
      await time.increase(86400);

      const round2 = await satori.getCurrentRound();
      const change = await satori.getValueChange(stream1, round1, round2);
      expect(change).to.equal(0); // 0 = NO CHANGE
    });

    it("Should handle multiple datastreams with lazy evaluation", async function () {
      // Create more streams
      let tx3 = await satori.createSimpleDataStream(
        "GOLD/USD",
        authority1.address
      );
      const stream3 = await getStreamIdFromTx(tx3, satori);

      let tx4 = await satori.createSimpleDataStream(
        "SILVER/USD",
        authority2.address
      );
      const stream4 = await getStreamIdFromTx(tx4, satori);

      await registry.connect(authority1).setValue(stream3, 2000);
      await registry.connect(authority2).setValue(stream4, 25);

      // End round
      const currentTime = await time.latest();
      const tomorrowMidnight = Math.floor(currentTime / 86400) * 86400 + 86400;
      await time.setNextBlockTimestamp(tomorrowMidnight + 1);
      await time.increase(CADENCE_SECONDS); // one cadence period (2 rounds)

      // Update some streams one cadence on
      const round1 = await satori.getCurrentRound();
      await registry.connect(authority1).setValue(stream1, 52000); // UP
      await registry.connect(authority1).setValue(stream3, 1900); // DOWN
      // stream2 and stream4 not updated

      // Check value changes
      expect(await satori.getValueChange(stream1, this.round0, round1)).to.equal(1); // UP
      expect(await satori.getValueChange(stream2, this.round0, round1)).to.equal(0); // NO CHANGE
      expect(await satori.getValueChange(stream3, this.round0, round1)).to.equal(-1); // DOWN
      expect(await satori.getValueChange(stream4, this.round0, round1)).to.equal(0); // NO CHANGE
    });

    it("Should handle streams created in different rounds", async function () {
      // End first round
      const currentTime = await time.latest();
      const tomorrowMidnight = Math.floor(currentTime / 86400) * 86400 + 86400;
      await time.setNextBlockTimestamp(tomorrowMidnight + 1);
      await time.increase(86400);

      // Create new stream in round 1
      const round1 = await satori.getCurrentRound();
      const tx = await satori.createSimpleDataStream(
        "NEW/USD",
        authority1.address
      );
      const newStream = await getStreamIdFromTx(tx, satori);
      await registry.connect(authority1).setValue(newStream, 100);

      // Advance a full cadence period so newStream may be rewritten
      await time.setNextBlockTimestamp(tomorrowMidnight + 86400 + 1);
      await time.increase(CADENCE_SECONDS);

      // Update new stream one cadence on
      const round2 = await satori.getCurrentRound();
      await registry.connect(authority1).setValue(newStream, 120);

      // Check changes
      const change = await satori.getValueChange(newStream, round1, round2);
      expect(change).to.equal(1); // UP from 100 to 120
    });
  });

  // Note: Snapshot queries have been removed in favor of lazy evaluation
  // Values are now tracked per datastream when updated, not snapshotted globally

  describe("Value Direction Tracking", function () {
    let stream1;

    beforeEach(async function () {
      const tx = await satori.createSimpleDataStream(
        "Direction Test",
        authority1.address
      );
      stream1 = await getStreamIdFromTx(tx, satori);
    });

    it("Should correctly identify UP movement", async function () {
      const round0 = await satori.getCurrentRound();
      await registry.connect(authority1).setValue(stream1, 100);

      // Round 1
      const time1 = await time.latest();
      const midnight1 = Math.floor(time1 / 86400) * 86400 + 86400;
      await time.setNextBlockTimestamp(midnight1 + 1);
      await time.increase(CADENCE_SECONDS); // one cadence period (2 rounds)

      // Increase value one cadence on
      const round1 = await satori.getCurrentRound();
      await registry.connect(authority1).setValue(stream1, 150);

      // Check change from round 0 to round 1
      const direction = await satori.getValueChange(stream1, round0, round1);
      expect(direction).to.equal(1); // UP from 100 to 150
    });

    it("Should correctly identify DOWN movement", async function () {
      const round0 = await satori.getCurrentRound();
      await registry.connect(authority1).setValue(stream1, 100);

      // Round 1
      const time1 = await time.latest();
      const midnight1 = Math.floor(time1 / 86400) * 86400 + 86400;
      await time.setNextBlockTimestamp(midnight1 + 1);
      await time.increase(CADENCE_SECONDS); // one cadence period (2 rounds)

      // Decrease value one cadence on
      const round1 = await satori.getCurrentRound();
      await registry.connect(authority1).setValue(stream1, 50);

      // Check change from round 0 to round 1
      const direction = await satori.getValueChange(stream1, round0, round1);
      expect(direction).to.equal(-1); // DOWN from 100 to 50
    });

    it("Should correctly identify NO CHANGE", async function () {
      await registry.connect(authority1).setValue(stream1, 100);

      // Round 1
      const time1 = await time.latest();
      const midnight1 = Math.floor(time1 / 86400) * 86400 + 86400;
      await time.setNextBlockTimestamp(midnight1 + 1);
      await time.increase(86400);

      // Keep same value
      const round1 = await satori.getCurrentRound();

      // Round 2
      await time.setNextBlockTimestamp(midnight1 + 86400 + 1);
      await time.increase(86400);

      const round2 = await satori.getCurrentRound();
      const direction = await satori.getValueChange(stream1, round1, round2);
      expect(direction).to.equal(0); // NO CHANGE
    });

    it("Should handle negative to positive transitions", async function () {
      const round0 = await satori.getCurrentRound();
      await registry.connect(authority1).setValue(stream1, -100);

      // Round 1
      const time1 = await time.latest();
      const midnight1 = Math.floor(time1 / 86400) * 86400 + 86400;
      await time.setNextBlockTimestamp(midnight1 + 1);
      await time.increase(CADENCE_SECONDS); // one cadence period (2 rounds)

      // Change to positive one cadence on
      const round1 = await satori.getCurrentRound();
      await registry.connect(authority1).setValue(stream1, 50);

      // Check change from round 0 to round 1
      const direction = await satori.getValueChange(stream1, round0, round1);
      expect(direction).to.equal(1); // UP (from -100 to 50)
    });
  });
});
