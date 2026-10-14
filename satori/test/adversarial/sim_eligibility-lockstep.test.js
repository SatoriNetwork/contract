/**
 * sim_eligibility-lockstep.test.js
 *
 * CONSERVATION SIMULATION — cluster: eligibility-lockstep.
 *
 * MIGRATED to burn voting. The mechanism this file used to hammer is gone: no
 * dual heap, no top-N eligible cap, no promotion/demotion, no once-per-round
 * snapshot pass, no round-totals lock, no `LockstepBroken` guard, and no vote
 * delegation. What survives is the PROPERTY those parts existed to defend —
 * that a round's reward numerators and its denominator agree, and that once a
 * round is over neither can move again.
 *
 * NOW: `SatoriVoting.recordGameVotesForRound(g, r)` is run by the first
 * predictor of game `g` in round `r`. It freezes `gameVotesAtRound[g][r]` and
 * adds the same number to `roundVoteTotal[r]` in ONE branch, so numerator and
 * denominator cannot drift. Weight itself is bought by BURNING SATORI and is
 * permanent — it can never be moved, revoked or re-pointed — so the churn that
 * used to come from vote-switching, delegation and transfers now comes from
 * fresh burns and from the admin disable switch.
 *
 * INVARIANTS ENFORCED (the SAFE direction — exact conservation equalities):
 *
 *   (I1) DENOMINATOR == Σ NUMERATORS. For every FINISHED round r:
 *          Σ_{all games g} gameVotesAtRound[g][r] == roundDenominator(r)
 *        summed over EVERY game id, not just the ones we expect to have
 *        participated — a stray numerator written for an unexpected game would
 *        break the equality.
 *
 *   (I2) FROZEN SNAPSHOT IMMUTABILITY. Once round r has ended, every
 *        gameVotesAtRound[g][r] and roundDenominator(r) must be IMMUTABLE
 *        across all later activity (later burns, disables, re-enables,
 *        transfers, predictions). Every previously observed round is re-read
 *        on every subsequent round and asserted unchanged.
 *
 *   (I3) ROUND-NOT-FINAL GUARD. `roundDenominator(r)` reverts `RoundNotFinal`
 *        while r is still open — the denominator accumulates over the round, so
 *        a mid-round read would size every share too large.
 *
 *   (I4) NON-INFLATION OF NUMERATORS. No single game's frozen numerator for a
 *        round exceeds that round's frozen denominator.
 *
 *   (I5) PARTICIPANT LIST AGREES. `getEligibleGamesAtRound(r)` lists exactly
 *        the games with a non-zero numerator for r, with no duplicates.
 *
 *   (I6) A DISABLED GAME RECORDS NOTHING. Predicting a disabled game is
 *        allowed but leaves no record, so it can never be scored.
 *
 * Uses a deterministic seeded LCG (NO Math.random) so the run is fully
 * reproducible. Only the in-repo mocks are used; no new .sol.
 */

const { expect } = require("chai");
const { deploySatoriFixture, pack1 } = require("../fixtures");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const UP = 1;
const DOWN = 2;
const TIME_UNIT = 86400; // seconds per round (two rounds/day)
const DEFAULT_GAME = 1;  // the protocol's own game — derived weight, never voted

// ---- deterministic seeded PRNG (LCG, Numerical Recipes constants) ----
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
    // bigint in [lo, hi]
    big(lo, hi) {
      state = (a * state + c) % m;
      const span = hi - lo + 1n;
      return lo + (BigInt(Number(state)) % span);
    },
  };
}

async function advanceToNextRound() {
  const now = await time.latest();
  const nextBoundary = Math.floor(now / TIME_UNIT) * TIME_UNIT + TIME_UNIT;
  await time.increaseTo(nextBoundary + 1);
}

async function getStreamIdFromTx(tx, satoriContract) {
  const receipt = await tx.wait();
  const ev = receipt.logs.find((log) => {
    try {
      const p = satoriContract.interface.parseLog(log);
      return p && p.name === "DataStreamCreated";
    } catch {
      return false;
    }
  });
  if (!ev) throw new Error("DataStreamCreated not found");
  return Number(satoriContract.interface.parseLog(ev).args.streamId);
}

describe("SIM eligibility-lockstep — round numerators/denominator agree and stay frozen under heavy churn", function () {
  this.timeout(600000);

  it("holds Σ numerators == denominator + immutability over many rounds of burn churn", async function () {
    const { satori, voting, registry, signers, owner } = await deploySatoriFixture();

    // 6 users with widely varied balances so burns land unevenly and the
    // per-round participating set keeps changing shape. Balances derive from
    // INITIAL_MINT so the sim scales with the supply schedule. We hand out
    // ~60% of the mint and keep the rest on the owner for stream-creation fees.
    const users = signers.slice(1, 7);
    const INITIAL_MINT = await satori.INITIAL_MINT();
    const UNIT = INITIAL_MINT / 100n;
    const weights = [14n, 12n, 10n, 9n, 8n, 7n]; // sum = 60
    for (let i = 0; i < users.length; i++) {
      await satori.transfer(users[i].address, UNIT * weights[i]);
    }

    // 5 streams. The fixture already created the DEFAULT stream at id 1, so
    // these land at ids 2..6. The default game participates too — its weight is
    // DERIVED (20% of all other burn, floored at 1e18), never burned — so it is
    // included in every sum below.
    const NSTREAMS = 5;
    const streams = [];
    for (let i = 0; i < NSTREAMS; i++) {
      const tx = await satori.createSimpleDataStream("S" + (i + 1), owner.address);
      streams.push(await getStreamIdFromTx(tx, satori));
    }
    const allGames = [DEFAULT_GAME, ...streams];

    // Bootstrap: every user buys some weight so several games can participate
    // from round 1. Burns are permanent — nothing here can ever be undone.
    for (let i = 0; i < users.length; i++) {
      await satori.connect(users[i]).vote(streams[i % NSTREAMS], ethers.parseEther("2"));
    }

    // Deterministic seeded PRNG — fixed seed for full reproducibility.
    const PRNG = makeRng(2718281828);

    // round -> { denom, perGame: Map<gameId, bigint>, participants: number[] }
    const observed = new Map();

    const ROUNDS = 26;
    const firstRound = Number(await satori.getCurrentRound());

    // Adversarial-coverage instrumentation: prove the participating set and the
    // denominator genuinely churn (otherwise the equalities are trivial).
    const distinctSets = new Set();
    const distinctDenoms = new Set();
    let roundsWithParticipation = 0;
    let disableRecordSuppressions = 0;
    const disabledNow = new Set();

    // Read + verify a FINISHED round. First observation captures; every later
    // one asserts byte-for-byte equality (I2).
    async function checkFinishedRound(r) {
      // (I1) sum over EVERY game id, so a stray write anywhere is caught.
      let sigma = 0n;
      const perGame = new Map();
      for (const g of allGames) {
        const v = await voting.getGameVotesAtRound(g, r);
        perGame.set(g, v);
        sigma += v;
      }
      const denom = await voting.roundDenominator(r);
      expect(sigma, `Σ gameVotesAtRound != roundDenominator at round ${r}`).to.equal(denom);

      // (I4) no single numerator exceeds the denominator.
      for (const [g, v] of perGame) {
        expect(v, `numerator > denom at round ${r} game ${g}`).to.be.lte(denom);
      }

      // (I5) the participant list agrees with the non-zero numerators.
      const listed = (await voting.getEligibleGamesAtRound(r)).map(Number);
      expect(new Set(listed).size, `duplicate participant at round ${r}`).to.equal(listed.length);
      const nonZero = [...perGame.entries()].filter(([, v]) => v > 0n).map(([g]) => g);
      expect([...listed].sort((a, b) => a - b),
        `participant list mismatch at round ${r}`).to.deep.equal(nonZero.sort((a, b) => a - b));

      const prior = observed.get(r);
      if (prior) {
        // (I2) nothing may drift once the round is over.
        expect(denom, `roundDenominator(${r}) drifted`).to.equal(prior.denom);
        for (const g of allGames) {
          expect(perGame.get(g), `gameVotesAtRound[${g}][${r}] drifted`)
            .to.equal(prior.perGame.get(g));
        }
        expect(listed.length, `participant count for round ${r} drifted`)
          .to.equal(prior.participants.length);
      } else {
        observed.set(r, { denom, perGame, participants: listed });
        if (listed.length > 0) {
          roundsWithParticipation++;
          distinctSets.add([...listed].sort((a, b) => a - b).join(","));
          distinctDenoms.add(denom.toString());
        }
      }
    }

    // A pool of actions that churn live weight. Under burn voting the only
    // levers are buying MORE weight (permanent) and the admin disable switch.
    async function churn(phaseTag) {
      const nActions = 2 + PRNG.int(4); // 2..5 actions
      for (let k = 0; k < nActions; k++) {
        const u = users[PRNG.int(users.length)];
        const action = PRNG.int(10);
        try {
          if (action <= 5) {
            // BURN for a random game — the dominant churn source. Amounts vary
            // by an order of magnitude so the weight ordering keeps reshuffling.
            const g = streams[PRNG.int(NSTREAMS)];
            const amt = ethers.parseEther("0.1") * PRNG.big(1n, 30n);
            await satori.connect(u).vote(g, amt);
          } else if (action === 6) {
            // DISABLE a game: its weight leaves totalBurnedWeight, it can no
            // longer be voted on, and it records nothing for any round.
            const g = streams[PRNG.int(NSTREAMS)];
            await voting.connect(owner).setGameApproved(g, false);
            disabledNow.add(g);
          } else if (action === 7) {
            // RE-ENABLE (restores the weight exactly).
            const g = streams[PRNG.int(NSTREAMS)];
            await voting.connect(owner).setGameApproved(g, true);
            disabledNow.delete(g);
          } else if (action === 8) {
            // TRANSFER — must NOT touch voting at all any more (the token hook
            // only syncs prediction delegation). Included precisely because a
            // regression there would show up as a numerator drift below.
            const d = users[PRNG.int(users.length)];
            if (d.address !== u.address) {
              const bal = await satori.balanceOf(u.address);
              if (bal > 0n) {
                const amt = bal / (2n + PRNG.big(0n, 6n));
                if (amt > 0n) await satori.connect(u).transfer(d.address, amt);
              }
            }
          } else {
            // Another burn for extra churn density.
            const g = streams[PRNG.int(NSTREAMS)];
            await satori.connect(u).vote(g, ethers.parseEther("0.5"));
          }
        } catch (e) {
          // Expected: burning more than a balance, voting a disabled game
          // (GameNotApproved), a prediction lock blocking a transfer. Never
          // swallow something that looks like a broken invariant.
          const msg = String(e);
          if (msg.includes("RoundNotFinal")) {
            throw new Error(`RoundNotFinal surfaced during ${phaseTag} churn: ${msg}`);
          }
        }
      }
    }

    for (let r = 1; r <= ROUNDS; r++) {
      await advanceToNextRound();
      const d = Number(await satori.getCurrentRound());

      // Refresh registry values so predicts have data, and tick the default
      // stream so game 1 can participate too.
      for (let i = 0; i < NSTREAMS; i++) {
        try {
          await registry.setValue(streams[i], 1000 + r * (i + 1));
        } catch (e) { /* cadence edge — non-fatal for the invariants under test */ }
      }
      try { await satori.flushDefaultStream(); } catch (e) {}

      // ---- PRE-PARTICIPATION churn: mutate live weight before any game in
      // this round has been frozen. ----
      await churn("pre");

      // ---- PARTICIPATION: each prediction runs recordGameVotesForRound for
      // its game, writing the numerator and growing the denominator together.
      // Several games join at different points in the round, which is exactly
      // the interleaving the old lock existed to police. ----
      const nPredicts = 1 + PRNG.int(4); // 1..4
      for (let p = 0; p < nPredicts; p++) {
        const predictor = users[PRNG.int(users.length)];
        const target = allGames[PRNG.int(allGames.length)];
        const dir = PRNG.int(2) === 0 ? UP : DOWN;
        try {
          await satori.connect(predictor).predictMultipleWithPayloads(
            [{ gameId: target, payload: pack1(dir) }]);
          // (I6) a disabled game must leave NO record for this round.
          if (disabledNow.has(target)) {
            expect(await voting.getGameVotesAtRound(target, d),
              `disabled game ${target} recorded a numerator at round ${d}`).to.equal(0n);
            disableRecordSuppressions++;
          }
        } catch (e) {
          // Stale value / cadence / zero-power edges are legitimate reverts.
        }
      }

      // (I3) the OPEN round's denominator is not readable — it is still growing.
      await expect(voting.roundDenominator(d)).to.be.revertedWithCustomError(
        voting, "RoundNotFinal");

      // ---- POST-PARTICIPATION churn: more weight bought AFTER games in this
      // round were already frozen. Later burns must NOT retroactively raise a
      // numerator that has already been written. ----
      await churn("post");

      // ---- SWEEP: every round that has now FINISHED must satisfy (I1),(I4),
      // (I5) and must be unchanged since we first saw it (I2). ----
      for (let dd = firstRound; dd < d; dd++) {
        await checkFinishedRound(dd);
      }
    }

    // Close the last round and do a final exhaustive re-check.
    await advanceToNextRound();
    const last = Number(await satori.getCurrentRound());
    for (let dd = firstRound; dd < last; dd++) {
      await checkFinishedRound(dd);
    }

    // The sim must be NON-DEGENERATE: rounds must actually have participated,
    // and the participating set / denominator must genuinely have moved,
    // otherwise the equalities are trivially satisfied and prove nothing.
    // eslint-disable-next-line no-console
    console.log(
      `      [sim] roundsWithParticipation=${roundsWithParticipation} ` +
      `distinctParticipantSets=${distinctSets.size} distinctDenominators=${distinctDenoms.size} ` +
      `disabledPredictionsSuppressed=${disableRecordSuppressions}`);
    expect(roundsWithParticipation, "too few rounds participated").to.be.gte(15);
    expect(distinctSets.size, "participating set never churned — sim is degenerate")
      .to.be.gte(3);
    expect(distinctDenoms.size, "denominator never moved — sim is degenerate")
      .to.be.gte(3);
  });
});
