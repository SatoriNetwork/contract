const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture,
  createCustomStream,
  createChainlinkStream, pack1 } = require("./fixtures");

const DAY = 86400;

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
  return satoriContract.interface.parseLog(event).args.streamId;
}

describe("Stream cadence (per-stream minCadenceRounds — minimum rounds between updates)", function () {
  let satori, registry, mockDataStream, mockChainlink;
  let owner, authority1, user1;

  beforeEach(async function () {
    const fix = await loadFixture(deploySatoriFixture);
    ({ satori, registry, owner } = fix);
    [, authority1, user1] = fix.signers;

    await satori.transfer(authority1.address, ethers.parseEther("100"));
    await satori.transfer(user1.address, ethers.parseEther("100"));
    // The fixture already calls initializeDefaultStream() (matching deploy.js),
    // so the bootstrapped default stream is id 1.

    const MockDataStream = await ethers.getContractFactory("MockDataStream");
    mockDataStream = await MockDataStream.deploy();
    await mockDataStream.waitForDeployment();

    const MockChainlinkAggregator = await ethers.getContractFactory("MockChainlinkAggregator");
    mockChainlink = await MockChainlinkAggregator.deploy();
    await mockChainlink.waitForDeployment();
  });

  // A round is 24h, so "daily" is 1440 minutes (one write per round) — and
  // 1440 is also the FLOOR for a public stream
  // (SatoriHub._requireGameableCadence). The convenience overloads therefore
  // hand out 1440, the finest a user may have.
  describe("Default daily cadence (existing signatures)", function () {
    it("the bootstrapped default stream (id 1) is a Sentiment stream: cadence 60 minutes", async function () {
      // initializeDefaultStream() creates it through the registry as the Coined
      // stream satori, and a Sentiment stream takes exactly cadence 60.
      expect(await registry.streamMinCadenceMinutes(1)).to.equal(60);
    });

    it("createSimpleDataStream(name, authority) defaults to minCadenceRounds = 2", async function () {
      const tx = await satori.connect(authority1).createSimpleDataStream("Daily", authority1.address);
      const streamId = await getStreamIdFromTx(tx, satori);
      expect(await registry.streamMinCadenceMinutes(streamId)).to.equal(1440);
    });

    it("createAdapterDataStream(Custom) defaults to minCadenceRounds = 2", async function () {
      const tx = await createCustomStream(
        satori.connect(authority1), "Daily Custom", await mockDataStream.getAddress(), authority1.address
      );
      const streamId = await getStreamIdFromTx(tx, satori);
      expect(await registry.streamMinCadenceMinutes(streamId)).to.equal(1440);
    });

    it("createAdapterDataStream(Chainlink) defaults to minCadenceRounds = 2", async function () {
      const tx = await createChainlinkStream(
        satori.connect(authority1), "Daily Chainlink", await mockChainlink.getAddress(), authority1.address
      );
      const streamId = await getStreamIdFromTx(tx, satori);
      expect(await registry.streamMinCadenceMinutes(streamId)).to.equal(1440);
    });
  });

  describe("Explicit per-stream cadence (new overloads)", function () {
    it("stores weekly cadence on a Simple stream", async function () {
      const tx = await satori.connect(authority1)["createSimpleDataStream(string,address,uint24)"](
        "Weekly",
        authority1.address,
        5040
      );
      const streamId = await getStreamIdFromTx(tx, satori);
      expect(await registry.streamMinCadenceMinutes(streamId)).to.equal(5040);
    });

    it("stores monthly cadence on a Custom stream", async function () {
      const tx = await createCustomStream(
        satori.connect(authority1), "Monthly Custom", await mockDataStream.getAddress(), authority1.address, 21600
      );
      const streamId = await getStreamIdFromTx(tx, satori);
      expect(await registry.streamMinCadenceMinutes(streamId)).to.equal(21600);
    });

    it("stores quarterly cadence on a Chainlink stream", async function () {
      const tx = await createChainlinkStream(
        satori.connect(authority1), "Quarterly Chainlink", await mockChainlink.getAddress(), authority1.address, 64800
      );
      const streamId = await getStreamIdFromTx(tx, satori);
      expect(await registry.streamMinCadenceMinutes(streamId)).to.equal(64800);
    });

    it("rejects minCadenceRounds = 0 (must be at least 1)", async function () {
      // The registry's own floor is 1. Reach it as the ADMIN: a public caller is
      // stopped earlier by the hub's cadence floor (covered in
      // StreamCadenceFloor.test.js), so only the exempt admin gets far enough to
      // prove that the registry itself still rejects zero.
      await expect(
        satori.connect(owner)["createSimpleDataStream(string,address,uint24)"](
          "Zero Cadence",
          authority1.address,
          0
        )
      ).to.be.revertedWithCustomError(registry, "InvalidCadence");
    });
  });

  // ─── Update-gap guards (round-level + wall-clock timestamp) ─────────────
  // Two layered guards. The round-level guard is
  // `lastUpdateRound + minCadenceRounds > currentRound`. The wall-clock guard
  // is `minCadenceRounds × 24h − 30 min` — it IS cadence-scaled, and the 30
  // minutes are a fixed grace window letting a provider post slightly before
  // the cadence anniversary.
  describe("setValue / updateValue: cadence enforced by round guard + wall-clock floor", function () {
    // Public streams have a cadence FLOOR of 1440 minutes = one round
    // (SatoriHub._requireGameableCadence); only the admin may create a
    // SUB-round stream. Note it is only the CREATOR that must be the admin —
    // the provider stays `authority`, so the rest of each test is unaffected.
    async function createSimple(authority, cadence) {
      if (cadence === undefined) {
        const tx = await satori.connect(authority).createSimpleDataStream("S", authority.address);
        return getStreamIdFromTx(tx, satori);
      }
      const creator = cadence >= 1440 ? authority : owner; // sub-round cadences are admin-only
      const tx = await satori.connect(creator)["createSimpleDataStream(string,address,uint24)"](
        "S", authority.address, cadence
      );
      return getStreamIdFromTx(tx, satori);
    }

    // Park the clock just after a round boundary so "one round later" is
    // unambiguous — otherwise a write landing in the last second of a round
    // would cross two boundaries on a single +24h step.
    async function alignToRoundStart() {
      const now = await time.latest();
      await time.increaseTo(Math.floor(now / DAY) * DAY + DAY + 1);
    }

    it("two-round stream (2880 minutes): one round later still fails, two rounds succeeds", async function () {
      const id = await createSimple(authority1, 2880);
      await alignToRoundStart();
      await registry.connect(authority1).setValue(id, 100);

      // Same round → round-level guard fires.
      await expect(registry.connect(authority1).setValue(id, 101))
        .to.be.revertedWithCustomError(registry, "CadenceRoundsNotElapsed");

      // ONE round (24h) later is still inside the two-round cadence period.
      await time.increase(DAY);
      await expect(registry.connect(authority1).setValue(id, 101))
        .to.be.revertedWithCustomError(registry, "CadenceRoundsNotElapsed");

      // TWO rounds (48h) after the write → clears both the round guard and the
      // 47h30m wall-clock floor.
      await time.increase(DAY);
      await registry.connect(authority1).setValue(id, 102);
    });

    it("every-round stream (1440 minutes — the public floor): setValue same round fails, next round succeeds", async function () {
      // 1440 minutes = one write per 24h round. The round guard reduces to
      // "not the same round".
      const id = await createSimple(authority1, 1440);
      await registry.connect(authority1).setValue(id, 100);

      // Same round → round-level guard fires.
      await expect(registry.connect(authority1).setValue(id, 101))
        .to.be.revertedWithCustomError(registry, "CadenceRoundsNotElapsed");

      // 24h+1s later → next round, past the 23h30m gap.
      await time.increase(24 * 3600 + 1);
      await registry.connect(authority1).setValue(id, 102);
    });

    it("3.5-day stream (5040 minutes → 4 rounds): setValue at 24h fails (round-level guard: 1 round < 4)", async function () {
      const id = await createSimple(authority1, 5040);
      await registry.connect(authority1).setValue(id, 100);

      // Move to next UTC day (round N+1). Daily would allow this; 5040 blocks.
      await time.increase(DAY + 1);
      await expect(registry.connect(authority1).setValue(id, 101))
        .to.be.revertedWithCustomError(registry, "CadenceRoundsNotElapsed");
    });

    it("3.5-day stream: setValue at 7 days (7 rounds later) succeeds", async function () {
      const id = await createSimple(authority1, 5040);
      await registry.connect(authority1).setValue(id, 100);

      await time.increase(7 * DAY + 1);
      await registry.connect(authority1).setValue(id, 101); // succeeds
    });

    it("15-day stream (21600 minutes): setValue at 14 days fails (round-level guard: 14 < 15)", async function () {
      const id = await createSimple(authority1, 21600);
      await registry.connect(authority1).setValue(id, 100);

      await time.increase(14 * DAY);
      await expect(registry.connect(authority1).setValue(id, 101))
        .to.be.revertedWithCustomError(registry, "CadenceRoundsNotElapsed");
    });

    it("15-day stream: setValue at 15 days succeeds", async function () {
      const id = await createSimple(authority1, 21600);
      await registry.connect(authority1).setValue(id, 100);

      await time.increase(15 * DAY + 1);
      await registry.connect(authority1).setValue(id, 101); // succeeds
    });

    it("3.5-day stream: timestamp guard blocks updates < (3.5 days − 30 min) apart, even after 4 round boundaries", async function () {
      // The timestamp guard is "full cadence period minus 30 minutes" — for
      // a 5040-minute stream that's 3.5d − 30min = 300,600s. An authority who
      // setValues at 23:59 of round N cannot setValue again at 00:01 of round
      // N+4 (that's only 3 days + 2 minutes of wall-clock); the round-level
      // guard would allow it (4 boundaries crossed), but the timestamp guard
      // blocks until ~3.479 days have actually elapsed.
      const id = await createSimple(authority1, 5040);

      const now = await time.latest();
      const midnight = Math.floor(now / DAY) * DAY + DAY;
      await time.increaseTo(midnight + DAY - 60); // 23:59:00

      await registry.connect(authority1).setValue(id, 100);

      // Advance 3 days + 2 minutes: crosses 4 round boundaries (the second
      // setValue would be in round N+4) but only 259,320 wall-clock
      // seconds — short of the 300,600-second timestamp floor.
      await time.increase(3 * DAY + 120);
      await expect(registry.connect(authority1).setValue(id, 101))
        .to.be.revertedWithCustomError(registry, "CadenceGapNotElapsed");

      // Advance enough to clear the timestamp floor: total elapsed will be
      // ~4 days. Now setValue succeeds.
      await time.increase(DAY); // total ~4d + 2min — well past the 3.479d floor
      await registry.connect(authority1).setValue(id, 101);
    });
  });

  describe("predict: no expiry window (phase 6) — StaleValue is the only freshness gate", function () {
    async function createAndSeedSimple(authority, cadence) {
      // Align to the start of a round so the setValue lands at round-start.
      await advanceRound();
      // Phase 6: any caller may create down to 60-minute cadence; keeping the
      // creator split is harmless (this block only uses cadences >= 1440).
      const creator = cadence === undefined || cadence >= 1440 ? authority : owner;
      const tx = cadence === undefined
        ? await satori.connect(authority).createSimpleDataStream("S", authority.address)
        : await satori.connect(creator)["createSimpleDataStream(string,address,uint24)"](
            "S", authority.address, cadence
          );
      const id = await getStreamIdFromTx(tx, satori);
      await registry.connect(authority).setValue(id, 100);
      return id;
    }
    async function advanceRound() {
      const now = await time.latest();
      const next = Math.floor(now / DAY) * DAY + DAY;
      await time.increaseTo(next + 1);
    }

    const UP = 1;

    it("daily stream (1440 minutes): predict in same round as setValue succeeds", async function () {
      const id = await createAndSeedSimple(authority1, 1440);
      // ~10h later — still within the 24h round.
      await time.increase(10 * 3600);
      await satori.connect(user1).predictMultipleWithPayloads([{ gameId: id, payload: pack1(UP) }]);
    });

    it("daily stream (1440 minutes): predict in round after setValue's round SUCCEEDS (PredictExpired is gone)", async function () {
      // Phase 6 deleted PredictExpired: moment-anchored scoring keys the
      // anchor to the prediction's own hour, so a stream written in round N
      // is still predictable in round N+1 — the anchor is simply the last
      // entry at or before the prediction.
      const id = await createAndSeedSimple(authority1, 1440);
      await advanceRound(); // step into round N+1
      await satori.connect(user1).predictMultipleWithPayloads([{ gameId: id, payload: pack1(UP) }]);
      const pred = await satori.getLatestPrediction(user1.address, id);
      expect(pred.roundMade).to.equal(await satori.getCurrentRound());
    });

    it("daily stream: a REPEAT prediction with no intervening write reverts StaleValue", async function () {
      // The freshness gate that survives phase 6: a user's second prediction
      // on a game requires the stream to have written since their last one.
      const id = await createAndSeedSimple(authority1, 1440);
      await satori.connect(user1).predictMultipleWithPayloads([{ gameId: id, payload: pack1(UP) }]);
      await advanceRound(); // new round, so it's not DuplicatePrediction — but no new write either
      await expect(satori.connect(user1).predictMultipleWithPayloads([{ gameId: id, payload: pack1(UP) }]))
        .to.be.revertedWithCustomError(satori, "StaleValue");
    });

    it("weekly stream: predict in same round as setValue succeeds", async function () {
      const id = await createAndSeedSimple(authority1, 5040);
      await time.increase(2 * 3600);
      await satori.connect(user1).predictMultipleWithPayloads([{ gameId: id, payload: pack1(UP) }]);
    });

    it("weekly stream: predict 1 round after setValue's round SUCCEEDS (PredictExpired is gone)", async function () {
      const id = await createAndSeedSimple(authority1, 5040);
      await advanceRound(); // the round AFTER the weekly setValue's round
      await satori.connect(user1).predictMultipleWithPayloads([{ gameId: id, payload: pack1(UP) }]);
      const pred = await satori.getLatestPrediction(user1.address, id);
      expect(pred.roundMade).to.equal(await satori.getCurrentRound());
    });

    it("weekly stream: predict 5 days after setValue SUCCEEDS (moment-anchored, no expiry window)", async function () {
      const id = await createAndSeedSimple(authority1, 5040);
      await time.increase(5 * DAY);
      await satori.connect(user1).predictMultipleWithPayloads([{ gameId: id, payload: pack1(UP) }]);
      const pred = await satori.getLatestPrediction(user1.address, id);
      expect(pred.roundMade).to.equal(await satori.getCurrentRound());
    });
  });
});
