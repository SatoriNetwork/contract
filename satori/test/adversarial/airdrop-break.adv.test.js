// airdrop-break.adv.test.js
//
// ADVERSARIAL break-testing for the AIRDROP (no vesting, no delay, no freeze:
// every allocation is claimable in full from the block it is loaded in;
// finalize only closes loading — docs/issues/airdrop-claim-at-finalize.md).
//
// Target surface:
//   SatoriAirdrop.sol : loadAirdropBatch, finalizeAirdropLoading,
//                       airdropLoadingFinalized, claimAirdrop, claimAirdropFor,
//                       claimAirdropForMany, claimableAirdrop, airdropAllocation,
//                       airdropClaimed, airdropClaimedTotal, airdropLoadedTotal,
//                       setAirdropAuthority, AIRDROP_TOTAL_SUPPLY
//   SatoriToken.sol   : airdropMint (gated msg.sender == token.airdrop),
//                       setAirdrop, airdropMinted counter, cap AIRDROP_TOTAL_SUPPLY,
//                       SEPARATE from totalRewardsMinted / the 1440/round cap.
//
// Attacks encoded below (each an adversary trying to break an invariant):
//  A1  claims on load: claimable before finalize, in the load block, while
//      loading continues; finalize changes nothing for claims
//  A2  finalize is write-once (AlreadySet), not by a rotated or recalled
//      loader; a stranger cannot finalize
//  A3  OVER-LOAD — loading refuses any batch past the cap, so every loaded
//      row is always payable in full
//  A4  guards: length mismatch / duplicate / zero-addr / zero-amount, intra-batch dup
//  A5  reentrancy on claim — plain ERC20, no claimer callback, CEI ordering
//  A6  mint-to-the-ALLOCATED-address only — no redirect; airdropMint gated
//  A7  loader-only loading and finalizing; rotation moves the right
//  A8  supply identity totalSupply() == totalRewardsMinted() + airdropMinted
//      under INTERLEAVED reward mints and airdrop claims
//  A9  loading after finalize is refused — for the loader, a rotated loader,
//      and a recalled one; at once and long after
//  A10 claimableAirdrop view exactness vs a real claim, to the wei
//  A11 all-or-nothing: after a full claim every re-claim pays nothing, through
//      every door, later or racing in the same block
//  A12 airdrop mint must NOT eat into the per-round reward cap (both lanes at cap)
//  A13 the door: re-pointing it to a rival or replacement never pays anyone
//      twice (the cursor is the token's) and never passes the cap
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
const { burnedTotal } = require("../helpers/burned");

const DAY = 24n * 3600n; // one reward round
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

// The hub mints on-chain only what Rewards reported, and refuses a report past
// the rounds priced so far: price the current round, then report `amount`.
async function report(hub, rw, amount) {
  await hub.connect(rw).freezeRoundGross(await hub.getCurrentRound());
  await hub.connect(rw).noteIssued(amount);
}

// What Rewards may still report: the priced rounds' allowance less what it
// already reported.
async function allowanceRoom(hub, token) {
  const reported = (await token.generalAccrued()) - (await hub.merkleReserveCumulative());
  return (await hub.onChainAllowance()) - reported;
}

describe("[adv] AIRDROP — whole allocation on load (SatoriAirdrop)", function () {
  this.timeout(600000);

  let satori, token, hub, airdrop, rewards, owner, alice, bob, carol, dave, TOTAL;

  beforeEach(async function () {
    const fix = await deploySatoriFixture();
    ({ satori, token, hub, airdrop, rewards, owner } = fix);
    [, alice, bob, carol, dave] = fix.signers;
    TOTAL = await airdrop.AIRDROP_TOTAL_SUPPLY();
  });

  // The fixture points the door at `airdrop` and seeds every token slot with
  // owner, who is also the loader. Finalize closes loading; claims never wait
  // for it.
  async function openClaims() {
    await airdrop.connect(owner).finalizeAirdropLoading();
  }

  async function deployAirdrop(authority) {
    const c = await (await ethers.getContractFactory("SatoriAirdrop"))
      .deploy(await token.getAddress(), authority);
    await c.waitForDeployment();
    return c;
  }

  // ================================================================
  // A1 — claims on load
  // ================================================================
  describe("A1 claims on load (no finalize, no freeze)", function () {
    it("every door pays the WHOLE allocation in the block right after the load — finalize never called", async function () {
      const alloc = E(1000);
      await airdrop.connect(owner).loadAirdropBatch([alice.address, bob.address, carol.address], [alloc, alloc, alloc]);
      expect(await airdrop.airdropLoadingFinalized()).to.equal(false);
      await expect(airdrop.connect(alice).claimAirdrop())
        .to.emit(airdrop, "AirdropClaimed").withArgs(alice.address, alloc);
      await expect(airdrop.connect(dave).claimAirdropFor(bob.address))
        .to.emit(airdrop, "AirdropClaimed").withArgs(bob.address, alloc);
      expect(await airdrop.connect(dave).claimAirdropForMany.staticCall([carol.address])).to.equal(alloc);
      await airdrop.connect(dave).claimAirdropForMany([carol.address]);
      for (const w of [alice, bob, carol]) expect(await satori.balanceOf(w.address)).to.equal(alloc);
      expect(await satori.balanceOf(dave.address)).to.equal(0n);
    });

    it("inside the load block, a claim ordered before the load reverts and one ordered after it pays", async function () {
      const gas = { gasLimit: 500000 };
      const nonce = await ethers.provider.getTransactionCount(alice.address);
      const opt = (i) => ({ ...gas, nonce: nonce + i });
      await ethers.provider.send("evm_setAutomine", [false]);
      let txs;
      try {
        txs = [
          await airdrop.connect(alice).claimAirdrop(opt(0)),
          await airdrop.connect(owner).loadAirdropBatch([alice.address], [E(7)], gas),
          await airdrop.connect(alice).claimAirdrop(opt(1)),
        ];
        await ethers.provider.send("evm_mine", []);
      } finally {
        await ethers.provider.send("evm_setAutomine", [true]);
      }
      const r = await Promise.all(txs.map((t) => ethers.provider.getTransactionReceipt(t.hash)));
      expect(new Set(r.map((x) => x.blockNumber)).size, "one block").to.equal(1);
      expect(r[0].status, "claim before the load").to.equal(0);
      expect(r[1].status, "load").to.equal(1);
      expect(r[2].status, "claim after the load").to.equal(1);
      expect(await satori.balanceOf(alice.address)).to.equal(E(7));
    });

    it("loading continues while people claim, years apart; finalize later changes nothing for claimers", async function () {
      await airdrop.connect(owner).loadAirdropBatch([alice.address], [E(100)]);
      await airdrop.connect(alice).claimAirdrop();
      await time.increase(2n * YEAR);
      await airdrop.connect(owner).loadAirdropBatch([bob.address], [E(200)]);
      await openClaims();
      await airdrop.connect(bob).claimAirdrop();
      expect(await token.airdropMinted()).to.equal(E(300));
      await expect(airdrop.connect(alice).claimAirdrop())
        .to.be.revertedWithCustomError(airdrop, "NothingToClaim");
    });
  });

  // ================================================================
  // A2 — finalize is write-once
  // ================================================================
  describe("A2 finalize is write-once", function () {
    it("a second finalize reverts AlreadySet, before and after a claim", async function () {
      await airdrop.connect(owner).loadAirdropBatch([alice.address], [E(1000)]);
      await openClaims();

      await expect(airdrop.connect(owner).finalizeAirdropLoading())
        .to.be.revertedWithCustomError(airdrop, "AlreadySet");
      await airdrop.connect(alice).claimAirdrop();
      await expect(airdrop.connect(owner).finalizeAirdropLoading())
        .to.be.revertedWithCustomError(airdrop, "AlreadySet");
      expect(await airdrop.airdropLoadingFinalized()).to.equal(true);
    });

    it("a rotated loader, or one recalled by the appoint authority, cannot finalize again", async function () {
      await airdrop.connect(owner).loadAirdropBatch([alice.address], [E(1000)]);
      await openClaims();

      await airdrop.connect(owner).setAirdropAuthority(carol.address);
      await expect(airdrop.connect(carol).finalizeAirdropLoading())
        .to.be.revertedWithCustomError(airdrop, "AlreadySet");
      // owner still holds token.appointAuthority (the fixture seeds every slot).
      await airdrop.connect(owner).setAirdropAuthority(dave.address);
      await expect(airdrop.connect(dave).finalizeAirdropLoading())
        .to.be.revertedWithCustomError(airdrop, "AlreadySet");

      await airdrop.connect(alice).claimAirdrop();
      expect(await satori.balanceOf(alice.address)).to.equal(E(1000));
    });

    it("a stranger cannot finalize, and a failed attempt leaves loading open", async function () {
      await airdrop.connect(owner).loadAirdropBatch([alice.address], [E(1000)]);
      for (const who of [alice, bob]) {
        await expect(airdrop.connect(who).finalizeAirdropLoading())
          .to.be.revertedWithCustomError(airdrop, "Unauthorized");
      }
      expect(await airdrop.airdropLoadingFinalized()).to.equal(false);
      await airdrop.connect(owner).loadAirdropBatch([bob.address], [E(1)]);
      await airdrop.connect(alice).claimAirdrop();
      expect(await satori.balanceOf(alice.address)).to.equal(E(1000));
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
  // A3 — OVER-LOAD: loading refuses it, so every loaded row is payable
  // ================================================================
  describe("A3 over-load (Σ load > cap)", function () {
    it("a batch taking the table past the cap reverts BudgetExceeded atomically; earlier rows stay and pay", async function () {
      const half = TOTAL / 2n;
      await airdrop.connect(owner).loadAirdropBatch([alice.address, bob.address], [half, half]);
      await expect(airdrop.connect(owner).loadAirdropBatch([carol.address], [half]))
        .to.be.revertedWithCustomError(airdrop, "BudgetExceeded");
      expect(await airdrop.airdropAllocation(carol.address)).to.equal(0n);
      expect(await airdrop.airdropLoadedTotal()).to.equal(half * 2n);
      await airdrop.connect(dave).claimAirdropForMany([alice.address, bob.address]);
      expect(await token.airdropMinted()).to.equal(half * 2n);
    });

    it("the cap is 1,100,000: exactly the cap loads, one wei more is refused, and every row pays in full", async function () {
      expect(TOTAL).to.equal(E(1100000));
      await airdrop.connect(owner).loadAirdropBatch([alice.address, bob.address], [TOTAL - 4n, 4n]);
      await expect(airdrop.connect(owner).loadAirdropBatch([carol.address], [1n]))
        .to.be.revertedWithCustomError(airdrop, "BudgetExceeded");
      await airdrop.connect(dave).claimAirdropForMany([alice.address, bob.address]);
      expect(await token.airdropMinted()).to.equal(TOTAL);
      expect(await satori.balanceOf(bob.address)).to.equal(4n);
    });

    it("an over-cap row inside one batch reverts the whole batch, before any row lands", async function () {
      await expect(airdrop.connect(owner).loadAirdropBatch([alice.address, bob.address], [E(1), TOTAL]))
        .to.be.revertedWithCustomError(airdrop, "BudgetExceeded");
      expect(await airdrop.airdropAllocation(alice.address)).to.equal(0n);
      expect(await airdrop.airdropLoadedTotal()).to.equal(0n);
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
      await token.connect(ad).airdropMint(alice.address, 1n);
      expect(await satori.balanceOf(alice.address)).to.equal(1n);
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
      await airdrop.connect(alice).loadAirdropBatch([bob.address], [E(1)]);
      expect(await airdrop.airdropAllocation(bob.address)).to.equal(E(1));
      await expect(
        airdrop.connect(owner).finalizeAirdropLoading()
      ).to.be.revertedWithCustomError(airdrop, "Unauthorized");
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
        expect(supply + (await burnedTotal(token))).to.equal(rmint + amint);
      };

      await identity();
      await time.increase(DAY);
      await report(hub, rw, E(10));
      await identity();
      await satori.connect(rw).rewardMint(carol.address, E(10));
      await identity();
      await airdrop.connect(alice).claimAirdrop();
      await identity();

      // Another round: another report + rewardMint, the fee booked on both paid
      // out, then bob claims.
      await time.increase(DAY);
      await report(hub, rw, E(50));
      await satori.connect(rw).rewardMint(dave.address, E(50));
      await identity();
      expect(await token.mintDevFee.staticCall()).to.be.gt(0n);
      await token.mintDevFee();
      await identity();
      await airdrop.connect(bob).claimAirdrop();
      await identity();

      // A transfer must NOT change totalSupply nor break the identity.
      const supplyBefore = await satori.totalSupply();
      await satori.connect(alice).transfer(carol.address, 1n);
      expect(await satori.totalSupply()).to.equal(supplyBefore);
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
    it("before finalize the loader, a rotated loader and a recalled one all load; after it none can", async function () {
      await airdrop.connect(owner).loadAirdropBatch([alice.address], [E(1000)]);
      await airdrop.connect(owner).setAirdropAuthority(carol.address);
      await airdrop.connect(carol).loadAirdropBatch([carol.address], [E(2)]);
      await token.connect(owner).setAppointAuthority(bob.address);
      await airdrop.connect(bob).setAirdropAuthority(dave.address);
      await airdrop.connect(dave).loadAirdropBatch([dave.address], [E(3)]);

      await expect(airdrop.connect(dave).finalizeAirdropLoading())
        .to.emit(airdrop, "AirdropLoadingFinalized").withArgs(E(1005));
      await expect(airdrop.connect(dave).loadAirdropBatch([bob.address], [E(1)]))
        .to.be.revertedWithCustomError(airdrop, "AirdropLoadingClosed");
      await airdrop.connect(bob).setAirdropAuthority(carol.address);
      await expect(airdrop.connect(carol).loadAirdropBatch([bob.address], [E(1)]))
        .to.be.revertedWithCustomError(airdrop, "AirdropLoadingClosed");
      await airdrop.connect(dave).claimAirdropForMany([alice.address, carol.address, dave.address]);
      expect(await token.airdropMinted()).to.equal(E(1005));
    });

    it("the loader cannot add a recipient right after finalize, after a claim, or years later", async function () {
      await airdrop.connect(owner).loadAirdropBatch([alice.address], [E(1000)]);
      await openClaims();
      const loaded = await airdrop.airdropLoadedTotal();

      const tryLoad = () => airdrop.connect(owner).loadAirdropBatch([bob.address], [E(1)]);
      await expect(tryLoad()).to.be.revertedWithCustomError(airdrop, "AirdropLoadingClosed");
      await airdrop.connect(alice).claimAirdrop();
      await expect(tryLoad()).to.be.revertedWithCustomError(airdrop, "AirdropLoadingClosed");
      await time.increase(5n * YEAR);
      await expect(tryLoad()).to.be.revertedWithCustomError(airdrop, "AirdropLoadingClosed");

      expect(await airdrop.airdropAllocation(bob.address)).to.equal(0n);
      expect(await airdrop.airdropLoadedTotal()).to.equal(loaded);
    });

    it("the closed gate fires before any other guard: an empty batch, a top-up of an existing row, a bad batch", async function () {
      await airdrop.connect(owner).loadAirdropBatch([alice.address], [E(1000)]);
      await openClaims();
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
      await openClaims();

      await airdrop.connect(owner).setAirdropAuthority(carol.address);
      await expect(airdrop.connect(carol).loadAirdropBatch([carol.address], [TOTAL]))
        .to.be.revertedWithCustomError(airdrop, "AirdropLoadingClosed");

      // Move the token's appoint authority to bob and let him recall the role.
      await token.connect(owner).setAppointAuthority(bob.address);
      await airdrop.connect(bob).setAirdropAuthority(dave.address);
      await expect(airdrop.connect(dave).loadAirdropBatch([dave.address], [TOTAL]))
        .to.be.revertedWithCustomError(airdrop, "AirdropLoadingClosed");

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
    it("claimableAirdrop is the exact allocation right after the load, exactly what the claim mints, then 0", async function () {
      // Odd wei on every row: the whole allocation must arrive to the wei.
      const amts = [E(333333) + 7n, 1n, E(700000) + 123456789n];
      const who = [alice, bob, carol];
      await airdrop.connect(owner).loadAirdropBatch(who.map((w) => w.address), amts);


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

      for (const later of [0n, 10n * YEAR]) {
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
      await time.increase(DAY);
      // Rewards reports everything the priced rounds allow: the on-chain lane's
      // whole headroom.
      await hub.connect(rw).freezeRoundGross(await hub.getCurrentRound());
      const reported = await allowanceRoom(hub, token);
      expect(reported).to.be.gt(0n);
      await hub.connect(rw).noteIssued(reported);

      // Snapshot the reward lane before the airdrop claim.
      const rmintBefore = await satori.totalRewardsMinted();
      const onChainMintBefore = await satori.onChainMinted();
      const ceilingBefore = await satori.onChainRewardCeiling();
      const accruedBefore = (await token.generalAccrued()) + (await token.devFeeAccrued());

      // Claim 500k SATORI of airdrop.
      await airdrop.connect(alice).claimAirdrop();

      // The reward lane counters are UNTOUCHED by the airdrop mint.
      expect(await satori.totalRewardsMinted()).to.equal(rmintBefore);
      expect(await satori.onChainMinted()).to.equal(onChainMintBefore);
      expect((await token.generalAccrued()) + (await token.devFeeAccrued())).to.equal(accruedBefore);

      // And the on-chain reward ceiling is unchanged — the airdrop didn't eat
      // into the reported room.
      const ceiling = await satori.onChainRewardCeiling();
      expect(ceiling).to.equal(ceilingBefore);
      const headroom = ceiling - (await satori.onChainMinted());
      expect(headroom).to.equal(reported);

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
      await time.increase(DAY);

      // Report the whole allowance and fill the on-chain reward lane to its
      // ceiling, in the same round the claim lands in.
      await hub.connect(rw).freezeRoundGross(await hub.getCurrentRound());
      await hub.connect(rw).noteIssued(await allowanceRoom(hub, token));
      const ceiling = await satori.onChainRewardCeiling();
      const headroom = ceiling - (await satori.onChainMinted());
      expect(headroom).to.be.gt(0n);
      await satori.connect(rw).rewardMint(carol.address, headroom);
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
      // ...and gave the full reward lane no room either.
      await expect(
        satori.connect(rw).rewardMint(carol.address, 1n)
      ).to.be.revertedWithCustomError(satori, "BudgetExceeded");
    });
  });

  // ================================================================
  // A13 — the door: re-pointable, but never pays twice or past the cap
  // ================================================================
  describe("A13 the airdrop door (re-pointable)", function () {
    it("only the contract the door points at mints; re-pointing switches which one pays", async function () {
      await airdrop.connect(owner).loadAirdropBatch([alice.address], [E(1000)]);
      const rival = await deployAirdrop(bob.address);
      await rival.connect(bob).loadAirdropBatch([bob.address], [E(5000)]);

      await expect(rival.connect(bob).claimAirdrop())
        .to.be.revertedWithCustomError(token, "Unauthorized");
      await token.connect(owner).setAirdrop(await rival.getAddress());
      await expect(airdrop.connect(alice).claimAirdrop())
        .to.be.revertedWithCustomError(token, "Unauthorized");
      await rival.connect(bob).claimAirdrop();
      await token.connect(owner).setAirdrop(await airdrop.getAddress());
      await airdrop.connect(alice).claimAirdrop();
      expect(await token.airdropMinted()).to.equal(E(6000));
    });

    it("a replacement table never pays anyone twice: it pays only past the token's airdropMintedTo", async function () {
      await airdrop.connect(owner).loadAirdropBatch([alice.address], [E(1000)]);
      await airdrop.connect(alice).claimAirdrop();
      const repl = await deployAirdrop(owner.address);
      await repl.connect(owner).loadAirdropBatch([alice.address, bob.address], [E(1000), E(10)]);
      await token.connect(owner).setAirdrop(await repl.getAddress());
      await expect(repl.connect(alice).claimAirdrop())
        .to.be.revertedWithCustomError(repl, "NothingToClaim");
      expect(await repl.connect(dave).claimAirdropForMany.staticCall([alice.address, bob.address])).to.equal(E(10));
      await repl.connect(dave).claimAirdropForMany([alice.address, bob.address]);
      expect(await satori.balanceOf(alice.address)).to.equal(E(1000));
      expect(await token.airdropMinted()).to.equal(E(1010));
    });

    it("the cap binds across contracts: tables on two contracts can never mint past it together", async function () {
      await airdrop.connect(owner).loadAirdropBatch([alice.address], [TOTAL]);
      await airdrop.connect(alice).claimAirdrop();
      const rival = await deployAirdrop(bob.address);
      await rival.connect(bob).loadAirdropBatch([bob.address], [E(1)]);
      await token.connect(owner).setAirdrop(await rival.getAddress());
      await expect(rival.connect(bob).claimAirdrop())
        .to.be.revertedWithCustomError(token, "BudgetExceeded");
      expect(await token.airdropMinted()).to.equal(TOTAL);
    });

    it("an emptied wiring slot locks the door (airdropLocked) and claims keep working", async function () {
      await airdrop.connect(owner).loadAirdropBatch([alice.address], [E(1000)]);
      await token.connect(owner).setWiringAuthority(ethers.ZeroAddress);
      expect(await token.airdropLocked()).to.equal(true);
      await expect(token.connect(owner).setAirdrop(bob.address))
        .to.be.revertedWithCustomError(token, "Unauthorized");
      await airdrop.connect(alice).claimAirdrop();
      expect(await satori.balanceOf(alice.address)).to.equal(E(1000));
      // Root can refill the slot, which unlocks the door again.
      await token.connect(owner).setWiringAuthority(bob.address);
      expect(await token.airdropLocked()).to.equal(false);
    });
  });
});
