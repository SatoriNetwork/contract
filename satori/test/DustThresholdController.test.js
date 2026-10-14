// Coverage for the adaptive dust-threshold controller (design:
// docs/design/payout-curve-redesign.md, Section B). Verifies bootstrap to the
// floor, the ±1-per-round bounded / floor-clamped nudge, directional response,
// and Sybil-resistance (power-weighted → free dust accounts can't move the bar).
const { expect } = require("chai");
const { deploySatoriFixture, pack1, VOTE } = require("./fixtures");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const UP = 1;
const FLOOR = 2n;

async function advanceRound() {
    const t = await time.latest();
    await time.increaseTo(Math.floor(t / 86400) * 86400 + 86400 + 1);
}
async function streamIdFromTx(tx, satori) {
    const r = await tx.wait();
    const ev = r.logs.find(l => { try { return satori.interface.parseLog(l)?.name === "DataStreamCreated"; } catch { return false; } });
    return satori.interface.parseLog(ev).args.streamId;
}

describe("Adaptive dust-threshold controller", function () {
    this.timeout(300000);
    let satori, engine, rewards, registry, owner, alice, bob, signers;
    let streamId;

    beforeEach(async function () {
        const fix = await deploySatoriFixture();
        ({ satori, engine, rewards, registry, signers } = fix);
        [owner, alice, bob] = await ethers.getSigners();
        // Every-round (1440-minute) stream — the controller under test nudges
        // ±1 PER ROUND, so it needs a value (and a prediction) every single
        // round.
        const tx = await satori["createSimpleDataStream(string,address,uint24)"]("BTC/USD", owner.address, 1440);
        streamId = await streamIdFromTx(tx, satori);
        await satori.transfer(alice.address, ethers.parseEther("100"));
        await satori.transfer(bob.address, ethers.parseEther("100"));
        await satori.connect(alice).vote(streamId, VOTE);
        await satori.connect(bob).vote(streamId, VOTE);
        await advanceRound();
    });

    async function threshold() {
        return (await engine.gameStreakState(streamId)).threshold;
    }

    // Drive `who` predicting UP every round against a rising value; return the
    // per-round threshold (read after each predict) for `numRounds` rounds.
    async function run(who, numRounds) {
        const ts = [];
        for (let i = 0; i < numRounds; i++) {
            await registry.setValue(streamId, 100 + i * 10);
            for (const p of who) await satori.connect(p).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(UP) }]);
            ts.push(await threshold());
            await advanceRound();
        }
        return ts;
    }

    it("bootstraps a fresh game to the floor (2) on the first prediction", async function () {
        expect(await threshold()).to.equal(0n); // unset before any prediction
        await registry.setValue(streamId, 100);
        await satori.connect(alice).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(UP) }]);
        expect(await threshold()).to.equal(FLOOR);
    });

    it("moves at most ±1 per round and never dips below the floor", async function () {
        const ts = await run([alice], 12);
        for (const t of ts) expect(Number(t)).to.be.greaterThanOrEqual(2);
        for (let i = 1; i < ts.length; i++) {
            const d = Math.abs(Number(ts[i]) - Number(ts[i - 1]));
            expect(d, `Δthreshold at round ${i}`).to.be.lessThanOrEqual(1);
        }
    });

    it("raises the bar when (power-weighted) predictions sit above it", async function () {
        // A lone predictor climbing a streak is 100% above the bar every round →
        // the controller keeps nudging the threshold up (it tracks her streak).
        const ts = await run([alice], 10);
        expect(Number(ts[ts.length - 1])).to.be.greaterThan(Number(ts[2]));
    });

    it("holds at the floor when predictions stay below it (dusting-too-many can't go lower than 2)", async function () {
        // Alice predicts, but every prediction is DOWN against a rising value → she is
        // always WRONG → her streak never leaves 0/1 → she is always below the floor-2
        // threshold. The controller wants to dust fewer (lower the bar) but can't go
        // below the floor, so the threshold pins at 2.
        for (let i = 0; i < 8; i++) {
            await registry.setValue(streamId, 100 + i * 10); // strictly rising
            await satori.connect(alice).predictMultipleWithPayloads([{ gameId: streamId, payload: ethers.hexlify(new Uint8Array([2])) }]); // DOWN → wrong
            expect(await threshold()).to.equal(FLOOR);
            await advanceRound();
        }
    });

    it("is Sybil-resistant: a swarm of near-zero-power dust accounts does not move the threshold", async function () {
        // Baseline: Alice alone climbs; capture her threshold trajectory.
        const baseline = await run([alice], 9);

        // Fresh game; Alice climbs identically, but now a swarm of tiny-power
        // accounts also predicts every round. Being power-weighted, their signal is
        // negligible, so the trajectory must match the baseline.
        // Second stream, same every-round rhythm as the baseline one above —
        // the two trajectories are only comparable if both tick every round.
        const tx2 = await satori["createSimpleDataStream(string,address,uint24)"]("ETH/USD", owner.address, 1440);
        const streamId2 = await streamIdFromTx(tx2, satori);
        const carol = signers[3];
        await satori.transfer(carol.address, ethers.parseEther("100"));
        await satori.connect(carol).vote(streamId2, VOTE); // carol replaces alice's role on the 2nd game (same 10-ether burn, so same residual power)
        // swarm: 6 accounts with a few thousand wei each (dust power, streak 0)
        const swarm = signers.slice(4, 10);
        for (const s of swarm) await satori.transfer(s.address, 5000n);
        await advanceRound();

        const ts2 = [];
        for (let i = 0; i < 9; i++) {
            await registry.setValue(streamId2, 100 + i * 10);
            await satori.connect(carol).predictMultipleWithPayloads([{ gameId: streamId2, payload: pack1(UP) }]);
            for (const s of swarm) {
                try { await satori.connect(s).predictMultipleWithPayloads([{ gameId: streamId2, payload: pack1(UP) }]); } catch (_) {}
            }
            ts2.push((await engine.gameStreakState(streamId2)).threshold);
            await advanceRound();
        }
        for (let i = 0; i < baseline.length; i++) {
            expect(Number(ts2[i]), `threshold at round ${i} must be unmoved by the dust swarm`).to.equal(Number(baseline[i]));
        }
    });
});

// The controller's setpoint is a governor dial (design: §C). It is NOT a curve dial —
// it never enters W(s,h,g,r,b) — so it lives outside curveConfig()/CurveConfigSet.
describe("Dust-target dial (controller setpoint)", function () {
    this.timeout(300000);
    let satori, engine, registry, owner, alice, bob, signers;
    let streamId;

    beforeEach(async function () {
        const fix = await deploySatoriFixture();
        ({ satori, engine, registry, signers } = fix);
        [owner, alice, bob] = await ethers.getSigners();
        const tx = await satori["createSimpleDataStream(string,address,uint24)"]("BTC/USD", owner.address, 1440);
        streamId = await streamIdFromTx(tx, satori);
        await satori.transfer(alice.address, ethers.parseEther("100"));
        await satori.transfer(bob.address, ethers.parseEther("100"));
        await satori.connect(alice).vote(streamId, VOTE);
        await satori.connect(bob).vote(streamId, VOTE);
        await advanceRound();
    });

    it("resolves to the 5000 default before any setter (unset ⇒ default)", async function () {
        expect(await engine.dustTargetSet()).to.equal(false); // never dialled
        expect(await engine.dustTarget()).to.equal(0n);       // raw storage
        expect(await engine.dustTargetBps()).to.equal(5000n); // effective
    });

    // 0 is a LEGAL setting ("pin the bar at the floor"), so it cannot double as the
    // "never dialled ⇒ use the default" sentinel the other four dials use. An explicit
    // `dustTargetSet` flag carries that instead — without it, setting 0 would silently
    // read back as 5000.
    it("distinguishes an explicit 0 from never having been set", async function () {
        expect(await engine.dustTargetBps()).to.equal(5000n); // unset → default
        await engine.connect(owner).setDustTarget(0);
        expect(await engine.dustTargetSet()).to.equal(true);
        expect(await engine.dustTargetBps()).to.equal(0n);    // explicit 0, NOT the default
    });

    // Governor, or a delegated `curveOperator` if one is set (CurveOperator.test.js).
    // None is set here, so a stranger is refused as before — with a more specific error.
    it("is governor-only", async function () {
        await expect(engine.connect(alice).setDustTarget(5000))
            .to.be.revertedWithCustomError(engine, "NotCurveOperator");
    });

    // Range [0, 9999]. The cap is the last target with a FIXED POINT: the controller
    // solves P_power(streak >= h) = 1 - target, which has a finite solution for every
    // target below BPS_SCALE and NO solution at BPS_SCALE (the bar would chase the
    // field's leader forever instead of settling). 0 is allowed — the above-bar term
    // vanishes, so the bar pins at the floor `f`, i.e. the controller switched off.
    it("is bounded to [0, 9999] — 9999 is the last target with a finite equilibrium", async function () {
        await expect(engine.connect(owner).setDustTarget(10000)).to.be.revertedWithCustomError(engine, "BadInput");
        await engine.connect(owner).setDustTarget(0);
        expect(await engine.dustTargetBps()).to.equal(0n);
        await engine.connect(owner).setDustTarget(9999);
        expect(await engine.dustTargetBps()).to.equal(9999n);
    });

    it("target 0 pins the bar at the floor — the controller stops adapting upward", async function () {
        await engine.connect(owner).setDustTarget(0);
        // A lone climber is 100% ABOVE the bar every round, which at the default 5000
        // would ratchet the bar up with her. At target 0 the above-bar term is zero, so
        // the signal can never be negative and the bar never rises.
        for (let i = 0; i < 8; i++) {
            await registry.setValue(streamId, 100 + i * 10);
            await satori.connect(alice).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(UP) }]);
            expect(Number((await engine.gameStreakState(streamId)).threshold)).to.equal(2); // the floor
            await advanceRound();
        }
    });

    it("target 9999 is the mirror — the bar tracks the leader upward every round", async function () {
        await engine.connect(owner).setDustTarget(9999);
        // At the top of the range the below-bar term is 1 vs an above-bar -9999, so the
        // signal is negative whenever anyone is at/above the bar — it ratchets up in
        // lockstep with the climber rather than settling below her.
        const bars = [];
        for (let i = 0; i < 8; i++) {
            await registry.setValue(streamId, 100 + i * 10);
            await satori.connect(alice).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(UP) }]);
            bars.push(Number((await engine.gameStreakState(streamId)).threshold));
            await advanceRound();
        }
        expect(bars[bars.length - 1], `bar must climb off the floor (got ${bars})`).to.be.greaterThan(2);
        for (let i = 1; i < bars.length; i++) {
            expect(bars[i] - bars[i - 1], "still rate-limited to +1/round").to.be.lessThanOrEqual(1);
        }
    });

    it("emits DustTargetSet with the effective value", async function () {
        await expect(engine.connect(owner).setDustTarget(5000))
            .to.emit(engine, "DustTargetSet").withArgs(5000);
    });

    // The setpoint must actually steer the controller. Field: one climber (above the bar
    // once her streak clears it) and one perpetual loser (streak 0, always below), at
    // equal starting power → roughly half the power sits below the bar. A setpoint under
    // that half reads "dusting too many" and sinks the bar; one above it reads "dusting
    // too few" and raises it. Same field, opposite directions — the dial doing its job.
    //
    // The floor is dropped to 1 first so the climber clears the bar on her SECOND round.
    // At the default floor of 4 she needs four winning rounds to get above it, and by then
    // her winnings have grown her prediction power past the loser's — the field stops being
    // half-and-half and both setpoints agree to raise. Diverging early keeps the two runs
    // comparing the same field. (This is why the controller is power-weighted at all: a
    // winner's power really does compound.)
    const RUN_ROUNDS = 4;
    async function runMixedField(stream, climber, loser) {
        for (let i = 0; i < RUN_ROUNDS; i++) {
            await registry.setValue(stream, 100 + i * 10); // strictly rising
            await satori.connect(climber).predictMultipleWithPayloads([{ gameId: stream, payload: pack1(UP) }]);
            await satori.connect(loser).predictMultipleWithPayloads([{ gameId: stream, payload: ethers.hexlify(new Uint8Array([2])) }]); // DOWN → always wrong
            await advanceRound();
        }
        return Number((await engine.gameStreakState(stream)).threshold);
    }

    // Both setpoints are set EXPLICITLY rather than leaning on the compiled default, so
    // this stays a test of the dial and does not silently weaken if the default moves.
    it("steers the bar: a higher target holds it higher on the same field", async function () {
        await engine.connect(owner).setDustFloor(1);
        await engine.connect(owner).setDustTarget(1000);          // 10% — dusting too many
        const atLow = await runMixedField(streamId, alice, bob);

        // Fresh game + fresh pair (voting burns, so reusing alice/bob would skew power).
        const tx2 = await satori["createSimpleDataStream(string,address,uint24)"]("ETH/USD", owner.address, 1440);
        const streamId2 = await streamIdFromTx(tx2, satori);
        const [carol, dave] = [signers[3], signers[4]];
        await satori.transfer(carol.address, ethers.parseEther("100"));
        await satori.transfer(dave.address, ethers.parseEther("100"));
        await satori.connect(carol).vote(streamId2, VOTE);
        await satori.connect(dave).vote(streamId2, VOTE);
        await engine.connect(owner).setDustTarget(9000);          // 90% — dusting too few
        await advanceRound();

        const atHigh = await runMixedField(streamId2, carol, dave);
        expect(atHigh, `90% target must hold the bar above the 10% one (got ${atHigh} vs ${atLow})`)
            .to.be.greaterThan(atLow);
    });
});
