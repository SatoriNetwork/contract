// SatoriAirdrop: the one-time airdrop in its OWN contract, no proxy, no upgrade
// path (docs/issues/airdrop-own-contract.md). The loader writes the table in
// batches; the freeze authority pins the token's airdrop door to it, which also
// closes the table; the loader finalizes, and from that moment every recipient
// claims their whole
// allocation at once — no vesting, no delay
// (docs/issues/airdrop-claim-at-finalize.md). Mint-on-claim through the
// token's SEPARATE airdropMint door, which is gated on the token's `airdrop`
// pointer — not the controller — so neither the hub nor SatoriRewards can
// reach it.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture } = require("./fixtures");

const DAY = 24n * 3600n;
const E = (n) => ethers.parseEther(String(n));

describe("SatoriAirdrop (own contract, whole allocation at finalize)", function () {
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

  // Pin the token's airdrop door to this contract, then finalize: claims are
  // open from the next transaction.
  async function freezeAndFinalize() {
    await token.connect(owner).freezeAirdrop();
    await airdrop.connect(owner).finalizeAirdropLoading();
  }

  async function newAirdrop() {
    return (await ethers.getContractFactory("SatoriAirdrop"))
      .deploy(await token.getAddress(), owner.address);
  }

  // alice holds a row on `c`; none of the three claim doors may pay it.
  async function expectClaimsClosed(c) {
    expect(await c.claimableAirdrop(alice.address)).to.equal(0n);
    await expect(c.connect(alice).claimAirdrop())
      .to.be.revertedWithCustomError(c, "ClaimsNotOpen");
    await expect(c.connect(carol).claimAirdropFor(alice.address))
      .to.be.revertedWithCustomError(c, "ClaimsNotOpen");
    await expect(c.connect(carol).claimAirdropForMany([alice.address]))
      .to.be.revertedWithCustomError(c, "ClaimsNotOpen");
  }

  describe("bound to the token, with nothing above it", function () {
    it("token.airdrop points at the contract and the contract points back", async function () {
      expect(await token.airdrop()).to.equal(await airdrop.getAddress());
      expect(await airdrop.token()).to.equal(await token.getAddress());
    });

    it("the ceiling, the cursor and the counter are READ from the token, never copied", async function () {
      expect(TOTAL).to.equal(await token.AIRDROP_TOTAL_SUPPLY());
      await loadTwo(TOTAL / 2n);
      await freezeAndFinalize();
      await airdrop.connect(alice).claimAirdrop();
      expect(await airdrop.airdropClaimed(alice.address))
        .to.equal(await token.airdropMintedTo(alice.address));
      expect(await airdrop.airdropClaimedTotal()).to.equal(await token.airdropMinted());
    });

    it("has no upgrade surface, no vesting or early-claim surface, and no claim delay", async function () {
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
    });
  });

  describe("the token's airdrop door", function () {
    it("airdropMint is callable ONLY by the airdrop contract: not an EOA, not the controller (hub)", async function () {
      await expect(token.connect(alice).airdropMint(alice.address, 1n))
        .to.be.revertedWithCustomError(token, "Unauthorized");
      // The hub is the controller and used to forward airdropMint. It no longer
      // can, and no longer exposes a forwarder to try.
      const hubSigner = await ethers.getImpersonatedSigner(await hub.getAddress());
      await ethers.provider.send("hardhat_setBalance", [hubSigner.address, "0x1000000000000000000"]);
      await expect(token.connect(hubSigner).airdropMint(alice.address, 1n))
        .to.be.revertedWithCustomError(token, "Unauthorized");
      expect(hub.interface.getFunction("airdropMint")).to.equal(null);
      // SatoriRewards no longer knows the airdrop exists.
      expect(rewards.interface.getFunction("claimAirdrop")).to.equal(null);
      expect(rewards.interface.getFunction("loadAirdropBatch")).to.equal(null);
    });

    it("setAirdrop is wiring-gated, rejects zero, and is repeatable until frozen; the door moves with it", async function () {
      await expect(token.connect(alice).setAirdrop(alice.address))
        .to.be.revertedWithCustomError(token, "Unauthorized");
      await expect(token.connect(owner).setAirdrop(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(token, "BadInput");
      await expect(token.connect(owner).setAirdrop(carol.address))
        .to.emit(token, "AirdropSet").withArgs(carol.address);
      expect(await token.airdrop()).to.equal(carol.address);
      // Re-pointing moves the door: the new pointer can mint, the old contract cannot.
      const self = await ethers.getImpersonatedSigner(await airdrop.getAddress());
      await ethers.provider.send("hardhat_setBalance", [self.address, "0x1000000000000000000"]);
      await expect(token.connect(self).airdropMint(alice.address, 1n))
        .to.be.revertedWithCustomError(token, "Unauthorized");
      await token.connect(carol).airdropMint(alice.address, 1n);
      expect(await token.airdropMintedTo(alice.address)).to.equal(1n);
      await token.connect(owner).setAirdrop(await airdrop.getAddress());
      expect(await token.airdrop()).to.equal(await airdrop.getAddress());
    });

    it("a claim pays only what the token has not already minted to the recipient", async function () {
      // Mints through an earlier pointer, before the freeze, advance the
      // token's per-recipient cursor; the airdrop reads that cursor.
      await token.connect(owner).setAirdrop(carol.address);
      await token.connect(carol).airdropMint(alice.address, 1n);
      await token.connect(carol).airdropMint(bob.address, E(5));
      await token.connect(carol).airdropMint(dave.address, E(7));
      await token.connect(owner).setAirdrop(await airdrop.getAddress());
      await airdrop.connect(owner).loadAirdropBatch(
        [alice.address, bob.address, dave.address],
        [E(100), E(5), E(5)]
      );
      await freezeAndFinalize();

      expect(await airdrop.claimableAirdrop(alice.address)).to.equal(E(100) - 1n);
      await expect(airdrop.connect(alice).claimAirdrop())
        .to.emit(airdrop, "AirdropClaimed").withArgs(alice.address, E(100) - 1n);
      expect(await satori.balanceOf(alice.address)).to.equal(E(100));
      expect(await airdrop.airdropClaimed(alice.address)).to.equal(E(100));

      // Already minted as much as allocated, or more: nothing owed.
      for (const w of [bob, dave]) {
        expect(await airdrop.claimableAirdrop(w.address)).to.equal(0n);
        await expect(airdrop.connect(w).claimAirdrop())
          .to.be.revertedWithCustomError(airdrop, "NothingToClaim");
      }
      expect(await satori.balanceOf(bob.address)).to.equal(E(5));
      expect(await satori.balanceOf(dave.address)).to.equal(E(7));
    });

    it("freezeAirdrop is freeze-gated, refuses an unset pointer, and is one-way", async function () {
      expect(await token.airdropFrozen()).to.equal(false);
      expect(await token.airdropLocked()).to.equal(false);
      await expect(token.connect(alice).freezeAirdrop())
        .to.be.revertedWithCustomError(token, "Unauthorized");

      // An unset pointer cannot be frozen — that would close the door forever
      // with nothing behind it. Prove it on a fresh token.
      const bare = await (await ethers.getContractFactory("SatoriToken"))
        .deploy(owner.address, owner.address, (await ethers.provider.getNetwork()).chainId);
      await expect(bare.connect(owner).freezeAirdrop())
        .to.be.revertedWithCustomError(bare, "AirdropNotSet");

      const addr = await airdrop.getAddress();
      await loadTwo(TOTAL / 2n);
      await expect(token.connect(owner).freezeAirdrop())
        .to.emit(token, "AirdropFrozen").withArgs(addr);
      expect(await token.airdropFrozen()).to.equal(true);
      expect(await token.airdropLocked()).to.equal(true);
      await expect(token.connect(owner).setAirdrop(carol.address))
        .to.be.revertedWithCustomError(token, "Frozen");
      expect(await token.airdrop()).to.equal(addr);
      // Frozen means frozen AT the standing contract — it keeps working.
      await airdrop.connect(owner).finalizeAirdropLoading();
      await expect(airdrop.connect(alice).claimAirdrop()).to.emit(airdrop, "AirdropClaimed");
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
      // owner holds token.appointAuthority at this point (the fixture seeds
      // every token slot with the owner). Move it to bob and let bob recall.
      await token.connect(owner).setAppointAuthority(bob.address);
      await expect(airdrop.connect(owner).setAirdropAuthority(owner.address))
        .to.be.revertedWithCustomError(airdrop, "Unauthorized");
      await airdrop.connect(bob).setAirdropAuthority(alice.address);
      expect(await airdrop.airdropAuthority()).to.equal(alice.address);
    });

    it("rejects a zero token at construction", async function () {
      const F = await ethers.getContractFactory("SatoriAirdrop");
      await expect(F.deploy(ethers.ZeroAddress, owner.address))
        .to.be.revertedWithCustomError(F, "BadInput");
      await expect(F.deploy(await token.getAddress(), ethers.ZeroAddress))
        .to.be.revertedWithCustomError(F, "BadInput");
    });
  });

  describe("finalize waits for the frozen door", function () {
    it("refuses AirdropNotFrozen until the door is frozen to this contract", async function () {
      await loadTwo(TOTAL / 2n);
      expect(await token.airdrop()).to.equal(await airdrop.getAddress());
      await expect(airdrop.connect(owner).finalizeAirdropLoading())
        .to.be.revertedWithCustomError(airdrop, "AirdropNotFrozen");
      await token.connect(owner).freezeAirdrop();
      await expect(airdrop.connect(owner).finalizeAirdropLoading())
        .to.emit(airdrop, "AirdropLoadingFinalized").withArgs(TOTAL);
    });

    it("refuses AirdropNotFrozen while the door points at, or is frozen to, another contract", async function () {
      const other = await newAirdrop();
      await token.connect(owner).setAirdrop(await other.getAddress());
      await expect(airdrop.connect(owner).finalizeAirdropLoading())
        .to.be.revertedWithCustomError(airdrop, "AirdropNotFrozen");
      await token.connect(owner).freezeAirdrop();
      await expect(airdrop.connect(owner).finalizeAirdropLoading())
        .to.be.revertedWithCustomError(airdrop, "AirdropNotFrozen");
      expect(await airdrop.airdropLoadingFinalized()).to.equal(false);
    });

    it("an emptied wiring slot is not enough: root can refill it and the door moves again", async function () {
      await token.connect(owner).setWiringAuthority(ethers.ZeroAddress);
      // The token's airdropLocked view counts an emptied slot; loading and
      // finalize do not.
      expect(await token.airdropLocked()).to.equal(true);
      expect(await token.airdropFrozen()).to.equal(false);
      await loadTwo(TOTAL / 2n);
      await expect(airdrop.connect(owner).finalizeAirdropLoading())
        .to.be.revertedWithCustomError(airdrop, "AirdropNotFrozen");

      await token.connect(owner).setWiringAuthority(bob.address);
      await token.connect(bob).setAirdrop(carol.address);
      expect(await token.airdrop()).to.equal(carol.address);

      // Only the one-way freeze pins the door.
      await token.connect(bob).setAirdrop(await airdrop.getAddress());
      await freezeAndFinalize();
      await expect(token.connect(bob).setAirdrop(carol.address))
        .to.be.revertedWithCustomError(token, "Frozen");
      await airdrop.connect(alice).claimAirdrop();
      expect(await satori.balanceOf(alice.address)).to.equal(TOTAL / 2n);
    });

    it("is airdrop-authority-only and one-shot, emits only the loaded total, and loading stays closed after it", async function () {
      // Separate keys, as in production: the freeze authority freezes, the
      // loader finalizes, and neither can take the other's step.
      await token.connect(owner).setFreezeAuthority(bob.address);
      expect(await airdrop.airdropLoadingFinalized()).to.equal(false);
      await airdrop.connect(owner).loadAirdropBatch([alice.address], [E(100)]);
      await expect(token.connect(owner).freezeAirdrop())
        .to.be.revertedWithCustomError(token, "Unauthorized");
      await token.connect(bob).freezeAirdrop();
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
    });
  });

  describe("load, freeze, finalize, claim", function () {
    it("nothing is claimable before finalize, frozen door or not: every door reverts ClaimsNotOpen", async function () {
      await loadTwo(TOTAL / 4n);
      await time.increase(365n * DAY);
      await expectClaimsClosed(airdrop);
      await token.connect(owner).freezeAirdrop();
      await expectClaimsClosed(airdrop);
    });

    it("the whole allocation is claimable the moment finalize lands, with no waiting", async function () {
      await airdrop.connect(owner).loadAirdropBatch([alice.address], [E(1000)]);
      await freezeAndFinalize();
      expect(await airdrop.claimableAirdrop(alice.address)).to.equal(E(1000));
      await expect(airdrop.connect(alice).claimAirdrop())
        .to.emit(airdrop, "AirdropClaimed").withArgs(alice.address, E(1000));
      expect(await satori.balanceOf(alice.address)).to.equal(E(1000));
    });

    it("a claim in the same block as finalize pays", async function () {
      await airdrop.connect(owner).loadAirdropBatch([alice.address], [E(1000)]);
      await token.connect(owner).freezeAirdrop();
      // Explicit gas limits: estimation must not depend on whether it sees
      // the pending finalize.
      const gas = { gasLimit: 500000 };
      await ethers.provider.send("evm_setAutomine", [false]);
      let txs;
      try {
        txs = [
          await airdrop.connect(owner).finalizeAirdropLoading(gas),
          await airdrop.connect(alice).claimAirdrop(gas),
        ];
        await ethers.provider.send("evm_mine", []);
      } finally {
        await ethers.provider.send("evm_setAutomine", [true]);
      }
      const [fin, claim] = await Promise.all(txs.map((t) => ethers.provider.getTransactionReceipt(t.hash)));
      expect(claim.blockNumber, "one block").to.equal(fin.blockNumber);
      expect(fin.status, "finalize").to.equal(1);
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
      await freezeAndFinalize();
      expect(await airdrop.claimableAirdrop(carol.address)).to.equal(0);
      await expect(airdrop.connect(carol).claimAirdrop())
        .to.be.revertedWithCustomError(airdrop, "NothingToClaim");
    });

    it("over-loading is not blocked, but the token cap locks out claims past the ceiling", async function () {
      const big = (TOTAL * 7n) / 10n; // two of these sum to 1.4x the cap
      await airdrop.connect(owner).loadAirdropBatch([alice.address, bob.address], [big, big]);
      await freezeAndFinalize();
      await airdrop.connect(alice).claimAirdrop(); // 0.7x cap — under the ceiling
      expect(await satori.balanceOf(alice.address)).to.equal(big);
      await expect(airdrop.connect(bob).claimAirdrop())
        .to.be.revertedWithCustomError(token, "BudgetExceeded");
    });
  });

  describe("the freeze closes the table: the last chance to fix it", function () {
    it("loading works before the freeze, batch after batch; once the door is frozen to this contract no row lands, before finalize too", async function () {
      await airdrop.connect(owner).loadAirdropBatch([alice.address], [E(100)]);
      await airdrop.connect(owner).loadAirdropBatch([bob.address], [E(200)]);
      await token.connect(owner).freezeAirdrop();
      expect(await airdrop.airdropLoadingFinalized()).to.equal(false);
      await expect(airdrop.connect(owner).loadAirdropBatch([carol.address], [E(1)]))
        .to.be.revertedWithCustomError(airdrop, "AirdropLoadingClosed");
      // The closed gate fires before the batch guards.
      await expect(airdrop.connect(owner).loadAirdropBatch([], []))
        .to.be.revertedWithCustomError(airdrop, "AirdropLoadingClosed");
      expect(await airdrop.airdropAllocation(carol.address)).to.equal(0n);
      // What was checked before the freeze is exactly what finalize opens.
      await expect(airdrop.connect(owner).finalizeAirdropLoading())
        .to.emit(airdrop, "AirdropLoadingFinalized").withArgs(E(300));
    });

    it("a door frozen to another contract closes this table too", async function () {
      await airdrop.connect(owner).loadAirdropBatch([alice.address], [E(100)]);
      const other = await newAirdrop();
      await token.connect(owner).setAirdrop(await other.getAddress());
      // Re-pointing alone closes nothing: both tables still load.
      await airdrop.connect(owner).loadAirdropBatch([bob.address], [E(1)]);
      await other.connect(owner).loadAirdropBatch([alice.address], [E(100)]);
      await token.connect(owner).freezeAirdrop();
      for (const c of [airdrop, other]) {
        await expect(c.connect(owner).loadAirdropBatch([carol.address], [E(1)]))
          .to.be.revertedWithCustomError(c, "AirdropLoadingClosed");
      }
      expect(await airdrop.airdropLoadedTotal()).to.equal(E(101));
      expect(await other.airdropLoadedTotal()).to.equal(E(100));
    });

    it("a freeze before the first batch leaves this airdrop empty for good", async function () {
      await token.connect(owner).freezeAirdrop();
      await expect(airdrop.connect(owner).loadAirdropBatch([alice.address], [E(100)]))
        .to.be.revertedWithCustomError(airdrop, "AirdropLoadingClosed");
      await expect(token.connect(owner).setAirdrop(carol.address))
        .to.be.revertedWithCustomError(token, "Frozen");
      await airdrop.connect(owner).finalizeAirdropLoading();
      expect(await airdrop.claimableAirdrop(alice.address)).to.equal(0n);
      await expect(airdrop.connect(alice).claimAirdrop())
        .to.be.revertedWithCustomError(airdrop, "NothingToClaim");
    });

    it("a wrong table found before the freeze is replaced, not paid", async function () {
      await airdrop.connect(owner).loadAirdropBatch([alice.address], [E(1000)]); // meant 100
      // Before the freeze: deploy a corrected contract and move the door to it.
      const fixed = await newAirdrop();
      await fixed.connect(owner).loadAirdropBatch([alice.address], [E(100)]);
      await token.connect(owner).setAirdrop(await fixed.getAddress());
      await token.connect(owner).freezeAirdrop();
      await fixed.connect(owner).finalizeAirdropLoading();
      await fixed.connect(alice).claimAirdrop();
      expect(await satori.balanceOf(alice.address)).to.equal(E(100));
      // With the door frozen on the corrected contract, the abandoned one can
      // never finalize, so the 900 its table still says alice is owed is never
      // paid.
      await expect(airdrop.connect(owner).finalizeAirdropLoading())
        .to.be.revertedWithCustomError(airdrop, "AirdropNotFrozen");
      await expectClaimsClosed(airdrop);
      expect(await satori.balanceOf(alice.address)).to.equal(E(100));
    });

    it("after freeze + finalize nothing claimable can be added: no new row, no new contract", async function () {
      await loadTwo(TOTAL / 2n);
      await freezeAndFinalize();
      await expect(airdrop.connect(owner).loadAirdropBatch([carol.address], [E(1)]))
        .to.be.revertedWithCustomError(airdrop, "AirdropLoadingClosed");
      // A contract deployed after the freeze cannot even be loaded.
      const other = await newAirdrop();
      await expect(other.connect(owner).loadAirdropBatch([carol.address], [E(1)]))
        .to.be.revertedWithCustomError(other, "AirdropLoadingClosed");
      await expect(token.connect(owner).setAirdrop(await other.getAddress()))
        .to.be.revertedWithCustomError(token, "Frozen");
      await expect(other.connect(owner).finalizeAirdropLoading())
        .to.be.revertedWithCustomError(other, "AirdropNotFrozen");
      await expect(other.connect(carol).claimAirdrop())
        .to.be.revertedWithCustomError(other, "ClaimsNotOpen");
      expect(await airdrop.claimableAirdrop(carol.address)).to.equal(0n);
    });
  });

  describe("the whole allocation, one claim", function () {
    const ALICE = E(600000);

    beforeEach(async function () {
      await loadTwo(ALICE); // alice 600k, bob the rest of the cap
      await freezeAndFinalize();
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
      await freezeAndFinalize();

      await airdrop.connect(alice).claimAirdrop();
      await airdrop.connect(bob).claimAirdrop();

      const claimedTotal = await airdrop.airdropClaimedTotal();
      expect(claimedTotal).to.equal(TOTAL);
      expect(await satori.totalSupply()).to.equal(
        (await satori.totalRewardsMinted()) + claimedTotal
      );
    });
  });

  describe("claiming for someone else", function () {
    beforeEach(async function () {
      await loadTwo(TOTAL / 2n);
      await freezeAndFinalize();
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
      expect(await satori.totalSupply()).to.equal(
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
