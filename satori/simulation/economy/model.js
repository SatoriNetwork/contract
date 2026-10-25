// The independent model. It watches every receipt, rebuilds what each participant
// is owed from the protocol's rules (docs/narratives/A_rewards.md, A_scoring.md,
// A_named_streams.md, the payout curve design) and compares that with what the
// contracts actually did. It reads the contracts' numbers only where they are inputs
// the rules take as given (a participant's prediction power before a predict, a
// delegation snapshot); everything it compares against is recomputed here.
const { ethers } = require("hardhat");

const PR_RAW_SHIFT = 40n;
const PR_RAW_MASK = (1n << 47n) - 1n;
const CURVE_SCALE = 1_000_000n;
const BPS = 10_000n;
const REFERRAL_BPS = 500n;
const RATE_SCALE = 10n ** 24n;
const HDR_STREAK_MASK = 255n;

const effRaw = (p) => { let s = p >> PR_RAW_SHIFT; if (s > PR_RAW_MASK) s = PR_RAW_MASK; return s << PR_RAW_SHIFT; };
function streakWeight(s, h, g, r, b) {
  if (s < h) return (CURVE_SCALE * h * s) / ((r + 1n) * (h + r * (h - s)));
  return (CURVE_SCALE * h * ((s - h) * (g * g + g + 1n) + g * h)) / ((g + 1n) * (s + h * (g - 1n))) + b * CURVE_SCALE;
}

class Model {
  constructor(world, params) {
    this.w = world;
    Object.assign(this, params); // f g r b dustTarget farmingThreshold devBps baseEmission marketing
    this.byGame = new Map(world.streams.map((s) => [s.gameId, s]));
    this.byStream = new Map(world.streams.map((s) => [s.streamId, s]));
    this.entries = new Map();      // streamId -> [{hour, value}] ring entries, in write order
    this.streak = new Map();       // `${user}|${game}` -> bigint
    this.threshold = new Map();    // game -> { thr, round }
    this.dust = new Map();         // `${game}|${round}` -> bigint signal
    this.preds = new Map();        // `${user}|${game}` -> [prediction] (unscored first)
    this.totals = new Map();       // `${game}|${round}` -> { up, down }
    this.gameW = new Map();        // `${game}|${round}` -> recorded weight
    this.roundTotal = new Map();   // round -> final recorded denominator
    this.votes = new Map();        // game -> live weight (model)
    this.budget = new Map();       // round -> frozen budget
    this.credited = new Map();     // `${game}|${round}` -> gross credited
    this.referral = new Map();     // user -> referrer
    this.rates = new Map();        // `${delegate}|${round}` -> summed rateAdded
    this.delegation = new Map();   // delegator -> [{ delegate, from, to, capital }]
    this.netCredit = new Map();    // address -> net credited (what claims must eventually pay)
    this.claimed = new Map();      // address -> claimed total
    this.delegatorGross = new Map(); // delegator -> gross pulled
    this.burned = 0n; this.claimedTotal = 0n; this.devFee = 0n; this.general = 0n;
    this.failures = [];            // { check, detail }
    this.stats = { predictions: 0, correct: 0, wrong: 0, voided: 0, unrecoverable: 0, displaced: 0, rewardsChecked: 0,
      referralsChecked: 0, budgetsChecked: 0, thresholdsChecked: 0, delegatorAccruals: 0 };
    this.perUser = new Map();      // address -> { predictions, correct, wrong, voided, maxStreak, earned }
  }

  fail(check, detail) { if (this.failures.length < 200) this.failures.push({ check, detail }); }
  user(a) { const k = a.toLowerCase(); if (!this.perUser.has(k)) this.perUser.set(k, { predictions: 0, correct: 0, wrong: 0, voided: 0, maxStreak: 0n, earned: 0n }); return this.perUser.get(k); }
  addNet(a, v) { const k = a.toLowerCase(); this.netCredit.set(k, (this.netCredit.get(k) || 0n) + v); }

  // --- inputs the harness tells the model about -------------------------------------
  setInitialVotes(game, w) { this.votes.set(game, w); }
  setReferral(user, ref) { this.referral.set(user.toLowerCase(), ref.toLowerCase()); }
  // A delegator's capital behind a delegate, as segments [from, to] of rounds. A new
  // segment opens on delegating (at its activation round), on a receipt (capital grows
  // from the next round), and the open one closes on leaving.
  openSegment(delegator, delegate, from, capital) {
    const k = delegator.toLowerCase();
    const list = this.delegation.get(k) || [];
    const open = list.find((p) => p.to == null);
    if (open) open.to = from - 1;
    if (delegate) list.push({ delegate: delegate.toLowerCase(), from, to: null, capital });
    this.delegation.set(k, list);
  }
  openCapital(delegator) {
    const open = (this.delegation.get(delegator.toLowerCase()) || []).find((p) => p.to == null);
    return open ? open.capital : 0n;
  }

  // --- the outcome rules ---------------------------------------------------------------
  // Plain band (cadence 60, target 1440): anchor = newest entry at or before the
  // prediction's hour; post = first entry more than 23 hours after it.
  // Sentiment: the anchor is the counter right after the predictor's own flow, so only
  // what the rest of the network does afterwards counts.
  expectedOutcome(p) {
    const es = this.entries.get(p.streamId) || [];
    const post = es.find((e) => e.hour > p.hour + 23);
    if (!post) return { status: "pending" };
    let anchor;
    if (p.named) anchor = p.counterAfter;
    else {
      const before = es.filter((e) => e.hour <= p.hour);
      if (!before.length) return { status: "pending" };
      anchor = before[before.length - 1].value;
    }
    if (post.value === anchor) return { status: "void" };
    const up = post.value > anchor;
    return { status: (p.dir === 1) === up ? "correct" : "wrong" };
  }

  expectedReward(game, round, weight, dir, named) {
    if (weight === 0n) return 0n;
    const t = this.totals.get(`${game}|${round}`) || { up: 0n, down: 0n };
    const mine = dir === 1 ? t.up : t.down, other = dir === 1 ? t.down : t.up;
    if (mine === 0n) return 0n;
    const gw = this.gameW.get(`${game}|${round}`) || 0n;
    const tot = this.roundTotal.get(round) || 0n;
    const budget = this.budget.get(round) || 0n;
    if (gw === 0n || tot === 0n || budget === 0n) return 0n;
    let pool = (budget * gw) / tot;
    if (pool === 0n) return 0n;
    let den = mine;
    if (named) { const smaller = mine < other ? mine : other; pool = (pool * smaller) / (mine + other); }
    else den = mine + other;
    return (pool * weight) / den;
  }

  // --- receipt processing ----------------------------------------------------------------
  // `pre` carries what the harness read just before the tx: for a predict, the
  // predictor's total power and each game's live weight; `ctx` the clock.
  onReceipt(rc, parse, pre, ctx) {
    const evs = [];
    for (const log of rc.logs) { const e = parse(log); if (e) evs.push(e); }
    // The engine credits a win (RewardSplit) just BEFORE it emits PredictionScored, so
    // credits wait here for the score that explains them.
    const splits = new Map(); // `${user}|${game}|${round}` -> gross credited
    for (const e of evs) this.apply(e, pre, ctx, splits);
    for (const [k, v] of splits) this.fail("reward-unexpected", `${k}: RewardSplit ${ethers.formatEther(v)} with no scored win`);
    return evs;
  }

  apply(e, pre, ctx, pendingScore) {
    const a = e.args;
    switch (e.name) {
      case "StreamValueUpdated": {
        const sid = Number(a.streamId);
        const list = this.entries.get(sid) || [];
        list.push({ hour: Number(a.hour), value: BigInt(a.newValue) });
        this.entries.set(sid, list);
        if (pre && pre.wrote && pre.wrote[sid] != null && BigInt(pre.wrote[sid]) !== BigInt(a.newValue))
          this.fail("value-write", `stream ${sid} wrote ${a.newValue}, harness sent ${pre.wrote[sid]}`);
        break;
      }
      case "RoundBudgetFrozen": {
        const round = Number(a.round);
        const expect = this.baseEmission - (this.baseEmission * this.devBps) / BPS;
        if (BigInt(a.budget) !== expect) this.fail("round-budget", `round ${round}: frozen ${a.budget}, rules give ${expect}`);
        this.budget.set(round, BigInt(a.budget)); this.stats.budgetsChecked++;
        break;
      }
      case "Voted": {
        const g = Number(a.gameId);
        const w = (this.votes.get(g) || 0n) + BigInt(a.weightAdded);
        this.votes.set(g, w);
        if (BigInt(a.newGameWeight) !== w) this.fail("vote-weight", `game ${g}: contract weight ${a.newGameWeight}, model ${w}`);
        if (BigInt(a.amountBurned) !== BigInt(a.weightAdded)) this.fail("vote-burn", `game ${g}: burned ${a.amountBurned} but weight +${a.weightAdded}`);
        this.burned += BigInt(a.amountBurned);
        break;
      }
      case "GameRecordedForRound": {
        const g = Number(a.gameId), round = Number(a.round);
        const live = this.votes.get(g) || 0n;
        if (BigInt(a.weight) !== live) this.fail("game-record", `game ${g} round ${round}: recorded ${a.weight}, live weight ${live}`);
        const prevTot = this.roundTotal.get(round) || 0n;
        if (BigInt(a.roundTotal) !== prevTot + BigInt(a.weight)) this.fail("round-total", `round ${round}: total ${a.roundTotal} != ${prevTot} + ${a.weight}`);
        this.gameW.set(`${g}|${round}`, BigInt(a.weight));
        this.roundTotal.set(round, BigInt(a.roundTotal));
        break;
      }
      case "StreakThresholdSet": {
        const g = Number(a.gameId), round = Number(a.round);
        const exp = this.nextThreshold(g, round);
        if (exp == null) this.fail("threshold-timing", `game ${g}: StreakThresholdSet in round ${round} but it was already set this round`);
        else if (BigInt(a.threshold) !== exp) this.fail("threshold", `game ${g} round ${round}: ${a.threshold}, controller gives ${exp}`);
        this.threshold.set(g, { thr: BigInt(a.threshold), round });
        this.stats.thresholdsChecked++;
        break;
      }
      case "PredictionMade": this.onPredict(a, pre, ctx); break;
      case "NamedCounterMoved": {
        const g = Number(a.gameId);
        const last = this.lastNamedPred && this.lastNamedPred.game === g ? this.lastNamedPred : null;
        if (last) { last.counterAfter = BigInt(a.value); this.lastNamedPred = null; }
        else this.fail("named-counter", `game ${g}: counter moved with no prediction before it`);
        break;
      }
      case "PredictionScored": case "PredictionVoided": case "PredictionUnrecoverable":
        this.onScore(e.name, a, ctx, pendingScore); break;
      case "PredictionDisplaced": {
        this.stats.displaced++;
        const list = this.preds.get(`${a.user.toLowerCase()}|${Number(a.gameId)}`) || [];
        const i = list.findIndex((p) => p.round === Number(a.round));
        if (i >= 0) list.splice(i, 1);
        this.fail("displaced", `${a.user} game ${a.gameId} round ${a.round}: a prediction was dropped unscored (M22 path)`);
        break;
      }
      case "RewardSplit": {
        const k = `${a.predictor.toLowerCase()}|${Number(a.gameId)}|${Number(a.round)}`;
        const gross = BigInt(a.predictorAmount) + BigInt(a.delegatorAmount);
        pendingScore.set(k, gross);
        const gk = `${Number(a.gameId)}|${Number(a.round)}`;
        this.credited.set(gk, (this.credited.get(gk) || 0n) + gross);
        this.general += gross;
        this.devFee += (gross * this.devBps + (BPS - this.devBps) - 1n) / (BPS - this.devBps);
        this.checkSplit(a, gross);
        this.settleSkim(a.predictor, BigInt(a.predictorAmount)); // the predictor's own portion pays the skim
        break;
      }
      case "DelegatorRateAccrued": {
        const k = `${a.delegate.toLowerCase()}|${Number(a.round)}`;
        this.rates.set(k, (this.rates.get(k) || 0n) + BigInt(a.rateAdded));
        const exp = this.delegatedCapital(a.delegate, Number(a.round));
        if (BigInt(a.delegatedPower) !== exp) this.fail("delegated-power", `${a.delegate} round ${a.round}: snapshot ${a.delegatedPower}, delegators' capital ${exp}`);
        break;
      }
      case "DelegatorRewardsAccrued": {
        const dk = a.delegator.toLowerCase();
        this.delegatorGross.set(dk, (this.delegatorGross.get(dk) || 0n) + BigInt(a.amount));
        this.settleSkim(a.delegator, BigInt(a.amount));
        this.stats.delegatorAccruals++;
        break;
      }
      // Emitted inside the credit, just BEFORE the RewardSplit / DelegatorRewardsAccrued
      // it belongs to; settleSkim checks it there.
      case "ReferralPaid": {
        if (this.pendingRef) this.fail("referral-unexpected", `${a.owner}: two ReferralPaid in a row`);
        this.pendingRef = { who: a.owner.toLowerCase(), dest: a.referral.toLowerCase(), amount: BigInt(a.amount) };
        break;
      }
      case "PredictionDelegated":
        this.openSegment(a.delegator, a.delegate, Number(a.activationRound), BigInt(a.predictionPower)); break;
      case "PredictionUndelegated": this.openSegment(a.delegator, null, ctx.round, 0n); break;
      case "DelegatePowerSynced": {
        // A receipt (claim mint or transfer in) grows a delegator's capital from its
        // activation round on; a send shrinks it at once (sends are locked anyway).
        const act = Number(a.activationRound);
        const cap = this.openCapital(a.delegator);
        if (act > ctx.round) this.openSegment(a.delegator, a.delegate, act, cap + BigInt(a.value));
        else this.openSegment(a.delegator, a.delegate, ctx.round, cap - BigInt(a.value));
        break;
      }
      case "RewardsClaimed": {
        const k = a.owner.toLowerCase();
        this.claimed.set(k, (this.claimed.get(k) || 0n) + BigInt(a.totalAmount));
        this.claimedTotal += BigInt(a.totalAmount);
        break;
      }
    }
  }

  // Every credit skims 5% (truncated) to the earner's referrer, or the marketing
  // wallet when it has none; the earner keeps the rest.
  settleSkim(who, amount) {
    who = who.toLowerCase();
    const cut = (amount * REFERRAL_BPS) / BPS;
    const ref = this.pendingRef; this.pendingRef = null;
    const dest = this.referral.get(who) || this.marketing.toLowerCase();
    if (cut > 0n) {
      if (!ref) this.fail("referral-missing", `${who}: credit ${amount} paid no 5% cut`);
      else {
        if (ref.who !== who) this.fail("referral-owner", `cut for ${ref.who}, credit was ${who}`);
        if (ref.amount !== cut) this.fail("referral-amount", `${who}: cut ${ref.amount}, 5% is ${cut}`);
        if (ref.dest !== dest) this.fail("referral-dest", `${who}: cut went to ${ref.dest}, expected ${dest}`);
        this.stats.referralsChecked++;
      }
    } else if (ref) this.fail("referral-unexpected", `${who}: cut ${ref.amount} on a credit of ${amount}`);
    this.addNet(who, amount - cut);
    if (cut > 0n) this.addNet(dest, cut);
    this.user(who).earned += amount - cut;
  }

  // The adaptive threshold controller: on the first prediction of a game in a new
  // round, move the bar one step against last active round's power-weighted dust signal.
  nextThreshold(g, round) {
    const st = this.threshold.get(g) || { thr: 0n, round: 0 };
    if (st.round === round) return null;
    let thr = st.thr < this.f ? this.f : st.thr;
    const sig = this.dust.get(`${g}|${st.round}`) || 0n;
    if (sig > 0n) { if (thr > this.f) thr -= 1n; } else if (sig < 0n) { if (thr < HDR_STREAK_MASK) thr += 1n; }
    return thr;
  }

  onPredict(a, pre, ctx) {
    const user = a.predictor.toLowerCase(), g = Number(a.gameId), round = Number(a.round);
    const s = this.byGame.get(g);
    const sk = `${user}|${g}`;
    const streak = this.streak.get(sk) || 0n;
    this.stats.predictions++; this.user(user).predictions++;
    if (Number(a.round) !== ctx.round) this.fail("predict-round", `${user} game ${g}: round ${a.round}, clock says ${ctx.round}`);
    if (Number(a.hour) !== ctx.hour) this.fail("predict-hour", `${user} game ${g}: hour ${a.hour}, clock says ${ctx.hour}`);
    if (BigInt(a.streak) !== streak) this.fail("streak-at-predict", `${user} game ${g}: contract streak ${a.streak}, model ${streak}`);

    const st = this.threshold.get(g);
    if (!st || st.round !== round) this.fail("threshold-missing", `game ${g} round ${round}: no threshold set before the prediction`);
    const thr = st ? st.thr : this.f;
    const mult = streak === 0n ? 1n : streakWeight(streak, thr, this.g, this.r, this.b);
    if (BigInt(a.multiplier) !== mult) this.fail("multiplier", `${user} game ${g} streak ${streak} bar ${thr}: ${a.multiplier}, curve gives ${mult}`);

    const P = pre.power, elig = pre.eligibleCount, live = pre.weightOf[g] || 0n;
    const power = live !== 0n && elig > 0 ? P / BigInt(elig) : 0n;
    if (BigInt(a.predictionPower) !== power) this.fail("power-split", `${user} game ${g}: power ${a.predictionPower}, rules give ${power} (total ${P} over ${elig} paying games)`);
    const weight = effRaw(power) * mult;
    if (BigInt(a.weight) !== weight) this.fail("weight", `${user} game ${g}: weight ${a.weight}, rules give ${weight}`);

    const dk = `${g}|${round}`;
    const below = streak < thr;
    this.dust.set(dk, (this.dust.get(dk) || 0n) + power * (below ? BPS - this.dustTarget : -this.dustTarget));

    const tk = `${g}|${round}`;
    const t = this.totals.get(tk) || { up: 0n, down: 0n };
    if (Number(a.direction) === 1) t.up += weight; else t.down += weight;
    this.totals.set(tk, t);

    const p = { user, game: g, streamId: s.streamId, named: s.named, round, hour: Number(a.hour), dir: Number(a.direction),
      weight, aboveFloor: P >= this.farmingThreshold, counterAfter: null };
    const list = this.preds.get(sk) || [];
    list.push(p); this.preds.set(sk, list);
    if (s.named) this.lastNamedPred = p;
  }

  onScore(name, a, ctx, pendingScore) {
    const user = a.user.toLowerCase(), g = Number(a.gameId), round = Number(a.round);
    const sk = `${user}|${g}`;
    const list = this.preds.get(sk) || [];
    if (!list.length) { this.fail("score-unknown", `${name} for ${user} game ${g} round ${round}: no open prediction`); return; }
    list.sort((x, y) => x.hour - y.hour);
    const p = list.shift();
    if (p.round !== round) this.fail("score-order", `${user} game ${g}: scored round ${round}, oldest open is round ${p.round}`);
    if (ctx.round <= p.round) this.fail("score-early", `${user} game ${g}: scored in round ${ctx.round}, before its round ${p.round} ended`);
    const exp = this.expectedOutcome(p);
    const got = name === "PredictionVoided" ? "void" : name === "PredictionUnrecoverable" ? "unrecoverable"
      : (a.correct ? "correct" : "wrong");
    if (exp.status !== got) this.fail("outcome", `${user} game ${g} round ${round} hour ${p.hour} dir ${p.dir}: contract says ${got}, rules say ${exp.status}`);

    const u = this.user(user);
    let streak = this.streak.get(sk) || 0n;
    if (got === "correct") { if (p.aboveFloor) streak = streak + 1n > HDR_STREAK_MASK ? HDR_STREAK_MASK : streak + 1n; this.stats.correct++; u.correct++; }
    else if (got === "wrong") { streak = 0n; this.stats.wrong++; u.wrong++; }
    else if (got === "unrecoverable") { streak = 0n; this.stats.unrecoverable++; }
    else { this.stats.voided++; u.voided++; }
    this.streak.set(sk, streak);
    if (streak > u.maxStreak) u.maxStreak = streak;
    if (name === "PredictionScored") {
      if (BigInt(a.streak) !== streak) this.fail("streak-after-score", `${user} game ${g} round ${round}: contract streak ${a.streak}, model ${streak}`);
      const sw = got === "correct" ? p.weight : 0n;
      if (BigInt(a.scaledWeight) !== sw) this.fail("scored-weight", `${user} game ${g}: scaledWeight ${a.scaledWeight}, expected ${sw}`);
      if (got === "correct") {
        const reward = this.gameLive(g) ? this.expectedReward(g, round, p.weight, p.dir, p.named) : 0n;
        const k = `${user}|${g}|${round}`;
        const credited = pendingScore.has(k) ? pendingScore.get(k) : 0n;
        pendingScore.delete(k);
        if (credited !== reward) this.fail("reward-amount", `${k}: credited ${credited}, rules give ${reward} (diff ${credited - reward})`);
        else this.stats.rewardsChecked++;
      }
    }
  }

  gameLive(g) { return this.byGame.has(g); } // every game in this world stays approved

  checkSplit(a, gross) {
    const info = this.splitInfo && this.splitInfo.get(`${a.predictor.toLowerCase()}|${Number(a.gameId)}|${Number(a.round)}`);
    if (!info || info.delegated === 0n) {
      if (BigInt(a.delegatorAmount) !== 0n) this.fail("split", `${a.predictor}: delegators paid ${a.delegatorAmount} with no delegated power`);
      return;
    }
    const dr = (gross * info.delegated) / (info.own + info.delegated);
    const bonus = info.feeBps === 0n ? 0n : (dr * info.feeBps) / BPS;
    const ds = dr - bonus;
    if (BigInt(a.delegatorAmount) !== ds) this.fail("split", `${a.predictor} round ${a.round}: delegators ${a.delegatorAmount}, rules give ${ds}`);
  }

  delegatedCapital(delegate, round) {
    const d = delegate.toLowerCase();
    let sum = 0n;
    for (const list of this.delegation.values()) for (const p of list)
      if (p.delegate === d && p.from <= round && (p.to == null || p.to >= round)) sum += p.capital;
    return sum;
  }

  // What each delegator should have pulled: capital x the delegate's summed rate for
  // every round of its delegation, floored per round as the contract's walk does.
  expectedDelegatorIncome(delegator) {
    let sum = 0n;
    for (const p of this.delegation.get(delegator.toLowerCase()) || []) {
      for (const [k, rate] of this.rates) {
        const [d, r] = k.split("|");
        const round = Number(r);
        if (d === p.delegate && round >= p.from && (p.to == null || round <= p.to)) sum += (p.capital * rate) / RATE_SCALE;
      }
    }
    return sum;
  }

  // Every game-round credits at most its slice, and every round at most its budget.
  conservation() {
    const perRound = new Map();
    for (const [k, c] of this.credited) {
      const [g, r] = k.split("|").map(Number);
      const pool = ((this.budget.get(r) || 0n) * (this.gameW.get(k) || 0n)) / (this.roundTotal.get(r) || 1n);
      if (c > pool) this.fail("slice", `game ${g} round ${r}: credited ${c} > slice ${pool}`);
      perRound.set(r, (perRound.get(r) || 0n) + c);
    }
    for (const [r, c] of perRound) if (c > (this.budget.get(r) || 0n)) this.fail("budget", `round ${r}: credited ${c} > budget ${this.budget.get(r)}`);
    return perRound;
  }
}

module.exports = { Model, effRaw, streakWeight };
