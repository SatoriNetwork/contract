/**
 * Adversarial regression guard — NO-TAX + cleanup-immune + re-fund + old-pot.
 *
 * Replaces the deleted sticky-`gameHasBounty` guard, reframed for the new
 * per-prediction "boosted" bit design (gameHasBounty NO LONGER EXISTS).
 *
 * The per-game gate was REMOVED. Bounty score-time credit is now gated PER
 * PREDICTION by a "boosted" bit packed into the prediction slot. A NON-boosted
 * correct prediction does ZERO bounty work at settle. So a once-funded-then-
 * cleaned game must NOT cost a non-boosted settler any more than a game that was
 * never funded at all — the old ~5k/settle "once-funded" tax is gone.
 *
 * PROPERTIES ASSERTED (all HOLD → GREEN; any failure is a BUG):
 *   (1) GAS FLATNESS / NO TAX — a correct NON-boosted predictor's settle gasUsed
 *       on a game that was FUNDED → drained → cleaned is EXACTLY EQUAL to the
 *       same on a NEVER-funded game. Settle gas does NOT scale with bounty
 *       history. The two probes are run against the same rewound chain state
 *       with the same signer and the same call sequence, so the comparison is a
 *       matched control and the documented "exactly the same" is literal — an
 *       approximate ratio bound could not resolve the ~5k/settle tax this guards.
 *   (2) POST-CLEANUP LATECOMER — a fresh predictor who first predicts AFTER the
 *       bounty is cleaned has boostedTokenCountInRound == 0, settles WITHOUT
 *       revert, and earns 0 (bountyStake unchanged).
 *   (3) OLD-POT / CLEANUP-IMMUNE — a boosted prediction taken BEFORE cleanup
 *       still pays its captured pot share AFTER cleanup.
 *   (4) RE-FUND — re-funding a cleaned token lets a fresh first-time predictor
 *       get a snapshot and be paid from the NEW pool.
 *
 * If any assertion fails — spurious payout, revert, stranding, or gas that
 * scales with bounty history — that is a REAL bug; report it, do not contort.
 */

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture, pack1 , warmUpStreak , voteFor } = require("../fixtures");

const UP = 1;

async function advanceOneDay() { await time.increase(86400); }

async function deployMockToken(symbol) {
  const M = await ethers.getContractFactory("MockERC20");
  const t = await M.deploy(symbol, symbol);
  await t.waitForDeployment();
  return t;
}

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
      if (p && p.name === "DataStreamCreated") return p.args.streamId;
    } catch (e) {}
  }
  throw new Error("DataStreamCreated event missing");
}

async function stakeFor(bounties, user, token, amount) {
  await token.mint(user.address, amount);
  await token.connect(user).approve(await bounties.getAddress(), amount);
  await bounties.connect(user).stakeBountyToken(await token.getAddress(), amount);
}

// Fund a pool that fully drains in ONE round's first scoring (amount == rate),
// so the token becomes cleanup-eligible (pool==0 && rate==0) after one drip.
async function fundDrainInOne(bounties, funder, game, token, amt = "100") {
  await token.mint(funder.address, ethers.parseEther(amt));
  await token.connect(funder).approve(await bounties.getAddress(), ethers.parseEther(amt));
  await bounties.connect(funder).fundBounty(
    game, await token.getAddress(), ethers.parseEther(amt), ethers.parseEther(amt)
  );
}

describe("adv — bounty NO-TAX: removed per-game gate must not tax non-boosted settles; cleanup-immune / re-fund / old-pot", function () {
  this.timeout(300000);

  let satori, rewards, bounties, registry, owner, token;
  let alice, bob, carol, dave, funder, authority;
  let usd, usdAddr;

  // Rebuild the whole stack from the fixture snapshot. Calling this a SECOND
  // time inside a test rewinds the chain to the same blank state, which is how
  // the gas probe below gets two structurally identical measurements.
  async function freshStack() {
    const fix = await loadFixture(deploySatoriFixture);
    ({ satori, rewards, bounties, registry, owner, token } = fix);
    [, alice, bob, carol, dave, funder, authority] = fix.signers;

    for (const u of [alice, bob, carol, dave, funder, authority]) {
      await satori.transfer(u.address, ethers.parseEther("100"));
    }

    usd = await deployMockToken("USDC");
    usdAddr = await usd.getAddress();
  }

  beforeEach(async function () {
    await freshStack();
  });

  // --- A NON-boosted correct predictor: stakes NOTHING, so applyBoost writes
  //     no snapshot and the slot's boosted bit stays 0. Drive predict→correct→
  //     settle and return settle gasUsed. `fundThenClean` toggles whether the
  //     game was ever funded (then drained + cleaned) before the predictor acts.
  async function nonBoostedSettleGas(name, voter, fundThenClean) {
    const game = await createStream(satori, owner, name, authority.address);
    // audit C-2: a bounty boost needs a non-zero multiplier, so streak >= 1
    await warmUpStreak(satori, registry, authority, [alice, bob, carol, dave], game);
    await voteFor(satori, voter, game);

    // SYMMETRIC PREAMBLE. Both probes run this ENTIRE block — same sacrificial
    // predictor, same stake, same rounds consumed, same setValue cadence. Only
    // the two bounty calls (fundBounty / cleanupDrainedBountyToken) are gated on
    // `fundThenClean`. Previously the never-funded probe skipped the whole block,
    // so the two settle-gas figures differed by ~16.8k (8%) for reasons that have
    // nothing to do with bounty history — measurement noise more than 3x the
    // ~5k effect size the test exists to detect, which no threshold can separate.
    if (fundThenClean) {
      // Fund USDC so dave's prediction is BOOSTED and his settle drips the pool
      // to zero, making the token cleanup-eligible.
      await fundDrainInOne(bounties, funder, game, usd, "100");
    }
    // Sacrificial staker (dave): boosted when the pool exists, a plain
    // non-boosted predictor when it does not — either way the same calls run.
    await voteFor(satori, dave, game);
    await stakeFor(bounties, dave, usd, ethers.parseEther("100"));

    await registry.connect(authority).setValue(game, 100);
    await satori.connect(dave).predictMultipleWithPayloads([{ gameId: game, payload: pack1(UP) }]);
    await advanceOneDay();
    await registry.connect(authority).setValue(game, 110);
    await advanceOneDay();
    await registry.connect(authority).setValue(game, 120);
    await satori.settlePrediction(dave.address, game); // drips pool->0, rate->0 when funded

    expect(await bounties.pool(game, usdAddr)).to.equal(0n);
    expect(await bounties.ratePerRound(game, usdAddr)).to.equal(0n);
    if (fundThenClean) {
      // Clean the drained token. After this the game carries 0 bounty tokens.
      expect(await bounties.gameBountyTokenCount(game)).to.equal(1n);
      await bounties.connect(owner).cleanupDrainedBountyToken(game, usdAddr);
    }
    expect(await bounties.gameBountyTokenCount(game)).to.equal(0n);
    // Advance a full round so the next setValue clears the cadence guard
    // (the drain cycle above already consumed several rounds on this game).
    await advanceOneDay();

    // The NON-boosted predictor stakes NOTHING → no snapshot, boosted bit 0.
    await registry.connect(authority).setValue(game, 100);
    await satori.connect(voter).predictMultipleWithPayloads([{ gameId: game, payload: pack1(UP) }]);
    const r = await satori.getCurrentRound();
    // Sanity: this prediction is genuinely NON-boosted.
    expect(await bounties.boostedTokenCountInRound(voter.address, r)).to.equal(0n,
      "the gas-probe predictor must be NON-boosted (no stake → no snapshot)");

    await advanceOneDay();
    await registry.connect(authority).setValue(game, 110);
    await advanceOneDay();
    await registry.connect(authority).setValue(game, 120);

    const beforeStake = await bounties.bountyStake(voter.address, usdAddr);
    const rcpt = await (await satori.settlePrediction(voter.address, game)).wait();
    // The settle must have actually SCORED the prediction CORRECT — so the gas
    // figure reflects the full score path (where the removed per-game tax lived),
    // not a no-op. A no-op settle would make the comparison meaningless.
    let scoredCorrect = false;
    for (const log of rcpt.logs) {
      try {
        const p = satori.interface.parseLog(log);
        if (p && p.name === "PredictionScored" && p.args.user === voter.address) {
          scoredCorrect = p.args.correct;
        }
      } catch (e) {}
    }
    expect(scoredCorrect, "gas-probe settle must score the prediction CORRECT (full score path ran)").to.equal(true);
    // A non-boosted settler must never receive bounty in any token.
    expect(await bounties.bountyStake(voter.address, usdAddr)).to.equal(beforeStake);
    return rcpt.gasUsed;
  }

  it("(1) NO-TAX: non-boosted settle gas on a funded-drained-cleaned game is identical to a never-funded game", async function () {
    // A CONTROLLED experiment, not two loosely-related samples: each probe runs
    // on a freshly rewound chain (loadFixture snapshot) with the SAME signer, the
    // SAME stream name and the SAME call sequence, so every address, nonce and
    // storage slot lines up. The only difference between the two runs is
    // fundBounty + cleanupDrainedBountyToken.
    await freshStack();
    const gasNeverFunded = await nonBoostedSettleGas("P", alice, false);
    await freshStack();
    const gasOnceFunded  = await nonBoostedSettleGas("P", alice, true);

    const delta = gasOnceFunded - gasNeverFunded;
    console.log(`        [gas] never-funded=${gasNeverFunded}  funded-drained-cleaned=${gasOnceFunded}  delta=${delta}`);

    // The removed per-game gate taxed once-funded games ~5k/settle FOREVER, and
    // that tax is invisible in state: it cross-calls creditBountyForWin for a
    // non-boosted prediction, which writes nothing (no snapshot, no pot change),
    // so the sibling assertions in this file cannot see it either. Gas is the
    // ONLY observable. The old guard was `ratio < 1.2` over two unmatched
    // probes: on a ~200k settle that tolerated a 40k tax — 8x the regression it
    // names — and the probes' own setup noise (16.8k) already exceeded the
    // effect size, so it could not have failed for its own stated reason.
    // With matched probes the documented claim is checkable literally:
    // A_bounty_staking.md — the two predictors "pay **exactly the same**
    // (no cross-call)".
    expect(delta,
      `NO-TAX violated: a once-funded(cleaned) game taxes the non-boosted settler. ` +
      `neverFunded=${gasNeverFunded} onceFunded=${gasOnceFunded} delta=${delta}`)
      .to.equal(0n);
  });

  it("(2)+(3)+(4) cleanup-immune old-pot pays, post-cleanup latecomer no-ops, re-fund pays a fresh predictor", async function () {
    const game = await createStream(satori, owner, "G", authority.address);
    // audit C-2: a bounty boost needs a non-zero multiplier, so streak >= 1
    await warmUpStreak(satori, registry, authority, [alice, bob, carol, dave], game);
    for (const u of [alice, bob, carol]) await voteFor(satori, u, game);

    // ===== Round R1: fund, stake, take a BOOSTED snapshot for alice. =====
    await fundDrainInOne(bounties, funder, game, usd, "100");
    await stakeFor(bounties, alice, usd, ethers.parseEther("100"));

    await registry.connect(authority).setValue(game, 100);
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: game, payload: pack1(UP) }]);
    const r1 = await satori.getCurrentRound();
    expect(await bounties.boostedTokenCountInRound(alice.address, r1)).to.equal(1n,
      "alice's R1 prediction must be BOOSTED (staked USDC, game funded)");
    const snap = await bounties.boostStakeForPrediction(alice.address, game, r1, usdAddr);
    expect(snap).to.be.gt(0n);

    // Drive R1 correct (UP: C > B).
    await advanceOneDay();
    await registry.connect(authority).setValue(game, 110);
    await advanceOneDay();
    await registry.connect(authority).setValue(game, 120);

    // ===== Drip + drain the pool via a SEPARATE sacrificial settler, capture
    //       the R1 pot, then clean BEFORE alice settles. =====
    // bob is a fresh first-time staker → boosted → his settle drips the pool.
    await stakeFor(bounties, bob, usd, ethers.parseEther("100"));
    // bob must have predicted in R1 too for his settle to score; but we already
    // closed R1. Instead, let ALICE's settle do the drip, and verify old-pot
    // payout survives a cleanup that lands AFTER drip but BEFORE a *second*
    // same-round settler. We model the classic race: settle alice? No — we need
    // the pot captured first, THEN clean, THEN a boosted settler is paid.
    //
    // Simplest faithful model of "boosted-before-cleanup still pays after
    // cleanup": alice (boosted, correct, R1) is the victim. We drip+capture the
    // R1 pot using the funder's own boosted prediction... but funder never
    // predicted. So we drip via alice's settle itself, then assert she WAS paid,
    // and SEPARATELY (test 3 below) clean and assert a still-pending boosted
    // settler is paid.
    //
    // Capture the pot by settling alice (boosted): this drips pool->0.
    const aliceStakeBefore = await bounties.bountyStake(alice.address, usdAddr);
    await satori.settlePrediction(alice.address, game);
    expect(await bounties.pool(game, usdAddr)).to.equal(0n);
    expect(await bounties.ratePerRound(game, usdAddr)).to.equal(0n);
    const pot = await bounties.roundBountyPot(game, r1, usdAddr);
    expect(pot).to.equal(ethers.parseEther("100"));
    const aliceEarned = (await bounties.bountyStake(alice.address, usdAddr)) - aliceStakeBefore;
    expect(aliceEarned,
      "boosted correct predictor (alice) must be paid her R1 captured-pot share").to.be.gt(0n);

    // ===== Now CLEAN the drained token (permissionless). =====
    expect(await bounties.gameBountyTokenCount(game)).to.equal(1n);
    await bounties.connect(owner).cleanupDrainedBountyToken(game, usdAddr);
    expect(await bounties.gameBountyTokenCount(game)).to.equal(0n);

    // ===== (2) POST-CLEANUP LATECOMER: carol first predicts AFTER cleanup.
    //       Carol STAKES USDC so the ONLY reason her boosted set is empty is
    //       that the game now funds NOTHING (cleaned) — proving the no-op comes
    //       from the missing funded token, not from a missing stake. =====
    await stakeFor(bounties, carol, usd, ethers.parseEther("100"));
    expect(await bounties.userStakedTokenCount(carol.address)).to.equal(1n,
      "latecomer has actually staked USDC (so empty set is NOT a no-stake artifact)");
    await advanceOneDay(); // clear cadence guard before re-opening the stream
    await registry.connect(authority).setValue(game, 100); // R-late open
    await satori.connect(carol).predictMultipleWithPayloads([{ gameId: game, payload: pack1(UP) }]);
    const rLate = await satori.getCurrentRound();
    expect(await bounties.boostedTokenCountInRound(carol.address, rLate)).to.equal(0n,
      "post-cleanup latecomer has an EMPTY boosted set despite staking USDC (game funds nothing now)");
    expect(await bounties.boostStakeForPrediction(carol.address, game, rLate, usdAddr)).to.equal(0n,
      "no snapshot captured for the cleaned token");

    // Confirm she has no stake balance change after settle (clean no-op). Her
    // stake stays escrowed; we capture it post-stake to net out the deposit.
    await advanceOneDay();
    await registry.connect(authority).setValue(game, 110);
    await advanceOneDay();
    await registry.connect(authority).setValue(game, 120);

    const carolStakeBefore = await bounties.bountyStake(carol.address, usdAddr);
    await expect(satori.settlePrediction(carol.address, game),
      "post-cleanup latecomer settle must NOT revert").to.not.be.reverted;
    expect(await bounties.bountyStake(carol.address, usdAddr),
      "latecomer earns 0 bounty stake").to.equal(carolStakeBefore);

    // ===== (4) RE-FUND the cleaned token → a fresh first-time predictor gets a
    //       snapshot and is paid from the NEW pool. =====
    expect(await bounties.gameBountyTokenCount(game)).to.equal(0n,
      "token stayed cleaned through the latecomer round");
    await fundDrainInOne(bounties, funder, game, usd, "100");
    expect(await bounties.gameBountyTokenCount(game)).to.equal(1n,
      "re-fund re-arms the token as a clean first-fund");
    expect(await bounties.pool(game, usdAddr)).to.equal(ethers.parseEther("100"));
    // ratePerRound is stored RATE_SCALE(1e18)-scaled; a clean re-fund re-arms it
    // back above zero (it was 0 after the prior drain + cleanup).
    expect(await bounties.ratePerRound(game, usdAddr),
      "re-fund re-arms ratePerRound above zero").to.be.gt(0n);

    // dave is a FRESH first-time predictor/staker → guaranteed non-zero snapshot.
    await stakeFor(bounties, dave, usd, ethers.parseEther("100"));
    await voteFor(satori, dave, game);
    await advanceOneDay(); // clear cadence guard before re-opening the stream
    await registry.connect(authority).setValue(game, 100);
    await satori.connect(dave).predictMultipleWithPayloads([{ gameId: game, payload: pack1(UP) }]);
    const rNew = await satori.getCurrentRound();
    expect(await bounties.boostedTokenCountInRound(dave.address, rNew)).to.equal(1n,
      "re-funded token: fresh predictor's prediction must be BOOSTED");
    expect(await bounties.boostStakeForPrediction(dave.address, game, rNew, usdAddr)).to.be.gt(0n);

    await advanceOneDay();
    await registry.connect(authority).setValue(game, 110);
    await advanceOneDay();
    await registry.connect(authority).setValue(game, 120);

    const daveStakeBefore = await bounties.bountyStake(dave.address, usdAddr);
    await satori.settlePrediction(dave.address, game);
    const newPot = await bounties.roundBountyPot(game, rNew, usdAddr);
    expect(newPot, "re-funded pool drips a fresh R-new pot").to.be.gt(0n);
    const daveEarned = (await bounties.bountyStake(dave.address, usdAddr)) - daveStakeBefore;
    expect(daveEarned,
      "fresh predictor must be paid from the RE-FUNDED pool").to.be.gt(0n);
  });

  it("(3-strict) a boosted snapshot taken BEFORE cleanup is still paid when its settle lands AFTER cleanup (old captured pot)", async function () {
    // Two boosted predictors in the SAME round; one settles+drips+captures the
    // pot, a cleanup lands, then the SECOND boosted predictor settles and must
    // still be paid from the already-captured pot (cleanup-immune / old-pot).
    const game = await createStream(satori, owner, "OLD", authority.address);
    // audit C-2: a bounty boost needs a non-zero multiplier, so streak >= 1
    await warmUpStreak(satori, registry, authority, [alice, bob, carol, dave], game);
    await voteFor(satori, alice, game);
    await voteFor(satori, bob, game);

    // pool=200 rate=200 → first scoring drips 200 and drains in one round.
    await fundDrainInOne(bounties, funder, game, usd, "200");
    await stakeFor(bounties, alice, usd, ethers.parseEther("100"));
    await stakeFor(bounties, bob, usd, ethers.parseEther("100"));

    await registry.connect(authority).setValue(game, 100);
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: game, payload: pack1(UP) }]);
    await satori.connect(bob).predictMultipleWithPayloads([{ gameId: game, payload: pack1(UP) }]);
    const r = await satori.getCurrentRound();
    expect(await bounties.boostedTokenCountInRound(alice.address, r)).to.equal(1n);
    expect(await bounties.boostedTokenCountInRound(bob.address, r)).to.equal(1n);

    await advanceOneDay();
    await registry.connect(authority).setValue(game, 110);
    await advanceOneDay();
    await registry.connect(authority).setValue(game, 120);

    // alice settles first: drips+captures pot, drains pool->0.
    await satori.settlePrediction(alice.address, game);
    expect(await bounties.pool(game, usdAddr)).to.equal(0n);
    expect(await bounties.ratePerRound(game, usdAddr)).to.equal(0n);
    const pot = await bounties.roundBountyPot(game, r, usdAddr);
    expect(pot).to.equal(ethers.parseEther("200"));

    // CLEANUP lands BEFORE bob settles.
    await bounties.connect(owner).cleanupDrainedBountyToken(game, usdAddr);
    expect(await bounties.gameBountyTokenCount(game)).to.equal(0n);

    // bob's boosted snapshot predates cleanup → he MUST still be paid.
    const bobStakeBefore = await bounties.bountyStake(bob.address, usdAddr);
    await satori.settlePrediction(bob.address, game);
    const bobEarned = (await bounties.bountyStake(bob.address, usdAddr)) - bobStakeBefore;
    expect(bobEarned,
      "OLD-POT: boosted predictor whose settle lands after cleanup must still be paid").to.be.gt(0n);

    // Conservation: the captured pot fully drains to alice + bob + fee, none
    // stranded (cleanup did not orphan bob's share).
    const aliceTotal =
      (await bounties.bountyStake(alice.address, usdAddr)) - ethers.parseEther("100");
    // Platform fee moved to the immutable token (its senior dev fee); the
    // recipient now lives on the token, and no bounty payout skim accrues here,
    // so this term is 0 — the pot must drain entirely to the two winners.
    const feeRecipient = await token.PLATFORM_FEE_RECIPIENT();
    const fee = await bounties.bountyStake(feeRecipient, usdAddr);
    const totalCredited = aliceTotal + bobEarned + fee;
    expect(totalCredited,
      "captured pot fully drains to winners + fee (no stranded residue)")
      .to.be.closeTo(pot, ethers.parseEther("0.0001"));
  });
});
