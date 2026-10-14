/**
 * RingEvictionStreakReset.test.js
 *
 * A pending prediction force-finalizes (PredictionUnrecoverable) only when
 * the stream produced enough new values to push the anchor out of the
 * 768-slot ring. That's the predictor's own inaction — they never triggered
 * scoring while the data was still locatable — so the streak resets to 0.
 *
 * A stream that just goes silent doesn't force-finalize: the slot stays
 * pending indefinitely. Nothing user-facing depends on cleanup, so we
 * accept that as the cost of not having a separate stale path.
 */

const { expect } = require("chai");
const { deploySatoriFixture, pack1, voteFor } = require("./fixtures");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const UP = 1;

async function getStreamIdFromTx(tx, satoriContract) {
    const receipt = await tx.wait();
    const event = receipt.logs.find(log => {
        try {
            const parsed = satoriContract.interface.parseLog(log);
            return parsed && parsed.name === 'DataStreamCreated';
        } catch { return false; }
    });
    if (!event) throw new Error("DataStreamCreated event not found");
    return satoriContract.interface.parseLog(event).args.streamId;
}

async function advanceRound() {
    const currentTime = await time.latest();
    const nextMidnight = Math.floor(currentTime / 86400) * 86400 + 86400;
    await time.increaseTo(nextMidnight + 1);
}

// The stream below is created at 2880 minutes (two 24h rounds). A value may
// only be written every CADENCE_ROUNDS rounds, and scoring is the coarse
// next-sample band (cadence > 1440): anchor = the standing sample at the
// prediction's moment, target = the first value written after it. (A
// 1440-minute stream would score ABC — not this file's point.) The ring is
// 768 slots, so eviction takes 768+ post-anchor WRITES; only the wall-clock
// between them changes. Rounds advanced for a NON-value reason (the silence
// test below) stay plain ROUNDS.
const CADENCE_ROUNDS = 2;
async function advanceCadencePeriod() {
    for (let i = 0; i < CADENCE_ROUNDS; i++) await advanceRound();
}

describe("Streak reset on ring-eviction (predictor's inaction) vs stale silence", function () {
    this.timeout(1200000); // 768-deep ring eviction loop
    let satori, engine, voting, rewards, bounties, registry;
    let owner, alice, carol;
    let stream1;

    beforeEach(async function () {
        [, alice, , carol] = await ethers.getSigners();

        const fix = await deploySatoriFixture();
        ;({ satori, engine, voting, rewards, registry, bounties, owner } = fix);

        stream1 = await getStreamIdFromTx(
            await satori["createSimpleDataStream(string,address,uint24)"]("S1", owner.address, 2880), satori);

        await satori.transfer(alice.address, ethers.parseEther("100"));
        await voteFor(satori, alice, stream1);

        await advanceRound();
        await registry.setValue(stream1, 100); // anchor A for the streak-builder
    });

    // Build a streak of 1: a correct UP prediction (AB, post > anchor).
    async function buildStreakOfOne() {
        await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]); // anchor A = 100
        await advanceCadencePeriod();
        await registry.setValue(stream1, 110);            // post → UP correct (110 > 100)
        await satori.connect(carol).settlePrediction(alice.address, stream1);
        expect(await satori.streaks(alice.address, stream1)).to.equal(1);
    }

    it("ring-eviction (stream keeps producing) resets the streak to 0", async function () {
        await buildStreakOfOne();

        // Fresh prediction whose anchor we will let the ring roll past.
        await advanceCadencePeriod();
        await registry.setValue(stream1, 130);            // P2 anchor
        await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);
        const p2Round = await satori.getCurrentRound();

        // Stream KEEPS PRODUCING: 769 new ticks (a value every cadence period, so
        // never stale) push P2's anchor out of the 768-slot ring.
        for (let i = 0; i < 769; i++) {
            await advanceCadencePeriod();
            await registry.setValue(stream1, 200 + i);
        }

        await expect(satori.connect(carol).settlePrediction(alice.address, stream1))
            .to.emit(engine, "PredictionUnrecoverable");

        const pred = await satori.predictions(alice.address, stream1, p2Round);
        expect(pred.scored).to.equal(true);
        // Predictor's inaction stranded the slot → streak reset.
        expect(await satori.streaks(alice.address, stream1)).to.equal(0);
    });

    it("silent stream alone does NOT force-finalize — the slot stays pending", async function () {
        await buildStreakOfOne();

        // Fresh prediction, then the stream goes completely dark (no setValue).
        await advanceCadencePeriod();
        await registry.setValue(stream1, 130);            // P2 anchor
        await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);
        const p2Round = await satori.getCurrentRound();

        // Lots of empty rounds — silence is not a force-finalize trigger anymore.
        for (let i = 0; i < 50; i++) await advanceRound();

        // settle should be a no-op: not found, not anchor-evicted (ring didn't roll).
        await satori.connect(carol).settlePrediction(alice.address, stream1);

        const pred = await satori.predictions(alice.address, stream1, p2Round);
        expect(pred.scored).to.equal(false);
        // Streak unchanged (no win, no loss, no reset).
        expect(await satori.streaks(alice.address, stream1)).to.equal(1);
    });
});
