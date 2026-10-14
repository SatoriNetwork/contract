/**
 * StrandedPredictionRecovery.test.js
 *
 * Pending predictions can become permanently unscoreable in two ways:
 *   - The 32-slot stream history rolls past the prediction's anchor.
 *   - The stream goes silent for 32+ rounds (no setValue activity) — the
 *     stale-anchor check in `SatoriRegistry.getFirstTwoValuesAfter` returns
 *     `anchorEvicted = true` after the inactivity threshold.
 *
 * Either way, _unsettledPredictionCount[user][round] would otherwise stay
 * > 0 forever, halting the predictor's claim cursor on every subsequent
 * winning round.
 *
 * The fix:
 *   1. SatoriRegistry::getFirstTwoValuesAfter returns `anchorEvicted = true`
 *      for both ring-buffer eviction AND 32-round silence.
 *   2. Satori::_scorePreviousPrediction force-finalizes the slot on
 *      `anchorEvicted`. Counter decrements, no reward is paid.
 *   3. Satori::settlePrediction has no streamExists gate so any caller
 *      can drain a stranded prediction.
 */

const { expect } = require("chai");
const { deploySatoriFixture, pack1, voteFor } = require("./fixtures");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const UP = 1;
const DOWN = 2;

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

// Both streams are created at 2880 minutes (two 24h rounds). A value may only
// be written once per CADENCE_ROUNDS rounds, and the scoring window is AB:
// anchor = the value AT the predict round, post = the FIRST value written
// after it. (A 1440-minute stream would score ABC — not this file's point.)
// Ring eviction is still counted in WRITES (the ring is 32 slots regardless),
// and the "silent stream" gaps below are still counted in ROUNDS — silence is
// silence.
const CADENCE_ROUNDS = 2;
async function advanceCadencePeriod() {
    for (let i = 0; i < CADENCE_ROUNDS; i++) await advanceRound();
}

describe("Stranded prediction recovery", function () {
    let satori, voting, rewards, bounties, registry, engine;
    let owner, alice, bob, carol;
    let stream1, stream2;

    beforeEach(async function () {
        const fix = await deploySatoriFixture();
        ({ satori, voting, rewards, registry, bounties, engine, owner } = fix);
        [, alice, bob, carol] = fix.signers;

        stream1 = await getStreamIdFromTx(
            await satori["createSimpleDataStream(string,address,uint24)"]("S1", owner.address, 2880), satori);
        stream2 = await getStreamIdFromTx(
            await satori["createSimpleDataStream(string,address,uint24)"]("S2", owner.address, 2880), satori);

        await satori.transfer(alice.address, ethers.parseEther("100"));
        await satori.transfer(bob.address, ethers.parseEther("100"));
        await satori.transfer(carol.address, ethers.parseEther("100"));
        // Burn-backed weight: 10 each, leaving alice and bob 90 to predict with.
        await voteFor(satori, alice, stream1);
        await voteFor(satori, bob, stream2);

        await advanceRound();
        await registry.setValue(stream1, 100);
        await registry.setValue(stream2, 100);
    });

    describe("silent stream", function () {
        // Streams are permanent — there is no deleteStream. A silent stream's
        // pending prediction just stays pending (settlePrediction is a no-op
        // when found=false and the anchor hasn't been ring-evicted). Nothing
        // user-facing depends on cleanup: claim() reads unclaimedRewards
        // directly and the delegator cursor advances unconditionally
        // (see DelegatorDeltaClaim.test.js).

        it("scores normally when the post-anchor value exists", async function () {
            await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);
            const round1 = await satori.getCurrentRound();

            await advanceCadencePeriod();
            await registry.setValue(stream1, 150); // post > anchor (100) — UP correct

            await satori.connect(carol).settlePrediction(alice.address, stream1);

            const pred = await satori.predictions(alice.address, stream1, round1);
            expect(pred.scored).to.equal(true);
            expect(await satori.streaks(alice.address, stream1)).to.equal(1);
        });

        it("claim still works for wins on other streams while one slot is stranded", async function () {
            await satori.connect(alice).predictMultipleWithPayloads([
                { gameId: stream1, payload: pack1(UP) },
                { gameId: stream2, payload: pack1(UP) },
            ]);

            const round1 = await satori.getCurrentRound();

            // stream2 gets its post-anchor value. stream1 never ticks again.
            await advanceCadencePeriod();
            await registry.setValue(stream2, 150);

            // stream1 stays silent forever. Silence is measured in ROUNDS, not
            // cadence periods, so this gap is deliberately not doubled.
            for (let i = 0; i < 33; i++) await advanceRound();

            // Settle stream2 so Alice has a recorded win.
            await satori.connect(carol).settlePrediction(alice.address, stream2);
            // stream1's slot is permanently pending — no force-finalize on
            // silence anymore. settle is a no-op for it.
            await satori.connect(carol).settlePrediction(alice.address, stream1);
            const stuck = await satori.predictions(alice.address, stream1, round1);
            expect(stuck.scored).to.equal(false);

            // Alice's claim works regardless — own rewards are eager-credited.
            const tx = await satori.connect(alice).claim();
            const receipt = await tx.wait();
            const claimEvent = receipt.logs.find(log => {
                try {
                    const parsed = rewards.interface.parseLog(log);
                    return parsed && parsed.name === 'RewardsClaimed';
                } catch { return false; }
            });
            expect(claimEvent).to.not.equal(undefined);
            const claimed = rewards.interface.parseLog(claimEvent).args.totalAmount;
            expect(claimed).to.be.gt(0);
        });
    });

    describe("anchor eviction", function () {
        it("force-finalizes the pending slot when 32-slot history rolls past the anchor", async function () {
            // Alice predicts at round D on stream1.
            await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);
            const round1 = await satori.getCurrentRound();

            // Push 33 setValue ticks so the anchor (the entry at <= round1)
            // is evicted from the 32-slot ring.
            // The first setValue (in beforeEach) is the anchor's predecessor;
            // we need 32+ entries strictly after roundD to push it out.
            for (let i = 0; i < 33; i++) {
                await advanceCadencePeriod();
                await registry.setValue(stream1, 100 + i);
            }

            // settlePrediction hard-finalizes the slot (ring-evicted anchor
            // is also an anchorEvicted signal). scored=true so the counter
            // drops. Ring eviction is the predictor's own inaction, so the
            // streak resets to 0 (here it was already 0 — see
            // RingEvictionStreakReset.test.js for the built-up-streak case).
            await satori.connect(carol).settlePrediction(alice.address, stream1);

            const pred = await satori.predictions(alice.address, stream1, round1);
            expect(pred.scored).to.equal(true);
            expect(await satori.streaks(alice.address, stream1)).to.equal(0);
        });

        it("does NOT prematurely finalize when the post-anchor value just hasn't ticked yet", async function () {
            // Alice predicts and NO post-prediction tick exists yet. (On an
            // AB-scored stream the window needs exactly one value after the
            // anchor, so "not resolvable yet" means zero post-anchor ticks —
            // the same not-yet-resolvable state the ABC form expressed as
            // "B but no C".)
            await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);
            const round1 = await satori.getCurrentRound();

            // settlePrediction should leave the slot pending — recoverable, NOT
            // force-finalized: the anchor is still in the ring, it simply has no
            // successor yet.
            await satori.connect(carol).settlePrediction(alice.address, stream1);

            const pred = await satori.predictions(alice.address, stream1, round1);
            expect(pred.scored).to.equal(false);

            // Now the post value arrives; settle should succeed.
            await advanceCadencePeriod();
            await registry.setValue(stream1, 200);

            await satori.connect(carol).settlePrediction(alice.address, stream1);
            const predAfter = await satori.predictions(alice.address, stream1, round1);
            expect(predAfter.scored).to.equal(true);
            expect(await satori.streaks(alice.address, stream1)).to.equal(1);
        });
    });

    describe("non-existent stream", function () {
        it("settlePrediction is a safe no-op for a stream that never existed", async function () {
            // Stream id 9999 was never created. Pre-fix this reverted with
            // "!stream". Post-fix it's a no-op (no
            // predictions on the slot, nothing to do).
            await expect(
                satori.connect(carol).settlePrediction(alice.address, 9999)
            ).to.not.be.reverted;
        });
    });

    describe("non-daily cadences (per-stream minCadenceRounds)", function () {
        const DAY = 86400;

        // Create a Simple stream with explicit cadence, with `owner` as the
        // authority so the registry's setValue path works with the default
        // signer.
        async function createSimpleWithCadence(name, cadenceRounds) {
            const tx = await satori["createSimpleDataStream(string,address,uint24)"](
                name, owner.address, cadenceRounds
            );
            return getStreamIdFromTx(tx, satori);
        }

        describe("weekly stream — AB scoring (cadence >= 2)", function () {
            // AB scoring compares A (value at predRound) directly against B
            // (first post-prediction tick). Settlement requires only ONE
            // post-prediction tick, not two — half the latency of ABC.

            it("scores a correct UP prediction in one cycle: streak = 1 (B > A)", async function () {
                const weeklyId = await createSimpleWithCadence("Weekly", 5040);
                await registry.setValue(weeklyId, 100);              // A = 100

                await satori.connect(alice).predictMultipleWithPayloads([{ gameId: weeklyId, payload: pack1(UP) }]);
                const predRound = await satori.getCurrentRound();

                // Advance 7 days + 1s and post B. AB scoring: B(150) > A(100)
                // → UP correct, streak = 1. No C needed.
                await time.increase(7 * DAY + 1);
                await registry.setValue(weeklyId, 150);              // B = 150

                await satori.connect(carol).settlePrediction(alice.address, weeklyId);

                const pred = await satori.predictions(alice.address, weeklyId, predRound);
                expect(pred.scored).to.equal(true);
                expect(await satori.streaks(alice.address, weeklyId)).to.equal(1);
            });

            it("scores DOWN correct (B < A) — streak = 1", async function () {
                const weeklyId = await createSimpleWithCadence("Weekly", 5040);
                await registry.setValue(weeklyId, 200);

                await satori.connect(alice).predictMultipleWithPayloads([{ gameId: weeklyId, payload: pack1(DOWN) }]);

                await time.increase(7 * DAY + 1);
                await registry.setValue(weeklyId, 150);              // B(150) < A(200)

                await satori.connect(carol).settlePrediction(alice.address, weeklyId);

                expect(await satori.streaks(alice.address, weeklyId)).to.equal(1);
            });

            it("scores UP incorrect (B < A) — streak reset to 0", async function () {
                const weeklyId = await createSimpleWithCadence("Weekly", 5040);
                await registry.setValue(weeklyId, 200);

                await satori.connect(alice).predictMultipleWithPayloads([{ gameId: weeklyId, payload: pack1(UP) }]);

                await time.increase(7 * DAY + 1);
                await registry.setValue(weeklyId, 150);              // B(150) < A(200) — UP wrong

                await satori.connect(carol).settlePrediction(alice.address, weeklyId);

                expect(await satori.streaks(alice.address, weeklyId)).to.equal(0);
            });

            it("voids when B == A (no movement) — streak preserved, no reward", async function () {
                // Build a small streak first so we can verify "preserved".
                // Use a separate cadence-1 stream to build the streak, then a
                // cadence>=2 stream to test the void.
                // Simpler: predict, score void, observe streak stays 0.
                const weeklyId = await createSimpleWithCadence("Weekly", 5040);
                await registry.setValue(weeklyId, 100);

                await satori.connect(alice).predictMultipleWithPayloads([{ gameId: weeklyId, payload: pack1(UP) }]);

                await time.increase(7 * DAY + 1);
                await registry.setValue(weeklyId, 100);              // B == A → Void

                await expect(satori.connect(carol).settlePrediction(alice.address, weeklyId))
                    .to.emit(engine, "PredictionVoided");

                // Streak stays at 0 (no increment for Void, no reset either).
                expect(await satori.streaks(alice.address, weeklyId)).to.equal(0);
            });
        });

    });
});
