const { expect } = require("chai");
const { deploySatoriFixture, pack1, voteFor } = require("./fixtures");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const UP = 1;

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

describe("Phantom-credit regression: closed delegation period must not earn endRound", function () {
    // BUG (pre-fix): when a delegator undelegates or switches BEFORE their
    // predictor predicts on day N, their period closes with endRound = N.
    // The pool subtraction is synchronous (the day-N rate denominator excludes
    // them), but the claim walk visited endRound inclusive AND _lookupBalanceAt
    // returns startBalance (no checkpoint at endRound). The closed period
    // multiplied startBalance by the day-N rate and credited the user — a
    // phantom share requiring extra mint to satisfy.
    //
    // FIX (option 2): walk excludes endRound for closed periods.

    const STAKE = ethers.parseEther("100");
    let satori, voting, rewards, bounties, registry;
    let owner, alice, dave, bob, eve;
    let streamId;

    beforeEach(async function () {
        const fix = await deploySatoriFixture();
        ({ satori, voting, rewards, registry, owner } = fix);
        [, alice, dave, bob, eve] = fix.signers;
        // Cadence-1440 (every-round) stream: the day-N / day-N+1 boundaries
        // this regression turns on are DELEGATION period boundaries, so the
        // stream must stay writable every round.
        const tx = await satori.connect(owner)["createSimpleDataStream(string,address,uint24)"]("BTC/USD", owner.address, 1440);
        streamId = await getStreamIdFromTx(tx, registry);
        await satori.transfer(alice.address, STAKE);
        await satori.transfer(dave.address, STAKE);
        await satori.transfer(eve.address, STAKE);
        await voteFor(satori, eve, streamId);
        await advanceRound();
    });

    it("undelegate before predictor predicts: closed period earns 0", async function () {
        // Alice and Dave both delegate to Bob on day N.
        await satori.connect(alice).delegatePredictionPower(bob.address);
        await satori.connect(dave).delegatePredictionPower(bob.address);
        await time.increase(86400);

        // Same day N: ALICE UNDELEGATES BEFORE BOB PREDICTS.
        await satori.connect(alice).delegatePredictionPower(ethers.ZeroAddress);

        // Bob predicts AFTER alice's undelegate. The rate snapshot at predict
        // time uses _delegatePowerForRate[bob] = dave's stake only.
        await registry.setValue(streamId, 100);
        await satori.connect(bob).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(UP) }]);

        // Advance and continue Bob's streak so day-N's prediction is scored
        // correct (UP value sequence).
        for (let i = 1; i <= 5; i++) {
            await advanceRound();
            await registry.setValue(streamId, 100 + i * 10);
            await satori.connect(bob).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(UP) }]);
        }
        await advanceRound();

        // Settle bob so rates populate for all his wins.
        await satori.connect(bob).claim();

        // Alice's only period (delegated to bob) is closed at endRound=N.
        // Pre-fix: walks day N inclusive, lookups startBalance, credits at
        // bob's day-N rate (sized for dave alone) -> phantom.
        // Post-fix: walk skips endRound -> 0.
        const aliceBefore = await satori.balanceOf(alice.address);
        await satori.connect(alice).claim();
        const aliceGain = (await satori.balanceOf(alice.address)) - aliceBefore;

        // Dave stayed delegated through bob's wins -> earns > 0.
        const daveBefore = await satori.balanceOf(dave.address);
        await satori.connect(dave).claim();
        const daveGain = (await satori.balanceOf(dave.address)) - daveBefore;

        expect(aliceGain).to.equal(0n, "alice was out of bob's pool before any of bob's predictions; should earn nothing");
        expect(daveGain).to.be.greaterThan(0n, "dave stayed delegated through bob's wins; should earn > 0");
    });

    it("switch before predictor predicts: closed period earns 0 from prior delegate", async function () {
        await satori.connect(alice).delegatePredictionPower(bob.address);
        await satori.connect(dave).delegatePredictionPower(bob.address);
        await time.increase(86400);

        // Alice switches to eve BEFORE bob predicts.
        await satori.connect(alice).delegatePredictionPower(eve.address);

        await registry.setValue(streamId, 100);
        await satori.connect(bob).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(UP) }]);

        for (let i = 1; i <= 5; i++) {
            await advanceRound();
            await registry.setValue(streamId, 100 + i * 10);
            await satori.connect(bob).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(UP) }]);
        }
        await advanceRound();

        await satori.connect(bob).claim();

        // Alice's bob-period is closed at endRound=N. Her eve-period is open
        // but eve never predicts, so eve has no rate to credit. Alice should
        // earn 0 either way.
        const aliceBefore = await satori.balanceOf(alice.address);
        await satori.connect(alice).claim();
        const aliceGain = (await satori.balanceOf(alice.address)) - aliceBefore;

        const daveBefore = await satori.balanceOf(dave.address);
        await satori.connect(dave).claim();
        const daveGain = (await satori.balanceOf(dave.address)) - daveBefore;

        expect(aliceGain).to.equal(0n, "alice's bob-period closed before bob predicted; eve never predicted; should earn nothing");
        expect(daveGain).to.be.greaterThan(0n, "dave stayed with bob through wins; should earn > 0");
    });
});
