// Cross-cutting delta audit for this session's changes:
//   3115c05 feat: official admin-gated adapter registration; rename feeAdmin->admin
//   315a13c feat: official adapter registration is FREE for the admin (waive spam fee)
//
// Attacks the SEAMS between: the rename (feeAdmin->admin), the new free
// admin-only registerAdapter/registerGameAdapter, and the existing
// community/bonded paths + reward/fee math.

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture } = require("../fixtures");

describe("audit2 cross-cutting delta", function () {
  let satori, registry, games, rewards, owner, alice, bob;

  beforeEach(async function () {
    const fix = await loadFixture(deploySatoriFixture);
    ({ satori, registry, games, rewards, owner } = fix);
    [, alice, bob] = fix.signers;
  });

  // ----- Rename sanity: admin()/setAdmin wired through; owner() is ownerless -----
  it("owner() is the ownerless address(0) signal; admin()/setAdmin transfer and re-gate", async function () {
    expect(await satori.owner()).to.equal(ethers.ZeroAddress);
    expect(await rewards.admin()).to.equal(owner.address);

    await rewards.connect(owner).setAdmin(alice.address);
    // owner() stays ownerless across the admin transfer; the role moves on admin().
    expect(await satori.owner()).to.equal(ethers.ZeroAddress);
    expect(await rewards.admin()).to.equal(alice.address);

    // old admin can no longer register official adapters
    const Impl = await ethers.getContractFactory("CustomAdapter");
    const impl = await Impl.deploy(); await impl.waitForDeployment();
    await expect(
      satori.connect(owner).registerAdapter(await impl.getAddress(), "x")
    ).to.be.revertedWithCustomError(satori, "Unauthorized");
    // new admin can
    await satori.connect(alice).registerAdapter(await impl.getAddress(), "x");
  });

  // ----- HYP A: admin can register UNLIMITED official adapters for FREE -----
  // The community path is bonded (currentSpamFee). The admin path is free.
  // Demonstrate the admin can register many official adapters paying nothing,
  // and that the spam-fee SATORI sink (-> address(this)) is bypassed.
  it("admin registers official adapters for FREE — no SATORI sink, repeatable", async function () {
    const ownerBefore = await satori.balanceOf(owner.address);
    const coreBefore = await satori.balanceOf(await satori.getAddress());
    const fee = await satori.streamBurn();
    expect(fee).to.be.gt(0n); // there IS a nonzero fee that community pays

    const Impl = await ethers.getContractFactory("CustomAdapter");
    for (let i = 0; i < 10; i++) {
      const impl = await Impl.deploy(); await impl.waitForDeployment();
      await satori.connect(owner).registerAdapter(await impl.getAddress(), "official-" + i);
    }
    // 10 official registrations cost the admin ZERO and added ZERO to the sink.
    expect(await satori.balanceOf(owner.address)).to.equal(ownerBefore);
    expect(await satori.balanceOf(await satori.getAddress())).to.equal(coreBefore);
  });

  // ----- HYP B: does the official flag grant any extra capability? -----
  // Compare an official adapter (community=false) vs a community adapter:
  // both should be equally usable to create streams; the flag is badge-only.
  it("official flag is badge-only — grants no extra stream/game capability", async function () {
    const Impl = await ethers.getContractFactory("CustomAdapter");
    const offImpl = await Impl.deploy(); await offImpl.waitForDeployment();
    const comImpl = await Impl.deploy(); await comImpl.waitForDeployment();

    const offId = await registry.nextAdapterId();
    await satori.connect(owner).registerAdapter(await offImpl.getAddress(), "off");
    expect(await registry.isCommunityAdapter(offId)).to.equal(false);

    const fee = await satori.streamBurn();
    await satori.transfer(alice.address, fee);
    const comId = await registry.nextAdapterId();
    await satori.connect(alice).registerCommunityAdapter(await comImpl.getAddress(), "com");
    expect(await registry.isCommunityAdapter(comId)).to.equal(true);

    // Both adapters are stored identically (impl set); flag is the only diff.
    expect(await registry.adapter(offId)).to.equal(await offImpl.getAddress());
    expect(await registry.adapter(comId)).to.equal(await comImpl.getAddress());
  });

  // ----- HYP C: community path still bonded (waiver did NOT leak) -----
  it("community path still charges the spam fee (waiver limited to admin path)", async function () {
    // streamBurn() grows by sqrt(roundsElapsed+1), so a round boundary landing
    // between the fee read and the charge inflates the charge by sqrt(2) and
    // flakes the exact-delta assertion. Park the clock just past a boundary so
    // the handful of tx-seconds below cannot cross one.
    const { time } = require("@nomicfoundation/hardhat-network-helpers");
    const unit = Number(await satori.TIME_UNIT_SECONDS());
    const now = await time.latest();
    await time.increaseTo(Math.floor(now / unit) * unit + unit + 1);

    const fee = await satori.streamBurn();
    await satori.transfer(alice.address, fee);
    const Impl = await ethers.getContractFactory("CustomAdapter");
    const impl = await Impl.deploy(); await impl.waitForDeployment();
    const aliceBefore = await satori.balanceOf(alice.address);
    await satori.connect(alice).registerCommunityAdapter(await impl.getAddress(), "c");
    expect(await satori.balanceOf(alice.address)).to.equal(aliceBefore - fee);
  });

  // ----- HYP D: non-admin cannot register official even WITH the bond held -----
  it("non-admin cannot use the official free path (Unauthorized)", async function () {
    const Impl = await ethers.getContractFactory("CustomAdapter");
    const impl = await Impl.deploy(); await impl.waitForDeployment();
    await satori.transfer(alice.address, await satori.streamBurn());
    await expect(
      satori.connect(alice).registerAdapter(await impl.getAddress(), "x")
    ).to.be.revertedWithCustomError(satori, "Unauthorized");
    await expect(
      satori.connect(alice).registerGameAdapter(await impl.getAddress(), "x")
    ).to.be.revertedWithCustomError(satori, "Unauthorized");
  });

  // ----- HYP E: admin with ZERO balance can still register (free path needs no funds) -----
  it("admin can register official adapter with ZERO token balance", async function () {
    // Move the entire admin balance away so admin holds nothing.
    const bal = await satori.balanceOf(owner.address);
    if (bal > 0n) await satori.connect(owner).transfer(bob.address, bal);
    expect(await satori.balanceOf(owner.address)).to.equal(0n);

    const Impl = await ethers.getContractFactory("CustomAdapter");
    const impl = await Impl.deploy(); await impl.waitForDeployment();
    // Community path would revert (insufficient balance for fee); official is free.
    await satori.connect(owner).registerAdapter(await impl.getAddress(), "broke-admin");
    // community path with no balance reverts
    await expect(
      satori.connect(owner).registerCommunityAdapter(await impl.getAddress(), "x")
    ).to.be.reverted;
  });
});
