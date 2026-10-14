const { expect } = require("chai");
const { deploySatoriFixture, RAW_TOLERANCE, SCALED_WEIGHT_TOLERANCE, pack1, voteFor } = require("./fixtures");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const UP = 1;
const WEIGHT_SCALE = 10n ** 18n;
const SCALE = 1_000_000n; // CURVE_SCALE — integer precision; cancels in the normalized payout

// Compiled defaults of the four governor curve dials (an unset/0 storage dial resolves
// to these). Tests that never call the setters run entirely at the defaults.
const DEF_G = 3n; // topGradient
const DEF_R = 12n; // bottomGradient
const DEF_B = 0n; // topShift

async function advanceRound() {
    const currentTime = await time.latest();
    const nextMidnight = Math.floor(currentTime / 86400) * 86400 + 86400;
    await time.increaseTo(nextMidnight + 1);
}

// The stream is created at 2880 minutes (two 24h rounds). It may be written
// once per CADENCE_ROUNDS rounds, so a
// predictor lands one prediction per cadence PERIOD, and scoring is the AB
// window: anchor = the value AT the predict round, post = the FIRST value
// written after it. One consequence matters throughout this file: a prediction
// now settles on the NEXT period's write (one step of lag) rather than two
// rounds later, so the sequences below expect one fewer trailing unsettled
// prediction than the every-round ABC form did.
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

// Mirror of SatoriEngine._streakWeight — the tunable rational S-curve W(s,h,g,r,b)·SCALE
// (design: docs/design/payout-curve-redesign.md §A). h = max(dustFloor, adaptiveThreshold)
// is the bar; g/r are the above/below-bar gradients; b is a flat above-bar lift. Cheap:
// mul/div, no sqrt.
//   s == 0   → first ? 1 : 0                                          (kept "you're in the game" hook)
//   s <  h   → SCALE·h·s / ((r+1)·(h + r·(h − s)))                    (convex dust ramp; W(0)=0 for any r)
//   s >= h   → SCALE·h·((s−h)(g²+g+1) + g·h) / ((g+1)(s + h(g−1))) + b·SCALE   (saturating top)
// Anchors: W(0)=0 (any r), W(h)=h/(g+1)+b; asymptote h·(g²+g+1)/(g+1)+b.
// The pure curve W(s,h,g,r,b)·SCALE — exactly what _streakWeight returns. W(0)=0
// is a property of the FORMULA; the contract never calls it with s == 0.
function curveW(streak, bar, g = DEF_G, r = DEF_R, b = DEF_B) {
    const s = BigInt(streak), h = BigInt(bar), G = BigInt(g), R = BigInt(r), B = BigInt(b);
    if (s === 0n) return 0n;
    if (s < h) return (SCALE * h * s) / ((R + 1n) * (h + R * (h - s)));
    return (SCALE * h * ((s - h) * (G * G + G + 1n) + G * h)) / ((G + 1n) * (s + h * (G - 1n))) + B * SCALE;
}

// What the CONTRACT actually pays: flat dust at streak 0 (audit C-2 — every
// streak-0 prediction, first-ever or back at zero after a miss), curve above it.
function expectedMultiplier(streak, bar, isFirst, g = DEF_G, r = DEF_R, b = DEF_B) {
    return BigInt(streak) === 0n ? 1n : curveW(streak, bar, g, r, b);
}

// Prediction weight is now simply `rawPower × multiplier` — the old
// `× WEIGHT_SCALE / totalVotes` normalisation is gone. Power-quantization
// therefore propagates to the scaledWeight scaled by the multiplier alone.
function weightTol(expMult) {
    const m = expMult === 0n ? 1n : expMult;
    return RAW_TOLERANCE * m + WEIGHT_SCALE;
}

describe("Streak multiplier curve (tunable rational S-curve W(s,h,g,r,b) + adaptive threshold)", function () {
    let satori, voting, rewards, bounties, registry, engine;
    let owner, alice, bob;
    let streamId;

    const ALICE_BALANCE = ethers.parseEther("100");
    const BOB_BALANCE = ethers.parseEther("100");

    beforeEach(async function () {
        [owner, alice, bob] = await ethers.getSigners();
        const fix = await deploySatoriFixture();
        ({ satori, voting, rewards, registry, engine } = fix);

        const tx = await satori["createSimpleDataStream(string,address,uint24)"]("BTC/USD", owner.address, 2880);
        streamId = await getStreamIdFromTx(tx, satori);

        await satori.transfer(alice.address, ALICE_BALANCE);
        await satori.transfer(bob.address, BOB_BALANCE);

        // The OWNER burns for the game (not alice/bob): burning destroys tokens,
        // and every expected scaledWeight below is keyed off alice committing her
        // full ALICE_BALANCE as prediction power.
        await voteFor(satori, owner, streamId);

        await advanceRound();
    });

    // Execute one prediction per CADENCE PERIOD against the given value sequence.
    // `values[i]` is prediction i's anchor and `values[i+1]` its post, so the AB
    // window makes prediction i correct iff values[i+1] > values[i]. Each predict
    // scores the PREVIOUS period's prediction (the write that opens this period is
    // its post), so after N predictions exactly N-1 have been scored. Captures, per
    // period, the committed prediction power, the post-scoring streak the multiplier
    // was computed from, the (adaptive) bar h = threshold that applied, and whether
    // it was Alice's first. The curve dials stay at their defaults (g=3, r=3, b=0)
    // throughout this file.
    async function buildStreakWithValues(values) {
        const powers = [], streaks = [], bars = [], firstFlags = [];
        for (let i = 0; i < values.length; i++) {
            await registry.setValue(streamId, values[i]);
            powers.push(await rewards.getPredictionPower(alice.address));
            firstFlags.push(i === 0);
            await satori.connect(alice).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(UP) }]);
            // Post-tx: streak == the value _makePrediction read, and gameStreakState.threshold
            // == the bar h (= max(floor, adaptive threshold)) used for the multiplier this round.
            streaks.push(await engine.streaks(alice.address, streamId));
            bars.push((await engine.gameStreakState(streamId)).threshold);
            await advanceCadencePeriod();
        }
        return { powers, streaks, bars, firstFlags };
    }

    // Monotone-up values: every prediction is correct, so the streak only climbs.
    async function buildStreak(numPredictions) {
        return buildStreakWithValues(
            Array.from({ length: numPredictions }, (_, i) => 100 + i * 10));
    }

    describe("the curve mirror (unit)", function () {
        it("hits the anchors W(0)=0 (any r) and W(h)=h/(g+1)+b (defaults g=3,r=3,b=0)", function () {
            const h = 12n;
            // audit C-2: streak 0 pays flat dust, first-ever prediction or not
            expect(expectedMultiplier(0, h, true)).to.equal(1n);
            expect(expectedMultiplier(0, h, false)).to.equal(1n);
            // W(0)=0 holds for ANY bottom gradient r
            for (const r of [1n, 3n, 8n, 30n]) expect(curveW(0, h, 3n, r, 0n)).to.equal(0n);
            // W(h) = h/(g+1) + b
            expect(expectedMultiplier(12, h, false)).to.equal(SCALE * h / 4n);            // h/(3+1) = 3.0
            expect(expectedMultiplier(12, h, false, 3n, 3n, 2n)).to.equal(SCALE * h / 4n + 2n * SCALE); // + b=2
            expect(expectedMultiplier(12, h, false, 5n, 6n, 0n)).to.equal(SCALE * h / 6n); // h/(5+1) = 2.0
        });

        it("anchors hold for arbitrary (h, g, r, b) with r >= g", function () {
            for (const [h, g, r, b] of [[4n, 3n, 3n, 0n], [8n, 2n, 5n, 1n], [12n, 3n, 3n, 0n], [30n, 4n, 8n, 3n], [2n, 1n, 1n, 0n]]) {
                expect(curveW(0, h, g, r, b)).to.equal(0n);                                          // W(0)=0
                expect(expectedMultiplier(Number(h), h, false, g, r, b)).to.equal(SCALE * h / (g + 1n) + b * SCALE); // W(h)=h/(g+1)+b
            }
        });

        it("is monotonic in streak for every (h, g, r, b) with r >= g — no integer-truncation dips", function () {
            // Every step is still checked; only the ASSERTION is hoisted out of the
            // inner loop. This sweep runs ~16.9k steps (the h=16383 case alone
            // covers the whole codec range), and a hardhat-chai-matchers
            // `expect(...).to.equal(...)` per step costs milliseconds — enough to
            // blow the 40s mocha budget on a pure-JS mirror check that itself runs
            // in about a second. Recording the FIRST dip and asserting once per
            // parameter set is exactly as strict and reports the same detail.
            for (const [h, g, r, b] of [[4n, 3n, 3n, 0n], [4n, 2n, 3n, 0n], [8n, 4n, 8n, 0n], [12n, 3n, 3n, 5n], [100n, 3n, 64n, 10n], [2n, 1n, 1n, 0n], [16383n, 8n, 8n, 0n]]) {
                let prev = -1n;
                let firstDip = null;
                const top = h + 60n > 16383n ? 16383n : h + 60n;
                for (let s = 0n; s <= top; s++) {
                    const m = expectedMultiplier(s, h, false, g, r, b);
                    if (firstDip === null && m < prev) {
                        firstDip = `h=${h} g=${g} r=${r} b=${b}: mult(${s})=${m} < mult(${s - 1n})=${prev}`;
                    }
                    prev = m;
                }
                expect(firstDip, firstDip ?? `monotonic for h=${h} g=${g} r=${r} b=${b}`).to.equal(null);
            }
        });

        it("dust below the bar is a small fraction of the entry (anti-faucet), rising toward it", function () {
            const h = 12n;
            const entry = expectedMultiplier(12, h, false);          // W(h) = h/(g+1)
            // streak 1 (deep dust) is a tiny fraction of the entry
            expect(expectedMultiplier(1, h, false) * 20n).to.be.lessThan(entry); // < 5% of entry
            // and the bottom half rises monotonically up to (but under) the entry
            expect(expectedMultiplier(1, h, false)).to.be.lessThan(expectedMultiplier(6, h, false));
            expect(expectedMultiplier(6, h, false)).to.be.lessThan(expectedMultiplier(11, h, false));
            expect(expectedMultiplier(11, h, false)).to.be.lessThan(entry);
        });

        it("the top saturates toward the asymptote h·(g²+g+1)/(g+1) + b", function () {
            const h = 12n, g = DEF_G, b = DEF_B;
            const entry = expectedMultiplier(12, h, false);                       // W(h) = h/(g+1)
            const asymptote = SCALE * h * (g * g + g + 1n) / (g + 1n) + b * SCALE; // limit as s→∞
            // a far-above-bar streak is close to, and strictly below, the asymptote
            const far = expectedMultiplier(16000, h, false);
            expect(far).to.be.lessThan(asymptote);
            expect(far * 100n).to.be.greaterThan(asymptote * 99n); // within 1% of the asymptote
            // and always above the entry (monotone top)
            expect(far).to.be.greaterThan(entry);
        });

        it("W(streak) < streak (sublinear) above the bar at defaults", function () {
            const h = 4n;
            for (const s of [4n, 8n, 20n, 100n, 1000n]) {
                expect(expectedMultiplier(s, h, false)).to.be.lessThan(s * SCALE);
            }
        });
    });

    describe("committed multipliers on chain", function () {
        it("match the mirror across a built streak (dust below the bar, saturating S-curve above)", async function () {
            const { powers, streaks, bars, firstFlags } = await buildStreak(12);
            const events = await engine.queryFilter(engine.filters.PredictionScored(alice.address, streamId));
            expect(events.length).to.equal(11); // 12 predicts − 1 unsettled (AB settles on the next period)

            for (let j = 0; j < events.length; j++) {
                const expMult = expectedMultiplier(streaks[j], bars[j], firstFlags[j]);
                const expWeight = expMult === 0n ? 0n : powers[j] * expMult;
                expect(events[j].args.scaledWeight, `event ${j} (streak ${streaks[j]}, bar ${bars[j]})`)
                    .to.be.closeTo(expWeight, weightTol(expMult));
            }
        });

        it("cold start: every streak-0 predict earns flat dust (mult 1), streak-1 earns curve dust", async function () {
            // A monotone-rising stream never returns a predictor to streak 0 under
            // the AB window (every prediction settles correct on the next period),
            // so the "streak 0 again, but NOT the first-ever" case has to be BUILT:
            // the 300 -> 100 drop below makes prediction 2 wrong and resets the
            // streak. Anchor/post pairs: (100,200) win, (200,300) win, (300,100)
            // LOSS, (100,200) win, (200,300) win.
            const { powers, streaks, bars, firstFlags } =
                await buildStreakWithValues([100, 200, 300, 100, 200, 300]);
            const events = await engine.queryFilter(engine.filters.PredictionScored(alice.address, streamId));
            expect(events.length).to.equal(5); // 6 predicts − 1 unsettled

            // event 0: first-ever predict, streak 0 → dust mult 1
            expect(firstFlags[0]).to.equal(true);
            expect(streaks[0]).to.equal(0n);
            expect(events[0].args.correct).to.equal(true);
            expect(events[0].args.scaledWeight).to.be.closeTo(powers[0] * 1n, SCALED_WEIGHT_TOLERANCE);

            // event 3: streak 0 again (post-reset, NOT first) → same flat dust, not 0.
            // Pre-C-2 this was the inconsistency: only a first-ever prediction paid
            // anything at streak 0, so only it could take a bounty boost.
            expect(firstFlags[3]).to.equal(false);
            expect(streaks[3]).to.equal(0n);
            expect(events[3].args.correct).to.equal(true);
            expect(events[3].args.scaledWeight).to.be.closeTo(powers[3] * 1n, SCALED_WEIGHT_TOLERANCE);

            // event 1: streak 1 (below the floor-4 bar) → dust weight from the S-curve mirror
            expect(streaks[1]).to.equal(1n);
            expect(events[1].args.correct).to.equal(true);
            const expMult1 = expectedMultiplier(streaks[1], bars[1], firstFlags[1]);
            const expWeight1 = powers[1] * expMult1;
            expect(events[1].args.scaledWeight).to.be.closeTo(expWeight1, weightTol(expMult1));
        });
    });

    describe("adaptive threshold behaviour", function () {
        it("bootstraps a fresh game to the floor (2) and never dips below it", async function () {
            // First predict bootstraps the game's threshold to DEFAULT_FLOOR = 2.
            await registry.setValue(streamId, 100);
            await satori.connect(alice).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(UP) }]);
            const gs = await engine.gameStreakState(streamId);
            expect(gs.threshold).to.equal(2);
        });

        it("the controller raises the bar toward a lone above-threshold predictor's streak", async function () {
            // A single predictor climbing a streak is 100% above the (power-weighted) bar
            // every round → the controller keeps nudging the threshold up (it tracks her streak).
            const { bars } = await buildStreak(9);
            const start = Number(bars[2]);
            const end = Number(bars[bars.length - 1]);
            expect(end).to.be.greaterThan(start);
            for (const t of bars) expect(Number(t)).to.be.greaterThanOrEqual(2);
        });

        it("an at/above-bar streak earns at least the entry W(h)=h/(g+1) (differentiated, non-dust)", async function () {
            const { streaks, bars } = await buildStreak(9);
            for (let i = 0; i < bars.length; i++) {
                if (Number(streaks[i]) >= Number(bars[i])) {
                    expect(expectedMultiplier(streaks[i], bars[i], false))
                        .to.be.greaterThanOrEqual((SCALE * BigInt(bars[i])) / (DEF_G + 1n)); // >= W(h)=h/(g+1)
                }
            }
        });
    });

    describe("scoring behaviour (unchanged by the curve)", function () {
        it("incorrect prediction emits scaledWeight 0 and resets streak to 0; first-prediction hook preserved", async function () {
            // P1: first-ever predict (dust mult 1) against anchor 100.
            await registry.setValue(streamId, 100);
            await satori.connect(alice).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(UP) }]);
            await advanceCadencePeriod();
            // P2: @ 200 — the AB post for P1, so it scores P1 CORRECT (100→200 UP).
            // Then predicts again, now committed at streak 1.
            await registry.setValue(streamId, 200);
            await satori.connect(alice).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(UP) }]);
            await advanceCadencePeriod();
            // P3: value drops to 50 — the AB post for P2, so it scores P2 WRONG
            // (UP but 200→50 is DOWN) and resets the streak.
            await registry.setValue(streamId, 50);
            await satori.connect(alice).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(UP) }]);
            await advanceCadencePeriod();

            const events = await engine.queryFilter(engine.filters.PredictionScored(alice.address, streamId));
            expect(events.length).to.equal(2);
            // P1 correct, streak 1; committed with the first-prediction hook (mult 1).
            expect(events[0].args.correct).to.equal(true);
            expect(events[0].args.streak).to.equal(1n);
            expect(events[0].args.scaledWeight).to.be.closeTo(
                ALICE_BALANCE * 1n, SCALED_WEIGHT_TOLERANCE);
            // P2 wrong, streak reset, weight 0.
            expect(events[1].args.correct).to.equal(false);
            expect(events[1].args.streak).to.equal(0n);
            expect(events[1].args.scaledWeight).to.equal(0n);
        });
    });
});
