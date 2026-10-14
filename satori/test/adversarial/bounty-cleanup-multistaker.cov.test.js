/**
 * Adversarial regression guard — STRANDING-DEAD under aggressive cleanup timing
 * with MULTIPLE same-round correct stakers, plus a re-fund / old-round
 * cross-contamination probe.
 *
 * THREAT recap: `cleanupDrainedBountyToken` is permissionless and fires the
 * moment a (game, token) pool hits zero (pool==0 && rate==0). Under the OLD
 * design a cleanup landing BETWEEN two same-round settlers stranded the later
 * settlers' already-captured `roundBountyPot` share (it cleared `_gameTokenSeen`
 * which `creditBountyForWin` gated on, and disarmed the `gameHasBounty`
 * score-time cross-call). The fix decouples payout from eviction.
 *
 * SCENARIO 1 — INTERLEAVED cleanup, three stakers, one round:
 *   Three stakers (UNEQUAL stake: 100 / 200 / 300) all predict the SAME
 *   game+round UP and are all correct. The pool drains in exactly one round
 *   (amount==rate). Settle order is interleaved with a permissionless cleanup:
 *       settle #1  (drips pool->0, captures the round pot)
 *       cleanup    (token now drained; keeper/grief evicts it)
 *       settle #2
 *       settle #3
 *   EVERY correct predictor must still be paid their stake-proportional share,
 *   and Σ(shares + fees) must equal the captured pot within dust. Nothing
 *   stranded; shares track the 1:2:3 stake ratio.
 *
 * SCENARIO 2 — RE-FUND + OLD-round non-cross-contamination:
 *   After scenario-style drain+cleanup on (game, token), an UNSETTLED predictor
 *   from the ORIGINAL round still has a live snapshot. The SAME (game, token) is
 *   RE-FUNDED (fresh pool), a NEW round is predicted+settled, AND the stale
 *   original-round predictor then settles. Assert:
 *     - the stale predictor is paid from the OLD round's pot,
 *     - the new-round predictor is paid from the NEW round's pot,
 *     - the two pots are independent (no cross-contamination — the old payout
 *       does not draw from the new pool/pot and vice versa).
 *
 * If any assertion fails, that is a REAL stranding/contamination bug — report
 * it with concrete numbers, do NOT contort the test to pass.
 */

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture, pack1 , warmUpStreak , voteFor } = require("../fixtures");

const UP = 1;

async function advanceOneDay() { await time.increase(86400); }

async function deployMockToken(sym = "USDC") {
  const M = await ethers.getContractFactory("MockERC20");
  const t = await M.deploy(sym, sym);
  await t.waitForDeployment();
  return t;
}

// Stream cadence floor: a PUBLIC caller may only create round-length (>= 1440
// minute) streams; sub-round streams are admin-only. This test's subject is bounty
// pool/drip/stake mechanics, not stream rhythm, so it keeps the fast (720-minute,
// sub-round) beat by having the ADMIN (`owner`) create the stream. `authority`
// stays the stream's PROVIDER, so it is still the account that writes values.
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

// Total bounty credited to `user` for `tokenAddr` = settled-into-stake delta.
// Bounty winnings auto-compound into bountyStake.
async function totalCredited(bounties, user, tokenAddr, stakeBefore) {
  const stakeNow = await bounties.bountyStake(user.address, tokenAddr);
  return stakeNow - stakeBefore;
}

describe("adv — cleanup-multistaker: interleaved cleanup must strand NO same-round correct predictor", function () {
  this.timeout(300000);

  let satori, token, rewards, bounties, registry, owner;
  let a, b, c, d, funder, authority;
  let usd, usdAddr;
  let feeRecipient;

  beforeEach(async function () {
    const fix = await loadFixture(deploySatoriFixture);
    ({ satori, token, rewards, bounties, registry, owner } = fix);
    [, a, b, c, d, funder, authority] = fix.signers;

    for (const s of [a, b, c, d, funder, authority]) {
      await satori.transfer(s.address, ethers.parseEther("100"));
    }

    // platform fee moved to immutable token (see test/next/DevFee.test.js): the
    // recipient is now SatoriToken.PLATFORM_FEE_RECIPIENT, not a rewards getter.
    feeRecipient = await token.PLATFORM_FEE_RECIPIENT();

    usd = await deployMockToken("USDC");
    usdAddr = await usd.getAddress();
    await usd.mint(funder.address, ethers.parseEther("1000000"));
    await usd.connect(funder).approve(await bounties.getAddress(), ethers.parseEther("1000000"));
  });

  it("SCENARIO 1: three UNEQUAL-stake correct predictors, settle interleaved with cleanup (settle#1, cleanup, settle#2, settle#3) — all paid proportionally, Σ(shares+fees)==pot, nothing stranded", async function () {
    const game = await createStream(satori, owner, "G1", authority.address);
    // audit C-2: a bounty boost needs a non-zero multiplier, so streak >= 1
    await warmUpStreak(satori, registry, authority, [a, b, c, d], game);
    await voteFor(satori, a, game);
    await voteFor(satori, b, game);
    await voteFor(satori, c, game);

    // pool == rate == 1000 -> the round's first scoring drips exactly 1000 and
    // fully drains the pool (tail-cap), making cleanup permitted.
    const FUND = ethers.parseEther("1000");
    await bounties.connect(funder).fundBounty(game, usdAddr, FUND, FUND);

    // Unequal stakes 100 / 200 / 300 (ratio 1:2:3).
    const sa = ethers.parseEther("100");
    const sb = ethers.parseEther("200");
    const sc = ethers.parseEther("300");
    await stakeFor(bounties, a, usd, sa);
    await stakeFor(bounties, b, usd, sb);
    await stakeFor(bounties, c, usd, sc);

    // ---- Round R: all three stake USDC, all predict UP. Snapshots taken. ----
    await registry.connect(authority).setValue(game, 100);
    await satori.connect(a).predictMultipleWithPayloads([{ gameId: game, payload: pack1(UP) }]);
    await satori.connect(b).predictMultipleWithPayloads([{ gameId: game, payload: pack1(UP) }]);
    await satori.connect(c).predictMultipleWithPayloads([{ gameId: game, payload: pack1(UP) }]);
    const r = await satori.getCurrentRound();

    // Every staker has a live, non-zero, stake-proportional snapshot.
    const snapA = await bounties.boostStakeForPrediction(a.address, game, r, usdAddr);
    const snapB = await bounties.boostStakeForPrediction(b.address, game, r, usdAddr);
    const snapC = await bounties.boostStakeForPrediction(c.address, game, r, usdAddr);
    expect(snapA).to.be.gt(0n);
    expect(snapB).to.be.gt(0n);
    expect(snapC).to.be.gt(0n);
    // Snapshots track the 1:2:3 stake ratio (same multiplier for all).
    expect(snapB).to.equal(snapA * 2n);
    expect(snapC).to.equal(snapA * 3n);

    // ---- Drive all three R predictions correct (UP: C > B). ----
    await advanceOneDay();
    await registry.connect(authority).setValue(game, 110);
    await advanceOneDay();
    await registry.connect(authority).setValue(game, 120);

    // Capture pre-settle stakes (the lock means stake hasn't moved).
    const sa0 = await bounties.bountyStake(a.address, usdAddr);
    const sb0 = await bounties.bountyStake(b.address, usdAddr);
    const sc0 = await bounties.bountyStake(c.address, usdAddr);

    // ===== SETTLE #1 (a): drips the pool, captures the round pot, drains. =====
    await satori.settlePrediction(a.address, game);
    expect(await bounties.pool(game, usdAddr)).to.equal(0n);
    expect(await bounties.ratePerRound(game, usdAddr)).to.equal(0n);
    const pot = await bounties.roundBountyPot(game, r, usdAddr);
    expect(pot, "dripped pot == funded amount (drained in one round)").to.equal(FUND);

    // ===== CLEANUP (permissionless, by an unrelated party) BETWEEN settlers. =
    // Clears _gameTokenSeen + shortens gameBountyTokens, but must NOT block the
    // remaining captured payouts.
    await bounties.connect(owner).cleanupDrainedBountyToken(game, usdAddr);
    expect(await bounties.pool(game, usdAddr)).to.equal(0n);
    // The captured pot is a fixed reference — untouched by cleanup.
    expect(await bounties.roundBountyPot(game, r, usdAddr)).to.equal(pot);

    // ===== SETTLE #2 (b): AFTER cleanup. Must still be paid its share. =====
    await satori.settlePrediction(b.address, game);
    // ===== SETTLE #3 (c): AFTER cleanup. Must still be paid its share. =====
    await satori.settlePrediction(c.address, game);

    // ---- Per-predictor totals. ----
    const earnedA = await totalCredited(bounties, a, usdAddr, sa0);
    const earnedB = await totalCredited(bounties, b, usdAddr, sb0);
    const earnedC = await totalCredited(bounties, c, usdAddr, sc0);

    console.log(`        [S1] pot=${ethers.formatEther(pot)}`);
    console.log(`        [S1] earnedA=${ethers.formatEther(earnedA)} earnedB=${ethers.formatEther(earnedB)} earnedC=${ethers.formatEther(earnedC)}`);

    // NO STRANDING: every correct predictor with a live snapshot is paid > 0,
    // even the two who settled AFTER the permissionless cleanup.
    expect(earnedA, "settler #1 (pre-cleanup) must be paid").to.be.gt(0n);
    expect(earnedB, "settler #2 (POST-cleanup) must be paid, not stranded").to.be.gt(0n);
    expect(earnedC, "settler #3 (POST-cleanup) must be paid, not stranded").to.be.gt(0n);

    // PROPORTIONALITY: shares track the 1:2:3 stake ratio (within dust).
    const dust = ethers.parseEther("0.0001");
    expect(earnedB, "b ~= 2*a").to.be.closeTo(earnedA * 2n, dust);
    expect(earnedC, "c ~= 3*a").to.be.closeTo(earnedA * 3n, dust);

    // CONSERVATION: Σ(shares) == captured pot (within dust). No residue
    // stranded in roundBountyPot beyond rounding dust.
    const totalOut = earnedA + earnedB + earnedC;
    expect(totalOut, "Σ(shares) must equal the captured pot — nothing stranded")
      .to.be.closeTo(pot, dust);

    // IDEMPOTENCE: re-settling each is a harmless no-op (no double-pay, no revert).
    await expect(satori.settlePrediction(a.address, game)).to.not.be.reverted;
    await expect(satori.settlePrediction(b.address, game)).to.not.be.reverted;
    await expect(satori.settlePrediction(c.address, game)).to.not.be.reverted;
    expect(await totalCredited(bounties, a, usdAddr, sa0)).to.equal(earnedA);
    expect(await totalCredited(bounties, b, usdAddr, sb0)).to.equal(earnedB);
    expect(await totalCredited(bounties, c, usdAddr, sc0)).to.equal(earnedC);
  });

  it("SCENARIO 2: re-fund after drain+cleanup with a STALE unsettled original-round predictor — old round pays from OLD pot, new round from NEW pot, no cross-contamination", async function () {
    const game = await createStream(satori, owner, "G2", authority.address);
    // audit C-2: a bounty boost needs a non-zero multiplier, so streak >= 1
    await warmUpStreak(satori, registry, authority, [a, b, c, d], game);
    await voteFor(satori, a, game);
    await voteFor(satori, b, game);
    // `d` is a FRESH predictor used only for the NEW round R2 (a first-ever
    // prediction gets streak-multiplier 1, so its boost snapshot is non-zero;
    // a returning streak-1 predictor would snapshot zero — a streak-curve
    // harness detail, unrelated to the cleanup property under test).
    await voteFor(satori, d, game);

    const FUND1 = ethers.parseEther("1000");
    await bounties.connect(funder).fundBounty(game, usdAddr, FUND1, FUND1);

    // a and b stake equal so the OLD round's totalBoost is split evenly between
    // the settler (b) and the STALE predictor (a) who delays settlement.
    const stakeAmt = ethers.parseEther("100");
    await stakeFor(bounties, a, usd, stakeAmt);
    await stakeFor(bounties, b, usd, stakeAmt);
    // d stakes for the NEW round (sole R2 predictor → takes the whole new pot).
    await stakeFor(bounties, d, usd, stakeAmt);

    // ---- OLD round R1: a and b both predict UP. ----
    await registry.connect(authority).setValue(game, 100);
    await satori.connect(a).predictMultipleWithPayloads([{ gameId: game, payload: pack1(UP) }]);
    await satori.connect(b).predictMultipleWithPayloads([{ gameId: game, payload: pack1(UP) }]);
    const r1 = await satori.getCurrentRound();
    const snapA1 = await bounties.boostStakeForPrediction(a.address, game, r1, usdAddr);
    const snapB1 = await bounties.boostStakeForPrediction(b.address, game, r1, usdAddr);
    expect(snapA1).to.be.gt(0n);
    expect(snapB1).to.be.gt(0n);

    // Drive R1 correct.
    await advanceOneDay();
    await registry.connect(authority).setValue(game, 110);
    await advanceOneDay();
    await registry.connect(authority).setValue(game, 120);

    // b settles R1 (drips + captures the OLD pot, drains pool). a stays STALE.
    const sb0 = await bounties.bountyStake(b.address, usdAddr);
    await satori.settlePrediction(b.address, game);
    expect(await bounties.pool(game, usdAddr)).to.equal(0n);
    expect(await bounties.ratePerRound(game, usdAddr)).to.equal(0n);
    const oldPot = await bounties.roundBountyPot(game, r1, usdAddr);
    expect(oldPot).to.equal(FUND1);
    const earnedB1 = await totalCredited(bounties, b, usdAddr, sb0);
    expect(earnedB1, "b paid from OLD pot at R1 settle").to.be.gt(0n);

    // ---- Permissionless cleanup of the drained token (a still UNSETTLED). ----
    await bounties.connect(owner).cleanupDrainedBountyToken(game, usdAddr);
    // a's old snapshot survives cleanup; old pot is a fixed reference.
    expect(await bounties.boostStakeForPrediction(a.address, game, r1, usdAddr)).to.equal(snapA1);
    expect(await bounties.roundBountyPot(game, r1, usdAddr)).to.equal(oldPot);

    // ===== RE-FUND the SAME (game, token) with a FRESH, DIFFERENT pool. =====
    const FUND2 = ethers.parseEther("500");
    await bounties.connect(funder).fundBounty(game, usdAddr, FUND2, FUND2);
    expect(await bounties.pool(game, usdAddr)).to.equal(FUND2);

    // ---- NEW round R2: a FRESH predictor d predicts UP (new snapshot under
    //      the new pool). a and b deliberately do NOT predict R2 — a's only live
    //      snapshot is the stale R1 one.
    // Advance past the per-stream cadence (720 minutes, elapsed-time-only) since
    // the last setValue(120) before posting the new opening price for R2.
    await advanceOneDay();
    await registry.connect(authority).setValue(game, 200);
    await satori.connect(d).predictMultipleWithPayloads([{ gameId: game, payload: pack1(UP) }]);
    const r2 = await satori.getCurrentRound();
    expect(r2, "R2 must be a distinct, later round than R1").to.be.gt(r1);
    const snapD2 = await bounties.boostStakeForPrediction(d.address, game, r2, usdAddr);
    expect(snapD2, "fresh R2 predictor d has a live new-round snapshot").to.be.gt(0n);
    // Neither a nor b has a snapshot for R2.
    expect(await bounties.boostStakeForPrediction(a.address, game, r2, usdAddr)).to.equal(0n);
    expect(await bounties.boostStakeForPrediction(b.address, game, r2, usdAddr)).to.equal(0n);
    // a's STALE R1 snapshot is still intact and distinct from the R2 round.
    expect(await bounties.boostStakeForPrediction(a.address, game, r1, usdAddr)).to.equal(snapA1);

    // Drive R2 correct.
    await advanceOneDay();
    await registry.connect(authority).setValue(game, 210);
    await advanceOneDay();
    await registry.connect(authority).setValue(game, 220);

    // d settles R2 -> paid from the NEW pot (d is the SOLE R2 predictor → whole
    // new pot, less fee, goes to d).
    const sd0 = await bounties.bountyStake(d.address, usdAddr);
    await satori.settlePrediction(d.address, game);
    const newPot = await bounties.roundBountyPot(game, r2, usdAddr);
    expect(newPot, "NEW pot dripped for R2").to.equal(FUND2);
    const earnedD2 = await totalCredited(bounties, d, usdAddr, sd0);
    expect(earnedD2, "d paid from NEW pot at R2 settle").to.be.gt(0n);

    // ===== Finally the STALE original-round predictor (a) settles. =====
    // a's only live snapshot is R1; a must be paid from the OLD pot, and that
    // payout must NOT touch the new pool/pot.
    const newPoolBeforeAStale = await bounties.pool(game, usdAddr);
    const sa0 = await bounties.bountyStake(a.address, usdAddr);
    await satori.settlePrediction(a.address, game);
    const earnedA1 = await totalCredited(bounties, a, usdAddr, sa0);

    console.log(`        [S2] oldPot=${ethers.formatEther(oldPot)} newPot=${ethers.formatEther(newPot)}`);
    console.log(`        [S2] earnedB1=${ethers.formatEther(earnedB1)} earnedA1(stale)=${ethers.formatEther(earnedA1)} earnedD2=${ethers.formatEther(earnedD2)}`);

    const dust = ethers.parseEther("0.0001");

    // STALE predictor is paid from the OLD round's pot (not zero, not stranded).
    expect(earnedA1, "stale R1 predictor must still be paid from OLD pot").to.be.gt(0n);

    // a and b had EQUAL stake at R1 -> equal OLD-round shares (within dust).
    expect(earnedA1, "a's stale share ~= b's R1 share (equal R1 stake)")
      .to.be.closeTo(earnedB1, dust);

    // NO CROSS-CONTAMINATION — conservation across both pots:
    // every credited token (all shares) == oldPot + newPot. If the
    // OLD payout had leaked from the NEW pool (or vice versa), this sum would
    // over/under-shoot the sum of the two fixed pots.
    const grandTotal = earnedB1 + earnedA1 + earnedD2;
    expect(grandTotal, "Σ(all shares) == oldPot + newPot — pots independent, nothing leaked/lost")
      .to.be.closeTo(oldPot + newPot, dust * 2n);

    // NEW pot conservation in isolation: d is the SOLE R2 staker. With the
    // bounty-token payout fee removed, d receives the FULL pot share with no
    // skim, so d's payout alone reconstructs the whole NEW pot.
    expect(earnedD2, "NEW pot fully drains to sole R2 staker d (no payout fee)")
      .to.be.closeTo(newPot, dust);

    //  - a's stale OLD-round payout did NOT draw from the NEW pool: the live
    //    pool is unchanged by a's settle (a touched only the captured R1 pot,
    //    a fixed reference, never the live pool which belongs to R2's funding).
    expect(await bounties.pool(game, usdAddr),
      "stale OLD-round settle must NOT consume the NEW pool").to.equal(newPoolBeforeAStale);

    //  - The NEW pot is undisturbed by a's stale settle (a had no R2 snapshot).
    expect(await bounties.roundBountyPot(game, r2, usdAddr),
      "NEW pot unchanged by stale OLD-round settle").to.equal(newPot);

    //  - The OLD pot is undisturbed by d's R2 settle (d had no R1 snapshot).
    expect(await bounties.roundBountyPot(game, r1, usdAddr),
      "OLD pot unchanged by the new-round settle").to.equal(oldPot);

    //  - d earned NOTHING from the OLD round (no R1 snapshot).
    expect(await bounties.boostStakeForPrediction(d.address, game, r1, usdAddr)).to.equal(0n);

    //  - a earned ONLY its R1 share, nothing from the NEW round (no R2 snapshot).
    expect(earnedA1, "a must earn ONLY its R1 share, nothing from the NEW round")
      .to.be.closeTo(earnedB1, dust);
  });
});
