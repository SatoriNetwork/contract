// Long-run economy simulation: a fresh local chain, ~40 participants who all behave
// differently, hundreds of daily rounds, and an independent model (model.js) that
// checks every prediction, score, reward, referral cut, delegator payout and claim.
//
//   SIM_ROUNDS=300 SIM_SEED=7 npx hardhat run simulation/economy/run.js
//
// Exits non-zero if any check fails. Writes a report to SIM_REPORT (default
// simulation/economy/last-run.md).
const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { makeRng } = require("../rng");
const W = require("./world");
const { Model } = require("./model");
const { cast } = require("./agents");

const ROUNDS = Number(process.env.SIM_ROUNDS || 300);
const SEED = Number(process.env.SIM_SEED || 7);
const REPORT = process.env.SIM_REPORT || path.join(__dirname, "last-run.md");
const E = (x) => ethers.parseEther(String(x));
const fmt = (v, d = 4) => Number(ethers.formatEther(v)).toFixed(d);

async function main() {
  const t0 = Date.now();
  const rng = makeRng(SEED);
  console.log(`\n=== Satori economy simulation: seed ${SEED}, ${ROUNDS} rounds ===\n`);
  const world = await W.deployWorld(rng, ROUNDS);
  const { hub, token, rewards, voting, registry, engine, owner, streams } = world;
  const byName = new Map(streams.map((s) => [s.name, s]));

  // Event decoding across every contract a receipt can touch.
  const ifaces = [engine, rewards, voting, registry, token, hub].map((c) => [c.target.toLowerCase(), c.interface]);
  const parse = (log) => {
    for (const [addr, i] of ifaces) if (log.address.toLowerCase() === addr) { try { return i.parseLog(log); } catch { return null; } }
    return null;
  };

  const [f, g, r, b] = await engine.curveConfig();
  const model = new Model(world, {
    f: BigInt(f), g: BigInt(g), r: BigInt(r), b: BigInt(b),
    dustTarget: BigInt(await engine.dustTargetBps()),
    farmingThreshold: BigInt(await hub.farmingThreshold()),
    devBps: BigInt(await token.devFeeBps()),
    baseEmission: BigInt(await hub.emissionRateNow()),
    marketing: await rewards.marketingFeeRecipient(),
  });
  model.splitInfo = new Map();
  for (const s of streams) model.setInitialVotes(s.gameId, BigInt(await voting.weightOf(s.gameId)));

  let clock = { round: 0, hour: 0 };
  const unexpected = []; // reverts nobody planned
  const expectedReverts = { asked: 0, got: 0 };
  const send = async (label, fn, pre = {}) => {
    try {
      const tx = await fn();
      const rc = await tx.wait();
      model.onReceipt(rc, parse, pre, clock);
      return rc;
    } catch (e) {
      const m = (e.message || "").match(/reverted with custom error '([^']+)'|reverted with reason string '([^']+)'/);
      const reason = (m && (m[1] || m[2])) || (e.shortMessage || e.message || "").slice(0, 120);
      if (pre.expectRevert) { expectedReverts.got++; if (!new RegExp(pre.expectRevert).test(reason)) unexpected.push({ label, reason: `expected ${pre.expectRevert}, got ${reason}`, ...clock }); }
      else unexpected.push({ label, reason, ...clock });
      return null;
    }
  };

  // ---- seat the cast ----
  const agents = cast();
  const byAgent = new Map();
  for (let i = 0; i < agents.length; i++) {
    const a = agents[i];
    a.wallet = new ethers.Wallet(ethers.id(`satori-sim-${SEED}-${i}`), ethers.provider);
    a.address = a.wallet.address;
    await network.provider.send("hardhat_setBalance", [a.address, "0x56BC75E2D63100000"]);
    byAgent.set(a.name, a);
  }
  model.names = new Map(agents.map((a) => [a.address.toLowerCase(), a.name]));
  const startBal = new Map();
  for (const a of agents) {
    if (a.stake > 0) await (await token.connect(owner).transfer(a.address, E(a.stake))).wait();
    startBal.set(a.address.toLowerCase(), BigInt(await token.balanceOf(a.address)));
  }
  const supply0 = BigInt(await token.totalSupply());
  const devFee0 = BigInt(await token.devFeeAccrued());
  const flows = new Map(); // address -> { burned, sentOut, received }
  const flow = (a) => { const k = a.toLowerCase(); if (!flows.has(k)) flows.set(k, { burned: 0n, out: 0n, in: 0n }); return flows.get(k); };

  // The owner gives the three markets some vote weight so they pay; COLD gets none.
  for (const [name, amt] of [["ALPHA", 4], ["BETA", 3], ["GAMMA", 3]]) {
    await (await token.connect(owner).approve(hub.target, E(amt))).wait();
    await send("owner vote", () => hub.connect(owner).vote(byName.get(name).gameId, E(amt)));
  }
  for (const a of agents) {
    if (a.votes) await (await token.connect(a.wallet).approve(hub.target, ethers.MaxUint256)).wait();
    if (a.referral) { await (await rewards.connect(a.wallet).setReferral(byAgent.get(a.referral).address)).wait(); model.setReferral(a.address, byAgent.get(a.referral).address); }
    if (a.feeBps != null) await (await rewards.connect(a.wallet).setPredictorFee(a.feeBps)).wait();
  }

  // ---- the clock: start at a UTC midnight ----
  const startTs = Math.floor((await time.latest()) / W.DAY) * W.DAY + W.DAY;
  const startHour = startTs / W.HOUR;
  const setHour = async (h) => { await time.increaseTo(h * W.HOUR + 1); clock = { round: Math.floor(h / 24), hour: h }; };

  const slotOf = (h) => Math.floor((h - startHour) / W.WRITE_EVERY_HOURS);
  const truth = (s, h) => {
    if (s.named) return 0;
    const a = W.pathValue(world, s.name, slotOf(h));
    const p = W.pathValue(world, s.name, slotOf(h + 23) + 1);
    return p > a ? 1 : p < a ? -1 : 0;
  };
  const lastMove = (s) => {
    const es = model.entries.get(s.streamId) || [];
    if (es.length < 2) return 0;
    const d = es[es.length - 1].value - es[es.length - 2].value;
    return d > 0n ? 1 : d < 0n ? -1 : 0;
  };
  const yesterdayMajority = (s) => {
    const t = model.totals.get(`${s.gameId}|${clock.round - 1}`);
    if (!t || t.up === t.down) return 0;
    return t.up > t.down ? 1 : -1;
  };
  const chooseDir = (a, s) => {
    const flip = () => (rng.bool() ? 1 : 2);
    const toDir = (sgn) => (sgn > 0 ? 1 : sgn < 0 ? 2 : flip());
    switch (a.dir.kind) {
      case "skill": { const t = truth(s, clock.hour); if (t === 0) return flip(); return rng.bool(a.dir.p) ? toDir(t) : toDir(-t); }
      case "up": return 1;
      case "down": return 2;
      case "momentum": return toDir(lastMove(s));
      case "contrarian": return toDir(-lastMove(s));
      case "herd": return toDir(yesterdayMajority(s));
      case "antiherd": return toDir(-yesterdayMajority(s));
      default: return flip();
    }
  };

  const predict = async (a) => {
    const names = typeof a.games === "function" ? a.games(clock.round - startHour / 24) : a.games;
    const entries = names.map((n) => byName.get(n)).map((s) => ({ s, dir: chooseDir(a, s) }));
    const pre = { power: BigInt(await rewards.getPredictionPower(a.address)), weightOf: {}, eligibleCount: 0 };
    for (const { s } of entries) { const w = BigInt(await voting.weightOf(s.gameId)); pre.weightOf[s.gameId] = w; if (w !== 0n) pre.eligibleCount++; }
    const rc = await send(`${a.name} predict`, () => engine.connect(a.wallet).predictMultipleWithPayloads(
      entries.map(({ s, dir }) => ({ gameId: s.gameId, payload: "0x0" + dir }))), pre);
    if (rc && a.isDelegate) for (const { s } of entries) {
      const [own, del] = await rewards.predictionDelegationInfo(a.address, s.gameId, clock.round);
      model.splitInfo.set(`${a.address.toLowerCase()}|${s.gameId}|${clock.round}`,
        { own: BigInt(own), delegated: BigInt(del), feeBps: BigInt(await rewards.effectivePredictorFee(a.address)) });
    }
    if (a.ruleTester && rc) {
      expectedReverts.asked += 2;
      await send(`${a.name} second batch`, () => engine.connect(a.wallet).predictMultipleWithPayloads([{ gameId: byName.get("ALPHA").gameId, payload: "0x01" }]), { expectRevert: "AlreadyPredicted" });
      await send(`${a.name} unknown game`, () => engine.connect(a.wallet).predictMultipleWithPayloads([{ gameId: 9999, payload: "0x01" }]), { expectRevert: "." });
    }
  };
  const claim = async (a) => {
    const to = a.claimTo ? byAgent.get(a.claimTo).address : a.address;
    // A delegator's walk is capped per call; keep claiming until nothing is left.
    for (let i = 0; i < 20; i++) {
      const rc = await send(`${a.name} claim`, () => hub.connect(a.wallet)["claim(address)"](to));
      if (!rc) break;
      if ((await world.fix.lens.getTotalClaimableRewards(a.address))[0] === 0n) break;
    }
  };
  const settleOpen = async (filter) => {
    for (const [k, list] of model.preds) {
      if (!list.some((p) => p.round < clock.round)) continue;
      const [user, game] = k.split("|");
      if (filter && !filter(user)) continue;
      await send("settle", () => engine.connect(byAgent.get("Keeper").wallet).settlePrediction(user, Number(game)));
    }
  };
  const claimDue = (a, day) => a.claim === "daily" || (a.claim === "weekly" && day % 7 === 6) || (a.claim === "monthly" && day % 30 === 29);

  // Delegators join before day 0's predictions.
  await setHour(startHour - 1);
  for (const a of agents) if (a.delegateTo) await send(`${a.name} delegate`, () => hub.connect(a.wallet).delegatePredictionPower(byAgent.get(a.delegateTo).address));
  for (const a of agents) if (agents.some((x) => x.delegateTo === a.name)) a.isDelegate = true;

  // ---- the days ----
  const writeValues = async (h) => {
    const simple = streams.filter((s) => !s.named);
    const vals = simple.map((s) => W.pathValue(world, s.name, slotOf(h)));
    const wrote = {}; simple.forEach((s, i) => { wrote[s.streamId] = vals[i]; });
    await send("feed", () => registry.connect(owner).setValues(simple.map((s) => s.streamId), vals), { wrote });
    for (const s of simple) {
      const es = model.entries.get(s.streamId) || [];
      if (!es.length || es[es.length - 1].hour !== h) model.fail("feed", `stream ${s.name}: hour ${h} value not written`);
    }
  };
  for (let day = 0; day < ROUNDS + 2; day++) {
    const closing = day >= ROUNDS; // two extra days: nobody plays, everything settles
    for (let hh = 0; hh < 24; hh++) {
      const h = startHour + day * 24 + hh;
      await setHour(h);
      if (hh % W.WRITE_EVERY_HOURS === 0) await writeValues(h);
      if (closing) { await send("poke satori", () => registry.updateValues([1])); continue; }

      for (const a of rng.shuffle([...agents])) {
        if (a.joinFunds && a.joinFunds.day === day && hh === 0) {
          await (await token.connect(owner).transfer(a.address, E(a.joinFunds.amount))).wait();
          startBal.set(a.address.toLowerCase(), startBal.get(a.address.toLowerCase()) + E(a.joinFunds.amount));
        }
        if (a.switches && hh === 1) for (const sw of a.switches) if (sw.day === day) {
          await send(`${a.name} ${sw.to ? "switch" : "leave"}`, () => hub.connect(a.wallet).delegatePredictionPower(sw.to ? byAgent.get(sw.to).address : ethers.ZeroAddress));
        }
        if (a.keeper && hh === 1 && day % 3 === 0) await settleOpen();
        if (a.settle === "self" && hh === 2) await settleOpen((u) => u === a.address.toLowerCase());
        if (a.votes && hh === 5) for (const v of a.votes(day, rng)) {
          const rc = await send(`${a.name} vote`, () => hub.connect(a.wallet).vote(byName.get(v.game).gameId, E(v.amount)));
          if (rc) flow(a.address).burned += E(v.amount);
        }
        if (a.transfers && hh === 6) for (const t of a.transfers(day)) {
          const to = byAgent.get(t.to).address;
          const rc = await send(`${a.name} transfer`, () => token.connect(a.wallet).transfer(to, E(t.amount)));
          if (rc) { flow(a.address).out += E(t.amount); flow(to).in += E(t.amount); }
        }
        if (a.when && !a.passive) {
          if (a.whenDay !== day) { a.whenDay = day; a.whenHour = a.when(day, rng); } // one draw per day
          const at = a.whenHour;
          const delegatedNow = a.delegateTo && !(a.switches && a.switches.some((s) => s.to === null && s.day < day));
          if (at === hh && !delegatedNow && BigInt(await token.balanceOf(a.address)) + BigInt(await rewards.unclaimedRewards(a.address)) > 0n) await predict(a);
        }
        if (hh === 23 && claimDue(a, day)) await claim(a);
      }
    }
    if ((day + 1) % 25 === 0 || day === ROUNDS + 1)
      console.log(`  day ${day + 1}: ${model.stats.predictions} predictions, ${model.stats.rewardsChecked} rewards checked, ${model.failures.length} failed checks, ${unexpected.length} unexpected reverts (${((Date.now() - t0) / 60000).toFixed(1)} min)`);
  }

  // ---- close out: settle everything, everyone claims ----
  await settleOpen();
  for (const a of agents) await claim(a);

  // ---- reconciliation ----
  const perRound = model.conservation();
  const open = [...model.preds.values()].flat();
  if (open.length) model.fail("left-open", `${open.length} predictions never scored`);
  for (const a of agents) {
    const k = a.address.toLowerCase();
    const bal = BigInt(await token.balanceOf(a.address));
    const left = (await world.fix.lens.getTotalClaimableRewards(a.address))[0];
    a.final = bal;
    // Every reward credited to this participant (net of cuts, plus cuts earned as a
    // referrer, plus delegator income) must have been paid out by its claims.
    const credited = model.netCredit.get(k) || 0n;
    const claimedOwn = model.claimed.get(k) || 0n;
    if (credited !== claimedOwn + BigInt(await rewards.unclaimedRewards(a.address)))
      model.fail("claims-pay-credits", `${a.name}: credited ${fmt(credited, 8)}, claimed ${fmt(claimedOwn, 8)}`);
    if (left !== 0n) model.fail("unclaimed-left", `${a.name}: ${fmt(left, 8)} still claimable after the final claims`);
    a.claimedOwn = claimedOwn;
  }
  const mk = model.marketing.toLowerCase();
  const mkLeft = BigInt(await rewards.unclaimedRewards(model.marketing));
  if (mkLeft !== (model.netCredit.get(mk) || 0n)) model.fail("marketing", `marketing wallet holds ${fmt(mkLeft, 8)}, cuts sent ${fmt(model.netCredit.get(mk) || 0n, 8)}`);
  // Balances: start - burns - sent + received + claims paid to this address.
  const claimsTo = new Map();
  for (const a of agents) {
    const to = a.claimTo ? byAgent.get(a.claimTo).address.toLowerCase() : a.address.toLowerCase();
    claimsTo.set(to, (claimsTo.get(to) || 0n) + (a.claimedOwn || 0n));
  }
  for (const a of agents) {
    const k = a.address.toLowerCase(), fl = flow(a.address);
    const exp = startBal.get(k) - fl.burned - fl.out + fl.in + (claimsTo.get(k) || 0n);
    if (a.final !== exp) model.fail("balance", `${a.name}: balance ${fmt(a.final, 8)}, expected ${fmt(exp, 8)}`);
  }
  // Delegators: paid capital x their delegate's rate, round by round (the contract
  // floors once per round walked, and again when it replays a round scored late, so
  // allow a wei per round).
  for (const a of agents.filter((x) => x.delegateTo)) {
    const exp = model.expectedDelegatorIncome(a.address);
    const got = model.delegatorGross.get(a.address.toLowerCase()) || 0n;
    const diff = got > exp ? got - exp : exp - got;
    if (diff > BigInt(2 * (ROUNDS + 2))) model.fail("delegator-income", `${a.name}: pulled ${fmt(got, 8)}, capital x rate gives ${fmt(exp, 8)}`);
    a.delegator = { exp, got };
  }
  const supply1 = BigInt(await token.totalSupply());
  const devFee1 = BigInt(await token.devFeeAccrued());
  if (supply1 !== supply0 + model.claimedTotal - model.burned)
    model.fail("supply", `supply ${fmt(supply1)} != start ${fmt(supply0)} + claims ${fmt(model.claimedTotal)} - burns ${fmt(model.burned)}`);
  if (devFee1 - devFee0 !== model.devFee) model.fail("dev-fee", `token booked ${fmt(devFee1 - devFee0, 8)} dev fee, rules give ${fmt(model.devFee, 8)}`);

  writeReport({ agents, model, perRound, unexpected, expectedReverts, supply0, supply1, minutes: (Date.now() - t0) / 60000 });
  console.log(`\nReport: ${REPORT}`);
  if (model.failures.length || unexpected.length) process.exitCode = 1;
}

function writeReport({ agents, model, perRound, unexpected, expectedReverts, supply0, supply1, minutes }) {
  const s = model.stats;
  const L = [];
  const budgetTotal = [...model.budget.values()].reduce((x, y) => x + y, 0n);
  const creditedTotal = [...perRound.values()].reduce((x, y) => x + y, 0n);
  L.push(`# Satori economy simulation: seed ${SEED}, ${ROUNDS} rounds, ${agents.length} participants`, "");
  L.push(`Ran in ${minutes.toFixed(1)} minutes on a local Hardhat chain.`, "");
  L.push(`## Verdict`, "");
  L.push(model.failures.length || unexpected.length ? `**FAILED**: ${model.failures.length} failed checks, ${unexpected.length} unexpected reverts.` : `**PASSED**: every check held.`, "");
  L.push(`## What was checked`, "");
  L.push(`| Check | Count |`, `|---|---|`);
  L.push(`| Predictions (streak, multiplier on the curve, power split, weight) | ${s.predictions} |`);
  L.push(`| Scored outcomes against the value feed (correct / wrong / void / unrecoverable) | ${s.correct} / ${s.wrong} / ${s.voided} / ${s.unrecoverable} |`);
  L.push(`| Rewards recomputed from the rules and matched to the wei | ${s.rewardsChecked} |`);
  L.push(`| 5% referral cuts (amount and destination) | ${s.referralsChecked} |`);
  L.push(`| Round budgets (emission minus dev fee) | ${s.budgetsChecked} |`);
  L.push(`| Adaptive streak bar moves | ${s.thresholdsChecked} |`);
  L.push(`| Delegator payouts | ${s.delegatorAccruals} |`);
  L.push(`| Displaced predictions (the M22 path) | ${s.displaced} |`);
  L.push(`| Rule probes that had to revert (and did) | ${expectedReverts.got} of ${expectedReverts.asked} |`, "");
  L.push(`Budget over the run: ${fmt(budgetTotal, 2)} SATORI; credited: ${fmt(creditedTotal, 2)} (${budgetTotal ? (Number(creditedTotal * 10000n / budgetTotal) / 100).toFixed(1) : 0}%; wrong and void weight is never issued). Supply ${fmt(supply0, 2)} → ${fmt(supply1, 2)}.`, "");
  if (model.failures.length) { L.push(`## Failed checks`, ""); for (const x of model.failures.slice(0, 60)) L.push(`- **${x.check}**: ${x.detail}`); L.push(""); }
  if (unexpected.length) { L.push(`## Unexpected reverts`, ""); for (const x of unexpected) L.push(`- round ${x.round} hour ${x.hour % 24}: ${x.label}: ${x.reason}`); L.push(""); }
  L.push(`## Participants`, "");
  L.push(`| Who | Behaviour | Start | Predictions | W / L / V | Win % | Best streak | Earned (net) | Final balance |`, `|---|---|---|---|---|---|---|---|---|`);
  for (const a of agents) {
    const u = model.perUser.get(a.address.toLowerCase()) || { predictions: 0, correct: 0, wrong: 0, voided: 0, maxStreak: 0n };
    const decided = u.correct + u.wrong;
    L.push(`| ${a.name} | ${a.persona} | ${a.stake + (a.joinFunds ? a.joinFunds.amount : 0)} | ${u.predictions} | ${u.correct} / ${u.wrong} / ${u.voided} | ${decided ? ((100 * u.correct) / decided).toFixed(0) : "-"} | ${u.maxStreak} | ${fmt(model.netCredit.get(a.address.toLowerCase()) || 0n, 3)} | ${fmt(a.final, 3)} |`);
  }
  L.push("", `Marketing wallet (5% of unreferred earnings): ${fmt(model.netCredit.get(model.marketing.toLowerCase()) || 0n, 3)} credited.`);
  fs.writeFileSync(REPORT, L.join("\n") + "\n");
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
