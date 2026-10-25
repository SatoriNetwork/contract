// The community adapter registration fee is admin-settable (C4: the formerly uint16
// adapter-id and game-type-id spaces). It lives on SatoriRewards, defaults to the
// flat 0.001 SATORI, and is charged ONLY by registerCommunityAdapter and
// registerCommunityGameAdapter; stream and game creation keep their flat burns.

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture } = require("../fixtures");

describe("Community registration fee (admin-settable)", function () {
  let satori, rewards, lens, owner, alice;
  const DEFAULT = ethers.parseEther("0.001");

  beforeEach(async function () {
    const fix = await loadFixture(deploySatoriFixture);
    ({ satori, rewards, lens, owner } = fix);
    [, alice] = fix.signers;
  });

  const freshAdapter = async () => {
    const Impl = await ethers.getContractFactory("CustomAdapter");
    const impl = await Impl.deploy();
    await impl.waitForDeployment();
    return impl.getAddress();
  };

  it("defaults to 0.001 SATORI, on Rewards and through the lens", async function () {
    expect(await rewards.registrationFee()).to.equal(DEFAULT);
    expect(await lens.registrationFee()).to.equal(DEFAULT);
  });

  it("only the admin sets it, refuses zero, and announces the change", async function () {
    await expect(rewards.connect(alice).setRegistrationFee(1n)).to.be.revertedWithCustomError(rewards, "Unauthorized");
    await expect(rewards.connect(owner).setRegistrationFee(0n)).to.be.revertedWithCustomError(rewards, "BadInput");
    const fee = ethers.parseEther("5");
    await expect(rewards.connect(owner).setRegistrationFee(fee))
      .to.emit(rewards, "RegistrationFeeSet").withArgs(fee, owner.address);
    expect(await rewards.registrationFee()).to.equal(fee);
    expect(await lens.registrationFee()).to.equal(fee);
  });

  it("charges the new fee for a community stream adapter, and the old one until it is set", async function () {
    await satori.transfer(alice.address, ethers.parseEther("10"));
    let before = await satori.balanceOf(alice.address);
    await satori.connect(alice).registerCommunityAdapter(await freshAdapter(), "default-fee");
    expect(before - (await satori.balanceOf(alice.address))).to.equal(DEFAULT);

    const fee = ethers.parseEther("5");
    await rewards.connect(owner).setRegistrationFee(fee);
    before = await satori.balanceOf(alice.address);
    await satori.connect(alice).registerCommunityAdapter(await freshAdapter(), "new-fee");
    expect(before - (await satori.balanceOf(alice.address))).to.equal(fee);
  });

  it("charges the new fee for a community game adapter", async function () {
    const fee = ethers.parseEther("2");
    await rewards.connect(owner).setRegistrationFee(fee);
    await satori.transfer(alice.address, ethers.parseEther("10"));
    const before = await satori.balanceOf(alice.address);
    await satori.connect(alice).registerCommunityGameAdapter(await freshAdapter(), "game-fee");
    expect(before - (await satori.balanceOf(alice.address))).to.equal(fee);
  });

  it("a fee the registrant cannot cover reverts the registration", async function () {
    await rewards.connect(owner).setRegistrationFee(ethers.parseEther("100"));
    await satori.transfer(alice.address, DEFAULT);
    await expect(satori.connect(alice).registerCommunityAdapter(await freshAdapter(), "too-poor")).to.be.reverted;
  });

  it("leaves the flat stream and game burns alone", async function () {
    await rewards.connect(owner).setRegistrationFee(ethers.parseEther("5"));
    expect(await satori.streamBurn()).to.equal(DEFAULT);
    expect(await satori.gameBurn()).to.equal(ethers.parseEther("0.1"));
  });
});
