/**
 * Regression guard — cleanup-before-settle no longer strands a captured pot
 * (was HIGH finding cov_bounties).
 *
 * `cleanupDrainedBountyToken` is permissionless and runs once a (game, token)
 * pool is drained (pool==0 && rate==0). Previously it (a) cleared
 * `_gameTokenSeen`, which `creditBountyForWin` gated payout on, and (b) flipped
 * `gameHasBounty` off, which gates the score-time credit cross-call entirely.
 * So a cleanup landing between two same-round settlers — normal housekeeping a
 * keeper bot would do the moment a pool hits zero, or a deliberate grief —
 * silently dropped the later settler's already-captured share, stranding it in
 * `roundBountyPot` forever. The victim was a CORRECT predictor with a live
 * snapshot who never touched their stake.
 *
 * Fixed by making payout independent of eviction:
 *   - `creditBountyForWin` no longer gates on `_gameTokenSeen` — a captured pot
 *     belongs to that round's predictors regardless of later eviction (the
 *     precise gates are downstream: the per-game snapshot in
 *     `_accrueBountyForWinToken` and `ratePerRound==0` in `_dripTokenForRound`).
 *   - `gameHasBounty` is armed at first fund and never disarmed (a cleaned game
 *     can still owe a captured pot; an un-settled snapshot can always still
 *     claim, so disarming is never safe). Cleanup keeps its real benefit — a
 *     shorter `gameBountyTokens` walk + a clean re-fund path.
 *
 * Asserts the INTENDED behavior: the late settler is paid and the pot fully
 * drains.
 */

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture, pack1 , warmUpStreak , voteFor } = require("../fixtures");

const UP = 1;

async function deployMockToken(sym = "USDC") {
  const M = await ethers.getContractFactory("MockERC20");
  const t = await M.deploy(sym, sym);
  await t.waitForDeployment();
  return t;
}

async function advanceOneDay() { await time.increase(86400); }

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

describe("cov_bounties — cleanup-before-settle must not drop a pending snapshot share", function () {
  this.timeout(120000);

  let satori, rewards, bounties, registry, owner;
  let alice, bob, funder, authority;
  let s1, usd, usdAddr;

  beforeEach(async function () {
    const fix = await loadFixture(deploySatoriFixture);
    ({ satori, rewards, bounties, registry, owner } = fix);
    [, alice, bob, funder, authority] = fix.signers;

    await satori.transfer(alice.address, ethers.parseEther("100"));
    await satori.transfer(bob.address, ethers.parseEther("100"));
    await satori.transfer(funder.address, ethers.parseEther("100"));
    await satori.transfer(authority.address, ethers.parseEther("100"));

    s1 = await createStream(satori, owner, "S1", authority.address);

    // audit C-2: streak 0 pays flat dust and takes no bounty boost — warm to streak >= 1

    await warmUpStreak(satori, registry, authority, [alice, bob], s1);
    await voteFor(satori, alice, s1);
    await voteFor(satori, bob, s1);

    usd = await deployMockToken("USDC");
    usdAddr = await usd.getAddress();
    await usd.mint(funder.address, ethers.parseEther("100000"));
    await usd.connect(funder).approve(await bounties.getAddress(), ethers.parseEther("100000"));
  });

  it("a correct predictor with a live snapshot is paid (and her pot share is NOT stranded) after cleanup", async function () {
    // pool=100 rate=100 -> the round's first scoring drips exactly 100 and
    // fully drains the pool (tail-cap), so cleanup becomes permitted.
    await bounties.connect(funder).fundBounty(s1, usdAddr, ethers.parseEther("100"), ethers.parseEther("100"));
    await stakeFor(bounties, alice, usd, ethers.parseEther("100"));
    await stakeFor(bounties, bob, usd, ethers.parseEther("100"));

    // ---- Round R: both stake 100, both predict UP. Snapshots taken. ----
    await registry.connect(authority).setValue(s1, 100);
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: s1, payload: pack1(UP) }]);
    await satori.connect(bob).predictMultipleWithPayloads([{ gameId: s1, payload: pack1(UP) }]);
    const r = await satori.getCurrentRound();

    const snapAlice = await bounties.boostStakeForPrediction(alice.address, s1, r, usdAddr);
    expect(snapAlice).to.be.gt(0n); // alice has a live, non-zero snapshot

    // ---- Drive both R predictions to be correct (UP: C > B). ----
    await advanceOneDay();
    await registry.connect(authority).setValue(s1, 110);
    await advanceOneDay();
    await registry.connect(authority).setValue(s1, 120);

    // ---- Bob settles first: this drips the pool (captures the round pot) and
    //      drains pool->0, rate->0, so the token is now "drained". ----
    await satori.settlePrediction(bob.address, s1);
    expect(await bounties.pool(s1, usdAddr)).to.equal(0n);
    expect(await bounties.ratePerRound(s1, usdAddr)).to.equal(0n);
    const pot = await bounties.roundBountyPot(s1, r, usdAddr);
    expect(pot).to.equal(ethers.parseEther("100"));

    // ---- Permissionless cleanup of the drained token, BEFORE alice settles.
    //      This clears _gameTokenSeen[s1][usd] and shortens gameBountyTokens,
    //      but must NOT block alice's already-captured payout. ----
    await bounties.connect(owner).cleanupDrainedBountyToken(s1, usdAddr);

    // ---- Alice settles. Her snapshot is intact, she predicted correctly,
    //      her stake never moved. INTENDED: she is paid her stake-share. ----
    const aliceStakeBefore = await bounties.bountyStake(alice.address, usdAddr);
    await satori.settlePrediction(alice.address, s1);

    const aliceEarned =
      (await bounties.bountyStake(alice.address, usdAddr)) - aliceStakeBefore;

    // INTENT 1: a correct predictor with a non-zero snapshot MUST be paid.
    expect(
      aliceEarned,
      "alice has a live R-time snapshot and predicted correctly; she must be paid her stake-share, not zero"
    ).to.be.gt(0n);

    // INTENT 2 (conservation): the captured round pot must fully drain to the
    // winners; alice's ~half share must not be permanently stranded.
    const bobEarned =
      (await bounties.bountyStake(bob.address, usdAddr)) - ethers.parseEther("100");
    const totalCredited = bobEarned + aliceEarned;
    expect(
      totalCredited,
      "the dripped pot must fully drain to the winners (no stranded residue)"
    ).to.be.closeTo(pot, 10n);
  });
});
