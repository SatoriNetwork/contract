// Seeds a LOCAL chain with FOUR MONTHS of plausible history — 120 rounds at
// 24h each — driven the way real players would drive it: nobody sets anything up in
// advance, streams get opened a few rounds in by whichever player felt like it,
// people change their votes, delegators come and go, and predictions are guesses
// that are often wrong.
//
//   HARDHAT_URL=http://127.0.0.1:3033 npx hardhat run scripts/seed-demo-activity.js --network localhost
//   ROUNDS=120 npx hardhat run scripts/seed-demo-activity.js --network localhost
//
// Every action goes through the ordinary public entry points a human would hit —
// hub.createSimpleDataStream / hub.vote / engine.predictMultipleWithPayloads
// / engine.settlePrediction / hub.delegatePredictionPower — so the resulting state
// is reachable in production, not something only a script could produce.
//
// SKILL IS REAL, NOT RANDOM. Each stream's price path is generated up front, so a
// predictor's "skill" is the probability they call the direction the path is
// actually about to take, so a good predictor earns visibly more for the
// delegators behind them than a coin-flipper does.
//
// SCORING. These are 1440-minute (every-round) streams, so their binary games
// score on the ABC band: the movement between the first two values written
// after the prediction round. Direction is therefore decided by the upcoming
// writes, which is exactly
// what the pre-generated path lets a skilled predictor see.
//
// DELEGATION. Delegators are SEPARATE accounts by necessity: delegating
// transfer-locks the balance and zeroes getPredictionPower, so a delegator cannot
// also predict. The cast covers long tenure, a late joiner on identical terms, a
// mid-run switcher chasing performance, a hot/cold pair using setAllowedDelegator,
// and one who drifts in and out repeatedly and so never builds any tenure at all.
//
// Deterministic: a seeded LCG, never Math.random, so re-runs reproduce the same two
// months and screenshots stay comparable.
//
// NOTE: enables ALL capability flags first. They ship OFF (progressive rollout), so
// a fresh deploy will not let a normal account create a stream at all. Local only.
const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

const ROUNDS = Number(process.env.ROUNDS || 120); // 120 rounds x 24h = ~120 days
const ROUND_SECONDS = 86400;
// The streams are 1440-minute (one-round) cadence, so they COULD post every
// round; the script keeps its own two-round write rhythm (CADENCE = 2), which
// just over-waits harmlessly.
const CADENCE = 2;              // in ROUNDS, for the script's own scheduling
const CADENCE_MINUTES = 1440;   // the stream's on-chain cadence, in minutes
const UP = "0x01";
const DOWN = "0x02";

let _s = 0x2f6e2b1;
const rnd = () => ((_s = (_s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = (a) => a[Math.min(a.length - 1, Math.floor(rnd() * a.length))];

const advance = async () => {
  await ethers.provider.send("evm_increaseTime", [ROUND_SECONDS]);
  await ethers.provider.send("evm_mine", []);
};
const tryTx = async (fn) => { try { await (await fn()).wait(); return true; } catch { return false; } };

// A price path with mild momentum, generated up front so skill can be real.
// One entry per cadence write.
function makePath(start, steps) {
  const out = [start];
  let v = start, mom = 0;
  for (let i = 1; i <= steps; i++) {
    mom = mom * 0.6 + (rnd() - 0.5);
    const step = v * (0.004 + Math.abs(mom) * 0.05);
    v = Math.max(1, Math.round(v + (mom > 0 ? step : -step)));
    if (v === out[i - 1]) v += 1; // never flat: a flat AB window VOIDS the prediction
    out.push(v);
  }
  return out;
}

async function main() {
  const raw = require("../deployments/localhost.json");
  const book = raw.addresses || raw;
  const [deployer, ...rest] = await ethers.getSigners();

  const hub = await ethers.getContractAt("SatoriHub", book.hub);
  const engine = await ethers.getContractAt("SatoriEngine", book.engine);
  const token = await ethers.getContractAt("SatoriToken", book.token);
  const registry = await ethers.getContractAt("SatoriRegistry", book.registry);
  const games = await ethers.getContractAt("SatoriGames", book.games);
  const rewards = await ethers.getContractAt("SatoriRewards", book.rewards);
  const voting = await ethers.getContractAt("SatoriVoting", book.voting);

  // ---- cast -------------------------------------------------------------
  // Predictors, with a real spread of skill. `skill` is the probability of calling
  // the direction the pre-generated path actually takes; `appetite` is how often
  // they bother playing at all.
  const P = [
    { n: "Oracle",  hold: "70", skill: 0.80, appetite: 0.90 },
    { n: "Sage",    hold: "60", skill: 0.66, appetite: 0.85 },
    { n: "Alice",   hold: "52", skill: 0.56, appetite: 0.80 },
    { n: "Bob",     hold: "46", skill: 0.50, appetite: 0.75 },
    { n: "Carol",   hold: "42", skill: 0.50, appetite: 0.70 },
    { n: "Dave",    hold: "38", skill: 0.45, appetite: 0.80 },
    { n: "Erin",    hold: "34", skill: 0.40, appetite: 0.65 },
    { n: "Mallory", hold: "30", skill: 0.52, appetite: 0.45 }, // sporadic
  ];
  P.forEach((p, i) => { p.s = rest[i]; });

  // Delegators. NONE of them predict — delegating zeroes prediction power.
  const D = [
    { n: "Frank", hold: "45" },   // -> Oracle at r2, never moves. Max tenure.
    { n: "Grace", hold: "36" },   // -> Bob, then chases Oracle at r60. Resets to 0.
    { n: "Heidi", hold: "32" },   // -> Oracle at r84. Frank's terms, 82 rounds later.
    { n: "Ivan",  hold: "28" },   // -> Erin (hot/cold pair; Erin locks to Ivan).
    { n: "Judy",  hold: "24" },   // drifts in and out; never builds tenure.
    { n: "Niaj",  hold: "20" },   // -> Sage, mid-run.
  ];
  D.forEach((d, i) => { d.s = rest[P.length + i]; });

  const byName = (n) => P.find((p) => p.n === n);

  // The deployer holds INITIAL_MINT minus whatever deployment itself consumed,
  // so check the cast fits BEFORE funding anyone — a mid-way ERC20 failure leaves
  // a half-funded chain that looks seeded and is not.
  const need = [...P, ...D].reduce((a, x) => a + Number(x.hold), 0);
  const have = Number(ethers.formatEther(await token.balanceOf(deployer.address)));
  if (need > have) {
    throw new Error(`cast needs ${need} SATORI, deployer holds ${have.toFixed(2)} — lower the holdings`);
  }
  console.log(`== budget: ${need} of ${have.toFixed(2)} SATORI ==`);

  console.log("== enabling capability flags (local demo only) ==");
  // bits 0..7 — EIGHT capabilities. Local demo only; never near a real deploy.
  await (await rewards.connect(deployer).setCapabilities(0xff)).wait();

  console.log("== funding predictors ==");
  for (const p of P) {
    await (await token.transfer(p.s.address, ethers.parseEther(p.hold))).wait();
    await (await token.connect(p.s).approve(book.hub, ethers.MaxUint256)).wait();
    console.log(`   ${p.n.padEnd(8)} ${p.hold.padStart(3)} SATORI   skill ${(p.skill * 100).toFixed(0)}%`);
  }
  console.log("== funding delegators ==");
  for (const d of D) {
    await (await token.transfer(d.s.address, ethers.parseEther(d.hold))).wait();
    await (await token.connect(d.s).approve(book.hub, ethers.MaxUint256)).wait();
    console.log(`   ${d.n.padEnd(8)} ${d.hold.padStart(3)} SATORI`);
  }

  // Erin closes her door before anyone delegates: her hot wallet accepts Ivan (her
  // own cold wallet) and nobody else. Per-predictor, so nobody else is affected.
  await tryTx(() => hub.connect(byName("Erin").s).setAllowedDelegator(D[3].s.address));
  console.log("   Erin restricted incoming delegation to Ivan");

  // Referral links, as players who invited each other would have.
  await tryTx(() => rewards.connect(P[1].s).setReferral(P[0].s.address));
  await tryTx(() => rewards.connect(P[3].s).setReferral(P[2].s.address));
  await tryTx(() => rewards.connect(D[1].s).setReferral(D[0].s.address));

  // ---- streams ----------------------------------------------------------
  // Not pre-created: each is opened by a different player a few rounds in, so the
  // early rounds are genuinely quiet and the charts start at different points.
  const steps = Math.ceil(ROUNDS / CADENCE) + 8;
  const plan = [
    { round: 1,  by: 0, name: "BTC/USD",  start: 61000 },
    { round: 3,  by: 1, name: "ETH/USD",  start: 3400 },
    { round: 6,  by: 2, name: "SOL/USD",  start: 145 },
    { round: 11, by: 0, name: "Hashrate", start: 720 },
    { round: 24, by: 4, name: "Gas/gwei", start: 18 },
    { round: 40, by: 1, name: "DOGE/USD", start: 41 },
  ].map((p) => ({ ...p, path: makePath(p.start, steps) }));
  const streams = [];

  // ---- delegation schedule ---------------------------------------------
  // `to` is a predictor name; null means undelegate. Judy is the "sometimes
  // delegates, sometimes doesn't" case — every re-entry opens a FRESH period at
  // L = 0, so she never accumulates tenure no matter how long she is around.
  const delegationPlan = [
    { round: 2,  who: "Frank", to: "Oracle" },
    { round: 2,  who: "Grace", to: "Bob"    },
    { round: 3,  who: "Ivan",  to: "Erin"   },
    { round: 8,  who: "Judy",  to: "Sage"   },
    { round: 20, who: "Niaj",  to: "Sage"   },
    { round: 30, who: "Judy",  to: null     },
    { round: 46, who: "Judy",  to: "Alice"  },
    { round: 60, who: "Grace", to: "Oracle" }, // chases performance
    { round: 70, who: "Judy",  to: null     },
    { round: 84, who: "Heidi", to: "Oracle" }, // Frank's terms, 82 rounds later
    { round: 96, who: "Judy",  to: "Oracle" },
  ];

  console.log(`== simulating ${ROUNDS} rounds (~${ROUNDS} days) ==`);
  const pending = P.map(() => ({}));

  for (let r = 0; r < ROUNDS; r++) {
    await advance();
    const cadenceRound = (r % CADENCE) === 0;

    // Someone opens a new stream once their round comes up. This can legitimately
    // FAIL — paying the creation burn is a transferFrom, and a player who predicted
    // last round is still transfer-locked — so a failed attempt stays queued and
    // they simply try again tomorrow, as a real person would.
    for (const p of plan.filter((x) => !x.done && x.round <= r)) {
      const creator = P[p.by].s;
      let rc;
      try {
        rc = await (await hub.connect(creator)["createSimpleDataStream(string,address,uint24)"](
          p.name, creator.address, CADENCE_MINUTES)).wait();
      } catch { continue; }
      p.done = true;
      let sid = 0;
      for (const log of rc.logs) {
        try {
          const parsed = registry.interface.parseLog(log);
          if (parsed && parsed.name === "DataStreamCreated") { sid = Number(parsed.args.streamId); break; }
        } catch {}
      }
      const gid = Number(await games.binaryGameByStream(sid));
      streams.push({ ...p, creator, sid, gid, k: 0 });
      console.log(`   r${r}: ${P[p.by].n} opened ${p.name} — stream #${sid}`);
      // Games are born unapproved; without the rewards admin's approval every
      // vote reverts GameNotApproved and the seed produces zero reward flow.
      await (await voting.connect(deployer).setGameApproved(gid, true)).wait();
      await tryTx(() => hub.connect(creator).vote(gid, ethers.parseEther("3")));
    }
    if (streams.length === 0 || !cadenceRound) continue;

    // Providers post this cadence step's value.
    for (const s of streams) {
      if (await tryTx(() => registry.connect(s.creator).setValue(s.sid, s.path[s.k]))) s.k++;
    }

    // Settle what is outstanding — a new value now exists, so AB can resolve.
    for (let u = 0; u < P.length; u++) {
      for (const gid of Object.keys(pending[u])) {
        await tryTx(() => engine.settlePrediction(P[u].s.address, Number(gid)));
      }
      pending[u] = {};
    }

    // Delegation events fire BEFORE this round's predictions, so the delegator
    // lands in that round's frozen split snapshot rather than being deferred.
    for (const d of delegationPlan.filter((x) => !x.done && x.round <= r)) {
      const who = D.find((x) => x.n === d.who).s;
      const target = d.to === null ? ethers.ZeroAddress : byName(d.to).s.address;
      if (await tryTx(() => hub.connect(who).delegatePredictionPower(target))) {
        d.done = true;
        console.log(`   r${r}: ${d.who} ${d.to === null ? "UNDELEGATED" : "-> " + d.to}`);
      }
    }

    // Players drift their votes. Burn voting DESTROYS the stake, so these are
    // small — a player who burns their balance away cannot predict at all.
    for (const p of P) {
      if (rnd() < 0.06) await tryTx(() => hub.connect(p.s).vote(pick(streams).gid, ethers.parseEther("1")));
    }

    // And they guess, on up to THREE streams in one batch (the core allows a single
    // predict per round, so multi-stream play has to be batched).
    for (let u = 0; u < P.length; u++) {
      const p = P[u];
      if (rnd() > p.appetite) continue; // sat this one out
      const n = 1 + (rnd() < 0.7 ? 1 : 0) + (rnd() < 0.35 ? 1 : 0);
      const pool = streams.slice();
      const picks = [];
      for (let i = 0; i < n && pool.length; i++) {
        picks.push(pool.splice(Math.min(pool.length - 1, Math.floor(rnd() * pool.length)), 1)[0]);
      }
      const batch = picks.map((t) => {
        // AB scoring: anchor is the value just written (path[k-1]), post is the next
        // write (path[k]). The truth is therefore knowable here — skill decides
        // whether this player calls it.
        const anchor = t.path[t.k - 1], next = t.path[t.k];
        const truth = next > anchor ? UP : DOWN;
        const wrong = truth === UP ? DOWN : UP;
        return { gameId: t.gid, payload: rnd() < p.skill ? truth : wrong };
      });
      if (await tryTx(() => engine.connect(p.s).predictMultipleWithPayloads(batch))) {
        for (const t of picks) pending[u][t.gid] = true;
      }
    }
    if ((r + 1) % 30 === 0) console.log(`   ...${r + 1}/${ROUNDS} rounds`);
  }

  // Let the tail resolve so the final bets are scored rather than left hanging.
  for (let i = 0; i < 6; i++) {
    await advance();
    if (i % CADENCE !== 0) continue;
    for (const s of streams) {
      if (await tryTx(() => registry.connect(s.creator).setValue(s.sid, s.path[s.k]))) s.k++;
    }
  }
  for (let u = 0; u < P.length; u++) {
    for (const s of streams) await tryTx(() => engine.settlePrediction(P[u].s.address, s.gid));
  }

  // Delegator rewards are credited by the claim walk; claim once so balances show them.
  for (const d of D) await tryTx(() => hub.connect(d.s).claim());

  // ---- summary ----------------------------------------------------------
  console.log("\n== predictors after two months ==");
  for (const p of P) {
    const bal = Number(ethers.formatEther(await token.balanceOf(p.s.address)));
    const unclaimed = Number(ethers.formatEther(await rewards.unclaimedRewards(p.s.address)));
    const inbound = Number(ethers.formatEther((await rewards.predictionDelegateInfo(p.s.address)).power));
    const st = [];
    for (const s of streams) {
      const k = Number(await engine.streaks(p.s.address, s.gid));
      if (k > 0) st.push(`${s.name}:${k}`);
    }
    console.log(`   ${p.n.padEnd(8)} skill ${(p.skill * 100).toFixed(0).padStart(3)}%  bal ${bal.toFixed(1).padStart(8)}` +
      `  unclaimed ${unclaimed.toFixed(1).padStart(9)}  deleg-in ${inbound.toFixed(0).padStart(4)}  ${st.join(" ")}`);
  }

  console.log("\n== delegators ==");
  for (const d of D) {
    const a = d.s.address;
    const n = Number(await rewards.delegationPeriodsLength(a));
    let to = "(none)", since = "-";
    if (n > 0) {
      const per = await rewards.delegationPeriodAt(a, n - 1);
      if (Number(per[2]) === 0) {
        const t = P.find((p) => p.s.address.toLowerCase() === per[0].toLowerCase());
        to = t ? t.n : per[0].slice(0, 8);
        since = String(per[1]);
      } else { to = "(left)"; }
    }
    const bal = Number(ethers.formatEther(await token.balanceOf(a)));
    console.log(`   ${d.n.padEnd(6)} -> ${to.padEnd(8)}` +
      `  periods ${String(n).padStart(2)}  since r${since.padEnd(7)} bal ${bal.toFixed(1).padStart(7)}`);
  }

  // Publish the cast so the dapp's dev account switcher can label these signers
  // by who they actually are. Written here rather than hardcoded in the UI: the
  // UI would otherwise carry a copy of this cast that rots the moment it changes,
  // and the switcher is the only way to reach a delegator at all.
  try {
    const cast = [
      { index: 0, name: "Owner", role: "deployer / admin" },
      ...P.map((p, i) => ({
        index: 1 + i,
        name: p.n,
        role: `predictor ${(p.skill * 100).toFixed(0)}%`,
      })),
      ...D.map((d, i) => {
        const n = P.length + 1 + i;
        const t = delegationPlan.filter((x) => x.who === d.n && x.done).pop();
        return {
          index: n,
          name: d.n,
          role: t && t.to ? `delegator -> ${t.to}` : "delegator",
        };
      }),
    ];
    const out = path.join(__dirname, "..", "..", "satori-ui", "public", "dev-cast.json");
    fs.writeFileSync(out, JSON.stringify(cast, null, 2));
    console.log(`   cast published -> satori-ui/public/dev-cast.json (${cast.length} accounts)`);
  } catch (e) {
    console.log(`   (could not publish dev cast: ${e.message})`);
  }

  const total = Number(await registry.getDataStreamCount());
  console.log(`\n   ${streams.length} base streams + derived = ${total} total; round ${await token.getCurrentRound()}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
