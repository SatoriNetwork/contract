/**
 * sim_mint-budget-conservation.test.js
 *
 * CONSERVATION SIMULATION — cluster: mint-budget-conservation
 *
 * A rigorous, deterministic, multi-round simulation that stresses the Satori
 * reward mint budget. It enforces, at every checkpoint and at the end:
 *
 *   (a) GLOBAL MINT CAP:
 *         satori.totalRewardsMinted() <= ROUND_REWARD_BUDGET(1440e18)
 *                                          * roundsElapsedSinceDeploy
 *       (the genesis INITIAL_MINT of 720e18 is HALF a round budget, folded
 *       into totalRewardsMinted at deploy)
 *       where roundsElapsed is counted exactly as Satori.rewardMint() does:
 *         roundsElapsed = getCurrentRound() - deploymentRound + 1
 *       and INITIAL_MINT is already folded into totalRewardsMinted at deploy,
 *       so the constant-form bound is:
 *         totalRewardsMinted <= ROUND_REWARD_BUDGET * roundsElapsed.
 *
 *   (b) totalSupply moves ONLY through the two paths that exist: the reward
 *       mint (up) and the vote BURN (down). Across every round,
 *         supplyDelta == mintedDelta - burnedDelta
 *       with burnedDelta the SATORI this sim destroyed by voting that round.
 *       There is no third path, so any other movement is a bug. Cumulative
 *       supply growth stays within the schedule.
 *
 *   (c) EVERY legitimately-earned claim SUCCEEDS — no BudgetExceeded revert.
 *       A revert at claim time means a round over-allocated relative to the
 *       cap. We claim for EVERY participant at the end and assert none revert
 *       with BudgetExceeded.
 *
 *   (d) PER-ROUND CONSERVATION: for sampled rounds where everyone claims
 *       before the round advances, the total newly-minted reward supply for
 *       that round (predictor payouts + delegator payouts + referral + the
 *       senior dev fee) is <= TOKENS_PER_ROUND (1440e18). Because every one of
 *       those components routes through the token's mint (and thus through
 *       totalRewardsMinted), the per-round delta of totalRewardsMinted is the
 *       exact sum of all distributed components for that round.
 *       (The value-provider cut, the default-stream cut and the
 *       first-predictor bonus were all removed with the burn-voting refactor —
 *       the whole on-chain gross now goes to predictors.)
 *
 * Adversarial flavor: large/varied stakes, churn (delegation set/switch/
 * undelegate, extra vote burns), gaps (rounds with no scoring), several
 * weighted games, referrals, predictor-fee commitments, and end-of-sim
 * everyone-claims-everything.
 *
 * Deterministic seeded LCG PRNG (no Math.random) for reproducibility.
 */

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture, pack1, voteFor } = require("../fixtures");

// ---- deterministic LCG PRNG (Numerical Recipes constants) -------------------
function makeRng(seed) {
  let state = BigInt(seed) & 0xffffffffn;
  const a = 1664525n;
  const c = 1013904223n;
  const m = 1n << 32n;
  return {
    next() {
      state = (a * state + c) % m;
      return Number(state);
    },
    // integer in [0, n)
    int(n) {
      state = (a * state + c) % m;
      return Number(state % BigInt(n));
    },
    bool() {
      state = (a * state + c) % m;
      return (state & 1n) === 1n;
    },
  };
}

// ALPHA / BETA / GAMMA are two-round (2880-minute) streams: each simulation
// step refreshes them once and so has to span a whole cadence period
// (CADENCE_ROUNDS 24h rounds).
const ROUND = 86400;            // 24h — production round cadence
const CADENCE_ROUNDS = 2;       // one cadence period = two rounds

// Advance exactly one cadence period (one simulation step).
async function nextCadenceStep() {
  await time.increase(ROUND * CADENCE_ROUNDS);
}

const E = (n) => ethers.parseEther(String(n));
const ROUND_BUDGET = E("1440"); // ROUND_REWARD_BUDGET / TOKENS_PER_ROUND

describe("SIM: mint-budget-conservation", function () {
  this.timeout(600000);

  it("conserves the mint budget over >=30 randomized rounds with full end-of-sim claims", async function () {
    const fx = await deploySatoriFixture();
    const { satori, rewards, registry, owner, signers, hub } = fx;

    const deploymentRound = await satori.deploymentRound();
    const ROUND_REWARD_BUDGET = await satori.ROUND_REWARD_BUDGET();
    expect(ROUND_REWARD_BUDGET).to.equal(ROUND_BUDGET);

    // ---- participants: 8 users with varied (large) balances -----------------
    // owner holds the bootstrap mint; give 8 users a spread of stakes so
    // vote-weight and prediction-power vary widely round to round.
    const users = signers.slice(1, 9); // 8 users
    // Owner holds the bootstrap mint minus adapter-registration spam fees
    // (~174 SATORI in the fixture). Keep the sum of stakes well under that,
    // while still spanning a wide relative range (5x..1x) so vote-weight and
    // prediction-power vary sharply round to round.
    const balances = ["5", "12", "30", "7", "25", "20", "3", "18"]; // sum=120
    const ownerBal = await satori.balanceOf(owner.address);
    let sum = 0n;
    for (const b of balances) sum += E(b);
    expect(ownerBal, "fixture owner must cover the staked spread").to.be.gte(sum);
    for (let i = 0; i < users.length; i++) {
      await satori.transfer(users[i].address, E(balances[i]));
    }

    // ---- 3 streams / games for varied weighted activity ---------------------
    // createSimpleDataStream is wrapped by the fixture to also create a paired
    // game with the same id (1:1 by creation order). The fixture now runs
    // initializeDefaultStream(), so id 1 is the DEFAULT game and these three
    // land at ids 2, 3, 4 — capture them from the creation events rather than
    // hardcoding.
    const games = [];
    for (const name of ["ALPHA", "BETA", "GAMMA"]) {
      const rcpt = await (await satori["createSimpleDataStream(string,address,uint24)"](name, owner.address, 2880)).wait();
      let id;
      for (const log of rcpt.logs) {
        try {
          const p = satori.interface.parseLog(log);
          if (p && p.name === "DataStreamCreated") { id = Number(p.args.streamId); break; }
        } catch (e) {}
      }
      if (id === undefined) throw new Error("DataStreamCreated missing for " + name);
      games.push(id);
    }

    // ---- referrals: set a few referral pointers (set-once, immutable) -------
    // route user[0] -> user[1], user[2] -> user[3]. user[4] stays UNREFERRED, so
    // its 1% routes to the marketing wallet (there is no self-referral opt-out).
    await rewards.connect(users[0]).setReferral(users[1].address);
    await rewards.connect(users[2]).setReferral(users[3].address);

    // ---- predictor-fee commitments (immutable on first use) -----------------
    await rewards.connect(users[1]).setPredictorFee(1000); // max 10% (== default)
    await rewards.connect(users[5]).setPredictorFee(500);  // 5%

    // ---- bootstrap weight: everyone BURNS a little onto one of the 3 games ---
    // Burns are deliberately small next to each user's stake so the wide
    // prediction-power spread the sim depends on survives (the poorest user
    // holds 3 SATORI). Every game ends up with weight, so every game earns.
    const BOOTSTRAP_BURN = E("1");
    const CHURN_BURN = E("0.1");
    let burnedTotal = 0n;      // SATORI this sim has destroyed by voting
    for (let i = 0; i < users.length; i++) {
      await voteFor(satori, users[i], games[i % games.length], BOOTSTRAP_BURN);
      burnedTotal += BOOTSTRAP_BURN;
    }

    // seed initial values so the first round has a baseline for scoring
    await registry.setValue(games[0], 100000);
    await registry.setValue(games[1], 200000);
    await registry.setValue(games[2], 300000);

    // move into the first active round
    await nextCadenceStep();

    const rng = makeRng(0xC0FFEE);

    // tracked global state for monotonicity / cap checks
    let prevSupply = await satori.totalSupply();
    let prevMinted = await satori.totalRewardsMinted();
    let prevBurned = burnedTotal;

    // running stream values (drift each round so directions resolve)
    const vals = {};
    vals[games[0]] = 100000; vals[games[1]] = 200000; vals[games[2]] = 300000;

    const ROUNDS = 34;

    // We sample per-round conservation on rounds where EVERYONE claims before
    // the round advances (so the totalRewardsMinted delta == that round's full
    // distribution). On those rounds invariant (d) is asserted exactly.
    const perRoundSamples = [];
    let cumulativeDistributed = 0n;

    const violations = [];

    function capForNow(curRound) {
      // roundsElapsed exactly as Satori.rewardMint computes it.
      const roundsElapsed = curRound - deploymentRound + 1n;
      return ROUND_REWARD_BUDGET * roundsElapsed;
    }

    for (let round = 1; round <= ROUNDS; round++) {
      await nextCadenceStep();

      // --- update stream values (drift), creating real up/down directions ---
      // adversarial: occasionally leave a stream STAGNANT (no setValue) to
      // create scoring gaps; occasionally big jumps.
      for (const g of games) {
        const r = rng.int(10);
        if (r < 2) {
          // stagnant: skip setValue for this stream this round (gap)
          continue;
        }
        const delta = (rng.int(2000) - 900) * (r >= 8 ? 50 : 1); // sometimes huge
        vals[g] = Math.max(1, vals[g] + delta);
        await registry.setValue(g, vals[g]);
      }

      // --- churn: delegation set / switch / undelegate -----------------------
      // each round a couple of users mutate their prediction-delegation.
      const churnCount = 1 + rng.int(3);
      for (let k = 0; k < churnCount; k++) {
        const u = users[rng.int(users.length)];
        const pick = rng.int(4);
        try {
          if (pick === 0) {
            await satori.connect(u).delegatePredictionPower(ethers.ZeroAddress); // undelegate
          } else {
            let d = users[rng.int(users.length)];
            await satori.connect(u).delegatePredictionPower(d.address);
          }
        } catch {
          // delegation can be blocked (locked / delegate active) — fine, these
          // are legitimately-rejected paths; global invariants still hold.
        }
      }

      // --- voting churn: keep shifting the weight distribution ---------------
      const voteCount = 1 + rng.int(3);
      for (let k = 0; k < voteCount; k++) {
        const u = users[rng.int(users.length)];
        const g = games[rng.int(games.length)];
        try {
          // Burnt weight is PERMANENT — a vote can no longer be moved — so
          // churn now means buying a little EXTRA weight for a random game each
          // round. The per-round denominator still shifts, which is what this
          // loop exists to stress, and the burn is booked so invariant (b) can
          // account for the destroyed supply.
          rng.bool(); // keep the PRNG stream identical to the original design
          await voteFor(satori, u, g, CHURN_BURN);
          burnedTotal += CHURN_BURN;
        } catch {}
      }

      // --- predictions: several users predict on several eligible games ------
      // Random but realistic: each user predicts on 0..3 games this round.
      for (let i = 0; i < users.length; i++) {
        const u = users[i];
        // settle prior-round predictions first (resolves & credits rewards)
        for (const g of games) {
          try {
            await satori.connect(u).settlePrediction(u.address, g);
          } catch {}
        }
        const howMany = rng.int(games.length + 1);
        if (howMany === 0) continue;
        // build a unique set of games to predict on
        const chosen = [];
        for (let c = 0; c < howMany; c++) {
          const g = games[rng.int(games.length)];
          if (!chosen.includes(g)) chosen.push(g);
        }
        const batch = chosen.map((g) => ({ gameId: g, payload: pack1((rng.int(2)) + 1) }));
        try {
          await satori.connect(u).predictMultipleWithPayloads(batch);
        } catch {
          // can be blocked (already predicted, ineligible, delegate-active) —
          // legitimately-rejected paths; invariants still hold.
        }
      }

      // tick the default stream / fee schedule explicitly (also happens on
      // first predict, but call it to be safe even on no-predict rounds)
      try { await satori.flushDefaultStream(); } catch {}

      // ---------------------------------------------------------------------
      // PER-ROUND CONSERVATION SAMPLE (invariant d).
      // On selected rounds, have EVERYONE claim now so all of this round's
      // distributed components are minted before the round advances. The
      // totalRewardsMinted delta is then the exact total distribution.
      // ---------------------------------------------------------------------
      // To isolate ONE round's distribution we must DRAIN the reward bucket
      // EVERY round: with the prior round fully claimed, the totalRewardsMinted
      // delta across this round equals exactly the rewards credited during this
      // round (predictor + delegator + referral + the senior dev fee).
      // Sampling only some rounds
      // would conflate several rounds' accruals into one delta and produce a
      // false positive, so we claim-and-measure on every round.
      const doSample = true;
      if (doSample) {
        const mintedBefore = await satori.totalRewardsMinted();
        // claim for everyone (users + owner).
        const claimers = [owner, ...users];
        for (const c of claimers) {
          // claimable amount via static call; only claim if > 0 and assert no
          // BudgetExceeded.
          let amt = 0n;
          try {
            amt = await hub.connect(c)["claim()"].staticCall();
          } catch (e) {
            // static call of claim itself reverting is a real problem
            violations.push({
              kind: "claim-static-revert",
              round,
              who: c.address,
              err: String(e).slice(0, 200),
            });
            continue;
          }
          if (amt > 0n) {
            try {
              await hub.connect(c)["claim()"]();
            } catch (e) {
              violations.push({
                kind: "claim-revert",
                round,
                who: c.address,
                amt: amt.toString(),
                err: String(e).slice(0, 200),
              });
            }
          }
        }
        const mintedAfter = await satori.totalRewardsMinted();
        const roundDistributed = mintedAfter - mintedBefore;
        perRoundSamples.push({ round, distributed: roundDistributed });
        cumulativeDistributed += roundDistributed;

        // INVARIANT (d): running conservation — through k drain windows the
        // protocol has paid out at most k windows' worth of budget. The budget
        // accrues per 24h ROUND, and one window is a whole cadence period, so
        // the allowance is ROUND_BUDGET x round x CADENCE_ROUNDS. Checked at
        // EVERY window, not just at the end.
        const runningAllowance = ROUND_BUDGET * BigInt(round * CADENCE_ROUNDS);
        if (cumulativeDistributed > runningAllowance) {
          violations.push({
            kind: "running-budget-exceeded",
            round,
            cumulative: cumulativeDistributed.toString(),
            allowed: runningAllowance.toString(),
          });
        }
      }

      // ---------------------------------------------------------------------
      // CHECKPOINT INVARIANTS (a) + (b), every round.
      // ---------------------------------------------------------------------
      const supplyNow = await satori.totalSupply();
      const mintedNow = await satori.totalRewardsMinted();
      const curRound = await satori.getCurrentRound();
      const cap = capForNow(curRound);

      // (a) global mint cap
      if (mintedNow > cap) {
        violations.push({
          kind: "global-cap-exceeded",
          round,
          minted: mintedNow.toString(),
          cap: cap.toString(),
        });
      }

      // (b) supply moves ONLY via the reward mint (up) and the vote burn
      //     (down): supplyDelta == mintedDelta - burnedDelta, exactly. Voting
      //     destroys SATORI now, so a bare "supply never decreases" check would
      //     be wrong; what must hold is that every wei of movement is one of
      //     those two paths and nothing else.
      const supplyDelta = supplyNow - prevSupply;
      const mintedDelta = mintedNow - prevMinted;
      const burnedDelta = burnedTotal - prevBurned;
      if (supplyDelta !== mintedDelta - burnedDelta) {
        violations.push({
          kind: "supply-minted-divergence",
          round,
          supplyDelta: supplyDelta.toString(),
          mintedDelta: mintedDelta.toString(),
          burnedDelta: burnedDelta.toString(),
        });
      }

      prevSupply = supplyNow;
      prevMinted = mintedNow;
      prevBurned = burnedTotal;
    }

    // -------------------------------------------------------------------------
    // FINAL: EVERYONE claims EVERYTHING. No claim may revert with
    // BudgetExceeded (invariant c). We run a few settle+claim sweeps to make
    // sure all pending rewards (incl. multi-round delegator accrual) drain.
    // -------------------------------------------------------------------------
    // advance one more cadence step so the last step's predictions can be scored.
    await nextCadenceStep();
    for (const g of games) {
      vals[g] += 137;
      try { await registry.setValue(g, vals[g]); } catch {}
    }
    for (let sweep = 0; sweep < 3; sweep++) {
      for (let i = 0; i < users.length; i++) {
        for (const g of games) {
          try { await satori.connect(users[i]).settlePrediction(users[i].address, g); } catch {}
        }
      }
      const claimers = [owner, ...users];
      for (const c of claimers) {
        let amt = 0n;
        try {
          amt = await hub.connect(c)["claim()"].staticCall();
        } catch (e) {
          violations.push({ kind: "final-claim-static-revert", who: c.address, err: String(e).slice(0, 200) });
          continue;
        }
        if (amt > 0n) {
          try {
            await hub.connect(c)["claim()"]();
          } catch (e) {
            violations.push({ kind: "final-claim-revert", who: c.address, amt: amt.toString(), err: String(e).slice(0, 200) });
          }
        }
      }
    }

    // -------------------------------------------------------------------------
    // FINAL GLOBAL ASSERTIONS — the SAFE direction.
    // -------------------------------------------------------------------------
    const finalRound = await satori.getCurrentRound();
    const finalCap = capForNow(finalRound);
    const finalMinted = await satori.totalRewardsMinted();
    const finalSupply = await satori.totalSupply();

    // Report diagnostics for the structured-output layer to read off the log.
    // eslint-disable-next-line no-console
    console.log("[SIM] rounds=%d samples=%d finalMinted=%s finalCap=%s finalSupply=%s violations=%d",
      ROUNDS,
      perRoundSamples.length,
      finalMinted.toString(),
      finalCap.toString(),
      finalSupply.toString(),
      violations.length);
    const maxPerRoundDistributed =
      perRoundSamples.reduce((m, s) => (s.distributed > m ? s.distributed : m), 0n);
    if (perRoundSamples.length) {
      // eslint-disable-next-line no-console
      console.log("[SIM] maxPerRoundDistributed=%s cumulative=%s budget=%s burned=%s",
        maxPerRoundDistributed.toString(), cumulativeDistributed.toString(),
        ROUND_BUDGET.toString(), burnedTotal.toString());
    }
    if (violations.length) {
      // eslint-disable-next-line no-console
      console.log("[SIM] VIOLATIONS:\n" + JSON.stringify(violations, null, 2));
    }

    // (c) no BudgetExceeded / claim reverts occurred anywhere.
    const claimReverts = violations.filter((v) =>
      v.kind === "claim-revert" || v.kind === "final-claim-revert" ||
      v.kind === "claim-static-revert" || v.kind === "final-claim-static-revert");
    expect(claimReverts, "every legitimately-earned claim must succeed (no BudgetExceeded)").to.deep.equal([]);

    // (d) the running payout never outruns the mint schedule, at any window.
    const runningOver = violations.filter((v) => v.kind === "running-budget-exceeded");
    expect(runningOver, "cumulative distributed must never exceed TOKENS_PER_ROUND * rounds").to.deep.equal([]);
    // ...and the same bound at the end of the run.
    expect(cumulativeDistributed,
      "cumulative distributed must never exceed TOKENS_PER_ROUND * rounds")
      .to.be.lte(ROUND_BUDGET * BigInt(ROUNDS * CADENCE_ROUNDS));

    // (b) supply moved only through the mint and the vote burn.
    const supplyIssues = violations.filter((v) => v.kind === "supply-minted-divergence");
    expect(supplyIssues,
      "totalSupply may move only via rewardMint (up) and the vote burn (down)").to.deep.equal([]);
    // Scenario detector for (b): the sim must actually have BURNED, otherwise
    // the burn term above is 0 and the check degenerates to the old one.
    expect(burnedTotal, "the sim must have destroyed SATORI by voting").to.be.gt(0n);

    // (a) global cap never exceeded at any checkpoint, including final.
    const capIssues = violations.filter((v) => v.kind === "global-cap-exceeded");
    expect(capIssues, "totalRewardsMinted must never exceed ROUND_REWARD_BUDGET * roundsElapsed").to.deep.equal([]);
    expect(finalMinted, "final totalRewardsMinted within schedule cap").to.be.lte(finalCap);
    expect(finalSupply, "final totalSupply within schedule cap").to.be.lte(finalCap);

    // LIVENESS — the sim must actually have RUN.
    //
    // WAS: `expect(ROUNDS).to.be.gte(30)`, i.e. the file-local literal 34
    // compared against the literal 30 (P2). It measured nothing about the
    // simulation and could not fail. That matters here more than anywhere,
    // because this file has no other liveness check: every state-changing call
    // in the loop is wrapped in a bare `catch {}` and all four conservation
    // assertions above are "no violation was RECORDED", so a silent break makes
    // them vacuously true rather than false. Proven, not argued: renaming
    // `predictMultipleWithPayloads` / `settlePrediction` to non-existent methods
    // — the exact "a signature change made every predict/settle revert silently"
    // scenario — leaves the whole file green with maxPerRoundDistributed = 0.
    // (It has already happened once undetected: `rewards.accrueProtocolFee()`
    // was REMOVED from the contracts, cf. A_rewards.md:174, and the bare catch
    // swallowed it for a long time; that dead call is now gone from this file.)
    //
    // So anchor liveness on MEASURED quantities.
    expect(perRoundSamples.length, "the sim must have sampled >= 30 settled rounds").to.be.gte(30);
    expect(maxPerRoundDistributed, "the sim must have DISTRIBUTED rewards; a run that " +
      "settled/claimed nothing satisfies every conservation bound above vacuously").to.be.gt(0n);
    // ...and distributed across the run, not just in one lucky round: the
    // bootstrap INITIAL_MINT alone reaches half of one round's budget, so a dead
    // sim tops out there.
    expect(finalMinted, "cumulative mint must exceed a single round's budget").to.be.gt(ROUND_BUDGET);
  });
});
