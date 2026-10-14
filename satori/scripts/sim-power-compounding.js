#!/usr/bin/env node
// Does the dust-threshold knee move once prediction power COMPOUNDS to winners?
//
// WHY THIS EXISTS. `sim-payout-curve.js` holds every player's power FIXED for the whole
// run — it evolves streaks and nothing else. That makes it a static snapshot rerun N
// times, and it is how the "~8000 knee" was derived. On the real chain power is not
// static: prediction power is your SATORI balance plus unclaimed rewards, so every payout
// feeds straight back into the weight you predict with next round. Winners compound.
//
// That is not a theory. Building a behavioural test for the dust-target dial, a two-player
// field that started 50/50 stopped being 50/50 within a few rounds because the winner's
// payouts grew her power until she dominated the round — the test had to be restructured
// around it. The chain does this; the old simulation does not.
//
// The maintainer's argument follows from that: if SATORI accumulates (and is delegated) to
// people who predict well, the field the controller sees is far more top-heavy than a
// static Pareto draw with a capped skill->power correlation, the effective skill `p` rises,
// and since the equilibrium bar is h = ln(1 - target)/ln(p), the bar clears the floor at a
// LOWER target. In short: the knee should move down.
//
// This script tests exactly that, and reports the concentration itself rather than only the
// knee — because if power does not actually concentrate, the knee has no reason to move and
// the conclusion should not be trusted.
//
//   node scripts/sim-power-compounding.js

// ---- RNG + curve (mirrors sim-payout-curve.js so the two are comparable) ----
function mkrng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
const DEF_G = 3, DEF_R = 12, DEF_B = 0;
function multNew(streak, h, g = DEF_G, r = DEF_R, b = DEF_B) {
  const s = streak;
  if (s === 0) return 0.000001;
  if (s < h) return (h * s) / ((r + 1) * (h + r * (h - s)));
  return (h * ((s - h) * (g * g + g + 1) + g * h)) / ((g + 1) * (s + h * (g - 1))) + b;
}
const median = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

// Same population as the original: Pareto power, most skill near chance, and a CAPPED
// skill->power correlation (at most 2.26x). The cap is the thing compounding removes.
function buildPop(N, rng) {
  const players = [];
  for (let i = 0; i < N; i++) {
    const u = Math.max(1e-9, rng());
    let power = Math.pow(1 / u, 1 / 1.2);
    const skill = 0.5 + 0.42 * Math.pow(rng(), 3);
    power *= 1 + 3 * (skill - 0.5);
    players.push({ power, skill, streak: 0 });
  }
  return players;
}

const powerWeightedSkill = (pop) => {
  const t = pop.reduce((a, p) => a + p.power, 0);
  return pop.reduce((a, p) => a + p.power * p.skill, 0) / t;
};

/**
 * @param compound  when true, each round's payout is ADDED to the winner's power, exactly
 *                  as unclaimed rewards count toward prediction power on chain.
 * @param emitFrac  per-round pool as a fraction of the field's INITIAL total power. The
 *                  chain mints 720 SATORI/round against a ~1e6 airdrop supply, so ~7.2e-4
 *                  is the realistic figure; the pool roughly doubles the supply over the
 *                  1500 rounds (~2 years) simulated here.
 */
function simulate(pop, { target, floor, rounds, burnIn, compound, emitFrac }, rng) {
  const players = pop.map((p) => ({ ...p }));
  const BPS = 10000;
  const POOL = players.reduce((a, p) => a + p.power, 0) * emitFrac;
  let threshold = floor;
  const thrHist = [];
  const skillHist = [];
  let dustPayout = 0, faucetPayout = 0, totalPayout = 0;

  for (let r = 0; r < rounds; r++) {
    let signal = 0, sumCorrectW = 0;
    const w = new Array(players.length);
    const correct = new Array(players.length);
    for (let i = 0; i < players.length; i++) {
      const p = players[i];
      signal += p.power * (p.streak < threshold ? (BPS - target) : -target);
      w[i] = p.power * multNew(p.streak, threshold);
      correct[i] = rng() < p.skill;
      if (correct[i]) sumCorrectW += w[i];
    }
    if (sumCorrectW > 0) {
      for (let i = 0; i < players.length; i++) {
        if (!correct[i]) continue;
        const pay = POOL * w[i] / sumCorrectW;
        // THE CHANGE. On chain this is automatic: prediction power counts unclaimed
        // rewards, so a payout is spendable weight next round without any user action.
        if (compound) players[i].power += pay;
        if (r >= burnIn) {
          totalPayout += pay;
          if (players[i].streak < threshold) dustPayout += pay;
          if (players[i].skill < 0.55) faucetPayout += pay;
        }
      }
    }
    for (let i = 0; i < players.length; i++) {
      players[i].streak = correct[i] ? Math.min(players[i].streak + 1, 16383) : 0;
    }
    if (signal > 0) threshold = Math.max(floor, threshold - 1);
    else if (signal < 0) threshold += 1;
    if (r >= burnIn) thrHist.push(threshold);
    if (r % 100 === 0) skillHist.push({ round: r, pws: powerWeightedSkill(players) });
  }
  return {
    bar: median(thrHist),
    leak: dustPayout / (totalPayout || 1),
    faucet: faucetPayout / (totalPayout || 1),
    finalSkill: powerWeightedSkill(players),
    skillHist,
    players,
  };
}

const N = 5000, ROUNDS = 1500, BURN = 300, FLOOR = 2;
const EMIT = 720 / 1e6;   // 720 SATORI/round against the 1e6 airdrop supply

console.log(`N=${N}, rounds=${ROUNDS} (burn-in ${BURN}), floor=${FLOOR}, g=3 r=12 b=0`);
console.log(`per-round pool = ${EMIT} x initial total power (720/round vs the 1e6 airdrop)\n`);

// ---- 1. Does power actually concentrate toward skill? ----
console.log('== 1. Does compounding concentrate power toward skill? ==');
{
  const rng = mkrng(12345);
  const pop = buildPop(N, rng);
  console.log(`  start: power-weighted skill ${powerWeightedSkill(pop).toFixed(3)}`);
  for (const compound of [false, true]) {
    const r2 = mkrng(999);
    const res = simulate(pop, { target: 5000, floor: FLOOR, rounds: ROUNDS, burnIn: BURN, compound, emitFrac: EMIT }, r2);
    const trail = res.skillHist.filter((h) => h.round % 300 === 0).map((h) => `r${h.round}:${h.pws.toFixed(3)}`).join('  ');
    console.log(`  ${compound ? 'COMPOUNDING' : 'static     '}: ${trail}  ->  final ${res.finalSkill.toFixed(3)}`);
  }
}

// ---- 2. Where is the knee, with and without compounding? ----
console.log('\n== 2. Where does the bar leave the floor? (the "knee") ==');
console.log('  target    static bar    compounding bar');
for (const target of [3300, 5000, 6000, 6667, 7500, 8000, 8541, 9000]) {
  const row = [];
  for (const compound of [false, true]) {
    const rng = mkrng(12345);
    const pop = buildPop(N, rng);
    const r2 = mkrng(999);
    const res = simulate(pop, { target, floor: FLOOR, rounds: ROUNDS, burnIn: BURN, compound, emitFrac: EMIT }, r2);
    row.push(res.bar);
  }
  const mark = (b) => (b === FLOOR ? `${b} (floor)` : `${b}`);
  console.log(`  ${String(target).padStart(6)}    ${mark(row[0]).padEnd(13)} ${mark(row[1])}`);
}

// ---- 3. What the shipped 5000 looks like under each assumption ----
console.log('\n== 3. The shipped target (5000) under each assumption ==');
console.log('  model         bar   below-bar leak   lucky-guesser share   power-wtd skill');
for (const compound of [false, true]) {
  const rng = mkrng(12345);
  const pop = buildPop(N, rng);
  const r2 = mkrng(999);
  const res = simulate(pop, { target: 5000, floor: FLOOR, rounds: ROUNDS, burnIn: BURN, compound, emitFrac: EMIT }, r2);
  console.log(`  ${(compound ? 'compounding' : 'static').padEnd(12)} ${String(res.bar).padStart(4)} ` +
    `${(100 * res.leak).toFixed(2).padStart(14)}% ${(100 * res.faucet).toFixed(1).padStart(20)}% ` +
    `${res.finalSkill.toFixed(3).padStart(17)}`);
}
