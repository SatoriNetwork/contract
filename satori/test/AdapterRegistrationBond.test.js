// Adapter registration is permissionless and bonded under the flat spam-burn
// fee (STREAM_BURN = 0.001 SATORI). Community registrations use
// `registerCommunityAdapter` (permissionless, bonded, charges `streamBurn()`);
// the protocol `admin` registers OFFICIAL adapters via `registerAdapter`
// (`community = false`) FREE — the admin gate is itself the spam deterrent.

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture } = require("./fixtures");

describe("Adapter registration (bonded, permissionless)", function () {
  let satori, registry, games, owner, alice;
  let customAdapter;

  beforeEach(async function () {
    const fix = await loadFixture(deploySatoriFixture);
    ({ satori, registry, games, owner, customAdapter } = fix);
    [, alice] = fix.signers;
  });

  describe("burn fees", function () {
    it("streamBurn / gameBurn / bountyBurn return the flat fees", async function () {
      expect(await satori.streamBurn()).to.equal(ethers.parseEther("0.001"));
      expect(await satori.gameBurn()).to.equal(ethers.parseEther("0.1"));
      expect(await satori.bountyBurn()).to.equal(ethers.parseEther("0.1"));
    });
  });

  describe("Permissionless registration (anyone with SATORI)", function () {
    it("anyone can call registerCommunityAdapter — charges streamBurn", async function () {
      const fee = await satori.streamBurn();
      await satori.transfer(alice.address, fee);
      const Impl = await ethers.getContractFactory("CustomAdapter");
      const impl = await Impl.deploy();
      await impl.waitForDeployment();
      const implAddr = await impl.getAddress();

      const aliceBefore = await satori.balanceOf(alice.address);
      const coreBefore = await satori.balanceOf(await satori.getAddress());

      // ID is auto-assigned; the fixture pre-registered three adapters
      // (IDs 1–3), so this lands at 4.
      const expectedId = await registry.nextAdapterId();
      await satori.connect(alice).registerCommunityAdapter(implAddr, "my-impl");

      expect(await satori.balanceOf(alice.address)).to.equal(aliceBefore - fee);
      expect(await satori.balanceOf(await satori.getAddress())).to.equal(coreBefore); // burned, not held

      expect(await registry.adapter(expectedId)).to.equal(implAddr);
      expect(await registry.adapterName(expectedId)).to.equal("my-impl");
      expect(await registry.isCommunityAdapter(expectedId)).to.equal(true);
    });

    it("reverts if caller lacks the bond", async function () {
      const Impl = await ethers.getContractFactory("CustomAdapter");
      const impl = await Impl.deploy();
      await impl.waitForDeployment();
      // alice has 0 SATORI
      await expect(
        satori.connect(alice).registerCommunityAdapter(await impl.getAddress(), "x")
      ).to.be.reverted; // ERC20InsufficientBalance
    });

    it("two registrations with the same name get different IDs (names are not unique)", async function () {
      const Impl = await ethers.getContractFactory("CustomAdapter");
      const a = await Impl.deploy(); await a.waitForDeployment();
      const b = await Impl.deploy(); await b.waitForDeployment();
      const idA = await registry.nextAdapterId();
      await satori.connect(owner).registerCommunityAdapter(await a.getAddress(), "duplicate-name");
      const idB = await registry.nextAdapterId();
      await satori.connect(owner).registerCommunityAdapter(await b.getAddress(), "duplicate-name");
      expect(idB).to.equal(idA + 1n);
      expect(await registry.adapterName(idA)).to.equal("duplicate-name");
      expect(await registry.adapterName(idB)).to.equal("duplicate-name");
    });

    it("reverts on zero impl address", async function () {
      await expect(
        satori.connect(owner).registerCommunityAdapter(ethers.ZeroAddress, "bad")
      ).to.be.revertedWithCustomError(registry, "InvalidAdapter");
    });
  });

  describe("Official (admin-only) registration", function () {
    // The protocol `admin` (owner() — the fixture deploys rewards with
    // admin = owner) can register OFFICIAL adapters: community = false. The
    // admin path is FREE (no burn fee); the only difference from the community
    // path is the official flag.
    it("admin can registerAdapter — community=false, FREE (no spam fee)", async function () {
      const Impl = await ethers.getContractFactory("CustomAdapter");
      const impl = await Impl.deploy(); await impl.waitForDeployment();
      const implAddr = await impl.getAddress();
      const ownerBefore = await satori.balanceOf(owner.address);
      const coreBefore = await satori.balanceOf(await satori.getAddress());
      const expectedId = await registry.nextAdapterId();

      await satori.connect(owner).registerAdapter(implAddr, "official-impl");

      // admin path is FREE — no fee charged (the admin gate is the spam deterrent)
      expect(await satori.balanceOf(owner.address)).to.equal(ownerBefore);
      expect(await satori.balanceOf(await satori.getAddress())).to.equal(coreBefore);
      expect(await registry.adapter(expectedId)).to.equal(implAddr);
      expect(await registry.isCommunityAdapter(expectedId)).to.equal(false); // OFFICIAL
    });

    it("registerAdapter reverts Unauthorized for a non-admin", async function () {
      const Impl = await ethers.getContractFactory("CustomAdapter");
      const impl = await Impl.deploy(); await impl.waitForDeployment();
      await expect(
        satori.connect(alice).registerAdapter(await impl.getAddress(), "x")
      ).to.be.revertedWithCustomError(satori, "Unauthorized");
    });

    it("admin can registerGameAdapter — isCommunity=false, FREE (no spam fee)", async function () {
      const Impl = await ethers.getContractFactory("CustomAdapter"); // any non-zero impl; validated at game-create
      const impl = await Impl.deploy(); await impl.waitForDeployment();
      const expectedId = await games.nextGameTypeId();
      const ownerBefore = await satori.balanceOf(owner.address);

      await satori.connect(owner).registerGameAdapter(await impl.getAddress(), "official-game");

      expect(await satori.balanceOf(owner.address)).to.equal(ownerBefore); // FREE
      expect(await games.isCommunityGameAdapter(expectedId)).to.equal(false); // OFFICIAL
    });

    it("registerGameAdapter reverts Unauthorized for a non-admin", async function () {
      const Impl = await ethers.getContractFactory("CustomAdapter");
      const impl = await Impl.deploy(); await impl.waitForDeployment();
      await expect(
        satori.connect(alice).registerGameAdapter(await impl.getAddress(), "x")
      ).to.be.revertedWithCustomError(satori, "Unauthorized");
    });

    // The community fee is one formula for everyone — there is NO fee-control
    // surface to tune or waive it. (The admin's OFFICIAL path is simply free,
    // gated by the admin check, not by a tunable fee.)
    it("`setAdapterRegistrationFee` does not exist", async function () {
      expect(satori.setAdapterRegistrationFee).to.be.undefined;
    });

    it("`renounceAdapterRegistrationFeeControl` does not exist", async function () {
      expect(satori.renounceAdapterRegistrationFeeControl).to.be.undefined;
    });
  });
});
