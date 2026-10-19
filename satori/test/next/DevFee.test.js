const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

// THE DEV FEE: 15% OF WHAT WAS ACTUALLY MINTED.
//
// Owner's rule, 2026-09-11: the fee is 15% of everything minted as rewards —
// the on-chain lane AND the merkle lane, since both route through this
// contract's `rewardMint` — excluding the airdrop (its own counter, its own
// cap) and the bridge (which moves existing supply rather than creating it).
//
// WAS a 20% -> 10% -> 5% ladder of a fixed 1440/round budget, accruing on the
// WALL CLOCK. That had to go: emission is no longer a fixed per-round figure
// (the upgradeable hub, which this contract cannot see, steps it by issuance
// and its emission authority can change the step), so a fee
// defined against 1440 would have drifted to an ever-larger share as emission
// fell, and would have gone on minting 72/round forever after emission stopped.
//
// Since `totalRewardsMinted == general + dev`, "dev is 15% of the total"
// rearranges to `dev = general * 1500 / 8500`, which is how the contract
// computes it. These tests assert the SHARE — the thing the rule is about —
// rather than re-deriving the same expression and agreeing with it.
//
// This file tests the TOKEN's rule in isolation, with a plain controller
// minting. In a real stack the hub is stricter: it holds the general lane to
// 85% of its own per-round rate, which never exceeds the token's 1440.

const ROUND = 86400;
const DEV_BPS = 1500n;
const PLACEHOLDER = "0x000000000000000000000000000000000000dEaD";

describe("SatoriToken — the dev fee is a share of what was minted", function () {
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

  // The identity the whole rule is about: dev == 15% of total.
  //
  // Asserted to WITHIN ONE WEI, not to the bps, and the distinction is real
  // rather than sloppy. The contract floors `general * 3/17`, so the fee can be
  // up to a wei short of an exact 15%; re-deriving a bps from that floors a
  // SECOND time and reads 1499 on small totals. What the rule actually
  // guarantees is that the fee is 15% of the total give or take one wei, and in
  // the direction that under-pays the fee rather than over-minting.
  async function expectFifteenPercent(label) {
    const T = await token.totalRewardsMinted();
    const d = await token.devFeeMinted();
    const lhs = d * 10000n, rhs = DEV_BPS * T;
    const diff = lhs > rhs ? lhs - rhs : rhs - lhs;
    // Two-sided. The genesis split rounds the dev UP (it takes the remainder
    // after the general share is floored onto the hub's cap), so the fee can
    // sit a hair ABOVE 15% there; `devFeeCeiling` floors, so it sits a hair
    // BELOW everywhere else. Both are under a wei.
    expect(diff, `${label}: dev must be within a wei of 15% of the total`)
      .to.be.lt(10000n);
  }
  async function pull() { await token.connect(alice).mintDevFee(); }
  async function headroom() {
    return ((await token.rewardCeiling()) * (10000n - DEV_BPS)) / 10000n
         - (await token.generalMinted());
  }

  describe("the rule", function () {
    it("genesis is split 15/85, and the general share saturates its cap exactly", async function () {
      expect(await token.totalRewardsMinted()).to.equal(INITIAL_MINT);
      await expectFifteenPercent("genesis");
      // The general share is floor(85%) and the dev takes the remainder — that
      // ORDER matters to the wei, because the hub seeds its own lane from it
      // and caps that lane at floor(85%). Flooring the dev instead puts the
      // general share one wei over the hub's cap from block zero.
      expect(await token.generalMinted()).to.equal((INITIAL_MINT * 8500n) / 10000n);
      expect(await token.balanceOf(dev.address))
        .to.equal(INITIAL_MINT - (INITIAL_MINT * 8500n) / 10000n);
    });

    it("stays at 15% of the total after arbitrary minting", async function () {
      for (const amt of ["1", "137.5", "0.000000000000000001"]) {
        await time.increase(ROUND);
        await token.connect(controller).rewardMint(bob.address, ethers.parseEther(amt));
        await pull();
        await expectFifteenPercent(`after minting ${amt}`);
      }
    });

    it("charges the MERKLE lane too — there is only one mint path", async function () {
      // The hub routes both lanes through this same rewardMint, so a merkle
      // claim is indistinguishable here and is charged identically. Nothing
      // can mint reward SATORI while dodging the fee.
      await time.increase(ROUND);
      const before = await token.devFeeCeiling();
      await token.connect(controller).rewardMint(alice.address, ethers.parseEther("100"));
      const after = await token.devFeeCeiling();
      // Within a wei: the contract takes the difference of two FLOORS, which is
      // not the floor of the difference.
      expect(after - before).to.be.closeTo(
        (ethers.parseEther("100") * DEV_BPS) / (10000n - DEV_BPS), 1n);
      expect(after).to.be.gt(before);
    });

    it("the entitlement is 3/17 of the general lane, which IS 15% of the total", async function () {
      await time.increase(ROUND);
      await token.connect(controller).rewardMint(bob.address, ethers.parseEther("500"));
      const g = await token.generalMinted();
      expect(await token.devFeeCeiling()).to.equal((g * DEV_BPS) / (10000n - DEV_BPS));
      await pull();
      await expectFifteenPercent("after a 500 mint");
    });
  });

  describe("no clock: a dead protocol owes nothing", function () {
    it("time alone accrues NOTHING — this is the whole point of the change", async function () {
      await pull();                                    // bring it up to date
      const owed0 = await token.mintDevFee.staticCall();
      await time.increase(ROUND * 500);                // ~16 months, no minting
      expect(await token.mintDevFee.staticCall()).to.equal(owed0);
      expect(await token.devFeeCeiling()).to.equal(await token.devFeeCeiling());
      await pull();
      await expectFifteenPercent("after 500 idle rounds");   // still 15%, not more
    });

    it("the fee follows minting DOWN as well as up: no mint, no growth", async function () {
      const c0 = await token.devFeeCeiling();
      await time.increase(ROUND * 50);
      expect(await token.devFeeCeiling()).to.equal(c0);
    });
  });

  describe("the reservation", function () {
    it("the general lane may take 85% of the ceiling and not a wei more", async function () {
      await time.increase(ROUND);
      const room = await headroom();
      await expect(token.connect(controller).rewardMint(alice.address, room + 1n))
        .to.be.revertedWithCustomError(token, "BudgetExceeded");
      await token.connect(controller).rewardMint(alice.address, room);   // exact fit
      await expect(token.connect(controller).rewardMint(alice.address, 1n))
        .to.be.revertedWithCustomError(token, "BudgetExceeded");
    });

    it("the reserved slice is never lent to the game, even unpulled", async function () {
      await time.increase(ROUND);
      const room = await headroom();
      await token.connect(controller).rewardMint(alice.address, room);
      // The dev has not pulled; its slice must still be there afterwards.
      const owed = await token.mintDevFee.staticCall();
      expect(owed).to.be.gt(0n);
      await pull();
      expect(await token.totalRewardsMinted()).to.be.lte(await token.rewardCeiling());
    });

    it("minting NEVER has to stop waiting for the dev to collect", async function () {
      // The reservation is what makes a "halt until the fee catches up" rule
      // unnecessary — and avoids making the protocol's liveness depend on
      // someone calling a permissionless function.
      for (let i = 0; i < 5; i++) {
        await time.increase(ROUND);
        const room = await headroom();
        await expect(token.connect(controller).rewardMint(bob.address, room)).to.not.be.reverted;
      }
      await pull();
      await expectFifteenPercent("after five full rounds");
    });
  });

  describe("the pull", function () {
    it("is permissionless and always pays the recipient, never the caller", async function () {
      await time.increase(ROUND);
      await token.connect(controller).rewardMint(alice.address, ethers.parseEther("100"));
      const before = await token.balanceOf(dev.address);
      await token.connect(bob).mintDevFee();
      expect(await token.balanceOf(dev.address)).to.be.gt(before);
      expect(await token.balanceOf(bob.address)).to.equal(0);
    });

    it("is idempotent, and SATURATES rather than underflowing", async function () {
      // At genesis the dev holds the remainder after the general share was
      // floored, which can sit a wei ABOVE its own floored 3/17 entitlement.
      // A bare `ceiling - devFeeMinted` would panic on that.
      expect(await token.mintDevFee.staticCall()).to.equal(0n);
      await pull();
      expect(await token.mintDevFee.staticCall()).to.equal(0n);
    });

    it("never lets the fee exceed the ONE global cap", async function () {
      for (const k of [1, 5, 50]) {
        await time.increase(ROUND * k);
        const room = await headroom();
        if (room > 0n) await token.connect(controller).rewardMint(alice.address, room);
        await pull();
        expect(await token.totalRewardsMinted()).to.be.lte(await token.rewardCeiling());
      }
    });
  });

  describe("what is NOT charged", function () {
    it("the airdrop is outside the fee entirely", async function () {
      const table = await (await ethers.getContractFactory("MockAirdropTable")).deploy(await token.getAddress());
      await token.connect(governor).setAirdrop(await table.getAddress());
      await token.connect(governor).freezeAirdrop(await table.getAddress(), 0n);
      const before = await token.devFeeCeiling();
      await table.mint(alice.address, ethers.parseEther("1000"));
      expect(await token.devFeeCeiling()).to.equal(before);          // unchanged
      expect(await token.totalRewardsMinted()).to.equal(INITIAL_MINT); // untouched
    });
  });

  describe("the ladder is gone", function () {
    it("one flat constant, and no tier or clock left in the ABI", async function () {
      expect(await token.devFeeBps()).to.equal(DEV_BPS);
      const names = token.interface.fragments
        .filter((f) => f.type === "function").map((f) => f.name);
      for (const gone of ["DEV_FEE_BPS_T1", "DEV_FEE_BPS_T2", "DEV_FEE_BPS_T3",
                          "DEV_TIER_ROUNDS", "devRateNow"]) {
        expect(names, `${gone} must be gone`).to.not.include(gone);
      }
      // devRateNow moved to the HUB: the token cannot know a per-round rate
      // any more, because the schedule lives in the hub.
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
