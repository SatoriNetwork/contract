/**
 * PredictionSelfDelegationNormalization.test.js
 *
 * Delegation storage must hold exactly two valid states: address(0)
 * (undelegated) or some-other-address (delegated). A `delegate == self`
 * entry is a third, broken state and is normalized away at the entry point.
 *
 * Prediction delegation originally missed that normalization.
 * `predictionDelegate` could hold three states:
 *   - address(0)  → undelegated (predict allowed, getPredictionPower returns balance)
 *   - other addr  → delegated   (predict reverts, getPredictionPower returns 0)
 *   - self addr   → BROKEN      (predict reverts, getPredictionPower returns balance)
 *
 * The third state is the bug. `getPredictionPower` says "you have power"
 * but `predict()` reverts with "Delegated". A UI
 * built against `getPredictionPower` will show a positive predictable
 * balance for a self-delegated user who can't actually predict.
 *
 * The fix: normalize `delegate=self` to `address(0)` at the entry point so
 * storage can never hold the third state. Once normalized, all
 * `delegate != delegator` carve-outs in `SatoriRewards` simplify to
 * `delegate != address(0)`.
 *
 * These tests pin the new contract:
 *
 *   1. Storage is normalized: `predictionDelegate(user) == address(0)`
 *      after `delegatePredictionPower(self)`.
 *   2. `delegatePredictionPower(self)` and `delegatePredictionPower(0)`
 *      produce identical end states (storage, lock, pool).
 *   3. `getPredictionPower` and the predict gate agree for a
 *      self-delegated input — both treat the user as undelegated.
 *   4. A delegated user routing through self matches routing through
 *      address(0) in pool accounting on the previous delegate.
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

describe("Prediction self-delegation normalization", function () {
    let satori, voting, rewards, bounties, registry;
    let owner, alice, bob, carol, platform;
    let stream1;

    beforeEach(async function () {
        const fix = await deploySatoriFixture();
        ({ satori, voting, rewards, registry, bounties, owner } = fix);
        const signers = fix.signers;
        [alice, bob, carol, platform] = signers.slice(1);

        stream1 = await getStreamIdFromTx(
            await satori.createSimpleDataStream("S1", owner.address), satori);

        await satori.transfer(alice.address, ethers.parseEther("100"));
        await satori.transfer(bob.address, ethers.parseEther("100"));
        await satori.transfer(carol.address, ethers.parseEther("100"));
        // Burn from the OWNER, not from a delegation subject: the tests below
        // compare alice's and bob's prediction power head-to-head, so neither
        // may have had their balance reduced by a vote burn.
        await voteFor(satori, owner, stream1);
    });

    it("delegatePredictionPower(self) stores address(0)", async function () {
        await satori.connect(alice).delegatePredictionPower(alice.address);
        expect((await rewards.predictionDelegateInfo(alice.address)).delegate).to.equal(ethers.ZeroAddress);
    });

    it("delegatePredictionPower(self) while delegated emits PredictionUndelegated naming the old delegate, never PredictionDelegated", async function () {
        const names = (rc) => rc.logs.map(l => { try { return rewards.interface.parseLog(l); } catch { return null; } }).filter(Boolean);
        // Not delegated: a self-delegation is a no-op undelegation and logs nothing.
        const idle = names(await (await satori.connect(carol).delegatePredictionPower(carol.address)).wait());
        expect(idle.filter(p => p.name === "PredictionUndelegated" || p.name === "PredictionDelegated")).to.have.length(0);

        await satori.connect(alice).delegatePredictionPower(bob.address);
        const out = names(await (await satori.connect(alice).delegatePredictionPower(alice.address)).wait());
        const undel = out.filter(p => p.name === "PredictionUndelegated");
        expect(undel).to.have.length(1);
        expect(undel[0].args.delegate).to.equal(bob.address);
        expect(out.filter(p => p.name === "PredictionDelegated")).to.have.length(0);
    });

    it("getPredictionPower for self-delegated input returns balance + delegated, like undelegated", async function () {
        // Carol delegates to Alice — Alice now has inbound power.
        await satori.connect(carol).delegatePredictionPower(alice.address);
        const expected = (await satori.balanceOf(alice.address)) +
                         ((await rewards.predictionDelegateInfo(alice.address)).power);

        // Alice "self-delegates" — should leave her power view unchanged.
        await satori.connect(alice).delegatePredictionPower(alice.address);

        expect(await rewards.getPredictionPower(alice.address)).to.equal(expected);
    });

    it("predict gate and getPredictionPower agree for a self-delegated-input user", async function () {
        // The bug-report scenario: a UI shows predictable power, the user
        // clicks predict, the predict gate reverts. After the fix, both
        // ends agree — the gate accepts the user and getPredictionPower
        // returns the same nonzero balance.
        await satori.connect(alice).delegatePredictionPower(alice.address);

        // View: still nonzero (storage was normalized).
        const power = await rewards.getPredictionPower(alice.address);
        expect(power).to.be.gt(0);

        // Self-delegate-via-self goes through the undelegate branch which
        // sets lockedUntil = currentRound + 1. Wait one round so the lock
        // expires, then prove predict() SUCCEEDS.
        await advanceRound();
        await registry.setValue(stream1, 100);

        // NOTE: this used to be `.to.not.be.revertedWith("Delegated")`, which was
        // vacuous — the gate is the CUSTOM error `Delegated()` (SatoriEngine.sol),
        // and hardhat-chai-matchers' revertedWith only matches Error(string), so
        // the negated form passed for EVERY outcome (success, custom revert, panic).
        // The documented intent is that the predict must SUCCEED, so assert the
        // success itself and the recorded prediction (a revert of ANY kind now fails).
        const round = await satori.getCurrentRound();
        await expect(satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]))
            .to.not.be.reverted;

        // The gate accepted her AND the prediction landed carrying the very power
        // the view advertised — the two halves of the normalization agree.
        const pred = await satori.predictions(alice.address, stream1, round);
        expect(pred.direction).to.equal(UP);
        // rawPredictionPower rides a reduced-precision packed field, so it tracks
        // the view up to that quantization (~1e-9 relative), never to the wei.
        expect(pred.rawPredictionPower).to.be.lte(power);
        expect(pred.rawPredictionPower).to.be.gt(power - power / 1000000n);
    });

    it("self-delegate from a never-delegated state matches zero-delegate exactly", async function () {
        // Path A: alice → 0 (canonical undelegate)
        const aliceA = alice;
        await satori.connect(aliceA).delegatePredictionPower(ethers.ZeroAddress);
        const storageA = (await rewards.predictionDelegateInfo(aliceA.address)).delegate;
        const powerA = await rewards.getPredictionPower(aliceA.address);
        const lockA = await satori.lockedUntil(aliceA.address);

        // Path B: bob → bob (self)
        const aliceB = bob;
        await satori.connect(aliceB).delegatePredictionPower(aliceB.address);
        const storageB = (await rewards.predictionDelegateInfo(aliceB.address)).delegate;
        const powerB = await rewards.getPredictionPower(aliceB.address);
        const lockB = await satori.lockedUntil(aliceB.address);

        // Same storage value (address(0)).
        expect(storageA).to.equal(storageB);
        expect(storageA).to.equal(ethers.ZeroAddress);

        // Same view: balance (alice and bob both started with 100).
        expect(powerA).to.equal(powerB);

        // Same lock semantics (lockUntilNextRound, not lockUntilUndelegation).
        expect(lockA).to.equal(lockB);
        // lockUntilUndelegation writes type(uint64).max — this is NOT that.
        const MAX = 2n ** 24n - 1n;
        expect(lockA).to.not.equal(MAX);
    });

    it("delegated → self matches delegated → 0 in pool accounting on previous delegate", async function () {
        // Two parallel delegators going through the same transition.
        // Alice → Bob → 0 should produce the same `delegatedPredictionPower[bob]`
        // contribution as Carol → Bob → carol-self.
        await satori.connect(alice).delegatePredictionPower(bob.address);
        await satori.connect(carol).delegatePredictionPower(bob.address);

        // After both delegate to bob: bob holds 200 inbound (alice's 100 + carol's 100).
        expect((await rewards.predictionDelegateInfo(bob.address)).power)
            .to.equal(ethers.parseEther("200"));

        // Alice undelegates via address(0).
        await satori.connect(alice).delegatePredictionPower(ethers.ZeroAddress);
        const afterAliceZero = (await rewards.predictionDelegateInfo(bob.address)).power;

        // Carol undelegates via self (the path the fix normalizes).
        await satori.connect(carol).delegatePredictionPower(carol.address);
        const afterCarolSelf = (await rewards.predictionDelegateInfo(bob.address)).power;

        // Both removed exactly 100 from bob's pool.
        expect(afterAliceZero).to.equal(ethers.parseEther("100"));
        expect(afterCarolSelf).to.equal(0);

        // And both undelegators' storage is normalized to address(0).
        expect((await rewards.predictionDelegateInfo(alice.address)).delegate).to.equal(ethers.ZeroAddress);
        expect((await rewards.predictionDelegateInfo(carol.address)).delegate).to.equal(ethers.ZeroAddress);
    });

    it("delegated → self does not leak into delegatedPredictionPower[self]", async function () {
        // Pre-fix bug: after delegated → self, predictionDelegate[user] = user
        // and the carve-out at line 822 skipped pool accounting — but a
        // future read of delegatedPredictionPower[user] could mistakenly
        // include carryover. Pin: after the round trip, alice's inbound
        // delegation pool is exactly what other delegators contributed
        // (zero in this isolated case).
        await satori.connect(alice).delegatePredictionPower(bob.address);
        await satori.connect(alice).delegatePredictionPower(alice.address);

        expect((await rewards.predictionDelegateInfo(alice.address)).power).to.equal(0);
    });
});
