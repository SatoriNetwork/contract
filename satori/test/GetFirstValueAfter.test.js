/**
 * GetFirstValueAfter.test.js
 *
 * Coverage for `SatoriRegistry.getFirstValueAfter` — the single-B view
 * function used by the AB scoring path for non-daily streams.
 *
 * Mirrors the failure-mode shape of getFirstTwoValuesAfter but exits on
 * the first post-anchor tick. Outcomes: anchor + B found; recoverable
 * (waiting for B); anchor evicted by ring rotation (irrecoverable).
 */

const { expect } = require("chai");
const { deploySatoriFixture } = require("./fixtures");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const DAY = 86400;

// `getFirstValueAfter` is the AB path's single-B lookup, and AB scoring is what a
// cadence >= 2 stream gets — so these streams are created at cadence 2 (daily),
// the finest a public user may create. One cadence period is TWO rounds, so every
// re-write of the stream's value is spaced by `advanceCadence()`.
const CADENCE_ROUNDS = 2;
const CADENCE_MINUTES = 1440; // the same duration, as the contract now wants it
// The ring is HOUR-keyed (phase 6): "first value after round r" queries the
// round's LAST hour, r*24+23.
const lastHourOf = (r) => BigInt(r) * 24n + 23n;

async function getStreamIdFromTx(tx, satori) {
    const receipt = await tx.wait();
    const event = receipt.logs.find(log => {
        try {
            const parsed = satori.interface.parseLog(log);
            return parsed && parsed.name === 'DataStreamCreated';
        } catch { return false; }
    });
    if (!event) throw new Error("DataStreamCreated event not found");
    return satori.interface.parseLog(event).args.streamId;
}

async function advanceRound() {
    const now = await time.latest();
    const nextMidnight = Math.floor(now / DAY) * DAY + DAY;
    await time.increaseTo(nextMidnight + 1);
}

/// One full cadence period of the streams under test — enough rounds AND enough
/// wall-clock for the next setValue to clear both cadence guards.
async function advanceCadence() {
    for (let i = 0; i < CADENCE_ROUNDS; i++) await advanceRound();
}

describe("SatoriRegistry.getFirstValueAfter", function () {
    let satori, registry;
    let owner, authority1;

    beforeEach(async function () {
        const fix = await deploySatoriFixture();
        satori = fix.satori;
        registry = fix.registry;
        owner = fix.owner;
        authority1 = fix.signers[1];

        await satori.transfer(authority1.address, ethers.parseEther("100"));
    });

    async function createSimple(authority, cadence) {
        const tx = cadence === undefined
            ? await satori.connect(authority).createSimpleDataStream("S", authority.address)
            : await satori.connect(authority)["createSimpleDataStream(string,address,uint24)"](
                "S", authority.address, cadence
            );
        return getStreamIdFromTx(tx, satori);
    }

    describe("count < 2 — anchor + B insufficient in the ring", function () {
        it("count == 0: recoverable (no ring to walk yet)", async function () {
            const id = await createSimple(authority1, CADENCE_MINUTES);
            const [b, found, evicted] = await registry.getFirstValueAfter(id, 0);
            expect(b).to.equal(0n);
            expect(found).to.equal(false);
            expect(evicted).to.equal(false);
        });

        it("count == 1: recoverable (waiting for B)", async function () {
            const id = await createSimple(authority1, CADENCE_MINUTES);
            await registry.connect(authority1).setValue(id, 100);
            const round = await satori.getCurrentRound();

            const [b, found, evicted] = await registry.getFirstValueAfter(id, lastHourOf(round));
            expect(b).to.equal(0n);
            expect(found).to.equal(false);
            expect(evicted).to.equal(false);
        });
    });

    describe("count >= 2 — full ring-walk path", function () {
        it("returns first post-anchor tick when both A and B are present", async function () {
            const id = await createSimple(authority1, CADENCE_MINUTES);
            await advanceCadence(); // anchor setValue to a fresh cadence period
            await registry.connect(authority1).setValue(id, 100); // A
            const predRound = await satori.getCurrentRound();
            await advanceCadence();
            await registry.connect(authority1).setValue(id, 150); // B

            const [b, found, evicted] = await registry.getFirstValueAfter(id, lastHourOf(predRound));
            expect(b).to.equal(150n);
            expect(found).to.equal(true);
            expect(evicted).to.equal(false);
        });

        it("returns the FIRST post-anchor tick when multiple exist (B, not C/D/...)", async function () {
            const id = await createSimple(authority1, CADENCE_MINUTES);
            await advanceCadence();
            await registry.connect(authority1).setValue(id, 100);
            const predRound = await satori.getCurrentRound();
            for (const v of [150, 200, 250]) {
                await advanceCadence();
                await registry.connect(authority1).setValue(id, v);
            }

            const [b, found, evicted] = await registry.getFirstValueAfter(id, lastHourOf(predRound));
            expect(b).to.equal(150n); // first post-anchor, not 200 or 250
            expect(found).to.equal(true);
            expect(evicted).to.equal(false);
        });

        it("count >= 2 but no post-anchor tick yet (predRound is the newest entry's round): recoverable", async function () {
            const id = await createSimple(authority1, CADENCE_MINUTES);
            await advanceCadence();
            await registry.connect(authority1).setValue(id, 100);
            await advanceCadence();
            await registry.connect(authority1).setValue(id, 150);
            const predRound = await satori.getCurrentRound();
            // No further ticks; predRound matches the newest entry's round.

            const [b, found, evicted] = await registry.getFirstValueAfter(id, lastHourOf(predRound));
            expect(found).to.equal(false);
            expect(evicted).to.equal(false); // still recoverable
        });

        it("anchor evicted by ring rotation: anchorEvicted=true", async function () {
            const id = await createSimple(authority1, CADENCE_MINUTES);
            await advanceCadence();
            await registry.connect(authority1).setValue(id, 100);
            const predRound = await satori.getCurrentRound();

            // 769 more setValues (one per round — the stream is every-round
            // now) to roll the anchor out of the 768-slot ring.
            this.timeout(600000);
            for (let i = 0; i < 769; i++) {
                await advanceRound();
                await registry.connect(authority1).setValue(id, 200 + i);
            }

            const [, found, evicted] = await registry.getFirstValueAfter(id, lastHourOf(predRound));
            expect(found).to.equal(false);
            expect(evicted).to.equal(true);
        });
    });

});
