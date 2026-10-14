// Bounties on ADAPTER games — score/total model, SINGLE ACTIVE token per round.
//
// GOAL/model (see docs/issues/closed/bounty-score-total-single-token.md + the
// IPredictionGame / ISatoriBounties interfaces): adapter games keep SATORI on the
// score/total model, and pay BOUNTIES on the SAME accuracy `userScore` weighted by
// the user's bounty STAKE (never by SATORI holdings):
//
//   * SATORI share  = pool × (userScore × multiplier) / total
//   * BOUNTY share  = pot  × (userScore × stake)     / bountyTotal
//
// where `bountyTotal = Σ userScore×stake` over the winning outcome (the adapter
// supplies it). For YesNoGame `userScore` is 1 on the side picked, so `bountyTotal`
// is Σ stake over the winning direction and the winners split that token's pot by
// stake. Score-0 (wrong/zero-accuracy) ⇒ numerator 0 ⇒ no bounty, by construction.
//
// Per (adapter game, round) exactly ONE token is ACTIVE — the first queued token
// with live funding, pinned at the round's first predict (snapshotAdapterStake)
// and frozen for the round. At score time scoreAdapterPrediction pins the FIRST
// scorer's `bountyTotal` and creditAdapterBounty pays the active token's pot,
// capping the running paid: Σ payouts + fee ≤ ONE pot — even for a hostile adapter
// that inflates userScore / bountyTotal.
//
// This file proves, against a HOSTILE/edge adapter surface:
//   * conservation under an over-reporting adapter (EveryoneWinsGame: bountyTotal=1
//     with huge per-user userScore) — exactly ONE pot is distributed, never N×;
//   * stake-only eligibility — a winning-side predictor who never staked the active
//     token gets zero bounty;
//   * first-scorer pin — settle order does not change who is paid or the total.
//
// THE TWO RAILS ARE SEPARATE. Only the built-in binary game (gameTypeId 0) is
// mint-eligible, so `vote` on any adapter game reverts GameNotMintEligible: an
// adapter game can never hold voting weight and its SATORI pool is always ZERO.
// None of that touches the bounty rail — bounty pools are separately funded
// escrow paid on accuracy × stake — so every assertion below stands on its own
// terms, and the SATORI-side zero pinned in case (1) is paired with the same
// settle having paid the bounty in full, so it can never be a stalled no-op.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time, impersonateAccount, setBalance } =
  require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture, pack1, voteFor } = require("../fixtures");

const ROUND = 86400, YES = 1, NO = 2;
const TOL = ethers.parseEther("0.01");
// Cadence-2 host streams accept a new setValue only every >= 2 rounds (and
// >= 2*24h - 30min of wall-clock). This helper sits between the two host writes
// of every test, so advance TWO rounds to satisfy the write rhythm. Adapters
// score on round-advance (currentRound > predictRound), so the extra round does
// not change any outcome.
async function advanceRound() { await time.increase(2 * ROUND); }
async function gameIdFrom(tx, games) {
  const r = await tx.wait();
  for (const log of r.logs) {
    try { const p = games.interface.parseLog(log); if (p && p.name === "GameCreated") return Number(p.args.gameId); } catch (e) {}
  }
  throw new Error("GameCreated missing");
}
// Genesis creates the DEFAULT stream at id 1 plus its derived family at ids
// 2..4, so the first stream a test creates is id 5. Read it off the event.
async function streamIdFrom(tx, satori) {
  const r = await tx.wait();
  for (const log of r.logs) {
    try { const p = satori.interface.parseLog(log); if (p && p.name === "DataStreamCreated") return Number(p.args.streamId); } catch (e) {}
  }
  throw new Error("DataStreamCreated missing");
}
async function impersonateCore(satori) {
  const a = await satori.getAddress();
  await impersonateAccount(a); await setBalance(a, ethers.parseEther("10"));
  return ethers.getSigner(a);
}
async function deployToken(sym = "USDC") {
  const M = await ethers.getContractFactory("MockERC20");
  const t = await M.deploy(sym, sym);
  await t.waitForDeployment();
  return t;
}
async function stakeFor(bounties, user, token, amount) {
  await token.mint(user.address, amount);
  await token.connect(user).approve(await bounties.getAddress(), amount);
  await bounties.connect(user).stakeBountyToken(await token.getAddress(), amount);
}
// fundBounty BEFORE any predict so the round's first predict pins this as the
// active token (live pool+rate for the game).
// The first fund of a (game, token) pair in a NON-SATORI token now costs an
// upfront `bountyBurn()` SATORI burn charged to the funder, so seed the funder
// with exactly that much SATORI from `owner` (holds the bootstrap mint).
async function fundBountyOn(fix, funder, token, gameId, poolEth = "1000", rateEth = "200") {
  const { satori, bounties, owner } = fix;
  await satori.connect(owner).transfer(funder.address, await satori.bountyBurn());
  await token.mint(funder.address, ethers.parseEther("100000"));
  await token.connect(funder).approve(await bounties.getAddress(), ethers.MaxUint256);
  const POT = ethers.parseEther(rateEth); // virgin pool: drip == rate per scored round
  await bounties.connect(funder).fundBounty(gameId, await token.getAddress(), ethers.parseEther(poolEth), POT);
  return POT;
}

// Register a YesNoGame adapter at type 1 and create a game on a fresh
// (cadence-2, the finest a PUBLIC stream may be) stream with the given int128
// threshold. Returns { gameId, streamId, yesNo }.
//
// NO vote: an adapter game is not mint-eligible, so `vote` on it reverts
// GameNotMintEligible. It draws no SATORI pool — and needs none: the bounty rail
// this file exercises is funded escrow, entirely independent of the mint.
async function setupYesNoGame(fix, threshold = 150) {
  const { satori, registry, rewards, games, owner, engine } = fix;
  const YesNoGame = await ethers.getContractFactory("YesNoGame");
  const yesNo = await YesNoGame.deploy(await engine.getAddress(), await games.getAddress(),
    await registry.getAddress());
  await yesNo.waitForDeployment();
  const coreSigner = await impersonateCore(satori);
  await games.connect(coreSigner).registerGameAdapter(await yesNo.getAddress(), owner.address, "YesNo", false);

  const streamId = await streamIdFrom(
    await satori.connect(owner)["createSimpleDataStream(string,address,uint24)"]("S", owner.address, 2880),
    satori);
  // A predict requires the host stream to have been written in the CURRENT
  // round (PredictExpired), so seed the anchor here.
  await registry.connect(owner).setValue(streamId, 100);
  const cfg = ethers.AbiCoder.defaultAbiCoder().encode(["int128"], [threshold]);
  const gameId = await gameIdFrom(await satori.connect(owner).createGame(streamId, 1, cfg, "yn"), games);
  return { gameId, streamId, yesNo };
}

describe("adapter-bounty (score/total, single active token) — conservation + stake eligibility under a hostile adapter", function () {
  this.timeout(300000);

  it("winning-side stakers split the active token's pot by STAKE; wrong-side staker gets none; Σ payouts + fee == pot", async function () {
    const fix = await loadFixture(deploySatoriFixture);
    const { satori, registry, rewards, bounties, signers } = fix;
    const funder = signers[5];

    const { gameId, streamId, yesNo } = await setupYesNoGame(fix, 150);
    const tok = await deployToken();
    const POT = await fundBountyOn(fix, funder, tok, gameId);
    const tokAddr = await tok.getAddress();

    // yes1 stakes 300, yes2 stakes 100 (both pick the WINNING side YES);
    // no1 stakes 100 but picks the LOSING side NO (userScore 0 → no bounty).
    const yes1 = signers[1], yes2 = signers[2], no1 = signers[3];
    for (const p of [yes1, yes2, no1]) await satori.transfer(p.address, ethers.parseEther("10"));
    await stakeFor(bounties, yes1, tok, ethers.parseEther("300"));
    await stakeFor(bounties, yes2, tok, ethers.parseEther("100"));
    await stakeFor(bounties, no1,  tok, ethers.parseEther("100"));

    const stake1 = await bounties.bountyStake(yes1.address, tokAddr);
    const stake2 = await bounties.bountyStake(yes2.address, tokAddr);
    const stakeNo = await bounties.bountyStake(no1.address, tokAddr);

    const predictRound = Number(await satori.getCurrentRound());
    await satori.connect(yes1).predictMultipleWithPayloads([{ gameId, payload: pack1(YES) }]);
    await satori.connect(yes2).predictMultipleWithPayloads([{ gameId, payload: pack1(YES) }]);
    await satori.connect(no1).predictMultipleWithPayloads([{ gameId, payload: pack1(NO) }]);

    await advanceRound();
    await registry.connect(fix.owner).setValue(streamId, 200);     // 200 > 150 → YES wins

    for (const p of [yes1, yes2, no1]) await satori.settlePrediction(p.address, gameId);

    // Bounty winnings are auto-restaked: earned == bountyStake − originalStake.
    const earn1  = (await bounties.bountyStake(yes1.address, tokAddr)) - stake1;
    const earn2  = (await bounties.bountyStake(yes2.address, tokAddr)) - stake2;
    const earnNo = (await bounties.bountyStake(no1.address,  tokAddr)) - stakeNo;

    expect(earn1).to.be.gt(0n);
    expect(earn2).to.be.gt(0n);
    expect(earnNo).to.equal(0n);                                   // wrong side → score 0 → no bounty
    // STAKE-weighted on accuracy: yes1 staked 3× yes2, both accuracy 1 → earns ~3×
    // yes2 (NOT SATORI-weighted — both have identical SATORI power here).
    expect(earn1).to.be.closeTo(earn2 * 3n, TOL);

    // The pot that actually dripped for the predict round.
    const dripped = await bounties.roundBountyPot(gameId, predictRound, tokAddr);
    expect(dripped).to.equal(POT);

    // CONSERVATION: winners == the dripped pot, never more (no payout fee).
    expect(earn1 + earn2).to.be.closeTo(dripped, TOL);
    expect(earn1 + earn2).to.be.lte(dripped + TOL);

    // THE OTHER RAIL, INVERTED: the same three settles credited ZERO SATORI.
    // An adapter game is not mint-eligible — `vote` refuses it, so it holds no
    // weight and its round pool is zero — while its bounty was paid in full
    // above by those very settles. The bounty payout and the consumed adapter
    // records below are what make these zeros a resolved outcome and not a
    // stalled no-op.
    expect(await yesNo.roundOutcome(gameId, predictRound)).to.equal(YES);
    for (const p of [yes1, yes2, no1]) {
      expect(await yesNo.pendingRound(gameId, p.address)).to.equal(0n);
      expect(await rewards.unclaimedRewards(p.address)).to.equal(0n);
    }
  });

  it("a predictor who did NOT stake the active token earns no bounty (stake-only eligibility)", async function () {
    const fix = await loadFixture(deploySatoriFixture);
    const { satori, registry, rewards, bounties, signers } = fix;
    const funder = signers[5];

    const { gameId, streamId } = await setupYesNoGame(fix, 150);
    const tok = await deployToken();
    const POT = await fundBountyOn(fix, funder, tok, gameId);
    const tokAddr = await tok.getAddress();

    // staker stakes + picks YES; nonStaker also picks YES but never staked.
    const staker = signers[1], nonStaker = signers[2];
    for (const p of [staker, nonStaker]) await satori.transfer(p.address, ethers.parseEther("10"));
    await stakeFor(bounties, staker, tok, ethers.parseEther("200"));
    const stakerStake = await bounties.bountyStake(staker.address, tokAddr);

    const predictRound = Number(await satori.getCurrentRound());
    await satori.connect(staker).predictMultipleWithPayloads([{ gameId, payload: pack1(YES) }]);
    await satori.connect(nonStaker).predictMultipleWithPayloads([{ gameId, payload: pack1(YES) }]);

    await advanceRound();
    await registry.connect(fix.owner).setValue(streamId, 200); // YES wins

    await satori.settlePrediction(staker.address, gameId);
    await satori.settlePrediction(nonStaker.address, gameId);

    const stakerEarn = (await bounties.bountyStake(staker.address, tokAddr)) - stakerStake;
    const nonStakerEarn = await bounties.bountyStake(nonStaker.address, tokAddr); // 0 prior

    // Lone staker on the winning side takes the whole pot (no payout fee).
    expect(stakerEarn).to.be.gt(0n);
    expect(nonStakerEarn).to.equal(0n);              // never staked → no snapshot → no bounty
    const dripped = await bounties.roundBountyPot(gameId, predictRound, tokAddr);
    expect(dripped).to.equal(POT);
    expect(stakerEarn).to.be.closeTo(dripped, TOL);
    expect(stakerEarn).to.be.lte(dripped + TOL);
  });

  it("hostile adapter (EveryoneWinsGame) cannot over-pay the bounty: first-scorer pin + cap ⇒ exactly ONE pot total, never N×", async function () {
    // EveryoneWinsGame.score returns a HUGE per-user userScore (== prediction
    // power w) and bountyTotal == 1 — an over-report trying to claim
    //   pot × (userScore × stake) / 1 == many pots
    // for EVERY predictor. The protocol pins the FIRST scorer's bountyTotal (=1)
    // for the round, computes bountyNum SATURATING (clamped to the remaining
    // room), and caps the running paid at the pinned total. So the first scorer's
    // num saturates to room=1, immediately exhausting the cap, and every later
    // predictor is clamped to 0. Exactly ONE pot is distributed, no overflow.
    const fix = await loadFixture(deploySatoriFixture);
    const { satori, registry, rewards, bounties, games, owner, signers, engine } = fix;

    const Evil = await ethers.getContractFactory("EveryoneWinsGame");
    const evil = await Evil.deploy(await engine.getAddress());
    await evil.waitForDeployment();
    const coreSigner = await impersonateCore(satori);
    await games.connect(coreSigner).registerGameAdapter(await evil.getAddress(), owner.address, "Evil", false);

    const streamId = await streamIdFrom(
      await satori.connect(owner)["createSimpleDataStream(string,address,uint24)"]("S", owner.address, 2880),
      satori);
    await registry.connect(owner).setValue(streamId, 100);
    const gameId = await gameIdFrom(await satori.connect(owner).createGame(streamId, 1, "0x", "evil"), games);
    // Unvotable: an adapter game is not mint-eligible, so its SATORI pool is
    // zero however hard the adapter lies. The over-pay this case guards against
    // is the BOUNTY pot, which is real escrow and does pay on adapter games.
    await expect(voteFor(satori, owner, gameId))
      .to.be.revertedWithCustomError(fix.voting, "GameNotMintEligible");

    const funder = signers[5];
    const tok = await deployToken();
    const POT = await fundBountyOn(fix, funder, tok, gameId);
    const tokAddr = await tok.getAddress();

    const ps = [signers[1], signers[2], signers[3], signers[4]];
    const priorStake = {};
    for (const p of ps) {
      await satori.transfer(p.address, ethers.parseEther("10"));
      await stakeFor(bounties, p, tok, ethers.parseEther("100"));
      priorStake[p.address] = await bounties.bountyStake(p.address, tokAddr);
    }
    const predictRound = Number(await satori.getCurrentRound());
    for (const p of ps) await satori.connect(p).predictMultipleWithPayloads([{ gameId, payload: pack1(1) }]);

    await advanceRound();
    await registry.connect(owner).setValue(streamId, 200);

    for (const p of ps) await satori.settlePrediction(p.address, gameId);

    let total = 0n;
    for (const p of ps) {
      const earned = (await bounties.bountyStake(p.address, tokAddr)) - priorStake[p.address];
      total += earned;
    }
    const dripped = await bounties.roundBountyPot(gameId, predictRound, tokAddr);

    // Every sybil's bet really was scored — the hostile adapter consumed all
    // four pending records — so the bound below is over a completed round, not
    // a stalled one.
    for (const p of ps) expect(await evil.pendingRound(gameId, p.address)).to.equal(0n);

    // The cap (pinned bountyTotal == 1) is exhausted by the first scorer, so the
    // total bounty distributed is at most ONE pot — never N× (no over-pay), and no
    // overflow reverted settlement.
    expect(total).to.be.lte(dripped + TOL);
    // ...and it really is ONE pot, not zero: the bound is a cap that BINDS, so
    // "never N×" is proved against a live payout rather than an empty round.
    expect(total).to.be.gt(0n);
    expect(total).to.be.closeTo(dripped, TOL);
  });

  it("first-scorer pin is settle-order independent: reverse settle order pays the same winners the same total", async function () {
    // The first scorer pins bountyTotal for the round; later scorers reuse it.
    // Settling in reverse order must not change who is paid nor the conserved
    // total — proving the pin is order-independent, not first-mover-biased.
    const fix = await loadFixture(deploySatoriFixture);
    const { satori, registry, rewards, bounties, signers } = fix;
    const funder = signers[5];

    const { gameId, streamId } = await setupYesNoGame(fix, 150);
    const tok = await deployToken();
    const POT = await fundBountyOn(fix, funder, tok, gameId);
    const tokAddr = await tok.getAddress();

    const yes1 = signers[1], yes2 = signers[2];
    for (const p of [yes1, yes2]) await satori.transfer(p.address, ethers.parseEther("10"));
    await stakeFor(bounties, yes1, tok, ethers.parseEther("300"));
    await stakeFor(bounties, yes2, tok, ethers.parseEther("100"));
    const s1 = await bounties.bountyStake(yes1.address, tokAddr);
    const s2 = await bounties.bountyStake(yes2.address, tokAddr);

    const predictRound = Number(await satori.getCurrentRound());
    // yes1 predicts first; yes2 second.
    await satori.connect(yes1).predictMultipleWithPayloads([{ gameId, payload: pack1(YES) }]);
    await satori.connect(yes2).predictMultipleWithPayloads([{ gameId, payload: pack1(YES) }]);

    await advanceRound();
    await registry.connect(fix.owner).setValue(streamId, 200); // YES wins

    // Settle in REVERSE of predict order: yes2 (second predictor) scores first and
    // therefore PINS bountyTotal; yes1 reuses the pinned value.
    await satori.settlePrediction(yes2.address, gameId);
    await satori.settlePrediction(yes1.address, gameId);

    const earn1 = (await bounties.bountyStake(yes1.address, tokAddr)) - s1;
    const earn2 = (await bounties.bountyStake(yes2.address, tokAddr)) - s2;

    // Still stake-weighted 3:1 regardless of who scored first.
    expect(earn1).to.be.gt(0n);
    expect(earn2).to.be.gt(0n);
    expect(earn1).to.be.closeTo(earn2 * 3n, TOL);

    const dripped = await bounties.roundBountyPot(gameId, predictRound, tokAddr);
    expect(dripped).to.equal(POT);
    expect(earn1 + earn2).to.be.closeTo(dripped, TOL);
    expect(earn1 + earn2).to.be.lte(dripped + TOL);
  });
});
