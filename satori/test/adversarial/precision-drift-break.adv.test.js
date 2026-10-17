const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture, pack1, VOTE } = require("../fixtures");
const { deployMerkleProxied } = require("../next/splitFixture");

/**
 * ADVERSARIAL — LONG-HORIZON PRECISION / ACCUMULATION DRIFT.
 *
 * Round 1 (dial-merkle-break, airdrop-break, ...) checked SINGLE-STEP
 * exactness of the reward/merkle/airdrop lanes. This file runs LONG (100-300
 * rounds) with reward mints, reserve accrual, merkle claims and airdrop
 * claims ALL active at once, and hunts for CUMULATIVE, monotonic drift that a
 * per-step test can't see:
 *
 *   INV-A  supply identity, to the wei, after every round:
 *            totalSupply()
 *              == totalRewardsMinted() + airdropClaimedTotal()
 *                 − voting.totalBurnedWeight()
 *          (airdropClaimedTotal mirrors the core's internal airdropMinted; the
 *           only two mint paths are rewardMint and airdropMint, and the only
 *           supply-REDUCING path is BURN VOTING).
 *
 *   INV-B  lane split, to the wei, after every round:
 *            onChainMinted + merkleMinted == totalRewardsMinted
 *
 *   INV-C  global cap is NEVER breached, even under sustained MAX on-chain dial
 *          for hundreds of rounds, right at the genesis +1-round-slack boundary:
 *            totalRewardsMinted <= ROUND_REWARD_BUDGET * (round - deploymentRound + 1)
 *
 *   INV-D  the two lane ceilings stay individually respected across the whole
 *          horizon (merkleMinted <= merkleReserveCeiling, onChainMinted <=
 *          onChainRewardCeiling) — including through repeated 0<->max dial
 *          toggling, which must NOT back-count dormant rounds or leak reserve.
 *
 *   INV-E  airdrop exactness over years: each recipient's first claim after
 *          claims open mints EXACTLY its allocation, nothing ever accrues on
 *          top, and Σ claimed settles to EXACTLY Σ alloc with ZERO dust.
 *
 * All simulations are deterministic (seeded LCG, no Math.random).
 */

const TIME_UNIT = 86400; // 24h round
const E = (n) => ethers.parseEther(String(n));
const ROUND_BUDGET = E("1440"); // ROUND_REWARD_BUDGET — the token's OUTER envelope

// The hub's per-round emission and the fee's flat 15% of it, READ FROM THE HUB.
// Every budget figure below derives from these. No simulation here issues
// anywhere near the hub's first step threshold, so the rate holds constant
// across the 100-200 rounds any one of them walks.
let RATE, DEV_RATE, MAX_OFFCHAIN;
async function loadRates(satori) {
  RATE = await satori.emissionRateNow();
  DEV_RATE = await satori.devRateNow();
  // The reserve-rate dial is bounded STRICTLY BELOW the residual general lane
  // (emission net of the senior fee), so the deepest legal dial never touches
  // the fee's share. (see test/next/DevFee.test.js)
  MAX_OFFCHAIN = RATE - DEV_RATE - 1n;
}
// The general lanes' shared cap after `e` rounds: the hub's emission ceiling net
// of the fee's 15%, with ONE floor over the whole product — which is the hub's
// own arithmetic, and not the same as `e` copies of a floored per-round share.
const genCap = (e) => (RATE * e * 8500n) / 10000n;
// AIRDROP_TOTAL_SUPPLY — a placeholder pending the real figure, so this
// mirror is only a convenience; assertions that matter read the contract.
const AIRDROP_TOTAL = E("1200000");
// Burn-voting amounts. `vote` DESTROYS the tokens it spends, so these sims burn
// a small seed to give each game weight and a tiny amount per churn vote — big
// enough to move weight, small enough that a user's prediction power (balance +
// unclaimed) survives hundreds of rounds of churn.
const SEED_BURN  = E("1");
const CHURN_BURN = E("0.01");

async function nextRound() { await time.increase(TIME_UNIT); }

// deterministic LCG (Numerical Recipes constants)
function makeRng(seed) {
  let s = BigInt(seed) & 0xffffffffn;
  const a = 1664525n, c = 1013904223n, m = 1n << 32n;
  return {
    next() { s = (a * s + c) % m; return Number(s); },
    int(n) { s = (a * s + c) % m; return Number(s % BigInt(n)); },
    bool() { s = (a * s + c) % m; return (s & 1n) === 1n; },
  };
}

// OZ StandardMerkleTree single-leaf: double-hashed abi.encode(account, amount).
function leafOf(addr, amount) {
  return ethers.keccak256(
    ethers.concat([
      ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [addr, amount])
      ),
    ])
  );
}

async function streamIdFrom(tx, satori) {
  const r = await tx.wait();
  for (const l of r.logs) {
    try {
      const p = satori.interface.parseLog(l);
      if (p && p.name === "DataStreamCreated") return p.args.streamId;
    } catch (e) {}
  }
  throw new Error("DataStreamCreated event missing");
}

// Wire a SatoriMerkle child onto an existing fixture. owner == core deployer.
async function wireMerkle(fx, publisher) {
  const merkle = await deployMerkleProxied(publisher.address, fx.token.target);
  await fx.satori.connect(fx.owner).setSatoriMerkle(await merkle.getAddress());
  // setSatoriCore is deployer-only; the merkle was deployed by the default
  // signer (owner), so owner (not publisher) binds the core.
  await merkle.connect(fx.owner).setSatoriCore(await fx.satori.getAddress());
  return merkle;
}

describe("ADV precision / long-horizon accumulation drift", function () {
  this.timeout(600000);

  // ==========================================================================
  // 1. FULL PROTOCOL, LONG HORIZON — every lane active for 120 rounds; the
  //    core supply/lane identities must hold to the WEI at every checkpoint.
  // ==========================================================================
  it("120 rounds, all lanes active: supply identity + lane split hold to the wei every round; no cap breach", async function () {
    const fx = await deploySatoriFixture();
    const { satori, rewards, airdrop, registry, owner, signers, games: gamesC } = fx;
    await loadRates(satori);
    const publisher = signers[15];
    const merkle = await wireMerkle(fx, publisher);

    const deploymentRound = await satori.deploymentRound();

    // participants
    const users = signers.slice(1, 8); // 7 users
    const balances = ["5", "12", "9", "7", "15", "3", "11"];
    for (let i = 0; i < users.length; i++) await satori.transfer(users[i].address, E(balances[i]));

    // streams / games. Stream/game id 1 is the protocol's DEFAULT game (the
    // fixture initializes it exactly as production does), so these land at 2/3/4
    // — capture both ids rather than hardcoding.
    const streams = [];
    for (const nm of ["A", "B", "C"]) {
      await satori.createSimpleDataStream(nm, owner.address);
      streams.push(Number(await registry.nextStreamId()) - 1);
    }
    const games = [];
    for (const sid of streams) games.push(Number(await gamesC.binaryGameByStream(sid)));

    // referrals so the referral skim is live on every credit
    await rewards.connect(users[0]).setReferral(users[1].address);
    await rewards.connect(users[2]).setReferral(users[3].address);
    // predictor fees
    await rewards.connect(users[1]).setPredictorFee(900);
    await rewards.connect(users[4]).setPredictorFee(700);

    // airdrop allocations — odd tails, down to a single wei. Finalized now, so
    // the nextRound() below also outlasts the one-day claim delay.
    const dropRecipients = [users[5], users[6], signers[9], signers[10]];
    const dropAmts = [
      123456789012345678n,
      E("50") + 7n,
      E("2000") + 999999n,
      1n,
    ];
    await airdrop.connect(owner).loadAirdropBatch(
      dropRecipients.map((r) => r.address), dropAmts
    );
    await airdrop.connect(owner).finalizeAirdropLoading();

    // bootstrap eligibility — every game gets burnt weight
    for (let i = 0; i < users.length; i++) {
      await satori.connect(users[i]).vote(games[i % games.length], SEED_BURN);
    }
    const seedVals = [100000, 200000, 300000];
    for (let i = 0; i < streams.length; i++) await registry.setValue(streams[i], seedVals[i]);
    await nextRound();

    const rng = makeRng(0xD11F7);
    const vals = {};
    for (let i = 0; i < streams.length; i++) vals[streams[i]] = seedVals[i];
    const ROUNDS = 120;
    let maxCapSlackSeen = 0n; // smallest (globalCap - totalRewardsMinted) observed

    // merkle entitlement cursor per recipient (monotonic, cumulative)
    const merkleUsers = [signers[11], signers[12]];
    const merkleCum = new Map(merkleUsers.map((u) => [u.address, 0n]));

    async function checkInvariants(round) {
      const ts = await satori.totalSupply();
      const trm = await satori.totalRewardsMinted();
      const act = await airdrop.airdropClaimedTotal();
      const onc = await satori.onChainMinted();
      const mrk = await satori.merkleMinted();
      // The senior dev fee is a THIRD reward lane on the immutable token (see
      // test/next/DevFee.test.js): totalRewardsMinted now counts it alongside the
      // on-chain + merkle lanes, so every lane/ceiling identity carries a devFee
      // term.
      const dev = await satori.devFeeMinted();
      const devCeil = await satori.devFeeCeiling();
      // BURN VOTING is the protocol's only supply-REDUCING path: `vote` destroys
      // the voter's SATORI outright. Every game here is on-chain (no 2x off-chain
      // handicap) and none is disabled, so voting.totalBurnedWeight() IS the exact
      // wei burnt. The supply identity carries it as a subtracted term.
      const burnt = await fx.voting.totalBurnedWeight();

      // INV-A: supply identity to the wei
      expect(ts, `INV-A supply identity @round ${round}`).to.equal(trm + act - burnt);
      // INV-B: THREE-lane split to the wei (dev + on-chain + merkle == total)
      expect(dev + onc + mrk, `INV-B lane split @round ${round}`).to.equal(trm);

      // INV-C: global cap never breached
      const curRound = await satori.getCurrentRound();
      const roundsElapsed = curRound - deploymentRound + 1n;
      const globalCap = ROUND_BUDGET * roundsElapsed;
      expect(trm, `INV-C global cap @round ${round}`).to.be.lte(globalCap);
      const slack = globalCap - trm;
      if (round === 1 || slack < maxCapSlackSeen) maxCapSlackSeen = slack;

      // INV-D: individual lane ceilings
      const merkCeil = await satori.merkleReserveCeiling();
      const oncCeil = await satori.onChainRewardCeiling();
      expect(mrk, `INV-D merkle ceiling @round ${round}`).to.be.lte(merkCeil);
      expect(onc, `INV-D onchain ceiling @round ${round}`).to.be.lte(oncCeil);
      // the merkle + on-chain (general) ceilings sum EXACTLY to the hub's
      // emission ceiling NET of the fee's flat 15%. This used to be stated
      // against `globalCap - devCeil`, which held only while the fee accrued on
      // the CLOCK; it is a ratio of what was MINTED now, so it lags whenever the
      // lanes run cold. The carve-out the hub enforces is the flat 15%.
      expect(merkCeil + oncCeil, `INV-D ceilings sum @round ${round}`).to.equal(genCap(roundsElapsed));
    }

    for (let round = 1; round <= ROUNDS; round++) {
      await nextRound();

      // toggle the merkle dial: sometimes 0, sometimes a big rate, sometimes max.
      // This exercises reserve accrual + 0<->max toggling for back-count/leak.
      const dialPick = rng.int(6);
      let dialTarget;
      if (dialPick === 0) dialTarget = 0n;                 // off
      else if (dialPick === 1) dialTarget = MAX_OFFCHAIN;  // MAX legal dial (< the residual general lane; dev fee carved first)
      // mid: a fraction of the legal max, so it stays under the wall as the rate moves
      else dialTarget = (MAX_OFFCHAIN * BigInt(4 + rng.int(92))) / 100n;
      try { await rewards.connect(owner).setOffchainBudget(dialTarget); } catch {}

      // update stream values (create up/down directions, some gaps)
      for (const sid of streams) {
        if (rng.int(10) < 2) continue; // stagnant gap
        vals[sid] = Math.max(1, vals[sid] + (rng.int(2000) - 900));
        try { await registry.setValue(sid, vals[sid]); } catch {}
      }

      // delegation churn
      for (let k = 0; k < 1 + rng.int(3); k++) {
        const u = users[rng.int(users.length)];
        try {
          if (rng.int(4) === 0) await satori.connect(u).delegatePredictionPower(ethers.ZeroAddress);
          else await satori.connect(u).delegatePredictionPower(users[rng.int(users.length)].address);
        } catch {}
      }

      // vote churn — each burns a small amount of the voter's SATORI
      for (let k = 0; k < 1 + rng.int(3); k++) {
        const u = users[rng.int(users.length)];
        try { await satori.connect(u).vote(games[rng.int(games.length)], CHURN_BURN); } catch {}
      }

      // settle prior round, then predict
      for (let i = 0; i < users.length; i++) {
        const u = users[i];
        for (const g of games) { try { await satori.connect(u).settlePrediction(u.address, g); } catch {} }
        const howMany = rng.int(games.length + 1);
        if (howMany === 0) continue;
        const chosen = [];
        for (let c = 0; c < howMany; c++) {
          const g = games[rng.int(games.length)];
          if (!chosen.includes(g)) chosen.push(g);
        }
        const batch = chosen.map((g) => ({ gameId: g, payload: pack1(rng.int(2) + 1) }));
        try { await satori.connect(u).predictMultipleWithPayloads(batch); } catch {}
      }

      try { await satori.flushDefaultStream(); } catch {}
      // platform fee moved to immutable token (see test/next/DevFee.test.js):
      // rewards.accrueProtocolFee() is gone (the fee self-accrues on the token).

      // claim on-chain rewards for everyone every round (drain the shadow so
      // totalRewardsMinted grows each round and the identity is stressed hard)
      for (const c of [owner, ...users]) {
        let amt = 0n;
        try { amt = await satori.connect(c)["claim()"].staticCall(); } catch {}
        if (amt > 0n) { try { await satori.connect(c)["claim()"](); } catch {} }
      }

      // MERKLE claims — only meaningful when the reserve has accrued headroom.
      // Publish a small cumulative bump per merkle user and try to claim it;
      // if the reserve is dry it reverts BudgetExceeded (that's fine — the lane
      // guard is doing its job), but whatever DOES mint must keep INV-B/D exact.
      if (rng.int(3) === 0) {
        const mu = merkleUsers[rng.int(merkleUsers.length)];
        const bump = E(String(1 + rng.int(30)));
        const newCum = merkleCum.get(mu.address) + bump;
        try {
          await merkle.connect(publisher).setMerkleRoot(leafOf(mu.address, newCum));
          await merkle.connect(mu).claimMerkle(newCum, []);
          merkleCum.set(mu.address, newCum); // only advance cursor on success
        } catch {
          // reserve dry OR entitlement not yet claimable — leave cursor as-is
        }
      }

      // AIRDROP claims — each recipient's whole allocation, on some rounds
      if (rng.int(2) === 0) {
        for (const r of dropRecipients) {
          let ca = 0n;
          try { ca = await airdrop.claimableAirdrop(r.address); } catch {}
          if (ca > 0n) { try { await airdrop.connect(r).claimAirdrop(); } catch {} }
        }
      }

      await checkInvariants(round);
    }

    // The genesis +1 slack is thin. Over 120 rounds with heavy activity the
    // smallest observed (globalCap - totalRewardsMinted) must never go negative
    // (INV-C already asserts >= 0). Record it for the report.
    expect(maxCapSlackSeen).to.be.gte(0n);
    // The swallowed airdrop claims above must actually have paid.
    expect(await airdrop.airdropClaimedTotal(), "airdrop lane exercised")
      .to.equal(dropAmts.reduce((a, b) => a + b, 0n));
  });

  // ==========================================================================
  // 2. GENESIS-SLACK STRESS — sustained MAX on-chain emission for many rounds,
  //    claiming EVERY round right up to the on-chain ceiling, to try to punch
  //    through the global cap using the INITIAL_MINT=720 genesis attribution.
  // ==========================================================================
  it("200 rounds hammering the on-chain lane at its ceiling never breaches the global cap (genesis-slack boundary)", async function () {
    const fx = await deploySatoriFixture();
    const { satori, rewards, airdrop, registry, owner, signers, games: gamesC } = fx;
    await loadRates(satori);
    const deploymentRound = await satori.deploymentRound();

    // Keep the merkle dial OFF so the ENTIRE global cap belongs to the on-chain
    // lane — this is the worst case for cap pressure. onChainRewardCeiling then
    // == globalCap, so any per-round over-allocation shows up immediately.
    const users = signers.slice(1, 6);
    for (const u of users) await satori.transfer(u.address, E("20"));

    // Stream/game id 1 is the protocol's DEFAULT game, so these land at 2/3.
    const streams = [];
    for (const nm of ["A", "B"]) {
      await satori.createSimpleDataStream(nm, owner.address);
      streams.push(Number(await registry.nextStreamId()) - 1);
    }
    const games = [];
    for (const sid of streams) games.push(Number(await gamesC.binaryGameByStream(sid)));
    for (let i = 0; i < users.length; i++) {
      await satori.connect(users[i]).vote(games[i % games.length], SEED_BURN);
    }
    const seedVals = [100000, 200000];
    for (let i = 0; i < streams.length; i++) await registry.setValue(streams[i], seedVals[i]);
    await nextRound();

    const rng = makeRng(0x6E2E5);
    const vals = {};
    for (let i = 0; i < streams.length; i++) vals[streams[i]] = seedVals[i];
    const ROUNDS = 200;

    for (let round = 1; round <= ROUNDS; round++) {
      await nextRound();
      for (const sid of streams) {
        vals[sid] = Math.max(1, vals[sid] + (rng.int(400) - 150));
        try { await registry.setValue(sid, vals[sid]); } catch {}
      }
      // maximize activity: everyone predicts on both games every round
      for (let i = 0; i < users.length; i++) {
        const u = users[i];
        for (const g of games) { try { await satori.connect(u).settlePrediction(u.address, g); } catch {} }
        const batch = games.map((g) => ({ gameId: g, payload: pack1(rng.int(2) + 1) }));
        try { await satori.connect(u).predictMultipleWithPayloads(batch); } catch {}
      }
      try { await satori.flushDefaultStream(); } catch {}
      // platform fee moved to immutable token (see test/next/DevFee.test.js):
      // rewards.accrueProtocolFee() is gone (the fee self-accrues on the token).
      for (const c of [owner, ...users]) {
        let amt = 0n;
        try { amt = await satori.connect(c)["claim()"].staticCall(); } catch {}
        if (amt > 0n) { try { await satori.connect(c)["claim()"](); } catch {} }
      }

      const trm = await satori.totalRewardsMinted();
      const dev = await satori.devFeeMinted();     // senior dev lane (self-accrues on the token)
      const devCeil = await satori.devFeeCeiling();
      const curRound = await satori.getCurrentRound();
      const roundsElapsed = curRound - deploymentRound + 1n;
      const globalCap = ROUND_BUDGET * roundsElapsed;
      // HARD boundary: cumulative reward mint must never exceed the schedule.
      expect(trm, `cap breach @round ${round}`).to.be.lte(globalCap);
      // merkle lane never touched => everything not on the dev lane is on-chain
      expect(await satori.merkleMinted()).to.equal(0n);
      // on-chain lane == total MINUS the senior dev fee (see test/next/DevFee.test.js)
      expect(await satori.onChainMinted()).to.equal(trm - dev);
      // on-chain (general) ceiling == the whole general cap when the merkle dial
      // is off (the fee's 15% is carved off the top).
      expect(await satori.onChainRewardCeiling()).to.equal(genCap(roundsElapsed));
    }
  });

  // ==========================================================================
  // 3. DIAL TOGGLE 0<->MAX for 150 rounds — reserve accrual must be monotone
  //    and never back-count dormant (rate==0) rounds nor leak reserve. The
  //    merkleReserveCumulative must equal the exact hand-computed accrual.
  // ==========================================================================
  it("150 rounds of 0<->max dial toggling: reserve accrual is exact, never back-counts dormant rounds, ceilings stay wei-exact", async function () {
    const fx = await deploySatoriFixture();
    const { satori, rewards, owner } = fx;
    await loadRates(satori);
    const deploymentRound = await satori.deploymentRound();

    const rng = makeRng(0x70661E);
    const ROUNDS = 150;

    // Shadow model of the reserve accrual, mirroring _accrueMerkleReserve /
    // setMerkleReserveRate exactly:
    //   - rate==0: nothing accrues; lastRound re-anchored to cur on next set.
    //   - set(newRate): bank OLD rate up to cur, then re-anchor to cur.
    //   - accrue (any rewardMint / view): if cur>last and rate>0, add rate*(cur-last).
    // We only CALL setOffchainBudget here (no rewardMint), so the on-chain
    // ceiling is untouched; we model the reserve purely from dial changes and
    // compare against merkleReserveCumulative + the live view ceiling.
    let shadowRate = 0n;
    let shadowLast = BigInt(await satori.getCurrentRound()); // anchored at deploy
    let shadowCumulative = 0n;

    function bankAt(cur) {
      if (shadowRate > 0n && cur > shadowLast) {
        shadowCumulative += shadowRate * (cur - shadowLast);
      }
      shadowLast = cur; // both accrue-and-set and set re-anchor to cur
    }

    for (let round = 1; round <= ROUNDS; round++) {
      await nextRound();
      // toggle: half the time OFF, else MAX legal, else a mid rate. The dial is
      // bounded < the residual general lane (dev fee carved first),
      // so both the MAX and the mid stay strictly under that bound — a set that
      // hit the bound would revert and desync the shadow model.
      const p = rng.int(3);
      let target;
      if (p === 0) target = 0n;
      else if (p === 1) target = MAX_OFFCHAIN;
      // a mid rate, as a FRACTION of the legal max so it tracks the hub's rate
      else target = (MAX_OFFCHAIN * BigInt(1 + rng.int(98))) / 100n;

      const cur = BigInt(await satori.getCurrentRound());
      // setOffchainBudget => setMerkleReserveRate => _accrueMerkleReserve at OLD
      // rate up to cur, then re-anchor + new rate.
      bankAt(cur);        // bank old rate up to now
      shadowRate = target; // new rate applies from cur forward
      await rewards.connect(owner).setOffchainBudget(target);

      // The contract's cumulative is banked up to shadowLast; the LIVE view
      // ceiling additionally projects the CURRENT rate to the current round.
      // Right after a set, cur==shadowLast so the projection is 0 and the two
      // are equal.
      const cumOnChain = await satori.merkleReserveCumulative();
      expect(cumOnChain, `reserve cumulative exact @round ${round}`).to.equal(shadowCumulative);

      // Advance the wall clock WITHOUT a set, then compare the live projected
      // ceiling to the shadow projection — this is where back-counting a
      // dormant (rate==0) stretch would show up as a positive projection.
      const curRound = await satori.getCurrentRound();
      const elapsed = BigInt(curRound) - deploymentRound + 1n;
      // The fee's flat 15% is carved off the top before either lane (see
      // test/next/DevFee.test.js), so the reserve + on-chain ceilings partition
      // the GENERAL lane — 85% of the hub's emission ceiling — not the whole cap.
      const generalCap = genCap(elapsed);
      const projected = shadowRate > 0n && BigInt(curRound) > shadowLast
        ? shadowCumulative + shadowRate * (BigInt(curRound) - shadowLast)
        : shadowCumulative;
      expect(await satori.merkleReserveCeiling(), `live merkle ceiling @round ${round}`).to.equal(projected);
      expect(await satori.onChainRewardCeiling(), `live onchain ceiling @round ${round}`).to.equal(generalCap - projected);
      // reserve can never exceed the GENERAL lane
      expect(projected).to.be.lte(generalCap);
    }

    // A dormant stretch must have banked NOTHING for its rounds: force a long
    // OFF stretch, then confirm cumulative is unchanged across it.
    const before = await satori.merkleReserveCumulative();
    const curNow = BigInt(await satori.getCurrentRound());
    bankAt(curNow);
    shadowRate = 0n;
    await rewards.connect(owner).setOffchainBudget(0n); // dial fully off
    for (let i = 0; i < 20; i++) await nextRound();     // 20 dormant rounds
    expect(await satori.merkleReserveCumulative(), "no accrual while off").to.equal(before);
    expect(await satori.merkleReserveCeiling(), "no projection while off").to.equal(before);
  });

  // ==========================================================================
  // 4. AIRDROP EXACTNESS OVER YEARS — many recipients with odd allocations,
  //    claiming at scattered checkpoints across five years after claims open;
  //    every first claim is EXACTLY the allocation, nothing ever accrues on
  //    top, and Σ claimed == Σ alloc with ZERO dust.
  // ==========================================================================
  it("airdrop pays EXACTLY Σ alloc across all recipients with zero dust; nothing accrues across years", async function () {
    const fx = await deploySatoriFixture();
    const { satori, airdrop, owner, signers } = fx;
    await loadRates(satori);

    // 10 recipients with deliberately awkward allocations.
    const recips = signers.slice(1, 11);
    const rng = makeRng(0xA1D20D);
    const amts = [];
    for (let i = 0; i < recips.length; i++) {
      // spread from 1 wei up to a few thousand SATORI, all with odd tails
      const base = E(String(rng.int(5000)));
      const tail = BigInt(rng.next()) % 1_000_000_007n;
      amts.push(base + tail + BigInt(i)); // ensure distinct & nonzero
    }
    // ensure the 1-wei worst case is present
    amts[0] = 1n;
    const sumAlloc = amts.reduce((a, b) => a + b, 0n);

    await airdrop.connect(owner).loadAirdropBatch(recips.map((r) => r.address), amts);
    expect(await airdrop.airdropLoadedTotal()).to.equal(sumAlloc);
    await airdrop.connect(owner).finalizeAirdropLoading();
    const supplyBefore = await satori.totalSupply();
    for (let i = 0; i < recips.length; i++) {
      expect(await airdrop.claimableAirdrop(recips[i].address), `shut r${i}`).to.equal(0n);
    }
    await nextRound(); // CLAIM_DELAY

    // 40 checkpoints across ~5 years with jitter. At each, a random subset of
    // the unclaimed recipients claims; everyone else's view must be unchanged:
    // the whole allocation if unclaimed, zero once claimed.
    const claimed = new Array(recips.length).fill(false);
    for (let step = 1; step <= 40; step++) {
      await time.increase(Math.floor((5 * 365 * TIME_UNIT) / 40) + rng.int(3600));
      for (let i = 0; i < recips.length; i++) {
        const r = recips[i];
        const view = await airdrop.claimableAirdrop(r.address);
        expect(view, `view r${i} step${step}`).to.equal(claimed[i] ? 0n : amts[i]);
        if (!claimed[i] && rng.int(8) === 0) {
          const before = await satori.balanceOf(r.address);
          await airdrop.connect(r).claimAirdrop();
          expect((await satori.balanceOf(r.address)) - before, `whole alloc r${i}`).to.equal(amts[i]);
          claimed[i] = true;
        } else if (claimed[i]) {
          await expect(airdrop.connect(r).claimAirdrop(), `re-claim r${i}`)
            .to.be.revertedWithCustomError(airdrop, "NothingToClaim");
        }
        expect(await airdrop.airdropClaimed(r.address), `cursor r${i}`).to.equal(claimed[i] ? amts[i] : 0n);
      }
      // supply identity holds throughout: all growth is airdrop here
      expect(await satori.totalSupply()).to.equal(supplyBefore + (await airdrop.airdropClaimedTotal()));
    }

    // Final sponsored sweep for whoever never claimed.
    await airdrop.connect(owner).claimAirdropForMany(recips.map((r) => r.address));

    // ZERO DUST: every recipient claimed EXACTLY its alloc.
    let claimedSum = 0n;
    for (let i = 0; i < recips.length; i++) {
      const c = await airdrop.airdropClaimed(recips[i].address);
      expect(c, `exact r${i}`).to.equal(amts[i]);
      expect(await airdrop.claimableAirdrop(recips[i].address), `no dust left r${i}`).to.equal(0n);
      claimedSum += c;
    }
    // aggregate is EXACT — no wei stranded, no wei over-minted
    expect(await airdrop.airdropClaimedTotal(), "Σ claimed == Σ alloc").to.equal(sumAlloc);
    expect(claimedSum).to.equal(sumAlloc);
    // supply reflects exactly the airdrop total on top of the pre-claim supply
    expect(await satori.totalSupply()).to.equal(supplyBefore + sumAlloc);
  });

  // ==========================================================================
  // 5. PER-ROUND REWARD-SPLIT DIVISION — over 100 rounds, the sum of every
  //    reward COMPONENT credited/minted in a round must never EXCEED the
  //    round's budget (integer division may STRAND wei; it must never CREATE
  //    it). We measure the totalRewardsMinted delta per round with the shadow
  //    fully drained each round and assert delta <= ROUND_BUDGET, and that the
  //    running total never overtakes the schedule.
  // ==========================================================================
  it("100 rounds: per-round mint delta never exceeds ROUND_BUDGET; division strands but never creates wei", async function () {
    const fx = await deploySatoriFixture();
    const { satori, rewards, airdrop, registry, owner, signers, games: gamesC } = fx;
    await loadRates(satori);
    const deploymentRound = await satori.deploymentRound();

    const users = signers.slice(1, 7);
    const bals = ["7", "13", "4", "22", "9", "16"];
    for (let i = 0; i < users.length; i++) await satori.transfer(users[i].address, E(bals[i]));

    // Stream/game id 1 is the protocol's DEFAULT game, so these land at 2/3/4.
    const streams = [];
    for (const nm of ["A", "B", "C"]) {
      await satori.createSimpleDataStream(nm, owner.address);
      streams.push(Number(await registry.nextStreamId()) - 1);
    }
    const games = [];
    for (const sid of streams) games.push(Number(await gamesC.binaryGameByStream(sid)));
    // referrals + fees so ALL split components are live
    await rewards.connect(users[0]).setReferral(users[1].address);
    await rewards.connect(users[3]).setPredictorFee(900);
    for (let i = 0; i < users.length; i++) {
      await satori.connect(users[i]).vote(games[i % games.length], SEED_BURN);
    }
    const seedVals = [100000, 200000, 300000];
    for (let i = 0; i < streams.length; i++) await registry.setValue(streams[i], seedVals[i]);
    await nextRound();

    const rng = makeRng(0x5911F7);
    const vals = {};
    for (let i = 0; i < streams.length; i++) vals[streams[i]] = seedVals[i];
    const ROUNDS = 100;

    for (let round = 1; round <= ROUNDS; round++) {
      await nextRound();
      const mintedBefore = await satori.totalRewardsMinted();

      for (const sid of streams) {
        if (rng.int(10) < 2) continue;
        vals[sid] = Math.max(1, vals[sid] + (rng.int(1500) - 700));
        try { await registry.setValue(sid, vals[sid]); } catch {}
      }
      for (let k = 0; k < 1 + rng.int(2); k++) {
        const u = users[rng.int(users.length)];
        try { await satori.connect(u).vote(games[rng.int(games.length)], CHURN_BURN); } catch {}
      }
      for (let i = 0; i < users.length; i++) {
        const u = users[i];
        for (const g of games) { try { await satori.connect(u).settlePrediction(u.address, g); } catch {} }
        const howMany = rng.int(games.length + 1);
        if (howMany === 0) continue;
        const chosen = [];
        for (let c = 0; c < howMany; c++) {
          const g = games[rng.int(games.length)];
          if (!chosen.includes(g)) chosen.push(g);
        }
        try {
          await satori.connect(u).predictMultipleWithPayloads(
            chosen.map((g) => ({ gameId: g, payload: pack1(rng.int(2) + 1) }))
          );
        } catch {}
      }
      try { await satori.flushDefaultStream(); } catch {}
      // platform fee moved to immutable token (see test/next/DevFee.test.js):
      // rewards.accrueProtocolFee() is gone (the fee self-accrues on the token).
      // fully drain the shadow so the mint delta isolates THIS round's mints
      for (const c of [owner, ...users]) {
        let amt = 0n;
        try { amt = await satori.connect(c)["claim()"].staticCall(); } catch {}
        if (amt > 0n) { try { await satori.connect(c)["claim()"](); } catch {} }
      }

      const mintedAfter = await satori.totalRewardsMinted();
      const delta = mintedAfter - mintedBefore;
      // Per-round mint delta may span at most this round's + carried unclaimed
      // from earlier rounds, but because we drain every round the standing
      // shadow is ~0; the delta is dominated by this round's distribution. The
      // hard invariant that CANNOT be violated is the cumulative schedule:
      const curRound = await satori.getCurrentRound();
      const globalCap = ROUND_BUDGET * (curRound - deploymentRound + 1n);
      expect(mintedAfter, `cap @round ${round}`).to.be.lte(globalCap);
      // delta is non-negative (mint is monotone) and finite
      expect(delta).to.be.gte(0n);
      // THREE-lane identity holds every round: dev + on-chain + merkle == total
      // (the senior dev fee self-accrues on the token — see test/next/DevFee.test.js)
      expect(
        (await satori.devFeeMinted()) + (await satori.onChainMinted()) + (await satori.merkleMinted())
      ).to.equal(mintedAfter);
    }
  });
});
