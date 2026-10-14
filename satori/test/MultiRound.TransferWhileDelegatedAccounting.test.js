const { expect } = require("chai");
const { deploySatoriFixture } = require("./fixtures");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

async function advanceToNextRound() {
  const now = await time.latest();
  const nextMidnight = Math.floor(now / 86400) * 86400 + 86400;
  await time.increaseTo(nextMidnight + 1);
}

describe("MultiRound: Transfer While Delegated Accounting", function () {
  it("updates delegated prediction power and transfer locks consistently", async function () {
    const fix = await deploySatoriFixture();
    const { satori, voting, rewards, registry, games, bounties, owner } = fix;
    const [, alice, bob] = fix.signers;

    await satori.transfer(alice.address, ethers.parseEther("100"));
    await satori.transfer(bob.address, ethers.parseEther("50"));

    const before = await rewards.getPredictionPower(bob.address);
    await satori.connect(alice).delegatePredictionPower(bob.address);
    const afterDelegate = await rewards.getPredictionPower(bob.address);
    expect(afterDelegate).to.be.gt(before);

    // while delegated, delegator transfer should be blocked
    await expect(
      satori.connect(alice).transfer(bob.address, ethers.parseEther("1"))
    ).to.be.revertedWithCustomError(satori, "Locked");

    // receiving tokens while delegated increases the delegate's prediction
    // power — but per adv_6 a mid-round receipt DEFERS to next round (it doesn't
    // flow until R+1). So it is unchanged the same round...
    await satori.transfer(alice.address, ethers.parseEther("20"));
    expect(await rewards.getPredictionPower(bob.address)).to.equal(afterDelegate);
    // ...and increases once it activates next round.
    await advanceToNextRound();
    const afterReceive = await rewards.getPredictionPower(bob.address);
    expect(afterReceive).to.be.gt(afterDelegate);

    // undelegate, then wait lock period before transfer
    await satori.connect(alice).delegatePredictionPower(ethers.ZeroAddress);
    await advanceToNextRound();
    await advanceToNextRound();

    await expect(
      satori.connect(alice).transfer(bob.address, ethers.parseEther("1"))
    ).to.not.be.reverted;

    // and delegated power should no longer include alice's full balance
    const afterUndelegate = await rewards.getPredictionPower(bob.address);
    expect(afterUndelegate).to.be.lt(afterReceive);
  });
});
