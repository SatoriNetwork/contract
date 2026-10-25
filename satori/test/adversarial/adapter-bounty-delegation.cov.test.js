// COVERAGE — GAP D7 + B11-delegation: an adapter's BOUNTY is paid to the
// PREDICTOR only and is NEVER shared with delegators (it does not flow through
// the SATORI delegation split `_splitReward`).
//
// MINT BOUNDARY: only the built-in binary game (gameTypeId == 0) earns SATORI
// from the mint, so an adapter game can never hold voting weight and its bets
// are recorded with predictionPower == 0 — there is no SATORI slice for the
// delegation split to divide in the first place. The bounty rail is untouched
// by that boundary: bounty pools are separately funded escrow in an arbitrary
// ERC20, paid on `userScore` × stake, so an adapter game is bountied exactly as
// before. The contrast this test draws is therefore sharper than it was: the
// delegator earns NEITHER rail, while the predictor takes the whole pot.
//
// Scenario on a YesNoGame adapter with a funded bounty token:
//   - DELEGATE stakes the bounty token and predicts the WINNING side.
//   - DELEGATOR delegates SATORI power to the delegate and stakes NOTHING.
//   - Advance + settle.
// Asserts:
//   (a) the delegator's claim drains ZERO SATORI, and the predictor's own mint
//       bucket is zero too — the adapter game accrues nothing from the mint;
//   (b) the delegator's bounty balance in the token is ZERO and there is
//       nothing to withdraw;
//   (c) the DELEGATE's bountyStake increased by the net-of-fee pot (the
//       predictor took the WHOLE bounty);
//   (d) conservation: delegate gain + fee bucket ≈ one dripped pot.
//
// Mutant this KILLS: if creditAdapterBounty paid the delegator too (or routed
// the bounty through _splitReward), the delegator's bountyStake would be > 0
// and the delegate's gain would be short of the full net-of-fee pot.

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
async function advanceRound() { await time.increase(ROUND); }

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
async function fundBounty(satori, bounties, funder, gameId, token, amount, rate) {
  // Posting a non-SATORI bounty charges an upfront bountyBurn in SATORI on the
  // funder (first fund of the pair). Fund it from owner (satori's default signer).
  await satori.transfer(funder.address, await satori.bountyBurn());
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

describe("COV adapter-bounty delegation — bounty stays with the predictor (D7/B11)", function () {
  this.timeout(300000);

  const POOL = ethers.parseEther("1000");
  const RATE = ethers.parseEther("1000"); // virgin pool: whole pool drips in one round
  const TOL = ethers.parseEther("0.0001");

  it("delegator earns ZERO bounty AND zero SATORI (adapter is not mint-eligible); delegate takes the whole net-of-fee bounty pot", async function () {
    const fix = await loadFixture(deploySatoriFixture);
    const { satori, registry, rewards, bounties, owner, signers } = fix;
    const [, delegate, delegator, funder, provider] = signers;

    const { gameTypeId } = await deployAndRegisterYesNoGame(fix);
    const streamId = await streamIdFrom(
      await satori.connect(owner)["createSimpleDataStream(string,address,uint24)"]("S", provider.address, 2880),
      satori);
    await registry.connect(provider).setValue(streamId, 100);
    const gameId = await createYesNoGame(satori.connect(owner), gameTypeId, streamId, 150, "yn");
    // No vote: only the built-in binary game (gameTypeId == 0) is mint-eligible,
    // so `vote` on an adapter game reverts GameNotMintEligible. Nothing here
    // needs it — the bounty rail is funded escrow and pays on every game type.

    // Equal SATORI balances so the delegated portion is a clean 1/2.
    await satori.transfer(delegate.address, ethers.parseEther("10"));
    await satori.transfer(delegator.address, ethers.parseEther("10"));

    // Delegator delegates SATORI prediction power to the delegate and stakes
    // NOTHING in the bounty token.
    await satori.connect(delegator).delegatePredictionPower(delegate.address);

    // Fund the bounty and have ONLY the delegate stake it.
    const usd = await deployToken("USDC");
    const usdAddr = await usd.getAddress();
    await fundBounty(satori, bounties, funder, gameId, usd, POOL, RATE);
    const STAKE = ethers.parseEther("300");
    await stakeFor(bounties, delegate, usd, STAKE);

    const predictRound = Number(await satori.getCurrentRound());
    await satori.connect(delegate).predictMultipleWithPayloads([{ gameId, payload: pack1(YES) }]);

    // Cadence-2 host: the two setValue writes must be >= 2 rounds apart, so
    // advance twice before the second write (>= 84600s wall-clock too).
    await advanceRound();
    await advanceRound();
    await registry.connect(provider).setValue(streamId, 200); // 200 > 150 -> YES wins

    await satori.settlePrediction(delegate.address, gameId);

    // (c) Delegate took the WHOLE bounty pot (auto-restaked). There is no
    //     payout fee — the winner takes the full share.
    const delegateEarned = (await bounties.bountyStake(delegate.address, usdAddr)) - STAKE;
    expect(delegateEarned).to.be.gt(0n);

    // (b) Delegator earned ZERO bounty — they staked nothing and the bounty
    //     never flows through the delegation split.
    expect(await bounties.bountyStake(delegator.address, usdAddr)).to.equal(0n);

    // (d) Conservation: delegate's gain ≈ exactly one dripped pot.
    const dripped = await bounties.roundBountyPot(gameId, predictRound, usdAddr);
    expect(dripped).to.equal(RATE);
    expect(delegateEarned).to.be.closeTo(dripped, TOL);
    expect(delegateEarned).to.be.lte(dripped);

    // (a) INVERTED (was: "the delegator earns a positive SATORI slice"). The
    //     adapter game is not mint-eligible, so the delegate's bet was recorded
    //     with predictionPower == 0 and no SATORI was ever minted for it — the
    //     delegation split has nothing to share. Check the PREDICTOR's own mint
    //     bucket first (eager credit writes it at settle time), then the
    //     delegator's claim drain. Neither is a stalled no-op: (c)/(d) above
    //     prove the very same settle paid out the whole bounty pot.
    expect(await rewards.unclaimedRewards(delegate.address)).to.equal(0n);
    const delBalBefore = await satori.balanceOf(delegator.address);
    await satori.connect(delegator)["claim()"]();
    const delSatoriGain = (await satori.balanceOf(delegator.address)) - delBalBefore;
    expect(delSatoriGain).to.equal(0n);
  });
});
