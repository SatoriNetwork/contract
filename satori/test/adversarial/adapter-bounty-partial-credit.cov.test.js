// COVERAGE — CAPABILITY B7: partial-credit accuracy weights the bounty by
// ACCURACY × STAKE (not stake alone). Using a PartialCreditGame adapter whose
// `userScore` is the raw per-user accuracy (1..255), two users stake EQUAL
// amounts but predict with accuracy 3 vs 1. Their bounty payouts must split
// 3:1 (accuracy-weighted), NOT 1:1 (a pure stake split).
//
// Mutant this KILLS: changing creditAdapterBounty's numerator from
// `userScore × stake` to just `stake` collapses the split to 1:1 (equal stakes),
// failing the ~3× assertion.

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture, ensureAdapterBountyToken } = require("../fixtures");

const ROUND = 86400;
async function advanceRound() { await time.increase(ROUND); }

// Pack a single accuracy byte (1..255) as the adapter payload.
function packAcc(acc) {
  return ethers.hexlify(new Uint8Array([Number(acc) & 0xff]));
}

async function deployToken(sym) {
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
async function fundBounty(bounties, funder, gameId, token, amount, rate) {
  await token.mint(funder.address, amount);
  await token.connect(funder).approve(await bounties.getAddress(), amount);
  await ensureAdapterBountyToken(bounties, gameId, token);
  await bounties.connect(funder).fundBounty(gameId, await token.getAddress(), amount, rate);
}

// Register a PartialCreditGame adapter against the fixture and create one game
// on `streamId`. Returns the new gameId.
async function deployRegisterAndCreatePartialCredit(fix, streamId) {
  const { satori, owner, games } = fix;
  const Mock = await ethers.getContractFactory("PartialCreditGame");
  const mock = await Mock.deploy(await satori.getAddress());
  await mock.waitForDeployment();

  const regTx = await satori.connect(owner).registerGameAdapter(await mock.getAddress(), "PartialCredit");
  const regRcpt = await regTx.wait();
  let gameTypeId;
  for (const log of regRcpt.logs) {
    try {
      const parsed = games.interface.parseLog(log);
      if (parsed && parsed.name === "GameAdapterRegistered") { gameTypeId = Number(parsed.args.gameTypeId); break; }
    } catch (e) {}
  }
  if (gameTypeId === undefined) throw new Error("GameAdapterRegistered event missing");

  const cfg = "0x"; // PartialCreditGame.validateForStream accepts any config
  const crTx = await satori.connect(owner).createGame(streamId, gameTypeId, cfg, "pc");
  const crRcpt = await crTx.wait();
  for (const log of crRcpt.logs) {
    try {
      const parsed = games.interface.parseLog(log);
      if (parsed && parsed.name === "GameCreated") return { gameId: Number(parsed.args.gameId), mock };
    } catch (e) {}
  }
  throw new Error("GameCreated event missing");
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

describe("COV adapter-bounty partial-credit — bounty = accuracy × stake (B7)", function () {
  this.timeout(300000);

  const POOL = ethers.parseEther("1000");
  const RATE = ethers.parseEther("1000"); // virgin pool: whole pool drips in one round
  const TOL = ethers.parseEther("0.01");
  const STAKE = ethers.parseEther("100");  // EQUAL stakes — the split must come from accuracy

  it("equal stakes, accuracy 3 vs 1 -> bounty splits ~3:1 (accuracy-weighted, not 1:1)", async function () {
    const fix = await loadFixture(deploySatoriFixture);
    const { satori, registry, rewards, bounties, owner, signers } = fix;
    const [, user1, user2, funder, provider] = signers;

    // The platform fee moved to the immutable token (see test/next/DevFee.test.js)
    // and is no longer part of any bounty/reward split — nothing here reads a
    // rewards fee recipient anymore.
    const streamId = await streamIdFrom(
      await satori.connect(owner)["createSimpleDataStream(string,address,uint24)"]("S", provider.address, 2880),
      satori);
    await registry.connect(provider).setValue(streamId, 100);
    const { gameId } = await deployRegisterAndCreatePartialCredit(fix, streamId);
    // No vote: only the built-in binary game (gameTypeId == 0) is mint-eligible,
    // so `vote` on an adapter game reverts GameNotMintEligible. This test is
    // purely about the BOUNTY rail — funded escrow paid on `userScore × stake`,
    // which PartialCreditGame reads from the payload, never from mint power.

    // Equal SATORI so prediction power is equal (irrelevant to the bounty rail,
    // but keeps the two users symmetric except for accuracy).
    await satori.transfer(user1.address, ethers.parseEther("10"));
    await satori.transfer(user2.address, ethers.parseEther("10"));

    const usd = await deployToken("USDC");
    const usdAddr = await usd.getAddress();
    // Posting a NON-SATORI bounty charges an upfront SATORI burn (bountyBurn) on
    // the funder for the first fund of this (game, token) pair. Give the funder
    // exactly that much SATORI (one first-fund here) so fundBounty can pay it.
    await satori.transfer(funder.address, await satori.bountyBurn());
    await fundBounty(bounties, funder, gameId, usd, POOL, RATE);

    // EQUAL stakes: any payout difference is purely the accuracy weight.
    await stakeFor(bounties, user1, usd, STAKE);
    await stakeFor(bounties, user2, usd, STAKE);

    const predictRound = Number(await satori.getCurrentRound());
    // user1 predicts accuracy 3, user2 predicts accuracy 1.
    await satori.connect(user1).predictMultipleWithPayloads([{ gameId, payload: packAcc(3) }]);
    await satori.connect(user2).predictMultipleWithPayloads([{ gameId, payload: packAcc(1) }]);

    // Cadence-2 stream: the host can only be written every 2 rounds (>= 2 rounds
    // AND >= 84600s of wall-clock). Advance TWO rounds before the second setValue
    // so it clears the cadence rhythm. The mock scores on round advance
    // (currentRound > predictRound), so the extra round does not change outcomes.
    await advanceRound();
    await advanceRound();
    await registry.connect(provider).setValue(streamId, 200); // anchor a post-round value

    await satori.settlePrediction(user1.address, gameId);
    await satori.settlePrediction(user2.address, gameId);

    const u1Earned = (await bounties.bountyStake(user1.address, usdAddr)) - STAKE;
    const u2Earned = (await bounties.bountyStake(user2.address, usdAddr)) - STAKE;

    expect(u1Earned).to.be.gt(0n);
    expect(u2Earned).to.be.gt(0n);

    // ACCURACY-WEIGHTED: 3:1, NOT the 1:1 a pure stake split (equal stakes) gives.
    expect(u1Earned).to.be.closeTo(u2Earned * 3n, TOL);

    // CONSERVATION: every unit of the dripped pot is a predictor share or fee.
    const dripped = await bounties.roundBountyPot(gameId, predictRound, usdAddr);
    expect(dripped).to.equal(RATE);
    const totalCredited = u1Earned + u2Earned;
    expect(totalCredited).to.be.closeTo(dripped, TOL);
    expect(totalCredited).to.be.lte(dripped);
  });
});
