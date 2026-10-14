/**
 * RewardBudgetInvariant.test.js
 *
 * Property/invariant test for the reward-emission budget.
 *
 * THE INVARIANT
 * -------------
 * The protocol must never bring more reward value into existence — whether
 * already minted, or merely credited as owed (unclaimedRewards + lazy pending
 * delegator shares) — than the cumulative budget:
 *
 *     totalRewardsMinted + Σ getTotalClaimableRewards(addr)
 *         ≤ ROUND_REWARD_BUDGET (1440e18) × roundsElapsed
 *
 *   where roundsElapsed = getCurrentRound − deploymentRound + 1.
 *
 * The hub does count commits on-chain (`emission().issued`, bumped by
 * `noteIssued` at every winning score), but only as the trigger for the next
 * emission step — it is not a cap and nothing reverts on it. The on-chain
 * `rewardMint` cap (SatoriHub) bounds *minted* supply; this test adds the
 * assurance neither gives: that *accrual* into unclaimedRewards (which counts
 * as prediction power before it is ever minted) also stays within budget.
 *
 * WHY getTotalClaimableRewards, not raw unclaimedRewards
 * ------------------------------------------------------
 * A delegate's reward is split: its own share lands in unclaimedRewards eagerly,
 * but each delegator's share is accrued lazily (surfaced by
 * _pendingDelegatorRewardsView until the delegator next claims). Summing raw
 * unclaimedRewards would undercount the owed total and could hide a violation,
 * so we sum getTotalClaimableRewards = unclaimed + pending.
 *
 * WHY the run starts at round ≥ 1
 * -------------------------------
 * The constructor mints INITIAL_MINT (one round of the hub's base rate, 846.62)
 * to the deployer and sets totalRewardsMinted = INITIAL_MINT at the deploy round,
 * so part of round 0's 1440 budget is already spent as the bootstrap. To keep the
 * invariant exact we do ALL value-provision and prediction from round 1 onward.
 * Stream/game creation in round 0 only transfers spam-fee SATORI and the seed
 * votes only BURN it (no mint, no accrual), so the round-0 baseline is exactly
 * INITIAL_MINT.
 *
 * BURN VOTING
 * -----------
 * Votes now destroy SATORI to buy a game permanent weight. That only ever
 * shrinks the left-hand side (burning reduces supply, never mints or accrues),
 * so it cannot break the bound — but it is exercised anyway because it moves
 * eligibility, and because a burn is a transfer that the prediction lock can
 * reject, which reshapes the interleavings the fuzz explores.
 */

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const {
  deploySatoriFixture,
  deployAndRegisterYesNoGame,
  createYesNoGame,
  pack1,
} = require("./fixtures");

const ROUND = 86400; // 24h, seconds
const UP = 1, DOWN = 2;

async function advanceRound() {
  const t = await time.latest();
  const next = Math.floor(t / ROUND) * ROUND + ROUND;
  await time.increaseTo(next + 1);
}

// Deterministic PRNG (mulberry32) so any failing run is reproducible from its seed.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function runFuzz(seed) {
  const fix = await loadFixture(deploySatoriFixture);
  const { satori, rewards, voting, lens, registry, games, owner, signers } = fix;

  const ROUND_REWARD_BUDGET = await satori.ROUND_REWARD_BUDGET(); // 1440e18
  const deployRound = await satori.deploymentRound();

  // --- Actors: 5 players funded from the owner's genesis mint. ---
  const players = signers.slice(1, 6);
  for (const p of players) {
    await (await satori.connect(owner).transfer(p.address, ethers.parseEther("60"))).wait();
  }
  const allActors = [owner, ...players];                 // 6 predictors/voters
  // platform fee moved to immutable token (see test/next/DevFee.test.js): it is
  // minted senior at the token, NOT accrued into unclaimedRewards, so the fee
  // recipient no longer contributes an "owed" term to this budget sum.
  const owedAddrs = allActors.map((a) => a.address);

  // --- Three simple streams (player providers) + their binary games. The
  // fixture already initialized the DEFAULT stream at id 1, so these land at
  // ids 2..4 and are read back from getDataStreamCount rather than hardcoded.
  // Stream 0 hosts the YES/NO adapter game below, so it must be 2880 minutes
  // (two rounds) to satisfy the create-time gate (adapter games reject
  // every-round streams); streams 1 & 2 host only the built-in type-0 binary
  // game and stay at 1440 (every round). Stream 0's every-round setValue
  // simply reverts on the gap half the time — swallowed like any other
  // legitimate revert. ---
  const providers = [players[0], players[1], players[2]];
  const streamIds = [];
  for (let i = 0; i < providers.length; i++) {
    await satori.connect(owner)["createSimpleDataStream(string,address,uint24)"](
      `S${i}`, providers[i].address, i === 0 ? 2880 : 1440
    );
    streamIds.push(Number(await registry.getDataStreamCount()));
  }
  const binaryGameOf = {};
  for (const sid of streamIds) binaryGameOf[sid] = Number(await games.binaryGameByStream(sid));

  // --- One YES/NO adapter game on stream 0 (exercises the adapter scoring path). ---
  const { gameTypeId } = await deployAndRegisterYesNoGame(fix);
  const yesNoGameId = await createYesNoGame(satori.connect(owner), gameTypeId, streamIds[0], 50000, "YN");

  const allGameIds = [...streamIds.map((s) => binaryGameOf[s]), yesNoGameId];
  // Only the built-in binary games earn from the mint, so only they can be
  // voted for — `vote` on the adapter game reverts GameNotMintEligible. The
  // adapter game stays in `allGameIds` (it is still predicted on and settled,
  // which is the point of having it) but never appears in a vote.
  const votableGameIds = streamIds.map((s) => binaryGameOf[s]);

  // --- Seed initial eligibility: distinct voters burn for one game each. Any
  // weight > 0 earns (no threshold, no cap), and SEED_BURN is small enough that
  // each player keeps the bulk of their 60 to predict with. ---
  const SEED_BURN = ethers.parseEther("5");
  const FUZZ_BURN = ethers.parseEther("1");
  await satori.connect(players[0]).vote(binaryGameOf[streamIds[0]], SEED_BURN);
  await satori.connect(players[1]).vote(binaryGameOf[streamIds[1]], SEED_BURN);
  await satori.connect(players[2]).vote(binaryGameOf[streamIds[2]], SEED_BURN);
  // players[3] backs stream 0's binary game rather than the adapter game that
  // shares that stream: the adapter game is not mint-eligible and cannot be
  // voted for at all. Predictions on it still happen throughout the run — they
  // simply draw nothing, which the invariant below must also hold across.
  await satori.connect(players[3]).vote(binaryGameOf[streamIds[0]], SEED_BURN);

  // The invariant assertion — run after EVERY action so a violation pinpoints
  // the exact action that caused it.
  async function checkInvariant(label) {
    const minted = await satori.totalRewardsMinted();
    let owed = 0n;
    for (const a of owedAddrs) owed += (await lens.getTotalClaimableRewards(a))[0];
    const cur = await satori.getCurrentRound();
    const roundsElapsed = cur - deployRound + 1n;
    const budget = ROUND_REWARD_BUDGET * roundsElapsed;
    const lhs = minted + owed;
    if (lhs > budget) {
      throw new Error(
        `BUDGET INVARIANT VIOLATED @ ${label} (seed 0x${seed.toString(16)}): ` +
        `minted ${ethers.formatEther(minted)} + owed ${ethers.formatEther(owed)} ` +
        `= ${ethers.formatEther(lhs)} > budget ${ethers.formatEther(budget)} ` +
        `(roundsElapsed ${roundsElapsed})`
      );
    }
  }

  // Round-0 baseline: only genesis exists, nothing accrued.
  await checkInvariant("setup (round 0)");

  // Step into round 1 before any value-provision / prediction (see header).
  await advanceRound();

  const rand = mulberry32(seed);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const value = {};
  for (const sid of streamIds) value[sid] = 50000;

  const ROUNDS = 40, ACTIONS = 6;
  for (let r = 0; r < ROUNDS; r++) {
    // Post a fresh value on every stream each round: makes predictions scorable
    // and lets each game join that round's accumulating denominator.
    for (let i = 0; i < streamIds.length; i++) {
      const sid = streamIds[i];
      value[sid] = Math.max(1, value[sid] + Math.round(value[sid] * 0.02 * (rand() * 2 - 1)));
      try { await registry.connect(providers[i]).setValue(sid, BigInt(value[sid])); } catch (e) {}
      await checkInvariant(`r${r} setValue s${sid}`);
    }

    // A burst of random actions. Every legitimate revert (DuplicatePrediction,
    // PredictExpired, StaleValue, ZeroBalance, Locked, GameNotApproved,
    // insufficient balance to burn, ...) is swallowed — the invariant must hold
    // whether the action lands or reverts.
    for (let k = 0; k < ACTIONS; k++) {
      const choice = rand();
      try {
        if (choice < 0.38) {
          // predict — 1- or 2-game batch, random actor + direction, sometimes referred
          const actor = pick(allActors);
          const n = rand() < 0.4 ? 2 : 1;
          const gids = [];
          for (let j = 0; j < n; j++) { const g = pick(allGameIds); if (!gids.includes(g)) gids.push(g); }
          const reqs = gids.map((g) => ({ gameId: g, payload: pack1(rand() < 0.5 ? UP : DOWN) }));
          if (rand() < 0.15) {
            await satori.connect(actor).predictMultipleWithReferral(pick(allActors).address, reqs);
          } else {
            await satori.connect(actor).predictMultipleWithPayloads(reqs);
          }
        } else if (choice < 0.62) {
          // settle a random actor's prediction on a random game (accrues rewards)
          await satori.settlePrediction(pick(allActors).address, pick(allGameIds));
        } else if (choice < 0.76) {
          // claim (moves owed → minted; exercises referral-cut direct mint)
          await satori.connect(pick(allActors))["claim()"]();
        } else if (choice < 0.86) {
          // vote — BURNS SATORI to buy the game permanent weight (changes the
          // reward split, and destroys supply the voter can no longer predict with)
          await satori.connect(pick(allActors)).vote(pick(votableGameIds), FUZZ_BURN);
        } else if (choice < 0.95) {
          // delegate prediction power (exercises the delegator reward-split path)
          const a = pick(allActors), b = pick(allActors);
          if (a.address !== b.address) await satori.connect(a).delegatePredictionPower(b.address);
        } else {
          // Successor to the old clearVote branch. A burn cannot be undone, so
          // the only lever that moves weight out of the pool now is the admin
          // disable switch — it subtracts the game's weight from
          // totalBurnedWeight and restores it on re-enable. Toggled off and
          // straight back on inside one action deliberately: a disable also
          // blocks SCORING for rounds that predate it, and a prediction scored
          // while dark is marked scored at zero forever, so leaving a game off
          // across actions makes the whole run vacuous (verified: seed
          // 0x5a7021 produced literally zero accrual that way). This exercises
          // the weight accounting without silently gutting the fuzz.
          const g = pick(allGameIds);
          await voting.connect(owner).setGameApproved(g, false);
          await voting.connect(owner).setGameApproved(g, true);
        }
      } catch (e) { /* legitimate revert — ignore, then re-assert the invariant */ }
      await checkInvariant(`r${r} action${k}`);
    }

    await advanceRound();
    await checkInvariant(`r${r} post-advance`);
  }

  // --- Non-vacuity: prove the run actually exercised real accrual (otherwise an
  // all-reverts run would satisfy the invariant trivially). ---
  const finalMinted = await satori.totalRewardsMinted();
  let finalOwed = 0n;
  for (const a of owedAddrs) finalOwed += (await lens.getTotalClaimableRewards(a))[0];
  const rewardValueCreated = (finalMinted - (await satori.INITIAL_MINT())) + finalOwed; // exclude genesis
  expect(rewardValueCreated, "VACUOUS RUN: no reward value was created").to.be.gt(ethers.parseEther("100"));
  // platform fee moved to immutable token (see test/next/DevFee.test.js): it no
  // longer accrues into claimable rewards, so the old fee-accrual non-vacuity
  // assertion is dropped.
  // Second non-vacuity leg: at least one fuzz `vote` must have LANDED, or the
  // burn-voting lane would be silently untested (every vote can revert — the
  // prediction lock blocks the burn, and a drained voter has nothing to burn).
  expect(
    await voting.totalBurnedWeight(),
    "VACUOUS RUN: no fuzz vote ever landed"
  ).to.be.gt(SEED_BURN * 4n);
}

describe("Reward budget invariant — minted + owed ≤ 1440 × roundsElapsed", function () {
  this.timeout(600000);

  // A few independent seeds broaden the action interleavings explored.
  for (const seed of [0xC0FFEE, 0x5A7021, 0xBADF00D]) {
    it(`holds across a randomized predict/settle/claim/vote/delegate run (seed 0x${(seed >>> 0).toString(16)})`, async function () {
      await runFuzz(seed >>> 0);
    });
  }
});
