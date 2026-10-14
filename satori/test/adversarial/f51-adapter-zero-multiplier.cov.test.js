// COVERAGE — AUDIT F51: an adapter that reports `multiplier == 0` must earn
// ZERO on the SATORI rail — no phantom floor to 1. The binary path already
// returns 0 for a zero multiplier (SatoriEngine `if (multiplier == 0) return 0`);
// the adapter path must match, so a 0 multiplier means "won nothing", not "1×".
//
// Witness: the SATORI SCORE reward is credited to `unclaimedRewards` at SETTLE
// time and is now the ONLY credit on this path (the flat first-predictor bonus
// is gone), so the `unclaimedRewards` DELTA across `settlePrediction` IS the
// score reward. A solo predictor (no delegators) does NOT emit `RewardSplit` —
// that event fires only when a delegator share is split off — so the balance
// delta, not the event, is the reliable witness here.
//
// SUPERSEDED IN PART by the mint-eligibility rule: only the built-in binary
// game (gameTypeId 0) earns SATORI from the mint, so an adapter game cannot be
// voted for, holds no weight, and draws a ZERO round allocation. Its SATORI
// rail therefore credits nothing whatever multiplier the adapter reports —
// which makes the F51 property hold a fortiori, but also makes it unobservable
// from here: the `effMul = multiplier == 0 ? 1 : multiplier` mutant no longer
// changes any number on this path, because the pool it would scale is zero.
// The contrast below is kept and inverted (both mocks credit zero) so the
// stronger, currently-load-bearing fact is pinned: an adapter game accrues
// NOTHING from the mint, however its adapter scores it.

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture, VOTE } = require("../fixtures");

const ROUND = 86400;
// 2880-minute (two-round) host stream: writes must be >= 2 rounds AND >= 171000s apart. This
// helper is used ONLY between the two host setValues, so it advances TWO rounds
// (2*86400 = 172800s >= 171000s) to satisfy the setValue rhythm. Scoring keys on
// round advance (currentRound > predictRound), so the extra round is inert.
async function advanceRound() { await time.increase(2 * ROUND); }
function packAcc(acc) { return ethers.hexlify(new Uint8Array([Number(acc) & 0xff])); }

// Deploy `contractName` as an adapter, register it, create one game on `streamId`.
async function registerAndCreate(fix, streamId, contractName, label) {
  const { satori, owner, games } = fix;
  const Mock = await ethers.getContractFactory(contractName);
  const mock = await Mock.deploy(await satori.getAddress());
  await mock.waitForDeployment();

  const regRcpt = await (
    await satori.connect(owner).registerGameAdapter(await mock.getAddress(), label)
  ).wait();
  let gameTypeId;
  for (const log of regRcpt.logs) {
    try {
      const p = games.interface.parseLog(log);
      if (p && p.name === "GameAdapterRegistered") { gameTypeId = Number(p.args.gameTypeId); break; }
    } catch (e) {}
  }
  if (gameTypeId === undefined) throw new Error("GameAdapterRegistered event missing");

  const crRcpt = await (
    await satori.connect(owner).createGame(streamId, gameTypeId, "0x", label)
  ).wait();
  for (const log of crRcpt.logs) {
    try {
      const p = games.interface.parseLog(log);
      if (p && p.name === "GameCreated") return { gameId: Number(p.args.gameId), mock };
    } catch (e) {}
  }
  throw new Error("GameCreated event missing");
}

describe("COV F51 — adapter multiplier 0 earns 0 SATORI (no phantom floor)", function () {
  this.timeout(300000);

  // One eligible (voted) adapter game, one funded predictor (accuracy 5), one
  // round elapsed — settle-ready. Identical wiring for both mocks; the ONLY
  // difference is the multiplier the adapter reports at score time.
  async function setup(contractName, label) {
    const fix = await loadFixture(deploySatoriFixture);
    const { satori, registry, rewards, owner, signers } = fix;
    const [, user, , , provider] = signers;

    // Stream id 1 is the protocol DEFAULT stream (created by the fixture), so
    // the stream this test creates is id 2 — captured from the event rather
    // than hardcoded.
    const crTx = await satori.connect(owner)["createSimpleDataStream(string,address,uint24)"]("S", provider.address, 2880);
    const streamId = Number(
      satori.interface.parseLog(
        (await crTx.wait()).logs.find((l) => {
          try { return satori.interface.parseLog(l)?.name === "DataStreamCreated"; } catch (e) { return false; }
        })
      ).args.streamId
    );

    const { gameId, mock } = await registerAndCreate(fix, streamId, contractName, label);
    // The adapter game CANNOT be given weight: `vote` refuses it outright, so
    // its round allocation — the pool every credit below is a fraction of — is
    // zero by construction. Asserted here so the zeros further down are known
    // to come from the mint boundary and not from some silent mis-wiring.
    await expect(satori.connect(owner).vote(gameId, VOTE))
      .to.be.revertedWithCustomError(fix.voting, "GameNotMintEligible");
    expect(await fix.voting.weightOf(gameId)).to.equal(0n);
    await satori.transfer(user.address, ethers.parseEther("10")); // prediction power

    // setValue lands the anchor value. (Nothing arms a denominator for this
    // game: `recordGameVotesForRound` returns early on zero weight.)
    await registry.connect(provider).setValue(streamId, 100);
    await satori.connect(user).predictMultipleWithPayloads([{ gameId, payload: packAcc(5) }]);
    await advanceRound();
    await registry.connect(provider).setValue(streamId, 200);    // anchor a post-round value
    return { satori, rewards, user, gameId, mock };
  }

  // The score reward is exactly the change in unclaimedRewards across settle.
  async function scoreRewardAtSettle({ satori, rewards, user, gameId }) {
    const before = await rewards.unclaimedRewards(user.address);
    await satori.settlePrediction(user.address, gameId);
    const after = await rewards.unclaimedRewards(user.address);
    return after - before;
  }

  it("multiplier 0: a WINNING adapter bet credits ZERO score reward at settle", async function () {
    const ctx = await setup("ZeroMultiplierGame", "zm");
    expect(await scoreRewardAtSettle(ctx)).to.equal(0n);
  });

  it("multiplier 1: the SAME wiring also credits ZERO — an adapter game's pool is zero, so no multiplier can earn from it", async function () {
    const ctx = await setup("PartialCreditGame", "pc");
    expect(await ctx.mock.pendingRound(ctx.gameId, ctx.user.address)).to.be.gt(0n); // armed
    expect(await scoreRewardAtSettle(ctx)).to.equal(0n);
    // Not a stalled settle: the adapter consumed the bet, so the zero is the
    // resolved answer and not "not scored yet".
    expect(await ctx.mock.pendingRound(ctx.gameId, ctx.user.address)).to.equal(0n);
  });
});
