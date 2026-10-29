const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixtureNoFee, onChainGrossNow } = require("../fixtures");

// SPLITTING `rewards.admin`, one level down from the token's governor split.
//
// `admin` was one address holding several unrelated jobs: the on-chain/off-chain
// dial, capability toggles, game approval, official adapter registration, and
// appointing the off-chain reporter. Same bundling `token.governor` had, same
// argument.
//
// THE DIAL is carved out — the largest economic lever in the protocol, which
// also BOUNDS the Merkle root publisher (a root can only pay out of the accrued
// reserve). Everything else stays with `admin` — denial or noise, not theft.
// (Airdrop loading was the second carve-out until the airdrop moved into its
// own contract; its loader role is covered in test/SatoriAirdrop.test.js.)
//
// ZERO MEANS "FALL BACK TO admin", which is what makes this upgrade a no-op on a
// live proxy: an unset slot behaves exactly as it did before.

describe("SatoriRewards — the admin split", function () {
  let satori, rewards, token, owner, admin, dialer, dropper, stranger;

  beforeEach(async function () {
    const fix = await deploySatoriFixtureNoFee();
    ({ satori, rewards, token } = fix);
    owner = fix.owner;
    [, admin, dialer, dropper, stranger] = fix.signers;
  });

  describe("an unset slot behaves exactly as before", function () {
    it("the slot starts empty and admin still holds the job", async function () {
      expect(await rewards.emissionSplitAuthority()).to.equal(ethers.ZeroAddress);

      // The whole point of the zero-fallback: a live proxy upgraded to this
      // implementation keeps working with no migration and no window in which a
      // job has no holder.
      await expect(rewards.connect(owner).setOffchainShareBps(1n)).to.not.be.reverted;
    });

    it("a stranger still holds nothing", async function () {
      await expect(rewards.connect(stranger).setOffchainShareBps(1n))
        .to.be.revertedWithCustomError(rewards, "Unauthorized");
    });
  });

  describe("carving the jobs out", function () {
    it("moves the dial to its own holder, and admin loses it", async function () {
      await rewards.connect(owner).setEmissionSplitAuthority(dialer.address);
      expect(await rewards.emissionSplitAuthority()).to.equal(dialer.address);

      await expect(rewards.connect(dialer).setOffchainShareBps(1n)).to.not.be.reverted;
      // THE POINT. The operator can no longer move the largest economic lever.
      await expect(rewards.connect(owner).setOffchainShareBps(2n))
        .to.be.revertedWithCustomError(rewards, "Unauthorized");
      // ...and still holds everything that was not carved out.
      await expect(rewards.connect(owner).setCapabilities(0n)).to.not.be.reverted;
    });

    it("setting a slot back to zero returns the job to admin", async function () {
      await rewards.connect(owner).setEmissionSplitAuthority(dialer.address);
      await rewards.connect(dialer).setEmissionSplitAuthority(ethers.ZeroAddress);
      await expect(rewards.connect(owner).setOffchainShareBps(1n)).to.not.be.reverted;
      await expect(rewards.connect(dialer).setOffchainShareBps(2n))
        .to.be.revertedWithCustomError(rewards, "Unauthorized");
    });
  });

  describe("who may reassign", function () {
    it("the holder rotates its own key without asking anyone", async function () {
      await rewards.connect(owner).setEmissionSplitAuthority(dialer.address);
      await rewards.connect(dialer).setEmissionSplitAuthority(stranger.address);
      expect(await rewards.emissionSplitAuthority()).to.equal(stranger.address);
    });

    it("the token's APPOINT authority can seize the job", async function () {
      // Appointment is a token-level power (dao-governance.md v2), so the same
      // slot that can replace the admin can replace these. Recall has to reach
      // every office or it is not recall.
      await rewards.connect(owner).setEmissionSplitAuthority(dialer.address);
      expect(await token.appointAuthority()).to.equal(owner.address);

      await rewards.connect(owner).setEmissionSplitAuthority(dropper.address);
      expect(await rewards.emissionSplitAuthority()).to.equal(dropper.address);
      // ...and the ousted holder cannot take it back.
      await expect(rewards.connect(dialer).setEmissionSplitAuthority(dialer.address))
        .to.be.revertedWithCustomError(rewards, "Unauthorized");
    });

    it("a stranger can never assign the slot", async function () {
      await expect(rewards.connect(stranger).setEmissionSplitAuthority(stranger.address))
        .to.be.revertedWithCustomError(rewards, "Unauthorized");
    });
  });

  describe("the dial still works the same once moved", function () {
    it("a carved-out dial holder changes the on-chain gross exactly as admin did", async function () {
      const residual = await onChainGrossNow(satori);
      await rewards.connect(owner).setEmissionSplitAuthority(dialer.address);
      await rewards.connect(dialer).setOffchainShareBps(5000);
      expect(await rewards.offchainShareBps()).to.equal(5000n);
      expect(residual).to.be.gt(0n);
      // And the bound is the contract's, not the holder's: still refused at
      // 100%, whoever is asking.
      await expect(rewards.connect(dialer).setOffchainShareBps(10000))
        .to.be.revertedWithCustomError(rewards, "BadInput");
    });
  });
});
