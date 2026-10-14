#!/usr/bin/env node
/*
 * Payout-curve simulation — tunes the rational S-curve + adaptive dust-threshold
 * controller constants (design: docs/design/payout-curve-redesign.md).
 *
 * Faithfully mirrors the on-chain logic (SatoriEngine._streakWeight): the tunable rational
 * S-curve W(s,h,g,r,b)·SCALE at the compiled dial defaults (g=3, r=3, b=0), h = threshold:
 *   s==0 → first?1:0 ; s<h → SCALE·h·s/((r+1)(h+r(h−s))) ;
 *   s>=h → SCALE·h·((s−h)(g²+g+1)+g·h)/((g+1)(s+h(g−1))) + b·SCALE
 * (anchors W(0)=0, W(h)=h/(g+1)+b; h = the floored adaptive bar)
 * plus the one-signed-accumulator threshold controller (±1/round, floor-clamped).
 *
 * Population: power-law holdings (Pareto) + skewed skill (most near chance, few
 * expert) → geometric streaks. Evolves round-by-round; correct predictors split
 * the pool by power·multiplier. Reports: converged threshold + wobble, dust
 * power-share vs target, dust PAYOUT leak, faucet leak (low-skill payout share),
 * and concentration (Gini, top shares) — S-curve vs the OLD Fibonacci/quad curve.
 *
 * Deterministic (seeded) so results are reproducible. No chain, pure JS.
 */

// ---- deterministic RNG (mulberry32) ----
function mkrng(seed) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

const CURVE_SCALE = 1_000_000; // integer precision; cancels in the normalized payout
const DEF_G = 3, DEF_R = 12, DEF_B = 0; // curve dial defaults (topGradient / bottomGradient / topShift)

// NEW curve: tunable rational S-curve W(s,h,g,r,b)·SCALE (design §A) at the dial defaults.
// Cheap (mul/div, no sqrt); h = the bar (threshold). Anchors W(0)=0, W(h)=h/(g+1)+b; the
// top saturates toward h·(g²+g+1)/(g+1)+b. (Floats here — Gini is scale-invariant.)
function multNew(streak, threshold, g = DEF_G, r = DEF_R, b = DEF_B) {
    const s = streak, h = threshold;
    if (s === 0) return 0;                                                    // (first-prediction hook = 1; negligible)
    if (s < h) return CURVE_SCALE * h * s / ((r + 1) * (h + r * (h - s)));    // convex dust ramp → 0
    return CURVE_SCALE * h * ((s - h) * (g * g + g + 1) + g * h) / ((g + 1) * (s + h * (g - 1))) + b * CURVE_SCALE; // saturating top
}
// OLD curve: Fib×100 (2..12), streak²×100 (>=13), 0 below 2, 25 at 1.
const FIB = [0, 25, 100, 200, 300, 500, 800, 1300, 2100, 3400, 5500, 8900, 14400];
function multOld(streak) { if (streak <= 0) return 0; if (streak < FIB.length) return FIB[streak]; return streak * streak * 100; }

function gini(xs) {
    const a = xs.filter(x => x > 0).sort((p, q) => p - q);
    if (a.length === 0) return 0;
    let cum = 0, s = 0; const n = a.length; const tot = a.reduce((x, y) => x + y, 0);
    for (let i = 0; i < n; i++) { cum += a[i]; s += cum; }
    // Gini = (n+1 - 2*Σ_i cum_i/tot) / n
    return (n + 1 - 2 * (s / tot)) / n;
}
function topShare(payouts, frac) {
    const a = [...payouts].sort((p, q) => q - p);
    const k = Math.max(1, Math.floor(a.length * frac));
    const tot = a.reduce((x, y) => x + y, 0) || 1;
    return a.slice(0, k).reduce((x, y) => x + y, 0) / tot;
}

// ---- build a population ----
function buildPop(N, rng, { skillCorrPower = true } = {}) {
    const players = [];
    for (let i = 0; i < N; i++) {
        // Pareto power (alpha≈1.2, heavy tail), min 1.
        const u = Math.max(1e-9, rng());
        let power = Math.pow(1 / u, 1 / 1.2);
        // skewed skill: most near 0.5 (chance), few up to ~0.9 (cubic push-down).
        let skill = 0.5 + 0.42 * Math.pow(rng(), 3);
        if (skillCorrPower) power *= 1 + 3 * (skill - 0.5); // skilled tend to hold more (design's power-law #1)
        players.push({ power, skill, streak: 0 });
    }
    return players;
}

// ---- run the controller + payouts for a given curve config ----
function simulate(players, { K, targetBps, floor, step, rounds, burnIn, curve }, rng) {
    const BPS = 10000;
    let threshold = floor;
    const thrHist = [];
    const payoutNew = new Array(players.length).fill(0);
    const POOL = 1000; // arbitrary per-round pool (shares are what matter)
    let dustPayout = 0, faucetPayout = 0, totalPayout = 0;

    for (let r = 0; r < rounds; r++) {
        // (finalize handled inline: nudge from last round's signal at round start)
        let signal = 0;
        // compute weights + accumulate signal (curve dials at their defaults)
        const w = new Array(players.length);
        let sumCorrectW = 0;
        const correct = new Array(players.length);
        for (let i = 0; i < players.length; i++) {
            const p = players[i];
            const below = p.streak < threshold;
            signal += p.power * (below ? (BPS - targetBps) : -targetBps);
            const m = curve === 'new' ? multNew(p.streak, threshold) : multOld(p.streak);
            w[i] = p.power * m;
            correct[i] = rng() < p.skill;
            if (correct[i]) sumCorrectW += w[i];
        }
        // payouts to correct predictors, split by weight
        if (r >= burnIn && sumCorrectW > 0) {
            for (let i = 0; i < players.length; i++) {
                if (!correct[i]) continue;
                const pay = POOL * w[i] / sumCorrectW;
                payoutNew[i] += pay;
                totalPayout += pay;
                if (players[i].streak < threshold) dustPayout += pay;       // below-threshold "dust" winners
                if (players[i].skill < 0.55) faucetPayout += pay;           // low-skill "lucky guesser" winners
            }
        }
        // evolve streaks
        for (let i = 0; i < players.length; i++) {
            players[i].streak = correct[i] ? Math.min(players[i].streak + 1, 16383) : 0;
        }
        // controller nudge (from this round's signal), floor-clamped, ±step
        if (signal > 0) threshold = Math.max(floor, threshold - step);
        else if (signal < 0) threshold += step;
        if (r >= burnIn) thrHist.push(threshold);
    }

    // dust power-fraction at the converged threshold (measure over a fresh stationary pass)
    let belowP = 0, totP = 0;
    for (const p of players) { totP += p.power; if (p.streak < Math.round(median(thrHist))) belowP += p.power; }

    return { payoutNew, thrHist, dustPayoutShare: dustPayout / (totalPayout || 1), faucetShare: faucetPayout / (totalPayout || 1), dustPowerFrac: belowP / totP };
}
function median(a) { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; }
function mean(a) { return a.reduce((x, y) => x + y, 0) / (a.length || 1); }
function std(a) { const m = mean(a); return Math.sqrt(mean(a.map(x => (x - m) ** 2))); }

// ---- sweep ----
const N = 5000, ROUNDS = 1500, BURN = 300;
console.log(`Population N=${N}, rounds=${ROUNDS} (burn-in ${BURN}). Power-law holdings + skewed skill (skill-correlated power).\n`);

// ---- 1. OLD vs NEW head-to-head (same population), de-amplification + faucet ----
console.log("== 1. OLD vs NEW (noisy population; rational S-curve, target=3300, floor=4) ==");
for (const curve of ['old', 'new']) {
    const rng = mkrng(12345); const pop = buildPop(N, rng, {});
    const res = simulate(pop, { K: 1000, targetBps: 3300, floor: 4, step: 1, rounds: ROUNDS, burnIn: BURN, curve }, rng);
    console.log(`${curve.toUpperCase().padEnd(4)}  Gini=${gini(res.payoutNew).toFixed(3)}  top1%=${(topShare(res.payoutNew, 0.01) * 100).toFixed(1)}%  top10%=${(topShare(res.payoutNew, 0.10) * 100).toFixed(1)}%  sub-real-band leak=${(res.dustPayoutShare * 100).toFixed(2)}%  low-skill share=${(res.faucetShare * 100).toFixed(1)}%`);
}

// ---- 2. Controller activates on a SKILLED field (raises the bar above the floor) ----
console.log("\n== 2. Controller adapts to field skill (K=1000, target=2800, floor=2) ==");
function buildSkilled(N, rng, base) { const p = buildPop(N, rng, {}); for (const x of p) x.skill = base + (0.98 - base) * Math.pow(rng(), 1.5); return p; }
for (const [label, base] of [['noisy (skill~0.5)', null], ['skilled (skill~0.7)', 0.6], ['expert (skill~0.85)', 0.8]]) {
    const rng = mkrng(777);
    const pop = base === null ? buildPop(N, rng, {}) : buildSkilled(N, rng, base);
    const res = simulate(pop, { K: 1000, targetBps: 2800, floor: 2, step: 1, rounds: ROUNDS, burnIn: BURN, curve: 'new' }, rng);
    console.log(`${label.padEnd(20)}  converged threshold=${median(res.thrHist)}±${std(res.thrHist).toFixed(2)}  dustPowerFrac=${(res.dustPowerFrac * 100).toFixed(0)}%`);
}

// ---- 3. Floor sweep (the binding knob for noisy fields) — faucet vs breadth ----
console.log("\n== 3. Floor sweep (noisy population; K=1000, target=2800) — faucet vs earner breadth ==");
console.log("floor   dustPowerFrac   faucetShare(low-skill)   dustPayoutLeak   Gini");
for (const floor of [2, 3, 4]) {
    const rng = mkrng(12345); const pop = buildPop(N, rng, {});
    const res = simulate(pop, { K: 1000, targetBps: 2800, floor, step: 1, rounds: ROUNDS, burnIn: BURN, curve: 'new' }, rng);
    console.log(`${String(floor).padEnd(6)}  ${(res.dustPowerFrac * 100).toFixed(0).padStart(9)}%      ${(res.faucetShare * 100).toFixed(1).padStart(10)}%             ${(res.dustPayoutShare * 100).toFixed(2).padStart(6)}%       ${gini(res.payoutNew).toFixed(3)}`);
}

// ---- 4. K sweep (dust leak) ----
console.log("\n== 4. K sweep (noisy; target=2800, floor=2) — dust-cliff leak ==");
console.log("K        dustPayoutLeak");
for (const K of [100, 1000, 10000]) {
    const rng = mkrng(12345); const pop = buildPop(N, rng, {});
    const res = simulate(pop, { K, targetBps: 2800, floor: 2, step: 1, rounds: ROUNDS, burnIn: BURN, curve: 'new' }, rng);
    console.log(`${String(K).padEnd(7)}  ${(res.dustPayoutShare * 100).toFixed(3)}%`);
}
