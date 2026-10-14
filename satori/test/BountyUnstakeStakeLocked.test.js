/**
 * Bounty unstake gated by round-based stake lock (cycle-attack fix).
 *
 * History: v4 used `UnstakeLockedByPending` (pending-counter based) which
 * was over-restrictive — it could lock the user for many rounds. v5
 * removed the lock entirely, arguing the snapshot was self-sufficient
 * for payouts. That was true for payouts but missed a separate
 * vulnerability: the **cycle attack**. A user could stake → predict →
 * unstake → send the underlying tokens to a friend who stakes-and-
 * predicts on the same stream/round, effectively double-counting the
 * same on-chain tokens in totalRawBoost while contractTk stayed
 * constant. The sqrt rate-depression only partially bounded the attack.
 *
 * v6 fix: `applyBoost` sets `stakeLockedUntil[user][token] =
 * predictRound + 1` whenever a snapshot fires. `unstakeBountyToken`
 * reverts with `StakeLocked` if `stakeLockedUntil > currentRound`. This
 * prevents the cycle attack (the underlying tokens can't leave the
 * user's slot within the predict round) while remaining UX-friendly
 * (only one round, not the v4 multi-round pending-prediction lock).
 *
 * The snapshot architecture is still load-bearing for payouts: the
 * user's eventual share is computed from the predict-time snapshot,
 * not the live stake. The lock only prevents the *underlying tokens*
 * from being recycled.
 *
 * These tests pin the v6 behavior.
 */

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture, pack1 , warmUpStreak, VOTE } = require("./fixtures");

const UP = 1;

async function deployMockToken(symbol = "USDC") {
  const M = await ethers.getContractFactory("MockERC20");
  const t = await M.deploy(symbol, symbol);
  await t.waitForDeployment();
  return t;
}

async function advanceOneDay() { await time.increase(86400); }

// Membership check: is `tokenAddr` in the user's dedup'd round bounty-token
// list for `round`? Replaces the old per-token "is this pending" boolean.
async function boostedInRound(bounties, user, tokenAddr, round) {
  const n = await bounties.boostedTokenCountInRound(user.address, round);
  for (let i = 0n; i < n; i++) {
    const t = await bounties.boostedTokensInRound(user.address, round, i);
    if (t.toLowerCase() === tokenAddr.toLowerCase()) return true;
  }
  return false;
}

async function createStream(satori, signer, name, authority) {
  // Every-round (1440-minute) stream — one value write per 24h round, which is
  // this suite's rhythm. 1440 is the finest PUBLIC cadence SatoriHub allows, so
  // no admin exemption is needed. `authority` stays the provider — it is who
  // may call `registry.setValue`.
  const tx = await satori.connect(signer)["createSimpleDataStream(string,address,uint24)"](name, authority, 1440);
  const rcpt = await tx.wait();
  for (const log of rcpt.logs) {
    try {
      const p = satori.interface.parseLog(log);
      if (p && p.name === "DataStreamCreated") return p.args.streamId;
    } catch (e) {}
  }
  throw new Error("DataStreamCreated event missing");
}

describe("Cycle attack — same on-chain tokens cannot snapshot twice in one round", function () {
  let satori, rewards, bounties, registry, owner;
  let alice, bob, funder, authority;
  let s1, usd, usdAddr;

  beforeEach(async function () {
    const fix = await loadFixture(deploySatoriFixture);
    ({ satori, rewards, bounties, registry, owner } = fix);
    [, alice, bob, funder, authority] = fix.signers;

    // Both alice and bob have SATORI prediction power.
    await satori.transfer(alice.address, ethers.parseEther("100"));
    await satori.transfer(bob.address, ethers.parseEther("100"));
    // Stream creation charges streamBurn(). The default game auto-created on
    // the stream is minted via a direct games-contract call that bypasses the
    // fee wrapper, so it costs nothing extra. (The creator is `owner`, so this
    // top-up just leaves the provider `authority` with a spare balance.)
    await satori.transfer(authority.address, await satori.streamBurn());

    s1 = await createStream(satori, owner, "S1", authority.address);

    // audit C-2: a bounty boost needs a non-zero multiplier, so streak >= 1

    await warmUpStreak(satori, registry, authority, [alice, bob], s1);
    await satori.connect(alice).vote(s1, VOTE);
    await satori.connect(bob).vote(s1, VOTE);

    usd = await deployMockToken("USDC");
    usdAddr = await usd.getAddress();

    // Funder funds the bounty pool. Funding a NON-SATORI bounty for the first
    // time on a (game, token) pair charges bountyBurn() SATORI from the funder.
    await satori.transfer(funder.address, await satori.bountyBurn());
    await usd.mint(funder.address, ethers.parseEther("10000"));
    await usd.connect(funder).approve(await bounties.getAddress(), ethers.parseEther("10000"));
    await bounties.connect(funder).fundBounty(
      s1, usdAddr, ethers.parseEther("1000"), ethers.parseEther("200")
    );

    // Alice starts with the 100 USDC she will try to cycle.
    await usd.mint(alice.address, ethers.parseEther("100"));
    await usd.connect(alice).approve(await bounties.getAddress(), ethers.parseEther("100"));
  });

  it("alice can't stake → predict → unstake → send-to-bob → re-stake within the same round", async function () {
    // Alice: stake 100 USDC, predict on s1 UP. Snapshot taken; lock fires.
    await registry.connect(authority).setValue(s1, 100);
    await bounties.connect(alice).stakeBountyToken(usdAddr, ethers.parseEther("100"));
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: s1, payload: pack1(UP) }]);

    // Alice's lock should now be set to predictRound + 1.
    const r = await satori.getCurrentRound();
    expect(await bounties.stakeLockedUntil(alice.address, usdAddr)).to.equal(r + 1n);

    // Cycle attempt: alice tries to unstake mid-round so she can send the
    // 100 USDC to bob. The lock blocks this.
    await expect(
      bounties.connect(alice).unstakeBountyToken(usdAddr, ethers.parseEther("100"), bob.address)
    ).to.be.revertedWithCustomError(bounties, "StakeLocked");

    // The lock prevents alice from releasing the underlying USDC this round,
    // so the cycle (send-to-bob → bob-stakes → bob-predicts in same round)
    // is structurally impossible. Bob cannot acquire-and-re-stake them
    // mid-round, so the same 100 USDC cannot snapshot twice in round R.

    // After round R+1, alice can unstake normally — the in-flight prediction's
    // snapshot still pays out at score time (verified in the other test).
    await advanceOneDay();
    await expect(
      bounties.connect(alice).unstakeBountyToken(usdAddr, ethers.parseEther("100"), bob.address)
    ).to.not.be.reverted;

    // Bob can stake in round R+1, but bob's prediction would land in
    // round R+1's accumulators, not round R's. Round R's snapshot total
    // is permanently locked in at 100 USDC of boost.
  });
});

describe("Bounty unstake — round-based stake lock (cycle-attack fix)", function () {
  let satori, rewards, bounties, registry, owner;
  let alice, bob, funder, authority;
  let s1, usd, usdAddr;

  beforeEach(async function () {
    const fix = await loadFixture(deploySatoriFixture);
    ({ satori, rewards, bounties, registry, owner } = fix);
    [, alice, bob, funder, authority] = fix.signers;

    await satori.transfer(alice.address, ethers.parseEther("100"));
    await satori.transfer(bob.address, ethers.parseEther("100"));
    // Top up `authority` with the stream-creation burn. The default game
    // auto-created on the new stream is minted via a direct games-contract call
    // that bypasses the fee wrapper, so it costs nothing extra — only
    // streamBurn() is charged per createStream call. (The creator is `owner`,
    // so `authority` is only the stream's provider here.)
    await satori.transfer(authority.address, await satori.streamBurn());

    s1 = await createStream(satori, owner, "S1", authority.address);

    // audit C-2: a bounty boost needs a non-zero multiplier, so streak >= 1

    await warmUpStreak(satori, registry, authority, [alice, bob], s1);
    await satori.connect(alice).vote(s1, VOTE);
    await satori.connect(bob).vote(s1, VOTE);

    usd = await deployMockToken("USDC");
    usdAddr = await usd.getAddress();

    // Funder funds the bounty pool on s1. First fund of a NON-SATORI
    // (game, token) pair charges bountyBurn() SATORI from the funder.
    await satori.transfer(funder.address, await satori.bountyBurn());
    await usd.mint(funder.address, ethers.parseEther("10000"));
    await usd.connect(funder).approve(await bounties.getAddress(), ethers.parseEther("10000"));
    await bounties.connect(funder).fundBounty(
      s1, usdAddr, ethers.parseEther("1000"), ethers.parseEther("200")
    );

    // Alice stakes 100 USD as boost; stake auto-subscribes her to USD.
    await usd.mint(alice.address, ethers.parseEther("100"));
    await usd.connect(alice).approve(await bounties.getAddress(), ethers.parseEther("100"));
    await bounties.connect(alice).stakeBountyToken(usdAddr, ethers.parseEther("100"));
  });

  // RE-ENABLED 2026-07-30 (skip triage): passes unmodified against the current
  // contracts — the property holds, so the skip was asserting nothing. See
  // docs/issues/closed/skip-triage-2026-07-30.md #6.
  it("unstake within predict round reverts StakeLocked; unstake at round+1 succeeds and snapshot still pays out", async function () {
    // Round R: alice predicts s1 UP — her 100 USD stake is snapshotted into
    // her boost contribution for (alice, s1, R, usd).
    await registry.connect(authority).setValue(s1, 100);
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: s1, payload: pack1(UP) }]);
    const r = await satori.getCurrentRound();

    // Telemetry: round bounty-token list now holds the snapshotted USD token
    // (one entry — a single distinct token snapshotted this round).
    expect(await bounties.boostedTokenCountInRound(alice.address, r)).to.equal(1n);
    expect(await boostedInRound(bounties, alice, usdAddr, r)).to.equal(true);

    // Snapshot exists for alice's R prediction on s1 in USD.
    const snap = await bounties.boostStakeForPrediction(alice.address, s1, r, usdAddr);
    expect(snap).to.be.gt(0n);

    // applyBoost set stakeLockedUntil[alice][usd] = R + 1.
    const lockUntil = await bounties.stakeLockedUntil(alice.address, usdAddr);
    expect(lockUntil).to.equal(r + 1n);

    // Within round R → StakeLocked revert (cycle attack prevented).
    await expect(
      bounties.connect(alice).unstakeBountyToken(usdAddr, ethers.parseEther("100"), alice.address)
    ).to.be.revertedWithCustomError(bounties, "StakeLocked");

    // Advance to round R+1 → unstake succeeds.
    await advanceOneDay();
    const usdBefore = await usd.balanceOf(alice.address);
    await expect(
      bounties.connect(alice).unstakeBountyToken(usdAddr, ethers.parseEther("100"), alice.address)
    ).to.not.be.reverted;
    expect((await usd.balanceOf(alice.address)) - usdBefore).to.equal(ethers.parseEther("100"));

    // bountyStake is now 0; the round bounty-token list is unchanged (still 1,
    // because unstake does not touch the snapshot list and the round hasn't
    // fully settled).
    expect(await bounties.bountyStake(alice.address, usdAddr)).to.equal(0n);
    expect(await bounties.boostedTokenCountInRound(alice.address, r)).to.equal(1n);
    expect(await boostedInRound(bounties, alice, usdAddr, r)).to.equal(true);

    // The snapshot the prediction committed to is also unchanged — it's
    // captured-in-storage, independent of the live stake.
    expect(await bounties.boostStakeForPrediction(alice.address, s1, r, usdAddr))
      .to.equal(snap);

    // Drive the prediction to score (UP correct: C > B).
    await advanceOneDay();
    await registry.connect(authority).setValue(s1, 110);
    await advanceOneDay();
    await registry.connect(authority).setValue(s1, 120);
    await satori.settlePrediction(alice.address, s1);

    // Round fully settled (this was the only prediction in round R), so
    // clearRoundBountyList fired and the round bounty-token list is empty.
    expect(await bounties.boostedTokenCountInRound(alice.address, r)).to.equal(0n);
    expect(await boostedInRound(bounties, alice, usdAddr, r)).to.equal(false);

    // Snapshot-based payout still arrived: bountyStake rematerialized via
    // auto-compound from 0 to the user's earned share of the pot.
    expect(await bounties.bountyStake(alice.address, usdAddr)).to.be.gt(0n);

    // And the user can unstake the auto-compounded earnings normally.
    const earnings = await bounties.bountyStake(alice.address, usdAddr);
    const usdBefore2 = await usd.balanceOf(alice.address);
    await bounties.connect(alice).unstakeBountyToken(usdAddr, earnings, alice.address);
    expect((await usd.balanceOf(alice.address)) - usdBefore2).to.equal(earnings);
  });

  it("partial AND full unstake are both gated by the round lock; both succeed at round+1", async function () {
    await registry.connect(authority).setValue(s1, 100);
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: s1, payload: pack1(UP) }]);
    const r = await satori.getCurrentRound();

    // Partial unstake (40 of 100) within the predict round → revert.
    await expect(
      bounties.connect(alice).unstakeBountyToken(usdAddr, ethers.parseEther("40"), alice.address)
    ).to.be.revertedWithCustomError(bounties, "StakeLocked");

    // Advance to round R+1 → partial unstake succeeds.
    await advanceOneDay();
    await expect(
      bounties.connect(alice).unstakeBountyToken(usdAddr, ethers.parseEther("40"), alice.address)
    ).to.not.be.reverted;
    expect(await bounties.bountyStake(alice.address, usdAddr)).to.equal(ethers.parseEther("60"));
    // Round bounty-token list unaffected by the partial unstake — the snapshot
    // still records the single distinct token boosted this round.
    expect(await bounties.boostedTokenCountInRound(alice.address, r)).to.equal(1n);
    expect(await boostedInRound(bounties, alice, usdAddr, r)).to.equal(true);

    // Full unstake of the remaining 60 — now also unlocked.
    await expect(
      bounties.connect(alice).unstakeBountyToken(usdAddr, ethers.parseEther("60"), alice.address)
    ).to.not.be.reverted;
    expect(await bounties.bountyStake(alice.address, usdAddr)).to.equal(0n);
  });
});
