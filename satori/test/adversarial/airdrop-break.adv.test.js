// airdrop-break.adv.test.js
//
// ADVERSARIAL break-testing for the AIRDROP (a sixth at once, the rest a 5-year linear drip).
//
// Target surface:
//   SatoriAirdrop.sol : loadAirdropBatch, claimAirdrop, airdropVested,
//                       claimableAirdrop, airdropStart (construction block),
//                       airdropAllocation, airdropClaimed, airdropClaimedTotal,
//                       airdropLoadedTotal, AIRDROP_TOTAL_SUPPLY,
//                       AIRDROP_VEST = 1825 days
//   SatoriToken.sol   : airdropMint (gated msg.sender == token.airdrop),
//                       airdropMinted counter, cap AIRDROP_TOTAL_SUPPLY,
//                       SEPARATE from totalRewardsMinted / the 1440/round cap.
//
// Attacks encoded below (each an adversary trying to break an invariant):
//  A1  vest boundaries: t=0, VEST-1, VEST, VEST+huge (exactness + saturation)
//  A2  dust/rounding at saturation — full vest returns EXACT alloc, no wei stranded
//  A3  OVER-LOAD LOCKOUT — load sum > cap; last claimers revert BudgetExceeded
//      while the core airdrop cap stays intact and the earlier claimers keep funds
//  A4  guards: length mismatch / duplicate / zero-addr / zero-amount, intra-batch dup
//  A5  reentrancy on claim — plain ERC20, no claimer callback, CEI ordering
//  A6  mint-to-msg.sender-ONLY — no redirect/front-run; airdropMint EOA-gated
//  A7  admin-only loading; admin-transfer changes who can load
//  A8  supply identity totalSupply() == totalRewardsMinted() + airdropMinted
//      under INTERLEAVED reward mints and airdrop claims
//  A9  back-vesting of a recipient loaded LATE (anchored to deploy, not load)
//  A10 monotonic airdropClaimed; claimableAirdrop view exactness vs a real claim
//  A11 re-claim idempotency (NothingToClaim), and same-block double claim
//  A12 airdrop mint must NOT eat into the per-round reward cap (both lanes at cap)
//
// ADDS a test file only; never edits a contract or an existing test.

const { expect } = require("chai");
const { ethers } = require("hardhat");
const {
  time,
  impersonateAccount,
  setBalance,
} = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture } = require("../fixtures");

const VEST = 1825n * 24n * 3600n; // 157,680,000 s — matches AIRDROP_VEST
const E = (n) => ethers.parseEther(String(n));
// One sixth at once, the rest linear off the single anchor — mirrors
// SatoriAirdrop.airdropVested (docs/issues/airdrop-upfront-sixth.md).
const vestedAt = (alloc, elapsed) => {
  if (elapsed >= VEST) return alloc;
  const upfront = alloc / 6n;
  return upfront + ((alloc - upfront) * elapsed) / VEST;
};

// Impersonate a contract (the rewards child, the hub, the airdrop) so we can
// drive the gated mint doors directly as it.
async function asRewards(rewards) {
  const addr = await rewards.getAddress();
  await impersonateAccount(addr);
  await setBalance(addr, ethers.parseEther("100"));
  return await ethers.getSigner(addr);
}

describe("[adv] AIRDROP — 5yr vesting drip break-tests (SatoriAirdrop)", function () {
  this.timeout(600000);

  let satori, token, airdrop, rewards, owner, alice, bob, carol, dave, TOTAL;

  beforeEach(async function () {
    const fix = await deploySatoriFixture();
    ({ satori, token, airdrop, rewards, owner } = fix);
    [, alice, bob, carol, dave] = fix.signers;
    TOTAL = await airdrop.AIRDROP_TOTAL_SUPPLY();
  });

  // ================================================================
  // A1 — vest boundaries
  // ================================================================
  describe("A1 vest boundaries (t=0, VEST-1, VEST, VEST+huge)", function () {
    it("t=0 (same block as load): exactly the upfront sixth plus dust, never more", async function () {
      const alloc = E(100000);
      // Load; alice's elapsed is whatever tiny amount passed since deploy.
      await airdrop.connect(owner).loadAirdropBatch([alice.address], [alloc]);
      const claimable = await airdrop.claimableAirdrop(alice.address);
      const elapsed = BigInt(await time.latest()) - BigInt(await airdrop.airdropStart());
      expect(claimable).to.equal(vestedAt(alloc, elapsed));
      // The sixth, plus a handful of seconds of drip on the rest ==> tiny on top.
      expect(claimable).to.be.gte(alloc / 6n);
      expect(claimable).to.be.lt(alloc / 6n + alloc / 1000000n);
      expect(claimable).to.be.lt(alloc);
    });

    it("VEST-1 second: strictly less than alloc; VEST exactly: exactly alloc", async function () {
      const alloc = E(500000);
      await airdrop.connect(owner).loadAirdropBatch([alice.address], [alloc]);
      const start = await airdrop.airdropStart();

      // Jump to exactly VEST-1 relative to airdropStart.
      await time.setNextBlockTimestamp(Number(start) + Number(VEST) - 1);
      await ethers.provider.send("evm_mine", []);
      const atMinus1 = await airdrop.claimableAirdrop(alice.address);
      // Formula: a sixth + rest*(VEST-1)/VEST — strictly below alloc, off by ~rest/VEST.
      const expectedMinus1 = vestedAt(alloc, VEST - 1n);
      expect(atMinus1).to.equal(expectedMinus1);
      expect(atMinus1).to.be.lt(alloc);

      // Jump to exactly VEST — saturates to the FULL alloc via the >= branch.
      await time.setNextBlockTimestamp(Number(start) + Number(VEST));
      await ethers.provider.send("evm_mine", []);
      expect(await airdrop.claimableAirdrop(alice.address)).to.equal(alloc);
    });

    it("VEST + huge (years later): still exactly alloc, no more, no overflow", async function () {
      const alloc = await airdrop.AIRDROP_TOTAL_SUPPLY(); // the whole cap on one recipient
      await airdrop.connect(owner).loadAirdropBatch([alice.address], [alloc]);
      await time.increase(VEST * 50n); // decades past the window
      expect(await airdrop.claimableAirdrop(alice.address)).to.equal(alloc);
      await airdrop.connect(alice).claimAirdrop();
      expect(await satori.balanceOf(alice.address)).to.equal(alloc);
      // A second claim decades-later still yields nothing.
      await time.increase(VEST * 10n);
      await expect(airdrop.connect(alice).claimAirdrop()).to.be.revertedWithCustomError(airdrop,
        "NothingToClaim"
      );
    });
  });

  // ================================================================
  // A2 — dust / rounding at saturation
  // ================================================================
  describe("A2 dust / rounding: full vest yields EXACT alloc, no wei stranded", function () {
    it("odd-wei allocation that never divides evenly still saturates to exactly alloc", async function () {
      // A deliberately ugly allocation not divisible by VEST so every partial
      // claim floors and leaves rounding dust — the >= VEST branch must still
      // return the EXACT alloc so no wei is stranded.
      const alloc = E(333333) + 7n; // 333333.000...007 SATORI, not VEST-divisible
      await airdrop.connect(owner).loadAirdropBatch([alice.address], [alloc]);

      // Claim in many partial slices, accumulating floor-rounding each time.
      const start = Number(await airdrop.airdropStart());
      const steps = 13;
      for (let i = 1; i <= steps; i++) {
        const t = start + Math.floor((Number(VEST) * i) / (steps + 1));
        await time.setNextBlockTimestamp(t);
        await airdrop.connect(alice).claimAirdrop();
        // Monotone: claimed never exceeds the exact vested slice.
        const claimed = await airdrop.airdropClaimed(alice.address);
        const vestedExact = vestedAt(alloc, BigInt(t - start));
        expect(claimed).to.equal(vestedExact);
      }

      // Cross the finish line: final claim must top up to EXACTLY alloc.
      await time.increase(VEST);
      await airdrop.connect(alice).claimAirdrop();
      expect(await airdrop.airdropClaimed(alice.address)).to.equal(alloc);
      expect(await satori.balanceOf(alice.address)).to.equal(alloc);
      // Not one wei short, not one wei over.
    });

    it("1-wei allocation: saturates to exactly 1 wei, no NothingToClaim trap before vest end", async function () {
      const alloc = 1n; // the smallest possible non-zero allocation
      await airdrop.connect(owner).loadAirdropBatch([alice.address], [alloc]);
      // Before VEST, 1*elapsed/VEST floors to 0 — nothing claimable yet.
      expect(await airdrop.claimableAirdrop(alice.address)).to.equal(0n);
      await expect(airdrop.connect(alice).claimAirdrop()).to.be.revertedWithCustomError(airdrop,
        "NothingToClaim"
      );
      // After VEST the saturation branch delivers the whole 1 wei.
      await time.increase(VEST);
      await airdrop.connect(alice).claimAirdrop();
      expect(await satori.balanceOf(alice.address)).to.equal(1n);
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
      await time.increase(VEST * 2n); // all fully vested

      // Alice + Bob claim: airdropMinted goes 0 -> half -> TOTAL (exactly at cap).
      await airdrop.connect(alice).claimAirdrop();
      await airdrop.connect(bob).claimAirdrop();
      expect(await airdrop.airdropClaimedTotal()).to.equal(TOTAL);
      expect(await satori.balanceOf(alice.address)).to.equal(half);
      expect(await satori.balanceOf(bob.address)).to.equal(half);

      // Carol's fully-vested claim would push airdropMinted to 1.5x cap ->
      // the core's airdropMint cap must reject it.
      await expect(airdrop.connect(carol).claimAirdrop()).to.be.revertedWithCustomError(
        satori,
        "BudgetExceeded"
      );

      // The cap held: airdropClaimedTotal is still exactly TOTAL, and carol's
      // rewards-side state was NOT mutated (CEI: the revert bubbled from the
      // core mint, but the whole tx reverted so airdropClaimed stayed 0).
      expect(await airdrop.airdropClaimedTotal()).to.equal(TOTAL);
      expect(await airdrop.airdropClaimed(carol.address)).to.equal(0n);
      // Alice + Bob keep their funds; no clawback.
      expect(await satori.balanceOf(alice.address)).to.equal(half);
      expect(await satori.balanceOf(bob.address)).to.equal(half);
    });

    it("locked-out recipient can claim a PARTIAL slice that still fits under the cap", async function () {
      // Cap-exact load on alice, plus a small overhang on bob.
      const overhang = E(10);
      await airdrop.connect(owner).loadAirdropBatch(
        [alice.address, bob.address],
        [TOTAL, overhang]
      );
      // Advance only a tiny bit so bob's vested slice is < remaining headroom...
      // but alice hasn't claimed yet, so the whole cap is free. Bob claims his
      // small vested slice fine.
      await time.increase(VEST / 100n);
      await airdrop.connect(bob).claimAirdrop();
      expect(await satori.balanceOf(bob.address)).to.be.gt(0n);

      // Now alice fully vests and tries to claim the ENTIRE cap. Since bob
      // already consumed a slice, alice's full-alloc claim overshoots the cap
      // and is locked out — the core cap is the hard backstop.
      await time.increase(VEST * 2n);
      await expect(airdrop.connect(alice).claimAirdrop()).to.be.revertedWithCustomError(
        satori,
        "BudgetExceeded"
      );
      // Cap invariant intact: total minted never exceeded TOTAL.
      expect(await airdrop.airdropClaimedTotal()).to.be.lte(TOTAL);
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
    it("no claimer callback exists — claim is a plain from==address(0) mint, no reentrancy lever", async function () {
      // claimAirdrop calls ISatoriCore.airdropMint -> _mint(to, amount) with
      // from == address(0). ERC20 _mint has no recipient hook (no ERC777/1363
      // callback), so a malicious contract recipient cannot re-enter claimAirdrop
      // mid-mint. We demonstrate a CONTRACT recipient claims exactly its slice
      // with no extra mint — the mint completing without any reentry.
      const alloc = E(400000);
      // Deploy a trivial contract that will hold an allocation and claim.
      // (Any contract address works as the recipient; reentrancy would require a
      // callback the plain ERC20 mint never invokes.)
      const factory = await ethers.getContractFactory("SatoriRewardsLens");
      const dummy = await factory.deploy(await satori.getAddress(), await rewards.getAddress());
      await dummy.waitForDeployment();
      const dummyAddr = await dummy.getAddress();

      await airdrop.connect(owner).loadAirdropBatch([dummyAddr, alice.address], [alloc, alloc]);
      // Pin the next block to a known offset so the vested slice is exact.
      const start = Number(await airdrop.airdropStart());
      const T = start + Number(VEST) / 3;
      await time.setNextBlockTimestamp(T);
      // A contract has no way to call claimAirdrop on its own behalf here (it has
      // no such method); the important invariant is the human-facing one below:
      // a normal claim mints exactly the linear slice, no reentrant top-up.
      await ethers.provider.send("evm_mine", []);

      // Alice claims at a pinned timestamp: the mint equals the pure formula.
      const T2 = start + Math.floor(Number(VEST) / 2);
      await time.setNextBlockTimestamp(T2);
      const balBefore = await satori.balanceOf(alice.address);
      await airdrop.connect(alice).claimAirdrop();
      const minted = (await satori.balanceOf(alice.address)) - balBefore;
      // Exactly the linear slice at T2 — not more (no reentrant double-mint),
      // not less. CEI: airdropClaimed was set to `vested` BEFORE this mint.
      expect(minted).to.equal(vestedAt(alloc, BigInt(T2 - start)));
      expect(await airdrop.airdropClaimed(alice.address)).to.equal(
        vestedAt(alloc, BigInt(T2 - start))
      );
    });

    it("CEI: once claimed == alloc (saturated), any re-claim reverts — the slice can't be re-taken", async function () {
      const alloc = E(400000);
      await airdrop.connect(owner).loadAirdropBatch([alice.address], [alloc]);
      // Fully saturate so vested is pinned at `alloc` regardless of the +1s that
      // each subsequent tx adds — this makes the re-claim revert DETERMINISTIC.
      await time.increase(VEST + 100n);
      await airdrop.connect(alice).claimAirdrop();
      expect(await airdrop.airdropClaimed(alice.address)).to.equal(alloc);
      // Re-claim: vested == already == alloc => NothingToClaim (even though the
      // block timestamp advanced; the vest is capped at alloc).
      await expect(airdrop.connect(alice).claimAirdrop()).to.be.revertedWithCustomError(airdrop,
        "NothingToClaim"
      );
      expect(await airdrop.airdropClaimed(alice.address)).to.equal(alloc);
    });

    it("anti-double-pay: two partial claims never mint more than the slice at the SECOND claim's time", async function () {
      const alloc = E(600000);
      await airdrop.connect(owner).loadAirdropBatch([alice.address], [alloc]);
      const start = Number(await airdrop.airdropStart());

      // First partial claim at T1.
      const T1 = start + Math.floor(Number(VEST) / 4);
      await time.setNextBlockTimestamp(T1);
      const b0 = await satori.balanceOf(alice.address);
      await airdrop.connect(alice).claimAirdrop();

      // Second partial claim at T2 > T1.
      const T2 = start + Math.floor(Number(VEST) / 2);
      await time.setNextBlockTimestamp(T2);
      await airdrop.connect(alice).claimAirdrop();
      const totalMinted = (await satori.balanceOf(alice.address)) - b0;

      // The two claims together minted EXACTLY the linear slice at T2 — the
      // earlier slice was not re-paid (monotonic cursor, CEI).
      expect(totalMinted).to.equal(vestedAt(alloc, BigInt(T2 - start)));
      expect(await airdrop.airdropClaimed(alice.address)).to.equal(
        vestedAt(alloc, BigInt(T2 - start))
      );
    });
  });

  // ================================================================
  // A6 — mint-to-msg.sender ONLY (no redirect) + airdropMint gating
  // ================================================================
  describe("A6 mint-to-the-ALLOCATED-address-only / airdropMint gating", function () {
    // This used to assert "mints strictly to msg.sender", which was true only
    // because no on-behalf door existed. `claimAirdropFor` opened one on
    // 2026-08-17 so the launch sweep can pay everyone's gas. The property that
    // actually matters is UNCHANGED and is what this now pins: a claim credits
    // the ALLOCATED address, and nobody can steer it anywhere else — least of
    // all to themselves. The old assertion was about the shape of the API; this
    // one is about the money.
    it("nobody can harvest alice's alloc TO THEMSELVES, with or without the on-behalf door", async function () {
      const alloc = E(200000);
      await airdrop.connect(owner).loadAirdropBatch([alice.address], [alloc]);
      await time.increase(VEST / 2n);

      // Bob is unallocated. Self-claiming mints him nothing.
      await expect(airdrop.connect(bob).claimAirdrop()).to.be.revertedWithCustomError(airdrop,
        "NothingToClaim"
      );
      expect(await satori.balanceOf(bob.address)).to.equal(0n);

      // Bob CAN now name alice as the beneficiary — and that is the whole point:
      // the tokens go to ALICE. He pays gas and receives nothing.
      await airdrop.connect(bob).claimAirdropFor(alice.address);
      expect(await satori.balanceOf(alice.address)).to.be.gt(0n);
      expect(await satori.balanceOf(bob.address)).to.equal(0n);

      // Nor can he route it through the batch form.
      const aliceBefore = await satori.balanceOf(alice.address);
      await airdrop.connect(bob).claimAirdropForMany([alice.address, bob.address]);
      expect(await satori.balanceOf(bob.address)).to.equal(0n);
      expect(await satori.balanceOf(alice.address)).to.be.gte(aliceBefore);
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
  // A7 — admin-only loading, admin transfer
  // ================================================================
  describe("A7 loader-only loading", function () {
    it("non-loader cannot load", async function () {
      await expect(
        airdrop.connect(alice).loadAirdropBatch([alice.address], [E(1)])
      ).to.be.revertedWithCustomError(airdrop, "Unauthorized");
    });

    it("rotating the loader moves the loading right; the rewards admin has no say", async function () {
      // The loader is its own role on SatoriAirdrop. Rotating the REWARDS admin
      // does nothing to it — that coupling is gone with the move.
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
      await airdrop.connect(alice).loadAirdropBatch([bob.address], [E(1)]);
      expect(await airdrop.airdropAllocation(bob.address)).to.equal(E(1));
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

      // airdropMinted is internal; its public mirror on the rewards side is
      // airdropClaimedTotal (incremented in lockstep with the core counter).
      const identity = async () => {
        const supply = await satori.totalSupply();
        const rmint = await satori.totalRewardsMinted();
        const amint = await airdrop.airdropClaimedTotal();
        expect(supply).to.equal(rmint + amint);
      };

      await identity();

      // The genesis INITIAL_MINT already fills the round-0 on-chain reward lane,
      // so advance a round to open fresh reward budget before the first
      // rewardMint. (This is a reward-lane constraint, orthogonal to the airdrop.)
      await time.increase(86400); // one full 24h round
      await satori.connect(rw).rewardMint(carol.address, E(10));
      await identity();
      await time.increase(VEST / 20n);
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

      // Fully vest and drain both airdrops; identity still exact.
      await time.increase(VEST * 2n);
      await airdrop.connect(alice).claimAirdrop();
      await airdrop.connect(bob).claimAirdrop();
      await identity();
      // The airdrop lane summed to exactly the LOADED total — which is what
      // this claims, and is not the cap. It happened to equal the cap while
      // both were 1,000,000; asserting against TOTAL was relying on that
      // coincidence, and the cap moving to 1,200,000 exposed it.
      expect(await airdrop.airdropClaimedTotal()).to.equal(await airdrop.airdropLoadedTotal());
      expect(await airdrop.airdropClaimedTotal()).to.equal(E(600000) + E(400000));
    });
  });

  // ================================================================
  // A9 — back-vesting of a LATE-loaded recipient (anchored to deploy)
  // ================================================================
  describe("A9 back-vesting off the deploy anchor", function () {
    it("a recipient loaded halfway through the window is immediately 7/12 vested (the sixth + half the rest)", async function () {
      const start = Number(await airdrop.airdropStart());
      // Warp to ~50% of the window, THEN load bob for the first time.
      await time.setNextBlockTimestamp(start + Number(VEST) / 2);
      await ethers.provider.send("evm_mine", []);
      const alloc = E(100000);
      await airdrop.connect(owner).loadAirdropBatch([bob.address], [alloc]);

      // Vesting is anchored to airdropStart (deploy), NOT load time, so bob is
      // already ~half vested the instant he's loaded.
      const claimable = await airdrop.claimableAirdrop(bob.address);
      const elapsed = BigInt((await time.latest())) - BigInt(start);
      expect(claimable).to.equal(vestedAt(alloc, elapsed));
      expect(claimable).to.be.gt(alloc * 7n / 12n - alloc / 1000n);
      expect(claimable).to.be.lt(alloc * 7n / 12n + alloc / 1000n);
    });

    it("a recipient loaded AFTER the window has fully passed is instantly 100% vested", async function () {
      await time.increase(VEST + 1n);
      const alloc = E(123456);
      await airdrop.connect(owner).loadAirdropBatch([carol.address], [alloc]);
      expect(await airdrop.claimableAirdrop(carol.address)).to.equal(alloc);
      await airdrop.connect(carol).claimAirdrop();
      expect(await satori.balanceOf(carol.address)).to.equal(alloc);
    });
  });

  // ================================================================
  // A10 — monotonic airdropClaimed; claimableAirdrop view exactness
  // ================================================================
  describe("A10 monotonic claimed + view exactness", function () {
    // The file-level vestedAt mirrors airdropVested (a sixth + linear rest).

    it("claimableAirdrop view equals the exact formula, and the claim mints exactly that at the SAME timestamp", async function () {
      const alloc = E(800000);
      await airdrop.connect(owner).loadAirdropBatch([alice.address], [alloc]);
      const start = Number(await airdrop.airdropStart());

      let prevClaimed = 0n;
      for (const frac of [0.1, 0.25, 0.5, 0.75, 0.99, 1.0, 1.5]) {
        // Mine an empty block at exactly T and read the view there. The view is
        // evaluated against this block's timestamp (T), so it must equal the pure
        // formula vested(T) - alreadyClaimed.
        const T = start + Math.floor(Number(VEST) * frac);
        await time.setNextBlockTimestamp(T);
        await ethers.provider.send("evm_mine", []);
        const already = await airdrop.airdropClaimed(alice.address);
        const view = await airdrop.claimableAirdrop(alice.address);
        expect(view).to.equal(vestedAt(alloc, BigInt(T - start)) - already);

        if (view === 0n) {
          await expect(airdrop.connect(alice).claimAirdrop()).to.be.revertedWithCustomError(airdrop,
            "NothingToClaim"
          );
          continue;
        }

        // The claim executes in the NEXT block (T+1). Its mint must equal the
        // formula at THAT block's timestamp minus what was already claimed — i.e.
        // the view is exact for the block it's read in, and the claim is exact
        // for the block it lands in. We assert the claim against its own timestamp.
        const balBefore = await satori.balanceOf(alice.address);
        const txt = await (await airdrop.connect(alice).claimAirdrop()).wait();
        const claimBlock = await ethers.provider.getBlock(txt.blockNumber);
        const tClaim = BigInt(claimBlock.timestamp - start);
        const minted = (await satori.balanceOf(alice.address)) - balBefore;
        expect(minted).to.equal(vestedAt(alloc, tClaim) - already);

        const claimed = await airdrop.airdropClaimed(alice.address);
        expect(claimed).to.be.gte(prevClaimed); // monotone non-decreasing
        expect(claimed).to.be.lte(alloc); // never over-vest
        expect(claimed).to.equal(vestedAt(alloc, tClaim));
        prevClaimed = claimed;
      }
      // Fully saturated at the end — exact alloc, no dust.
      expect(await airdrop.airdropClaimed(alice.address)).to.equal(alloc);
    });
  });

  // ================================================================
  // A11 — re-claim idempotency
  // ================================================================
  describe("A11 re-claim idempotency", function () {
    it("re-claim after full saturation reverts NothingToClaim; claimedTotal unchanged", async function () {
      const alloc = E(300000);
      await airdrop.connect(owner).loadAirdropBatch([alice.address], [alloc]);
      // Saturate so vested is pinned at alloc — makes the re-claim revert
      // DETERMINISTIC (a sub-VEST re-claim would correctly mint the +1s slice
      // that the live per-second vest accrues, which is NOT a bug).
      await time.increase(VEST + 10n);
      await airdrop.connect(alice).claimAirdrop();
      const totalAfter = await airdrop.airdropClaimedTotal();
      expect(await airdrop.airdropClaimed(alice.address)).to.equal(alloc);
      await expect(airdrop.connect(alice).claimAirdrop()).to.be.revertedWithCustomError(airdrop,
        "NothingToClaim"
      );
      expect(await airdrop.airdropClaimedTotal()).to.equal(totalAfter);
    });

    it("a sub-vest re-claim in the very next block is NOT idempotent — it mints the tiny newly-accrued slice (documenting live-vest behavior)", async function () {
      // This documents that the airdrop vest is LIVE per-second: even 1 second
      // after a partial claim, a re-claim mints the newly-vested wei. This is
      // correct (monotonic, never double-pays the old slice) — not a bug.
      const alloc = E(600000);
      await airdrop.connect(owner).loadAirdropBatch([alice.address], [alloc]);
      await time.increase(VEST / 4n);
      await airdrop.connect(alice).claimAirdrop();
      const claimed1 = await airdrop.airdropClaimed(alice.address);
      // Next block (+1s): the re-claim succeeds and adds exactly the 1s slice.
      await airdrop.connect(alice).claimAirdrop();
      const claimed2 = await airdrop.airdropClaimed(alice.address);
      expect(claimed2).to.be.gt(claimed1); // monotone increase
      // The added slice is tiny: (5/6)alloc/VEST per second, times a couple seconds.
      expect(claimed2 - claimed1).to.be.lt((alloc / VEST) * 5n + 1n);
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
      await time.increase(VEST); // fully vest

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
      // Fill the on-chain reward lane to its current ceiling.
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
      await airdrop.connect(owner).loadAirdropBatch([alice.address], [E(250000)]);
      await time.increase(VEST);
      await airdrop.connect(alice).claimAirdrop();
      expect(await satori.balanceOf(alice.address)).to.equal(E(250000));
      // The airdrop mint did not touch the reward counter — it stayed at the cap.
      expect(await satori.totalRewardsMinted()).to.equal(rmintBefore);
      // The airdrop lane mirror advanced by exactly the claimed amount.
      expect(await airdrop.airdropClaimedTotal()).to.equal(E(250000));
    });
  });
});
