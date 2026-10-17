// airdrop-break.adv.test.js
//
// ADVERSARIAL break-testing for the AIRDROP (no vesting: the whole allocation,
// claimable CLAIM_DELAY after the loader finalizes the table —
// docs/issues/airdrop-claim-after-a-day.md).
//
// Target surface:
//   SatoriAirdrop.sol : loadAirdropBatch, finalizeAirdropLoading, claimsOpenAt,
//                       CLAIM_DELAY = 1 days, claimAirdrop, claimAirdropFor,
//                       claimAirdropForMany, claimableAirdrop, airdropAllocation,
//                       airdropClaimed, airdropClaimedTotal, airdropLoadedTotal,
//                       setAirdropAuthority, AIRDROP_TOTAL_SUPPLY
//   SatoriToken.sol   : airdropMint (gated msg.sender == token.airdrop),
//                       airdropMinted counter, cap AIRDROP_TOTAL_SUPPLY,
//                       SEPARATE from totalRewardsMinted / the 1440/round cap.
//
// Attacks encoded below (each an adversary trying to break an invariant):
//  A1  claim gate: before finalize (even years later), at claimsOpenAt-1, at
//      exactly claimsOpenAt — all three doors and the view; the day starts at
//      finalize, never at deploy or load
//  A2  finalize is write-once: claimsOpenAt cannot be moved (AlreadySet), not by
//      a rotated or recalled loader; a stranger cannot finalize
//  A3  OVER-LOAD LOCKOUT — load sum > cap; last claimers revert BudgetExceeded
//      while the core airdrop cap stays intact and the earlier claimers keep
//      funds; a claim that does not fit mints nothing partial
//  A4  guards: length mismatch / duplicate / zero-addr / zero-amount, intra-batch dup
//  A5  reentrancy on claim — plain ERC20, no claimer callback, CEI ordering
//  A6  mint-to-the-ALLOCATED-address only — no redirect; airdropMint gated
//  A7  loader-only loading and finalizing; rotation moves the right
//  A8  supply identity totalSupply() == totalRewardsMinted() + airdropMinted
//      under INTERLEAVED reward mints and airdrop claims
//  A9  loading after finalize is refused — for the loader, a rotated loader,
//      and a recalled one; during the day and long after
//  A10 claimableAirdrop view exactness vs a real claim, to the wei
//  A11 all-or-nothing: after a full claim every re-claim pays nothing, through
//      every door, later or racing in the same block
//  A12 airdrop mint must NOT eat into the per-round reward cap (both lanes at cap)
//
// ADDS a test file only; never edits a contract or an existing test.

const { expect } = require("chai");
const { ethers } = require("hardhat");
const {
  time,
  takeSnapshot,
  impersonateAccount,
  setBalance,
} = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture } = require("../fixtures");

const DAY = 24n * 3600n; // matches CLAIM_DELAY
const YEAR = 365n * DAY;
const E = (n) => ethers.parseEther(String(n));

// Impersonate a contract (the rewards child, the hub, the airdrop) so we can
// drive the gated mint doors directly as it.
async function asRewards(rewards) {
  const addr = await rewards.getAddress();
  await impersonateAccount(addr);
  await setBalance(addr, ethers.parseEther("100"));
  return await ethers.getSigner(addr);
}

describe("[adv] AIRDROP — whole allocation one day after finalize (SatoriAirdrop)", function () {
  this.timeout(600000);

  let satori, token, airdrop, rewards, owner, alice, bob, carol, dave, TOTAL;

  beforeEach(async function () {
    const fix = await deploySatoriFixture();
    ({ satori, token, airdrop, rewards, owner } = fix);
    [, alice, bob, carol, dave] = fix.signers;
    TOTAL = await airdrop.AIRDROP_TOTAL_SUPPLY();
  });

  async function openClaims() {
    await airdrop.connect(owner).finalizeAirdropLoading();
    await time.increase(DAY);
  }

  // ================================================================
  // A1 — the claim gate
  // ================================================================
  describe("A1 claim gate (before finalize, claimsOpenAt-1, claimsOpenAt)", function () {
    it("never finalized: years later every door still reverts ClaimsNotOpen and nothing mints", async function () {
      await airdrop.connect(owner).loadAirdropBatch([alice.address], [E(100000)]);
      await time.increase(10n * YEAR);
      expect(await airdrop.claimableAirdrop(alice.address)).to.equal(0n);
      await expect(airdrop.connect(alice).claimAirdrop())
        .to.be.revertedWithCustomError(airdrop, "ClaimsNotOpen");
      await expect(airdrop.connect(bob).claimAirdropFor(alice.address))
        .to.be.revertedWithCustomError(airdrop, "ClaimsNotOpen");
      await expect(airdrop.connect(bob).claimAirdropForMany([alice.address]))
        .to.be.revertedWithCustomError(airdrop, "ClaimsNotOpen");
      // The gate fires before the loop: not even an empty sweep gets through.
      await expect(airdrop.connect(bob).claimAirdropForMany([]))
        .to.be.revertedWithCustomError(airdrop, "ClaimsNotOpen");
      expect(await token.airdropMinted()).to.equal(0n);
      expect(await satori.balanceOf(alice.address)).to.equal(0n);
    });

    it("each door is shut at claimsOpenAt-1 and pays the WHOLE allocation at exactly claimsOpenAt", async function () {
      const alloc = E(250000) + 3n;
      await airdrop.connect(owner).loadAirdropBatch([alice.address], [alloc]);
      await airdrop.connect(owner).finalizeAirdropLoading();
      const opens = await airdrop.claimsOpenAt();

      const doors = {
        claimAirdrop: () => airdrop.connect(alice).claimAirdrop(),
        claimAirdropFor: () => airdrop.connect(bob).claimAirdropFor(alice.address),
        claimAirdropForMany: () => airdrop.connect(bob).claimAirdropForMany([alice.address]),
      };
      for (const [name, door] of Object.entries(doors)) {
        const snap = await takeSnapshot();
        await time.setNextBlockTimestamp(opens - 1n);
        await expect(door(), `${name} @opens-1`).to.be.revertedWithCustomError(airdrop, "ClaimsNotOpen");
        expect(await token.airdropMinted(), `${name} minted while shut`).to.equal(0n);

        await time.setNextBlockTimestamp(opens);
        await expect(door(), `${name} @opens`)
          .to.emit(airdrop, "AirdropClaimed").withArgs(alice.address, alloc);
        expect(await satori.balanceOf(alice.address), `${name} paid`).to.equal(alloc);
        expect(await satori.balanceOf(bob.address), `${name} caller`).to.equal(0n);
        await snap.restore();
      }

      // The view flips on the same second.
      await time.setNextBlockTimestamp(opens - 1n);
      await ethers.provider.send("evm_mine", []);
      expect(await airdrop.claimableAirdrop(alice.address)).to.equal(0n);
      await time.setNextBlockTimestamp(opens);
      await ethers.provider.send("evm_mine", []);
      expect(await airdrop.claimableAirdrop(alice.address)).to.equal(alloc);
    });

    it("the day starts at finalize: a long wait after deploy and after load buys nothing", async function () {
      await time.increase(30n * DAY);
      await airdrop.connect(owner).loadAirdropBatch([alice.address], [E(1000)]);
      await time.increase(30n * DAY);
      const tx = await airdrop.connect(owner).finalizeAirdropLoading();
      const at = BigInt((await ethers.provider.getBlock(tx.blockNumber)).timestamp);
      expect(await airdrop.claimsOpenAt()).to.equal(at + DAY);
      // One second after finalize — sixty days after deploy — still shut.
      await expect(airdrop.connect(alice).claimAirdrop())
        .to.be.revertedWithCustomError(airdrop, "ClaimsNotOpen");
    });
  });

  // ================================================================
  // A2 — finalize is write-once
  // ================================================================
  describe("A2 finalize is write-once: claimsOpenAt cannot be moved", function () {
    it("a second finalize reverts AlreadySet during the day and after claims open; claimsOpenAt is unchanged", async function () {
      await airdrop.connect(owner).loadAirdropBatch([alice.address], [E(1000)]);
      await airdrop.connect(owner).finalizeAirdropLoading();
      const opens = await airdrop.claimsOpenAt();

      await time.increase(DAY / 2n);
      await expect(airdrop.connect(owner).finalizeAirdropLoading())
        .to.be.revertedWithCustomError(airdrop, "AlreadySet");
      await time.increase(DAY);
      await expect(airdrop.connect(owner).finalizeAirdropLoading())
        .to.be.revertedWithCustomError(airdrop, "AlreadySet");
      expect(await airdrop.claimsOpenAt()).to.equal(opens);
      await airdrop.connect(alice).claimAirdrop();
      await expect(airdrop.connect(owner).finalizeAirdropLoading())
        .to.be.revertedWithCustomError(airdrop, "AlreadySet");
      expect(await airdrop.claimsOpenAt()).to.equal(opens);
    });

    it("a rotated loader, or one recalled by the appoint authority, cannot re-finalize to push claims later", async function () {
      await airdrop.connect(owner).loadAirdropBatch([alice.address], [E(1000)]);
      await airdrop.connect(owner).finalizeAirdropLoading();
      const opens = await airdrop.claimsOpenAt();

      await airdrop.connect(owner).setAirdropAuthority(carol.address);
      await expect(airdrop.connect(carol).finalizeAirdropLoading())
        .to.be.revertedWithCustomError(airdrop, "AlreadySet");
      // owner still holds token.appointAuthority (the fixture seeds every slot).
      await airdrop.connect(owner).setAirdropAuthority(dave.address);
      await expect(airdrop.connect(dave).finalizeAirdropLoading())
        .to.be.revertedWithCustomError(airdrop, "AlreadySet");
      expect(await airdrop.claimsOpenAt()).to.equal(opens);

      await time.setNextBlockTimestamp(opens);
      await airdrop.connect(alice).claimAirdrop();
      expect(await satori.balanceOf(alice.address)).to.equal(E(1000));
    });

    it("a stranger cannot finalize — neither to open claims early nor to freeze a half-loaded table", async function () {
      await airdrop.connect(owner).loadAirdropBatch([alice.address], [E(1000)]);
      for (const who of [alice, bob]) {
        await expect(airdrop.connect(who).finalizeAirdropLoading())
          .to.be.revertedWithCustomError(airdrop, "Unauthorized");
      }
      expect(await airdrop.claimsOpenAt()).to.equal(0n);
      expect(await airdrop.airdropLoadingFinalized()).to.equal(false);
      // Loading is still open for the loader.
      await airdrop.connect(owner).loadAirdropBatch([bob.address], [E(1)]);
    });

    it("finalizing an EMPTY table closes it empty for good: every claim pays nothing", async function () {
      await openClaims();
      await expect(airdrop.connect(owner).loadAirdropBatch([alice.address], [E(1)]))
        .to.be.revertedWithCustomError(airdrop, "AirdropLoadingClosed");
      await expect(airdrop.connect(alice).claimAirdrop())
        .to.be.revertedWithCustomError(airdrop, "NothingToClaim");
      expect(await airdrop.connect(bob).claimAirdropForMany.staticCall([alice.address, bob.address]))
        .to.equal(0n);
      expect(await token.airdropMinted()).to.equal(0n);
    });
  });

  // ================================================================
  // A3 — OVER-LOAD LOCKOUT: last claimers revert, cap holds, earlier claims safe
  // ================================================================
  describe("A3 over-load lockout (Σ load > cap)", function () {
    it("loads 1.5x cap across 3; first two drain the cap, third is locked out by the core", async function () {
      const half = TOTAL / 2n;
      // Three recipients each allocated half the cap => Σ = 1.5x cap.
      await airdrop.connect(owner).loadAirdropBatch(
        [alice.address, bob.address, carol.address],
        [half, half, half]
      );
      expect(await airdrop.airdropLoadedTotal()).to.equal((TOTAL * 3n) / 2n);
      await openClaims();

      // Alice + Bob claim: airdropMinted goes 0 -> half -> TOTAL (exactly at cap).
      await airdrop.connect(alice).claimAirdrop();
      await airdrop.connect(bob).claimAirdrop();
      expect(await airdrop.airdropClaimedTotal()).to.equal(TOTAL);
      expect(await satori.balanceOf(alice.address)).to.equal(half);
      expect(await satori.balanceOf(bob.address)).to.equal(half);

      // Carol's claim would push airdropMinted to 1.5x cap -> the core's
      // airdropMint cap must reject it.
      await expect(airdrop.connect(carol).claimAirdrop()).to.be.revertedWithCustomError(
        satori,
        "BudgetExceeded"
      );

      // The cap held: airdropClaimedTotal is still exactly TOTAL, and carol's
      // cursor stayed 0 (the whole tx reverted).
      expect(await airdrop.airdropClaimedTotal()).to.equal(TOTAL);
      expect(await airdrop.airdropClaimed(carol.address)).to.equal(0n);
      // Alice + Bob keep their funds; no clawback.
      expect(await satori.balanceOf(alice.address)).to.equal(half);
      expect(await satori.balanceOf(bob.address)).to.equal(half);
    });

    it("a locked-out claim mints NOTHING partial even with headroom left, and one such row fails a whole sweep", async function () {
      // Σ = TOTAL + 4: after alice, 10 SATORI of headroom remain. Dave (4) fits;
      // bob (10) fits only if he goes before dave.
      await airdrop.connect(owner).loadAirdropBatch(
        [alice.address, dave.address, bob.address],
        [TOTAL - E(10), E(4), E(10)]
      );
      await openClaims();
      await airdrop.connect(alice).claimAirdrop();

      // A sweep that reaches bob after dave reverts as a unit: dave is not paid
      // either. ForMany skips only rows with nothing owed, not rows over the cap.
      await expect(airdrop.connect(carol).claimAirdropForMany([dave.address, bob.address]))
        .to.be.revertedWithCustomError(token, "BudgetExceeded");
      expect(await satori.balanceOf(dave.address)).to.equal(0n);

      await airdrop.connect(carol).claimAirdropForMany([dave.address]);
      expect(await satori.balanceOf(dave.address)).to.equal(E(4));

      // 6 SATORI of headroom, bob is owed 10: every door refuses, nothing partial.
      await expect(airdrop.connect(bob).claimAirdrop())
        .to.be.revertedWithCustomError(token, "BudgetExceeded");
      await expect(airdrop.connect(carol).claimAirdropFor(bob.address))
        .to.be.revertedWithCustomError(token, "BudgetExceeded");
      await expect(airdrop.connect(carol).claimAirdropForMany([bob.address]))
        .to.be.revertedWithCustomError(token, "BudgetExceeded");
      expect(await satori.balanceOf(bob.address)).to.equal(0n);
      expect(await airdrop.airdropClaimed(bob.address)).to.equal(0n);
      expect(await airdrop.claimableAirdrop(bob.address)).to.equal(E(10));
      // The leftover headroom stays unminted; the cap is never crossed.
      expect(await token.airdropMinted()).to.equal(TOTAL - E(6));
    });
  });

  // ================================================================
  // A4 — guards
  // ================================================================
  describe("A4 load guards (length/dup/zero-addr/zero-amount)", function () {
    it("length mismatch reverts", async function () {
      await expect(
        airdrop.connect(owner).loadAirdropBatch([alice.address, bob.address], [E(1)])
      ).to.be.revertedWithCustomError(airdrop, "LengthMismatch");
    });

    it("zero address reverts BadInput", async function () {
      await expect(
        airdrop.connect(owner).loadAirdropBatch([ethers.ZeroAddress], [E(1)])
      ).to.be.revertedWithCustomError(airdrop, "BadInput");
    });

    it("zero amount reverts BadInput", async function () {
      await expect(
        airdrop.connect(owner).loadAirdropBatch([alice.address], [0n])
      ).to.be.revertedWithCustomError(airdrop, "BadInput");
    });

    it("duplicate across batches reverts DuplicateRecipient and does NOT overwrite", async function () {
      await airdrop.connect(owner).loadAirdropBatch([alice.address], [E(100)]);
      await expect(
        airdrop.connect(owner).loadAirdropBatch([alice.address], [E(999999)])
      ).to.be.revertedWithCustomError(airdrop, "DuplicateRecipient");
      // Allocation unchanged — no silent overwrite / top-up.
      expect(await airdrop.airdropAllocation(alice.address)).to.equal(E(100));
    });

    it("INTRA-batch duplicate reverts atomically — no partial load, loadedTotal unchanged", async function () {
      const before = await airdrop.airdropLoadedTotal();
      await expect(
        airdrop.connect(owner).loadAirdropBatch(
          [alice.address, bob.address, alice.address],
          [E(1), E(2), E(3)]
        )
      ).to.be.revertedWithCustomError(airdrop, "DuplicateRecipient");
      // The whole batch reverted atomically: no allocation stuck, total unmoved.
      expect(await airdrop.airdropAllocation(alice.address)).to.equal(0n);
      expect(await airdrop.airdropAllocation(bob.address)).to.equal(0n);
      expect(await airdrop.airdropLoadedTotal()).to.equal(before);
    });

    it("empty batch is a no-op (no revert, loadedTotal unchanged)", async function () {
      const before = await airdrop.airdropLoadedTotal();
      await airdrop.connect(owner).loadAirdropBatch([], []);
      expect(await airdrop.airdropLoadedTotal()).to.equal(before);
    });
  });

  // ================================================================
  // A5 — reentrancy / CEI ordering on claim
  // ================================================================
  describe("A5 reentrancy & CEI on claimAirdrop", function () {
    it("no claimer callback exists — a CONTRACT recipient is paid exactly its allocation, once", async function () {
      // claimAirdrop -> token.airdropMint -> _mint(to, amount), from ==
      // address(0). ERC20 _mint has no recipient hook (no ERC777/1363
      // callback), so a contract recipient has no lever to re-enter mid-mint.
      const alloc = E(400000);
      const factory = await ethers.getContractFactory("SatoriRewardsLens");
      const dummy = await factory.deploy(await satori.getAddress(), await rewards.getAddress());
      await dummy.waitForDeployment();
      const dummyAddr = await dummy.getAddress();

      await airdrop.connect(owner).loadAirdropBatch([dummyAddr, alice.address], [alloc, alloc]);
      await openClaims();

      // The contract cannot call claimAirdrop for itself; the sponsored door
      // pays it, to the wei, with no extra mint.
      await expect(airdrop.connect(bob).claimAirdropFor(dummyAddr))
        .to.emit(airdrop, "AirdropClaimed").withArgs(dummyAddr, alloc);
      expect(await satori.balanceOf(dummyAddr)).to.equal(alloc);
      await expect(airdrop.connect(bob).claimAirdropFor(dummyAddr))
        .to.be.revertedWithCustomError(airdrop, "NothingToClaim");

      const balBefore = await satori.balanceOf(alice.address);
      await airdrop.connect(alice).claimAirdrop();
      expect((await satori.balanceOf(alice.address)) - balBefore).to.equal(alloc);
      expect(await airdrop.airdropClaimedTotal()).to.equal(alloc * 2n);
    });

    it("CEI: once claimed == alloc, any re-claim reverts — the allocation can't be re-taken", async function () {
      const alloc = E(400000);
      await airdrop.connect(owner).loadAirdropBatch([alice.address], [alloc]);
      await openClaims();
      await airdrop.connect(alice).claimAirdrop();
      expect(await airdrop.airdropClaimed(alice.address)).to.equal(alloc);
      await expect(airdrop.connect(alice).claimAirdrop()).to.be.revertedWithCustomError(airdrop,
        "NothingToClaim"
      );
      expect(await airdrop.airdropClaimed(alice.address)).to.equal(alloc);
    });
  });

  // ================================================================
  // A6 — mint-to-the-allocated-address ONLY (no redirect) + airdropMint gating
  // ================================================================
  describe("A6 mint-to-the-ALLOCATED-address-only / airdropMint gating", function () {
    // The property that matters: a claim credits the ALLOCATED address, and
    // nobody can steer it anywhere else — least of all to themselves — with or
    // without the on-behalf doors the launch sweep uses.
    it("nobody can harvest alice's alloc TO THEMSELVES, with or without the on-behalf door", async function () {
      const alloc = E(200000);
      await airdrop.connect(owner).loadAirdropBatch([alice.address], [alloc]);
      await openClaims();

      // Bob is unallocated. Self-claiming mints him nothing.
      await expect(airdrop.connect(bob).claimAirdrop()).to.be.revertedWithCustomError(airdrop,
        "NothingToClaim"
      );
      expect(await satori.balanceOf(bob.address)).to.equal(0n);

      // Bob CAN name alice as the beneficiary — and the tokens go to ALICE.
      // He pays gas and receives nothing.
      await airdrop.connect(bob).claimAirdropFor(alice.address);
      expect(await satori.balanceOf(alice.address)).to.equal(alloc);
      expect(await satori.balanceOf(bob.address)).to.equal(0n);

      // Nor can he route it through the batch form.
      await airdrop.connect(bob).claimAirdropForMany([alice.address, bob.address]);
      expect(await satori.balanceOf(bob.address)).to.equal(0n);
      expect(await satori.balanceOf(alice.address)).to.equal(alloc);
    });

    it("airdropMint is callable ONLY by the airdrop contract (EOA / owner / the hub cannot mint)", async function () {
      await expect(
        token.connect(alice).airdropMint(alice.address, 1n)
      ).to.be.revertedWithCustomError(token, "Unauthorized");
      await expect(
        token.connect(owner).airdropMint(owner.address, 1n)
      ).to.be.revertedWithCustomError(token, "Unauthorized");
      // Even minting to self as an arbitrary recipient is blocked.
      await expect(
        token.connect(bob).airdropMint(bob.address, await token.AIRDROP_TOTAL_SUPPLY())
      ).to.be.revertedWithCustomError(token, "Unauthorized");
      // The hub is the controller; the airdrop door is not the controller's.
      const hubSigner = await asRewards(satori);
      await expect(
        token.connect(hubSigner).airdropMint(bob.address, 1n)
      ).to.be.revertedWithCustomError(token, "Unauthorized");
    });

    it("the airdrop contract CAN airdropMint to ANY address, but only via the claim path in practice; direct mint respects cap", async function () {
      // Impersonating the airdrop address, a direct airdropMint past the cap
      // reverts — the token cap is enforced regardless of the caller.
      const ad = await asRewards(airdrop);
      await expect(
        token.connect(ad).airdropMint(alice.address, TOTAL + 1n)
      ).to.be.revertedWithCustomError(token, "BudgetExceeded");
    });
  });

  // ================================================================
  // A7 — loader-only loading and finalizing, loader rotation
  // ================================================================
  describe("A7 loader-only loading", function () {
    it("non-loader cannot load or finalize", async function () {
      await expect(
        airdrop.connect(alice).loadAirdropBatch([alice.address], [E(1)])
      ).to.be.revertedWithCustomError(airdrop, "Unauthorized");
      await expect(
        airdrop.connect(alice).finalizeAirdropLoading()
      ).to.be.revertedWithCustomError(airdrop, "Unauthorized");
    });

    it("rotating the loader moves the loading and finalizing right; the rewards admin has no say", async function () {
      // The loader is its own role on SatoriAirdrop. Rotating the REWARDS admin
      // does nothing to it.
      await rewards.connect(owner).setAdmin(carol.address);
      await airdrop.connect(owner).loadAirdropBatch([dave.address], [E(1)]);
      await expect(
        airdrop.connect(carol).loadAirdropBatch([bob.address], [E(1)])
      ).to.be.revertedWithCustomError(airdrop, "Unauthorized");
      // Rotate the loader to alice; owner loses the right, alice gains it.
      await airdrop.connect(owner).setAirdropAuthority(alice.address);
      await expect(
        airdrop.connect(owner).loadAirdropBatch([bob.address], [E(1)])
      ).to.be.revertedWithCustomError(airdrop, "Unauthorized");
      await expect(
        airdrop.connect(owner).finalizeAirdropLoading()
      ).to.be.revertedWithCustomError(airdrop, "Unauthorized");
      await airdrop.connect(alice).loadAirdropBatch([bob.address], [E(1)]);
      expect(await airdrop.airdropAllocation(bob.address)).to.equal(E(1));
      await airdrop.connect(alice).finalizeAirdropLoading();
      expect(await airdrop.airdropLoadingFinalized()).to.equal(true);
    });
  });

  // ================================================================
  // A8 — supply identity under INTERLEAVED reward mints + airdrop claims
  // ================================================================
  describe("A8 supply identity: totalSupply == totalRewardsMinted + airdropMinted (interleaved)", function () {
    it("holds after arbitrarily interleaved rewardMints and airdrop claims across rounds", async function () {
      const rw = await asRewards(rewards);
      // Load two recipients, summing to less than the cap.
      await airdrop.connect(owner).loadAirdropBatch(
        [alice.address, bob.address],
        [E(600000), E(400000)]
      );

      // airdropClaimedTotal is the airdrop's public read of token.airdropMinted.
      const identity = async () => {
        const supply = await satori.totalSupply();
        const rmint = await satori.totalRewardsMinted();
        const amint = await airdrop.airdropClaimedTotal();
        expect(supply).to.equal(rmint + amint);
      };

      await identity();
      await expect(airdrop.connect(alice).claimAirdrop())
        .to.be.revertedWithCustomError(airdrop, "ClaimsNotOpen");
      await identity();

      // The genesis INITIAL_MINT already fills the round-0 on-chain reward lane,
      // so advance a round to open fresh reward budget before the first
      // rewardMint. The same day opens the airdrop claims.
      await airdrop.connect(owner).finalizeAirdropLoading();
      await time.increase(86400); // one full 24h round
      await satori.connect(rw).rewardMint(carol.address, E(10));
      await identity();
      await airdrop.connect(alice).claimAirdrop();
      await identity();

      // Advance another round; another rewardMint (fresh budget), then bob claims.
      await time.increase(86400); // one full 24h round
      await satori.connect(rw).rewardMint(dave.address, E(50));
      await identity();
      await airdrop.connect(bob).claimAirdrop();
      await identity();

      // A transfer must NOT change totalSupply nor break the identity.
      await satori.connect(alice).transfer(carol.address, 1n).catch(() => {});
      await identity();

      // A sponsored re-sweep pays nothing; identity still exact.
      await airdrop.connect(carol).claimAirdropForMany([alice.address, bob.address]);
      await identity();
      // The airdrop lane summed to exactly the LOADED total — which is what
      // this claims, and is not the cap.
      expect(await airdrop.airdropClaimedTotal()).to.equal(await airdrop.airdropLoadedTotal());
      expect(await airdrop.airdropClaimedTotal()).to.equal(E(600000) + E(400000));
    });
  });

  // ================================================================
  // A9 — loading after finalize is refused, whoever holds the loader role
  // ================================================================
  describe("A9 loading after finalize is refused", function () {
    it("the loader cannot add a recipient during the day, after claims open, or years later", async function () {
      await airdrop.connect(owner).loadAirdropBatch([alice.address], [E(1000)]);
      await airdrop.connect(owner).finalizeAirdropLoading();
      const loaded = await airdrop.airdropLoadedTotal();

      const tryLoad = () => airdrop.connect(owner).loadAirdropBatch([bob.address], [E(1)]);
      await expect(tryLoad()).to.be.revertedWithCustomError(airdrop, "AirdropLoadingClosed");
      await time.increase(DAY);
      await expect(tryLoad()).to.be.revertedWithCustomError(airdrop, "AirdropLoadingClosed");
      await airdrop.connect(alice).claimAirdrop();
      await time.increase(5n * YEAR);
      await expect(tryLoad()).to.be.revertedWithCustomError(airdrop, "AirdropLoadingClosed");

      expect(await airdrop.airdropAllocation(bob.address)).to.equal(0n);
      expect(await airdrop.airdropLoadedTotal()).to.equal(loaded);
    });

    it("the closed gate fires before any other guard: an empty batch, a top-up of an existing row, a bad batch", async function () {
      await airdrop.connect(owner).loadAirdropBatch([alice.address], [E(1000)]);
      await airdrop.connect(owner).finalizeAirdropLoading();
      await expect(airdrop.connect(owner).loadAirdropBatch([], []))
        .to.be.revertedWithCustomError(airdrop, "AirdropLoadingClosed");
      await expect(airdrop.connect(owner).loadAirdropBatch([alice.address], [E(999999)]))
        .to.be.revertedWithCustomError(airdrop, "AirdropLoadingClosed");
      await expect(airdrop.connect(owner).loadAirdropBatch([bob.address, carol.address], [E(1)]))
        .to.be.revertedWithCustomError(airdrop, "AirdropLoadingClosed");
      expect(await airdrop.airdropAllocation(alice.address)).to.equal(E(1000));
    });

    it("rotating or recalling the loader after finalize does not reopen loading", async function () {
      await airdrop.connect(owner).loadAirdropBatch([alice.address], [E(1000)]);
      await airdrop.connect(owner).finalizeAirdropLoading();

      await airdrop.connect(owner).setAirdropAuthority(carol.address);
      await expect(airdrop.connect(carol).loadAirdropBatch([carol.address], [TOTAL]))
        .to.be.revertedWithCustomError(airdrop, "AirdropLoadingClosed");

      // Move the token's appoint authority to bob and let him recall the role.
      await token.connect(owner).setAppointAuthority(bob.address);
      await airdrop.connect(bob).setAirdropAuthority(dave.address);
      await expect(airdrop.connect(dave).loadAirdropBatch([dave.address], [TOTAL]))
        .to.be.revertedWithCustomError(airdrop, "AirdropLoadingClosed");

      await time.increase(DAY);
      await expect(airdrop.connect(carol).claimAirdrop())
        .to.be.revertedWithCustomError(airdrop, "NothingToClaim");
      await expect(airdrop.connect(dave).claimAirdrop())
        .to.be.revertedWithCustomError(airdrop, "NothingToClaim");
      expect(await airdrop.airdropLoadedTotal()).to.equal(E(1000));
    });
  });

  // ================================================================
  // A10 — claimableAirdrop view exactness
  // ================================================================
  describe("A10 view exactness", function () {
    it("claimableAirdrop is 0 while shut, the exact allocation once open, exactly what the claim mints, then 0", async function () {
      // Odd wei on every row: the whole allocation must arrive to the wei.
      const amts = [E(333333) + 7n, 1n, E(800000) + 123456789n];
      const who = [alice, bob, carol];
      await airdrop.connect(owner).loadAirdropBatch(who.map((w) => w.address), amts);

      for (const w of who) expect(await airdrop.claimableAirdrop(w.address)).to.equal(0n);
      await airdrop.connect(owner).finalizeAirdropLoading();
      for (const w of who) expect(await airdrop.claimableAirdrop(w.address)).to.equal(0n);
      await time.increase(DAY);

      // The sweep's dry-run quote equals the sum of the views.
      let viewSum = 0n;
      for (let i = 0; i < who.length; i++) {
        const view = await airdrop.claimableAirdrop(who[i].address);
        expect(view, `view r${i}`).to.equal(amts[i]);
        viewSum += view;
      }
      expect(await airdrop.connect(dave).claimAirdropForMany.staticCall(who.map((w) => w.address)))
        .to.equal(viewSum);

      for (let i = 0; i < who.length; i++) {
        const before = await satori.balanceOf(who[i].address);
        await airdrop.connect(who[i]).claimAirdrop();
        expect((await satori.balanceOf(who[i].address)) - before, `minted r${i}`).to.equal(amts[i]);
        expect(await airdrop.airdropClaimed(who[i].address), `cursor r${i}`).to.equal(amts[i]);
        expect(await airdrop.claimableAirdrop(who[i].address), `left r${i}`).to.equal(0n);
      }
      expect(await airdrop.airdropClaimedTotal()).to.equal(viewSum);
      expect(await airdrop.claimableAirdrop(dave.address)).to.equal(0n);
    });
  });

  // ================================================================
  // A11 — all-or-nothing: re-claim idempotency
  // ================================================================
  describe("A11 re-claim idempotency (all-or-nothing)", function () {
    it("after a full claim, every door pays nothing — immediately and years later", async function () {
      const alloc = E(300000);
      await airdrop.connect(owner).loadAirdropBatch([alice.address], [alloc]);
      await openClaims();
      await airdrop.connect(alice).claimAirdrop();
      const totalAfter = await airdrop.airdropClaimedTotal();

      for (const later of [0n, DAY, 10n * YEAR]) {
        await time.increase(later + 1n);
        await expect(airdrop.connect(alice).claimAirdrop())
          .to.be.revertedWithCustomError(airdrop, "NothingToClaim");
        await expect(airdrop.connect(bob).claimAirdropFor(alice.address))
          .to.be.revertedWithCustomError(airdrop, "NothingToClaim");
        await expect(airdrop.connect(bob).claimAirdropForMany([alice.address]))
          .to.not.emit(airdrop, "AirdropClaimed");
        expect(await airdrop.claimableAirdrop(alice.address)).to.equal(0n);
      }
      expect(await airdrop.airdropClaimedTotal()).to.equal(totalAfter);
      expect(await satori.balanceOf(alice.address)).to.equal(alloc);
    });

    it("a self-claim, a sponsored claim and a sweep racing in ONE block pay exactly once", async function () {
      const alloc = E(600000);
      await airdrop.connect(owner).loadAirdropBatch([alice.address], [alloc]);
      await openClaims();

      // Explicit gas limits: estimation against the pending block would see the
      // first claim and refuse to send the others.
      const gas = { gasLimit: 500000 };
      await ethers.provider.send("evm_setAutomine", [false]);
      let txs;
      try {
        txs = [
          await airdrop.connect(alice).claimAirdrop(gas),
          await airdrop.connect(bob).claimAirdropFor(alice.address, gas),
          await airdrop.connect(carol).claimAirdropForMany([alice.address], gas),
        ];
        await ethers.provider.send("evm_mine", []);
      } finally {
        await ethers.provider.send("evm_setAutomine", [true]);
      }

      const receipts = await Promise.all(txs.map((t) => ethers.provider.getTransactionReceipt(t.hash)));
      expect(new Set(receipts.map((r) => r.blockNumber)).size, "one block").to.equal(1);
      const claimEvents = receipts.flatMap((r) => r.logs)
        .map((l) => { try { return airdrop.interface.parseLog(l); } catch { return null; } })
        .filter((p) => p && p.name === "AirdropClaimed");
      expect(claimEvents.length, "paid once").to.equal(1);
      expect(claimEvents[0].args.amount).to.equal(alloc);
      // The sweep never reverts on an already-paid row; the single-claim doors
      // that lost the race revert NothingToClaim.
      expect(receipts[2].status, "sweep").to.equal(1);
      expect(await satori.balanceOf(alice.address)).to.equal(alloc);
      expect(await satori.balanceOf(bob.address)).to.equal(0n);
      expect(await satori.balanceOf(carol.address)).to.equal(0n);
      expect(await airdrop.airdropClaimedTotal()).to.equal(alloc);
    });
  });

  // ================================================================
  // A12 — airdrop mint must NOT consume the per-round reward budget
  // ================================================================
  describe("A12 airdrop lane is walled off from the per-round reward cap", function () {
    it("a full airdrop claim does NOT reduce the on-chain reward headroom for the round", async function () {
      const rw = await asRewards(rewards);
      // Load alice for a big slice.
      await airdrop.connect(owner).loadAirdropBatch([alice.address], [E(500000)]);
      await openClaims();

      // Snapshot the reward lane before the airdrop claim.
      const rmintBefore = await satori.totalRewardsMinted();
      const onChainMintBefore = await satori.onChainMinted();

      // Claim 500k SATORI of airdrop.
      await airdrop.connect(alice).claimAirdrop();

      // The reward lane counters are UNTOUCHED by the airdrop mint.
      expect(await satori.totalRewardsMinted()).to.equal(rmintBefore);
      expect(await satori.onChainMinted()).to.equal(onChainMintBefore);

      // And the on-chain reward ceiling is unchanged — the airdrop didn't eat
      // into the round budget.
      const ceiling = await satori.onChainRewardCeiling();
      const headroom = ceiling - (await satori.onChainMinted());
      expect(headroom).to.be.gt(0n);

      // Sanity: a rewardMint up to the remaining headroom still succeeds AFTER
      // a 500k airdrop mint — proving the airdrop didn't steal reward budget.
      await satori.connect(rw).rewardMint(bob.address, headroom);
      expect(await satori.totalRewardsMinted()).to.equal(rmintBefore + headroom);
      // One wei more than the ceiling now reverts (lane is exactly full).
      await expect(
        satori.connect(rw).rewardMint(bob.address, 1n)
      ).to.be.revertedWithCustomError(satori, "BudgetExceeded");
    });

    it("reward lane at its cap does NOT block an airdrop claim (independent budgets)", async function () {
      const rw = await asRewards(rewards);
      await airdrop.connect(owner).loadAirdropBatch([alice.address], [E(250000)]);
      await openClaims();

      // Fill the on-chain reward lane to its current ceiling, in the same round
      // the claim lands in.
      const ceiling = await satori.onChainRewardCeiling();
      const headroom = ceiling - (await satori.onChainMinted());
      if (headroom > 0n) {
        await satori.connect(rw).rewardMint(carol.address, headroom);
      }
      // Reward lane is now full: a further rewardMint reverts.
      await expect(
        satori.connect(rw).rewardMint(carol.address, 1n)
      ).to.be.revertedWithCustomError(satori, "BudgetExceeded");

      // The airdrop, on its OWN lane, still works despite the reward cap being hit.
      const rmintBefore = await satori.totalRewardsMinted();
      await airdrop.connect(alice).claimAirdrop();
      expect(await satori.balanceOf(alice.address)).to.equal(E(250000));
      // The airdrop mint did not touch the reward counter — it stayed at the cap.
      expect(await satori.totalRewardsMinted()).to.equal(rmintBefore);
      // The airdrop lane advanced by exactly the claimed amount.
      expect(await airdrop.airdropClaimedTotal()).to.equal(E(250000));
    });
  });
});
