/**
 * PerStreamPowerInvariant.test.js
 *
 * Tests the per-slot rawPredictionPower allocation:
 *
 *   - Single-stream predict() stores the user's full prediction power.
 *   - N-stream predictMultiple() stores totalPower / N in every slot.
 */

const { expect } = require("chai");
const { deploySatoriFixture, RAW_TOLERANCE, pack1, voteFor } = require("./fixtures");
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

describe("Per-stream power — equal split", function () {
    let satori, voting, rewards, bounties, registry;
    let owner, alice, bob, carol, dave;
    let streams;

    beforeEach(async function () {
        [owner, alice, bob, carol, dave] = await ethers.getSigners();

        const fix = await deploySatoriFixture();
        ({ satori, voting, rewards, registry, bounties } = fix);

        streams = [];
        for (let i = 0; i < 3; i++) {
            const id = await getStreamIdFromTx(
                await satori.createSimpleDataStream(`S${i}`, owner.address), satori);
            streams.push(id);
        }

        await satori.transfer(alice.address, ethers.parseEther("100"));
        await satori.transfer(bob.address, ethers.parseEther("100"));
        await satori.transfer(carol.address, ethers.parseEther("100"));
        await satori.transfer(dave.address, ethers.parseEther("100"));

        // Different voters per stream so they're all eligible
        await voteFor(satori, bob, streams[0]);
        await voteFor(satori, carol, streams[1]);
        await voteFor(satori, dave, streams[2]);

        await advanceRound();
        for (let i = 0; i < 3; i++) {
            await registry.setValue(streams[i], 100 + i);
        }
    });

    it("single-stream predict stores the full prediction power", async function () {
        const totalPower = await rewards.getPredictionPower(alice.address);
        const round = await satori.getCurrentRound();

        await satori.connect(alice).predictMultipleWithPayloads([{ gameId: streams[0], payload: pack1(UP) }]);

        const pred = await satori.predictions(alice.address, streams[0], round);
        expect(pred.rawPredictionPower).to.be.closeTo(totalPower, RAW_TOLERANCE);
    });

    it("N-stream predictMultiple stores totalPower / N in every slot", async function () {
        const totalPower = await rewards.getPredictionPower(alice.address);
        const N = 3n;
        const expectedPerSlot = totalPower / N;
        const round = await satori.getCurrentRound();

        await satori.connect(alice).predictMultipleWithPayloads(
            streams.map(id => ({ gameId: id, payload: pack1(UP) }))
        );

        for (let i = 0; i < 3; i++) {
            const pred = await satori.predictions(alice.address, streams[i], round);
            expect(pred.rawPredictionPower).to.be.closeTo(expectedPerSlot, RAW_TOLERANCE);
        }
    });

    it("all batch slots hold identical power (single snapshot)", async function () {
        const round = await satori.getCurrentRound();

        await satori.connect(alice).predictMultipleWithPayloads(
            streams.map(id => ({ gameId: id, payload: pack1(UP) }))
        );

        const first = (await satori.predictions(alice.address, streams[0], round)).rawPredictionPower;
        for (let i = 1; i < 3; i++) {
            const pred = await satori.predictions(alice.address, streams[i], round);
            expect(pred.rawPredictionPower).to.equal(first);
        }
    });

    it("total power across batch is conserved (minus dust)", async function () {
        const totalPower = await rewards.getPredictionPower(alice.address);
        const round = await satori.getCurrentRound();

        await satori.connect(alice).predictMultipleWithPayloads(
            streams.map(id => ({ gameId: id, payload: pack1(UP) }))
        );

        let sum = 0n;
        for (let i = 0; i < 3; i++) {
            const pred = await satori.predictions(alice.address, streams[i], round);
            sum += pred.rawPredictionPower;
        }

        const dust = totalPower - sum;
        expect(dust).to.be.gte(0);
        // Pre-Side-A: bound was streamCount-1 wei of integer-division rounding.
        // Post-Side-A: each stream's rawPower also floors to a multiple of
        // 2^PR_RAW_SHIFT (Side A quantization; PR_RAW_SHIFT=40), so the dust
        // bound is streamCount × 2^40 plus the original streamCount-1 division
        // residual.
        const STREAM_COUNT = 3n;
        expect(dust).to.be.lt(STREAM_COUNT * (1n << 40n) + (STREAM_COUNT - 1n));
    });
});
