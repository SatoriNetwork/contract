/**
 * MEGA CONSERVATION SIMULATION — cluster: megasim-all-invariants
 *
 * A single long (>=40 round) deterministic, seeded simulation that exercises
 * EVERYTHING the protocol can do at once and asserts the FULL invariant set
 * after every round:
 *
 *   INV-1  totalRewardsMinted + Σ unclaimedRewards <= ROUND_REWARD_BUDGET ×
 *          (curRound - deployRound + 1).
 *          This is the protocol's eager-credit shadow solvency law: every
 *          token the protocol has *promised* (minted OR sitting in an
 *          unclaimedRewards bucket as an eager credit) is coverable by the
 *          cumulative emission schedule. The contract mints reward SATORI
 *          lazily at claim time, so the backing for the shadow is the right
 *          to mint under the cap — not a held balance. (Mirrors
 *          foundry/Rewards.invariant.t.sol and echidna's
 *          unclaimedRewardsSolvent.) The plain mint-cap
 *          (totalRewardsMinted <= cap) is implied and asserted too.
 *
 *   INV-2  Burn-weight ledger: voting.totalBurnedWeight() == Σ gameWeight(g)
 *          over every ENABLED non-default game, and the default game's weight
 *          is exactly the derived 1%-of-a-denominator-including-itself,
 *          floored at 1e18. Under burn voting this replaces the old
 *          "Σ getVotingPower == totalSupply" law: voting no longer stakes a
 *          live balance (which delegation could shuffle and a hook could lose)
 *          — it DESTROYS tokens and credits permanent weight, so the thing that
 *          can now leak or double-count is the weight ledger, not the balance.
 *          Transfers, claim/predict delegation and reward mints must not touch
 *          it at all.
 *
 *   INV-3  Round denominator: for every FINISHED round r,
 *          Σ gameVotesAtRound[g][r] over ALL games == voting.roundDenominator(r).
 *          (Mirrors LockstepInvariant.test.js.) The old heap snapshot, the
 *          round-totals lock and the LockstepBroken guard are gone: numerator
 *          and denominator are now written in one branch of
 *          recordGameVotesForRound by the round's first predictor of each game.
 *
 *   INV-4  Bounty solvency (no over-distribution): for each bounty ERC20, the
 *          bounties contract's on-chain token balance >= every outstanding
 *          liability denominated in that token:
 *            Σ pool[stream][tk]        (undripped reserve, locked in-contract)
 *          + Σ bountyStake[user][tk]   (unstakeable: staked + auto-compounded wins)
 *          The protocol can always honor every promised bounty token. A breach
 *          would mean over-distribution (e.g. a double-credit minting more
 *          bountyStake than was actually dripped). roundBountyPot is NOT a
 *          liability here — it's a per-round denominator snapshot that is never
 *          decremented at credit time (the credited value already lives in
 *          bountyStake), so any uncredited residue is untracked
 *          surplus that only makes the balance >= liabilities bound safer.
 *
 * RULES: every assertion is in the SAFE direction (<= cap, == conservation,
 * balance >= liabilities). Nothing is weakened to force green. If any of these
 * fire, that is a NEW finding (the file is then relocated out of the green
 * suite and recorded).
 *
 * Determinism: a fixed-seed LCG (no Math.random). this.timeout(600000).
 * Rounds advance via time.increase(86400) (one 24h round).
 */

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture, pack1 } = require("../fixtures");

const ROUND_SECONDS = 86400;
const ROUND_REWARD_BUDGET = 720n * 10n ** 18n;
const UP = 1;
const DOWN = 2;
const DEFAULT_GAME = 1;              // the protocol's own game — derived weight
const DEFAULT_SHARE_BPS = 100n;     // SatoriVoting.DEFAULT_SHARE_BPS
const DEFAULT_WEIGHT_FLOOR = 10n ** 18n; // SatoriVoting.DEFAULT_WEIGHT_FLOOR

// --- deterministic LCG (Numerical Recipes constants), fixed seed --------------
function makeRng(seed) {
  let state = BigInt.asUintN(32, BigInt(seed));
  return {
    next() {
      state = (1664525n * state + 1013904223n) % (2n ** 32n);
      return Number(state);
    },
    // Take the HIGH 16 bits: a power-of-two-modulus LCG has notoriously short
    // periods in its LOW bits (the bottom bit alternates with period 2), which
    // silently starved the rarer branches of this sim — `action = int(10)` was
    // strictly alternating parity, so half the action table was under-sampled.
    _draw() {
      return Math.floor(this.next() / 65536);
    },
    // integer in [0, n)
    int(n) {
      return this._draw() % n;
    },
    // boolean with ~p/100 chance true
    chance(pPercent) {
      return this._draw() % 100 < pPercent;
    },
    pick(arr) {
      return arr[this._draw() % arr.length];
    },
  };
}

async function advanceOneRound() {
  await time.increase(ROUND_SECONDS);
}

// A public caller may only create streams at cadence >= 2 rounds, and both
// `createSimpleDataStream(name, provider)` and the 4-arg
// `createAdapterDataStream` now hand out exactly that. BIN-1 / BIN-2 / ADP-1 are
// therefore daily streams: one value per cadence period, so a simulation STEP
// spans CADENCE_ROUNDS protocol rounds and predictions live in the round the
// value was published.
const CADENCE_ROUNDS = 2;

async function advanceCadenceStep() {
  for (let i = 0; i < CADENCE_ROUNDS; i++) await advanceOneRound();
}

async function streamIdFromTx(tx, satori) {
  const rcpt = await tx.wait();
  for (const log of rcpt.logs) {
    try {
      const p = satori.interface.parseLog(log);
      if (p && p.name === "DataStreamCreated") return Number(p.args.streamId);
    } catch (e) {}
  }
  throw new Error("DataStreamCreated not found");
}

describe("MEGASIM all-invariants conservation simulation", function () {
  this.timeout(600000);

  it("holds the full invariant set across 44 adversarial rounds", async function () {
    const rng = makeRng(0xC0FFEE);

    const fix = await deploySatoriFixture();
    const { satori, voting, rewards, bounties, registry, games, owner, signers } = fix;
    const satoriAddr = await satori.getAddress();
    const bountiesAddr = await bounties.getAddress();

    // ---- users: 8 with varied balances --------------------------------------
    const users = signers.slice(1, 9); // 8 users
    const balances = [
      ethers.parseEther("90"),
      ethers.parseEther("60"),
      ethers.parseEther("45"),
      ethers.parseEther("30"),
      ethers.parseEther("22"),
      ethers.parseEther("15"),
      ethers.parseEther("9"),
      ethers.parseEther("4"),
    ];
    for (let i = 0; i < users.length; i++) {
      await satori.transfer(users[i].address, balances[i]);
    }

    // The DEFAULT stream/game is already live at id 1 — the fixture calls
    // initializeDefaultStream() exactly as production deploys. Its weight is
    // DERIVED (1% of the denominator, floored at 1e18), it cannot be voted on
    // and it cannot be disabled. Consequence: the streams created below start
    // at id 2.

    // ---- streams: a couple of simple (binary) + one adapter game ------------
    // Providers are users. NOTE: value providers are no longer paid by the
    // protocol at all (the provider cut was removed with the refactor); the
    // whole per-game slice goes to that game's predictors. The provider
    // addresses remain because the registry still gates who may setValue.
    const sBin1 = await streamIdFromTx(
      await satori.createSimpleDataStream("BIN-1", users[6].address), satori);
    const sBin2 = await streamIdFromTx(
      await satori.createSimpleDataStream("BIN-2", users[7].address), satori);

    // Adapter game stream: use the Custom adapter (id 3) which reads the
    // registry value directly — same setValue/ABC scoring mechanics, but
    // exercises the type-1 adapter game prediction path.
    const { createCustomStream } = require("../fixtures");
    const sAdp = await streamIdFromTx(
      await createCustomStream(satori, "ADP-1", users[5].address), satori);

    const streams = [sBin1, sBin2, sAdp];

    // Burn voting SPENDS tokens, so `vote` goes through the token's `_update`
    // and is subject to the LANE_A transfer lock. Two protocol rules therefore
    // gate every governance burn — neither existed when voting merely staked a
    // live balance:
    //   * predicting in round R locks the predictor through R+1
    //     (SatoriEngine.predict -> hub.engineLock(user, round + 1));
    //   * delegating prediction power locks the delegator INDEFINITELY until
    //     they undelegate (SatoriRewards -> hub.lockUntilUndelegation).
    // A sim where 30% of actions predict and 10% delegate leaves almost nobody
    // able to burn, which would silently starve INV-2. Model what a real
    // governance burn looks like instead: the burn happens, performed by a
    // holder whose tokens are actually unlocked. Returns null if every user is
    // locked (then no burn lands that round, which is also realistic).
    const token = fix.token;
    async function unlockedVoter(preferred) {
      const cur = BigInt(await satori.getCurrentRound());
      // SatoriToken._update reverts Locked() when `l != 0 && l >= currentRound`.
      const free = async (a) => {
        const l = BigInt(await token.transferLockedUntil(a.address));
        return l === 0n || l < cur;
      };
      if (await free(preferred)) return preferred;
      for (const c of users) if (await free(c)) return c;
      return null;
    }

    // Bootstrap eligibility: each stream gets a BURN so it carries weight and
    // therefore earns. Amounts differ so the games hold unequal shares of the
    // round denominator. Each voter keeps the bulk of their balance to predict
    // with (prediction power is balance + unclaimed).
    await satori.connect(users[0]).vote(sBin1, ethers.parseEther("12"));
    await satori.connect(users[1]).vote(sBin2, ethers.parseEther("8"));
    await satori.connect(users[2]).vote(sAdp, ethers.parseEther("5"));

    // ---- bounty tokens (MockERC20) ------------------------------------------
    const M = await ethers.getContractFactory("MockERC20");
    const usd = await M.deploy("USDC", "USDC");
    await usd.waitForDeployment();
    const wbtc = await M.deploy("WBTC", "WBTC");
    await wbtc.waitForDeployment();
    const bountyTokens = [usd, wbtc];
    const bountyTokenAddrs = [await usd.getAddress(), await wbtc.getAddress()];

    // Seed every user generously with both bounty tokens.
    for (const tk of bountyTokens) {
      for (const u of users) {
        await tk.mint(u.address, ethers.parseEther("1000000"));
        await tk.connect(u).approve(bountiesAddr, ethers.parseEther("1000000000"));
      }
    }

    // Fund initial bounties on two streams with both tokens.
    await bounties.connect(users[0]).fundBounty(sBin1, bountyTokenAddrs[0], ethers.parseEther("5000"), ethers.parseEther("250"));
    await bounties.connect(users[1]).fundBounty(sAdp, bountyTokenAddrs[1], ethers.parseEther("3000"), ethers.parseEther("150"));

    // ---- referrals (set-once) -----------------------------------------------
    await rewards.connect(users[3]).setReferral(users[0].address);
    await rewards.connect(users[4]).setReferral(users[1].address);

    // The universe of addresses that can ever carry an unclaimedRewards eager
    // credit: users + owner (fee recipient + referrer) + contract addresses
    // (referral cuts and the default-stream cut land in buckets).
    const rewardUniverse = [
      owner.address,
      satoriAddr,
      await rewards.getAddress(),
      bountiesAddr,
      ...users.map((u) => u.address),
    ];

    const deploymentRound = BigInt(await satori.deploymentRound());

    // ---- per-step value state for scoring -----------------------------------
    // Each stream tracks its current registry value. These are cadence-2
    // streams, which are NOT on the every-round A-B-C window (SatoriEngine:
    // `isABC = minCadenceRounds <= 1`): a prediction resolves against the value
    // at its own round versus the NEXT value published, one step later.
    const streamVal = { [sBin1]: 1000, [sBin2]: 5000, [sAdp]: 20000 };

    // Track which (user, stream, predictRound, direction) predictions are
    // pending settlement so we can settle with the right gaps later.
    const pending = []; // {user, stream, round}

    // ---------------- INVARIANT CHECKERS -------------------------------------
    // Games the admin has switched off (the sim toggles one mid-run).
    const disabledGames = new Set();
    // Non-degeneracy instrumentation: INV-2/INV-3 are equalities, so they are
    // trivially satisfied if nothing ever burns or participates.
    let disableToggles = 0;
    let votesLanded = 0;

    async function sumUnclaimedRewards() {
      let s = 0n;
      for (const a of rewardUniverse) s += BigInt(await rewards.unclaimedRewards(a));
      return s;
    }

    // For lockstep + bounty-pot scans we need a recent round window.
    async function assertInvariants(label, round) {
      const cur = BigInt(await satori.getCurrentRound());

      // INV-1: eager-credit shadow solvency (and the plain mint cap).
      const minted = BigInt(await satori.totalRewardsMinted());
      const pendingShadow = await sumUnclaimedRewards();
      const cap = ROUND_REWARD_BUDGET * (cur - deploymentRound + 1n);
      expect(minted).to.be.lte(cap, `[${label}] mint cap breached: minted=${minted} cap=${cap}`);
      expect(minted + pendingShadow).to.be.lte(
        cap,
        `[${label}] eager-credit shadow exceeds cap: minted=${minted} pending=${pendingShadow} cap=${cap}`
      );

      // INV-2: the burn-weight ledger. totalBurnedWeight is Σ gameWeight over
      // ENABLED non-default games (the default is excluded on purpose — its
      // weight derives FROM this total, so including it would be circular).
      const gameCount = Number(await games.gameCount());
      let ledger = 0n;
      for (let g = 2; g <= gameCount; g++) {
        if (disabledGames.has(g)) continue;
        ledger += BigInt(await voting.gameWeight(g));
      }
      const tbw = BigInt(await voting.totalBurnedWeight());
      expect(tbw).to.equal(
        ledger,
        `[${label}] totalBurnedWeight(${tbw}) != Σ enabled gameWeight(${ledger})`
      );
      // ...and the default game's weight is exactly the derived share, floored.
      const rawDerived = (tbw * DEFAULT_SHARE_BPS) / (10000n - DEFAULT_SHARE_BPS);
      const expectDerived = rawDerived < DEFAULT_WEIGHT_FLOOR ? DEFAULT_WEIGHT_FLOOR : rawDerived;
      expect(BigInt(await voting.defaultDerivedWeight())).to.equal(
        expectDerived, `[${label}] default derived weight drifted`);
      expect(BigInt(await voting.weightOf(DEFAULT_GAME))).to.equal(
        expectDerived, `[${label}] weightOf(default) != derived weight`);

      // INV-3: the round denominator equals the sum of that round's frozen
      // numerators, for every FINISHED round in a recent window. The sum must
      // cover EVERY game id, including the default game (id 1) and any game
      // that was later disabled — a stray numerator anywhere breaks it.
      // `roundDenominator` reverts RoundNotFinal for the still-open round, so
      // the window stops one short of `cur`.
      const lo = cur > 8n ? cur - 8n : 0n;
      for (let r = lo; r < cur; r++) {
        const denom = BigInt(await voting.roundDenominator(r));
        let sumNum = 0n;
        for (let g = 1; g <= gameCount; g++) {
          sumNum += BigInt(await voting.getGameVotesAtRound(g, r));
        }
        expect(sumNum).to.equal(
          denom,
          `[${label}] denominator broken at round ${r}: Σ gameVotes(${sumNum}) != roundDenominator(${denom})`
        );
      }

      // INV-4: bounty solvency per token.
      for (let ti = 0; ti < bountyTokens.length; ti++) {
        const tk = bountyTokens[ti];
        const tkAddr = bountyTokenAddrs[ti];
        const bal = BigInt(await tk.balanceOf(bountiesAddr));

        // True (non-over-distribution) liabilities are the buckets that are
        // still owed to / locked for someone:
        //   pool[stream]            — undripped reserve (locked, no recover path
        //                             but still held by the contract)
        //   bountyStake[user]       — unstakeable (incl. auto-compounded wins)
        //
        // roundBountyPot is DELIBERATELY excluded: it is a per-round denominator
        // snapshot that is NEVER decremented at credit time (the credited share
        // moves into bountyStake while the pot value persists
        // — see SatoriBounties._accrueBountyForWinToken and the
        // bounty-staking.cov "residue" case). Counting it would double-count the
        // value already reflected in bountyStake. Any uncredited pot residue
        // simply remains as untracked surplus in `bal`, which only makes the
        // balance >= liabilities bound *safer*.
        //
        // The invariant being enforced: the contract can always honor every
        // promised bounty token — Σ distributed-or-locked <= tokens actually
        // funded in. A breach here would mean over-distribution (e.g. a
        // double-credit minting more bountyStake than was dripped).
        let liabilities = 0n;
        const bStreamCount = Number(await registry.getDataStreamCount());
        for (let sid = 1; sid <= bStreamCount; sid++) {
          liabilities += BigInt(await bounties.pool(sid, tkAddr));
        }
        for (const a of [owner.address, ...users.map((u) => u.address)]) {
          liabilities += BigInt(await bounties.bountyStake(a, tkAddr));
        }

        expect(bal).to.be.gte(
          liabilities,
          `[${label}] bounty insolvent for token ${ti}: balance=${bal} liabilities=${liabilities}`
        );
      }
    }

    // initial check before the loop
    await advanceCadenceStep();
    await assertInvariants("init", 0);

    const ROUNDS = 44;
    for (let round = 1; round <= ROUNDS; round++) {
      await advanceCadenceStep();

      // Tick the default stream every round: fee accrual + default-stream cut +
      // fee schedule. Past the FEE_DROP_ROUND boundary the schedule drops the
      // fee; we additionally force the boundary partway through (see below).
      try { await satori.flushDefaultStream(); } catch (e) {}

      // --- publish fresh values (one per stream per cadence step) ---
      // Drive each stream's value so a prediction made LAST step resolves
      // deterministically against this step's value. We move every stream UP
      // most steps, occasionally DOWN, so both correct and incorrect
      // predictions occur.
      const goesDown = rng.chance(25); // 25% of rounds the streams dip
      for (const sid of streams) {
        const delta = (rng.int(40) + 5); // 5..44
        if (goesDown) {
          streamVal[sid] = Math.max(1, streamVal[sid] - delta);
        } else {
          streamVal[sid] = streamVal[sid] + delta;
        }
        try {
          const provSigner = users[sid === sBin1 ? 6 : sid === sBin2 ? 7 : 5];
          await registry.connect(provSigner).setValue(sid, streamVal[sid]);
        } catch (e) {
          try { await registry.setValue(sid, streamVal[sid]); } catch (e2) {}
        }
      }

      // --- settle pending predictions with multi-step gaps ---
      // On a cadence-2 stream a prediction made in step R is settleable as soon
      // as the NEXT value is published (step R+1); we deliberately wait until
      // R+2 so every settle also exercises the gap path. We settle a random
      // subset each step, leaving others to accumulate — exercising the
      // settlement cursor + the delegator open-round replay across gaps.
      const stillPending = [];
      for (const p of pending) {
        const ageOk = round >= p.round + 2; // resolving value published (and then some)
        // Settle ~60% of eligible ones each round; carry the rest (gap).
        if (ageOk && rng.chance(60)) {
          try { await satori.settlePrediction(p.user.address, p.stream); } catch (e) {}
        } else if (ageOk && round >= p.round + 6) {
          // Force-settle very old ones (large gap) so they don't linger forever.
          try { await satori.settlePrediction(p.user.address, p.stream); } catch (e) {}
        } else {
          stillPending.push(p);
        }
      }
      pending.length = 0;
      pending.push(...stillPending);

      // --- per-user random actions ---
      for (let ui = 0; ui < users.length; ui++) {
        const u = users[ui];
        const action = rng.int(10);

        try {
          if (action === 0 || action === 1 || action === 2) {
            // PREDICT on a random stream (mix binary + adapter).
            const sid = rng.pick(streams);
            const dir = rng.chance(60) ? UP : DOWN; // bias UP (usually correct)
            await satori.connect(u).predictMultipleWithPayloads([{ gameId: sid, payload: pack1(dir) }]);
            pending.push({ user: u, stream: sid, round });
          } else if (action === 3) {
            // VOTE: BURN SATORI to buy a game permanent weight. Bounded to a
            // slice of the balance so the user survives to keep predicting
            // (prediction power is balance + unclaimed).
            const v = await unlockedVoter(u);
            if (v) {
              const bal = BigInt(await satori.balanceOf(v.address));
              const amt = bal / BigInt(6 + rng.int(6));
              if (amt > 0n) { await satori.connect(v).vote(rng.pick(streams), amt); votesLanded++; }
            }
          } else if (action === 4) {
            // A second, smaller burn on a different game — weight is permanent,
            // so the only way to change the balance of power is to buy more.
            const v = await unlockedVoter(u);
            if (v) {
              const bal = BigInt(await satori.balanceOf(v.address));
              const amt = bal / 20n;
              if (amt > 0n) { await satori.connect(v).vote(rng.pick(streams), amt); votesLanded++; }
            }
          } else if (action === 5) {
            // PREDICTION-POWER DELEGATION.
            const tgt = rng.pick(users);
            await satori.connect(u).delegatePredictionPower(tgt.address);
          } else if (action === 6) {
            // CLAIM rewards (realizes eager-credit shadow into minted supply).
            await satori.connect(u)["claim()"]();
          } else if (action === 7) {
            // TRANSFER SATORI to another user (churns balances while delegated).
            const tgt = rng.pick(users);
            const bal = BigInt(await satori.balanceOf(u.address));
            if (bal > 0n) {
              const amt = bal / BigInt(2 + rng.int(8));
              if (amt > 0n) await satori.connect(u).transfer(tgt.address, amt);
            }
          } else if (action === 8) {
            // BOUNTY STAKE a random token (enables boost on next predict).
            const ti = rng.int(bountyTokens.length);
            const amt = ethers.parseEther(String(50 + rng.int(450)));
            await bounties.connect(u).stakeBountyToken(bountyTokenAddrs[ti], amt);
          } else {
            // CLAIM DELEGATION (routes a user's claim path to a delegate).
            const tgt = rng.chance(25) ? u : rng.pick(users);
            await satori.connect(u).delegateClaimAbility(tgt.address);
          }
        } catch (e) {
          // Adversarial sim deliberately includes blocked/invalid paths
          // (locked stakes, eligibility gates, delegated-away claims, etc.).
          // Global invariants are asserted below regardless of local reverts.
        }
      }

      // --- participation top-up ---
      // INV-3 is an equality over a round's frozen numerators, so it only says
      // something about rounds that actually had a participant. The random walk
      // leaves a lot of empty rounds (predicts revert on stale values, cadence
      // gaps and disabled games), so if this round is still empty, walk the
      // enabled streams until one prediction lands.
      if (BigInt(await voting.roundVoteTotal(await satori.getCurrentRound())) === 0n) {
        outer:
        for (const sid of streams) {
          if (disabledGames.has(sid)) continue;
          for (const u of users) {
            try {
              await satori.connect(u).predictMultipleWithPayloads(
                [{ gameId: sid, payload: pack1(UP) }]);
              pending.push({ user: u, stream: sid, round });
              break outer;
            } catch (e) {}
          }
        }
      }

      // --- occasional extra bounty funding (churn the pool/rate) ---
      if (rng.chance(30)) {
        try {
          const sid = rng.pick(streams);
          const ti = rng.int(bountyTokens.length);
          const fundAmt = ethers.parseEther(String(500 + rng.int(2000)));
          const rate = ethers.parseEther(String(20 + rng.int(120)));
          await bounties.connect(rng.pick(users)).fundBounty(sid, bountyTokenAddrs[ti], fundAmt, rate);
        } catch (e) {}
      }

      // --- occasional admin disable / re-enable of a weighted game ---
      // The disable switch is the protocol's only defence against a manipulated
      // game now that burnt weight is permanent, and it is the one thing that
      // can REMOVE weight from the ledger, so the sim must exercise it.
      if (rng.chance(20)) {
        const sid = rng.pick(streams);
        const want = !disabledGames.has(sid);
        try {
          await voting.connect(owner).setGameApproved(sid, !(want));
          if (want) disabledGames.add(sid); else disabledGames.delete(sid);
          disableToggles++;
        } catch (e) {}
      }

      // --- occasional bounty unstake (drains stake; gated by lock) ---
      if (rng.chance(25)) {
        try {
          const u = rng.pick(users);
          const ti = rng.int(bountyTokens.length);
          const staked = BigInt(await bounties.bountyStake(u.address, bountyTokenAddrs[ti]));
          if (staked > 0n) {
            await bounties.connect(u).unstakeBountyToken(bountyTokenAddrs[ti], staked / 2n, u.address);
          }
        } catch (e) {}
      }

      // === FULL INVARIANT CHECK after the round ===
      await assertInvariants(`round ${round}`, round);
    }

    // Final drain sweep: settle everything still pending, everyone claims,
    // fee recipient accrues + claims, then re-assert the full invariant set.
    await advanceCadenceStep();
    try { await satori.flushDefaultStream(); } catch (e) {}
    for (const sid of streams) {
      streamVal[sid] += 100;
      try { await registry.setValue(sid, streamVal[sid]); } catch (e) {}
    }
    await advanceCadenceStep();
    for (const sid of streams) {
      streamVal[sid] += 100;
      try { await registry.setValue(sid, streamVal[sid]); } catch (e) {}
    }
    // Re-enable everything so the final settle sweep can actually score (a
    // disabled game blocks scoring even for rounds that predate the disable).
    for (const sid of [...disabledGames]) {
      await voting.connect(owner).setGameApproved(sid, true);
      disabledGames.delete(sid);
    }
    for (const p of pending) {
      try { await satori.settlePrediction(p.user.address, p.stream); } catch (e) {}
    }
    for (const u of users) {
      try { await satori.connect(u)["claim()"](); } catch (e) {}
    }
    try { await satori.connect(owner)["claim()"](); } catch (e) {}

    await assertInvariants("final drain", ROUNDS + 2);

    // Sanity: the sim did real work — reward minting climbed well past the
    // bootstrap, so the cap was under genuine pressure (not a vacuous pass).
    const finalMinted = BigInt(await satori.totalRewardsMinted());
    expect(finalMinted).to.be.gt(ROUND_REWARD_BUDGET);

    // ...and INV-2 / INV-3 were not vacuous: weight was really bought, games
    // were really switched off and on, and rounds really had participants.
    let roundsWithDenominator = 0;
    const finalRound = BigInt(await satori.getCurrentRound());
    for (let r = BigInt(deploymentRound); r < finalRound; r++) {
      if (BigInt(await voting.roundDenominator(r)) > 0n) roundsWithDenominator++;
    }
    // eslint-disable-next-line no-console
    console.log(
      `      [sim] votes=${votesLanded} disableToggles=${disableToggles} ` +
      `roundsWithDenominator=${roundsWithDenominator} ` +
      `totalBurnedWeight=${ethers.formatEther(await voting.totalBurnedWeight())}`);
    expect(votesLanded, "no burn ever landed — INV-2 is vacuous").to.be.gt(10);
    expect(disableToggles, "the disable switch never fired").to.be.gt(2);
    expect(roundsWithDenominator, "no round ever had a participant — INV-3 is vacuous")
      .to.be.gt(20);
    expect(BigInt(await voting.totalBurnedWeight()), "no weight was ever bought")
      .to.be.gt(0n);

    if (process.env.SIM_DEBUG) {
      let stakeUsd = 0n, stakeWbtc = 0n;
      for (const u of users) {
        stakeUsd += BigInt(await bounties.bountyStake(u.address, bountyTokenAddrs[0]));
        stakeWbtc += BigInt(await bounties.bountyStake(u.address, bountyTokenAddrs[1]));
      }
      console.log("    [sim] totalRewardsMinted =", ethers.formatEther(finalMinted));
      console.log("    [sim] Σ bountyStake USDC  =", ethers.formatEther(stakeUsd));
      console.log("    [sim] Σ bountyStake WBTC  =", ethers.formatEther(stakeWbtc));
      console.log("    [sim] totalSupply         =", ethers.formatEther(await satori.totalSupply()));
    }
  });
});
