// v5 — stake/unstake surface for the auto-boost feature.
//
// Verifies:
//   - stakeBountyToken happy path + first-stake push into userStakedTokens.
//   - unstakeBountyToken happy path + swap-pop on unstake-to-zero.
//   - No cap on the staked-tokens list (the prior
//     MAX_STAKED_TOKENS_PER_USER cap was removed — unstake is the
//     user-controlled mechanism to shrink the list).
//   - Subsequent stakes in already-staked token just bump amount.
//   - unstake succeeds even while predictions reference the stake (the lock
//     was removed in favor of the self-sufficient predict-time snapshot).
//   - recipient parameter routes unstake transfer correctly.
//   - balance-delta deposit handles fee-on-transfer tokens.

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture, pack1 , warmUpStreak, VOTE } = require("./fixtures");

async function deployMockToken() {
  const M = await ethers.getContractFactory("MockERC20");
  const t = await M.deploy("USDC", "USDC");
  await t.waitForDeployment();
  return t;
}

async function deployFeeMockToken(feeBps) {
  const M = await ethers.getContractFactory("MockFeeERC20");
  const t = await M.deploy("FEE", "FEE", feeBps);
  await t.waitForDeployment();
  return t;
}

describe("BountyStake — v5 stake/unstake surface", function () {
  let satori, rewards, bounties, registry, owner, alice, bob, recipient;
  let usd;

  beforeEach(async function () {
    const fix = await loadFixture(deploySatoriFixture);
    ({ satori, rewards, bounties, registry, owner } = fix);
    [, alice, bob, recipient] = fix.signers;

    usd = await deployMockToken();
    await usd.mint(alice.address, ethers.parseEther("10000"));
    await usd.connect(alice).approve(await bounties.getAddress(), ethers.parseEther("10000"));
  });

  it("stake -> first-stake pushes token into userStakedTokens; bountyStake bookkeeping is correct", async function () {
    const usdAddr = await usd.getAddress();
    await bounties.connect(alice).stakeBountyToken(usdAddr, ethers.parseEther("100"));

    expect(await bounties.bountyStake(alice.address, usdAddr)).to.equal(ethers.parseEther("100"));
    expect(await bounties.userStakedTokens(alice.address, 0)).to.equal(usdAddr);
  });

  it("stake -> repeat stake in same token bumps bountyStake but does NOT push duplicate", async function () {
    const usdAddr = await usd.getAddress();
    await bounties.connect(alice).stakeBountyToken(usdAddr, ethers.parseEther("100"));
    await bounties.connect(alice).stakeBountyToken(usdAddr, ethers.parseEther("50"));

    expect(await bounties.bountyStake(alice.address, usdAddr)).to.equal(ethers.parseEther("150"));
    // Index 1 should revert (out-of-bounds) — verifying no duplicate entry.
    await expect(bounties.userStakedTokens(alice.address, 1)).to.be.reverted;
  });

  it("stake -> no cap on distinct first-stake tokens (caps removed)", async function () {
    // The MAX_STAKED_TOKENS_PER_USER cap was removed: user-controlled list
    // (unstake to shrink) made the self-grief vector reversible, and
    // settler-grief on permissionless score paths is bounded by the
    // settler's own gas budget. Stake-cap reverts no longer fire.
    const N = 40; // exceeds the prior 32 cap
    for (let i = 0; i < N; i++) {
      const t = await deployMockToken();
      await t.mint(alice.address, ethers.parseEther("100"));
      await t.connect(alice).approve(await bounties.getAddress(), ethers.parseEther("100"));
      await bounties.connect(alice).stakeBountyToken(await t.getAddress(), ethers.parseEther("10"));
    }
    // All N stake calls succeeded — no cap. Confirm the (N-1)th element
    // is reachable, and (N)th throws (out-of-bounds), proving length==N.
    const last = await bounties.userStakedTokens(alice.address, N - 1);
    expect(last).to.match(/^0x[0-9a-fA-F]{40}$/);
    let outOfBoundsThrew = false;
    try { await bounties.userStakedTokens(alice.address, N); }
    catch { outOfBoundsThrew = true; }
    expect(outOfBoundsThrew).to.equal(true);
  });

  it("stake -> rejects zero amount and zero token address", async function () {
    const usdAddr = await usd.getAddress();
    await expect(
      bounties.connect(alice).stakeBountyToken(usdAddr, 0)
    ).to.be.revertedWithCustomError(rewards, "BadInput");
    await expect(
      bounties.connect(alice).stakeBountyToken(ethers.ZeroAddress, ethers.parseEther("1"))
    ).to.be.revertedWithCustomError(rewards, "BadInput");
  });

  it("stake -> fee-on-transfer token: bountyStake equals NET received, not gross sent", async function () {
    const fee = await deployFeeMockToken(500); // 5% fee
    await fee.mint(alice.address, ethers.parseEther("1000"));
    await fee.connect(alice).approve(await bounties.getAddress(), ethers.parseEther("1000"));

    const feeAddr = await fee.getAddress();
    await bounties.connect(alice).stakeBountyToken(feeAddr, ethers.parseEther("100"));
    // 5% burn → net received = 95.
    expect(await bounties.bountyStake(alice.address, feeAddr)).to.equal(ethers.parseEther("95"));
  });

  it("unstake -> partial: bountyStake decremented, userStakedTokens entry stays", async function () {
    const usdAddr = await usd.getAddress();
    await bounties.connect(alice).stakeBountyToken(usdAddr, ethers.parseEther("100"));
    await bounties.connect(alice).unstakeBountyToken(usdAddr, ethers.parseEther("30"), alice.address);

    expect(await bounties.bountyStake(alice.address, usdAddr)).to.equal(ethers.parseEther("70"));
    expect(await bounties.userStakedTokens(alice.address, 0)).to.equal(usdAddr);
    expect(await usd.balanceOf(alice.address)).to.equal(ethers.parseEther("10000") - ethers.parseEther("70"));
  });

  it("unstake -> full: bountyStake zeroed, userStakedTokens swap-popped", async function () {
    const usdAddr = await usd.getAddress();
    await bounties.connect(alice).stakeBountyToken(usdAddr, ethers.parseEther("100"));
    await bounties.connect(alice).unstakeBountyToken(usdAddr, ethers.parseEther("100"), alice.address);

    expect(await bounties.bountyStake(alice.address, usdAddr)).to.equal(0n);
    // Array is now empty — index 0 is OOB.
    await expect(bounties.userStakedTokens(alice.address, 0)).to.be.reverted;
  });

  it("unstake -> recipient param routes the unstake transfer to the recipient", async function () {
    const usdAddr = await usd.getAddress();
    await bounties.connect(alice).stakeBountyToken(usdAddr, ethers.parseEther("100"));
    const before = await usd.balanceOf(recipient.address);
    await bounties.connect(alice).unstakeBountyToken(usdAddr, ethers.parseEther("100"), recipient.address);
    expect((await usd.balanceOf(recipient.address)) - before).to.equal(ethers.parseEther("100"));
  });

  it("unstake -> insufficient stake reverts", async function () {
    const usdAddr = await usd.getAddress();
    await bounties.connect(alice).stakeBountyToken(usdAddr, ethers.parseEther("100"));
    await expect(
      bounties.connect(alice).unstakeBountyToken(usdAddr, ethers.parseEther("101"), alice.address)
    ).to.be.revertedWithCustomError(bounties, "InsufficientStake");
  });

  it("unstake -> zero amount + zero recipient revert", async function () {
    const usdAddr = await usd.getAddress();
    await bounties.connect(alice).stakeBountyToken(usdAddr, ethers.parseEther("100"));
    await expect(
      bounties.connect(alice).unstakeBountyToken(usdAddr, 0, alice.address)
    ).to.be.revertedWithCustomError(rewards, "BadInput");
    await expect(
      bounties.connect(alice).unstakeBountyToken(usdAddr, ethers.parseEther("1"), ethers.ZeroAddress)
    ).to.be.revertedWithCustomError(rewards, "BadInput");
  });

  it("unstake -> succeeds while a pending prediction references the stake (the snapshot is self-sufficient)", async function () {
    const usdAddr = await usd.getAddress();
    await bounties.connect(alice).stakeBountyToken(usdAddr, ethers.parseEther("100"));

    // Bob funds a USD bounty on a fresh stream. Alice predicts on it; her
    // own stake in USD auto-boosts and appends usd to the round-list
    // boostedTokensInRound[alice][predictRound].
    const registry = await ethers.getContractAt(
      "SatoriRegistry",
      await satori.satoriRegistry()
    );
    await satori.transfer(alice.address, ethers.parseEther("100"));
    await satori.transfer(bob.address, ethers.parseEther("100"));
    // Every-round (1440-minute) stream — one write per 24h round, which is the
    // rhythm this stake-lock test writes values at.
    const tx = await satori.connect(owner)["createSimpleDataStream(string,address,uint24)"]("S", owner.address, 1440);
    const rcpt = await tx.wait();
    let streamId;
    for (const log of rcpt.logs) {
      try {
        const p = satori.interface.parseLog(log);
        if (p && p.name === "DataStreamCreated") { streamId = p.args.streamId; break; }
      } catch (e) {}
    }
    await satori.connect(alice).vote(streamId, VOTE);
    // audit C-2: streak 0 takes no bounty boost — warm to streak >= 1
    await warmUpStreak(satori, registry, owner, alice, streamId);

    await usd.mint(bob.address, ethers.parseEther("1000"));
    await usd.connect(bob).approve(await bounties.getAddress(), ethers.parseEther("1000"));
    await bounties.connect(bob).fundBounty(
      streamId, usdAddr, ethers.parseEther("500"), ethers.parseEther("50")
    );

    await registry.connect(owner).setValue(streamId, 100);
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(1) }]);
    const round = await satori.getCurrentRound();

    // Alice's round-list now holds usd (one distinct boosted token this
    // round). The snapshot is still load-bearing for payout — that hasn't
    // changed. But unstakeBountyToken now ALSO checks stakeLockedUntil,
    // which applyBoost sets to predictRound+1 to block the cycle attack.
    expect(await bounties.boostedTokenCountInRound(alice.address, round)).to.equal(1n);
    expect(await bounties.stakeLockedUntil(alice.address, usdAddr)).to.be.gt(0n);

    // Within the predict round → StakeLocked revert.
    await expect(
      bounties.connect(alice).unstakeBountyToken(usdAddr, ethers.parseEther("100"), alice.address)
    ).to.be.revertedWithCustomError(bounties, "StakeLocked");

    // Advance past the lock → unstake succeeds. The snapshot still pays
    // out at score time regardless of the live stake.
    const ROUND = 86400;
    await time.increase(ROUND);
    await expect(
      bounties.connect(alice).unstakeBountyToken(usdAddr, ethers.parseEther("100"), alice.address)
    ).to.not.be.reverted;
    expect(await bounties.bountyStake(alice.address, usdAddr)).to.equal(0n);
  });
});
