const { expect } = require("chai");
const { deploySatoriFixture, pack1, VOTE } = require("./fixtures");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const UP = 1;
const DOWN = 2;

async function advanceRound() {
    const currentTime = await time.latest();
    const nextMidnight = Math.floor(currentTime / 86400) * 86400 + 86400;
    await time.increaseTo(nextMidnight + 1);
}

// The stream below is the 2-arg createSimpleDataStream — what a public caller
// now gets: daily cadence (1440 minutes). Every "day" in this file is one
// cadence period. The ring is HOUR-keyed and 768 slots deep, so the eviction
// boundaries below are counted in WRITES (768+ writes to roll an anchor out)
// and the registry views take an HOUR — a round-r prediction's window is
// queried with the round's last hour, r*24+23.
//
// Scoring on a daily stream is the ABC band (cadence 1440, default target
// 1440 → tgt < 24*cad): the anchor is the standing value at the prediction's
// hour and B/C are the first TWO entries after it. The later ticks are still
// deliberately steered the WRONG way, so a scorer that read the recent window
// instead of the real post-anchor entries would flip every outcome asserted
// here. The getFirstTwoValuesAfter assertions are registry-view facts.
const CADENCE_ROUNDS = 2;
async function advanceCadencePeriod() {
    for (let i = 0; i < CADENCE_ROUNDS; i++) await advanceRound();
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

describe("Intermittent prediction — scoring over the 768-slot history", function () {
    this.timeout(2400000); // the eviction tests write 768+ daily values
    let satori, voting, rewards, bounties, registry, lens;
    let owner, alice, bob;
    let streamId;

    beforeEach(async function () {
        const fix = await deploySatoriFixture();
        ({ satori, voting, rewards, registry, lens } = fix);
        owner = fix.owner;
        [, alice, bob] = fix.signers;

        // One stream, weighted by Bob burning 10 SATORI (keeps Alice's balance
        // free for predicting — a vote now SPENDS, so the voter is deliberately
        // not the predictor)
        const tx = await satori.createSimpleDataStream("BTC/USD", owner.address);
        streamId = await getStreamIdFromTx(tx, registry);

        await satori.transfer(alice.address, ethers.parseEther("100"));
        await satori.transfer(bob.address, ethers.parseEther("100"));
        await satori.connect(bob).vote(streamId, VOTE);

        await advanceCadencePeriod();
        await registry.setValue(streamId, 1000);
    });

    it("Scores a prediction against the REAL B/C even after many later ticks overwrite the 3-slot window", async function () {
        // Alice predicts UP on day 1. The "real" B and C are tomorrow and the day after.
        await satori.connect(alice).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(UP) }]);
        const predictionRound = await satori.getCurrentRound();

        // Day 2: real B = 1100 (stream went up)
        await advanceCadencePeriod();
        await registry.setValue(streamId, 1100);

        // Day 3: real C = 1200 (stream went up again → UP is correct)
        await advanceCadencePeriod();
        await registry.setValue(streamId, 1200);

        // Now burn through many more updates WITHOUT settling. Each of these
        // pushes B and C further away from the "last 3" window. The stream
        // movement after C is deliberately DOWN so that if scoring accidentally
        // used a later-window comparison, Alice would LOSE instead of WIN.
        const laterValues = [900, 800, 700, 600, 500, 400, 300, 200, 150];
        for (const v of laterValues) {
            await advanceCadencePeriod();
            await registry.setValue(streamId, v);
        }

        // Sanity: the 3-slot legacy view no longer contains B (1100) or C (1200).
        const [recentValues] = await registry.getRecentHistory(streamId);
        const recentAsNumbers = recentValues.map(v => Number(v));
        expect(recentAsNumbers).to.not.include(1100);
        expect(recentAsNumbers).to.not.include(1200);

        // But the registry still remembers the real B and C in its 768-slot history.
        // The ring is hour-keyed: query with the prediction round's LAST hour.
        const [vB, vC, found] = await registry.getFirstTwoValuesAfter(streamId, predictionRound * 24n + 23n);
        expect(found).to.equal(true);
        expect(vB).to.equal(1100n);
        expect(vC).to.equal(1200n);

        // Scoring should match: Alice wins — the post value written right after her
        // round (1100) is above the anchor at her round (1000), direction UP.
        await satori.settlePrediction(alice.address, streamId);

        const pred = await satori.predictions(alice.address, streamId, predictionRound);
        expect(pred.scored).to.equal(true);
        expect(await satori.streaks(alice.address, streamId)).to.equal(1);
    });

    it("Scores a DOWN prediction correctly after the window has rolled past B/C", async function () {
        // Alice predicts DOWN on day 1. Real B/C must trend down for her to win.
        await satori.connect(alice).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(DOWN) }]);
        const predictionRound = await satori.getCurrentRound();

        // Day 2: real B = 900
        await advanceCadencePeriod();
        await registry.setValue(streamId, 900);

        // Day 3: real C = 800 (DOWN correct)
        await advanceCadencePeriod();
        await registry.setValue(streamId, 800);

        // Bury B and C by updating many more times. Trend upward afterwards so
        // that a late 3-slot read would score her wrongly.
        for (const v of [850, 900, 950, 1000, 1050, 1100]) {
            await advanceCadencePeriod();
            await registry.setValue(streamId, v);
        }

        await satori.settlePrediction(alice.address, streamId);

        const pred = await satori.predictions(alice.address, streamId, predictionRound);
        expect(pred.scored).to.equal(true);
        expect(await satori.streaks(alice.address, streamId)).to.equal(1);
    });

    it("Claims the correct reward after a long intermittent gap", async function () {
        // Predict, let B and C happen, then wait a long time before claiming.
        await satori.connect(alice).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(UP) }]);

        await advanceCadencePeriod();
        await registry.setValue(streamId, 1100); // B

        await advanceCadencePeriod();
        await registry.setValue(streamId, 1200); // C — UP correct

        // Simulate abandonment: many ticks after C with no settle and no claim.
        for (const v of [1150, 1100, 1050, 1000, 950, 900, 850, 800]) {
            await advanceCadencePeriod();
            await registry.setValue(streamId, v);
        }

        // Finally, settle and claim. The claimed amount should be positive.
        await satori.settlePrediction(alice.address, streamId);

        const pending = (await lens.getTotalClaimableRewards(alice.address))[0];
        expect(pending).to.be.gt(0n);

        const before = await satori.balanceOf(alice.address);
        await satori.connect(alice).claim();
        const after = await satori.balanceOf(alice.address);
        expect(after - before).to.equal(pending);
    });

    it("Intermittent predict-then-predict-much-later still scores the earlier one against real B/C", async function () {
        // Day 1: Alice predicts UP.
        await satori.connect(alice).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(UP) }]);
        const firstPredDate = await satori.getCurrentRound();

        // Day 2: B = 1100
        await advanceCadencePeriod();
        await registry.setValue(streamId, 1100);
        // Day 3: C = 1200 (UP wins)
        await advanceCadencePeriod();
        await registry.setValue(streamId, 1200);

        // Alice disappears. Stream keeps ticking for many days.
        for (let i = 0; i < 10; i++) {
            await advanceCadencePeriod();
            await registry.setValue(streamId, 1300 + i * 10);
        }

        // Alice comes back and predicts again — this should implicitly settle
        // her earlier prediction against the REAL B and C (1100 and 1200).
        await satori.connect(alice).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(UP) }]);

        const firstPred = await satori.predictions(alice.address, streamId, firstPredDate);
        expect(firstPred.scored).to.equal(true);
        expect(await satori.streaks(alice.address, streamId)).to.be.gte(1);
    });

    it("Returns false from getFirstTwoValuesAfter when the anchor has been evicted", async function () {
        // Day 1: Alice predicts.
        await satori.connect(alice).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(UP) }]);
        const predictionRound = await satori.getCurrentRound();

        // Push the buffer far enough that nothing at or before the prediction's
        // hour remains. Setup wrote one entry at day 1 (value 1000). Writing 769
        // more fills the 768 slots with days 2..770, so day 1 is evicted.
        for (let i = 0; i < 769; i++) {
            await advanceCadencePeriod();
            await registry.setValue(streamId, 2000 + i);
        }

        // Helper must refuse to score with anchorEvicted=true: no entry at or
        // before the prediction round's last hour survives, so the first two
        // retained entries are NOT the true B/C.
        const [vB, vC, found, anchorEvicted] = await registry.getFirstTwoValuesAfter(streamId, predictionRound * 24n + 23n);
        expect(found).to.equal(false);
        expect(anchorEvicted).to.equal(true);
        expect(vB).to.equal(0n);
        expect(vC).to.equal(0n);

        // Stale-anchor hard-finalizes the slot: scored = true so the
        // per-user pending counter drops and the claim/settle cursors
        // can advance. Streak preserved (no win, no loss).
        await satori.settlePrediction(alice.address, streamId);
        const pred = await satori.predictions(alice.address, streamId, predictionRound);
        expect(pred.scored).to.equal(true);
    });

    it("Boundary: 767 post-prediction updates — anchor still retained, real B/C returned", async function () {
        // Setup wrote day-1: 1000. Alice predicts on day 1. We then write exactly
        // 767 more entries (days 2..768), for 768 total — the buffer is full but
        // the day-1 anchor has NOT been evicted yet.
        await satori.connect(alice).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(UP) }]);
        const predictionRound = await satori.getCurrentRound();

        for (let i = 1; i <= 767; i++) {
            await advanceCadencePeriod();
            await registry.setValue(streamId, 10000 + i);
        }

        // Helper must return the REAL first two post-prediction values.
        const [vB, vC, found] = await registry.getFirstTwoValuesAfter(streamId, predictionRound * 24n + 23n);
        expect(found).to.equal(true);
        expect(vB).to.equal(10001n);
        expect(vC).to.equal(10002n);

        // And scoring uses the real post-anchor entry: 10001 > the anchor 1000
        // at the predict round → UP wins (never the collapsing recent window).
        await satori.settlePrediction(alice.address, streamId);
        const pred = await satori.predictions(alice.address, streamId, predictionRound);
        expect(pred.scored).to.equal(true);
        expect(await satori.streaks(alice.address, streamId)).to.equal(1);
    });

    it("Boundary: 768 post-prediction updates — anchor evicted, helper returns false", async function () {
        // Setup wrote day-1: 1000. Alice predicts on day 1. Writing 768 more entries
        // (days 2..769) pushes the day-1 anchor out of the 768-slot buffer. Even though
        // the true B (day 2, 10001) is still present, we cannot prove it is the first
        // post-prediction tick — so the fix returns found=false rather than silently
        // substituting. This is the conservative k=768 sacrifice called out in the
        // bug fix writeup.
        await satori.connect(alice).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(UP) }]);
        const predictionRound = await satori.getCurrentRound();

        for (let i = 1; i <= 768; i++) {
            await advanceCadencePeriod();
            await registry.setValue(streamId, 10000 + i);
        }

        const [vB, vC, found, anchorEvicted] = await registry.getFirstTwoValuesAfter(streamId, predictionRound * 24n + 23n);
        expect(found).to.equal(false);
        expect(anchorEvicted).to.equal(true);
        expect(vB).to.equal(0n);
        expect(vC).to.equal(0n);

        // Stale-anchor hard-finalizes: scored = true, streak preserved.
        await satori.settlePrediction(alice.address, streamId);
        const pred = await satori.predictions(alice.address, streamId, predictionRound);
        expect(pred.scored).to.equal(true);
    });
});
