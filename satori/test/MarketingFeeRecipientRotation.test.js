// The marketing-fee recipient moved from an `immutable` (compiled into the
// implementation's bytecode) to APPENDED PROXY STORAGE, with a two-step rotation.
//
// Why: SatoriRewards is upgradeable, so an `immutable` was never actually
// immutable — a new implementation simply carries a new value. That is why a
// `_validateNewImplementation` pin had been bolted on to re-check it, and that
// pin was itself only a speed bump: the check runs in the OUTGOING
// implementation, so upgrading once to an impl that drops the check and again to
// one with a different value defeated it.
//
// Storage is the stronger form on that axis — an upgrade swaps code, not storage
// — and it removes a permanent failure mode: an immutable recipient whose key is
// lost burns 5% of every un-referred reward forever with no recovery.
//
// Rotation is deliberately NOT an admin power. `admin` is documented
// non-extractive ("can never direct funds or votes to itself"); letting it
// re-point this would hand it 5% of all un-referred emission. Only the current
// recipient may nominate, and the nominee must accept (proving the address is
// real and controlled before any cut routes there — same reasoning as the LA-1
// two-step publisher fix on SatoriMerkle).

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const {
  deploySplitCompatFixture,
  TEST_MARKETING_FEE_RECIPIENT,
} = require("./next/splitFixture");

const fix = () => deploySplitCompatFixture(2000);
// Matches SatoriRewards._PLACEHOLDER_MARKETING exactly.
const PLACEHOLDER = ethers.getAddress("0x000000000000000000000000000000000000bEEF");

/// Fund the impersonated marketing recipient so it can send the rotation txs.
async function asRecipient(addr) {
  await ethers.provider.send("hardhat_setBalance", [addr, "0x56BC75E2D63100000"]);
  return await ethers.getImpersonatedSigner(addr);
}

describe("Marketing fee recipient — proxy storage + two-step rotation", function () {
  describe("initial state", function () {
    it("the proxy's recipient is the deploy-time value", async function () {
      const f = await loadFixture(fix);
      expect(await f.rewards.marketingFeeRecipient())
        .to.equal(ethers.getAddress(TEST_MARKETING_FEE_RECIPIENT));
      expect(await f.rewards.pendingMarketingFeeRecipient()).to.equal(ethers.ZeroAddress);
    });

    it("a zero or placeholder recipient is rejected at construction", async function () {
      const F = await ethers.getContractFactory("SatoriRewards");
      const f = await loadFixture(fix);
      await expect(F.deploy(f.voting.target, f.owner.address, ethers.ZeroAddress))
        .to.be.revertedWithCustomError(F, "BadInput");
      await expect(F.deploy(f.voting.target, f.owner.address, PLACEHOLDER))
        .to.be.revertedWithCustomError(F, "BadInput");
    });
  });

  describe("who may rotate it", function () {
    it("the ADMIN cannot — this is the property that keeps admin non-extractive", async function () {
      const f = await loadFixture(fix);
      const attacker = f.signers[7];
      // f.owner holds the rewards admin role in this fixture.
      expect(await f.rewards.admin()).to.equal(f.owner.address);
      await expect(
        f.rewards.connect(f.owner).transferMarketingFeeRecipient(f.owner.address)
      ).to.be.revertedWithCustomError(f.rewards, "Unauthorized");
      await expect(
        f.rewards.connect(attacker).transferMarketingFeeRecipient(attacker.address)
      ).to.be.revertedWithCustomError(f.rewards, "Unauthorized");
      expect(await f.rewards.marketingFeeRecipient())
        .to.equal(ethers.getAddress(TEST_MARKETING_FEE_RECIPIENT));
    });

    it("the current recipient can nominate, and only the nominee can accept", async function () {
      const f = await loadFixture(fix);
      const current = await asRecipient(TEST_MARKETING_FEE_RECIPIENT);
      const successor = f.signers[8];
      const stranger = f.signers[9];

      await expect(f.rewards.connect(current).transferMarketingFeeRecipient(successor.address))
        .to.emit(f.rewards, "MarketingFeeRecipientTransferStarted")
        .withArgs(ethers.getAddress(TEST_MARKETING_FEE_RECIPIENT), successor.address);

      // Nomination alone changes nothing.
      expect(await f.rewards.marketingFeeRecipient())
        .to.equal(ethers.getAddress(TEST_MARKETING_FEE_RECIPIENT));

      await expect(f.rewards.connect(stranger).acceptMarketingFeeRecipient())
        .to.be.revertedWithCustomError(f.rewards, "Unauthorized");

      await expect(f.rewards.connect(successor).acceptMarketingFeeRecipient())
        .to.emit(f.rewards, "MarketingFeeRecipientChanged")
        .withArgs(ethers.getAddress(TEST_MARKETING_FEE_RECIPIENT), successor.address);

      expect(await f.rewards.marketingFeeRecipient()).to.equal(successor.address);
      expect(await f.rewards.pendingMarketingFeeRecipient()).to.equal(ethers.ZeroAddress);
    });

    it("a nomination can be cancelled, and accepting nothing reverts", async function () {
      const f = await loadFixture(fix);
      const current = await asRecipient(TEST_MARKETING_FEE_RECIPIENT);
      const successor = f.signers[8];

      await f.rewards.connect(current).transferMarketingFeeRecipient(successor.address);
      await f.rewards.connect(current).transferMarketingFeeRecipient(ethers.ZeroAddress);
      expect(await f.rewards.pendingMarketingFeeRecipient()).to.equal(ethers.ZeroAddress);

      await expect(f.rewards.connect(successor).acceptMarketingFeeRecipient())
        .to.be.revertedWithCustomError(f.rewards, "Unauthorized");
      expect(await f.rewards.marketingFeeRecipient())
        .to.equal(ethers.getAddress(TEST_MARKETING_FEE_RECIPIENT));
    });

    it("the placeholder cannot be nominated", async function () {
      const f = await loadFixture(fix);
      const current = await asRecipient(TEST_MARKETING_FEE_RECIPIENT);
      await expect(f.rewards.connect(current).transferMarketingFeeRecipient(PLACEHOLDER))
        .to.be.revertedWithCustomError(f.rewards, "BadInput");
    });
  });

  describe("an upgrade cannot change it — the whole point of the move", function () {
    it("installing an implementation compiled with a DIFFERENT recipient leaves the live value untouched", async function () {
      const f = await loadFixture(fix);
      const before = await f.rewards.marketingFeeRecipient();
      const hostileValue = f.signers[6].address;
      expect(hostileValue).to.not.equal(before);

      // A perfectly valid SatoriRewards implementation whose CONSTRUCTOR arg is a
      // different marketing recipient. Pre-move this value lived in bytecode, so
      // installing it would have re-pointed the cut (which is exactly why the
      // now-removed pin existed). Post-move the ctor writes the implementation's
      // own throwaway storage; the proxy keeps its own slot.
      const F = await ethers.getContractFactory("SatoriRewards");
      const hostileImpl = await F.deploy(f.voting.target, f.owner.address, hostileValue);
      await hostileImpl.waitForDeployment();

      await f.rewards.connect(f.owner).upgradeTo(await hostileImpl.getAddress());

      expect(await f.rewards.marketingFeeRecipient()).to.equal(before);
    });

    it("upgrades still work at all (the removed validator did not brick the path)", async function () {
      const f = await loadFixture(fix);
      const F = await ethers.getContractFactory("SatoriRewards");
      const impl = await F.deploy(f.voting.target, f.owner.address, TEST_MARKETING_FEE_RECIPIENT);
      await impl.waitForDeployment();
      await expect(f.rewards.connect(f.owner).upgradeTo(await impl.getAddress()))
        .to.emit(f.rewards, "Upgraded");
    });
  });

});
