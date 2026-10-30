const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, impersonateAccount, setBalance } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture, pack1, VOTE } = require("../fixtures");
const { burnedTotal } = require("../helpers/burned");
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
 *            onChainMinted + merkleMinted == generalMinted
 *            generalMinted + devFeeMinted == totalRewardsMinted
 *          and nothing mints that was not reported (minted <= accrued per lane).
 *
 *   INV-C  the envelope is NEVER breached, counting the deploy round:
 *            generalAccrued + devFeeAccrued <= ROUND_REWARD_BUDGET * (round - deploymentRound + 1)
 *          After the deploy round the priced allowance binds tighter, so the
 *          long sims cannot press it; only a report inside the deploy round,
 *          which genesis already paid, can, and test 2b makes one.
 *
 *   INV-D  the lanes stay strict across the whole horizon (merkleMinted <=
 *          merkleReserveCumulative; the hub mints on-chain exactly the room the
 *          lens shows, not one wei more), and every priced round's
 *          on-chain gross + banked reserve is exactly the residual — including
 *          through repeated 0<->max dial toggling, which must NOT back-count
 *          dormant rounds or leak reserve.
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

// These simulations measure precision against one fixed per-round residual, not
// the schedule. The default schedule steps every round's worth issued, so
// loadRates holds the rate with the emission lever (ratio 1.0, a configuration
// the protocol supports); none moves the fee, so the rate and bps hold constant
// across every round any one of them walks.
let RATE, DEV_RATE, RESIDUAL, BPS, GEN_GENESIS, DEV_GENESIS;
// The deepest legal off-chain share, and what a share banks per round at RESIDUAL.
const MAX_SHARE = 9999n;
const perRound = (bps) => (RESIDUAL * bps) / 10000n;
async function loadRates(satori, token) {
  const hub = await ethers.getContractAt("SatoriHub", await satori.getAddress());
  await hub.connect(await ethers.getSigner(await hub.emissionHolder())).setEmissionRatio(E(1));
  RATE = await satori.emissionRateNow();
  if ((await hub.emissionRateNext()) !== RATE) throw new Error("a step was already pending");
  DEV_RATE = await satori.devRateNow();
  RESIDUAL = RATE - DEV_RATE;
  // The reserve-rate dial is bounded STRICTLY BELOW the residual general lane.
  BPS = await token.devFeeBps();
  const initial = await token.INITIAL_MINT();
  GEN_GENESIS = (initial * (10000n - (await token.devFeeBps()))) / 10000n;
  DEV_GENESIS = initial - GEN_GENESIS;
}
const feeOn = (general) => (general * BPS + (10000n - BPS) - 1n) / (10000n - BPS);
// The hub's schedule for the general lanes once `priced` rounds are priced:
// genesis's general share plus the residual for every priced round (the deploy
// round included, which genesis also paid).
const scheduleGeneral = (priced, deploymentRound) =>
  GEN_GENESIS + RESIDUAL * (priced - deploymentRound + 1n);
// Burn-voting amounts. `vote` DESTROYS the tokens it spends, so these sims burn
// a small seed to give each game weight and a tiny amount per churn vote — big
// enough to move weight, small enough that a user's prediction power (balance +
// unclaimed) survives hundreds of rounds of churn.
const SEED_BURN  = E("1");
const CHURN_BURN = E("0.01");

async function nextRound() { await time.increase(TIME_UNIT); }

// Not wrapped in try: a reported credit that cannot be minted is exactly the
// failure these sims hunt for.
async function drainClaims(hub, accounts) {
  for (const c of accounts) {
    const amt = await hub.connect(c)["claim()"].staticCall();
    if (amt > 0n) await hub.connect(c)["claim()"]();
  }
}

async function asRewards(rewards) {
  const addr = await rewards.getAddress();
  await impersonateAccount(addr);
  await setBalance(addr, E("10"));
  return ethers.getSigner(addr);
}

// The on-chain room as the hub enforces it: exactly `room` mints, one wei more
// is refused.
const MINT_PROBE = "0x000000000000000000000000000000000000bEEF";
async function expectOnChainRoom(hub, rw, room, tag) {
  await hub.connect(rw).rewardMint.staticCall(MINT_PROBE, room);
  await expect(hub.connect(rw).rewardMint.staticCall(MINT_PROBE, room + 1n), `room + 1 refused @${tag}`)
    .to.be.revertedWithCustomError(hub, "BudgetExceeded");
}

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
    const { satori, token, hub, rewards, airdrop, registry, owner, signers, games: gamesC } = fx;
    await loadRates(satori, token);
    const publisher = signers[15];
    const merkle = await wireMerkle(fx, publisher);
    const rw = await asRewards(rewards);

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
    // the loop below can claim from its first round.
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
    let minCapSlackSeen = 0n; // smallest (envelope - accrued) observed

    // merkle entitlement cursor per recipient (monotonic, cumulative)
    const merkleUsers = [signers[11], signers[12]];
    const merkleCum = new Map(merkleUsers.map((u) => [u.address, 0n]));

    async function checkInvariants(round) {
      const ts = await satori.totalSupply();
      const trm = await satori.totalRewardsMinted();
      const act = await airdrop.airdropClaimedTotal();
      const onc = await satori.onChainMinted();
      const mrk = await satori.merkleMinted();
      const dev = await token.devFeeMinted();
      const genMinted = await token.generalMinted();
      const genAcc = await token.generalAccrued();
      const devAcc = await token.devFeeAccrued();
      const cum = await hub.merkleReserveCumulative();
      // BURN VOTING is the protocol's only supply-REDUCING path: `vote` destroys
      // the voter's SATORI outright. Every game here is on-chain (no 2x off-chain
      // handicap) and none is disabled, so voting.totalBurnedWeight() IS the exact
      // wei burnt by votes; the hub's fees burn too. The supply identity
      // subtracts everything burned.

      // INV-A: supply identity to the wei
      expect(ts, `INV-A supply identity @round ${round}`).to.equal(trm + act - (await burnedTotal(fx.hub)));
      // INV-B: lane split to the wei, and nothing minted that was not reported
      expect(onc + mrk, `INV-B general lanes @round ${round}`).to.equal(genMinted);
      expect(genMinted + dev, `INV-B lane split @round ${round}`).to.equal(trm);
      expect(genMinted, `INV-B general reported @round ${round}`).to.be.lte(genAcc);
      expect(dev, `INV-B fee booked @round ${round}`).to.be.lte(devAcc);
      // every report rounds its fee UP, so the booked fee never falls below the rate
      expect(devAcc * (10000n - BPS), `fee at rate @round ${round}`).to.be.gte(genAcc * BPS);
      expect((await hub.emission()).issued, `issued == accrued @round ${round}`).to.equal(genAcc + devAcc);

      // INV-C: the envelope binds on what was reported, general plus fee
      const curRound = await satori.getCurrentRound();
      const roundsElapsed = curRound - deploymentRound + 1n;
      const globalCap = ROUND_BUDGET * roundsElapsed;
      expect(genAcc + devAcc, `INV-C envelope @round ${round}`).to.be.lte(globalCap);
      expect(trm, `INV-C minted @round ${round}`).to.be.lte(globalCap);
      const slack = globalCap - (genAcc + devAcc);
      if (round === 1 || slack < minCapSlackSeen) minCapSlackSeen = slack;

      // INV-D: strict lanes
      const merkCeil = await satori.merkleReserveCeiling();
      const oncCeil = await satori.onChainRewardCeiling();
      // every round is touched, so its reserve is already banked
      expect(merkCeil, `INV-D reserve banked @round ${round}`).to.equal(cum);
      expect(mrk, `INV-D merkle lane @round ${round}`).to.be.lte(cum);
      expect(onc, `INV-D onchain lane @round ${round}`).to.be.lte(oncCeil);
      await expectOnChainRoom(hub, rw, oncCeil - onc, `INV-D round ${round}`);
      // schedule backstop: each priced round's gross + reserve is exactly the
      // residual, and the on-chain lane's reports stay within its priced gross
      const priced = await hub.onChainPricedRound();
      const allowance = await hub.onChainAllowance();
      expect(priced, `round priced @round ${round}`).to.equal(curRound);
      expect(allowance + cum, `INV-D schedule exact @round ${round}`)
        .to.equal(scheduleGeneral(priced, deploymentRound));
      expect(genAcc - cum, `INV-D backstop @round ${round}`).to.be.lte(allowance);
    }

    for (let round = 1; round <= ROUNDS; round++) {
      await nextRound();

      // toggle the merkle share: sometimes 0, sometimes a big share, sometimes max.
      // This exercises reserve accrual + 0<->max toggling for back-count/leak.
      const dialPick = rng.int(6);
      let shareTarget;
      if (dialPick === 0) shareTarget = 0n;                 // off
      else if (dialPick === 1) shareTarget = MAX_SHARE;     // MAX legal share
      else shareTarget = 100n * BigInt(4 + rng.int(92));    // mid: 4%..95%
      await rewards.connect(owner).setOffchainShareBps(shareTarget);

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


      // claim on-chain rewards for everyone every round (drain the shadow so
      // totalRewardsMinted grows each round and the identity is stressed hard)
      await drainClaims(fx.hub, [owner, ...users]);

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

    expect(minCapSlackSeen).to.be.gte(0n);
    // The swallowed airdrop and merkle claims above must actually have paid.
    expect(await airdrop.airdropClaimedTotal(), "airdrop lane exercised")
      .to.equal(dropAmts.reduce((a, b) => a + b, 0n));
    expect(await satori.merkleMinted(), "merkle lane exercised").to.be.gt(0n);
    expect(await satori.onChainMinted(), "on-chain lane exercised").to.be.gt(GEN_GENESIS);

    // Every report over the horizon (genesis included) booked its fee at the
    // token's rate, rounded up, and the running totals carry no drift.
    const reports = await token.queryFilter(token.filters.RewardsAccrued(), 0, "latest");
    let g = 0n, f = 0n;
    for (const e of reports) {
      expect(e.args.devFee, "fee per report").to.equal(feeOn(e.args.general));
      g += e.args.general;
      f += e.args.devFee;
      expect(e.args.generalTotal).to.equal(g);
      expect(e.args.devFeeTotal).to.equal(f);
    }
    expect(g).to.equal(await token.generalAccrued());
    expect(f).to.equal(await token.devFeeAccrued());
  });

  // ==========================================================================
  // 2. ON-CHAIN LANE AT FULL TILT — sustained maximum on-chain emission (dial
  //    off) for many rounds, claiming EVERY round right up to the on-chain
  //    ceiling: every reported wei is minted or still owed, and the reports
  //    track the priced schedule to the wei.
  // ==========================================================================
  it("200 rounds hammering the on-chain lane at its ceiling: reports stay inside the priced schedule and drain to the wei", async function () {
    this.timeout(2400000);
    const fx = await deploySatoriFixture();
    const { satori, token, hub, rewards, airdrop, registry, owner, signers, games: gamesC } = fx;
    await loadRates(satori, token);
    const rw = await asRewards(rewards);
    const deploymentRound = await satori.deploymentRound();

    const marketing = await rewards.marketingFeeRecipient();
    // Keep the merkle dial OFF so EVERY reported general wei belongs to the
    // on-chain lane.
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
      await drainClaims(fx.hub, [owner, ...users]);

      const trm = await satori.totalRewardsMinted();
      const dev = await token.devFeeMinted();
      const genAcc = await token.generalAccrued();
      const devAcc = await token.devFeeAccrued();
      const curRound = await satori.getCurrentRound();
      const roundsElapsed = curRound - deploymentRound + 1n;
      const globalCap = ROUND_BUDGET * roundsElapsed;
      // The allowance below binds tighter; test 2b is the one that presses the envelope.
      expect(genAcc + devAcc, `envelope breach @round ${round}`).to.be.lte(globalCap);
      expect(trm, `cap breach @round ${round}`).to.be.lte(globalCap);
      expect(await satori.merkleMinted()).to.equal(0n);
      expect(await hub.merkleReserveCumulative()).to.equal(0n);
      expect(await satori.onChainMinted()).to.equal(trm - dev);
      expect(await token.generalMinted(), `general reported @round ${round}`).to.be.lte(genAcc);
      expect(dev, `fee booked @round ${round}`).to.be.lte(devAcc);
      // every earner but the keyless marketing wallet (the no-referral cut) just
      // drained, so the room left is exactly that wallet's bucket: no reported
      // credit stranded, no room that nobody earned
      const owed = await rewards.unclaimedRewards(marketing);
      expect(genAcc - (await token.generalMinted()), `drained to the ceiling @round ${round}`).to.equal(owed);
      await expectOnChainRoom(hub, rw, owed, `round ${round}`);
      // schedule backstop: the on-chain lane's reports stay within the rounds
      // priced so far, each at the full residual
      const priced = await hub.onChainPricedRound();
      const allowance = await hub.onChainAllowance();
      expect(priced, `round priced @round ${round}`).to.equal(curRound);
      expect(allowance, `allowance exact @round ${round}`).to.equal(scheduleGeneral(priced, deploymentRound));
      expect(genAcc, `backstop @round ${round}`).to.be.lte(allowance);
    }
    expect(await satori.onChainMinted(), "on-chain lane exercised").to.be.gt(GEN_GENESIS);
  });

  // ==========================================================================
  // 2b. GENESIS OVERLAP — genesis paid the deploy round, and the hub prices it
  //     again on its first touch, so inside the deploy round the allowance
  //     admits more than the envelope has left. The token's envelope must be
  //     what binds there, to the wei.
  // ==========================================================================
  it("deploy round: the envelope, not the priced allowance, caps a report genesis already paid for", async function () {
    // mid-round, so the deploy round cannot end while the test runs
    const now = await time.latest();
    await time.increaseTo((Math.floor(now / TIME_UNIT) + 1) * TIME_UNIT + TIME_UNIT / 2);
    const fx = await deploySatoriFixture();
    const { satori, token, hub, rewards } = fx;
    await loadRates(satori, token);
    const rw = await asRewards(rewards);
    const dep = await satori.deploymentRound();
    expect(await satori.getCurrentRound(), "still the deploy round").to.equal(dep);

    const initial = await token.INITIAL_MINT();
    expect(await token.generalAccrued(), "only genesis reported").to.equal(GEN_GENESIS);
    expect(await token.devFeeAccrued(), "only genesis booked").to.equal(DEV_GENESIS);
    expect(await hub.merkleReserveCumulative()).to.equal(0n);

    await hub.connect(rw).freezeRoundGross(dep);
    expect(await hub.onChainAllowance(), "the hub admits a full residual").to.equal(GEN_GENESIS + RESIDUAL);

    // general + its rounded-up fee == ceil(general * 10000 / (10000 - bps))
    const room = ROUND_BUDGET - initial;
    const maxGeneral = (room * (10000n - BPS)) / 10000n;
    expect(maxGeneral + feeOn(maxGeneral)).to.be.lte(room);
    expect(maxGeneral + 1n + feeOn(maxGeneral + 1n)).to.be.gt(room);
    expect(maxGeneral, "overlap exists").to.be.lt(RESIDUAL);

    // Same selector as the hub's own BudgetExceeded, but the allowance above
    // admits every amount tried here, so these refusals are the token's envelope.
    await expect(hub.connect(rw).noteIssued(RESIDUAL))
      .to.be.revertedWithCustomError(token, "BudgetExceeded");
    await expect(hub.connect(rw).noteIssued(maxGeneral + 1n))
      .to.be.revertedWithCustomError(token, "BudgetExceeded");
    await hub.connect(rw).noteIssued(maxGeneral);

    const genAcc = await token.generalAccrued();
    const devAcc = await token.devFeeAccrued();
    expect(genAcc).to.equal(GEN_GENESIS + maxGeneral);
    expect(devAcc).to.equal(DEV_GENESIS + feeOn(maxGeneral));
    expect(genAcc + devAcc, "envelope").to.be.lte(ROUND_BUDGET);
    expect((await hub.emission()).issued, "issued == accrued").to.equal(genAcc + devAcc);
    // a full envelope never blocks minting what was reported
    await expectOnChainRoom(hub, rw, maxGeneral, "deploy round");
  });

  // ==========================================================================
  // 3. DIAL TOGGLE 0<->MAX for 150 rounds — reserve accrual must be monotone
  //    and never back-count dormant (rate==0) rounds nor leak reserve. The
  //    merkleReserveCumulative must equal the exact hand-computed accrual.
  // ==========================================================================
  it("150 rounds of 0<->max dial toggling: reserve accrual is exact, never back-counts dormant rounds, ceilings stay wei-exact", async function () {
    const fx = await deploySatoriFixture();
    const { satori, token, hub, rewards, owner } = fx;
    await loadRates(satori, token);
    const rw = await asRewards(rewards);
    const deploymentRound = await satori.deploymentRound();

    const rng = makeRng(0x70661E);
    const ROUNDS = 150;

    // Shadow of the hub's reserve bank. Every bank site banks rounds
    // [last, cur+1) at the dial in force and re-anchors `last` to cur+1 even at
    // share 0; a set takes effect from the next round. Each bank is ONE report to
    // the token, which books its own rounded-up fee. Only setOffchainShareBps runs
    // here, so no on-chain credit is ever reported.
    let shadowRate = 0n;
    let shadowLast = deploymentRound;
    let shadowCum = 0n;
    let shadowDevAccrued = DEV_GENESIS;

    function bankThrough(cur) {
      const end = cur + 1n;
      if (end <= shadowLast) return;
      if (shadowRate > 0n) {
        const add = shadowRate * (end - shadowLast);
        shadowCum += add;
        shadowDevAccrued += feeOn(add);
      }
      shadowLast = end;
    }
    const projection = (cur) => (shadowRate > 0n && cur + 1n > shadowLast
      ? shadowCum + shadowRate * (cur + 1n - shadowLast)
      : shadowCum);

    async function checkLedger(tag, cur) {
      const genAcc = await token.generalAccrued();
      const devAcc = await token.devFeeAccrued();
      const cum = await hub.merkleReserveCumulative();
      expect(genAcc, `reserve reported @${tag}`).to.equal(GEN_GENESIS + cum);
      expect(devAcc, `fee booked per bank @${tag}`).to.equal(shadowDevAccrued);
      expect((await hub.emission()).issued, `issued == accrued @${tag}`).to.equal(genAcc + devAcc);
      // pricing and banking give the on-chain lane no room: only reported credits do
      expect(await satori.onChainMinted(), `nothing minted on-chain past genesis @${tag}`).to.equal(GEN_GENESIS);
      await expectOnChainRoom(hub, rw, 0n, tag);
      expect(genAcc + devAcc, `envelope @${tag}`).to.be.lte(ROUND_BUDGET * (cur - deploymentRound + 1n));
    }

    for (let round = 1; round <= ROUNDS; round++) {
      // gaps of up to three untouched rounds: each is priced and banked lazily
      // at the next touch, at the dial in force over the gap
      const gap = 1 + rng.int(3);
      for (let i = 0; i < gap; i++) await nextRound();
      const cur = BigInt(await satori.getCurrentRound());

      // the view projects the untouched rounds exactly; a dormant stretch
      // (dial 0) projects nothing
      expect(await satori.merkleReserveCeiling(), `live merkle ceiling @round ${round}`).to.equal(projection(cur));
      expect(await hub.merkleReserveCumulative(), `nothing banked by time @round ${round}`).to.equal(shadowCum);

      // a third OFF, else MAX legal, else a mid share (1%..98%)
      const p = rng.int(3);
      let target;
      if (p === 0) target = 0n;
      else if (p === 1) target = MAX_SHARE;
      else target = 100n * BigInt(1 + rng.int(98));

      bankThrough(cur);              // the old share pays through the current round
      shadowRate = perRound(target); // the new one from cur+1
      await rewards.connect(owner).setOffchainShareBps(target);

      expect(await hub.merkleReserveCumulative(), `reserve cumulative exact @round ${round}`).to.equal(shadowCum);
      expect(await satori.merkleReserveCeiling(), `banked through the round @round ${round}`).to.equal(shadowCum);
      await checkLedger(`round ${round}`, cur);
      // every priced round's on-chain gross + its reserve is exactly the residual
      const priced = await hub.onChainPricedRound();
      expect(priced, `round priced @round ${round}`).to.equal(cur);
      expect((await hub.onChainAllowance()) + shadowCum, `schedule exact @round ${round}`)
        .to.equal(scheduleGeneral(priced, deploymentRound));
    }

    // A dormant stretch must bank NOTHING for its rounds, and a dial set after
    // it must not back-count them.
    const before = await hub.merkleReserveCumulative();
    const curNow = BigInt(await satori.getCurrentRound());
    bankThrough(curNow);
    shadowRate = 0n;
    await rewards.connect(owner).setOffchainShareBps(0n); // same round: the last set never applied
    expect(await hub.merkleReserveCumulative(), "off before it applied").to.equal(before);
    for (let i = 0; i < 20; i++) await nextRound();     // 20 dormant rounds
    expect(await hub.merkleReserveCumulative(), "no accrual while off").to.equal(before);
    expect(await satori.merkleReserveCeiling(), "no projection while off").to.equal(before);

    const curOn = BigInt(await satori.getCurrentRound());
    bankThrough(curOn);
    shadowRate = perRound(MAX_SHARE);
    await rewards.connect(owner).setOffchainShareBps(MAX_SHARE);
    expect(await hub.merkleReserveCumulative(), "dormant rounds not back-counted").to.equal(before);
    await checkLedger("after dormant", curOn);
    await nextRound();
    expect(await satori.merkleReserveCeiling(), "share pays from the next round only")
      .to.equal(before + perRound(MAX_SHARE));
  });

  // ==========================================================================
  // 4. AIRDROP EXACTNESS OVER YEARS — many recipients with odd allocations,
  //    claiming at scattered checkpoints across five years after claims open;
  //    every first claim is EXACTLY the allocation, nothing ever accrues on
  //    top, and Σ claimed == Σ alloc with ZERO dust.
  // ==========================================================================
  it("airdrop pays EXACTLY Σ alloc across all recipients with zero dust; nothing accrues across years", async function () {
    const fx = await deploySatoriFixture();
    const { satori, token, airdrop, owner, signers } = fx;
    await loadRates(satori, token);

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
    const supplyBefore = await satori.totalSupply();
    for (let i = 0; i < recips.length; i++) {
      expect(await airdrop.claimableAirdrop(recips[i].address), `open on load r${i}`).to.equal(amts[i]);
    }
    await airdrop.connect(owner).finalizeAirdropLoading();

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
  //    reports never overtake the priced schedule.
  // ==========================================================================
  it("100 rounds: per-round mint delta never exceeds ROUND_BUDGET; division strands but never creates wei", async function () {
    const fx = await deploySatoriFixture();
    const { satori, token, hub, rewards, airdrop, registry, owner, signers, games: gamesC } = fx;
    await loadRates(satori, token);
    const deploymentRound = await satori.deploymentRound();
    const marketing = await rewards.marketingFeeRecipient();

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
      // fully drain the shadow so the mint delta isolates THIS round's mints
      await drainClaims(fx.hub, [owner, ...users]);

      const mintedAfter = await satori.totalRewardsMinted();
      const delta = mintedAfter - mintedBefore;
      // Only because every earner drains every round: one claim can carry many
      // rounds of credits, so this is no protocol bound on a single round.
      expect(delta, `per-round mint @round ${round}`).to.be.lte(ROUND_BUDGET);
      const curRound = await satori.getCurrentRound();
      const globalCap = ROUND_BUDGET * (curRound - deploymentRound + 1n);
      const genAcc = await token.generalAccrued();
      expect(mintedAfter, `cap @round ${round}`).to.be.lte(globalCap);
      expect(genAcc + (await token.devFeeAccrued()), `envelope @round ${round}`).to.be.lte(globalCap);
      expect(
        (await token.devFeeMinted()) + (await satori.onChainMinted()) + (await satori.merkleMinted())
      ).to.equal(mintedAfter);
      // every reported wei is minted or owed to the one wallet that never claims
      expect(genAcc - (await token.generalMinted()), `drained to the ceiling @round ${round}`)
        .to.equal(await rewards.unclaimedRewards(marketing));
      // dial off: the reports never pass the rounds priced so far at the residual
      const cum = await hub.merkleReserveCumulative();
      const priced = await hub.onChainPricedRound();
      const allowance = await hub.onChainAllowance();
      expect(cum).to.equal(0n);
      expect(priced, `round priced @round ${round}`).to.equal(curRound);
      expect(allowance + cum, `schedule exact @round ${round}`).to.equal(scheduleGeneral(priced, deploymentRound));
      expect(genAcc - cum, `backstop @round ${round}`).to.be.lte(allowance);
    }
  });
});
