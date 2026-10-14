// One-round STAKE LOCK on the ADAPTER bounty path (cycle-attack fix), mirrored
// from the binary path's BountyUnstakeStakeLocked.test.js but driven through a
// REAL adapter predict so it actually exercises snapshotAdapterStake.
//
// snapshotAdapterStake(user, gameId, round) (SatoriBounties.sol) pins the round's
// single ACTIVE bounty token T, snapshots the caller's stake into
// boostStakeForPrediction, and LOCKS the stake via
//     stakeLockedUntil[user][T] = round + 1
// whenever the game has a live funded token T the user holds stake in.
// unstakeBountyToken then reverts with custom error `StakeLocked` while
// stakeLockedUntil > getCurrentRound(); after round R+1 it succeeds, reduces
// bountyStake, and returns the ERC20 to the recipient.
//
// This proves, on a YesNoGame ADAPTER game (gameTypeId >= 1):
//   - predicting the adapter game in round R sets stakeLockedUntil(user, T) == R+1
//   - unstaking in the SAME round R reverts StakeLocked (cycle attack blocked)
//   - at round R+1 the unstake succeeds, bountyStake drops by the amount, and the
//     underlying ERC20 lands at the recipient
// It is NON-tautological: the lock is set only via the adapter predict path
// (snapshotAdapterStake), not a direct contract poke.

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const {
  deploySatoriFixture,
  deployAndRegisterYesNoGame,
  createYesNoGame,
  pack1,
} = require("../fixtures");

const ROUND = 86400;
const YES = 1;
async function advanceRound() { await time.increase(ROUND); }

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

describe("COV adapter-bounty STAKE LOCK (snapshotAdapterStake one-round lock + unstake gate)", function () {
  this.timeout(300000);

  let fix, satori, registry, rewards, bounties, owner, signers;
  let gameTypeId, gameId, streamId;
  let staker, funder, provider;

  const POOL = ethers.parseEther("1000");
  const RATE = ethers.parseEther("1000");
  const STAKE = ethers.parseEther("100");

  beforeEach(async function () {
    fix = await loadFixture(deploySatoriFixture);
    ({ satori, registry, rewards, bounties, owner, signers } = fix);
    [, staker, funder, provider] = signers;

    // Register the YesNoGame adapter (gameTypeId >= 1) via the admin path.
    ({ gameTypeId } = await deployAndRegisterYesNoGame(fix));

    // A stream + an adapter (YesNo) game on it, threshold 150.
    streamId = await streamIdFrom(
      await satori.connect(owner)["createSimpleDataStream(string,address,uint24)"]("S", provider.address, 2880),
      satori);
    await registry.connect(provider).setValue(streamId, 100); // anchor before predicts
    gameId = await createYesNoGame(satori.connect(owner), gameTypeId, streamId, 150, "yn");

    // No vote: only the built-in binary game (gameTypeId == 0) is mint-eligible,
    // so `vote` on an adapter game reverts GameNotMintEligible. The predict path
    // does not need it — an unvoted game is simply handed predictionPower == 0,
    // and snapshotAdapterStake (the lock under test) runs off the user's STAKE,
    // not off any mint weight.

    // Give the staker SATORI so the prediction is valid.
    await satori.transfer(staker.address, ethers.parseEther("10"));
  });

  it("adapter predict in round R locks stake (stakeLockedUntil==R+1); same-round unstake reverts StakeLocked; at R+1 unstake succeeds, bountyStake drops, ERC20 returned", async function () {
    const usd = await deployToken("USDC");
    const usdAddr = await usd.getAddress();

    // Fund the ADAPTER game's bounty so USDC is the live ACTIVE token, then the
    // staker stakes it. With a live funded token the user holds stake in, the
    // adapter predict's snapshotAdapterStake will fire the lock.
    // Funding a NON-SATORI bounty now charges bountyBurn (in SATORI) on the
    // first fund of a (game, token) pair, so the funder needs that SATORI.
    await satori.transfer(funder.address, await satori.bountyBurn());
    await fundBounty(bounties, funder, gameId, usd, POOL, RATE);
    await stakeFor(bounties, staker, usd, STAKE);

    // Pre-condition: stake recorded, not yet locked.
    expect(await bounties.bountyStake(staker.address, usdAddr)).to.equal(STAKE);
    expect(await bounties.stakeLockedUntil(staker.address, usdAddr)).to.equal(0n);

    // Round R: REAL adapter predict (drives snapshotAdapterStake), which locks.
    const R = await satori.getCurrentRound();
    await satori.connect(staker).predictMultipleWithPayloads([{ gameId, payload: pack1(YES) }]);

    // (2) The stake is locked exactly one round: stakeLockedUntil == R + 1.
    expect(await bounties.stakeLockedUntil(staker.address, usdAddr)).to.equal(R + 1n);

    // (3) Cycle guard: unstaking in the SAME round R reverts StakeLocked.
    await expect(
      bounties.connect(staker).unstakeBountyToken(usdAddr, STAKE, staker.address)
    ).to.be.revertedWithCustomError(bounties, "StakeLocked");

    // (4) Advance to round R+1, then the unstake succeeds.
    await advanceRound();
    expect(await satori.getCurrentRound()).to.equal(R + 1n);

    const stakeBefore = await bounties.bountyStake(staker.address, usdAddr);
    const walletBefore = await usd.balanceOf(staker.address);

    await expect(
      bounties.connect(staker).unstakeBountyToken(usdAddr, STAKE, staker.address)
    ).to.not.be.reverted;

    // bountyStake decreased by the unstaked amount...
    expect(stakeBefore - (await bounties.bountyStake(staker.address, usdAddr))).to.equal(STAKE);
    // ...and the ERC20 was returned to the recipient.
    expect((await usd.balanceOf(staker.address)) - walletBefore).to.equal(STAKE);
  });
});
