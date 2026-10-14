const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

// The transfer hook runs AFTER the balance move (so a balance-derived consumer
// like the hub sees the settled state) and is reentrancy-safe (the hook is the
// single external call in the token, placed last, and cannot mint or bypass the
// ONE global cap). Both are proven here rather than asserted in prose.

const ROUND = 86400;
const E = (n) => ethers.parseEther(String(n));
const BEEF = "0x000000000000000000000000000000000000bEEF";

describe("SatoriToken — transfer hook: runs AFTER the move + reentrancy-safe", function () {
  let token, hook;
  let deployer, governor, dev, controller, alice, bob;

  beforeEach(async function () {
    [deployer, governor, dev, controller, alice, bob] = await ethers.getSigners();
    token = await (await ethers.getContractFactory("SatoriToken"))
      .connect(deployer).deploy(governor.address, dev.address, (await ethers.provider.getNetwork()).chainId);
    await token.waitForDeployment();
    hook = await (await ethers.getContractFactory("ReentrantTransferHook"))
      .deploy(await token.getAddress());
    await token.connect(governor).setController(controller.address);
    await token.connect(governor).setHook(await hook.getAddress());
    // fund alice and make her a participant so the hook fires on her transfers
    await token.connect(governor).transfer(alice.address, E(100));
    await token.connect(controller).markParticipated(alice.address);
  });

  it("runs AFTER the balance move — the hook observes the settled post-transfer balances", async function () {
    await token.connect(alice).transfer(bob.address, E(10)); // mode 0: observe only
    // bob had 0 and received 10; alice had 100 and sent 10 — the ONLY way the hook
    // sees 10 / 90 is if it ran AFTER super._update. If it ran before it would see 0 / 100.
    expect(await hook.observedToBal()).to.equal(E(10));
    expect(await hook.observedFromBal()).to.equal(E(90));
    expect(await hook.calls()).to.equal(1);
    expect(await token.balanceOf(bob.address)).to.equal(E(10));
    expect(await token.balanceOf(alice.address)).to.equal(E(90));
  });

  it("a reentrant rewardMint cannot bypass the controller — reverts, is swallowed, no phantom mint", async function () {
    await hook.setMode(1);
    const supplyBefore = await token.totalSupply();
    const mintedBefore = await token.totalRewardsMinted();
    await expect(token.connect(alice).transfer(bob.address, E(10)))
      .to.emit(token, "TransferHookFailed").withArgs(alice.address, bob.address, E(10));
    expect(await token.balanceOf(bob.address)).to.equal(E(10));       // outer transfer still settled
    expect(await token.totalSupply()).to.equal(supplyBefore);         // no inflation
    expect(await token.totalRewardsMinted()).to.equal(mintedBefore);
  });

  it("a reentrant mintDevFee is bounded by devFeeCeiling — no over-mint, cap holds", async function () {
    // The fee is a ratio of what was MINTED now, not of elapsed time, so the
    // clock alone owes nothing — a general mint is what creates the debt.
    await time.increase(ROUND);
    const ceilingBefore = await token.devFeeCeiling();
    const owed = ceilingBefore > (await token.devFeeMinted())
      ? ceilingBefore - (await token.devFeeMinted())
      : 0n;
    await hook.setMode(2);
    const recipient = await token.PLATFORM_FEE_RECIPIENT();
    const devBefore = await token.balanceOf(recipient);
    await token.connect(alice).transfer(bob.address, E(10)); // hook pulls the dev fee mid-transfer
    // Saturating, not equal: the genesis split can leave devFeeMinted a wei
    // AHEAD of its ceiling, and the pull then correctly pays nothing.
    expect(await token.devFeeMinted()).to.be.gte(await token.devFeeCeiling());
    expect(await token.balanceOf(recipient)).to.equal(devBefore + owed);
    expect(await token.totalRewardsMinted()).to.be.lte(await token.rewardCeiling()); // ONE cap holds
    expect(await token.mintDevFee.staticCall()).to.equal(0n);         // second pull same round = 0
  });

  it("a reentrant transfer stays consistent — pure moves, no value created", async function () {
    await token.connect(governor).transfer(await hook.getAddress(), E(5)); // give the hook a balance
    await hook.setMode(3);
    const supplyBefore = await token.totalSupply();
    await token.connect(alice).transfer(bob.address, E(10));
    expect(await token.balanceOf(BEEF)).to.equal(1n);                          // hook moved 1 wei
    expect(await token.balanceOf(await hook.getAddress())).to.equal(E(5) - 1n);
    expect(await token.balanceOf(bob.address)).to.equal(E(10));                // outer transfer settled
    expect(await token.totalSupply()).to.equal(supplyBefore);                  // supply unchanged
  });
});
