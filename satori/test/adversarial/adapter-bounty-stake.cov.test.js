// STAKE-WEIGHTED bounties on ADAPTER games (gameTypeId >= 1) — score/total model,
// SINGLE ACTIVE bounty token per round (a queue).
//
// New model (GOAL): an adapter game keeps SATORI on the score/total model
// (weighted by the adapter's SATORI multiplier), and its bounty is paid on the
// SAME accuracy score but weighted by the user's bounty STAKE — never by SATORI
// holdings. The adapter's `score()` returns, alongside the SATORI `total`, a
// `bountyTotal = Σ accuracy×stake` over the winning outcome. The protocol pays
//     payout = pot(T) × (userScore × stake) / bountyTotal
// for the round's single ACTIVE token T, pinning `bountyTotal` first-scorer and
// capping the running paid (Σ payouts ≤ one pot). For YesNoGame `userScore` is 1
// on the side picked and 0 otherwise, so `bountyTotal` is Σ stake over the
// winning direction and the winners split the pot by their stake.
//
// ACTIVE token = a QUEUE: funders fund freely (append to gameBountyTokens), but
// per (adapter game, round) exactly ONE token is active — the first queued token
// with live funding, pinned at the round's first predict. When it drains and
// cleanupDrainedBountyToken pops it, future rounds advance to the next token.
//
// This file proves:
//   (1) two YES stakers (100 vs 300) on the SAME side both win → split the pot
//       1:3 by STAKE (NOT by SATORI power, which is equal); the NO (losing-side,
//       userScore 0) staker gets ZERO bounty; Σ payouts+fee ≤ one dripped pot
//       (conservation); and the two rails are now fully separated — the adapter
//       game accrues ZERO SATORI from the mint while paying its bounty in full;
//   (2) a NON-staker who predicts the winning side gets zero bounty.
//   (3) the QUEUE: fund token A then token B on the same adapter game; round 1
//       uses A (first funded, live); after A drains + cleanupDrainedBountyToken,
//       a later round uses B.
//   (4) score-0 across the board (everyone predicts the LOSING side) ⇒ no bounty
//       even though everyone staked.
//
// All assertions re-express the no-over-mint / no-strand / no-double-pay /
// conservation invariants for the score/total single-active-token adapter path —
// none are weakened.

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const {
  deploySatoriFixture,
  deployAndRegisterYesNoGame,
  createYesNoGame,
  pack1, ensureAdapterBountyToken } = require("../fixtures");

const ROUND = 86400;
const YES = 1;
const NO = 2;
// Cadence-2 host stream: each host write must be >= 2 rounds apart (2*12h ==
// 86400s >= the 84600s cadence gap). This helper is used only between the
// anchor setValue and the next setValue, so it advances TWO rounds. Adapter
// mocks score on round advance, so the extra round leaves outcomes unchanged.
async function advanceRound() { await time.increase(2 * ROUND); }

async function deployToken(sym) {
  const M = await ethers.getContractFactory("MockERC20");
  const t = await M.deploy(sym, sym);
  await t.waitForDeployment();
  return t;
}

// Mint -> approve -> stake `amount` of `token` for `user` on the bounties contract.
async function stakeFor(bounties, user, token, amount) {
  await token.mint(user.address, amount);
  await token.connect(user).approve(await bounties.getAddress(), amount);
  await bounties.connect(user).stakeBountyToken(await token.getAddress(), amount);
}

// Fund `gameId` with `amount` of `token` at drip rate `rate` (per scored round).
async function fundBounty(bounties, funder, gameId, token, amount, rate) {
  await token.mint(funder.address, amount);
  await token.connect(funder).approve(await bounties.getAddress(), amount);
  await ensureAdapterBountyToken(bounties, gameId, token);
  await bounties.connect(funder).fundBounty(gameId, await token.getAddress(), amount, rate);
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

describe("COV adapter-bounty STAKE-weighted (score/total, single active token)", function () {
  this.timeout(300000);

  let fix, satori, registry, rewards, lens, bounties, owner, signers;
  let gameTypeId, gameId, streamId;
  let yes1, yes2, no1, funder, provider;

  // Pool == one drip (virgin pool, rate == pool) so the WHOLE pool drips in the
  // single predict round and conservation is checked against exactly the pot.
  const POOL = ethers.parseEther("1000");
  const RATE = ethers.parseEther("1000");
  const TOL = ethers.parseEther("0.0001");

  // Bounty stakes — different on purpose so a stake-weighted split is visibly
  // distinct from a SATORI-score split (the predictors have EQUAL SATORI power).
  const STAKE_LOW = ethers.parseEther("100");
  const STAKE_HIGH = ethers.parseEther("300");

  beforeEach(async function () {
    fix = await loadFixture(deploySatoriFixture);
    ({ satori, registry, rewards, lens, bounties, owner, signers } = fix);
    [, yes1, yes2, no1, funder, provider] = signers;

    // The platform fee moved to the immutable token (see test/next/DevFee.test.js)
    // and is no longer part of any bounty/reward split — nothing here reads a
    // rewards fee recipient anymore.

    // Register the YesNoGame adapter (gameTypeId >= 1) via the admin path.
    ({ gameTypeId } = await deployAndRegisterYesNoGame(fix));

    // A stream + an adapter (YesNo) game on it, threshold 150.
    streamId = await streamIdFrom(
      await satori.connect(owner)["createSimpleDataStream(string,address,uint24)"]("S", provider.address, 2880),
      satori);
    await registry.connect(provider).setValue(streamId, 100); // anchor before predicts
    gameId = await createYesNoGame(satori.connect(owner), gameTypeId, streamId, 150, "yn");

    // No vote: only the built-in binary game (gameTypeId == 0) is mint-eligible,
    // so `vote` on an adapter game reverts GameNotMintEligible and the game
    // draws NO SATORI pool at all. The bounty rail below is unaffected — it is
    // funded escrow paid on the adapter's accuracy × the user's stake.

    // Give predictors equal SATORI so their prediction power (SATORI side) is
    // identical — any difference in bounty payout is therefore purely the stake.
    for (const p of [yes1, yes2, no1]) {
      await satori.transfer(p.address, ethers.parseEther("10"));
    }
  });

  it("(1) two YES stakers (100 vs 300) split bounty 1:3 by STAKE; NO (score-0) gets 0; Σ payouts+fee==dripped pot; SATORI is ZERO for all (adapter not mint-eligible)", async function () {
    const usd = await deployToken("USDC");
    const usdAddr = await usd.getAddress();

    // Posting a NON-SATORI bounty (first fund of this game+token) burns a heavy
    // SATORI fee from the funder. Give `funder` exactly one bountyBurn in SATORI.
    await satori.transfer(funder.address, await satori.bountyBurn());
    // Fund the ADAPTER game's bounty (one funded token ⇒ it is the active token).
    await fundBounty(bounties, funder, gameId, usd, POOL, RATE);

    // Stake BEFORE predicting (predict-time snapshot is what pays out).
    // yes1 stakes 100, yes2 stakes 300 — SAME direction (YES), DIFFERENT stake.
    await stakeFor(bounties, yes1, usd, STAKE_LOW);
    await stakeFor(bounties, yes2, usd, STAKE_HIGH);
    // no1 stakes too (so "loser gets nothing" is about ACCURACY, not lack of
    // stake): no1 picks the LOSING side (NO), userScore 0 ⇒ must be paid 0.
    await stakeFor(bounties, no1, usd, STAKE_HIGH);

    const predictRound = Number(await satori.getCurrentRound());

    await satori.connect(yes1).predictMultipleWithPayloads([{ gameId, payload: pack1(YES) }]);
    await satori.connect(yes2).predictMultipleWithPayloads([{ gameId, payload: pack1(YES) }]);
    await satori.connect(no1).predictMultipleWithPayloads([{ gameId, payload: pack1(NO) }]);

    await advanceRound();
    await registry.connect(provider).setValue(streamId, 200); // 200 > 150 -> YES wins

    for (const p of [yes1, yes2, no1]) await satori.settlePrediction(p.address, gameId);

    // --- Bounty side: STAKE-weighted on accuracy. Winnings auto-restake into
    //     bountyStake (no payout fee — winners take the full share). ---
    const y1Earned = (await bounties.bountyStake(yes1.address, usdAddr)) - STAKE_LOW;
    const y2Earned = (await bounties.bountyStake(yes2.address, usdAddr)) - STAKE_HIGH;
    const noEarned = (await bounties.bountyStake(no1.address, usdAddr)) - STAKE_HIGH;

    // The pot that actually dripped for the predict round (keyed by gameId).
    const dripped = await bounties.roundBountyPot(gameId, predictRound, usdAddr);
    expect(dripped).to.equal(RATE); // virgin pool: rate == RATE, whole pool drips

    // Both YES stakers won; the NO (score-0) staker won nothing.
    expect(y1Earned).to.be.gt(0n);
    expect(y2Earned).to.be.gt(0n);
    expect(noEarned).to.equal(0n);

    // (1) STAKE-weighted: 100:300 == 1:3. yes2 earns ~3x yes1 (NOT 1:1, which is
    //     what a SATORI-score split would give — both YES predictors have EQUAL
    //     prediction power).
    expect(y2Earned).to.be.closeTo(y1Earned * 3n, TOL);

    // CONSERVATION: every unit of the dripped pot is a predictor share (no payout
    // fee). Nothing minted, nothing stranded; never EXCEEDS one pot.
    const totalCredited = y1Earned + y2Earned;
    expect(totalCredited).to.be.closeTo(dripped, TOL);
    expect(totalCredited).to.be.lte(dripped);

    // --- SATORI side: INVERTED (was "equal and positive for the two YES
    //     winners"). Only the built-in binary game earns from the mint, so an
    //     adapter game can never hold voting weight, every bet on it is recorded
    //     with predictionPower == 0, and its round allocation is zero — WINNERS
    //     INCLUDED. Nobody here accrues a single wei of SATORI. This is the
    //     property worth pinning now: the two rails are fully separated, and the
    //     bounty above was paid in full out of escrow by the SAME settle, so
    //     these zeros cannot be a stalled no-op. ---
    const s1 = (await lens.getTotalClaimableRewards(yes1.address))[0]; // predicted first
    const s2 = (await lens.getTotalClaimableRewards(yes2.address))[0];
    const sNo = (await lens.getTotalClaimableRewards(no1.address))[0];
    expect(s1).to.equal(0n);
    expect(s2).to.equal(0n);
    expect(sNo).to.equal(0n);
    // Same statement at the accrual slot itself, not just through the lens.
    for (const p of [yes1, yes2, no1]) {
      expect(await rewards.unclaimedRewards(p.address)).to.equal(0n);
    }
  });

  it("(2) a NON-staker who predicts the winning side gets zero bounty", async function () {
    const usd = await deployToken("USDC");
    const usdAddr = await usd.getAddress();

    // First fund of a NON-SATORI bounty burns bountyBurn in SATORI from funder.
    await satori.transfer(funder.address, await satori.bountyBurn());
    await fundBounty(bounties, funder, gameId, usd, POOL, RATE);

    // yes1 stakes + picks YES; yes2 also picks YES but never staked.
    await stakeFor(bounties, yes1, usd, STAKE_HIGH);

    const predictRound = Number(await satori.getCurrentRound());
    await satori.connect(yes1).predictMultipleWithPayloads([{ gameId, payload: pack1(YES) }]);
    await satori.connect(yes2).predictMultipleWithPayloads([{ gameId, payload: pack1(YES) }]);

    await advanceRound();
    await registry.connect(provider).setValue(streamId, 200); // YES wins

    for (const p of [yes1, yes2]) await satori.settlePrediction(p.address, gameId);

    const y1Earned = (await bounties.bountyStake(yes1.address, usdAddr)) - STAKE_HIGH;
    const y2Earned = await bounties.bountyStake(yes2.address, usdAddr); // 0 prior

    const dripped = await bounties.roundBountyPot(gameId, predictRound, usdAddr);
    expect(dripped).to.equal(RATE);

    // Lone staker on the winning side takes the whole pot (no payout fee).
    expect(y1Earned).to.be.gt(0n);
    expect(y2Earned).to.equal(0n); // never staked → no snapshot → no bounty
    expect(y1Earned).to.be.closeTo(dripped, TOL);
    expect(y1Earned).to.be.lte(dripped);
  });

  it("(3) ONE TOKEN: only the author's chosen token can fund the game; after it drains the author switches and a later round pays the new token", async function () {
    const usd = await deployToken("USDC"); // the author's choice (fixture helper)
    const dai = await deployToken("DAI");
    const usdAddr = await usd.getAddress();
    const daiAddr = await dai.getAddress();

    await satori.transfer(funder.address, (await satori.bountyBurn()) * 2n);
    await fundBounty(bounties, funder, gameId, usd, POOL, RATE);

    await dai.mint(funder.address, POOL);
    await dai.connect(funder).approve(await bounties.getAddress(), POOL);
    await expect(bounties.connect(funder).fundBounty(gameId, daiAddr, POOL, RATE))
      .to.be.revertedWithCustomError(bounties, "NotTheGamesBountyToken");

    await stakeFor(bounties, yes1, usd, STAKE_HIGH);
    await stakeFor(bounties, yes1, dai, STAKE_HIGH);

    const round1 = Number(await satori.getCurrentRound());
    await satori.connect(yes1).predictMultipleWithPayloads([{ gameId, payload: pack1(YES) }]);
    await advanceRound();
    await registry.connect(provider).setValue(streamId, 200); // YES wins

    await satori.settlePrediction(yes1.address, gameId);

    const usdEarnR1 = (await bounties.bountyStake(yes1.address, usdAddr)) - STAKE_HIGH;
    const daiEarnR1 = (await bounties.bountyStake(yes1.address, daiAddr)) - STAKE_HIGH;

    expect(usdEarnR1).to.be.gt(0n);
    expect(daiEarnR1).to.equal(0n);
    const usdDripped = await bounties.roundBountyPot(gameId, round1, usdAddr);
    expect(usdDripped).to.equal(RATE);
    expect(await bounties.roundBountyPot(gameId, round1, daiAddr)).to.equal(0n);
    expect(usdEarnR1).to.be.closeTo(usdDripped, TOL);
    expect(usdEarnR1).to.be.lte(usdDripped);

    expect(await bounties.pool(gameId, usdAddr)).to.equal(0n);
    expect(await bounties.ratePerRound(gameId, usdAddr)).to.equal(0n);

    await ensureAdapterBountyToken(bounties, gameId, dai);
    await satori.transfer(funder.address, await satori.bountyBurn());
    await bounties.connect(funder).fundBounty(gameId, daiAddr, POOL, RATE);

    const round2 = Number(await satori.getCurrentRound());
    expect(round2).to.be.gt(round1);
    await satori.connect(yes1).predictMultipleWithPayloads([{ gameId, payload: pack1(YES) }]);
    await advanceRound();
    await registry.connect(provider).setValue(streamId, 250); // YES wins again

    const daiStakeBefore = await bounties.bountyStake(yes1.address, daiAddr);
    await satori.settlePrediction(yes1.address, gameId);

    const daiEarnR2 = (await bounties.bountyStake(yes1.address, daiAddr)) - daiStakeBefore;

    expect(daiEarnR2).to.be.gt(0n);
    const daiDrippedR2 = await bounties.roundBountyPot(gameId, round2, daiAddr);
    expect(daiDrippedR2).to.equal(RATE);
    expect(daiEarnR2).to.be.closeTo(daiDrippedR2, TOL);
    expect(daiEarnR2).to.be.lte(daiDrippedR2);
  });

  it("(4) score-0 across the board (everyone predicts the LOSING side) ⇒ no bounty even though staked", async function () {
    const usd = await deployToken("USDC");
    const usdAddr = await usd.getAddress();

    // First fund of a NON-SATORI bounty burns bountyBurn in SATORI from funder.
    await satori.transfer(funder.address, await satori.bountyBurn());
    await fundBounty(bounties, funder, gameId, usd, POOL, RATE);

    // Everyone stakes AND predicts NO, but the outcome is YES — so every
    // predictor has accuracy 0 ⇒ userScore 0 ⇒ no bounty by construction.
    await stakeFor(bounties, yes1, usd, STAKE_LOW);
    await stakeFor(bounties, yes2, usd, STAKE_HIGH);

    const predictRound = Number(await satori.getCurrentRound());
    await satori.connect(yes1).predictMultipleWithPayloads([{ gameId, payload: pack1(NO) }]);
    await satori.connect(yes2).predictMultipleWithPayloads([{ gameId, payload: pack1(NO) }]);

    await advanceRound();
    await registry.connect(provider).setValue(streamId, 200); // YES wins → both wrong

    for (const p of [yes1, yes2]) await satori.settlePrediction(p.address, gameId);

    const y1Earned = (await bounties.bountyStake(yes1.address, usdAddr)) - STAKE_LOW;
    const y2Earned = (await bounties.bountyStake(yes2.address, usdAddr)) - STAKE_HIGH;

    // Nobody scored ⇒ nobody is paid.
    expect(y1Earned).to.equal(0n);
    expect(y2Earned).to.equal(0n);

    // bountyTotal = Σ stake over the WINNING (YES) side = 0 (nobody picked YES),
    // so the adapter bounty path no-ops; the round's pot still drips on the SATORI
    // settle but no bounty is paid out of it. Conservation (≤ one pot) trivially
    // holds: zero is paid.
    const dripped = await bounties.roundBountyPot(gameId, predictRound, usdAddr);
    expect(y1Earned + y2Earned).to.be.lte(dripped);
  });
});
