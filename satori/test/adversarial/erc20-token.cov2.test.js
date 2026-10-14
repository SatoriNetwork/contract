const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, impersonateAccount, setBalance } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture } = require("../fixtures");

const ROUND = 86400; // timeUnitSeconds

// Drive rewards-only token hooks (rewardMint / lockUntil*) directly by
// impersonating address(satoriRewards).
async function asRewards(rewards) {
  const addr = await rewards.getAddress();
  await impersonateAccount(addr);
  await setBalance(addr, ethers.parseEther("10"));
  return await ethers.getSigner(addr);
}

// MockERC20 is referenced per harness contract so the suite compiles it in.
let MockERC20;

describe("[adversarial-cov2] erc20-token (round 2 — med gaps)", function () {
  this.timeout(120000);

  before(async function () {
    MockERC20 = await ethers.getContractFactory("MockERC20");
    // warp half a round so getCurrentRound is stable mid-round, mirroring the
    // default suite's time posture and avoiding boundary flakiness.
    await time.increase(ROUND / 2);
  });

  // ---------------------------------------------------------------------
  // rewardMint cap accounting is CUMULATIVE within a single round.
  //
  // The existing cov suite does at most one rewardMint per round, so it
  // never proves that two mints in the SAME round share the per-round
  // headroom. A regression that recomputed headroom per-call (e.g. reset
  // totalRewardsMinted, or compared `amount` instead of the running total
  // against the cap) would pass every current test yet allow double-mint.
  // ---------------------------------------------------------------------
  describe("rewardMint cap is cumulative across multiple mints in one round", function () {
    it("two partial mints in the same round share one round's headroom; the second wei over the cap reverts", async function () {
      const { satori, rewards } = await deploySatoriFixture();
      const rewardsSigner = await asRewards(rewards);
      // The binding cap is the HUB's: its emission ceiling net of the
      // fee's flat 15%. The token's `1440 × rounds` sits outside it.
      const RATE = await satori.emissionRateNow();
      const BPS = await satori.devFeeBps();
      const genCap = (e) => (RATE * e * (10000n - BPS)) / 10000n;
      const recipient = (await ethers.getSigners())[5].address;

      // Drain whatever the deploy round has left, then advance one round so the
      // headroom under test is EXACTLY one round's share.
      const room0 = genCap(1n) - (await satori.onChainMinted());
      if (room0 > 0n) await satori.connect(rewardsSigner).rewardMint(recipient, room0);
      await time.increase(ROUND);
      const base = await satori.totalRewardsMinted();
      const perRound = genCap(2n) - genCap(1n);

      // First partial mint consumes part of the round's headroom.
      const part = perRound / 4n;
      await satori.connect(rewardsSigner).rewardMint(recipient, part);
      expect(await satori.totalRewardsMinted()).to.equal(base + part);

      // The REMAINING headroom for this round is (perRound - part). One wei more
      // than that must revert — proving the cap is checked against the running
      // total, not per-call.
      const remaining = perRound - part;
      await expect(
        satori.connect(rewardsSigner).rewardMint(recipient, remaining + 1n)
      ).to.be.revertedWithCustomError(satori, "BudgetExceeded");

      // Exactly the remaining headroom succeeds and saturates the round.
      await satori.connect(rewardsSigner).rewardMint(recipient, remaining);
      expect(await satori.totalRewardsMinted()).to.equal(base + perRound);

      // Now fully saturated for this round; any further mint reverts.
      await expect(
        satori.connect(rewardsSigner).rewardMint(recipient, 1n)
      ).to.be.revertedWithCustomError(satori, "BudgetExceeded");
    });
  });

  // ---------------------------------------------------------------------
  // rewardMint(to == address(0)) reverts (OZ ERC20 zero-address guard) AND
  // leaves the cap accounting untouched.
  //
  // Cap accounting does `totalRewardsMinted += amount` BEFORE `_mint`. If the
  // `_mint` revert did not roll the whole tx back (a future refactor caching
  // state), the cap would be silently consumed by a no-op mint, permanently
  // shrinking real emission headroom. Pin that the revert is atomic.
  // ---------------------------------------------------------------------
  describe("rewardMint to the zero address reverts atomically", function () {
    it("reverts and does NOT consume cap headroom", async function () {
      const { satori, rewards } = await deploySatoriFixture();
      const rewardsSigner = await asRewards(rewards);
      const RATE = await satori.emissionRateNow();
      const BPS = await satori.devFeeBps();
      const genCap = (e) => (RATE * e * (10000n - BPS)) / 10000n;
      const recipient = (await ethers.getSigners())[5].address;

      // Saturate the deploy round first, so the post-advance headroom is
      // EXACTLY one round's share and the full-headroom mint below is a tight
      // proof that the reverted zero-address call consumed nothing.
      const room0 = genCap(1n) - (await satori.onChainMinted());
      if (room0 > 0n) await satori.connect(rewardsSigner).rewardMint(recipient, room0);
      await time.increase(ROUND);
      const perRound = genCap(2n) - genCap(1n);
      const mintedBefore = await satori.totalRewardsMinted();
      const supplyBefore = await satori.totalSupply();

      // Within-headroom amount, but to the zero address -> OZ ERC20InvalidReceiver.
      await expect(
        satori.connect(rewardsSigner).rewardMint(ethers.ZeroAddress, perRound / 2n)
      ).to.be.reverted;

      // Accounting untouched by the reverted call.
      expect(await satori.totalRewardsMinted()).to.equal(mintedBefore);
      expect(await satori.totalSupply()).to.equal(supplyBefore);

      // The full round headroom is still available to a valid recipient.
      await satori.connect(rewardsSigner).rewardMint(recipient, perRound);
      expect(await satori.totalRewardsMinted()).to.equal(mintedBefore + perRound);
    });
  });

  // ---------------------------------------------------------------------
  // owner() is the ownerless address(0) signal (a deliberate "no central
  // authority" broadcast), decoupled from BOTH the admin role and the
  // constructor-set immutable PLATFORM_FEE_RECIPIENT recipient.
  //
  // owner() always returns address(0): it does not surface admin and is
  // unaffected by a setAdmin transfer. The operational admin role is read via
  // rewards.admin(). This guards the ownerless signal, the admin-role wiring,
  // and the immutable-recipient contract change in one place.
  // ---------------------------------------------------------------------
  describe("owner() is ownerless address(0); admin moves on setAdmin; recipient is immutable", function () {
    it("owner() returns address(0), ignores the admin transfer, and is decoupled from the immutable recipient", async function () {
      const { satori, rewards, owner, signers } = await deploySatoriFixture();
      const newAdmin = signers[8];
      // The platform fee moved to the immutable token as the senior dev fee, so
      // the recipient now lives on the TOKEN as token.PLATFORM_FEE_RECIPIENT()
      // (platform fee moved to immutable token — see test/next/DevFee.test.js).
      // Read it live rather than hardcode the fixture's chosen recipient.
      const RECIPIENT = await satori.PLATFORM_FEE_RECIPIENT();

      // Baseline: owner() is the ownerless constant; admin == fixture deployer.
      expect(await satori.owner()).to.equal(ethers.ZeroAddress);
      expect(await rewards.admin()).to.equal(owner.address);

      // The fee recipient is the constructor-set immutable recipient (non-zero).
      // It lives on the token now; there is no recipient setter or redirect path,
      // and rewards no longer exposes PLATFORM_FEE_RECIPIENT at all.
      expect(RECIPIENT).to.not.equal(ethers.ZeroAddress);
      expect(rewards.PLATFORM_FEE_RECIPIENT).to.equal(undefined); // moved off rewards
      expect(satori.setPlatformFeeRecipient).to.equal(undefined);
      expect(satori.wireFeeRecipient).to.equal(undefined);

      // Transfer the admin role -> the role moves on admin(); owner() stays
      // ownerless and the recipient is untouched.
      const recipientBefore = await satori.PLATFORM_FEE_RECIPIENT();
      await rewards.connect(owner).setAdmin(newAdmin.address);

      expect(await rewards.admin()).to.equal(newAdmin.address);
      expect(await satori.owner()).to.equal(ethers.ZeroAddress);
      // recipient is genuinely immutable: untouched by the admin transfer.
      expect(await satori.PLATFORM_FEE_RECIPIENT()).to.equal(recipientBefore);
      // owner() is the ownerless constant — never the admin, never the recipient.
      expect(await satori.owner()).to.not.equal(await rewards.admin());
      expect(await satori.owner()).to.not.equal(await satori.PLATFORM_FEE_RECIPIENT());
    });
  });

  // ---------------------------------------------------------------------
  // Token-level lock hooks (lockUntilNextRound / lockUntilUndelegation) are
  // strictly rewards-gated.
  //
  // These hooks write the very `lockedUntil` field that the transfer gate
  // enforces. If their access gate regressed, anyone could permanently freeze
  // (LOCKED_UNTIL_UNDELEGATION) any victim's balance — a pure griefing DoS.
  // The cov suite drives them only through the legitimate rewards path and
  // never asserts the unauthorized-caller revert at the token boundary.
  // ---------------------------------------------------------------------
  describe("lock hooks are rewards-only (no third-party freeze)", function () {
    it("rejects every non-rewards caller and leaves the victim unlocked & transferable", async function () {
      const { satori, token, rewards, voting, owner, signers } = await deploySatoriFixture();
      const attacker = signers[6];
      const victim = signers[7];

      // Fund the victim so a successful transfer is observable.
      await satori.transfer(victim.address, ethers.parseEther("10"));
      expect(await satori.lockedUntil(victim.address)).to.equal(0n);

      // Arbitrary attacker cannot freeze the victim via either hook.
      await expect(
        satori.connect(attacker).lockUntilUndelegation(victim.address)
      ).to.be.revertedWithCustomError(satori, "Unauthorized");
      await expect(
        satori.connect(attacker).lockUntilNextRound(victim.address)
      ).to.be.revertedWithCustomError(satori, "Unauthorized");

      // Even the deployer / admin holds no token-lock authority.
      await expect(
        satori.connect(owner).lockUntilUndelegation(victim.address)
      ).to.be.revertedWithCustomError(satori, "Unauthorized");

      // SatoriVoting (transfer-exempt elsewhere) is NOT the lock authority either.
      const votingAddr = await voting.getAddress();
      await impersonateAccount(votingAddr);
      await setBalance(votingAddr, ethers.parseEther("10"));
      const votingSigner = await ethers.getSigner(votingAddr);
      await expect(
        satori.connect(votingSigner).lockUntilUndelegation(victim.address)
      ).to.be.revertedWithCustomError(satori, "Unauthorized");

      // Victim never got locked and can still transfer freely.
      expect(await satori.lockedUntil(victim.address)).to.equal(0n);
      await expect(
        satori.connect(victim).transfer(owner.address, ethers.parseEther("1"))
      ).to.not.be.reverted;

      // Positive control: the wired rewards address CAN set the lock, proving
      // the gate is the authority check (not an unconditional revert).
      const rewardsSigner = await asRewards(rewards);
      const SENTINEL = await token.LOCK_INDEFINITE();
      await satori.connect(rewardsSigner).lockUntilUndelegation(victim.address);
      expect(await satori.lockedUntil(victim.address)).to.equal(SENTINEL);
    });
  });
});
