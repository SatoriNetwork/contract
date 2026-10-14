// Personas = disparate simulated humans. Each has a different starting stake, a different
// prediction skill, and a policy: decide(view, rng, shared) -> [action]. `view` is what
// the player can "see" (its wallet, the markets, its P&L, the public state); `shared` is a
// team scratchpad (real attackers coordinate across wallets).
//
// This is the seam where an LLM "player who read the code" drops in: an llm policy would
// receive the same `view` (plus the contract source) and RETURN the same action array.
// Scripted policies below encode honest behavior + the known attack shapes so the harness
// is useful with zero LLM cost; the LLM layer adds creativity on top of the same oracle.
const { ethers } = require("hardhat");

const UP = 1, DOWN = 2;

// An honest predictor of a given skill (prob of guessing the real move). Predicts one
// batch/round across the default game + a couple markets, occasionally votes, claims.
function honest(skill) {
  return {
    kind: "honest",
    decide(view, rng) {
      const acts = [];
      if (!view.hasPredicted && view.wealth > 0n) {
        const entries = [];
        const dflt = view.markets.find(m => m.isDefault);
        if (dflt && rng.bool(0.7)) entries.push({ gameId: dflt.gameId, dir: rng.bool() ? UP : DOWN });
        const others = rng.shuffle(view.markets.filter(m => !m.isDefault));
        for (const m of others.slice(0, 2)) {
          const correct = m.hint > 0 ? UP : DOWN, wrong = m.hint > 0 ? DOWN : UP;
          entries.push({ gameId: m.gameId, dir: rng.bool(skill) ? correct : wrong });
        }
        if (entries.length) acts.push({ type: "predictMany", entries });
      }
      if (rng.bool(0.12)) {
        const m = rng.pick(view.markets.filter(x => !x.isDefault));
        if (m) acts.push({ type: "vote", gameId: m.gameId });
      }
      if (view.round % 4 === 0) acts.push({ type: "claim" });
      return acts;
    },
  };
}

// Honest + funds/stakes a per-game bounty in its own ERC20 (exercises the bounty paths
// that H2 attacked).
function bountyFunder(skill) {
  const base = honest(skill);
  return {
    kind: "bountyFunder",
    decide(view, rng, shared) {
      const acts = base.decide(view, rng);
      if (view.token) {
        const m = rng.pick(view.markets.filter(x => !x.isDefault));
        if (m && rng.bool(0.3))
          acts.push({ type: "fundBounty", gameId: m.gameId, tokenAddr: view.token.addr,
            amount: ethers.parseEther("100"), rate: ethers.parseEther("10") });
        if (rng.bool(0.25))
          acts.push({ type: "stakeBounty", tokenAddr: view.token.addr, amount: ethers.parseEther("25") });
        if (rng.bool(0.15))
          acts.push({ type: "withdrawBounty", tokenAddrs: [view.token.addr] });
      }
      return acts;
    },
  };
}

// H3 attacker (deployer half of a team). Multi-round setup, then signals the sybils.
// Targets the score/total over-mint: EveryoneWinsGame announces `total == each user's own
// score`, trying to pay every predictor the FULL pool (pool × w/w). The core's first-scorer
// total-pin + running-sum cap defeat it — only the first scorer is paid one pool, the rest
// get 0 — so conservation (per-(game,round) credit <= one budget) must hold.
function h3Deployer() {
  return {
    kind: "attacker", exploiter: true,
    decide(view, rng, shared) {
      if (!shared.evil) // step 1: deploy + register the hostile adapter
        return [{ type: "deployEvilGameAdapter", kind: "everyoneWins", name: "evil", capture: "evil" }];
      if (shared.evil && !shared.evilGame) { // step 2: create the adapter game on a real stream
        const m = view.markets.find(x => !x.isDefault);
        return [{ type: "createAdapterGame", streamId: m.streamId, adapterTypeId: shared.evil.typeId,
          config: "0x", name: "evilgame", capture: "evilGame" }];
      }
      if (shared.evilGame && !shared.evilReady) { // step 3: make it eligible, then unleash
        shared.evilReady = true;
        return [{ type: "vote", gameId: shared.evilGame.gameId }];
      }
      // steady state: the deployer also bets on its own game.
      if (shared.evilReady && shared.evilGame && !view.hasPredicted && view.wealth > 0n)
        return [{ type: "predict", gameId: shared.evilGame.gameId, dir: UP }];
      return [];
    },
  };
}

// H3 sybils: many wallets that all bet on the deployer's EveryoneWinsGame so each would
// (without the pin+cap) win the full pool. With the cap, only the first scorer is paid.
function h3Sybil() {
  return {
    kind: "attacker", exploiter: true,
    decide(view, rng, shared) {
      if (shared.evilReady && shared.evilGame && !view.hasPredicted && view.wealth > 0n)
        return [{ type: "predict", gameId: shared.evilGame.gameId, dir: UP }];
      return [];
    },
  };
}

// LLM seam (sub-agent PLAN executor). A red-team SUB-AGENT (a Claude Code agent) READ the
// immutable contract out-of-band and authored an attack PLAN (JSON). There is NO external
// API here: this persona simply REPLAYS that plan. Each turn it computes its relative round
// (offset from the first round it was asked to decide), pulls the steps scheduled for THIS
// wallet at THIS relative round, resolves any "$name.field" capture refs against the shared
// scratchpad, and runs the result through validatePlan — the safety boundary that drops
// anything illegal so a malformed plan can neither crash the run nor escape the legal action
// space. Same interface, same oracle — so anything the sub-agent invents becomes a guard.
const LLM = require("./llm");
function plannedAdversary(steps) {
  const mySteps = Array.isArray(steps) ? steps : [];
  let firstRound = null; // absolute round of this wallet's first decide() call
  return {
    kind: "llm", exploiter: true,
    decide(view, rng, shared) {
      try {
        if (firstRound === null) firstRound = view.round;
        const rel = view.round - firstRound;
        const due = mySteps.filter((s) => s.round === rel);
        if (!due.length) return [];
        const raw = [];
        for (const s of due)
          for (const a of (Array.isArray(s.actions) ? s.actions : []))
            raw.push(LLM.resolveRefs(a, shared));
        return LLM.validatePlan(raw, view);
      } catch (e) {
        return []; // crash-proof: a bad plan never throws
      }
    },
  };
}

module.exports = { honest, bountyFunder, h3Deployer, h3Sybil, plannedAdversary, UP, DOWN };
