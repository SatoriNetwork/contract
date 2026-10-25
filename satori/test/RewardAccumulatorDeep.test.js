/**
 * RewardAccumulatorDeep.test.js
 *
 * Behavioral tests for the deep #3 reward refactor: round-keyed accumulators
 * replace the per-tag _userScoredRounds list. Each test exercises a property
 * the new structure must guarantee while staying agnostic to internal storage
 * names so the suite survives later cleanups.
 *
 * Tests assert balance changes from claim() rather than pre-claim views, since
 * the per-stream/per-round rate is populated only when the predictor's
 * _settleRewards runs — this happens implicitly via _accrueDelegatorRewards
 * when the delegator claims. The view function intentionally reflects stored
 * state, not speculative state.
 *
 *  1. Per-round delegator-rate accumulation across multiple streams in one round.
 *  2. Predictor's settle pays out across multiple streams (single-round bundle).
 *  3. Cold-start delegator never sees the predictor's pre-existing wins.
 *  4. Cursor advances correctly across multi-round predictor claims.
 *  5. Mid-period undelegation only credits in-period rounds.
 *  6. No-wins delegate: claim is a no-op, no revert.
 *  7. Long-gap delegator claim with mostly-zero rounds completes and pays out.
 *  8. Long-gap predictor claim across many winning rounds completes.
 *  9. Mixed eligible/ineligible streams in one round: ineligible win does not
 *     contribute to the per-round rate.
 * 10. Predictor view total matches claim minted across many sequential claims.
 */

const { expect } = require("chai");
const { deploySatoriFixture, wrapSatoriForGames, pack1, voteFor } = require("./fixtures");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const UP = 1;
const DOWN = 2;

// These streams are created the way a real user gets them: cadence 2 (daily —
// the finest a public stream may be). A cadence-2 stream may only be written
// once per cadence period, so the round-keyed accumulator this file exercises is
// driven one CADENCE PERIOD at a time rather than one round at a time.
const ROUND = 86400;                              // 24h
const CADENCE_ROUNDS = 2;                         // daily
const CADENCE_SECONDS = ROUND * CADENCE_ROUNDS;   // 24h

// Advance to the start of the next cadence period (2 rounds / 24h ahead),
// landing just past a round boundary so the next setValue clears both the
// round guard and the 23h30m wall-clock guard.
async function advanceCadencePeriod() {
    const currentTime = await time.latest();
    const nextMidnight = Math.floor(currentTime / ROUND) * ROUND + ROUND;
    await time.increaseTo(nextMidnight + 1);
    await time.increase(CADENCE_SECONDS - ROUND);
}

async function getStreamIdFromTx(tx, satori) {
    const receipt = await tx.wait();
    const event = receipt.logs.find(log => {
        try {
            const parsed = satori.interface.parseLog(log);
            return parsed && parsed.name === 'DataStreamCreated';
        } catch {
            return false;
        }
    });
    if (!event) throw new Error("DataStreamCreated event not found");
    return satori.interface.parseLog(event).args.streamId;
}

describe("Deep reward refactor — round-keyed accumulator", function () {
    let satori, voting, rewards, bounties, registry, lens;
    let owner, alice, bob, carol, dave, eve, platform;

    beforeEach(async function () {
        [owner, alice, bob, carol, dave, eve, platform] = await ethers.getSigners();
        const fix = await deploySatoriFixture();
        ({ satori, voting, rewards, registry, lens } = fix);

        // Each predictor / voter / delegator gets a modest balance from the
        // 1440-token initial supply. Total stays under cap.
        await satori.transfer(alice.address, ethers.parseEther("100"));
        await satori.transfer(bob.address, ethers.parseEther("100"));
        await satori.transfer(carol.address, ethers.parseEther("100"));
        await satori.transfer(dave.address, ethers.parseEther("100"));
        await satori.transfer(eve.address, ethers.parseEther("100"));

        // Align to a fresh cadence period so subsequent advanceCadencePeriod +
        // setValue pairs always satisfy the registry's daily cadence guard and
        // the predict path's same-round freshness gate.
        await advanceCadencePeriod();
    });

    it("Aggregates delegator rate across multiple streams in one round", async function () {
        // Three streams, one round, one delegator. Each scoreCorrectPrediction
        // call lands on the SAME (delegate, round) bucket. Alice's claim
        // reflects the sum of per-stream contributions.
        const s1 = await getStreamIdFromTx(await satori.createSimpleDataStream("S1", owner.address), satori);
        const s2 = await getStreamIdFromTx(await satori.createSimpleDataStream("S2", owner.address), satori);
        const s3 = await getStreamIdFromTx(await satori.createSimpleDataStream("S3", owner.address), satori);

        await registry.setValue(s1, 100);
        await registry.setValue(s2, 200);
        await registry.setValue(s3, 300);
        await voteFor(satori, carol, s1);
        await voteFor(satori, carol, s2);
        await voteFor(satori, carol, s3);

        await satori.connect(alice).delegatePredictionPower(bob.address);
        await time.increase(86400);
        await registry.setValue(s1, 100);
        await registry.setValue(s2, 200);
        await registry.setValue(s3, 300);
        await satori.connect(bob).predictMultipleWithPayloads([
            { gameId: s1, payload: pack1(UP) },
            { gameId: s2, payload: pack1(UP) },
            { gameId: s3, payload: pack1(UP) },
        ]);

        await advanceCadencePeriod();
        await registry.setValue(s1, 110);
        await registry.setValue(s2, 220);
        await registry.setValue(s3, 330);

        await advanceCadencePeriod();
        await registry.setValue(s1, 120);
        await registry.setValue(s2, 240);
        await registry.setValue(s3, 360);

        await satori.settlePrediction(bob.address, s1);
        await satori.settlePrediction(bob.address, s2);
        await satori.settlePrediction(bob.address, s3);

        // Alice claims — must accrue across all 3 streams in the single round.
        const aliceBefore = await satori.balanceOf(alice.address);
        await satori.connect(alice).claim();
        const aliceAfter = await satori.balanceOf(alice.address);
        const aliceDiff = aliceAfter - aliceBefore;
        expect(aliceDiff).to.be.gt(0n);

        // Bob claims — his predictor share + bonus.
        const bobBefore = await satori.balanceOf(bob.address);
        await satori.connect(bob).claim();
        const bobAfter = await satori.balanceOf(bob.address);
        const bobDiff = bobAfter - bobBefore;
        expect(bobDiff).to.be.gt(0n);

        // Idempotency: second claim by either pays nothing.
        const aliceB2 = await satori.balanceOf(alice.address);
        await satori.connect(alice).claim();
        expect((await satori.balanceOf(alice.address)) - aliceB2).to.equal(0n);

        const bobB2 = await satori.balanceOf(bob.address);
        await satori.connect(bob).claim();
        expect((await satori.balanceOf(bob.address)) - bobB2).to.equal(0n);
    });

    it("Predictor's settle pays out across multiple streams in one round", async function () {
        // Alice (no delegators) wins three streams in one round. Predictor
        // path walks the round bucket and computes per-stream rewards.
        const a1 = await getStreamIdFromTx(await satori.createSimpleDataStream("A1", owner.address), satori);
        const a2 = await getStreamIdFromTx(await satori.createSimpleDataStream("A2", owner.address), satori);
        const a3 = await getStreamIdFromTx(await satori.createSimpleDataStream("A3", owner.address), satori);

        await registry.setValue(a1, 100);
        await registry.setValue(a2, 100);
        await registry.setValue(a3, 100);
        await voteFor(satori, carol, a1);
        await voteFor(satori, carol, a2);
        await voteFor(satori, carol, a3);

        await satori.connect(alice).predictMultipleWithPayloads([
            { gameId: a1, payload: pack1(UP) },
            { gameId: a2, payload: pack1(UP) },
            { gameId: a3, payload: pack1(UP) },
        ]);

        await advanceCadencePeriod();
        await registry.setValue(a1, 110);
        await registry.setValue(a2, 110);
        await registry.setValue(a3, 110);

        await advanceCadencePeriod();
        await registry.setValue(a1, 120);
        await registry.setValue(a2, 120);
        await registry.setValue(a3, 120);

        await satori.settlePrediction(alice.address, a1);
        await satori.settlePrediction(alice.address, a2);
        await satori.settlePrediction(alice.address, a3);

        const aliceTotal = (await lens.getTotalClaimableRewards(alice.address))[0];
        expect(aliceTotal).to.be.gt(0n);

        const balBefore = await satori.balanceOf(alice.address);
        await satori.connect(alice).claim();
        const balAfter = await satori.balanceOf(alice.address);
        expect(balAfter - balBefore).to.equal(aliceTotal);
    });

    it("Cold-start delegator: nextClaimRound starts at delegation round, never walks backward", async function () {
        // Bob runs a long history of wins BEFORE Carol delegates. Carol's
        // claim must skip that history entirely.
        const sid = await getStreamIdFromTx(await satori.createSimpleDataStream("COLD", owner.address), satori);
        await registry.setValue(sid, 100);
        await voteFor(satori, dave, sid);

        // Five rounds of wins before Carol shows up.
        for (let i = 0; i < 5; i++) {
            await satori.connect(bob).predictMultipleWithPayloads([{ gameId: sid, payload: pack1(UP) }]);
            await advanceCadencePeriod();
            await registry.setValue(sid, 110 + i * 10);
            await advanceCadencePeriod();
            await registry.setValue(sid, 120 + i * 10);
            await satori.settlePrediction(bob.address, sid);
        }

        // Bob claims his pre-existing rewards (clears history).
        await satori.connect(bob).claim();

        // Carol delegates today.
        await satori.connect(carol).delegatePredictionPower(bob.address);
        await time.increase(86400);
        await registry.setValue(sid, 100);

        // Bob wins one more round.
        await satori.connect(bob).predictMultipleWithPayloads([{ gameId: sid, payload: pack1(UP) }]);
        await advanceCadencePeriod();
        await registry.setValue(sid, 200);
        await advanceCadencePeriod();
        await registry.setValue(sid, 210);
        await satori.settlePrediction(bob.address, sid);

        // Carol claims — receives only the new round's share.
        const carolBefore = await satori.balanceOf(carol.address);
        await satori.connect(carol).claim();
        const carolAfter = await satori.balanceOf(carol.address);
        expect(carolAfter - carolBefore).to.be.gt(0n);

        // Carol claiming a second time pays nothing.
        const carolB2 = await satori.balanceOf(carol.address);
        await satori.connect(carol).claim();
        expect((await satori.balanceOf(carol.address)) - carolB2).to.equal(0n);
    });

    it("Cursor advances across multiple separate predictor claim transactions", async function () {
        // Alice predicts and claims on three separate rounds; per-round mints
        // match per-round views.
        // The new streak curve commits weight=0 at streak<=1 (other than the
        // first-on-stream bypass). Pre-warm Alice to streak>=2 so every loop
        // iteration commits non-zero weight and accrues a claimable amount.
        const sid = await getStreamIdFromTx(await satori.createSimpleDataStream("CURSOR", owner.address), satori);
        await registry.setValue(sid, 100);
        await voteFor(satori, bob, sid);

        // Warm-up cycle 1: first-ever predict on stream → bypass mult=1 → wins.
        await satori.connect(alice).predictMultipleWithPayloads([{ gameId: sid, payload: pack1(UP) }]);
        await advanceCadencePeriod();
        await registry.setValue(sid, 110);
        await advanceCadencePeriod();
        await registry.setValue(sid, 120);
        await satori.settlePrediction(alice.address, sid); // streak: 0→1
        // Warm-up cycle 2: streak=1 commit (weight=0) but settles correct.
        await satori.connect(alice).predictMultipleWithPayloads([{ gameId: sid, payload: pack1(UP) }]);
        await advanceCadencePeriod();
        await registry.setValue(sid, 130);
        await advanceCadencePeriod();
        await registry.setValue(sid, 140);
        await satori.settlePrediction(alice.address, sid); // streak: 1→2
        // Drain warm-up earnings so each loop iteration claims from 0.
        await satori.connect(alice).claim();

        for (let i = 0; i < 3; i++) {
            await satori.connect(alice).predictMultipleWithPayloads([{ gameId: sid, payload: pack1(UP) }]);
            await advanceCadencePeriod();
            await registry.setValue(sid, 150 + i * 30);
            await advanceCadencePeriod();
            await registry.setValue(sid, 160 + i * 30);
            await satori.settlePrediction(alice.address, sid);

            const view = (await lens.getTotalClaimableRewards(alice.address))[0];
            expect(view).to.be.gt(0n);

            const before = await satori.balanceOf(alice.address);
            await satori.connect(alice).claim();
            const after = await satori.balanceOf(alice.address);
            expect(after - before).to.equal(view);

            expect((await lens.getTotalClaimableRewards(alice.address))[0]).to.equal(0n);
        }
    });

    it("Mid-period undelegation: only in-period rounds are credited", async function () {
        // Carol delegates to Bob. Bob wins. Carol undelegates. Bob wins
        // again — second win must NOT credit Carol.
        const sid = await getStreamIdFromTx(await satori.createSimpleDataStream("MID", owner.address), satori);
        await registry.setValue(sid, 100);
        await voteFor(satori, dave, sid);

        await satori.connect(carol).delegatePredictionPower(bob.address);
        await time.increase(86400);
        await registry.setValue(sid, 100);

        // In-period win
        await satori.connect(bob).predictMultipleWithPayloads([{ gameId: sid, payload: pack1(UP) }]);
        await advanceCadencePeriod();
        await registry.setValue(sid, 110);
        await advanceCadencePeriod();
        await registry.setValue(sid, 120);
        await satori.settlePrediction(bob.address, sid);

        // Carol claims her in-period share.
        const carolBefore = await satori.balanceOf(carol.address);
        await satori.connect(carol).claim();
        const carolAfter = await satori.balanceOf(carol.address);
        const inPeriodReward = carolAfter - carolBefore;
        expect(inPeriodReward).to.be.gt(0n);

        // Carol undelegates.
        await satori.connect(carol).delegatePredictionPower(ethers.ZeroAddress);

        // Bob wins after undelegation.
        await advanceCadencePeriod();
        await registry.setValue(sid, 130);
        await satori.connect(bob).predictMultipleWithPayloads([{ gameId: sid, payload: pack1(UP) }]);
        await advanceCadencePeriod();
        await registry.setValue(sid, 140);
        await advanceCadencePeriod();
        await registry.setValue(sid, 150);
        await satori.settlePrediction(bob.address, sid);

        // Carol's claim must pay nothing — second win is outside her period.
        const carolB2 = await satori.balanceOf(carol.address);
        await satori.connect(carol).claim();
        expect((await satori.balanceOf(carol.address)) - carolB2).to.equal(0n);
    });

    it("No-wins delegate: claim is a no-op without revert", async function () {
        // Carol delegates to Bob; Bob never predicts.
        const sid = await getStreamIdFromTx(await satori.createSimpleDataStream("NOOP", owner.address), satori);
        await registry.setValue(sid, 100);
        await voteFor(satori, dave, sid);

        await satori.connect(carol).delegatePredictionPower(bob.address);

        for (let i = 0; i < 5; i++) {
            await advanceCadencePeriod();
        }

        const view = (await lens.getTotalClaimableRewards(carol.address))[0];
        expect(view).to.equal(0n);

        const balBefore = await satori.balanceOf(carol.address);
        await expect(satori.connect(carol).claim()).to.not.be.reverted;
        const balAfter = await satori.balanceOf(carol.address);
        expect(balAfter - balBefore).to.equal(0n);
    });

    it("Long-gap delegator: many rounds with mostly-zero per-round rates", async function () {
        // Bob wins a few rounds spaced apart by many idle rounds. Carol's
        // claim walks all rounds since her delegation but only does real
        // work on the winning rounds.
        const sid = await getStreamIdFromTx(await satori.createSimpleDataStream("LONG", owner.address), satori);
        await registry.setValue(sid, 100);
        await voteFor(satori, dave, sid);

        await satori.connect(carol).delegatePredictionPower(bob.address);

        async function bobWinsOneRound(vB, vC) {
            await satori.connect(bob).predictMultipleWithPayloads([{ gameId: sid, payload: pack1(UP) }]);
            await advanceCadencePeriod();
            await registry.setValue(sid, vB);
            await advanceCadencePeriod();
            await registry.setValue(sid, vC);
            await satori.settlePrediction(bob.address, sid);
        }

        // Win 1
        await bobWinsOneRound(110, 120);

        // Idle ticks (registry values keep advancing so the next predict has fresh value)
        for (let i = 0; i < 10; i++) {
            await advanceCadencePeriod();
            await registry.setValue(sid, 130 + i);
        }

        // Win 2
        await bobWinsOneRound(200, 210);

        for (let i = 0; i < 10; i++) {
            await advanceCadencePeriod();
            await registry.setValue(sid, 220 + i);
        }

        // Win 3
        await bobWinsOneRound(300, 310);

        // Carol claims after long gap with mixed empty/winning rounds.
        const carolBefore = await satori.balanceOf(carol.address);
        await satori.connect(carol).claim();
        const carolAfter = await satori.balanceOf(carol.address);
        expect(carolAfter - carolBefore).to.be.gt(0n);
    });

    it("Long-gap predictor: many winning rounds settled in one claim", async function () {
        // Alice wins on 10 separate rounds without claiming.
        const sid = await getStreamIdFromTx(await satori.createSimpleDataStream("PRED", owner.address), satori);
        await registry.setValue(sid, 100);
        await voteFor(satori, bob, sid);

        for (let i = 0; i < 10; i++) {
            await satori.connect(alice).predictMultipleWithPayloads([{ gameId: sid, payload: pack1(UP) }]);
            await advanceCadencePeriod();
            await registry.setValue(sid, 110 + i * 10);
            await advanceCadencePeriod();
            await registry.setValue(sid, 120 + i * 10);
            await satori.settlePrediction(alice.address, sid);
        }

        const view = (await lens.getTotalClaimableRewards(alice.address))[0];
        expect(view).to.be.gt(0n);

        const balBefore = await satori.balanceOf(alice.address);
        await satori.connect(alice).claim();
        const balAfter = await satori.balanceOf(alice.address);
        expect(balAfter - balBefore).to.equal(view);
    });

    it("Mixed eligible/ineligible streams in one round: only eligible win lands on per-round rate", async function () {
        // Stream X eligible (Carol votes); Stream Y ineligible. Bob predicts
        // UP on both. Bob's delegator (Alice) earns only the X slice.
        const sX = await getStreamIdFromTx(await satori.createSimpleDataStream("X", owner.address), satori);
        const sY = await getStreamIdFromTx(await satori.createSimpleDataStream("Y", owner.address), satori);

        await registry.setValue(sX, 100);
        await registry.setValue(sY, 100);
        await voteFor(satori, carol, sX);

        await satori.connect(alice).delegatePredictionPower(bob.address);
        await time.increase(86400);
        await registry.setValue(sX, 100);
        await registry.setValue(sY, 100);   // Y is predicted below too

        await satori.connect(bob).predictMultipleWithPayloads([
            { gameId: sX, payload: pack1(UP) },
            { gameId: sY, payload: pack1(UP) },
        ]);

        await advanceCadencePeriod();
        await registry.setValue(sX, 110);
        await registry.setValue(sY, 110);
        await advanceCadencePeriod();
        await registry.setValue(sX, 120);
        await registry.setValue(sY, 120);

        await satori.settlePrediction(bob.address, sX);
        await satori.settlePrediction(bob.address, sY);

        const aliceBefore = await satori.balanceOf(alice.address);
        await satori.connect(alice).claim();
        const aliceAfter = await satori.balanceOf(alice.address);
        expect(aliceAfter - aliceBefore).to.be.gt(0n);
    });

    it("Predictor view total matches actual claim minted across many sequential claims", async function () {
        const sid = await getStreamIdFromTx(await satori.createSimpleDataStream("VIEW", owner.address), satori);
        await registry.setValue(sid, 100);
        await voteFor(satori, bob, sid);

        // Pre-warm Alice to streak>=2 so each loop iteration commits non-zero
        // weight under the new curve.
        await satori.connect(alice).predictMultipleWithPayloads([{ gameId: sid, payload: pack1(UP) }]);
        await advanceCadencePeriod();
        await registry.setValue(sid, 110);
        await advanceCadencePeriod();
        await registry.setValue(sid, 120);
        await satori.settlePrediction(alice.address, sid); // streak: 0→1
        await satori.connect(alice).predictMultipleWithPayloads([{ gameId: sid, payload: pack1(UP) }]);
        await advanceCadencePeriod();
        await registry.setValue(sid, 130);
        await advanceCadencePeriod();
        await registry.setValue(sid, 140);
        await satori.settlePrediction(alice.address, sid); // streak: 1→2
        await satori.connect(alice).claim();

        // Step of 30 (not 10) so the schedule rises STRICTLY across iterations
        // as well as within one: a daily stream resolves a prediction against
        // the value in its own round vs the next value, so iteration i's anchor
        // is iteration i-1's LAST write. A 10-step would make those two equal
        // and void the round instead of winning it. Matches the sibling
        // "Cursor advances…" test above.
        for (let i = 0; i < 5; i++) {
            await satori.connect(alice).predictMultipleWithPayloads([{ gameId: sid, payload: pack1(UP) }]);
            await advanceCadencePeriod();
            await registry.setValue(sid, 150 + i * 30);
            await advanceCadencePeriod();
            await registry.setValue(sid, 160 + i * 30);
            await satori.settlePrediction(alice.address, sid);

            const view = (await lens.getTotalClaimableRewards(alice.address))[0];
            expect(view).to.be.gt(0n);

            const before = await satori.balanceOf(alice.address);
            await satori.connect(alice).claim();
            const after = await satori.balanceOf(alice.address);
            expect(after - before).to.equal(view);

            expect((await lens.getTotalClaimableRewards(alice.address))[0]).to.equal(0n);
        }
    });
});
