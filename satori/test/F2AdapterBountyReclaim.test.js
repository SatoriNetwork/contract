// F2 (audit 2026-07) — adapter-game bounty payouts must be recorded in
// roundBountyPotClaimed, or reclaimStrandedPot double-spends the pot.
//
// The BINARY payout rail (_accrueBountyForWinToken) bumps roundBountyPotClaimed
// per paid winner. The ADAPTER rail (_accrueAdapterBounty) credited the winner's
// withdrawable bountyStake but never bumped claimed. So after adapter winners
// were paid, claimed stayed 0, and the permissionless reclaimStrandedPot swept
// the ENTIRE already-paid pot back into pool — double-counting tokens that are
// simultaneously owed as bountyStake, breaking the solvency invariant
//   contractBalance(token) >= Σ bountyStake + Σ pool + Σ (pot − claimed).
//
// This test funds a bounty on a YesNoGame adapter game, gives it two equal
// boosted winners, settles only one (so a genuine stranded remainder exists),
// then evicts and reclaims — asserting the settled winner's payout is recorded
// in `claimed` and that the subsystem stays solvent across settle and reclaim.

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const {
  deploySatoriFixture,
  deployAndRegisterYesNoGame,
  createYesNoGame,
  pack1,
  VOTE, ensureAdapterBountyToken } = require("./fixtures");

const YES = 1;
// The adapter host stream is a two-round (2880-minute) cadence stream:
// setValue must wait 2 rounds (2×86400s − 30m slack) between writes, so
// advance two full rounds per step.
async function advanceTwoRounds() { await time.increase(2 * 86400); }

async function streamIdFrom(tx, fix) {
  const rcpt = await tx.wait();
  for (const log of rcpt.logs) {
    try {
      const p = fix.registry.interface.parseLog(log);
      if (p && p.name === "DataStreamCreated") return Number(p.args.streamId);
    } catch (e) {}
  }
  throw new Error("DataStreamCreated event missing");
}

describe("F2 — adapter bounty payouts are tracked in claimed; reclaim cannot double-spend", function () {
  this.timeout(1200000); // 768-deep ring eviction loop
  let fix, satori, bounties, registry;
  let alice, bob, funder, authority;
  let stream, gameId, usd, usdAddr, bountiesAddr;

  beforeEach(async function () {
    fix = await loadFixture(deploySatoriFixture);
    ({ satori, bounties, registry } = fix);
    [, alice, bob, funder, authority] = fix.signers;
    bountiesAddr = await bounties.getAddress();

    for (const u of [alice, bob, funder, authority]) {
      await satori.transfer(u.address, ethers.parseEther("100"));
    }

    // An adapter game (YesNoGame) on a fresh stream.
    const { gameTypeId } = await deployAndRegisterYesNoGame(fix);
    stream = await streamIdFrom(
      // 2880 minutes (two rounds): adapter games (gameTypeId > 0) require a
      // cadence of at least two rounds (GameCadenceTooShort below that).
      await satori.connect(authority)["createSimpleDataStream(string,address,uint24)"]("S", authority.address, 2880),
      fix
    );
    await registry.connect(authority).setValue(stream, 100); // anchor
    gameId = await createYesNoGame(satori.connect(authority), gameTypeId, stream, 150, "yn");

    // No burn for the adapter game: only the built-in binary game is
    // mint-eligible, so voting for an adapter game reverts GameNotMintEligible.
    // Nothing here needs it — prediction power is balance + unclaimed, and the
    // bounty rail is funded escrow that pays on every game type.

    usd = await (await ethers.getContractFactory("MockERC20")).deploy("USDC", "USDC");
    await usd.waitForDeployment();
    usdAddr = await usd.getAddress();
    for (const u of [funder, alice, bob]) {
      await usd.mint(u.address, ethers.parseEther("10000"));
      await usd.connect(u).approve(bountiesAddr, ethers.parseEther("10000"));
    }
  });

  async function liabilities(predRound) {
    const stakeA = await bounties.bountyStake(alice.address, usdAddr);
    const stakeB = await bounties.bountyStake(bob.address, usdAddr);
    const pool = await bounties.pool(gameId, usdAddr);
    const pot = await bounties.roundBountyPot(gameId, predRound, usdAddr);
    const claimed = await bounties.roundBountyPotClaimed(gameId, predRound, usdAddr);
    const unclaimed = pot > claimed ? pot - claimed : 0n;
    return stakeA + stakeB + pool + unclaimed;
  }

  it("keeps the bounty subsystem solvent across an adapter-game settle, a reclaim and a late settle", async function () {
    // Two equal winners stake, fund the adapter game's bounty, both predict YES.
    await bounties.connect(alice).stakeBountyToken(usdAddr, ethers.parseEther("100"));
    await bounties.connect(bob).stakeBountyToken(usdAddr, ethers.parseEther("100"));
    await ensureAdapterBountyToken(bounties, gameId, usdAddr);
    await bounties
      .connect(funder)
      .fundBounty(gameId, usdAddr, ethers.parseEther("1000"), ethers.parseEther("400"));

    await satori.connect(alice).predictMultipleWithPayloads([{ gameId, payload: pack1(YES) }]);
    await satori.connect(bob).predictMultipleWithPayloads([{ gameId, payload: pack1(YES) }]);
    const predRound = Number(await satori.getCurrentRound());

    // First value after predRound > threshold ⇒ YES wins for both.
    await advanceTwoRounds();
    await registry.connect(authority).setValue(stream, 200);

    // Only Alice settles her boosted winning adapter bet; Bob abandons his.
    await satori.connect(funder).settlePrediction(alice.address, gameId);

    const pot = await bounties.roundBountyPot(gameId, predRound, usdAddr);
    const claimed = await bounties.roundBountyPotClaimed(gameId, predRound, usdAddr);
    expect(pot).to.be.gt(0n); // the drip fired
    // FIX: Alice's adapter payout is recorded in claimed (pre-fix this stays 0).
    expect(claimed).to.be.gt(0n);

    // Solvency after settle.
    expect(await usd.balanceOf(bountiesAddr)).to.be.gte(await liabilities(predRound));

    // Evict predRound so reclaim is allowed: the hour-keyed ring is 768
    // entries deep, so every entry at or before the round's last hour must be
    // rolled out by 768+ subsequent writes.
    for (let i = 0; i < 770; i++) {
      await advanceTwoRounds();
      await registry.connect(authority).setValue(stream, 210 + i);
    }
    await bounties.reclaimStrandedPot(gameId, predRound, usdAddr);

    // Solvency MUST still hold after reclaim. Pre-fix, reclaim swept the full
    // already-paid pot into pool, double-counting Alice's share.
    expect(await usd.balanceOf(bountiesAddr)).to.be.gte(await liabilities(predRound));

    // M28: the adapter still resolves Bob's bet, but his share went back to
    // the pool with the reclaim, so the late settle pays nothing.
    const bobBefore = await bounties.bountyStake(bob.address, usdAddr);
    await satori.connect(funder).settlePrediction(bob.address, gameId);
    expect(await bounties.bountyStake(bob.address, usdAddr)).to.equal(bobBefore);
    expect(await bounties.roundBountyPotClaimed(gameId, predRound, usdAddr)).to.equal(pot);
    expect(await usd.balanceOf(bountiesAddr)).to.be.gte(await liabilities(predRound));
  });
});
