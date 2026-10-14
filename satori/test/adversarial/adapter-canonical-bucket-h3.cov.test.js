// Regression guard for audit finding H3 (HIGH): adapter-game over-mint via a
// per-user denominator under the SCORE/TOTAL model.
//
// The protocol queries the adapter's score(user, gameId) PER USER and gets back
// (userScore, total). `total` is the shared (game, round) denominator and must be
// the SAME for everyone in the round. A hostile adapter (EveryoneWinsGame) lies:
// it announces total == that user's OWN userScore, trying to claim
//   reward = streamPool * userScore / userScore == streamPool  (the FULL pool, each)
// → N predictors would each mint one full streamPool (N × pool, an over-mint).
//
// FIX (structural, two rails in scoreAdapterPrediction): (1) PIN the first
// scorer's `total` for the whole (gameId, round) and reuse it for everyone; and
// (2) CAP the running sum of paid numerators at that pinned total. The first
// scorer pins total == w1, the running sum immediately reaches it, and every
// later predictor is clamped to 0 — so AT MOST one streamPool is ever minted,
// regardless of what the adapter returns. Honest adapters (which already return
// one consistent total for the whole round, e.g. YesNoGame) are unaffected.
//
// MINT ELIGIBILITY now bounds the same thing from a second, blunter direction:
// only the built-in binary game earns from the mint, so an adapter game cannot
// be voted for, carries no weight, and its `streamPool` is ZERO. The over-mint
// this file guards is not merely capped at one pool — it is capped at nothing.
// The two rails still run on every score (the pin and the paid-cap are computed
// before the pool multiply), so the structure is unchanged; what the assertions
// below now measure is that N × pool == 1 × pool == 0. The pool-splitting
// arithmetic itself is still exercised end-to-end on the BINARY rail, and the
// adapter's proportional split is still live on the BOUNTY rail (funded escrow,
// which pays on every game type).

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time, impersonateAccount, setBalance } =
  require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture, pack1 , voteFor } = require("../fixtures");

const ROUND = 86400;
const TOKENS_PER_ROUND = ethers.parseEther("1440");

async function advanceRound() { await time.increase(ROUND); }

async function gameIdFrom(tx, games) {
  const r = await tx.wait();
  for (const log of r.logs) {
    try {
      const p = games.interface.parseLog(log);
      if (p && p.name === "GameCreated") return Number(p.args.gameId);
    } catch (e) {}
  }
  throw new Error("GameCreated event missing");
}

async function impersonateCore(satori) {
  const satoriAddr = await satori.getAddress();
  await impersonateAccount(satoriAddr);
  await setBalance(satoriAddr, ethers.parseEther("10"));
  return ethers.getSigner(satoriAddr);
}

// Deploy the fixture + a malicious EveryoneWinsGame adapter game on a fresh
// stream, voted eligible, with `n` equal-weight predictors who have predicted.
async function setupEvil(n) {
  const fix = await loadFixture(deploySatoriFixture);
  const { satori, registry, games, owner, signers } = fix;

  const Evil = await ethers.getContractFactory("EveryoneWinsGame");
  const evil = await Evil.deploy(await satori.getAddress());
  await evil.waitForDeployment();
  const coreSigner = await impersonateCore(satori);
  await games.connect(coreSigner).registerGameAdapter(
    await evil.getAddress(), owner.address, "Evil", false
  );

  const streamId = await streamIdFrom(
    await satori.connect(owner)["createSimpleDataStream(string,address,uint24)"]("S", owner.address, 2880),
    satori);
  await registry.connect(owner).setValue(streamId, 100);
  const g = await gameIdFrom(
    await satori.connect(owner).createGame(streamId, 1, "0x", "evil"), games);
  // Unvotable: `vote` on an adapter game reverts GameNotMintEligible, so the
  // game's round allocation is zero however hard its adapter lies about scores.
  await expect(voteFor(satori, owner, g))
    .to.be.revertedWithCustomError(fix.voting, "GameNotMintEligible");

  const ps = [];
  for (let i = 1; i <= n; i++) {
    ps.push(signers[i]);
    await satori.transfer(signers[i].address, ethers.parseEther("10"));
  }
  for (const p of ps) {
    await satori.connect(p).predictMultipleWithPayloads([{ gameId: g, payload: pack1(1) }]);
  }

  // Cadence-2 stream: the second host write must be >= 2 rounds after the first.
  await advanceRound();
  await advanceRound();
  await registry.connect(owner).setValue(streamId, 200);
  return { ...fix, evil, streamId, g, ps };
}


// The fixture now initializes the DEFAULT stream at id 1 (as production does),
// so the first stream a test creates is id 2. Read the id off the event.
async function streamIdFrom(tx, satori) {
  const r = await tx.wait();
  for (const log of r.logs) {
    try {
      const p = satori.interface.parseLog(log);
      if (p && p.name === "DataStreamCreated") return Number(p.args.streamId);
    } catch (e) {}
  }
  throw new Error("DataStreamCreated event missing");
}

describe("H3 cov — adapter (game,round) total is pinned + capped (score/total model)", function () {
  this.timeout(300000);

  it("EveryoneWinsGame: 5 'total==own score' sybils are paid NOTHING, let alone 5× a pool (conservation)", async function () {
    const { satori, rewards, evil, g, ps } = await setupEvil(5);

    const before = {};
    for (const p of ps) before[p.address] = await rewards.unclaimedRewards(p.address);

    for (const p of ps) await satori.settlePrediction(p.address, g);

    const gains = [];
    let totalCredited = 0n;
    for (const p of ps) {
      const gain = (await rewards.unclaimedRewards(p.address)) - before[p.address];
      gains.push(gain);
      totalCredited += gain;
    }

    // Every sybil's bet really was scored — the adapter consumed all five
    // pending records — so the zeros are resolved outcomes, not stalled settles.
    for (const p of ps) expect(await evil.pendingRound(g, p.address)).to.equal(0n);

    // The whole point: the per-game round pool is bounded by the round budget;
    // total credited across ALL of the adapter's "winners" must not exceed it.
    // (Pre-fix this was ~2734, i.e. ~3.8× — far over 720.)
    expect(totalCredited).to.be.lte(TOKENS_PER_ROUND,
      "sum of adapter-game payouts must not exceed one round budget");

    // And it is exactly zero. The pin+cap rails still clamp every later scorer
    // to 0; the mint boundary clamps the FIRST one too, because the pool the
    // pinned share is taken from is zero for an adapter game.
    expect(totalCredited).to.equal(0n);
    expect(gains.filter((x) => x > 0n).length).to.equal(0,
      "not even the first scorer is paid: an adapter game draws no pool");
  });

  it("over-mint is realized through mint too: total claimed <= one round budget", async function () {
    const { satori, rewards, g, ps } = await setupEvil(5);
    for (const p of ps) await satori.settlePrediction(p.address, g);

    // Open up cumulative-cap headroom, then claim everyone.
    for (let i = 0; i < 4; i++) await advanceRound();

    let totalClaimed = 0n;
    for (const p of ps) {
      const b0 = await satori.balanceOf(p.address);
      await satori.connect(p).claim();
      totalClaimed += (await satori.balanceOf(p.address)) - b0;
    }
    expect(totalClaimed).to.be.lte(TOKENS_PER_ROUND,
      "actual minted SATORI to all winners must not exceed one round budget");
    // Realized through mint, the over-mint is not just bounded — it is zero.
    expect(totalClaimed).to.equal(0n);
  });

  it("conservation holds regardless of settle order (reverse order)", async function () {
    const { satori, rewards, g, ps } = await setupEvil(5);

    const before = {};
    for (const p of ps) before[p.address] = await rewards.unclaimedRewards(p.address);

    // Settle in REVERSE: now the LAST user pins the canonical total.
    for (let i = ps.length - 1; i >= 0; i--) await satori.settlePrediction(ps[i].address, g);

    let totalCredited = 0n;
    const gains = [];
    for (const p of ps) {
      const gain = (await rewards.unclaimedRewards(p.address)) - before[p.address];
      gains.push(gain);
      totalCredited += gain;
    }
    expect(totalCredited).to.be.lte(TOKENS_PER_ROUND);
    // Settle-order independence, at its new floor: reversing the order changes
    // nothing, because there is nothing to allocate. Whoever pins the total
    // pins a share of a zero pool.
    expect(totalCredited).to.equal(0n);
    expect(gains.filter((x) => x > 0n).length).to.equal(0);
  });

  it("an honest YesNoGame is treated identically: both YES winners are paid ZERO, and so is the NO bettor", async function () {
    const fix = await loadFixture(deploySatoriFixture);
    const { satori, engine, rewards, registry, games, owner, signers } = fix;

    const YesNoGame = await ethers.getContractFactory("YesNoGame");
    const yesNo = await YesNoGame.deploy(
      await engine.getAddress(), await games.getAddress(),
      await registry.getAddress());
    await yesNo.waitForDeployment();
    const coreSigner = await impersonateCore(satori);
    await games.connect(coreSigner).registerGameAdapter(
      await yesNo.getAddress(), owner.address, "YesNo", false);

    const streamId = await streamIdFrom(
      await satori.connect(owner)["createSimpleDataStream(string,address,uint24)"]("S", owner.address, 2880),
      satori);
    await registry.connect(owner).setValue(streamId, 100);
    const cfg = ethers.AbiCoder.defaultAbiCoder().encode(["int128"], [150]);
    const g = await gameIdFrom(
      await satori.connect(owner).createGame(streamId, 1, cfg, "yesno"), games);
    // Honest or hostile, an adapter game is not mint-eligible: the burn that
    // would size its pool is refused.
    await expect(voteFor(satori, owner, g))
      .to.be.revertedWithCustomError(fix.voting, "GameNotMintEligible");

    const yes1 = signers[1], yes2 = signers[2], no1 = signers[3];
    for (const p of [yes1, yes2, no1]) await satori.transfer(p.address, ethers.parseEther("10"));

    // Two equal-weight YES predictors and one NO predictor.
    await satori.connect(yes1).predictMultipleWithPayloads([{ gameId: g, payload: pack1(1) }]);
    await satori.connect(yes2).predictMultipleWithPayloads([{ gameId: g, payload: pack1(1) }]);
    await satori.connect(no1).predictMultipleWithPayloads([{ gameId: g, payload: pack1(2) }]);

    const before = {};
    for (const p of [yes1, yes2, no1]) before[p.address] = await rewards.unclaimedRewards(p.address);

    // Cadence-2 stream: the second host write must be >= 2 rounds after the first.
    await advanceRound();
    await advanceRound();
    await registry.connect(owner).setValue(streamId, 200); // 200 > 150 → YES wins

    for (const p of [yes1, yes2, no1]) await satori.settlePrediction(p.address, g);

    const gYes1 = (await rewards.unclaimedRewards(yes1.address)) - before[yes1.address];
    const gYes2 = (await rewards.unclaimedRewards(yes2.address)) - before[yes2.address];
    const gNo1 = (await rewards.unclaimedRewards(no1.address)) - before[no1.address];

    // The round really resolved YES and every bet was consumed — so these are
    // settled outcomes, not pending ones.
    for (const p of [yes1, yes2, no1]) {
      expect(await yesNo.pendingRound(g, p.address)).to.equal(0n);
    }

    // Both YES winners are paid the same as the NO bettor: nothing. The fix is
    // still a no-op for honest adapters — there is simply no pool to be a no-op
    // over. Equal weight → equal (zero) slices.
    expect(gYes1).to.equal(0n);
    expect(gYes2).to.equal(0n);
    expect(gNo1).to.equal(0n);
    expect(gYes1).to.equal(gYes2);
    // Conservation: the two slices sum to no more than one round budget.
    expect(gYes1 + gYes2).to.be.lte(TOKENS_PER_ROUND);
  });

  // (The old "Bucket0Game (winningBucket 0)" probe is dropped: Bucket0Game.sol
  // is deleted and buckets are meaningless under the score/total model. Its
  // intent — "a finalized prediction is never paid twice" — is preserved by the
  // no-double-pay assertions in the EveryoneWinsGame / re-score cases above and
  // the second-settle no-op test below.)

  // A finalized adapter prediction is consumed at score time: a second settle on
  // the SAME (user, game) pays nothing. Re-expresses the old Bucket0Game
  // double-pay guard for the score/total model (record consumed → no double-pay),
  // including the legal pinned-total==0 / pinned-total>0 paths.
  it("second settle is a no-op: a finalized prediction pays nothing on re-score", async function () {
    const { satori, rewards, evil, g, ps } = await setupEvil(3);

    // First settle pins the canonical total and pays the first scorer.
    const before = {};
    for (const p of ps) before[p.address] = await rewards.unclaimedRewards(p.address);
    for (const p of ps) await satori.settlePrediction(p.address, g);

    const firstGains = {};
    for (const p of ps) firstGains[p.address] =
      (await rewards.unclaimedRewards(p.address)) - before[p.address];

    // The first settle CONSUMED every record — that is what makes the second
    // settle a no-op, and it is the fact under test. (The credits themselves
    // are all zero: an adapter game draws no pool.)
    for (const p of ps) expect(await evil.pendingRound(g, p.address)).to.equal(0n);

    // Re-settle EVERYONE: each prediction was consumed at first score, so no
    // further credit accrues to anyone (winner or loser).
    for (const p of ps) await satori.settlePrediction(p.address, g);
    for (const p of ps) {
      const secondGain =
        (await rewards.unclaimedRewards(p.address)) - before[p.address] - firstGains[p.address];
      expect(secondGain).to.equal(0n, "second settle must pay nothing (record consumed)");
    }
  });

  // Ported from the H3 staging repro: two adapter (type-1) games on ONE stream
  // (the deferred multi-game scenario, still permitted in-contract) — combined
  // winner payout across both games stays within one round budget.
  it("two YesNo adapter games on one stream: combined payout <= one round budget", async function () {
    const fix = await loadFixture(deploySatoriFixture);
    const { satori, engine, rewards, registry, games, owner, signers } = fix;

    const YesNoGame = await ethers.getContractFactory("YesNoGame");
    const yesNo = await YesNoGame.deploy(
      await engine.getAddress(), await games.getAddress(),
      await registry.getAddress());
    await yesNo.waitForDeployment();
    const coreSigner = await impersonateCore(satori);
    await games.connect(coreSigner).registerGameAdapter(
      await yesNo.getAddress(), owner.address, "YesNo", false);

    const streamId = await streamIdFrom(
      await satori.connect(owner)["createSimpleDataStream(string,address,uint24)"]("S", owner.address, 2880),
      satori);
    await registry.connect(owner).setValue(streamId, 100);
    const cfg = ethers.AbiCoder.defaultAbiCoder().encode(["int128"], [150]);
    const gA = await gameIdFrom(await satori.connect(owner).createGame(streamId, 1, cfg, "A"), games);
    const gB = await gameIdFrom(await satori.connect(owner).createGame(streamId, 1, cfg, "B"), games);

    // Neither adapter game can be bought weight — that is the point of the
    // combined bound below: two adapter games on one stream draw one stream's
    // worth of nothing.
    const v2 = signers[9];
    await satori.transfer(v2.address, ethers.parseEther("5"));
    await expect(voteFor(satori, owner, gA))
      .to.be.revertedWithCustomError(fix.voting, "GameNotMintEligible");
    await expect(voteFor(satori, v2, gB, ethers.parseEther("5")))
      .to.be.revertedWithCustomError(fix.voting, "GameNotMintEligible");

    const p1 = signers[1], p2 = signers[2], p3 = signers[3];
    for (const p of [p1, p2, p3]) await satori.transfer(p.address, ethers.parseEther("10"));
    await satori.connect(p1).predictMultipleWithPayloads([{ gameId: gA, payload: pack1(1) }]);
    await satori.connect(p2).predictMultipleWithPayloads([{ gameId: gB, payload: pack1(1) }]);
    await satori.connect(p3).predictMultipleWithPayloads([{ gameId: gB, payload: pack1(2) }]);

    const before = {};
    for (const p of [p1, p2, p3]) before[p.address] = await rewards.unclaimedRewards(p.address);

    // Cadence-2 stream: the second host write must be >= 2 rounds after the first.
    await advanceRound();
    await advanceRound();
    await registry.connect(owner).setValue(streamId, 200); // 200 > 150 → YES wins both

    for (const [p, gm] of [[p1, gA], [p2, gB], [p3, gB]]) await satori.settlePrediction(p.address, gm);

    let total = 0n;
    for (const p of [p1, p2, p3]) total += (await rewards.unclaimedRewards(p.address)) - before[p.address];
    expect(total).to.be.lte(TOKENS_PER_ROUND,
      "combined payout across both adapter games must not exceed one round budget");
    expect(total).to.equal(0n);
    // ...and every bet was genuinely scored on its way to that zero.
    for (const [p, gm] of [[p1, gA], [p2, gB], [p3, gB]]) {
      expect(await yesNo.pendingRound(gm, p.address)).to.equal(0n);
    }
  });
});
