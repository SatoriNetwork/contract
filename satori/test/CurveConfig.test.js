// Coverage for the four governor-tunable S-curve dials (design:
// docs/design/payout-curve-redesign.md §A): setDustFloor (f), setTopGradient (g),
// setBottomGradient (r), setTopShift (b). Verifies the 0-storage⇒default resolution,
// governor-only access control, per-dial bounds, the r ≥ g monotonicity guardrail, the
// CurveConfigSet event, and that a dial actually reaches the live committed multiplier.
const { expect } = require("chai");
const { deploySatoriFixture, RAW_TOLERANCE, pack1, VOTE } = require("./fixtures");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const UP = 1;
const SCALE = 1_000_000n;
const WEIGHT_SCALE = 10n ** 18n;

async function advanceRound() {
    const t = await time.latest();
    await time.increaseTo(Math.floor(t / 86400) * 86400 + 86400 + 1);
}
async function streamIdFromTx(tx, satori) {
    const r = await tx.wait();
    const ev = r.logs.find(l => { try { return satori.interface.parseLog(l)?.name === "DataStreamCreated"; } catch { return false; } });
    return satori.interface.parseLog(ev).args.streamId;
}

// Mirror of SatoriEngine._streakWeight — tunable rational S-curve W(s,h,g,r,b)·SCALE.
function mult(streak, bar, isFirst, g, r, b) {
    const s = BigInt(streak), h = BigInt(bar), G = BigInt(g), R = BigInt(r), B = BigInt(b);
    if (s === 0n) return isFirst ? 1n : 0n;
    if (s < h) return (SCALE * h * s) / ((R + 1n) * (h + R * (h - s)));
    return (SCALE * h * ((s - h) * (G * G + G + 1n) + G * h)) / ((G + 1n) * (s + h * (G - 1n))) + B * SCALE;
}

describe("Curve configuration — governor dials (f, g, r, b)", function () {
    this.timeout(120000);
    let satori, engine, rewards, registry, owner, alice, bob;
    let streamId;
    const ALICE_BALANCE = ethers.parseEther("100");
    const BOB_BALANCE = ethers.parseEther("100");

    beforeEach(async function () {
        [owner, alice, bob] = await ethers.getSigners();
        const fix = await deploySatoriFixture();
        ({ satori, engine, rewards, registry } = fix);
        // Every-round (1440-minute) stream — buildStreak() below posts a value
        // and predicts EVERY round, so the curve is sampled once per round
        // exactly as the mirror expects.
        const tx = await satori["createSimpleDataStream(string,address,uint24)"]("BTC/USD", owner.address, 1440);
        streamId = await streamIdFromTx(tx, satori);
        await satori.transfer(alice.address, ALICE_BALANCE);
        await satori.transfer(bob.address, BOB_BALANCE);
        await satori.connect(alice).vote(streamId, VOTE);
        await satori.connect(bob).vote(streamId, VOTE);
        await advanceRound();
    });

    // Drive Alice up a correct streak; capture per-round power / streak / bar / first-flag.
    async function buildStreak(n) {
        const powers = [], streaks = [], bars = [], firstFlags = [];
        for (let i = 0; i < n; i++) {
            await registry.setValue(streamId, 100 + i * 10);
            powers.push(await rewards.getPredictionPower(alice.address));
            firstFlags.push(i === 0);
            await satori.connect(alice).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(UP) }]);
            streaks.push(await engine.streaks(alice.address, streamId));
            bars.push((await engine.gameStreakState(streamId)).threshold);
            await advanceRound();
        }
        return { powers, streaks, bars, firstFlags };
    }

    describe("defaults (0 storage ⇒ compiled default)", function () {
        it("curveConfig() resolves to f=2, g=3, r=12, b=0 before any setter", async function () {
            const c = await engine.curveConfig();
            expect(c.f).to.equal(2n);
            expect(c.g).to.equal(3n);
            expect(c.r).to.equal(12n);
            expect(c.b).to.equal(0n);
            // raw storage dials are still 0 (the sentinel)
            expect(await engine.dustFloor()).to.equal(0);
            expect(await engine.topGradient()).to.equal(0);
            expect(await engine.bottomGradient()).to.equal(0);
            expect(await engine.topShift()).to.equal(0);
        });
    });

    describe("access control (governor only)", function () {
        // The dials are now reachable by the governor OR an optional delegated
        // `curveOperator` (see CurveOperator.test.js for that key). With no
        // operator set — the default — a stranger is refused exactly as before;
        // only the error is more specific than the old blanket `Unauthorized`.
        it("a non-governor cannot move any dial", async function () {
            expect(await engine.curveOperator()).to.equal(ethers.ZeroAddress);
            await expect(engine.connect(alice).setDustFloor(2)).to.be.revertedWithCustomError(engine, "NotCurveOperator");
            await expect(engine.connect(alice).setTopGradient(2)).to.be.revertedWithCustomError(engine, "NotCurveOperator");
            await expect(engine.connect(alice).setBottomGradient(5)).to.be.revertedWithCustomError(engine, "NotCurveOperator");
            await expect(engine.connect(alice).setTopShift(1)).to.be.revertedWithCustomError(engine, "NotCurveOperator");
        });
    });

    describe("per-dial bounds", function () {
        it("dustFloor ∈ [1, 64]", async function () {
            await expect(engine.connect(owner).setDustFloor(0)).to.be.revertedWithCustomError(engine, "BadInput");
            await expect(engine.connect(owner).setDustFloor(65)).to.be.revertedWithCustomError(engine, "BadInput");
            await engine.connect(owner).setDustFloor(1);
            await engine.connect(owner).setDustFloor(64);
            expect((await engine.curveConfig()).f).to.equal(64n);
        });
        it("topGradient ∈ [1, 8]", async function () {
            await expect(engine.connect(owner).setTopGradient(0)).to.be.revertedWithCustomError(engine, "BadInput");
            await expect(engine.connect(owner).setTopGradient(9)).to.be.revertedWithCustomError(engine, "BadInput");
        });
        it("bottomGradient ∈ [1, 64]", async function () {
            await expect(engine.connect(owner).setBottomGradient(0)).to.be.revertedWithCustomError(engine, "BadInput");
            await expect(engine.connect(owner).setBottomGradient(65)).to.be.revertedWithCustomError(engine, "BadInput");
        });
        it("topShift ∈ [0, 64]", async function () {
            await expect(engine.connect(owner).setTopShift(65)).to.be.revertedWithCustomError(engine, "BadInput");
            await engine.connect(owner).setTopShift(0);
            await engine.connect(owner).setTopShift(64);
            expect((await engine.curveConfig()).b).to.equal(64n);
        });
    });

    describe("monotonicity guardrail r ≥ g", function () {
        it("g cannot cross above the current r; raise r first", async function () {
            // defaults g=3, r=12 — pull r down to 3 first so g has something to cross
            await engine.connect(owner).setBottomGradient(3);   // r=3 (≥ g=3) ok
            await expect(engine.connect(owner).setTopGradient(5)).to.be.revertedWithCustomError(engine, "BadInput"); // 5 > r=3
            await engine.connect(owner).setBottomGradient(5);   // r=5 (≥ g=3) ok
            await engine.connect(owner).setTopGradient(5);      // g=5 (≤ r=5) ok
            const c = await engine.curveConfig();
            expect(c.g).to.equal(5n);
            expect(c.r).to.equal(5n);
        });
        it("r cannot drop below the current g", async function () {
            await engine.connect(owner).setBottomGradient(6);   // r=6
            await engine.connect(owner).setTopGradient(6);      // g=6
            await expect(engine.connect(owner).setBottomGradient(5)).to.be.revertedWithCustomError(engine, "BadInput"); // 5 < g=6
        });
        it("g == r is allowed (equality holds monotonicity)", async function () {
            await engine.connect(owner).setBottomGradient(8);
            await engine.connect(owner).setTopGradient(8); // g == r == 8, at the cap
            const c = await engine.curveConfig();
            expect(c.g).to.equal(8n);
            expect(c.r).to.equal(8n);
        });
    });

    describe("CurveConfigSet event (effective config)", function () {
        it("emits the resolved (f, g, r, b) after each change", async function () {
            await expect(engine.connect(owner).setDustFloor(2)).to.emit(engine, "CurveConfigSet").withArgs(2, 3, 12, 0);
            await expect(engine.connect(owner).setTopShift(4)).to.emit(engine, "CurveConfigSet").withArgs(2, 3, 12, 4);
            await engine.connect(owner).setBottomGradient(6);
            await expect(engine.connect(owner).setTopGradient(6)).to.emit(engine, "CurveConfigSet").withArgs(2, 6, 6, 4);
        });
    });

    describe("dials reach the live curve", function () {
        it("setDustFloor changes a fresh game's bootstrap bar", async function () {
            await engine.connect(owner).setDustFloor(2);
            const tx = await satori["createSimpleDataStream(string,address,uint24)"]("ETH/USD", owner.address, 1440);
            const sid2 = await streamIdFromTx(tx, satori);
            await satori.connect(alice).vote(sid2, VOTE);
            await advanceRound();
            await registry.setValue(sid2, 100);
            await satori.connect(alice).predictMultipleWithPayloads([{ gameId: sid2, payload: pack1(UP) }]);
            expect((await engine.gameStreakState(sid2)).threshold).to.equal(2); // bootstrap to the new floor
        });

        it("setTopShift lifts the committed above-bar multiplier by b·SCALE", async function () {
            await engine.connect(owner).setTopShift(10); // b = 10
            const { powers, streaks, bars, firstFlags } = await buildStreak(12);
            const events = await engine.queryFilter(engine.filters.PredictionScored(alice.address, streamId));
            let checkedAbove = false;
            for (let j = 0; j < events.length; j++) {
                const s = Number(streaks[j]), h = Number(bars[j]);
                if (s >= h && s > 0) {
                    const expWithB = mult(s, h, firstFlags[j], 3n, 3n, 10n);
                    const expNoB = mult(s, h, firstFlags[j], 3n, 3n, 0n);
                    expect(expWithB).to.equal(expNoB + 10n * SCALE);   // mirror: the lift is exactly b·SCALE
                    // scaledWeight is simply power x multiplier now — the old
                    // `x WEIGHT_SCALE / totalVotes` normalisation is gone.
                    const wExp = powers[j] * expWithB;
                    const tol = RAW_TOLERANCE * expWithB;
                    expect(events[j].args.scaledWeight, `event ${j} (streak ${s}, bar ${h})`).to.be.closeTo(wExp, tol);
                    checkedAbove = true;
                }
            }
            expect(checkedAbove, "expected at least one at/above-bar event").to.equal(true);
        });

        it("setTopGradient reshapes the committed above-bar multiplier", async function () {
            await engine.connect(owner).setBottomGradient(6); // r=6 first (so g≤r)
            await engine.connect(owner).setTopGradient(6);    // g=6
            const { powers, streaks, bars, firstFlags } = await buildStreak(12);
            const events = await engine.queryFilter(engine.filters.PredictionScored(alice.address, streamId));
            let checkedAbove = false;
            for (let j = 0; j < events.length; j++) {
                const s = Number(streaks[j]), h = Number(bars[j]);
                if (s >= h && s > 0) { // at/above the bar — g shapes the value there (W(h)=h/(g+1))
                    const expG6 = mult(s, h, firstFlags[j], 6n, 6n, 0n);
                    const expG3 = mult(s, h, firstFlags[j], 3n, 3n, 0n);
                    expect(expG6).to.not.equal(expG3); // the dial changes the shape (h/(6+1) vs h/(3+1))
                    // scaledWeight is simply power x multiplier now — the old
                    // `x WEIGHT_SCALE / totalVotes` normalisation is gone.
                    const wExp = powers[j] * expG6;
                    const tol = RAW_TOLERANCE * expG6;
                    expect(events[j].args.scaledWeight, `event ${j} (streak ${s}, bar ${h})`).to.be.closeTo(wExp, tol);
                    checkedAbove = true;
                }
            }
            expect(checkedAbove, "expected at least one at/above-bar event").to.equal(true);
        });
    });
});
