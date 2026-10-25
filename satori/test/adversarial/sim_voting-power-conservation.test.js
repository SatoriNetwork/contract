const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture, pack1 } = require("../fixtures");

/**
 * sim_voting-power-conservation
 * =============================
 * Cluster: voting-power-conservation
 *
 * MIGRATED to burn voting. There is no "voting power" any more: a vote no
 * longer stakes a live balance that follows the holder around. `vote(g, amount)`
 * BURNS `amount` SATORI and credits game `g` that much PERMANENT weight. The
 * tokens are destroyed; the weight can never be moved, reduced or revoked.
 * Delegation, the two-channel own/inbound split, vote bounties and the dual
 * heap are all gone, so the old laws (Σ getVotingPower == totalSupply,
 * cumulativeTotalPower == Σ heap weights) have no referents.
 *
 * The successor conservation laws — the ones the reward split now rests on —
 * are asserted after EVERY mutation:
 *
 *   INV-1 (burn conservation, per action):
 *       A vote destroys EXACTLY `amount` from the voter's balance and exactly
 *       `amount` from totalSupply, and credits the game exactly `amount` of
 *       weight (on-chain games; off-chain games take the documented 2x
 *       handicap, not exercised here). Tokens cannot be created or stranded by
 *       the vote path.
 *
 *   INV-2 (weight ledger):
 *       voting.totalBurnedWeight() == Σ_{g != 1, ENABLED} voting.gameWeight(g)
 *     The default game (id 1) is deliberately excluded — its weight derives
 *     FROM this total, so including it would be circular. A disabled game's
 *     weight leaves the total and comes back exactly on re-enable.
 *
 *   INV-3 (derived default):
 *       voting.defaultDerivedWeight() == max(1e18, totalBurnedWeight * 100/9900)
 *     i.e. the default game holds exactly 1% of a denominator that includes
 *     itself, floored so genesis is non-zero. It is never burned for.
 *
 *   INV-4 (eligibility is weight, nothing else):
 *       voting.isEligible(g) == (voting.weightOf(g) > 0)  for every game
 *     No threshold, no top-N, no cap. `weightOf` is zero exactly when the game
 *     is disabled or has never been voted for.
 *
 *   INV-5 (monotonicity):
 *       Raw gameWeight is monotonically non-decreasing — burns are
 *       irreversible and there is no un-vote. Scope (2026-09-05): the one
 *       sanctioned decrease is `moveVotes` (a burner re-pointing their own
 *       share off a DISABLED game); this sim never calls it, so within this
 *       action set the law is exact. The fuzzed version lives in
 *       Conservation.invariant.t.sol as gameWeight + movedOut monotonicity.
 *
 *   INV-6 (mint ceiling):
 *       totalRewardsMinted <= ROUND_REWARD_BUDGET × (round − deployRound + 1).
 *     Claims mint; the sim must never inflate past the schedule.
 *
 * The simulation is deterministic: a fixed-seed LCG drives all randomness,
 * so any failure is reproducible by re-running the file.
 */

const ROUND_REWARD_BUDGET = 720n * 10n ** 18n;
const DEFAULT_GAME = 1;
const DEFAULT_SHARE_BPS = 100n;
const DEFAULT_WEIGHT_FLOOR = 10n ** 18n;

// --- Deterministic seeded PRNG (LCG, Numerical Recipes constants) ---------
// Do NOT use Math.random — the sim must be byte-for-byte reproducible.
function makeRng(seed) {
  let state = BigInt.asUintN(32, BigInt(seed));
  const a = 1664525n;
  const c = 1013904223n;
  const m = 1n << 32n;
  return {
    next() {
      state = (a * state + c) % m;
      return Number(state);
    },
    // integer in [0, n). Takes the HIGH bits: a power-of-two-modulus LCG has
    // notoriously short periods in its low bits (the bottom 3 bits cycle with
    // period 8), which silently starved the rarer actions of this sim.
    int(n) {
      return Math.floor(this.next() / 65536) % n;
    },
    // bigint in [lo, hi]
    big(lo, hi) {
      const span = hi - lo + 1n;
      const r = BigInt(Math.floor(this.next() / 65536)) % span;
      return lo + r;
    },
    bool() {
      return this.int(2) === 1;
    },
  };
}

// Advance to the next round boundary (rounds are 86400s = 24h) plus 1s.
async function advanceRound() {
  const now = await time.latest();
  const next = Math.floor(now / 86400) * 86400 + 86400;
  await time.increaseTo(next + 1);
}

// A public caller may only create streams at cadence >= 2 rounds, and
// `createSimpleDataStream(name, provider)` now hands out exactly that. SIM-A/B/C
// are refreshed once per simulation step, so a step is a whole cadence period.
const CADENCE_ROUNDS = 2;

async function advanceCadence() {
  for (let i = 0; i < CADENCE_ROUNDS; i++) await advanceRound();
}

async function streamIdFrom(tx, satori) {
  const r = await tx.wait();
  for (const log of r.logs) {
    try {
      const p = satori.interface.parseLog(log);
      if (p && p.name === "DataStreamCreated") return Number(p.args.streamId);
    } catch (_) {}
  }
  throw new Error("DataStreamCreated not found");
}

describe("SIM burn-weight conservation", function () {
  this.timeout(600000);

  it("conserves burnt weight across votes, disables, transfers/mints, and predictions over many rounds", async function () {
    const { satori, voting, registry, owner, signers } =
      await deploySatoriFixture();

    const rng = makeRng(0xC0FFEE); // fixed seed -> reproducible

    // ----- Participants: 8 users with varied balances ---------------------
    // signers[0] == owner holds the bootstrap mint (720 SATORI).
    const users = signers.slice(1, 9); // 8 users
    const E = (n) => ethers.parseEther(String(n));
    // Varied, "lumpy" balances incl. a whale and dust holders.
    const balances = [E(120), E(0.5), E(45), E(7), E(0.001), E(88), E(3), E(15)];
    for (let i = 0; i < users.length; i++) {
      await satori.transfer(users[i].address, balances[i]);
    }

    // ----- Streams + games to burn for -------------------------------------
    // The fixture already created the DEFAULT stream at id 1 (as production
    // does), so these land at ids 2, 3, 4. The default game's weight is DERIVED
    // and it cannot be voted on, so it is never in `votableGames`.
    const sA = await streamIdFrom(await satori.createSimpleDataStream("SIM-A", owner.address), satori);
    const sB = await streamIdFrom(await satori.createSimpleDataStream("SIM-B", owner.address), satori);
    const sC = await streamIdFrom(await satori.createSimpleDataStream("SIM-C", owner.address), satori);
    const votableGames = [sA, sB, sC];
    const allGames = [DEFAULT_GAME, ...votableGames];

    // Bootstrap a little weight so the ledger is non-trivial from the start.
    await satori.connect(users[0]).vote(sA, E(3));
    await satori.connect(users[2]).vote(sB, E(2));

    await advanceCadence();
    await registry.setValue(sA, 1000);
    await registry.setValue(sB, 2000);
    await registry.setValue(sC, 3000);

    // Which games the admin currently has switched off.
    const disabled = new Set();
    // High-water mark per game for the monotonicity check (INV-5).
    const maxRawWeight = new Map(allGames.map((g) => [g, 0n]));

    // --------------------------------------------------------------------
    // Invariant checkers
    // --------------------------------------------------------------------

    // INV-2: totalBurnedWeight == Σ enabled non-default gameWeight.
    async function checkWeightLedger(label) {
      let sum = 0n;
      for (const g of votableGames) {
        if (!disabled.has(g)) sum += BigInt(await voting.gameWeight(g));
      }
      const total = BigInt(await voting.totalBurnedWeight());
      expect(total).to.equal(
        sum,
        `INV-2 weight ledger broken @ ${label}: totalBurnedWeight=${total} Σenabled=${sum}`
      );
      return total;
    }

    // INV-3: the default game's derived weight, floored.
    async function checkDerivedDefault(label, total) {
      const raw = (total * DEFAULT_SHARE_BPS) / (10000n - DEFAULT_SHARE_BPS);
      const expected = raw < DEFAULT_WEIGHT_FLOOR ? DEFAULT_WEIGHT_FLOOR : raw;
      const got = BigInt(await voting.defaultDerivedWeight());
      expect(got).to.equal(
        expected,
        `INV-3 derived default wrong @ ${label}: got=${got} expected=${expected}`
      );
      // The default game reports its derived weight through the normal getter,
      // and can never be disabled away.
      expect(BigInt(await voting.weightOf(DEFAULT_GAME))).to.equal(
        expected,
        `INV-3b weightOf(default) != derived @ ${label}`
      );
    }

    // INV-4 + INV-5: eligibility is exactly "has weight", and raw weight never
    // goes backwards.
    async function checkEligibilityAndMonotonicity(label) {
      for (const g of allGames) {
        const w = BigInt(await voting.weightOf(g));
        const elig = await voting.isEligible(g);
        expect(elig).to.equal(
          w > 0n,
          `INV-4 isEligible(${g})=${elig} but weightOf=${w} @ ${label}`
        );
        if (g === DEFAULT_GAME) continue;
        // weightOf is zeroed by a disable; the RAW ledger entry is not.
        const raw = BigInt(await voting.gameWeight(g));
        expect(raw).to.be.gte(
          maxRawWeight.get(g),
          `INV-5 raw weight of game ${g} went backwards @ ${label}`
        );
        maxRawWeight.set(g, raw);
        expect(w).to.equal(
          disabled.has(g) ? 0n : raw,
          `INV-4b weightOf(${g}) disagrees with disable state @ ${label}`
        );
      }
    }

    // INV-6: the emission schedule is never exceeded.
    async function checkMintCeiling(label) {
      const cur = BigInt(await satori.getCurrentRound());
      const dep = BigInt(await satori.deploymentRound());
      const minted = BigInt(await satori.totalRewardsMinted());
      const cap = ROUND_REWARD_BUDGET * (cur - dep + 1n);
      expect(minted).to.be.lte(
        cap,
        `INV-6 mint ceiling breached @ ${label}: minted=${minted} cap=${cap}`
      );
    }

    async function checkAll(label) {
      const total = await checkWeightLedger(label);
      await checkDerivedDefault(label, total);
      await checkEligibilityAndMonotonicity(label);
      await checkMintCeiling(label);
    }

    await checkAll("post-bootstrap");

    // --------------------------------------------------------------------
    // Action helpers — each wrapped so intentional reverts (empty balances,
    // prediction locks, disabled games) don't abort the sim; the GLOBAL
    // invariants are asserted after every action regardless.
    // --------------------------------------------------------------------

    const ROUNDS = 24;
    let actionCounter = 0;
    let votesLanded = 0;
    let disablesLanded = 0;

    // INV-1 is a per-action law, so it is checked inside doVote where the
    // before/after pair is available.
    async function doVote(u) {
      let g = votableGames[rng.int(votableGames.length)];
      if (disabled.has(g)) {
        // A disabled game rejects votes outright (asserted explicitly in the
        // mid-sim stress block); fall through to a live one so the burn path
        // keeps getting exercised while games are switched off.
        g = votableGames.find((x) => !disabled.has(x));
        if (g === undefined) return;
      }
      const bal = BigInt(await satori.balanceOf(u.address));
      if (bal === 0n) return;
      // Burn a bounded slice so the user survives to act again.
      const amt = bal / BigInt(4 + rng.int(8));
      if (amt === 0n) return;

      const supplyBefore = BigInt(await satori.totalSupply());
      const weightBefore = BigInt(await voting.gameWeight(g));
      const totalBefore = BigInt(await voting.totalBurnedWeight());
      const roundBefore = BigInt(await voting.totalBurnAtRound(await satori.getCurrentRound()));
      const gameRoundBefore = BigInt(await voting.gameBurnAtRound(g, await satori.getCurrentRound()));

      await satori.connect(u).vote(g, amt);
      votesLanded++;

      // INV-1: the tokens are DESTROYED — not moved to an escrow, not left in
      // the wallet — and the game gains exactly what was destroyed.
      expect(BigInt(await satori.balanceOf(u.address))).to.equal(
        bal - amt, "INV-1 voter balance not reduced by exactly the burn");
      expect(BigInt(await satori.totalSupply())).to.equal(
        supplyBefore - amt, "INV-1 totalSupply not reduced by exactly the burn");
      expect(BigInt(await voting.gameWeight(g))).to.equal(
        weightBefore + amt, "INV-1 game weight not credited exactly the burn");
      expect(BigInt(await voting.totalBurnedWeight())).to.equal(
        totalBefore + amt, "INV-1 totalBurnedWeight not credited exactly the burn");
      // Per-round burn deltas track the same number.
      const cur = await satori.getCurrentRound();
      expect(BigInt(await voting.totalBurnAtRound(cur))).to.equal(
        roundBefore + amt, "INV-1 totalBurnAtRound drifted");
      expect(BigInt(await voting.gameBurnAtRound(g, cur))).to.equal(
        gameRoundBefore + amt, "INV-1 gameBurnAtRound drifted");
    }

    async function doDisableToggle() {
      const g = votableGames[rng.int(votableGames.length)];
      const want = !disabled.has(g);
      await voting.connect(owner).setGameApproved(g, !(want));
      if (want) disabled.add(g); else disabled.delete(g);
      disablesLanded++;
    }

    async function doTransfer(u) {
      const to = users[rng.int(users.length)];
      const bal = BigInt(await satori.balanceOf(u.address));
      if (bal === 0n) return;
      // Transfer a randomized fraction (incl. occasional full-balance moves).
      const denom = BigInt(1 + rng.int(4)); // 1..4
      const amt = bal / denom;
      if (amt === 0n) return;
      // A transfer must not touch voting at all any more — the token hook only
      // syncs prediction delegation. The global sweep below proves it.
      await satori.connect(u).transfer(to.address, amt);
    }

    async function doClaim(u) {
      // Mints rewards into the user's balance -> grows totalSupply, which must
      // stay under the emission ceiling (INV-6).
      const amt = await satori.connect(u).claim.staticCall();
      if (amt > 0n) await satori.connect(u).claim();
    }

    async function doPredict(u) {
      const g = allGames[rng.int(allGames.length)];
      const dir = (rng.int(2) + 1); // 1 or 2
      await satori
        .connect(u)
        .predictMultipleWithPayloads([{ gameId: g, payload: pack1(dir) }]);
    }

    const actions = [
      doVote,
      doVote,
      doVote,
      doTransfer,
      doClaim,
      doPredict,
      doPredict,
      doDisableToggle,
    ];

    // --------------------------------------------------------------------
    // Main loop: many rounds, churny per-round action bursts, gaps in
    // timing, large stakes. Assert all invariants after EVERY action.
    // --------------------------------------------------------------------
    for (let round = 1; round <= ROUNDS; round++) {
      await advanceCadence();
      // Feed fresh values so predictions/scoring have something to settle.
      await registry.setValue(sA, 1000 + round * 7);
      await registry.setValue(sB, 2000 - round * 5);
      await registry.setValue(sC, 3000 + round * 3);

      const burst = 4 + rng.int(5); // 4..8 actions per round
      for (let b = 0; b < burst; b++) {
        const u = users[rng.int(users.length)];
        const action = actions[rng.int(actions.length)];
        actionCounter++;
        try {
          await action(u);
        } catch (e) {
          // Intentional: prediction locks, empty balances, GameNotApproved and
          // other guarded reverts are expected parts of an adversarial
          // sequence. Global invariants are still asserted below regardless.
          // A failed per-action INV-1 assertion is a chai AssertionError, which
          // must NOT be swallowed.
          if (e && e.constructor && e.constructor.name === "AssertionError") throw e;
        }
        // The load-bearing assertions — after EVERY mutation attempt.
        await checkAll(`round ${round} action ${b} (#${actionCounter})`);
      }

      // Mid-sim deliberate stress: disable a game that carries real weight,
      // confirm its weight leaves the ledger, then restore it and confirm the
      // weight comes back EXACTLY. A burn can never be undone, so a disable
      // that lost weight would be an unrecoverable protocol failure.
      if (round === 8 || round === 16) {
        const g = votableGames[round % votableGames.length];
        if (disabled.has(g)) {
          await voting.connect(owner).setGameApproved(g, true);
          disabled.delete(g);
          await checkAll(`pre-stress re-enable round ${round}`);
        }
        const rawBefore = BigInt(await voting.gameWeight(g));
        const totalBefore = BigInt(await voting.totalBurnedWeight());

        await voting.connect(owner).setGameApproved(g, false);
        disabled.add(g);
        expect(BigInt(await voting.weightOf(g))).to.equal(0n, "disabled game still earns");
        expect(await voting.isEligible(g)).to.equal(false, "disabled game still eligible");
        expect(BigInt(await voting.totalBurnedWeight())).to.equal(
          totalBefore - rawBefore, "disable did not subtract the game's weight");
        await checkAll(`disabled round ${round}`);

        // Voting a disabled game is rejected outright.
        await expect(
          satori.connect(users[0]).vote(g, ethers.parseEther("0.1"))
        ).to.be.revertedWithCustomError(voting, "GameNotApproved");

        await voting.connect(owner).setGameApproved(g, true);
        disabled.delete(g);
        expect(BigInt(await voting.gameWeight(g))).to.equal(
          rawBefore, "re-enable did not restore the raw weight");
        expect(BigInt(await voting.totalBurnedWeight())).to.equal(
          totalBefore, "re-enable did not restore the ledger total");
        await checkAll(`re-enabled round ${round}`);
      }
    }

    // Re-enable everything so the guard rails below test the reason they name.
    for (const g of [...disabled]) {
      await voting.connect(owner).setGameApproved(g, true);
      disabled.delete(g);
    }
    await checkAll("all-re-enabled");

    // The vote path's guard rail set, asserted once against live state. None of
    // these may ever silently burn the caller's tokens.
    const supplyBeforeGuards = BigInt(await satori.totalSupply());
    await expect(satori.connect(users[0]).vote(DEFAULT_GAME, ethers.parseEther("1")))
      .to.be.revertedWithCustomError(voting, "CannotVoteDefault");
    // A nonexistent game (id 0 or a junk id) is rejected by the hub BEFORE the
    // burn, so no tokens are destroyed on the way to SatoriVoting.UnknownGame.
    await expect(satori.connect(users[0]).vote(0, ethers.parseEther("1")))
      .to.be.revertedWithCustomError(satori, "UnknownStream");
    await expect(satori.connect(users[0]).vote(9999, ethers.parseEther("1")))
      .to.be.revertedWithCustomError(satori, "UnknownStream");
    await expect(satori.connect(users[0]).vote(sA, 0))
      .to.be.revertedWithCustomError(voting, "ZeroVote");
    await expect(voting.connect(owner).setGameApproved(DEFAULT_GAME, false))
      .to.be.revertedWithCustomError(voting, "CannotSetDefaultApproval");
    expect(BigInt(await satori.totalSupply())).to.equal(
      supplyBeforeGuards, "a rejected vote destroyed tokens anyway");
    await checkAll("post-guard-rails");

    // Final settle: everyone tries to claim, then assert one last time.
    for (const u of users) {
      try {
        const amt = await satori.connect(u).claim.staticCall();
        if (amt > 0n) await satori.connect(u).claim();
      } catch (e) {
        /* lock / nothing to claim */
      }
      await checkAll(`final-claim ${u.address}`);
    }

    await checkAll("end-of-sim");

    // Sanity: we actually exercised a meaningful number of actions, and the
    // burn/disable paths really ran (otherwise the ledger laws are vacuous).
    // eslint-disable-next-line no-console
    console.log(`      [sim] actions=${actionCounter} votes=${votesLanded} disables=${disablesLanded} ` +
      `totalBurnedWeight=${ethers.formatEther(await voting.totalBurnedWeight())}`);
    expect(actionCounter).to.be.greaterThan(80);
    expect(votesLanded, "no vote ever landed — sim is degenerate").to.be.greaterThan(20);
    expect(disablesLanded, "the disable switch never fired").to.be.greaterThan(3);
    expect(BigInt(await voting.totalBurnedWeight()),
      "no weight was ever bought").to.be.greaterThan(0n);
  });
});
