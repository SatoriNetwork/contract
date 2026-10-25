// SatoriAirdrop: the one-time airdrop in its OWN contract, no proxy, no upgrade
// path (docs/issues/airdrop-own-contract.md). The loader writes the table in
// batches, and every allocation is claimable in full from the block it lands
// in — no vesting, no delay, no freeze. Finalize only closes loading for good
// (docs/issues/airdrop-claim-at-finalize.md). Mint-on-claim through the token's
// SEPARATE airdropMint door, which is gated on the token's `airdrop` pointer —
// not the controller — so neither the hub nor SatoriRewards can reach it.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture } = require("./fixtures");
const { burnedTotal } = require("./helpers/burned");

const DAY = 24n * 3600n;
const E = (n) => ethers.parseEther(String(n));

describe("SatoriAirdrop (own contract, claimable on load)", function () {
  let satori, token, airdrop, hub, rewards, owner, alice, bob, carol, dave, TOTAL;

  beforeEach(async function () {
    const fix = await deploySatoriFixture();
    ({ satori, token, airdrop, hub, rewards, owner } = fix); // owner is the loader and holds every token slot
    [, alice, bob, carol, dave] = fix.signers;
    TOTAL = await airdrop.AIRDROP_TOTAL_SUPPLY();
  });

  async function loadTwo(aAmt) {
    await airdrop.connect(owner).loadAirdropBatch(
      [alice.address, bob.address],
      [aAmt, TOTAL - aAmt]
    );
  }

  async function newAirdrop() {
    return (await ethers.getContractFactory("SatoriAirdrop"))
      .deploy(await token.getAddress(), owner.address);
  }

  describe("bound to the token, with nothing above it", function () {
    it("token.airdrop points at the contract and the contract points back", async function () {
      expect(await token.airdrop()).to.equal(await airdrop.getAddress());
      expect(await airdrop.token()).to.equal(await token.getAddress());
    });

    it("the ceiling is 1,100,000 SATORI, read from the token", async function () {
      expect(await token.AIRDROP_TOTAL_SUPPLY()).to.equal(E(1100000));
      expect(TOTAL).to.equal(await token.AIRDROP_TOTAL_SUPPLY());
    });

    it("the ceiling, the cursor and the counter are READ from the token, never copied", async function () {
      await loadTwo(TOTAL / 2n);
      await airdrop.connect(alice).claimAirdrop();
      expect(await airdrop.airdropClaimed(alice.address))
        .to.equal(await token.airdropMintedTo(alice.address));
      expect(await airdrop.airdropClaimedTotal()).to.equal(await token.airdropMinted());
    });

    it("has no upgrade surface, no vesting or early-claim surface, no claim delay and no freeze", async function () {
      for (const f of [
        "upgradeTo", "renounceUpgrade", "implementation", "initialize",
        "airdropStart", "AIRDROP_VEST", "UPFRONT_DIVISOR", "airdropVested",
        "claimAirdropEarly", "earlyClaimQuote", "earlyClaimEnabled", "setEarlyClaimEnabled",
        "CLAIM_DELAY", "claimsOpenAt",
      ]) {
        expect(airdrop.interface.getFunction(f), f).to.equal(null);
      }
      for (const e of ["AirdropClaimedEarly", "EarlyClaimEnabledSet"]) {
        expect(airdrop.interface.getEvent(e), e).to.equal(null);
      }
      for (const err of ["ClaimsNotOpen", "AirdropNotFrozen"]) {
        expect(airdrop.interface.getError(err), err).to.equal(null);
      }
      for (const f of ["freezeAirdrop", "airdropFrozen"]) {
        expect(token.interface.getFunction(f), f).to.equal(null);
      }
      expect(token.interface.getEvent("AirdropFrozen")).to.equal(null);
      for (const err of ["AirdropNotFrozen", "AirdropChanged", "AirdropNotSet"]) {
        expect(token.interface.getError(err), err).to.equal(null);
      }
    });
  });

  describe("the token's airdrop door", function () {
    it("airdropMint is callable ONLY by the airdrop contract: not an EOA, not the controller (hub)", async function () {
      await expect(token.connect(alice).airdropMint(alice.address, 1n))
        .to.be.revertedWithCustomError(token, "Unauthorized");
      const hubSigner = await ethers.getImpersonatedSigner(await hub.getAddress());
      await ethers.provider.send("hardhat_setBalance", [hubSigner.address, "0x1000000000000000000"]);
      await expect(token.connect(hubSigner).airdropMint(alice.address, 1n))
        .to.be.revertedWithCustomError(token, "Unauthorized");
      expect(hub.interface.getFunction("airdropMint")).to.equal(null);
      expect(rewards.interface.getFunction("claimAirdrop")).to.equal(null);
      expect(rewards.interface.getFunction("loadAirdropBatch")).to.equal(null);
    });

    it("airdropMint needs no freeze: the pointed-at contract mints at once, within the cap", async function () {
      await token.connect(owner).setAirdrop(carol.address);
      await token.connect(carol).airdropMint(alice.address, E(5));
      expect(await satori.balanceOf(alice.address)).to.equal(E(5));
      expect(await token.airdropMintedTo(alice.address)).to.equal(E(5));
      await expect(token.connect(carol).airdropMint(bob.address, TOTAL))
        .to.be.revertedWithCustomError(token, "BudgetExceeded");
    });

    it("setAirdrop is wiring-gated, rejects zero, and is repeatable; the door moves with it", async function () {
      await expect(token.connect(alice).setAirdrop(alice.address))
        .to.be.revertedWithCustomError(token, "Unauthorized");
      await expect(token.connect(owner).setAirdrop(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(token, "BadInput");
      await expect(token.connect(owner).setAirdrop(carol.address))
        .to.emit(token, "AirdropSet").withArgs(carol.address);
      expect(await token.airdrop()).to.equal(carol.address);
      // Re-pointing moves the door: the old contract is no longer the caller it takes.
      const self = await ethers.getImpersonatedSigner(await airdrop.getAddress());
      await ethers.provider.send("hardhat_setBalance", [self.address, "0x1000000000000000000"]);
      await expect(token.connect(self).airdropMint(alice.address, 1n))
        .to.be.revertedWithCustomError(token, "Unauthorized");
      await token.connect(owner).setAirdrop(await airdrop.getAddress());
      await token.connect(owner).setAirdrop(carol.address);
      await token.connect(owner).setAirdrop(await airdrop.getAddress());
      expect(await token.airdrop()).to.equal(await airdrop.getAddress());
    });

    it("airdropLocked is true exactly when the wiring slot is empty", async function () {
      expect(await token.airdropLocked()).to.equal(false);
      await token.connect(owner).setWiringAuthority(ethers.ZeroAddress);
      expect(await token.airdropLocked()).to.equal(true);
      await token.connect(owner).setWiringAuthority(bob.address);
      expect(await token.airdropLocked()).to.equal(false);
    });

    it("a table loaded into a contract the token does not point at cannot be claimed", async function () {
      const other = await newAirdrop();
      await other.connect(owner).loadAirdropBatch([alice.address], [E(10)]);
      await expect(other.connect(alice).claimAirdrop())
        .to.be.revertedWithCustomError(token, "Unauthorized");
    });

    it("a replacement airdrop pays only the difference: the cursor is the token's airdropMintedTo", async function () {
      await airdrop.connect(owner).loadAirdropBatch([alice.address], [E(100)]);
      await airdrop.connect(alice).claimAirdrop();
      expect(await satori.balanceOf(alice.address)).to.equal(E(100));

      const next = await newAirdrop();
      await next.connect(owner).loadAirdropBatch([alice.address, bob.address], [E(150), E(40)]);
      await token.connect(owner).setAirdrop(await next.getAddress());
      expect(await next.claimableAirdrop(alice.address)).to.equal(E(50));
      await expect(next.connect(alice).claimAirdrop())
        .to.emit(next, "AirdropClaimed").withArgs(alice.address, E(50));
      expect(await satori.balanceOf(alice.address)).to.equal(E(150));
      await next.connect(bob).claimAirdrop();
      expect(await token.airdropMinted()).to.equal(E(190));

      // A replacement whose allocation is at or below what was already paid pays nothing.
      const lower = await newAirdrop();
      await lower.connect(owner).loadAirdropBatch([alice.address], [E(150)]);
      await token.connect(owner).setAirdrop(await lower.getAddress());
      expect(await lower.claimableAirdrop(alice.address)).to.equal(0n);
      await expect(lower.connect(alice).claimAirdrop())
        .to.be.revertedWithCustomError(lower, "NothingToClaim");
    });
  });

  describe("the loader role (no admin fallback)", function () {
    it("starts on the constructor's authority; zero is rejected", async function () {
      expect(await airdrop.airdropAuthority()).to.equal(owner.address);
      await expect(airdrop.connect(owner).setAirdropAuthority(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(airdrop, "BadInput");
    });

    it("the holder can rotate it; the new holder loads, the old one cannot", async function () {
      await expect(airdrop.connect(owner).setAirdropAuthority(carol.address))
        .to.emit(airdrop, "AirdropAuthorityChanged").withArgs(owner.address, carol.address);
      await airdrop.connect(carol).loadAirdropBatch([alice.address], [1n]);
      await expect(airdrop.connect(owner).loadAirdropBatch([bob.address], [1n]))
        .to.be.revertedWithCustomError(airdrop, "Unauthorized");
      await expect(airdrop.connect(owner).finalizeAirdropLoading())
        .to.be.revertedWithCustomError(airdrop, "Unauthorized");
    });

    it("the token's appoint authority can recall it — nobody else can", async function () {
      await airdrop.connect(owner).setAirdropAuthority(carol.address);
      await expect(airdrop.connect(alice).setAirdropAuthority(alice.address))
        .to.be.revertedWithCustomError(airdrop, "Unauthorized");
      await token.connect(owner).setAppointAuthority(bob.address);
      await expect(airdrop.connect(owner).setAirdropAuthority(owner.address))
        .to.be.revertedWithCustomError(airdrop, "Unauthorized");
      await airdrop.connect(bob).setAirdropAuthority(alice.address);
      expect(await airdrop.airdropAuthority()).to.equal(alice.address);
    });

    it("rejects a zero token or authority at construction", async function () {
      const F = await ethers.getContractFactory("SatoriAirdrop");
      await expect(F.deploy(ethers.ZeroAddress, owner.address))
        .to.be.revertedWithCustomError(F, "BadInput");
      await expect(F.deploy(await token.getAddress(), ethers.ZeroAddress))
        .to.be.revertedWithCustomError(F, "BadInput");
    });
  });

  describe("finalize closes loading, and only that", function () {
    it("is airdrop-authority-only and one-shot, emits the loaded total, and loading stays closed after it", async function () {
      expect(await airdrop.airdropLoadingFinalized()).to.equal(false);
      await airdrop.connect(owner).loadAirdropBatch([alice.address], [E(100)]);
      for (const s of [bob, alice]) {
        await expect(airdrop.connect(s).finalizeAirdropLoading())
          .to.be.revertedWithCustomError(airdrop, "Unauthorized");
      }
      await expect(airdrop.connect(owner).finalizeAirdropLoading())
        .to.emit(airdrop, "AirdropLoadingFinalized").withArgs(E(100));
      expect(airdrop.interface.getEvent("AirdropLoadingFinalized").inputs.length).to.equal(1);
      expect(await airdrop.airdropLoadingFinalized()).to.equal(true);

      await expect(airdrop.connect(owner).finalizeAirdropLoading())
        .to.be.revertedWithCustomError(airdrop, "AlreadySet");
      await expect(airdrop.connect(owner).loadAirdropBatch([bob.address], [E(1)]))
        .to.be.revertedWithCustomError(airdrop, "AirdropLoadingClosed");
      // The closed gate fires before the batch guards.
      await expect(airdrop.connect(owner).loadAirdropBatch([], []))
        .to.be.revertedWithCustomError(airdrop, "AirdropLoadingClosed");
    });

    it("needs no freeze and no particular pointer: it works while the door points elsewhere", async function () {
      await token.connect(owner).setAirdrop(carol.address);
      await expect(airdrop.connect(owner).finalizeAirdropLoading())
        .to.emit(airdrop, "AirdropLoadingFinalized").withArgs(0n);
    });

    it("claims still work after finalize", async function () {
      await loadTwo(TOTAL / 2n);
      await airdrop.connect(owner).finalizeAirdropLoading();
      await airdrop.connect(alice).claimAirdrop();
      await airdrop.connect(carol).claimAirdropFor(bob.address);
      expect(await satori.balanceOf(alice.address)).to.equal(TOTAL / 2n);
      expect(await satori.balanceOf(bob.address)).to.equal(TOTAL - TOTAL / 2n);
    });
  });

  describe("load and claim", function () {
    it("an allocation is claimable the moment its batch lands, without finalize", async function () {
      await airdrop.connect(owner).loadAirdropBatch([alice.address], [E(1000)]);
      expect(await airdrop.airdropLoadingFinalized()).to.equal(false);
      expect(await airdrop.claimableAirdrop(alice.address)).to.equal(E(1000));
      await expect(airdrop.connect(alice).claimAirdrop())
        .to.emit(airdrop, "AirdropClaimed").withArgs(alice.address, E(1000));
      expect(await satori.balanceOf(alice.address)).to.equal(E(1000));
    });

    it("every claim door pays before finalize: self, sponsored, sweep", async function () {
      await airdrop.connect(owner).loadAirdropBatch([alice.address, bob.address, dave.address], [E(1), E(2), E(3)]);
      await airdrop.connect(alice).claimAirdrop();
      await airdrop.connect(carol).claimAirdropFor(bob.address);
      await airdrop.connect(carol).claimAirdropForMany([dave.address]);
      expect(await airdrop.airdropClaimedTotal()).to.equal(E(6));
    });

    it("loading continues while people claim: a later batch is claimable as it lands", async function () {
      await airdrop.connect(owner).loadAirdropBatch([alice.address], [E(100)]);
      await airdrop.connect(alice).claimAirdrop();
      await airdrop.connect(owner).loadAirdropBatch([bob.address], [E(200)]);
      await airdrop.connect(bob).claimAirdrop();
      expect(await airdrop.airdropLoadedTotal()).to.equal(E(300));
      expect(await airdrop.airdropClaimedTotal()).to.equal(E(300));
    });

    it("a claim in the same block as the load pays", async function () {
      const gas = { gasLimit: 500000 };
      await ethers.provider.send("evm_setAutomine", [false]);
      let txs;
      try {
        txs = [
          await airdrop.connect(owner).loadAirdropBatch([alice.address], [E(1000)], gas),
          await airdrop.connect(alice).claimAirdrop(gas),
        ];
        await ethers.provider.send("evm_mine", []);
      } finally {
        await ethers.provider.send("evm_setAutomine", [true]);
      }
      const [load, claim] = await Promise.all(txs.map((t) => ethers.provider.getTransactionReceipt(t.hash)));
      expect(claim.blockNumber, "one block").to.equal(load.blockNumber);
      expect(load.status, "load").to.equal(1);
      expect(claim.status, "claim").to.equal(1);
      expect(await satori.balanceOf(alice.address)).to.equal(E(1000));
    });

    it("every loaded row emits AirdropAllocated, so the table is enumerable from logs", async function () {
      await expect(airdrop.connect(owner).loadAirdropBatch([alice.address, bob.address], [E(3), E(4)]))
        .to.emit(airdrop, "AirdropAllocated").withArgs(alice.address, E(3))
        .and.to.emit(airdrop, "AirdropAllocated").withArgs(bob.address, E(4));
      await airdrop.connect(owner).loadAirdropBatch([carol.address], [E(5)]);
      const logs = await airdrop.queryFilter(airdrop.filters.AirdropAllocated(), 0);
      expect(logs.map((l) => l.args.recipient)).to.deep.equal([alice.address, bob.address, carol.address]);
      expect(logs.reduce((s, l) => s + l.args.amount, 0n)).to.equal(await airdrop.airdropLoadedTotal());
    });

    it("loading is loader-only, and guards dup / length / zero", async function () {
      await expect(airdrop.connect(alice).loadAirdropBatch([alice.address], [TOTAL]))
        .to.be.revertedWithCustomError(airdrop, "Unauthorized");
      await expect(airdrop.connect(owner).loadAirdropBatch([alice.address, bob.address], [1n]))
        .to.be.revertedWithCustomError(airdrop, "LengthMismatch");
      await expect(airdrop.connect(owner).loadAirdropBatch([alice.address], [0n]))
        .to.be.revertedWithCustomError(airdrop, "BadInput");
      await expect(airdrop.connect(owner).loadAirdropBatch([ethers.ZeroAddress], [1n]))
        .to.be.revertedWithCustomError(airdrop, "BadInput");
      await airdrop.connect(owner).loadAirdropBatch([alice.address], [TOTAL]);
      await expect(airdrop.connect(owner).loadAirdropBatch([alice.address], [1n]))
        .to.be.revertedWithCustomError(airdrop, "DuplicateRecipient");
    });

    it("unallocated address: claimable is 0 and claim reverts NothingToClaim", async function () {
      expect(await airdrop.claimableAirdrop(carol.address)).to.equal(0);
      await expect(airdrop.connect(carol).claimAirdrop())
        .to.be.revertedWithCustomError(airdrop, "NothingToClaim");
    });
  });

  describe("loading refuses past the 1,100,000 ceiling", function () {
    it("a single batch over the cap reverts BudgetExceeded and lands nothing", async function () {
      const big = (TOTAL * 7n) / 10n; // two of these sum to 1.4x the cap
      await expect(airdrop.connect(owner).loadAirdropBatch([alice.address, bob.address], [big, big]))
        .to.be.revertedWithCustomError(airdrop, "BudgetExceeded");
      expect(await airdrop.airdropLoadedTotal()).to.equal(0n);
      expect(await airdrop.airdropAllocation(alice.address)).to.equal(0n);
    });

    it("loading up to exactly the cap works; one more wei in a later batch reverts", async function () {
      await airdrop.connect(owner).loadAirdropBatch([alice.address], [TOTAL - E(1)]);
      await airdrop.connect(owner).loadAirdropBatch([bob.address], [E(1)]);
      expect(await airdrop.airdropLoadedTotal()).to.equal(TOTAL);
      expect(TOTAL).to.equal(E(1100000));
      await expect(airdrop.connect(owner).loadAirdropBatch([carol.address], [1n]))
        .to.be.revertedWithCustomError(airdrop, "BudgetExceeded");
      // Everything loaded is paid in full.
      await airdrop.connect(carol).claimAirdropForMany([alice.address, bob.address]);
      expect(await token.airdropMinted()).to.equal(TOTAL);
    });

    it("1,100,000 + 1 wei is refused even when the excess sits in the first row", async function () {
      await expect(airdrop.connect(owner).loadAirdropBatch([alice.address], [E(1100000) + 1n]))
        .to.be.revertedWithCustomError(airdrop, "BudgetExceeded");
    });
  });

  describe("the whole allocation, one claim", function () {
    const ALICE = E(600000);

    beforeEach(async function () {
      await loadTwo(ALICE); // alice 600k, bob the rest of the cap
    });

    it("the first claim pays the whole allocation; a second pays nothing", async function () {
      expect(await airdrop.claimableAirdrop(alice.address)).to.equal(ALICE);
      await expect(airdrop.connect(alice).claimAirdrop())
        .to.emit(airdrop, "AirdropClaimed").withArgs(alice.address, ALICE);
      expect(await satori.balanceOf(alice.address)).to.equal(ALICE);
      expect(await airdrop.claimableAirdrop(alice.address)).to.equal(0n);
      await expect(airdrop.connect(alice).claimAirdrop())
        .to.be.revertedWithCustomError(airdrop, "NothingToClaim");
    });

    it("a never-claiming user can still claim their full allocation years later", async function () {
      await time.increase(3650n * DAY);
      await airdrop.connect(bob).claimAirdrop();
      expect(await satori.balanceOf(bob.address)).to.equal(TOTAL - ALICE);
    });
  });

  describe("conservation + cap", function () {
    it("keeps totalSupply == totalRewardsMinted + airdropClaimedTotal; never exceeds the cap", async function () {
      await loadTwo(E(600000));
      await airdrop.connect(alice).claimAirdrop();
      await airdrop.connect(bob).claimAirdrop();

      const claimedTotal = await airdrop.airdropClaimedTotal();
      expect(claimedTotal).to.equal(TOTAL);
      expect((await satori.totalSupply()) + (await burnedTotal(token))).to.equal(
        (await satori.totalRewardsMinted()) + claimedTotal
      );
    });
  });

  describe("claiming for someone else", function () {
    beforeEach(async function () {
      await loadTwo(TOTAL / 2n);
    });

    it("claimAirdropFor mints to the RECIPIENT, never to the caller", async function () {
      const bobBefore = await satori.balanceOf(bob.address);
      await expect(airdrop.connect(carol).claimAirdropFor(alice.address))
        .to.emit(airdrop, "AirdropClaimed").withArgs(alice.address, TOTAL / 2n);
      expect(await satori.balanceOf(alice.address)).to.equal(TOTAL / 2n);
      expect(await satori.balanceOf(carol.address)).to.equal(0n);
      expect(await satori.balanceOf(bob.address)).to.equal(bobBefore);
    });

    it("reverts NothingToClaim when the recipient has nothing owed", async function () {
      await airdrop.connect(carol).claimAirdropFor(alice.address);
      await expect(airdrop.connect(carol).claimAirdropFor(alice.address))
        .to.be.revertedWithCustomError(airdrop, "NothingToClaim");
      await expect(airdrop.connect(carol).claimAirdropFor(carol.address))
        .to.be.revertedWithCustomError(airdrop, "NothingToClaim");
    });

    it("claimAirdropForMany pays everyone owed and SKIPS the rest without reverting", async function () {
      await airdrop.connect(alice).claimAirdrop();
      await expect(airdrop.connect(carol).claimAirdropForMany([
        alice.address, bob.address, carol.address, ethers.ZeroAddress,
      ])).to.not.be.reverted;
      expect(await satori.balanceOf(alice.address)).to.equal(TOTAL / 2n);
      expect(await satori.balanceOf(bob.address)).to.equal(TOTAL - TOTAL / 2n);
      expect(await satori.balanceOf(carol.address)).to.equal(0n);
    });

    it("returns the total actually paid, so a sweep can be dry-run before it spends gas", async function () {
      const quoted = await airdrop.connect(carol).claimAirdropForMany.staticCall([
        alice.address, bob.address, carol.address,
      ]);
      expect(quoted).to.equal(TOTAL);
    });

    it("an empty list is a no-op, not a revert", async function () {
      await expect(airdrop.connect(carol).claimAirdropForMany([])).to.not.be.reverted;
      expect(await airdrop.airdropClaimedTotal()).to.equal(0n);
    });

    it("sponsored claims keep the supply identity and the cap exact; a re-run pays nothing", async function () {
      await airdrop.connect(carol).claimAirdropForMany([alice.address, bob.address]);
      const claimedTotal = await airdrop.airdropClaimedTotal();
      expect(claimedTotal).to.equal(TOTAL);
      expect((await satori.totalSupply()) + (await burnedTotal(token))).to.equal(
        (await satori.totalRewardsMinted()) + claimedTotal
      );
      await airdrop.connect(carol).claimAirdropForMany([alice.address, bob.address]);
      expect(await airdrop.airdropClaimedTotal()).to.equal(TOTAL);
    });

    it("a sponsored claim and a self-claim are interchangeable", async function () {
      await airdrop.connect(carol).claimAirdropFor(alice.address);
      await airdrop.connect(bob).claimAirdrop();
      expect(await satori.balanceOf(alice.address)).to.equal(
        await satori.balanceOf(bob.address)
      );
    });
  });
});
