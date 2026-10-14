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
        } catch {
            return false;
        }
    });
    if (!event) throw new Error("DataStreamCreated event not found");
    return satoriContract.interface.parseLog(event).args.streamId;
}

async function advanceRound() {
    const currentTime = await time.latest();
    const nextMidnight = Math.floor(currentTime / 86400) * 86400 + 86400;
    await time.increaseTo(nextMidnight + 1);
}

// The stream is created at 2880 minutes (two 24h rounds). A value may only be
// written once per CADENCE_ROUNDS rounds, and the scoring window is AB:
// anchor = the value AT the predict round, post = the FIRST value written
// after it. One post therefore resolves a prediction. (A 1440-minute stream
// would score ABC — not this file's point.)
const CADENCE_ROUNDS = 2;
async function advanceCadencePeriod() {
    for (let i = 0; i < CADENCE_ROUNDS; i++) await advanceRound();
}

describe("settlePrediction — public settle for orphaned predictions", function () {
    let satori, voting, rewards, bounties, registry;
    let owner, alice, bob, carol;
    let stream1;

    beforeEach(async function () {
        const fix = await deploySatoriFixture();
        ({ satori, voting, rewards, bounties, registry } = fix);
        [owner, alice, bob, carol] = fix.signers;

        // Create stream and make it eligible
        const tx = await satori["createSimpleDataStream(string,address,uint24)"]("Stream 1", owner.address, 2880);
        stream1 = await getStreamIdFromTx(tx, satori);

        await satori.transfer(alice.address, ethers.parseEther("100"));
        await satori.transfer(bob.address, ethers.parseEther("100"));
        await satori.transfer(carol.address, ethers.parseEther("100"));
        await voteFor(satori, alice, stream1); // burns 10, leaving 90 to predict with

        await advanceRound();
        await registry.setValue(stream1, 100);
    });

    it("Should be a safe no-op for non-existent streams", async function () {
        // Pending slots on deleted streams must remain drainable from outside,
        // so settlePrediction no longer gates on streamExists. With no
        // predictions on the slot, it's a harmless no-op.
        await expect(
            satori.settlePrediction(alice.address, 9999)
        ).to.not.be.reverted;
    });

    it("Should be a safe no-op when the user has no predictions on the stream", async function () {
        await expect(satori.settlePrediction(alice.address, stream1)).to.not.be.reverted;
    });

    it("Should settle an unscored prediction without the original predictor returning", async function () {
        // Alice predicts UP on day 1
        await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);
        const round1 = await satori.getCurrentRound();

        // One cadence period on: post = 150 > the anchor 100 (UP is correct)
        await advanceCadencePeriod();
        await registry.setValue(stream1, 150);

        // Before: slot is unscored
        let pred = await satori.predictions(alice.address, stream1, round1);
        expect(pred.scored).to.equal(false);

        // Carol (anyone) triggers the settle
        await satori.connect(carol).settlePrediction(alice.address, stream1);

        // After: slot is scored and Alice's streak ticked up
        pred = await satori.predictions(alice.address, stream1, round1);
        expect(pred.scored).to.equal(true);
        expect(await satori.streaks(alice.address, stream1)).to.equal(1);
    });

    it("Should rescue an orphan when the predictor has since delegated away", async function () {
        // Alice predicts UP on day 1
        await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);
        const round1 = await satori.getCurrentRound();

        // One cadence period on: post = 150 > the anchor 100 (UP correct)
        await advanceCadencePeriod();
        await registry.setValue(stream1, 150);

        // Alice delegates away — now blocked from predicting, so can't self-trigger
        await satori.connect(alice).delegatePredictionPower(bob.address);
        await expect(
            satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }])
        ).to.be.revertedWithCustomError(satori, "Delegated");

        // Anyone can settle her orphaned prediction
        await satori.connect(bob).settlePrediction(alice.address, stream1);

        const pred = await satori.predictions(alice.address, stream1, round1);
        expect(pred.scored).to.equal(true);
    });

    it("Should be idempotent — calling twice does not double-count", async function () {
        await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);
        const round1 = await satori.getCurrentRound();

        await advanceCadencePeriod();
        await registry.setValue(stream1, 150);

        await satori.connect(carol).settlePrediction(alice.address, stream1);
        const streakAfterFirst = await satori.streaks(alice.address, stream1);

        // Second call: slot is already scored, nothing to do
        await satori.connect(carol).settlePrediction(alice.address, stream1);
        const streakAfterSecond = await satori.streaks(alice.address, stream1);

        expect(streakAfterSecond).to.equal(streakAfterFirst);

        const pred = await satori.predictions(alice.address, stream1, round1);
        expect(pred.scored).to.equal(true);
    });
});
