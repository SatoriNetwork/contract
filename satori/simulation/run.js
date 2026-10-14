// Episode runner. Deploys a fresh world, seats disparate players, runs N rounds, and
// asserts the invariant battery after every player's turn. A HARD violation = a provable
// hack; the runner stops and prints the seed + action log so it shrinks to a repro.
//
//   SIM_SEED=42 SIM_ROUNDS=30 npx hardhat run simulation/run.js
//   SIM_LLM_PLAN=plan.json npx hardhat run simulation/run.js   (replay a sub-agent plan)
const { ethers } = require("hardhat");
const { makeRng } = require("./rng");
const W = require("./world");
const { Ledger, wealthOf, snapshotStartWealth, checkInvariants, economicReport } = require("./oracle");
const A = require("./actions");
const P = require("./personas");
const LLM = require("./llm");

// SIM_LLM_PLAN points at a sub-agent-authored attack plan JSON. When set, the scripted
// roster is replaced by `plan.wallets` adversary wallets that REPLAY the plan; the plan's
// own seed/rounds are defaults that the env still overrides. Unset = scripted 10-agent run.
const PLAN_PATH = process.env.SIM_LLM_PLAN || "";
const PLAN = PLAN_PATH ? LLM.loadPlan(PLAN_PATH) : null;

const SEED = Number(process.env.SIM_SEED || (PLAN && PLAN.seed != null ? PLAN.seed : 42));
const ROUNDS = Number(process.env.SIM_ROUNDS || (PLAN && PLAN.rounds != null ? PLAN.rounds : 30));

// Persona mix: [personaFactory, label, startingStake(ether), needsToken]
function roster() {
  // When SIM_LLM_PLAN is set, the roster is N adversary wallets, each replaying the steps
  // addressed to its wallet index. Each is provisioned a token (so bounty/token actions are
  // legal) and a starting stake. Default run (no SIM_LLM_PLAN) is the scripted roster.
  if (PLAN) {
    const n = PLAN.wallets;
    const spec = [];
    for (let w = 0; w < n; w++) {
      const stepsForWallet = PLAN.steps.filter((s) => s.wallet === w);
      spec.push([P.plannedAdversary(stepsForWallet), `LLM-${w}`, "50", true]);
    }
    return spec;
  }
  return [
    [P.honest(0.62), "WHALE", "150", false],
    [P.honest(0.55), "MID-A", "60", false],
    [P.honest(0.55), "MID-B", "60", false],
    [P.honest(0.45), "MINNOW-A", "15", false],
    [P.honest(0.45), "MINNOW-B", "15", false],
    [P.bountyFunder(0.5), "FUNDER", "80", true],
    [P.h3Deployer(), "EVIL", "40", false],
    [P.h3Sybil(), "SYBIL-0", "30", false],
    [P.h3Sybil(), "SYBIL-1", "30", false],
    [P.h3Sybil(), "SYBIL-2", "30", false],
  ];
}

async function main() {
  const rng = makeRng(SEED);
  const mode = PLAN ? `sub-agent plan (${PLAN.wallets} wallet(s), ${PLAN.steps.length} step(s))` : "scripted roster";
  console.log(`\n=== Satori adversarial simulation — seed ${SEED}, ${ROUNDS} rounds — ${mode} ===\n`);

  const world = await W.deployWorld(3);
  const ledger = new Ledger();
  await ledger.init(world);
  const startBps = Number((await world.fix.rewards.feeSlot()).bps);

  // Seat the players: give each its disparate starting stake + provision a token if needed.
  const signers = world.fix.signers;
  const agents = [];
  const spec = roster();
  for (let i = 0; i < spec.length; i++) {
    const [policy, name, stakeEth, needsToken] = spec[i];
    const signer = signers[i + 1];
    const agent = { name, signer, address: signer.address, policy, kind: policy.kind, skill: policy.skill, exploiter: !!policy.exploiter };
    await world.fix.satori.connect(world.owner).transfer(signer.address, ethers.parseEther(stakeEth));
    if (needsToken) agent.token = await A.provisionToken(world, agent, ethers.parseEther("100000"), ledger, "USDC");
    ledger.registerAgent({ name, address: signer.address, persona: agent.kind, exploiter: agent.exploiter });
    agents.push(agent);
  }
  await snapshotStartWealth(world, ledger);

  const shared = {};               // team scratchpad (capture results, attacker coordination)
  const pending = new Map();       // `${user}|${gameId}` -> round (predictions awaiting settle)
  const creditByGameRound = new Map(); // `${gameId}|${round}` -> bigint SATORI credited
  const hardViolations = [];
  const rel = (rnd) => rnd - world.deploymentRound; // relative round for readable output
  const settler = { name: "settler", signer: world.owner, address: world.owner.address };

  const recordViolation = (round, vs) => {
    for (const x of vs) {
      hardViolations.push({ round, ...x });
      console.log(`  🚨 [round ${round}] ${x.severity} ${x.name}: ${x.detail}`);
    }
  };

  for (let r = 0; r < ROUNDS && hardViolations.length === 0; r++) {
    await W.advanceRound(world);
    await W.tickValues(world, rng);
    const round = await W.currentRound(world);

    // Settle sweep: finalize last round's predictions and account the SATORI credited.
    //  - An unexpected NoPendingPrediction on a believed-pending prediction is a STRAND (H4).
    //  - Per (game, round) total credit must be <= one round budget. Under the score/total
    //    model the core PINS the first scorer's `total` per (game, round) and CAPS the
    //    round's running paid numerators at it, so the most a game can mint per round is
    //    exactly ONE pool (= budget × gameVotes/activeVotes <= budget). Exceeding a whole
    //    budget therefore means the pool was paid more than once (the over-mint the old
    //    singleton-bucket attack sought; EveryoneWinsGame is its score/total analogue).
    //    Universally true → no false positives, and it catches an over-mint the
    //    self-enforced cumulative cap cannot reveal.
    for (const [key, predRound] of [...pending.entries()]) {
      const [user, gameIdStr] = key.split("|");
      const gameId = Number(gameIdStr);
      const before = await world.fix.rewards.unclaimedRewards(user);
      const res = await A.execute(world, settler, { type: "settle", user, gameId }, ledger, round);
      const after = await world.fix.rewards.unclaimedRewards(user);
      if (!res.ok && /NoPendingPrediction/.test(res.errorName || "")) {
        recordViolation(round, [{ severity: "HARD", name: "strand",
          detail: `settle(${user}, ${gameId}) reverted NoPendingPrediction though predicted in round ${rel(predRound)}` }]);
      }
      const delta = after - before;
      if (delta > 0n) {
        const gk = `${gameId}|${predRound}`;
        // Backstop: any single game/round paying out more than a whole round budget means
        // the pool was paid out more than once — an over-mint. The pin+cap make this
        // structurally impossible, so this should never fire; it's a tripwire if it does.
        const tot = (creditByGameRound.get(gk) || 0n) + delta;
        creditByGameRound.set(gk, tot);
        if (tot > world.BUDGET)
          recordViolation(round, [{ severity: "HARD", name: "per-game-round-overpay",
            detail: `game ${gameId} round ${rel(predRound)}: credited ${ethers.formatEther(tot)} > budget 720 (over-mint, pool paid more than once)` }]);
      }
      pending.delete(key); // resolved or no-op; re-added below if re-predicted
    }
    if (hardViolations.length) break;

    // Each player takes a turn.
    for (const agent of agents) {
      const view = {
        round, name: agent.name, address: agent.address, persona: agent.kind, skill: agent.skill,
        wealth: await wealthOf(world, agent.address),
        hasPredicted: Number(await world.fix.satori.predictedStreamsCount(agent.address, round)) !== 0,
        markets: world.markets.map(m => ({ gameId: m.gameId, streamId: m.streamId, isDefault: m.isDefault,
          hint: world.pendingMove[m.gameId] ?? 0 })),
        token: agent.token ? { addr: agent.token.addr } : null,
      };
      const actions = (await agent.policy.decide(view, rng, shared)) || [];
      for (const action of actions) {
        const res = await A.execute(world, agent, action, ledger, round);
        if (action.capture && res.data) shared[action.capture] = res.data;
        if (res.ok && (action.type === "predict" || action.type === "predictMany")) {
          const entries = action.type === "predict" ? [{ gameId: action.gameId }] : action.entries;
          for (const e of entries) pending.set(`${agent.address}|${e.gameId}`, round);
        }
      }
      const { violations } = await checkInvariants(world, ledger, startBps);
      if (violations.length) { recordViolation(round, violations); break; }
    }
    if (rel(round) % 5 === 0) process.stdout.write(`  round ${rel(round)} ok (${ledger.actionLog.length} actions)\n`);
  }

  // ---- Report ----
  console.log("\n=== Leaderboard (net SATORI P&L) ===");
  const econ = await economicReport(world, ledger);
  for (const row of econ.rows)
    console.log(`  ${row.exploiter ? "😈" : "  "} ${row.name.padEnd(9)} ${row.persona.padEnd(12)} ${(row.net >= 0n ? "+" : "")}${ethers.formatEther(row.net)}`);

  console.log("\n=== Oracle verdict ===");
  if (hardViolations.length) {
    console.log(`  ❌ HACKED — ${hardViolations.length} hard invariant violation(s). Repro: SEED=${SEED}.`);
    console.log(`     Last 12 actions:`);
    for (const e of ledger.actionLog.slice(-12)) console.log(`       r${e.round} ${e.agent} ${e.action.type} ${e.ok ? "ok" : "REVERT:" + e.error}`);
    process.exitCode = 1;
  } else {
    console.log(`  ✅ HELD — ${ledger.actionLog.length} actions over ${ROUNDS} rounds, no conservation/solvency/auth break.`);
    if (econ.flag) console.log(`  ⚠️  economic flag: an exploiter persona is the most profitable — inspect for value redistribution.`);
  }
  console.log("");
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
