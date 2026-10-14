const { expect } = require("chai");
const { deploySatoriFixture } = require("./fixtures");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

// Registry now owns the 768-slot per-stream history ring (absorbed from the
// deleted SatoriHistory contract, deepened for the hour-keyed rolling-scoring
// redesign). These tests exercise the buffer via registry.setValue (authority
// path, bypassing the core's 23-hour constraint) and the new
// registry.getHistory() view. Entries are keyed by absolute HOUR
// (block.timestamp / 3600), so the "rounds" array carries hours.
//
// The ring's rhythm is part of what's under test here, so these streams are
// created the way a real user gets them: 1440 minutes (daily — the finest a
// public stream may be, and exactly one 24h round). One cadence period is
// therefore ONE round, and every write is spaced by CADENCE_SECONDS below.
const CADENCE_ROUNDS = 1;
const CADENCE_SECONDS = 86400 * CADENCE_ROUNDS; // 24h — one daily cadence period

describe("Registry history buffer (768-slot, hour-keyed)", function () {
    this.timeout(1200000); // the eviction test writes 769 daily values
    let satori, registry;
    let owner, authority;

    beforeEach(async function () {
        const fix = await deploySatoriFixture();
        ({ satori, registry } = fix);
        owner = fix.owner;
        authority = fix.signers[1];
    });

    async function createStream(auth) {
        const tx = await satori.createSimpleDataStream("Test Stream", auth.address);
        const receipt = await tx.wait();
        const event = receipt.logs.find(log => {
            try {
                const parsed = registry.interface.parseLog(log);
                return parsed && parsed.name === "DataStreamCreated";
            } catch { return false; }
        });
        return registry.interface.parseLog(event).args.streamId;
    }

    it("empty history returns count=0 and empty arrays", async function () {
        // Stream id 1 is the DEFAULT stream, which initializeDefaultStream()
        // already seeded with one write. Use a freshly created, never-written
        // stream to exercise the genuinely-empty buffer.
        const streamId = await createStream(authority);
        const [values, dates, count] = await registry.getHistory(streamId);
        expect(count).to.equal(0);
        expect(values.length).to.equal(0);
        expect(dates.length).to.equal(0);
    });

    it("two values recorded → getHistory returns both oldest-first", async function () {
        const streamId = await createStream(authority);

        await registry.connect(authority).setValue(streamId, 100n);
        await time.increase(CADENCE_SECONDS);
        await registry.connect(authority).setValue(streamId, 200n);

        const [values, dates, count] = await registry.getHistory(streamId);
        expect(count).to.equal(2);
        expect(values[0]).to.equal(100n);
        expect(values[1]).to.equal(200n);
        // `dates` are absolute HOURS; one daily cadence period is 24 hours apart.
        expect(dates[1] - dates[0]).to.equal(BigInt(CADENCE_ROUNDS * 24)); // one day apart
    });

    it("769th value evicts oldest; count stays 768", async function () {
        const streamId = await createStream(authority);

        for (let i = 0; i < 769; i++) {
            await registry.connect(authority).setValue(streamId, BigInt(i * 10 + 1));
            await time.increase(CADENCE_SECONDS);
        }

        const [values, , count] = await registry.getHistory(streamId);
        expect(count).to.equal(768);
        // Entry 0 (value 1) was evicted. Oldest is entry 1 (value 11).
        expect(values[0]).to.equal(11n);
        // Newest is entry 768 (value 7681).
        expect(values[767]).to.equal(7681n);
    });

    it("different streams have independent histories", async function () {
        const streamA = await createStream(authority);
        const streamB = await createStream(authority);

        await registry.connect(authority).setValue(streamA, 111n);
        await time.increase(CADENCE_SECONDS);
        await registry.connect(authority).setValue(streamA, 222n);
        await time.increase(CADENCE_SECONDS);
        await registry.connect(authority).setValue(streamB, 999n);

        const [valuesA, , countA] = await registry.getHistory(streamA);
        const [valuesB, , countB] = await registry.getHistory(streamB);

        expect(countA).to.equal(2);
        expect(valuesA[0]).to.equal(111n);
        expect(valuesA[1]).to.equal(222n);

        expect(countB).to.equal(1);
        expect(valuesB[0]).to.equal(999n);
    });

});
