// SatoriSplitterImmutable — the authority moves in two steps (sweep C4).
//
// A one-step transfer to a mistyped address would hand the rotation right, which
// can redirect a branch's whole income, to someone who cannot be asked to give it
// back. The right now moves only when the named address accepts.

const { expect } = require("chai");
const { ethers } = require("hardhat");

async function deploy() {
  const [, authority, next, other, r1, r2] = await ethers.getSigners();
  const Splitter = await ethers.getContractFactory("SatoriSplitterImmutable");
  const s = await Splitter.deploy(authority.address, [r1.address, r2.address], [5000, 5000], 0);
  await s.waitForDeployment();
  return { s, authority, next, other };
}

describe("SatoriSplitterImmutable — two-step authority", function () {
  it("an offer does not move the right until it is accepted", async function () {
    const { s, authority, next } = await deploy();
    await expect(s.connect(authority).transferAuthority(next.address))
      .to.emit(s, "AuthorityTransferStarted").withArgs(authority.address, next.address);
    expect(await s.authority()).to.equal(authority.address);
    expect(await s.pendingAuthority()).to.equal(next.address);

    await expect(s.connect(next).acceptAuthority())
      .to.emit(s, "AuthorityTransferred").withArgs(authority.address, next.address);
    expect(await s.authority()).to.equal(next.address);
    expect(await s.pendingAuthority()).to.equal(ethers.ZeroAddress);
  });

  it("only the named address can accept, and the old authority keeps the right until then", async function () {
    const { s, authority, next, other } = await deploy();
    await s.connect(authority).transferAuthority(next.address);
    await expect(s.connect(other).acceptAuthority()).to.be.revertedWithCustomError(s, "NotPendingAuthority");
    await expect(s.connect(authority).acceptAuthority()).to.be.revertedWithCustomError(s, "NotPendingAuthority");
    // still the authority: it can renounce, or re-point the offer
    await s.connect(authority).transferAuthority(other.address);
    await expect(s.connect(next).acceptAuthority()).to.be.revertedWithCustomError(s, "NotPendingAuthority");
    await s.connect(other).acceptAuthority();
    expect(await s.authority()).to.equal(other.address);
  });

  it("a mistyped address with no key cannot take the right", async function () {
    const { s, authority } = await deploy();
    await s.connect(authority).transferAuthority("0x000000000000000000000000000000000000dEaD");
    expect(await s.authority()).to.equal(authority.address);
    await s.connect(authority).transferAuthority(ethers.ZeroAddress);
    expect(await s.authority()).to.equal(ethers.ZeroAddress);
  });

  it("zero and renounce give the right up at once and clear a pending offer", async function () {
    const { s, authority, next } = await deploy();
    await s.connect(authority).transferAuthority(next.address);
    await s.connect(authority).renounceAuthority();
    expect(await s.authority()).to.equal(ethers.ZeroAddress);
    expect(await s.pendingAuthority()).to.equal(ethers.ZeroAddress);
    await expect(s.connect(next).acceptAuthority()).to.be.revertedWithCustomError(s, "NotPendingAuthority");

    const second = await deploy();
    await second.s.connect(second.authority).transferAuthority(second.next.address);
    await second.s.connect(second.authority).transferAuthority(ethers.ZeroAddress);
    expect(await second.s.authority()).to.equal(ethers.ZeroAddress);
    expect(await second.s.pendingAuthority()).to.equal(ethers.ZeroAddress);
  });

  it("a stranger cannot offer", async function () {
    const { s, other } = await deploy();
    await expect(s.connect(other).transferAuthority(other.address)).to.be.revertedWithCustomError(s, "NotAuthority");
  });
});
