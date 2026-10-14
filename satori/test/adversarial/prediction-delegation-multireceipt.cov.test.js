/**
 * adv_15_dependencies-wiring.test.js
 *
 * AUDIT FINDING (HIGH) — dependencies-wiring:
 *   "syncPredictionDelegation drops earlier same-round receipt from
 *    per-delegator checkpoint (pool vs Σ-effective divergence)"
 *   SatoriRewards.sol:syncPredictionDelegation lines 1731-1748
 *   (driven by Satori.sol:_update line 2017)
 *
 * Mechanism under test:
 *   When a prediction-delegator receives TWO separate token transfers in the
 *   SAME round, syncPredictionDelegation's `to`-side branch:
 *     - accumulates the delegate pool pending CORRECTLY (pend.amount += value
 *       on each receipt -> value1 + value2), but
 *     - the per-delegator activation checkpoint at cp(today+1) is computed as
 *       `_lookupBalanceAt(p, today) + value`. Because the only checkpoint sits
 *       at today+1 (> today), _lookupBalanceAt(today) keeps returning the
 *       PRE-receipt startBalance on BOTH receipts. The second receipt therefore
 *       OVERWRITES cp(today+1) with startBalance+value2, silently dropping
 *       value1.
 *
 *   Result: the rate denominator (pool) folds in startBalance+value1+value2
 *   (= 200), but the per-delegator walk reads only startBalance+value2 (= 150).
 *   For a SOLE delegator, the documented invariant `pool == Σ effective`
 *   (SatoriRewards.sol comment 1577-1578) requires her to receive the ENTIRE
 *   delegatorsShare. The bug under-credits her by value1's slice (orphaned,
 *   never minted).
 *
 * INTENDED behavior (asserted): a lone delegator whose effective stake is the
 *   whole pool receives the full delegatorsShare regardless of whether her
 *   100-token top-up arrived as ONE transfer or TWO same-round transfers.
 *   The two paths must pay the delegator identically.
 *
 * Ground truth: the control scenario uses a SINGLE 100-token receipt (no bug,
 *   per the contrast called out in the finding). Both scenarios produce an
 *   identical pool (startBalance 100 + 100 = 200) and identical predictor /
 *   round conditions, so the delegator's claimed reward MUST match.
 *
 * Harness: full-stack fixture (require("../fixtures")).
 */

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixtureNoFee, RAW_TOLERANCE, pack1, voteFor } = require("../fixtures");

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

// Runs the full delegate->topup->predict->settle->claim flow and returns the
// SATORI credited to the sole delegator (alice). `receipts` is an array of
// {from, amount} transfers into alice, all executed in the same round as the
// delegation. Pool = 100 (startBalance) + Σ amounts.
async function runScenario(ctx, receipts) {
    const { satori, registry, owner, alice, bob, eve } = ctx;

    // Every-round (1440-minute) stream: the subject is multi-receipt delegated
    // power accounting, so the stream must be writable every round to keep each
    // predict in-window.
    const sid = await getStreamIdFromTx(
        await satori["createSimpleDataStream(string,address,uint24)"]("S", owner.address, 1440), satori);
    await registry.setValue(sid, 100);
    // Burn-backed vote: eve burns VOTE (10) to give `sid` weight. She never
    // predicts, so the spend does not perturb the scenario being compared.
    await voteFor(satori, eve, sid);

    // Round R: alice delegates startBalance (100) to bob. Marks alice as a
    // participant so receipts into her fire syncPredictionDelegation's to-side.
    await satori.connect(alice).delegatePredictionPower(bob.address);

    // Same round R: the configured receipts into alice.
    for (const r of receipts) {
        await satori.connect(r.from).transfer(alice.address, r.amount);
    }

    // R+1: pending pool (100 + Σ amounts) activates.
    await advanceRound();
    await registry.setValue(sid, 100); // refresh so predict is in-window
    await satori.connect(bob).predictMultipleWithPayloads([{ gameId: sid, payload: pack1(UP) }]);

    await advanceRound();
    await registry.setValue(sid, 110); // UP correct
    await advanceRound();
    await registry.setValue(sid, 120);

    await satori.settlePrediction(bob.address, sid);

    const before = await satori.balanceOf(alice.address);
    await satori.connect(alice).claim();
    return (await satori.balanceOf(alice.address)) - before;
}

describe("ADV-15 dependencies-wiring: same-round double receipt into a delegator", function () {
    this.timeout(120000);

    it("two same-round receipts pay the sole delegator the SAME as one combined receipt", async function () {
        // ---- Control: ONE 100-token receipt (single-receipt path, no bug) ----
        let f = await deploySatoriFixtureNoFee();
        let ctx = {
            satori: f.satori, rewards: f.rewards, registry: f.registry, owner: f.owner,
            alice: f.signers[1], bob: f.signers[2], carol: f.signers[3],
            dave: f.signers[4], eve: f.signers[5],
        };
        await ctx.satori.transfer(ctx.alice.address, ethers.parseEther("100"));
        await ctx.satori.transfer(ctx.bob.address, ethers.parseEther("100"));
        await ctx.satori.transfer(ctx.carol.address, ethers.parseEther("100"));
        await ctx.satori.transfer(ctx.eve.address, ethers.parseEther("100"));
        await advanceRound();

        const controlReward = await runScenario(ctx, [
            { from: ctx.carol, amount: ethers.parseEther("100") },
        ]);

        // ---- Bug case: TWO 50-token same-round receipts (pool identical: 200) ----
        f = await deploySatoriFixtureNoFee();
        ctx = {
            satori: f.satori, rewards: f.rewards, registry: f.registry, owner: f.owner,
            alice: f.signers[1], bob: f.signers[2], carol: f.signers[3],
            dave: f.signers[4], eve: f.signers[5],
        };
        await ctx.satori.transfer(ctx.alice.address, ethers.parseEther("100"));
        await ctx.satori.transfer(ctx.bob.address, ethers.parseEther("100"));
        await ctx.satori.transfer(ctx.carol.address, ethers.parseEther("100"));
        await ctx.satori.transfer(ctx.dave.address, ethers.parseEther("100"));
        await ctx.satori.transfer(ctx.eve.address, ethers.parseEther("100"));
        await advanceRound();

        const doubleReceiptReward = await runScenario(ctx, [
            { from: ctx.carol, amount: ethers.parseEther("50") },
            { from: ctx.dave, amount: ethers.parseEther("50") },
        ]);

        // INTENDED: identical pool (200) and identical predictor conditions ->
        // identical delegator payout. The first 50-token receipt must not be
        // silently dropped from alice's checkpoint.
        expect(doubleReceiptReward).to.be.closeTo(controlReward, RAW_TOLERANCE);
    });
});
