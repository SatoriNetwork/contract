const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

// THE DEV FEE: 15% OF WHAT WAS EARNED.
//
// Owner's rule, 2026-09-11: the fee is 15% of everything paid as rewards —
// the on-chain lane AND the merkle lane, since both route through this
// contract's `rewardMint` — excluding the airdrop (its own counter, its own
// cap) and the bridge (which moves existing supply rather than creating it).
//
// Owner's rule, 2026-10-20 (M03): the fee is booked when a reward is EARNED,
// not when it is claimed. The controller reports general rewards through
// `accrueRewards` as it credits them; the token books the dev's share then, at
// its own rate, and `rewardMint` pays only what was reported. So a fee change
// never touches a reward already earned, and a controller that stops
// reporting cannot pay anyone — the guarantee lives in the immutable token,
// not in the upgradeable hub's good behaviour.
//
// Since gross == general + dev, "dev is 15% of the gross" rearranges to
// `dev = general * 1500 / 8500`, rounded UP per report. These tests assert the
// SHARE — the thing the rule is about — rather than re-deriving the same
// expression and agreeing with it.
//
// This file tests the TOKEN's rule in isolation, with a plain controller
// reporting and minting. In a real stack the hub is stricter: it reports only
// what its own per-round schedule priced, which never exceeds the token's 1440.

const ROUND = 86400;
const DEV_BPS = 1500n;
const PLACEHOLDER = "0x000000000000000000000000000000000000dEaD";
const feeOn = (general, bps = DEV_BPS) =>
  (general * bps + (10000n - bps) - 1n) / (10000n - bps);

describe("SatoriToken — the dev fee is a share of what was earned", function () {
  let token, SatoriToken;
  let deployer, governor, controller, dev, alice, bob;
  let INITIAL_MINT, BUDGET;

  beforeEach(async function () {
    [deployer, governor, controller, dev, alice, bob] = await ethers.getSigners();
    SatoriToken = await ethers.getContractFactory("SatoriToken");
    token = await SatoriToken.connect(deployer).deploy(
      governor.address, dev.address, (await ethers.provider.getNetwork()).chainId);
    await token.waitForDeployment();
    INITIAL_MINT = await token.INITIAL_MINT();
    BUDGET = await token.ROUND_REWARD_BUDGET();
    await token.connect(governor).setController(controller.address);
  });

  // The identity the whole rule is about: dev == 15% of what was earned.
  //
  // Asserted to WITHIN ONE WEI PER REPORT, not to the bps: lhs - rhs is
  // 8500 x (dev - 3/17 x general), and each report rounds its fee up by under
  // a wei, so it sits in [0, 8500 x reports). `reports` counts genesis, which
  // books its fee by the same rounding.
  async function expectFifteenPercent(label, reports) {
    const g = await token.generalAccrued();
    const d = await token.devFeeAccrued();
    const lhs = d * 10000n, rhs = DEV_BPS * (g + d);
    expect(lhs, `${label}: the dev is never short of 15% of the gross`).to.be.gte(rhs);
    expect(lhs - rhs, `${label}: and each report's fee is over 3/17 by less than a wei`)
      .to.be.lt(8500n * reports);
  }
  async function pull() { await token.connect(alice).mintDevFee(); }
  // Report `g` as earned, then mint it: the plain-controller stand-in for a
  // hub that credits a reward and later pays the claim.
  async function earnAndMint(to, g) {
    await token.connect(controller).accrueRewards(g);
    await token.connect(controller).rewardMint(to, g);
  }
  // Largest general report the envelope still takes right now.
  async function room() {
    const bps = await token.devFeeBps();
    const left = (await token.rewardCeiling()) - (await token.generalAccrued()) - (await token.devFeeAccrued());
    let g = (left * (10000n - bps)) / 10000n;
    while (g + feeOn(g, bps) > left) g--;
    return g;
  }

  describe("the rule", function () {
    it("genesis is split 15/85, and the split is the same formula every report uses", async function () {
      expect(await token.totalRewardsMinted()).to.equal(INITIAL_MINT);
      await expectFifteenPercent("genesis", 1n);
      const gen = (INITIAL_MINT * 8500n) / 10000n;
      expect(await token.generalMinted()).to.equal(gen);
      expect(await token.generalAccrued()).to.equal(gen);
      expect(await token.balanceOf(dev.address)).to.equal(INITIAL_MINT - gen);
      // The remainder the dev takes IS the rounded-up 3/17 of the general
      // share, so genesis is not a special case of the accrual rule.
      expect(INITIAL_MINT - gen).to.equal(feeOn(gen));
      expect(await token.devFeeAccrued()).to.equal(feeOn(gen));
      expect(await token.devFeeMinted()).to.equal(feeOn(gen));
    });

    it("books 3/17 of every report at the moment it is reported", async function () {
      await time.increase(ROUND);
      let reports = 1n;
      for (const amt of ["1", "137.5", "0.000000000000000001"]) {
        const g = ethers.parseEther(amt);
        const before = await token.devFeeAccrued();
        const [genTotal, fee] = await token.connect(controller).accrueRewards.staticCall(g);
        expect(genTotal).to.equal((await token.generalAccrued()) + g);
        expect(fee).to.equal(feeOn(g));
        await expect(token.connect(controller).accrueRewards(g))
          .to.emit(token, "RewardsAccrued")
          .withArgs(g, feeOn(g), await token.generalAccrued() + g, before + feeOn(g));
        expect((await token.devFeeAccrued()) - before).to.equal(feeOn(g));
        await expectFifteenPercent(`after reporting ${amt}`, ++reports);
      }
    });

    it("charges the MERKLE lane too — there is only one report path and one mint path", async function () {
      // The hub reports its merkle reserve through the same accrueRewards and
      // mints merkle claims through the same rewardMint, so a merkle reward is
      // indistinguishable here and is charged identically. Nothing can mint
      // reward SATORI while dodging the fee.
      await time.increase(ROUND);
      const before = await token.devFeeAccrued();
      await earnAndMint(alice.address, ethers.parseEther("100"));
      expect((await token.devFeeAccrued()) - before).to.equal(feeOn(ethers.parseEther("100")));
    });

    it("splitting a report into dust cannot round the fee away", async function () {
      await time.increase(ROUND);
      const before = await token.devFeeAccrued();
      for (let i = 0; i < 200; i++) await token.connect(controller).accrueRewards(5n);
      // 1000 wei at 3/17 is 176.47 exactly; rounding up per report books 200,
      // and a per-report FLOOR would have booked 0.
      expect((await token.devFeeAccrued()) - before).to.be.gte(177n);
      expect((await token.devFeeAccrued()) - before).to.equal(200n);
    });

    it("the fee is booked on what is earned, so a credit nobody claims still pays it", async function () {
      await time.increase(ROUND);
      await token.connect(controller).accrueRewards(ethers.parseEther("500"));
      // Nothing minted to anyone, and the dev's pull still pays the share.
      expect(await token.generalMinted()).to.equal((INITIAL_MINT * 8500n) / 10000n);
      expect(await token.mintDevFee.staticCall()).to.equal(feeOn(ethers.parseEther("500")));
      await pull();
      await expectFifteenPercent("after a 500 credit nobody claimed", 2n);
    });
  });

  describe("the token refuses what was not earned", function () {
    it("rewardMint pays only what was reported, to the wei", async function () {
      await time.increase(ROUND);
      await expect(token.connect(controller).rewardMint(alice.address, 1n))
        .to.be.revertedWithCustomError(token, "NotAccrued");
      await token.connect(controller).accrueRewards(ethers.parseEther("10"));
      await expect(token.connect(controller).rewardMint(alice.address, ethers.parseEther("10") + 1n))
        .to.be.revertedWithCustomError(token, "NotAccrued");
      await token.connect(controller).rewardMint(alice.address, ethers.parseEther("10"));
      await expect(token.connect(controller).rewardMint(alice.address, 1n))
        .to.be.revertedWithCustomError(token, "NotAccrued");
    });

    it("a controller that never reports cannot mint, so a hub upgrade cannot skip the fee", async function () {
      // The point of booking at report time inside the immutable token: a hub
      // that forgets (or is upgraded to forget) accrueRewards pays nobody, it
      // does not pay people fee-free.
      await time.increase(ROUND * 30);
      await expect(token.connect(controller).rewardMint(alice.address, 1n))
        .to.be.revertedWithCustomError(token, "NotAccrued");
      expect(await token.devFeeAccrued()).to.equal(await token.devFeeMinted());
    });

    it("the rate is the token's own: accrueRewards takes an amount and nothing else", async function () {
      const f = token.interface.getFunction("accrueRewards");
      expect(f.inputs.map((i) => i.type)).to.deep.equal(["uint256"]);
      expect(f.outputs.map((o) => o.type)).to.deep.equal(["uint256", "uint256"]);
      await expect(token.connect(alice).accrueRewards(1n))
        .to.be.revertedWithCustomError(token, "Unauthorized");
      await expect(token.connect(governor).accrueRewards(1n))
        .to.be.revertedWithCustomError(token, "Unauthorized");
    });
  });

  describe("no clock: a dead protocol owes nothing", function () {
    it("time alone accrues NOTHING — this is the whole point of the change", async function () {
      await pull();                                    // bring it up to date
      const owed0 = await token.mintDevFee.staticCall();
      const accrued0 = await token.devFeeAccrued();
      await time.increase(ROUND * 500);                // ~16 months, no reports
      expect(await token.mintDevFee.staticCall()).to.equal(owed0);
      expect(await token.devFeeAccrued()).to.equal(accrued0);
      await pull();
      await expectFifteenPercent("after 500 idle rounds", 1n);   // still 15%, not more
    });
  });

  describe("the envelope", function () {
    it("binds at the report: general plus fee never exceeds 1440 x rounds", async function () {
      await time.increase(ROUND);
      const g = await room();
      await expect(token.connect(controller).accrueRewards(g + 1n))
        .to.be.revertedWithCustomError(token, "BudgetExceeded");
      await token.connect(controller).accrueRewards(g);   // exact fit
      expect((await token.generalAccrued()) + (await token.devFeeAccrued()))
        .to.be.lte(await token.rewardCeiling());
      await expect(token.connect(controller).accrueRewards(1n))
        .to.be.revertedWithCustomError(token, "BudgetExceeded");
      // Everything reported stays mintable, with no envelope check of its own.
      await expect(token.connect(controller).rewardMint(alice.address, g)).to.not.be.reverted;
    });

    it("the reserved slice is never lent to the game, even unpulled", async function () {
      await time.increase(ROUND);
      await earnAndMint(alice.address, await room());
      // The dev has not pulled; its slice must still be there afterwards.
      const owed = await token.mintDevFee.staticCall();
      expect(owed).to.be.gt(0n);
      await pull();
      expect(await token.totalRewardsMinted()).to.be.lte(await token.rewardCeiling());
    });

    it("minting NEVER has to stop waiting for the dev to collect", async function () {
      // Booking the fee at the report is what makes a "halt until the fee
      // catches up" rule unnecessary — and keeps the protocol's liveness from
      // depending on someone calling a permissionless function.
      for (let i = 0; i < 5; i++) {
        await time.increase(ROUND);
        await expect(token.connect(controller).accrueRewards(await room())).to.not.be.reverted;
        const owed = (await token.generalAccrued()) - (await token.generalMinted());
        await expect(token.connect(controller).rewardMint(bob.address, owed)).to.not.be.reverted;
      }
      await pull();
      await expectFifteenPercent("after five full rounds", 6n);
    });
  });

  describe("the pull", function () {
    it("is permissionless and always pays the recipient, never the caller", async function () {
      await time.increase(ROUND);
      await earnAndMint(alice.address, ethers.parseEther("100"));
      const before = await token.balanceOf(dev.address);
      await token.connect(bob).mintDevFee();
      expect(await token.balanceOf(dev.address)).to.equal(before + feeOn(ethers.parseEther("100")));
      expect(await token.balanceOf(bob.address)).to.equal(0);
    });

    it("is idempotent: a second pull pays nothing and cannot panic", async function () {
      expect(await token.mintDevFee.staticCall()).to.equal(0n);
      await pull();
      expect(await token.mintDevFee.staticCall()).to.equal(0n);
      await time.increase(ROUND);
      await token.connect(controller).accrueRewards(ethers.parseEther("3"));
      await pull();
      expect(await token.mintDevFee.staticCall()).to.equal(0n);
      expect(await token.devFeeMinted()).to.equal(await token.devFeeAccrued());
    });

    it("never lets the fee exceed the ONE global cap", async function () {
      for (const k of [1, 5, 50]) {
        await time.increase(ROUND * k);
        const g = await room();
        if (g > 0n) await earnAndMint(alice.address, g);
        await pull();
        expect(await token.totalRewardsMinted()).to.be.lte(await token.rewardCeiling());
      }
    });
  });

  describe("what is NOT charged", function () {
    it("the airdrop is outside the fee entirely", async function () {
      const table = await (await ethers.getContractFactory("MockAirdropTable")).deploy(await token.getAddress());
      await token.connect(governor).setAirdrop(await table.getAddress());
      const before = await token.devFeeAccrued();
      const general = await token.generalAccrued();
      await table.mint(alice.address, ethers.parseEther("1000"));
      expect(await token.devFeeAccrued()).to.equal(before);            // unchanged
      expect(await token.generalAccrued()).to.equal(general);          // unchanged
      expect(await token.totalRewardsMinted()).to.equal(INITIAL_MINT); // untouched
    });
  });

  describe("the ladder is gone", function () {
    it("15% forever: a constant, with no dial, band, freeze or fee authority in the ABI", async function () {
      expect(await token.devFeeBps()).to.equal(1500n);
      const names = token.interface.fragments
        .filter((f) => f.type === "function").map((f) => f.name);
      for (const gone of ["proposeDevFeeBps", "cancelDevFeeBps", "acceptDevFeeBps",
                          "pendingDevFeeBps", "pendingDevFeeBlock", "lastDevFeeChangeRound",
                          "DEV_FEE_BPS_MIN", "DEV_FEE_BPS_MAX", "DEV_FEE_BPS_DEFAULT",
                          "DEV_FEE_CHANGE_GAP_ROUNDS", "freezeDevFeeBps", "devFeeBpsFrozen",
                          "devFeeBpsLocked", "feeAuthority", "setFeeAuthority"]) {
        expect(names, `${gone} must be gone`).to.not.include(gone);
      }
      for (const sig of ["proposeDevFeeBps(uint256)", "setFeeAuthority(address)"]) {
        const sel = ethers.id(sig).slice(0, 10).slice(2);
        const code = await ethers.provider.getCode(await token.getAddress());
        expect(code.includes(sel), `${sig} selector in bytecode`).to.equal(false);
      }
    });

    it("one flat constant, and no tier, clock or mint-time ceiling left in the ABI", async function () {
      expect(await token.devFeeBps()).to.equal(DEV_BPS);
      const names = token.interface.fragments
        .filter((f) => f.type === "function").map((f) => f.name);
      for (const gone of ["DEV_FEE_BPS_T1", "DEV_FEE_BPS_T2", "DEV_FEE_BPS_T3",
                          "DEV_TIER_ROUNDS", "devRateNow",
                          "devFeeCeiling", "generalCeiling", "generalCeilingFor",
                          "devAccruedCheckpoint", "generalMintedCheckpoint"]) {
        expect(names, `${gone} must be gone`).to.not.include(gone);
      }
      // devRateNow moved to the HUB: the token cannot know a per-round rate
      // any more, because the schedule lives in the hub. The ceilings went
      // with the mint-time fee: the token now caps at the report.
    });

    it("rejects a zero or placeholder dev recipient", async function () {
      const home = (await ethers.provider.getNetwork()).chainId;
      await expect(SatoriToken.deploy(governor.address, ethers.ZeroAddress, home))
        .to.be.revertedWithCustomError(SatoriToken, "BadInput");
      await expect(SatoriToken.deploy(governor.address, PLACEHOLDER, home))
        .to.be.revertedWithCustomError(SatoriToken, "BadInput");
    });

    it("pins PLATFORM_FEE_RECIPIENT as an immutable with no setter", async function () {
      expect(await token.PLATFORM_FEE_RECIPIENT()).to.equal(dev.address);
      const hasSetter = token.interface.fragments.some(
        (f) => f.type === "function" && /platformfee|devrecipient/i.test(f.name)
               && f.stateMutability !== "view");
      expect(hasSetter).to.equal(false);
    });
  });
});
