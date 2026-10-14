// SatoriAirdrop: the one-time vesting drip in its OWN contract, no proxy, no
// upgrade path (docs/issues/airdrop-own-contract.md). Table-loaded, 5-year
// linear vest, LIVE FROM DEPLOY (airdropStart is the construction block, an
// immutable). Mint-on-claim through the token's SEPARATE airdropMint door,
// which is gated on the token's `airdrop` pointer — not the controller — so
// neither the hub nor SatoriRewards can reach it.
//
// Carries every test from the SatoriRewards era (Airdrop.test.js and
// AirdropFinalize.test.js) so the move is proven behaviour-preserving, then
// adds what is new: the token pointer, its freeze lever, and the loader role
// with no admin fallback.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture } = require("./fixtures");

const VEST = 1825n * 24n * 3600n; // 1825 days in seconds (matches AIRDROP_VEST)
const E = (n) => ethers.parseEther(String(n));
// One sixth at once, the rest linear off the single anchor — mirrors
// SatoriAirdrop.airdropVested (docs/issues/airdrop-upfront-sixth.md).
const vestedAt = (alloc, elapsed) => {
  if (elapsed >= VEST) return alloc;
  const upfront = alloc / 6n;
  return upfront + ((alloc - upfront) * elapsed) / VEST;
};

describe("SatoriAirdrop (own contract, vesting drip, live from deploy)", function () {
  let satori, token, airdrop, hub, rewards, owner, alice, bob, carol, TOTAL;

  beforeEach(async function () {
    const fix = await deploySatoriFixture();
    ({ satori, token, airdrop, hub, rewards, owner } = fix); // owner is the loader
    [, alice, bob, carol] = fix.signers;
    TOTAL = await airdrop.AIRDROP_TOTAL_SUPPLY();
  });

  async function loadTwo(aAmt) {
    await airdrop.connect(owner).loadAirdropBatch(
      [alice.address, bob.address],
      [aAmt, TOTAL - aAmt]
    );
  }

  describe("bound to the token, with nothing above it", function () {
    it("token.airdrop points at the contract and the contract points back", async function () {
      expect(await token.airdrop()).to.equal(await airdrop.getAddress());
      expect(await airdrop.token()).to.equal(await token.getAddress());
    });

    it("the ceiling, the cursor and the counter are READ from the token, never copied", async function () {
      expect(TOTAL).to.equal(await token.AIRDROP_TOTAL_SUPPLY());
      await loadTwo(TOTAL / 2n);
      await time.increase(VEST / 4n);
      await airdrop.connect(alice).claimAirdrop();
      expect(await airdrop.airdropClaimed(alice.address))
        .to.equal(await token.airdropMintedTo(alice.address));
      expect(await airdrop.airdropClaimedTotal()).to.equal(await token.airdropMinted());
    });

    it("airdropStart is the construction block, and AIRDROP_VEST is 1825 days", async function () {
      expect(await airdrop.airdropStart()).to.be.gt(0);
      expect(await airdrop.AIRDROP_VEST()).to.equal(VEST);
    });

    it("has no upgrade surface at all", async function () {
      for (const f of ["upgradeTo", "renounceUpgrade", "implementation", "initialize"]) {
        expect(airdrop.interface.getFunction(f), f).to.equal(null);
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

    it("setAirdrop is wiring-gated, rejects zero, and is repeatable until frozen", async function () {
      await expect(token.connect(alice).setAirdrop(alice.address))
        .to.be.revertedWithCustomError(token, "Unauthorized");
      await expect(token.connect(owner).setAirdrop(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(token, "BadInput");
      await expect(token.connect(owner).setAirdrop(carol.address))
        .to.emit(token, "AirdropSet").withArgs(carol.address);
      expect(await token.airdrop()).to.equal(carol.address);
      // Re-pointing moves the door: the old contract can no longer mint.
      await loadTwo(TOTAL / 2n);
      await time.increase(VEST / 4n);
      await expect(airdrop.connect(alice).claimAirdrop())
        .to.be.revertedWithCustomError(token, "Unauthorized");
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
      await expect(token.connect(owner).freezeAirdrop())
        .to.emit(token, "AirdropFrozen").withArgs(addr);
      expect(await token.airdropFrozen()).to.equal(true);
      expect(await token.airdropLocked()).to.equal(true);
      await expect(token.connect(owner).setAirdrop(carol.address))
        .to.be.revertedWithCustomError(token, "Frozen");
      expect(await token.airdrop()).to.equal(addr);
      // Frozen means frozen AT the standing contract — it keeps working.
      await loadTwo(TOTAL / 2n);
      await time.increase(VEST / 4n);
      await expect(airdrop.connect(alice).claimAirdrop()).to.emit(airdrop, "AirdropClaimed");
    });

    it("airdropLocked also reports an emptied wiring slot", async function () {
      await token.connect(owner).setWiringAuthority(ethers.ZeroAddress);
      expect(await token.airdropFrozen()).to.equal(false);
      expect(await token.airdropLocked()).to.equal(true);
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

  describe("always live from deploy", function () {
    it("airdropStart is anchored at deploy; a loaded recipient can claim with no finalize step", async function () {
      expect(await airdrop.airdropStart()).to.be.gt(0);
      await loadTwo(TOTAL / 4n);
      expect(await airdrop.airdropLoadedTotal()).to.equal(TOTAL);
      await time.increase(VEST / 10n);
      await expect(airdrop.connect(alice).claimAirdrop()).to.emit(airdrop, "AirdropClaimed");
    });

    it("the loader can keep adding recipients while others are claiming", async function () {
      await airdrop.connect(owner).loadAirdropBatch([alice.address], [TOTAL / 2n]);
      await time.increase(VEST / 2n);
      await airdrop.connect(alice).claimAirdrop(); // claims against a partial table
      await airdrop.connect(owner).loadAirdropBatch([bob.address], [TOTAL / 2n]);
      expect(await airdrop.airdropLoadedTotal()).to.equal(TOTAL);
      // bob is back-vested off the deploy anchor and can claim his elapsed share
      expect(await airdrop.claimableAirdrop(bob.address)).to.be.gt(0);
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
      await time.increase(VEST / 2n);
      expect(await airdrop.claimableAirdrop(carol.address)).to.equal(0);
      await expect(airdrop.connect(carol).claimAirdrop())
        .to.be.revertedWithCustomError(airdrop, "NothingToClaim");
    });

    it("over-loading is not blocked, but the token cap locks out claims past the ceiling", async function () {
      const big = (TOTAL * 7n) / 10n; // two of these sum to 1.4x the cap
      await airdrop.connect(owner).loadAirdropBatch([alice.address, bob.address], [big, big]);
      await time.increase(VEST * 2n); // fully vested
      await airdrop.connect(alice).claimAirdrop(); // 0.7x cap — under the ceiling
      expect(await satori.balanceOf(alice.address)).to.equal(big);
      await expect(airdrop.connect(bob).claimAirdrop())
        .to.be.revertedWithCustomError(token, "BudgetExceeded");
    });
  });

  describe("one sixth at once, the rest drips", function () {
    const ALICE = E(600000);

    beforeEach(async function () {
      await loadTwo(ALICE); // alice 600k, bob the rest of the cap
    });

    it("a sixth is claimable the block after the load; the other five sixths vest linearly", async function () {
      // The instant after loading: exactly alloc/6 plus a few seconds of drip.
      const start = await airdrop.airdropStart();
      const nowLoad = BigInt(await time.latest());
      expect(await airdrop.claimableAirdrop(alice.address)).to.equal(vestedAt(ALICE, nowLoad - start));
      expect(await airdrop.claimableAirdrop(alice.address)).to.be.gte(ALICE / 6n);
      expect(await airdrop.claimableAirdrop(alice.address)).to.be.lt(ALICE / 6n + ALICE / 1000000n);
      const bal0 = await satori.balanceOf(alice.address);
      await airdrop.connect(alice).claimAirdrop();
      const nowClaim = BigInt(await time.latest());
      expect((await satori.balanceOf(alice.address)) - bal0).to.equal(vestedAt(ALICE, nowClaim - start));
      // Half-way: the sixth plus half of the rest, i.e. 7/12.
      await time.setNextBlockTimestamp(Number(start) + Number(VEST) / 2);
      await ethers.provider.send("evm_mine", []);
      expect(await airdrop.airdropVested(alice.address)).to.equal(ALICE / 6n + (ALICE - ALICE / 6n) / 2n);
      expect(await airdrop.airdropVested(alice.address)).to.equal(ALICE * 7n / 12n);
    });

    it("vests exactly the formula, monotonically, and saturates to the full allocation", async function () {
      const start = await airdrop.airdropStart();

      await time.increase(VEST / 2n);
      const bal0 = await satori.balanceOf(alice.address);
      await airdrop.connect(alice).claimAirdrop();
      const bal1 = await satori.balanceOf(alice.address);
      const now1 = BigInt(await time.latest());
      const expected1 = vestedAt(ALICE, now1 - start);
      expect(bal1 - bal0).to.equal(expected1);            // exact: sixth + half the rest
      expect(await airdrop.airdropClaimed(alice.address)).to.equal(expected1);

      await time.increase(VEST);
      await airdrop.connect(alice).claimAirdrop();
      expect(await airdrop.airdropClaimed(alice.address)).to.equal(ALICE); // saturates, no dust
      expect(await satori.balanceOf(alice.address)).to.equal(ALICE);
      await expect(airdrop.connect(alice).claimAirdrop())
        .to.be.revertedWithCustomError(airdrop, "NothingToClaim");
    });

    it("airdropVested is the public form of the schedule the claim path uses", async function () {
      await time.increase(VEST / 5n);
      const vested = await airdrop.airdropVested(alice.address);
      expect(vested).to.equal(await airdrop.claimableAirdrop(alice.address));
      const now = BigInt(await time.latest());
      expect(vested).to.equal(vestedAt(ALICE, now - (await airdrop.airdropStart())));
      expect(await airdrop.airdropVested(carol.address)).to.equal(0n);
      expect(await airdrop.UPFRONT_DIVISOR()).to.equal(6n);
    });

    it("a late load is back-vested: the sixth plus the elapsed share of the rest, at once", async function () {
      const start = await airdrop.airdropStart();
      await time.setNextBlockTimestamp(Number(start) + Number(VEST) * 3 / 5);
      await airdrop.connect(owner).loadAirdropBatch([carol.address], [E(1000)]);
      const now = BigInt(await time.latest());
      expect(await airdrop.claimableAirdrop(carol.address)).to.equal(vestedAt(E(1000), now - start));
      expect(await airdrop.claimableAirdrop(carol.address)).to.equal(E(1000) / 6n + (E(1000) - E(1000) / 6n) * 3n / 5n);
    });

    it("a one-wei allocation has no upfront sixth and vests its wei at the window's end, no dust", async function () {
      await airdrop.connect(owner).loadAirdropBatch([carol.address], [1n]);
      expect(await airdrop.claimableAirdrop(carol.address)).to.equal(0n);
      await time.increase(VEST);
      expect(await airdrop.claimableAirdrop(carol.address)).to.equal(1n);
    });

    it("a never-claiming user can still claim their full alloc years later", async function () {
      await time.increase(VEST * 3n);
      const bal0 = await satori.balanceOf(bob.address);
      await airdrop.connect(bob).claimAirdrop();
      expect((await satori.balanceOf(bob.address)) - bal0).to.equal(TOTAL - ALICE);
    });
  });

  // docs/issues/airdrop-early-claim.md — buy out the locked remainder at the
  // elapsed fraction f, forfeit the rest. total = alloc·f·(2−f).
  describe("early claim (buy out the remainder)", function () {
    const ALICE = E(1000);
    let start;

    beforeEach(async function () {
      await loadTwo(ALICE);
      await airdrop.connect(owner).setEarlyClaimEnabled(true);
      start = Number(await airdrop.airdropStart());
    });

    it("ships OFF: the door reverts EarlyClaimDisabled until the loader opens it, and can be closed again", async function () {
      // A fresh stack: nothing has switched it on.
      const fix = await deploySatoriFixture();
      const fresh = fix.airdrop;
      expect(await fresh.earlyClaimEnabled()).to.equal(false);
      await fresh.connect(fix.owner).loadAirdropBatch([alice.address], [ALICE]);
      await time.increase(VEST / 2n);
      // The quote is informational and still answers; the door does not open.
      const [paid] = await fresh.earlyClaimQuote(alice.address);
      expect(paid).to.be.gt(0n);
      await expect(fresh.connect(alice).claimAirdropEarly())
        .to.be.revertedWithCustomError(fresh, "EarlyClaimDisabled");
      // Nothing moved — not even the drip slice the call would have paid first.
      expect(await fix.token.airdropMintedTo(alice.address)).to.equal(0n);
      expect(await fresh.airdropAllocation(alice.address)).to.equal(ALICE);
      // Only the loader can switch it.
      await expect(fresh.connect(alice).setEarlyClaimEnabled(true))
        .to.be.revertedWithCustomError(fresh, "Unauthorized");
      await expect(fresh.connect(fix.owner).setEarlyClaimEnabled(true))
        .to.emit(fresh, "EarlyClaimEnabledSet").withArgs(true);
      expect(await fresh.earlyClaimEnabled()).to.equal(true);
      // ...and switch it back; the plain drip is unaffected either way.
      await fresh.connect(fix.owner).setEarlyClaimEnabled(false);
      await expect(fresh.connect(alice).claimAirdropEarly())
        .to.be.revertedWithCustomError(fresh, "EarlyClaimDisabled");
      await expect(fresh.connect(alice).claimAirdrop()).to.emit(fresh, "AirdropClaimed");
    });

    it("switching it off afterwards changes nothing for someone already settled", async function () {
      await at(1, 2);
      await airdrop.connect(alice).claimAirdropEarly();
      await airdrop.connect(owner).setEarlyClaimEnabled(false);
      await time.increase(VEST);
      expect(await airdrop.claimableAirdrop(alice.address)).to.equal(0n);
      await expect(airdrop.connect(alice).claimAirdrop()).to.be.revertedWithCustomError(airdrop, "NothingToClaim");
    });

    // Pin the NEXT block to an exact offset so every figure is exact.
    const at = async (fracNum, fracDen) => {
      const t = start + Math.floor((Number(VEST) * fracNum) / fracDen);
      await time.setNextBlockTimestamp(t);
      return BigInt(t - start);
    };

    it("at the half-way mark: half vested, a quarter more now, a quarter forfeited", async function () {
      const elapsed = await at(1, 2);
      await ethers.provider.send("evm_mine", []);
      // The quote at this exact timestamp.
      const [paid, forfeited] = await airdrop.earlyClaimQuote(alice.address);
      const vested = vestedAt(ALICE, elapsed);                    // 7/12: the sixth + half the rest
      const remainder = ALICE - vested;                           // 5/12
      expect(paid).to.equal(remainder * elapsed / VEST);          // 5/24 ≈ 208.33
      expect(forfeited).to.equal(remainder - paid);               // 5/24
      expect(vested + paid).to.equal(ALICE * 19n / 24n);          // ≈ 791.67 total
    });

    it("pays the drip slice at full value FIRST, then the buyout, in one transaction", async function () {
      const elapsed = await at(1, 5); // 20%: vested 1/6 + 1/6 = 1/3, locked 2/3, buyout 2/15, forfeit 8/15
      const vested = vestedAt(ALICE, elapsed);
      const paid = (ALICE - vested) * elapsed / VEST;
      const forfeited = (ALICE - vested) - paid;
      const bal0 = await satori.balanceOf(alice.address);
      await expect(airdrop.connect(alice).claimAirdropEarly())
        .to.emit(airdrop, "AirdropClaimed").withArgs(alice.address, vested, vested)
        .and.to.emit(airdrop, "AirdropClaimedEarly").withArgs(alice.address, paid, forfeited, vested + paid);
      expect((await satori.balanceOf(alice.address)) - bal0).to.equal(vested + paid);
      expect(vested + paid).to.be.closeTo(ALICE * 7n / 15n, 2n);  // 1/3 + 2/15 = 7/15, to the wei of flooring
      // The schedule collapses: allocation == minted, nothing more ever vests.
      expect(await airdrop.airdropAllocation(alice.address)).to.equal(vested + paid);
      expect(await airdrop.airdropClaimed(alice.address)).to.equal(vested + paid);
      expect(await token.airdropMintedTo(alice.address)).to.equal(vested + paid);
    });

    it("a prior ordinary claim changes nothing: the buyout is priced on what is still locked", async function () {
      await at(1, 10);
      await airdrop.connect(alice).claimAirdrop();                // drip at 10%
      const elapsed = await at(1, 2);
      await ethers.provider.send("evm_mine", []);
      const [paid] = await airdrop.earlyClaimQuote(alice.address);
      const vested = vestedAt(ALICE, elapsed);
      expect(paid).to.equal((ALICE - vested) * elapsed / VEST);    // same as a fresh user
    });

    it("after a buyout the recipient is settled: no drip, no second buyout, no re-load, ever", async function () {
      await at(1, 2);
      await airdrop.connect(alice).claimAirdropEarly();
      const settledAt = await airdrop.airdropAllocation(alice.address);
      expect(await airdrop.claimableAirdrop(alice.address)).to.equal(0n);
      const [p2, f2] = await airdrop.earlyClaimQuote(alice.address);
      expect(p2).to.equal(0n); expect(f2).to.equal(0n);
      await expect(airdrop.connect(alice).claimAirdrop()).to.be.revertedWithCustomError(airdrop, "NothingToClaim");
      await expect(airdrop.connect(alice).claimAirdropEarly()).to.be.revertedWithCustomError(airdrop, "NothingToClaim");
      await expect(airdrop.connect(carol).claimAirdropFor(alice.address)).to.be.revertedWithCustomError(airdrop, "NothingToClaim");
      // The end of the window brings nothing back.
      await time.increase(VEST);
      expect(await airdrop.claimableAirdrop(alice.address)).to.equal(0n);
      expect(await airdrop.airdropVested(alice.address)).to.equal(settledAt);
      await expect(airdrop.connect(alice).claimAirdrop()).to.be.revertedWithCustomError(airdrop, "NothingToClaim");
      expect(await satori.balanceOf(alice.address)).to.equal(settledAt);
      await expect(airdrop.connect(owner).loadAirdropBatch([alice.address], [1n]))
        .to.be.revertedWithCustomError(airdrop, "DuplicateRecipient");
      // Bob, who did nothing, is untouched and fully vested.
      expect(await airdrop.claimableAirdrop(bob.address)).to.equal(TOTAL - ALICE);
    });

    it("reverts rather than forfeit for nothing: zero payout at the first block, unallocated, fully vested", async function () {
      // A one-wei allocation seconds after deploy: paid floors to 0.
      await airdrop.connect(owner).loadAirdropBatch([carol.address], [1n]);
      await expect(airdrop.connect(carol).claimAirdropEarly()).to.be.revertedWithCustomError(airdrop, "NothingToClaim");
      expect(await airdrop.airdropAllocation(carol.address)).to.equal(1n); // untouched
      // Unallocated.
      const [, , , , stranger] = await ethers.getSigners();
      await expect(airdrop.connect(stranger).claimAirdropEarly()).to.be.revertedWithCustomError(airdrop, "NothingToClaim");
      // Past the window there is nothing locked to buy; the drip pays it all.
      await time.increase(VEST);
      const [p, f] = await airdrop.earlyClaimQuote(alice.address);
      expect(p).to.equal(0n); expect(f).to.equal(0n);
      await expect(airdrop.connect(alice).claimAirdropEarly()).to.be.revertedWithCustomError(airdrop, "NothingToClaim");
      await airdrop.connect(alice).claimAirdrop();
      expect(await satori.balanceOf(alice.address)).to.equal(ALICE);
    });

    it("is self-only: there is no on-behalf door for a value-destroying call", async function () {
      for (const f of ["claimAirdropEarlyFor", "claimAirdropEarlyForMany", "setEarlyClaimEnabledFor"]) {
        expect(airdrop.interface.getFunction(f), f).to.equal(null);
      }
    });

    it("waiting is never punished: the TOTAL the call pays only grows, the forfeit only shrinks", async function () {
      // The buyout slice alone is alloc·f·(1−f) and peaks at the half-way mark;
      // what the call actually pays is drip + buyout, and THAT
      // is what a later block must never reduce.
      let lastTotal = 0n, lastForfeit = ALICE;
      for (const [n, d] of [[1, 100], [1, 10], [1, 4], [1, 2], [3, 4], [9, 10]]) {
        await at(n, d);
        await ethers.provider.send("evm_mine", []);
        const [paid, forfeited] = await airdrop.earlyClaimQuote(alice.address);
        const total = (await airdrop.claimableAirdrop(alice.address)) + paid;
        expect(total, `${n}/${d}`).to.be.gte(lastTotal);
        expect(forfeited, `${n}/${d}`).to.be.lte(lastForfeit);
        lastTotal = total; lastForfeit = forfeited;
      }
      // Forfeit shrinks as (5/6)(1−f)²: at 90% it is 1/120 of the allocation.
      expect(lastForfeit).to.be.closeTo(ALICE / 120n, ALICE / 1000n);
    });

    it("forfeited tokens are never minted; the identity and the ceiling hold; the loaded total is untouched", async function () {
      await at(1, 2);
      await airdrop.connect(alice).claimAirdropEarly();
      await time.increase(VEST);
      await airdrop.connect(bob).claimAirdrop();
      const minted = await token.airdropMinted();
      expect(minted).to.equal((await satori.balanceOf(alice.address)) + (await satori.balanceOf(bob.address)));
      expect(minted).to.be.lt(TOTAL);                              // alice's forfeit is simply absent
      expect(await airdrop.airdropLoadedTotal()).to.equal(TOTAL);   // the loader's checksum does not move
      expect(await satori.totalSupply()).to.equal((await satori.totalRewardsMinted()) + minted);
    });
  });

  describe("conservation + cap", function () {
    it("keeps totalSupply == totalRewardsMinted + airdropClaimedTotal; never exceeds the cap", async function () {
      await loadTwo(E(600000));
      await time.increase(VEST * 2n);

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
    it("claimAirdropFor mints to the RECIPIENT, never to the caller", async function () {
      await loadTwo(TOTAL / 2n);
      await time.increase(VEST / 4n);

      const bobBefore = await satori.balanceOf(bob.address);
      const expected = await airdrop.claimableAirdrop(alice.address);
      expect(expected).to.be.gt(0n);

      await expect(airdrop.connect(carol).claimAirdropFor(alice.address))
        .to.emit(airdrop, "AirdropClaimed");

      expect(await satori.balanceOf(alice.address)).to.be.gte(expected);
      expect(await satori.balanceOf(carol.address)).to.equal(0n);
      expect(await satori.balanceOf(bob.address)).to.equal(bobBefore);
    });

    it("reverts NothingToClaim when the recipient has nothing newly vested", async function () {
      await loadTwo(TOTAL / 2n);
      await time.increase(VEST / 4n);
      await airdrop.connect(carol).claimAirdropFor(alice.address);
      await expect(airdrop.connect(carol).claimAirdropFor(carol.address))
        .to.be.revertedWithCustomError(airdrop, "NothingToClaim");
    });

    it("claimAirdropForMany pays everyone owed and SKIPS the rest without reverting", async function () {
      await loadTwo(TOTAL / 2n);
      await time.increase(VEST / 4n);

      await airdrop.connect(alice).claimAirdrop();
      const aliceAfterSelfClaim = await satori.balanceOf(alice.address);
      const bobOwed = await airdrop.claimableAirdrop(bob.address);
      expect(bobOwed).to.be.gt(0n);

      await expect(airdrop.connect(carol).claimAirdropForMany([
        alice.address, bob.address, carol.address, ethers.ZeroAddress,
      ])).to.not.be.reverted;

      expect(await satori.balanceOf(bob.address)).to.be.gte(bobOwed);
      expect(await satori.balanceOf(carol.address)).to.equal(0n);
      expect(await satori.balanceOf(alice.address)).to.be.lt(aliceAfterSelfClaim * 2n);
    });

    it("returns the total actually paid, so a sweep can be dry-run before it spends gas", async function () {
      await loadTwo(TOTAL / 2n);
      await time.increase(VEST / 4n);

      const quoted = await airdrop.connect(carol).claimAirdropForMany.staticCall([
        alice.address, bob.address, carol.address,
      ]);
      const aliceOwed = await airdrop.claimableAirdrop(alice.address);
      const bobOwed = await airdrop.claimableAirdrop(bob.address);
      expect(quoted).to.be.gte(aliceOwed + bobOwed);
      expect(quoted).to.be.gt(0n);
    });

    it("an empty list is a no-op, not a revert", async function () {
      await expect(airdrop.connect(carol).claimAirdropForMany([])).to.not.be.reverted;
      expect(await airdrop.airdropClaimedTotal()).to.equal(0n);
    });

    it("sponsored claims keep the supply identity and the cap exact", async function () {
      await loadTwo(E(600000));
      await time.increase(VEST * 2n);

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
      await loadTwo(TOTAL / 2n);
      await time.increase(VEST * 2n);

      await airdrop.connect(carol).claimAirdropFor(alice.address);
      await airdrop.connect(bob).claimAirdrop();

      expect(await satori.balanceOf(alice.address)).to.equal(
        await satori.balanceOf(bob.address)
      );
    });
  });
});

describe("SatoriAirdrop loading: optional finalize one-shot", function () {
  let airdrop, owner, alice, bob;

  beforeEach(async function () {
    const fix = await loadFixture(deploySatoriFixture);
    ({ airdrop, owner } = fix);
    [, alice, bob] = fix.signers;
  });

  it("finalize is loader-only, one-shot, and permanently closes loading", async function () {
    await airdrop.connect(owner).loadAirdropBatch([alice.address], [E(100)]);

    await expect(airdrop.connect(alice).finalizeAirdropLoading())
      .to.be.revertedWithCustomError(airdrop, "Unauthorized");
    expect(await airdrop.airdropLoadingFinalized()).to.equal(false);

    await expect(airdrop.connect(owner).finalizeAirdropLoading())
      .to.emit(airdrop, "AirdropLoadingFinalized").withArgs(E(100));
    expect(await airdrop.airdropLoadingFinalized()).to.equal(true);

    await expect(airdrop.connect(owner).finalizeAirdropLoading())
      .to.be.revertedWithCustomError(airdrop, "AlreadySet");

    await expect(
      airdrop.connect(owner).loadAirdropBatch([bob.address], [E(1)])
    ).to.be.revertedWithCustomError(airdrop, "AirdropLoadingClosed");
  });

  it("finalize changes NOTHING for claimants: vesting claims keep working exactly as before", async function () {
    await airdrop.connect(owner).loadAirdropBatch([alice.address], [E(1000)]);
    await airdrop.connect(owner).finalizeAirdropLoading();

    await time.increase(365 * 24 * 3600);
    await expect(airdrop.connect(alice).claimAirdrop()).to.emit(airdrop, "AirdropClaimed");
    const claimed = await airdrop.airdropClaimed(alice.address);
    expect(claimed).to.be.gt(0n);
    expect(claimed).to.be.lt(E(1000));
  });

  it("loading stays open indefinitely when finalize is never called", async function () {
    await airdrop.connect(owner).loadAirdropBatch([alice.address], [E(1)]);
    await time.increase(1825 * 24 * 3600);
    await airdrop.connect(owner).loadAirdropBatch([bob.address], [E(1)]);
    expect(await airdrop.airdropLoadedTotal()).to.equal(E(2));
  });
});
