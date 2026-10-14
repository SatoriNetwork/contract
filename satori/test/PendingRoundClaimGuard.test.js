/**
 * PendingRoundClaimGuard.test.js
 *
 * Two related cursor-vs-pending-state bugs surfaced while reviewing the
 * claim path:
 *
 *   (A) Predictor side — multi-stream same-round orphan. The deep #3
 *       refactor dedupes _predictorWinRounds by round. If a user wins
 *       multiple streams in the same round but the streams are scored at
 *       different times (lazy A-B-C scoring is per-stream), and the user
 *       claims between the two scorings, _settleRewards advances the
 *       round-cursor past R. The second scoreCorrectPrediction call
 *       appends a new (stream, direction) to _predictorWinsInRound[R] but
 *       does NOT re-push R to _predictorWinRounds (because
 *       _predictorWinRoundIndex[R] is non-zero). Result: the second
 *       stream's win is permanently orphaned.
 *
 *   (B) Delegator side — pending-rate cursor advance.
 *       _accrueDelegatorRewards walks rounds by number from nextClaimRound
 *       to nowRound-1 and unconditionally bumps nextClaimRound = to + 1,
 *       regardless of whether the delegate's _delegatorRewardRatePerRound
 *       was populated. If the delegate has pending (unscored) predictions
 *       when the delegator claims, those rounds have rate=0 at walk time
 *       and are skipped over forever — even if the predictions later
 *       settle as correct and the rate is populated.
 */

const { expect } = require("chai");
const { deploySatoriFixture, pack1, voteFor, warmUpLoyalty } = require("./fixtures");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const UP = 1;

// Explicit 3-arg overload. Every stream below is created with cadence 1440
// minutes, i.e. writable every 24h round: the rounds these tests step through
// are CLAIM-CURSOR rounds, not stream write windows, so the every-round
// rhythm is preserved.
const SIMPLE3 = "createSimpleDataStream(string,address,uint24)";

async function advanceRound() {
    const currentTime = await time.latest();
    const nextMidnight = Math.floor(currentTime / 86400) * 86400 + 86400;
    await time.increaseTo(nextMidnight + 1);
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

describe("Pending-round claim cursor guards", function () {
    let satori, voting, rewards, bounties, registry;
    let owner, alice, bob, carol, dave, platform;

    beforeEach(async function () {
        [owner, alice, bob, carol, dave, platform] = await ethers.getSigners();
        const fix = await deploySatoriFixture();
        ({ satori, voting, rewards, registry } = fix);

        await satori.transfer(alice.address, ethers.parseEther("100"));
        await satori.transfer(bob.address, ethers.parseEther("100"));
        await satori.transfer(carol.address, ethers.parseEther("100"));
        await satori.transfer(dave.address, ethers.parseEther("100"));

        await advanceRound();
    });

    it("(A) predictor: scoreCorrectPrediction after same-round claim must not orphan the new win", async function () {
        // Two eligible streams. Alice predicts on both in round R.
        // Score s1 alone, claim (cursor advances past R), then score s2.
        // Without a fix, s2's win is silently orphaned.
        const s1 = await getStreamIdFromTx(
            await satori.connect(owner)[SIMPLE3]("S1", owner.address, 1440), satori);
        const s2 = await getStreamIdFromTx(
            await satori.connect(owner)[SIMPLE3]("S2", owner.address, 1440), satori);

        await registry.setValue(s1, 100);
        await registry.setValue(s2, 100);
        await voteFor(satori, carol, s1);
        await voteFor(satori, dave, s2);

        await satori.connect(alice).predictMultipleWithPayloads([
            { gameId: s1, payload: pack1(UP) },
            { gameId: s2, payload: pack1(UP) },
        ]);

        await advanceRound();
        await registry.setValue(s1, 110);
        await registry.setValue(s2, 110);

        await advanceRound();
        await registry.setValue(s1, 120);
        await registry.setValue(s2, 120);

        // Score only s1 — Alice's round-R win on s1 is recorded; s2's
        // pending prediction is untouched.
        await satori.settlePrediction(alice.address, s1);

        // First claim — settles the (s1, R) row. _nextSettleRoundIndex
        // advances past R's index in _predictorWinRounds.
        const balBefore1 = await satori.balanceOf(alice.address);
        await satori.connect(alice).claim();
        const s1Reward = (await satori.balanceOf(alice.address)) - balBefore1;
        expect(s1Reward).to.be.gt(0n);

        // Now score s2. scoreCorrectPrediction sees _predictorWinRoundIndex
        // [alice][R] != 0 and skips re-pushing R; only appends (s2, UP) to
        // _predictorWinsInRound[alice][R].
        await satori.settlePrediction(alice.address, s2);

        // Second claim — should pay s2's reward. With the bug, the cursor
        // is past R's index so the round is never walked again.
        const balBefore2 = await satori.balanceOf(alice.address);
        await satori.connect(alice).claim();
        const s2Reward = (await satori.balanceOf(alice.address)) - balBefore2;
        expect(s2Reward).to.be.gt(0n);
    });

    it("(B) delegator: claim while delegate's prediction is pending must not skip the round", async function () {
        // Carol delegates to Bob. Bob predicts on round D. Before Bob's
        // prediction is scored, Carol claims at D+2. Walk advances cursor
        // past D. Then Bob's prediction settles. Carol claims again. With
        // the bug, round D's reward is permanently skipped for Carol.
        const sid = await getStreamIdFromTx(
            await satori.connect(owner)[SIMPLE3]("DELEGATED", owner.address, 1440), satori);
        await registry.setValue(sid, 100);
        await voteFor(satori, dave, sid);

        await satori.connect(carol).delegatePredictionPower(bob.address);
        // Delegator weight is capital x loyalty and a fresh delegation starts at
        // L = 0, so the share measured below reads zero without a warm-up.
        await warmUpLoyalty(satori, registry, null, bob, [carol], platform, sid);
        await registry.setValue(sid, 100);

        // Bob predicts on round D
        await satori.connect(bob).predictMultipleWithPayloads([{ gameId: sid, payload: pack1(UP) }]);

        // Round D+1: stream value B
        await advanceRound();
        await registry.setValue(sid, 110);

        // Round D+2: stream value C (prediction is now scoreable but NOT
        // yet scored — settlePrediction has not been called)
        await advanceRound();
        await registry.setValue(sid, 120);

        // Carol claims at D+2 BEFORE Bob's prediction is scored.
        // _settleRewards(Bob) is a no-op (his _predictorWinRounds is empty).
        // Carol's loop walks rounds D and D+1, both rates 0. Cursor → D+2.
        const carolBeforeFirst = await satori.balanceOf(carol.address);
        await satori.connect(carol).claim();
        expect(
            (await satori.balanceOf(carol.address)) - carolBeforeFirst
        ).to.equal(0n);

        // Now settle Bob's round-D prediction. _predictorWinRounds[Bob]
        // gets round D appended, but the per-round rate is still 0 because
        // Bob's _settleRewards has not run (no claim, no delegator claim
        // since the recording).
        await satori.settlePrediction(bob.address, sid);

        // Advance another round so Carol's `to = nowRound - 1` includes
        // some round AFTER D, but the loop walks from nextClaimRound = D+2.
        await advanceRound();
        await registry.setValue(sid, 130);

        // Carol claims again. Inside _accrueDelegatorRewards, _settleRewards
        // (Bob) NOW runs — it walks _predictorWinRounds[Bob] = [D] and
        // populates _delegatorRewardRatePerRound[Bob][D]. Carol's loop
        // walks from = D+2 to D+2 (current = D+3, to = D+2). Round D is
        // BEFORE `from`, so the populated rate is never multiplied through.
        const carolBeforeSecond = await satori.balanceOf(carol.address);
        await satori.connect(carol).claim();
        const carolReward = (await satori.balanceOf(carol.address)) - carolBeforeSecond;
        expect(carolReward).to.be.gt(0n);
    });
});
