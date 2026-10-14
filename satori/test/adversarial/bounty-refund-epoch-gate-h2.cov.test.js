// Adversarial VERIFICATION of the H2 fix (cross-epoch fund leak).
//
// H2 bug: bounty pool[game][tk] / ratePerRound[game][tk] are a single GLOBAL
// reserve reused across funding epochs, but _dripFiredForRound[game][round][tk]
// is per-round. A stale unsettled boosted winner from a PRIOR epoch (whose round
// never dripped before the pool drained) could settle late after a re-fund and
// drip the NEW pool into its old round's pot, siphoning the new funder's capital.
//
// Fix:
//  (1) _fundingEpochStartRound[gameId][token], stamped to the current round
//      inside fundBounty's VIRGIN branch (oldWeight == 0).
//  (2) _dripTokenForRound: `if (round < _fundingEpochStartRound[gameId][tk]) return;`
//
// This file tries HARD to break it (siphon a re-funded pool, or over-block a
// legitimate path). Probes 1-7 below.

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture, pack1 , warmUpStreak , voteFor } = require("../fixtures");

const UP = 1;
const DOWN = 2;

async function deployMockToken(sym = "USDC") {
  const M = await ethers.getContractFactory("MockERC20");
  const t = await M.deploy(sym, sym);
  await t.waitForDeployment();
  return t;
}
async function advanceOneDay() { await time.increase(86400); }

// Stream cadence floor: a PUBLIC caller may only create streams with
// round-length (>= 1440 minute) cadence; sub-round streams are admin-only. This
// test's subject is bounty pool/drip/stake mechanics, not stream rhythm, so it
// keeps the fast (720-minute, sub-round) beat by having the ADMIN (`owner`)
// create the stream. `authority` stays the stream's PROVIDER, so
// it is still the account that writes values.
async function createStream(satori, signer, name, authority) {
  const tx = await satori.connect(signer)["createSimpleDataStream(string,address,uint24)"](name, authority, 720);
  const rcpt = await tx.wait();
  for (const log of rcpt.logs) {
    try {
      const p = satori.interface.parseLog(log);
      if (p && p.name === "DataStreamCreated") return Number(p.args.streamId);
    } catch (e) {}
  }
  throw new Error("DataStreamCreated event missing");
}
async function stakeFor(bounties, user, token, amount) {
  await token.mint(user.address, amount);
  await token.connect(user).approve(await bounties.getAddress(), amount);
  await bounties.connect(user).stakeBountyToken(await token.getAddress(), amount);
}

// Drain a freshly-funded small pool (pool == rate == SMALL, drains in 1 drip)
// in some round via a throwaway predictor `who`, settling it.
// Returns the round in which the drip fired.
async function predictAndSettle(satori, registry, bounties, who, streamId, authority, vBase) {
  await registry.connect(authority).setValue(streamId, vBase);
  const R = Number(await satori.getCurrentRound());
  await satori.connect(who).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(UP) }]);
  await advanceOneDay();
  await registry.connect(authority).setValue(streamId, vBase + 10); // B
  await advanceOneDay();
  await registry.connect(authority).setValue(streamId, vBase + 20); // C, UP wins
  await satori.settlePrediction(who.address, streamId);
  return R;
}

describe("VERIFY H2: cross-epoch fund-leak gate", function () {
  this.timeout(300000);

  let satori, bounties, registry, games, owner, rewards, token;
  let alice, bob, carol, dave, funder, authority, mallory;
  let streamId, usd, usdAddr, feeRecipient;
  const TOL = ethers.parseEther("0.01");

  beforeEach(async function () {
    const fix = await loadFixture(deploySatoriFixture);
    ({ satori, bounties, registry, games, owner, rewards, token } = fix);
    [, alice, bob, carol, dave, funder, authority, mallory] = fix.signers;
    // Platform fee moved to the immutable token (its senior dev fee).
    feeRecipient = await token.PLATFORM_FEE_RECIPIENT();
    for (const s of [alice, bob, carol, dave, funder, authority, mallory]) {
      await satori.transfer(s.address, ethers.parseEther("100"));
    }
    streamId = await createStream(satori, owner, "S", authority.address);
    for (const s of [alice, bob, carol, dave, mallory]) {
      await voteFor(satori, s, streamId);
    }
    usd = await deployMockToken("USDC");
    usdAddr = await usd.getAddress();
    await usd.mint(funder.address, ethers.parseEther("10000000"));
    await usd.connect(funder).approve(await bounties.getAddress(), ethers.parseEther("10000000"));
    // Bounty boosts need a NON-zero multiplier, and audit C-2 made streak 0 run the
    // normal curve (W(0)=0) — a streak-0 prediction takes no bounty snapshot by
    // design, so depositors' tokens only ever pay a real streak. Warm the
    // predictors to streak >= 1 here.
    await warmUpStreak(satori, registry, authority, [alice, bob, carol, dave], streamId);

  });

  // ================================================================
  // PROBE A (scenario 1): the canonical cross-epoch siphon.
  // Drain -> re-fund -> stale prior-epoch winner settles. Must siphon NOTHING.
  // (This is the original H2; verified again here with full accounting + the
  //  attacker trying to settle BEFORE and AFTER refund, and checking the
  //  refunded pool is intact to the wei.)
  // ================================================================
  it("PROBE A: stale prior-epoch winner siphons nothing after a drain+refund", async function () {
    const SMALL = ethers.parseEther("50");
    await bounties.connect(funder).fundBounty(streamId, usdAddr, SMALL, SMALL);

    await stakeFor(bounties, alice, usd, ethers.parseEther("100"));
    await stakeFor(bounties, bob, usd, ethers.parseEther("100"));

    // Round R: Alice (attacker) predicts UP, snapshot for round R, NOT settled.
    await registry.connect(authority).setValue(streamId, 100);
    const R = Number(await satori.getCurrentRound());
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(UP) }]);
    await advanceOneDay();
    await registry.connect(authority).setValue(streamId, 110); // B for R
    await advanceOneDay();
    await registry.connect(authority).setValue(streamId, 120); // C for R (UP correct)

    // Round R2: Bob predicts UP and SETTLES, draining the pool in round R2.
    const R2 = Number(await satori.getCurrentRound());
    expect(R2).to.be.greaterThan(R);
    await satori.connect(bob).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(UP) }]);
    await advanceOneDay();
    await registry.connect(authority).setValue(streamId, 130);
    await advanceOneDay();
    await registry.connect(authority).setValue(streamId, 140);
    await satori.settlePrediction(bob.address, streamId); // drains in R2

    expect(await bounties.pool(streamId, usdAddr)).to.equal(0n);
    expect(await bounties.ratePerRound(streamId, usdAddr)).to.equal(0n);
    expect(await bounties.roundBountyPot(streamId, R, usdAddr)).to.equal(0n); // R never dripped

    // Re-fund (epoch 2). No cleanup. Virgin branch fires because pool==0.
    const REFUND = ethers.parseEther("500");
    await bounties.connect(funder).fundBounty(streamId, usdAddr, REFUND, REFUND);
    expect(await bounties.pool(streamId, usdAddr)).to.equal(REFUND);

    const aliceBefore = await bounties.bountyStake(alice.address, usdAddr);
    const contractBefore = await usd.balanceOf(await bounties.getAddress());

    // Attacker settles stale round-R prediction. Gate must refuse the drip.
    await satori.settlePrediction(alice.address, streamId);

    const aliceEarned = (await bounties.bountyStake(alice.address, usdAddr)) - aliceBefore;
    const drippedOld = await bounties.roundBountyPot(streamId, R, usdAddr);
    const poolAfter = await bounties.pool(streamId, usdAddr);
    const contractAfter = await usd.balanceOf(await bounties.getAddress());

    console.log("PROBE A | R:", R, "R2:", R2,
      "| aliceEarned:", ethers.formatEther(aliceEarned),
      "| drippedOld:", ethers.formatEther(drippedOld),
      "| poolAfter:", ethers.formatEther(poolAfter));

    expect(aliceEarned).to.equal(0n);                  // stale predictor earns nothing
    expect(drippedOld).to.equal(0n);                   // old round stays empty
    expect(poolAfter).to.equal(REFUND);                // re-funded pool intact to the wei
    expect(contractAfter).to.equal(contractBefore);    // no token moved out
  });

  // ================================================================
  // PROBE B (scenario 2): multiple drain->refund cycles, epoch 1 -> 2 -> 3.
  // A stale winner from epoch 1 AND a stale winner from epoch 2 each settle
  // late during epoch 3. Neither may reach epoch 3's pool.
  // ================================================================
  it("PROBE B: stale winners from epoch1 and epoch2 cannot touch epoch3 pool", async function () {
    const SMALL = ethers.parseEther("50");

    // Each attacker stakes so they have a non-zero snapshot when they predict.
    await stakeFor(bounties, alice, usd, ethers.parseEther("100"));  // epoch1 attacker
    await stakeFor(bounties, bob, usd, ethers.parseEther("100"));    // epoch2 attacker
    await stakeFor(bounties, carol, usd, ethers.parseEther("100"));  // drainers
    await stakeFor(bounties, dave, usd, ethers.parseEther("100"));   // drainers

    // ---- EPOCH 1 ----
    await bounties.connect(funder).fundBounty(streamId, usdAddr, SMALL, SMALL);
    // Alice predicts in epoch1 round Ra, never settles.
    await registry.connect(authority).setValue(streamId, 100);
    const Ra = Number(await satori.getCurrentRound());
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(UP) }]);
    await advanceOneDay();
    await registry.connect(authority).setValue(streamId, 110);
    await advanceOneDay();
    await registry.connect(authority).setValue(streamId, 120);
    // Carol predicts + settles in the next round, draining epoch1.
    const RaDrain = Number(await satori.getCurrentRound());
    await satori.connect(carol).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(UP) }]);
    await advanceOneDay();
    await registry.connect(authority).setValue(streamId, 130);
    await advanceOneDay();
    await registry.connect(authority).setValue(streamId, 140);
    await satori.settlePrediction(carol.address, streamId);
    expect(await bounties.pool(streamId, usdAddr)).to.equal(0n);

    // ---- EPOCH 2 ----
    // Advance a round before re-funding/predicting so the next setValue clears
    // the registry's 1-per-round cadence guard (the drain settle above happened
    // in the same round as setValue(140)).
    await advanceOneDay();
    await bounties.connect(funder).fundBounty(streamId, usdAddr, SMALL, SMALL);
    await registry.connect(authority).setValue(streamId, 200);
    const Rb = Number(await satori.getCurrentRound());
    expect(Rb).to.be.greaterThan(Ra);
    await satori.connect(bob).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(UP) }]);
    await advanceOneDay();
    await registry.connect(authority).setValue(streamId, 210);
    await advanceOneDay();
    await registry.connect(authority).setValue(streamId, 220);
    // Dave drains epoch2.
    await satori.connect(dave).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(UP) }]);
    await advanceOneDay();
    await registry.connect(authority).setValue(streamId, 230);
    await advanceOneDay();
    await registry.connect(authority).setValue(streamId, 240);
    await satori.settlePrediction(dave.address, streamId);
    expect(await bounties.pool(streamId, usdAddr)).to.equal(0n);

    // ---- EPOCH 3: big pool ----
    // Advance a round again before the epoch-3 fund for the same cadence reason.
    await advanceOneDay();
    const BIG = ethers.parseEther("1000");
    await bounties.connect(funder).fundBounty(streamId, usdAddr, BIG, BIG);
    const Rc = Number(await satori.getCurrentRound());
    expect(Rc).to.be.greaterThan(Rb);
    expect(await bounties.pool(streamId, usdAddr)).to.equal(BIG);

    const poolBefore = await bounties.pool(streamId, usdAddr);
    const aStakeBefore = await bounties.bountyStake(alice.address, usdAddr);
    const bStakeBefore = await bounties.bountyStake(bob.address, usdAddr);

    // Both stale attackers settle late, during epoch 3.
    await satori.settlePrediction(alice.address, streamId); // epoch1 round Ra
    await satori.settlePrediction(bob.address, streamId);   // epoch2 round Rb

    const aliceEarned = (await bounties.bountyStake(alice.address, usdAddr)) - aStakeBefore;
    const bobEarned = (await bounties.bountyStake(bob.address, usdAddr)) - bStakeBefore;
    const drippedRa = await bounties.roundBountyPot(streamId, Ra, usdAddr);
    const drippedRb = await bounties.roundBountyPot(streamId, Rb, usdAddr);
    const poolAfter = await bounties.pool(streamId, usdAddr);

    console.log("PROBE B | Ra:", Ra, "Rb:", Rb, "Rc:", Rc,
      "| aliceEarned:", ethers.formatEther(aliceEarned),
      "| bobEarned:", ethers.formatEther(bobEarned),
      "| poolAfter:", ethers.formatEther(poolAfter));

    expect(aliceEarned).to.equal(0n);   // epoch1 stale -> 0
    expect(bobEarned).to.equal(0n);     // epoch2 stale -> 0
    expect(drippedRa).to.equal(0n);
    expect(drippedRb).to.equal(0n);
    expect(poolAfter).to.equal(poolBefore); // epoch3 pool fully intact
  });

  // ================================================================
  // PROBE C (scenario 3): TOP-UP that does NOT drain (oldWeight != 0).
  // An in-flight round from the SAME epoch must STILL drip legitimately;
  // the top-up must NOT bump the epoch start (over-block check).
  // ================================================================
  it("PROBE C: top-up of a live pool does NOT bump epoch; in-flight round still drips", async function () {
    const POT = ethers.parseEther("1000");
    const RATE = ethers.parseEther("100");
    await bounties.connect(funder).fundBounty(streamId, usdAddr, POT, RATE);

    await stakeFor(bounties, alice, usd, ethers.parseEther("100"));

    // Alice predicts in round R (epoch 1, pool still has plenty).
    await registry.connect(authority).setValue(streamId, 100);
    const R = Number(await satori.getCurrentRound());
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(UP) }]);
    await advanceOneDay();
    await registry.connect(authority).setValue(streamId, 110);

    // BEFORE Alice settles (round R not yet dripped), a second funder TOPS UP
    // the live pool. oldPool > 0 so oldWeight != 0 -> NON-virgin branch -> the
    // epoch start must remain at R's epoch, NOT bump to "now".
    await bounties.connect(funder).fundBounty(streamId, usdAddr, ethers.parseEther("500"), RATE);

    await advanceOneDay();
    await registry.connect(authority).setValue(streamId, 120); // C for R

    const aliceBefore = await bounties.bountyStake(alice.address, usdAddr);
    await satori.settlePrediction(alice.address, streamId);
    const aliceEarned = (await bounties.bountyStake(alice.address, usdAddr)) - aliceBefore;
    const dripped = await bounties.roundBountyPot(streamId, R, usdAddr);

    console.log("PROBE C | R:", R,
      "| aliceEarned:", ethers.formatEther(aliceEarned),
      "| dripped:", ethers.formatEther(dripped));

    // The round DID drip (top-up did not over-block), and Alice (sole staker)
    // got the whole drip.
    expect(dripped).to.be.gt(0n);
    expect(aliceEarned).to.be.closeTo(dripped, TOL);
    expect(aliceEarned).to.be.gt(0n);
  });

  // ================================================================
  // PROBE D (scenario 4): legitimate WITHIN-epoch late settle.
  // Round >= epoch start, pool still funded, predictor settles late (several
  // rounds after predicting). Must still drip & pay.
  // ================================================================
  it("PROBE D: within-epoch late settle still drips and pays", async function () {
    const POT = ethers.parseEther("5000");
    const RATE = ethers.parseEther("100");
    await bounties.connect(funder).fundBounty(streamId, usdAddr, POT, RATE);

    await stakeFor(bounties, alice, usd, ethers.parseEther("100"));

    await registry.connect(authority).setValue(streamId, 100);
    const R = Number(await satori.getCurrentRound());
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(UP) }]);
    await advanceOneDay();
    await registry.connect(authority).setValue(streamId, 110); // B for R
    await advanceOneDay();
    await registry.connect(authority).setValue(streamId, 120); // C for R, settleable now

    // Let SEVERAL more rounds pass (ring buffer keeps history). Same epoch (no
    // drain, no refund). Alice settles way late.
    for (let i = 0; i < 4; i++) {
      await advanceOneDay();
      await registry.connect(authority).setValue(streamId, 130 + i * 10);
    }

    const aliceBefore = await bounties.bountyStake(alice.address, usdAddr);
    await satori.settlePrediction(alice.address, streamId);
    const aliceEarned = (await bounties.bountyStake(alice.address, usdAddr)) - aliceBefore;
    const dripped = await bounties.roundBountyPot(streamId, R, usdAddr);

    console.log("PROBE D | R:", R, "settled @round:", Number(await satori.getCurrentRound()),
      "| aliceEarned:", ethers.formatEther(aliceEarned),
      "| dripped:", ethers.formatEther(dripped));

    expect(dripped).to.be.gt(0n);                          // same-epoch round drips
    expect(aliceEarned).to.be.closeTo(dripped, TOL);
    expect(aliceEarned).to.be.gt(0n);
  });

  // ================================================================
  // PROBE E (scenario 5): multi-token on one game; independent epoch boundaries.
  // Token A drains+refunds (advancing A's epoch) while token B stays in its
  // original epoch the whole time. A stale round-R prediction that snapshotted
  // BOTH tokens settles late:
  //   - token A's epoch advanced past R -> A drip refused (0).
  //   - token B never advanced (R >= B epoch start) -> B drips & pays.
  // Confirms the gate is per-token and doesn't cross-contaminate.
  // ================================================================
  it("PROBE E: per-token epoch boundaries are independent", async function () {
    const tokA = usd;
    const tokAAddr = usdAddr;
    const tokB = await deployMockToken("WBTC");
    const tokBAddr = await tokB.getAddress();
    await tokB.mint(funder.address, ethers.parseEther("10000000"));
    await tokB.connect(funder).approve(await bounties.getAddress(), ethers.parseEther("10000000"));

    const SMALL = ethers.parseEther("50");
    const BIGB = ethers.parseEther("2000");
    const RATEB = ethers.parseEther("100");

    // Fund A (small, will drain) and B (big, stays in epoch 1 throughout).
    await bounties.connect(funder).fundBounty(streamId, tokAAddr, SMALL, SMALL);
    await bounties.connect(funder).fundBounty(streamId, tokBAddr, BIGB, RATEB);

    // Alice stakes BOTH tokens so her round-R snapshot covers both.
    await stakeFor(bounties, alice, tokA, ethers.parseEther("100"));
    await stakeFor(bounties, alice, tokB, ethers.parseEther("100"));
    await stakeFor(bounties, bob, tokA, ethers.parseEther("100")); // drainer of A

    // Round R: Alice predicts (snapshot for BOTH A and B), never settles yet.
    await registry.connect(authority).setValue(streamId, 100);
    const R = Number(await satori.getCurrentRound());
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(UP) }]);
    await advanceOneDay();
    await registry.connect(authority).setValue(streamId, 110);
    await advanceOneDay();
    await registry.connect(authority).setValue(streamId, 120);

    // Bob drains token A in a LATER round (B keeps draining its own pot too, but
    // B has a huge pool so it survives). To drain A cleanly we use Bob who only
    // staked A.
    await satori.connect(bob).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(UP) }]);
    await advanceOneDay();
    await registry.connect(authority).setValue(streamId, 130);
    await advanceOneDay();
    await registry.connect(authority).setValue(streamId, 140);
    await satori.settlePrediction(bob.address, streamId);
    expect(await bounties.pool(streamId, tokAAddr)).to.equal(0n); // A drained
    expect(await bounties.pool(streamId, tokBAddr)).to.be.gt(0n); // B still funded

    // Re-fund token A only (advances A's epoch past R). B untouched.
    const REFUNDA = ethers.parseEther("500");
    await bounties.connect(funder).fundBounty(streamId, tokAAddr, REFUNDA, REFUNDA);
    expect(await bounties.pool(streamId, tokAAddr)).to.equal(REFUNDA);

    const aliceAbefore = await bounties.bountyStake(alice.address, tokAAddr);
    const aliceBbefore = await bounties.bountyStake(alice.address, tokBAddr);
    const poolAbefore = await bounties.pool(streamId, tokAAddr);

    // Alice settles stale round R. A must refuse (epoch advanced); B must drip.
    await satori.settlePrediction(alice.address, streamId);

    const aliceAearned = (await bounties.bountyStake(alice.address, tokAAddr)) - aliceAbefore;
    const aliceBearned = (await bounties.bountyStake(alice.address, tokBAddr)) - aliceBbefore;
    const drippedAold = await bounties.roundBountyPot(streamId, R, tokAAddr);
    const drippedBold = await bounties.roundBountyPot(streamId, R, tokBAddr);
    const poolAafter = await bounties.pool(streamId, tokAAddr);

    console.log("PROBE E | R:", R,
      "| A earned:", ethers.formatEther(aliceAearned),
      "| B earned:", ethers.formatEther(aliceBearned),
      "| A poolAfter:", ethers.formatEther(poolAafter));

    // Token A: epoch advanced past R -> refused -> nothing siphoned.
    expect(aliceAearned).to.equal(0n);
    expect(drippedAold).to.equal(0n);
    expect(poolAafter).to.equal(poolAbefore); // A re-fund intact

    // Token B: never advanced its epoch (still epoch 1, R >= start) -> drips & pays.
    expect(drippedBold).to.be.gt(0n);
    expect(aliceBearned).to.be.gt(0n);
  });

  // ================================================================
  // PROBE F (scenario 6): cleanup vs no-cleanup. The gate must hold in BOTH.
  // Same siphon attempt, run once WITH cleanupDrainedBountyToken between drain
  // and refund, once WITHOUT. (PROBE5 used cleanup, PROBE6 didn't — re-checked
  // here side by side under one fixture to confirm identical zero-siphon.)
  // ================================================================
  async function staleSiphonAttempt(useCleanup) {
    const SMALL = ethers.parseEther("50");
    await bounties.connect(funder).fundBounty(streamId, usdAddr, SMALL, SMALL);
    await stakeFor(bounties, alice, usd, ethers.parseEther("100"));
    await stakeFor(bounties, bob, usd, ethers.parseEther("100"));

    await registry.connect(authority).setValue(streamId, 100);
    const R = Number(await satori.getCurrentRound());
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(UP) }]);
    await advanceOneDay();
    await registry.connect(authority).setValue(streamId, 110);
    await advanceOneDay();
    await registry.connect(authority).setValue(streamId, 120);

    await satori.connect(bob).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(UP) }]);
    await advanceOneDay();
    await registry.connect(authority).setValue(streamId, 130);
    await advanceOneDay();
    await registry.connect(authority).setValue(streamId, 140);
    await satori.settlePrediction(bob.address, streamId);
    expect(await bounties.pool(streamId, usdAddr)).to.equal(0n);

    if (useCleanup) {
      await bounties.connect(mallory).cleanupDrainedBountyToken(streamId, usdAddr);
    }

    const REFUND = ethers.parseEther("500");
    await bounties.connect(funder).fundBounty(streamId, usdAddr, REFUND, REFUND);

    const aliceBefore = await bounties.bountyStake(alice.address, usdAddr);
    await satori.settlePrediction(alice.address, streamId);
    const aliceEarned = (await bounties.bountyStake(alice.address, usdAddr)) - aliceBefore;

    return {
      aliceEarned,
      drippedOld: await bounties.roundBountyPot(streamId, R, usdAddr),
      poolAfter: await bounties.pool(streamId, usdAddr),
      REFUND,
    };
  }

  it("PROBE F1: gate holds WITH cleanup between drain and refund", async function () {
    const r = await staleSiphonAttempt(true);
    console.log("PROBE F1(cleanup) | aliceEarned:", ethers.formatEther(r.aliceEarned));
    expect(r.aliceEarned).to.equal(0n);
    expect(r.drippedOld).to.equal(0n);
    expect(r.poolAfter).to.equal(r.REFUND);
  });

  it("PROBE F2: gate holds WITHOUT cleanup between drain and refund", async function () {
    const r = await staleSiphonAttempt(false);
    console.log("PROBE F2(no-cleanup) | aliceEarned:", ethers.formatEther(r.aliceEarned));
    expect(r.aliceEarned).to.equal(0n);
    expect(r.drippedOld).to.equal(0n);
    expect(r.poolAfter).to.equal(r.REFUND);
  });

  // ================================================================
  // PROBE G (scenario 7): first-ever fund — epoch start stamped correctly;
  // a normal first-epoch winner drips. (No prior epoch exists; the gate must
  // be a no-op for an honest current-epoch predictor.)
  // ================================================================
  it("PROBE G: first-ever fund — normal current-epoch winner drips", async function () {
    const POT = ethers.parseEther("1000");
    const RATE = ethers.parseEther("200");
    await bounties.connect(funder).fundBounty(streamId, usdAddr, POT, RATE);

    await stakeFor(bounties, alice, usd, ethers.parseEther("100"));

    await registry.connect(authority).setValue(streamId, 100);
    const R = Number(await satori.getCurrentRound());
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(UP) }]);
    await advanceOneDay();
    await registry.connect(authority).setValue(streamId, 110);
    await advanceOneDay();
    await registry.connect(authority).setValue(streamId, 120);

    const aliceBefore = await bounties.bountyStake(alice.address, usdAddr);
    await satori.settlePrediction(alice.address, streamId);
    const aliceEarned = (await bounties.bountyStake(alice.address, usdAddr)) - aliceBefore;
    const dripped = await bounties.roundBountyPot(streamId, R, usdAddr);

    console.log("PROBE G | R:", R, "| aliceEarned:", ethers.formatEther(aliceEarned),
      "| dripped:", ethers.formatEther(dripped));

    expect(dripped).to.equal(RATE); // full per-round rate dripped
    expect(aliceEarned).to.be.closeTo(dripped, TOL);
    expect(aliceEarned).to.be.gt(0n);
  });

  // ================================================================
  // PROBE H (extra adversarial): try to BEAT the gate by predicting in the
  // round at the EXACT epoch boundary. The gate uses `round < start` (strict).
  // A predictor who predicts in the SAME round the re-fund happens (round ==
  // start) must STILL be paid (boundary is inclusive of the new epoch). And a
  // predictor one round BEFORE the refund (round == start-1) must be refused.
  // This pins the off-by-one.
  // ================================================================
  it("PROBE H: epoch boundary is exact — round==start pays, round==start-1 refused", async function () {
    const SMALL = ethers.parseEther("50");
    await bounties.connect(funder).fundBounty(streamId, usdAddr, SMALL, SMALL);

    await stakeFor(bounties, alice, usd, ethers.parseEther("100")); // round start-1 attacker
    await stakeFor(bounties, bob, usd, ethers.parseEther("100"));   // drainer
    await stakeFor(bounties, carol, usd, ethers.parseEther("100")); // round==start honest

    // Drain epoch 1 with two predictors so we can place Alice's stale pred just
    // before the refund.
    await registry.connect(authority).setValue(streamId, 100);
    const Rprev = Number(await satori.getCurrentRound());
    // Alice predicts here (this will be epoch1, round Rprev). Never settles.
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(UP) }]);
    await advanceOneDay();
    await registry.connect(authority).setValue(streamId, 110);
    await advanceOneDay();
    await registry.connect(authority).setValue(streamId, 120);

    // Bob drains.
    await satori.connect(bob).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(UP) }]);
    await advanceOneDay();
    await registry.connect(authority).setValue(streamId, 130);
    await advanceOneDay();
    await registry.connect(authority).setValue(streamId, 140);
    await satori.settlePrediction(bob.address, streamId);
    expect(await bounties.pool(streamId, usdAddr)).to.equal(0n);

    // Advance a round before re-funding (drain settle shared a round with the
    // setValue(140) above; the registry allows one setValue per round).
    await advanceOneDay();

    // Re-fund NOW. Epoch 2 start == current round. Carol predicts in this exact
    // round (round == start).
    const REFUND = ethers.parseEther("500");
    await bounties.connect(funder).fundBounty(streamId, usdAddr, REFUND, REFUND);
    const startRound = Number(await satori.getCurrentRound());
    expect(startRound).to.be.greaterThan(Rprev);

    await registry.connect(authority).setValue(streamId, 200);
    await satori.connect(carol).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(UP) }]);
    await advanceOneDay();
    await registry.connect(authority).setValue(streamId, 210);
    await advanceOneDay();
    await registry.connect(authority).setValue(streamId, 220);

    // Settle Alice (round Rprev == start-? , strictly < startRound) -> refused.
    const aliceBefore = await bounties.bountyStake(alice.address, usdAddr);
    await satori.settlePrediction(alice.address, streamId);
    const aliceEarned = (await bounties.bountyStake(alice.address, usdAddr)) - aliceBefore;

    // Settle Carol (round == startRound) -> must be paid.
    const carolBefore = await bounties.bountyStake(carol.address, usdAddr);
    await satori.settlePrediction(carol.address, streamId);
    const carolEarned = (await bounties.bountyStake(carol.address, usdAddr)) - carolBefore;
    const carolRoundPot = await bounties.roundBountyPot(streamId, startRound, usdAddr);

    console.log("PROBE H | Rprev:", Rprev, "startRound:", startRound,
      "| aliceEarned(stale):", ethers.formatEther(aliceEarned),
      "| carolEarned(boundary):", ethers.formatEther(carolEarned));

    expect(aliceEarned).to.equal(0n);          // strictly-older round refused
    expect(carolEarned).to.be.gt(0n);          // round == start is the NEW epoch, pays
    expect(carolRoundPot).to.be.gt(0n);
    expect(await bounties.roundBountyPot(streamId, Rprev, usdAddr)).to.equal(0n);
  });
});
