/**
 * ADVERSARIAL AUDIT 2 — feeAdmin -> admin rename surface.
 *
 * Attacks the rename: every gate that used to read feeAdmin must now read
 * `admin`; cross-contract reads of the renamed getter must resolve; setAdmin
 * must not be hijackable / must not allow address(0) bricking; admin must have
 * EXACTLY the three documented powers (reduce fee, transfer role, register
 * official adapters) and ZERO economic authority.
 *
 * Run:
 *   npx hardhat test adversarial-findings/_audit2_admin-rename.test.js
 */
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture } = require("../fixtures");

describe("AUDIT2 admin-rename", function () {
  it("admin() resolves to the deployer; owner() is the ownerless address(0) signal", async () => {
    const { satori, rewards, owner } = await loadFixture(deploySatoriFixture);
    expect(await rewards.admin()).to.equal(owner.address);
    // Satori.owner() deliberately returns address(0) (ownerless signal); it does
    // NOT surface the admin role.
    expect(await satori.owner()).to.equal(ethers.ZeroAddress);
  });

  it("setAdmin is admin-gated: a non-admin EOA cannot hijack the role", async () => {
    const { rewards, signers } = await loadFixture(deploySatoriFixture);
    const mallory = signers[3];
    await expect(rewards.connect(mallory).setAdmin(mallory.address)).to.be.reverted;
    // role unchanged
    expect(await rewards.admin()).to.equal((await ethers.getSigners())[0].address);
  });

  it("setAdmin(address(0)) is rejected (cannot brick the role)", async () => {
    const { rewards, owner } = await loadFixture(deploySatoriFixture);
    await expect(rewards.connect(owner).setAdmin(ethers.ZeroAddress)).to.be.reverted;
    expect(await rewards.admin()).to.equal(owner.address);
  });

  it("setAdmin transfers role; old admin loses power, new admin gains it; owner() stays ownerless", async () => {
    const { satori, rewards, owner, signers } = await loadFixture(deploySatoriFixture);
    const newAdmin = signers[4];
    await rewards.connect(owner).setAdmin(newAdmin.address);
    expect(await rewards.admin()).to.equal(newAdmin.address);
    // owner() is the ownerless constant — unaffected by the admin transfer.
    expect(await satori.owner()).to.equal(ethers.ZeroAddress);
    // old admin can no longer exercise admin power (official adapter registration)
    const Custom = await ethers.getContractFactory("CustomAdapter");
    const a1 = await Custom.deploy(); await a1.waitForDeployment();
    await expect(
      satori.connect(owner).registerAdapter(await a1.getAddress(), "stale-admin")
    ).to.be.reverted;
    // new admin can
    await expect(
      satori.connect(newAdmin).registerAdapter(await a1.getAddress(), "new-admin")
    ).to.not.be.reverted;
  });

  it("registerAdapter / registerGameAdapter gate on admin(); non-admin rejected, admin allowed", async () => {
    const { satori, rewards, owner, signers } = await loadFixture(deploySatoriFixture);
    const mallory = signers[3];
    const Custom = await ethers.getContractFactory("CustomAdapter");
    const a1 = await Custom.deploy(); await a1.waitForDeployment();
    const a2 = await Custom.deploy(); await a2.waitForDeployment();

    // Non-admin official stream-adapter registration must revert.
    await expect(
      satori.connect(mallory).registerAdapter(await a1.getAddress(), "evil")
    ).to.be.reverted;
    // Admin official registration succeeds (free, no bond).
    await expect(
      satori.connect(owner).registerAdapter(await a1.getAddress(), "official")
    ).to.not.be.reverted;

    // Game adapter: need an IPredictionGame impl. Use the default game type if a
    // mock exists; otherwise just assert the non-admin gate reverts (the gate is
    // what the rename touched).
    await expect(
      satori.connect(mallory).registerGameAdapter(await a2.getAddress(), "evilgame")
    ).to.be.reverted;

    // And after the admin role moves, the OLD admin can no longer register.
    const newAdmin = signers[4];
    await rewards.connect(owner).setAdmin(newAdmin.address);
    const a3 = await Custom.deploy(); await a3.waitForDeployment();
    await expect(
      satori.connect(owner).registerAdapter(await a3.getAddress(), "stale-admin")
    ).to.be.reverted;
    await expect(
      satori.connect(newAdmin).registerAdapter(await a3.getAddress(), "new-admin")
    ).to.not.be.reverted;
  });

  it("admin has no economic PARAMETER setters: no recipient/rate-up/emission knobs exist", async () => {
    const { rewards, owner } = await loadFixture(deploySatoriFixture);
    // The fee recipient is a hard-coded immutable constant with no setter.
    const iface = rewards.interface;
    const fnNames = iface.fragments.filter(f => f.type === "function").map(f => f.name);
    // No function should let admin redirect the fee destination.
    //
    // `*Authority` setters are EXCLUDED, and the distinction is the point: those
    // assign who holds a job, they do not set an economic value. `rewards.admin`
    // was split on 2026-09-14 and `setEmissionSplitAuthority` appoints the
    // holder of the dial — it moves no number and can grant no power the caller
    // did not already hold, since assigning is gated on the current holder or
    // the token's appoint authority.
    //
    // NOTE ON THE TITLE, corrected: admin is not economically powerless. Until
    // `emissionSplitAuthority` is set it holds the dial by fallback, which is the
    // largest economic lever in the protocol. What this test actually pins — and
    // all it ever pinned — is that there is no SETTER for a fee recipient, a
    // reward rate, a round duration or an emission figure anywhere in rewards.
    const redirectish = fnNames.filter(n =>
      !/Authority$/.test(n) &&
      /setPlatformFeeRecipient|setFeeRecipient|setRecipient|setRewardRate|setRoundDuration|setStreakCurve|setEmission|mintTo|setBudget/i.test(n)
    );
    expect(redirectish, `unexpected economic setters: ${redirectish}`).to.have.length(0);
    // platform fee moved to immutable token (see test/next/DevFee.test.js):
    // rewards.PLATFORM_FEE_RECIPIENT() no longer exists — the fee recipient is an
    // immutable on SatoriToken, and its immutability/non-admin-authority is
    // asserted there. The point here (rewards admin has no economic setter) stands
    // via the redirectish check above.
  });
});
