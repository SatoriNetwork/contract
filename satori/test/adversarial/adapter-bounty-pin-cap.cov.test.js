// Adapter-bounty MUTATION-KILLING tests for two load-bearing guards in
// SatoriBounties' score/total single-active-token rail (SatoriBounties.sol
// snapshotAdapterStake / _firstFundedToken / creditAdapterBounty):
//
//   M1 — bountyTotal PIN (creditAdapterBounty): the first scorer's bountyTotal is
//        pinned for the whole round; later scorers reuse it and the running paid is
//        capped at it. WITHOUT the pin, a hostile adapter that reports a SMALL
//        bountyTotal on the first scorer (so it takes ~the whole pot) and a LARGE
//        one on a later scorer (so the later scorer draws a SECOND slice against a
//        different denominator) OVER-MINTS (Σ > one pot). The pin forces every
//        scorer onto ONE denominator ⇒ Σ payouts + fee ≤ one dripped pot.
//
//   M3 — active-token FREEZE (snapshotAdapterStake reads the frozen
//        _adapterActiveToken pin): two predictors in the SAME round must resolve
//        the SAME active token even if the author switches the game's bounty
//        token (allowed once the old pool is empty) between their two predicts.
//        The pin keeps predict-time token == score-time token for the whole round.
//
// Both guards are already correct; these tests LOCK them on the immutable contract.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time, impersonateAccount, setBalance } =
  require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture, pack1, ensureAdapterBountyToken } = require("../fixtures");

const ROUND = 86400;
const TOL = ethers.parseEther("0.01");
// Adapter host streams are cadence-2 (create-time gate requires minCadenceRounds
// >= 2 for gameTypeId > 0). A cadence-2 stream can only be written every 2 rounds
// (>= 2 rounds AND >= 2*ROUND - 30min = 84600s wall-clock between setValue writes).
// This helper is used ONLY between the two host setValue writes of a round, so it
// advances TWO rounds to satisfy the cadence rhythm. Scoring is unaffected:
// VaryingBountyGame scores on round advance (cur > predictRound) and YesNoGame on
// getFirstValueAfter(anchor) (first value strictly after the anchor, any gap), and
// the drip is pinned to the prediction round, so payouts/conservation are intact.
async function advanceRound() { await time.increase(2 * ROUND); }

async function gameIdFrom(tx, games) {
  const r = await tx.wait();
  for (const log of r.logs) {
    try { const p = games.interface.parseLog(log); if (p && p.name === "GameCreated") return Number(p.args.gameId); } catch (e) {}
  }
  throw new Error("GameCreated missing");
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
// fundBounty with a VIRGIN pool whose rate == pool ⇒ the whole pool drips in the
// single scored round (so conservation can be checked against exactly the pot).
async function fundBountyOn(satori, bounties, funder, token, gameId, poolEth = "1000", rateEth = "1000") {
  // Non-SATORI bounty posting charges an upfront bountyBurn on the funder; fund
  // it from owner (satori's default signer) before the first fund of the pair.
  await satori.transfer(funder.address, await satori.bountyBurn());
  await token.mint(funder.address, ethers.parseEther("100000"));
  await token.connect(funder).approve(await bounties.getAddress(), ethers.MaxUint256);
  const POOL = ethers.parseEther(poolEth);
  const RATE = ethers.parseEther(rateEth);
  await ensureAdapterBountyToken(bounties, gameId, token);
  await bounties.connect(funder).fundBounty(gameId, await token.getAddress(), POOL, RATE);
  return RATE;
}

// Register an adapter (by contract factory name) at the next gameTypeId, create a
// game on a fresh stream. Returns { gameId, streamId, gameTypeId }.
//
// The game is NOT voted: only the built-in binary game (gameTypeId == 0) is
// mint-eligible, so `vote` on an adapter game reverts GameNotMintEligible. Both
// tests below are bounty tests — the bounty pot is funded escrow that pays on the
// adapter's `userScore` × stake, so it is unaffected by the mint boundary (and
// VaryingBountyGame's userScore is a constant ACC, not the mint power).
async function setupAdapterGame(fix, factoryName) {
  const { satori, registry, rewards, games, owner } = fix;
  const Adapter = await ethers.getContractFactory(factoryName);
  const adapter = await Adapter.deploy(await satori.getAddress());
  await adapter.waitForDeployment();
  const coreSigner = await impersonateCore(satori);
  await games.connect(coreSigner).registerGameAdapter(await adapter.getAddress(), owner.address, factoryName, false);
  const gameTypeId = Number(await games.nextGameTypeId()) - 1;

  const streamId = await streamIdFrom(
    await satori.connect(owner)["createSimpleDataStream(string,address,uint24)"]("S", owner.address, 2880),
    satori);
  await registry.connect(owner).setValue(streamId, 100);
  const gameId = await gameIdFrom(await satori.connect(owner).createGame(streamId, gameTypeId, "0x", "adp"), games);
  return { gameId, streamId, gameTypeId };
}

// Register a YesNoGame adapter (4-arg core ctor), create a game with the
// given int128 threshold on a fresh stream (again unvoted — see above).
// YesNoGame's bountyTotal is Σ stake
// over the winning direction, so SAME-side stakers genuinely SPLIT the pot by
// stake — required for M3, where BOTH same-round predictors must visibly earn
// from the pinned token (a constant-bountyTotal mock would let the first scorer
// take everything and pay later scorers 0, masking the token a later scorer
// resolved to).
async function setupYesNoGame(fix, threshold = 150) {
  const { satori, registry, rewards, games, owner } = fix;
  const YesNoGame = await ethers.getContractFactory("YesNoGame");
  const yesNo = await YesNoGame.deploy(await fix.engine.getAddress(), await games.getAddress(),
    await registry.getAddress());
  await yesNo.waitForDeployment();
  const coreSigner = await impersonateCore(satori);
  await games.connect(coreSigner).registerGameAdapter(await yesNo.getAddress(), owner.address, "YesNo", false);
  const gameTypeId = Number(await games.nextGameTypeId()) - 1;

  const streamId = await streamIdFrom(
    await satori.connect(owner)["createSimpleDataStream(string,address,uint24)"]("S", owner.address, 2880),
    satori);
  await registry.connect(owner).setValue(streamId, 100);
  const cfg = ethers.AbiCoder.defaultAbiCoder().encode(["int128"], [threshold]);
  const gameId = await gameIdFrom(await satori.connect(owner).createGame(streamId, gameTypeId, cfg, "yn"), games);
  return { gameId, streamId, gameTypeId };
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

describe("adapter-bounty mutation-killing — bountyTotal PIN (M1) + active-token FREEZE (M3)", function () {
  this.timeout(300000);

  it("M1: a call-order-varying bountyTotal (tiny first scorer, different small later) cannot over-mint — the first-scorer PIN caps Σ payouts + fee ≤ one dripped pot", async function () {
    // VaryingBountyGame answers a TINY bountyTotal (== 1) to the FIRST scorer of the
    // round (so per-call they take ~the whole pot) and a DIFFERENT small bountyTotal
    // (== ACC) to LATER scorers — small enough that a PER-CALL impl would let the
    // later scorer draw a SECOND ~full slice against its OWN denominator (room ≈ its
    // bountyTotal), over-minting Σ > one pot. The pin forces every scorer onto the
    // first scorer's denominator (1) and caps the running paid at it, so the first
    // scorer exhausts room == 1 and every later scorer is clamped to 0 ⇒ exactly ONE
    // pot, never N×. WITHOUT the pin (per-call bountyTotal) the sum EXCEEDS one pot.
    const fix = await loadFixture(deploySatoriFixture);
    const { satori, registry, rewards, bounties, signers } = fix;
    const funder = signers[5];

    const { gameId, streamId } = await setupAdapterGame(fix, "VaryingBountyGame");
    const tok = await deployToken();
    const POT = await fundBountyOn(satori, bounties, funder, tok, gameId);
    const tokAddr = await tok.getAddress();

    // TWO stakers; both predict the SAME round. Each one's ACC × stake (5 × 100e18)
    // hugely exceeds the first scorer's reported bountyTotal == 1, so the first
    // scorer's saturating numerator clamps to the whole denominator and takes the
    // pot; the second scorer (different small bountyTotal per-call) is the over-mint
    // vector — neutralized only by the pin.
    const p1 = signers[1], p2 = signers[2];
    const priorStake = {};
    for (const p of [p1, p2]) {
      await satori.transfer(p.address, ethers.parseEther("10"));
      await stakeFor(bounties, p, tok, ethers.parseEther("100"));
      priorStake[p.address] = await bounties.bountyStake(p.address, tokAddr);
    }

    const predictRound = Number(await satori.getCurrentRound());
    // p1 predicts first, p2 second (does not matter for the pin — the pin is on the
    // first SCORER, set at settle order below).
    await satori.connect(p1).predictMultipleWithPayloads([{ gameId, payload: pack1(1) }]);
    await satori.connect(p2).predictMultipleWithPayloads([{ gameId, payload: pack1(1) }]);

    await advanceRound();
    await registry.connect(fix.owner).setValue(streamId, 200);

    // Settle p1 first (tiny bountyTotal pins == 1), then p2 (huge per-call total) —
    // the exact order that triggers small-then-large.
    await satori.settlePrediction(p1.address, gameId);
    await satori.settlePrediction(p2.address, gameId);

    const earn1 = (await bounties.bountyStake(p1.address, tokAddr)) - priorStake[p1.address];
    const earn2 = (await bounties.bountyStake(p2.address, tokAddr)) - priorStake[p2.address];

    const dripped = await bounties.roundBountyPot(gameId, predictRound, tokAddr);
    expect(dripped).to.equal(POT); // virgin pool: whole pool drips this round

    // CONSERVATION under the pin: the SUM of everything credited to predictors is at
    // most ONE dripped pot. Without the pin the second scorer's huge-denominator draw
    // would push this OVER the pot.
    const totalCredited = earn1 + earn2;
    expect(totalCredited).to.be.lte(dripped + TOL);
    // And it is meaningful (not a trivial zero): the first scorer actually took the
    // pot (its ACC × stake saturated to the pinned denominator).
    expect(earn1).to.be.gt(0n);
  });

  it("M3: the author switching the bounty token mid-round does not change the round's active token — both same-round predictors resolve the FROZEN pinned token A", async function () {
    const YES = 1;
    const fix = await loadFixture(deploySatoriFixture);
    const { satori, registry, bounties, owner, signers } = fix;
    const funder = signers[5];

    const { gameId, streamId } = await setupYesNoGame(fix, 150);

    const A = await deployToken("AAA");
    const B = await deployToken("BBB");
    const Aaddr = await A.getAddress(), Baddr = await B.getAddress();

    // Virgin pool with rate == pool: the round's first stake reserves all of A,
    // leaving its pool empty so the author may switch to B before the round ends.
    await fundBountyOn(satori, bounties, funder, A, gameId);

    const p1 = signers[1], p2 = signers[2];
    for (const p of [p1, p2]) await satori.transfer(p.address, ethers.parseEther("10"));
    await stakeFor(bounties, p1, A, ethers.parseEther("100"));
    await stakeFor(bounties, p2, A, ethers.parseEther("100"));
    await stakeFor(bounties, p2, B, ethers.parseEther("100"));

    const roundR = Number(await satori.getCurrentRound());
    await satori.connect(p1).predictMultipleWithPayloads([{ gameId, payload: pack1(YES) }]);
    expect(await bounties.pool(gameId, Aaddr)).to.equal(0n);

    await fundBountyOn(satori, bounties, funder, B, gameId);
    expect(await bounties.adapterBountyToken(gameId)).to.equal(Baddr);

    await satori.connect(p2).predictMultipleWithPayloads([{ gameId, payload: pack1(YES) }]);
    expect(await bounties.adapterActiveToken(gameId, roundR)).to.equal(Aaddr);

    await advanceRound();
    await registry.connect(owner).setValue(streamId, 250);

    const a1Before = await bounties.bountyStake(p1.address, Aaddr);
    const a2Before = await bounties.bountyStake(p2.address, Aaddr);
    const b2Before = await bounties.bountyStake(p2.address, Baddr);

    await satori.settlePrediction(p1.address, gameId);
    await satori.settlePrediction(p2.address, gameId);

    const earnA1 = (await bounties.bountyStake(p1.address, Aaddr)) - a1Before;
    const earnA2 = (await bounties.bountyStake(p2.address, Aaddr)) - a2Before;
    const earnB2 = (await bounties.bountyStake(p2.address, Baddr)) - b2Before;

    expect(earnA1).to.be.gt(0n);
    expect(earnA2).to.be.gt(0n);
    expect(earnB2).to.equal(0n);

    const drippedA = await bounties.roundBountyPot(gameId, roundR, Aaddr);
    expect(drippedA).to.be.gt(0n);
    expect(earnA1 + earnA2).to.be.lte(drippedA + TOL);
    expect(await bounties.roundBountyPot(gameId, roundR, Baddr)).to.equal(0n);
  });
});
