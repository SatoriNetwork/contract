const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

// THE DAO'S FEE DIAL — a BOUNDED, TWO-STEP, SPACED lever on the dev fee.
//
// humble.md 1b, owner-ruled 2026-09-11. The fee ships at 15% and the governor
// (later: the DAO) may move it, but only inside [5%, 25%]. The band is made of
// constants in the immutable token, so the DAO chooses inside a range the
// constitution fixes and the range itself is as unalterable as the old flat
// rate was.
//
// This reverses the earlier "the fee gets no key, ever" ruling, and the trade is
// real: whoever holds `feeAuthority` can take a quarter of all emission. What
// these tests hold the line on is that they cannot go outside the band, cannot
// do it in one transaction, cannot do it more than once in 30 rounds, and —
// the load-bearing one — cannot revalue history by doing it.
//
// THE PROPERTY THAT MATTERS (M03, 2026-10-20). The fee is booked at the
// REPORT, at the rate then in force. A change therefore moves no counter:
// everything already earned keeps its booking, every credit stays mintable,
// and nothing already pulled comes back. The old segmented ceiling existed to
// approximate that at mint time; it is gone, and so is the brick it guarded
// against (a raise pushing a mint-time cap under what was already minted).

const ROUND = 86400;
const GAP = 30;

describe("SatoriToken — the DAO's bounded fee dial", function () {
  let token;
  let deployer, governor, controller, dev, alice, stranger;
  let MIN, MAX, DEFAULT_BPS, INITIAL_MINT;

  beforeEach(async function () {
    [deployer, governor, controller, dev, alice, stranger] = await ethers.getSigners();
    const SatoriToken = await ethers.getContractFactory("SatoriToken");
    token = await SatoriToken.connect(deployer).deploy(
      governor.address, dev.address, (await ethers.provider.getNetwork()).chainId);
    await token.waitForDeployment();
    await token.connect(governor).setController(controller.address);
    MIN = await token.DEV_FEE_BPS_MIN();
    MAX = await token.DEV_FEE_BPS_MAX();
    DEFAULT_BPS = await token.DEV_FEE_BPS_DEFAULT();
    INITIAL_MINT = await token.INITIAL_MINT();
    // Genesis counts as the first change: the dial opens 30 rounds later.
    await time.increase(ROUND * GAP);
  });

  // Move the fee to `bps`, both steps, in two different blocks.
  async function setFee(bps) {
    await token.connect(governor).proposeDevFeeBps(bps);
    await token.connect(governor).acceptDevFeeBps();
  }
  // The gap between accepted changes.
  const waitGap = () => time.increase(ROUND * GAP);

  const feeOn = (g, bps) => (g * bps + (10000n - bps) - 1n) / (10000n - bps);
  // Report `amount` as earned and mint it, as the controller.
  async function earn(amount) {
    await token.connect(controller).accrueRewards(amount);
    await token.connect(controller).rewardMint(alice.address, amount);
  }
  // What the controller may still report right now.
  const room = async () => {
    const bps = await token.devFeeBps();
    const left = (await token.rewardCeiling()) - (await token.generalAccrued()) - (await token.devFeeAccrued());
    let g = (left * (10000n - bps)) / 10000n;
    while (g + feeOn(g, bps) > left) g--;
    return g;
  };

  // ------------------------------------------------------------------
  describe("the band", function () {
    it("ships at 15% inside a [5%, 25%] band, and genesis is its first change", async function () {
      expect(DEFAULT_BPS).to.equal(1500n);
      expect(MIN).to.equal(500n);
      expect(MAX).to.equal(2500n);
      expect(await token.devFeeBps()).to.equal(DEFAULT_BPS);
      expect(await token.DEV_FEE_CHANGE_GAP_ROUNDS()).to.equal(GAP);
      expect(await token.lastDevFeeChangeRound()).to.equal(await token.deploymentRound());
    });

    it("refuses anything outside the band, and accepts both edges", async function () {
      await expect(token.connect(governor).proposeDevFeeBps(MIN - 1n))
        .to.be.revertedWithCustomError(token, "BadInput");
      await expect(token.connect(governor).proposeDevFeeBps(MAX + 1n))
        .to.be.revertedWithCustomError(token, "BadInput");
      await expect(token.connect(governor).proposeDevFeeBps(0n))
        .to.be.revertedWithCustomError(token, "BadInput");

      await setFee(MIN);
      expect(await token.devFeeBps()).to.equal(MIN);
      await waitGap();
      await setFee(MAX);
      expect(await token.devFeeBps()).to.equal(MAX);
    });

    it("is governor-only on all three entry points", async function () {
      for (const call of [
        token.connect(stranger).proposeDevFeeBps(2000n),
        token.connect(controller).proposeDevFeeBps(2000n),
        token.connect(stranger).acceptDevFeeBps(),
        token.connect(stranger).cancelDevFeeBps(),
      ]) {
        await expect(call).to.be.revertedWithCustomError(token, "Unauthorized");
      }
    });
  });

  // ------------------------------------------------------------------
  describe("two steps, two blocks", function () {
    it("accept does nothing without a standing proposal", async function () {
      await expect(token.connect(governor).acceptDevFeeBps())
        .to.be.revertedWithCustomError(token, "BadInput");
    });

    it("REFUSES to accept in the same block it was proposed in", async function () {
      // The point of the two-step is that a stolen key cannot move a quarter of
      // emission in one shot. Two calls the same block would be one shot: a
      // bundle lands them atomically and nobody sees the pending value.
      await network.provider.send("evm_setAutomine", [false]);
      try {
        await token.connect(governor).proposeDevFeeBps(MAX);
        // Sent into the SAME block. Whether it reverts or is dropped, what the
        // guard promises is that it does not take effect — assert the state,
        // which is the thing that matters and the thing an attacker cares about.
        await token.connect(governor).acceptDevFeeBps().catch(() => {});
        await network.provider.send("evm_mine");
      } finally {
        await network.provider.send("evm_setAutomine", [true]);
      }
      // The fee did not move, and the proposal is still standing — so the
      // bundle bought the attacker nothing but a publicly visible proposal.
      expect(await token.devFeeBps()).to.equal(DEFAULT_BPS);
      expect(await token.pendingDevFeeBps()).to.equal(MAX);
      // That a LATER block does enact it is what every other test in this file
      // exercises (`setFee` is two blocks), so it is not re-proved here — doing
      // so would drag mempool behaviour into a test about a contract guard.
    });

    it("cancel withdraws a proposal; a bare cancel reverts", async function () {
      await expect(token.connect(governor).cancelDevFeeBps())
        .to.be.revertedWithCustomError(token, "BadInput");
      await token.connect(governor).proposeDevFeeBps(MAX);
      await token.connect(governor).cancelDevFeeBps();
      expect(await token.pendingDevFeeBps()).to.equal(0n);
      await expect(token.connect(governor).acceptDevFeeBps())
        .to.be.revertedWithCustomError(token, "BadInput");
      expect(await token.devFeeBps()).to.equal(DEFAULT_BPS);
    });

    it("re-proposing overwrites the standing proposal", async function () {
      await token.connect(governor).proposeDevFeeBps(MAX);
      await token.connect(governor).proposeDevFeeBps(MIN);
      expect(await token.pendingDevFeeBps()).to.equal(MIN);
      await expect(token.connect(governor).acceptDevFeeBps())
        .to.emit(token, "DevFeeBpsSet").withArgs(DEFAULT_BPS, MIN);
      expect(await token.devFeeBps()).to.equal(MIN);
    });

    it("is home-chain only", async function () {
      const SatoriToken = await ethers.getContractFactory("SatoriToken");
      const remote = await SatoriToken.connect(deployer).deploy(
        governor.address, dev.address, 999999);
      await remote.waitForDeployment();
      await expect(remote.connect(governor).proposeDevFeeBps(MAX))
        .to.be.revertedWithCustomError(remote, "NotHomeChain");
    });
  });

  // ------------------------------------------------------------------
  describe("at most one change per 30 rounds", function () {
    // A round's budget is sized at the rate live when it starts and booked at
    // the rate live when its wins are scored, so a change moves the dev's
    // booking on the rounds in flight. Alternating a cut before each round's
    // first touch with a raise after it would farm that every round; spacing
    // the changes bounds it to a few rounds per change.
    it("refuses a second accept inside the gap, and allows it on the boundary", async function () {
      await setFee(MAX);
      const at = await token.getCurrentRound();
      expect(await token.lastDevFeeChangeRound()).to.equal(at);
      await token.connect(governor).proposeDevFeeBps(MIN);
      await expect(token.connect(governor).acceptDevFeeBps())
        .to.be.revertedWithCustomError(token, "DevFeeChangeTooSoon");
      await time.increase(ROUND * (GAP - 1));
      await expect(token.connect(governor).acceptDevFeeBps())
        .to.be.revertedWithCustomError(token, "DevFeeChangeTooSoon");
      await time.increase(ROUND);
      await token.connect(governor).acceptDevFeeBps();
      expect(await token.devFeeBps()).to.equal(MIN);
    });

    it("the gap counts from the last ACCEPT, not from the proposal, and a cancel resets nothing", async function () {
      await setFee(MAX);
      await time.increase(ROUND * 10);
      await token.connect(governor).proposeDevFeeBps(MIN);
      await token.connect(governor).cancelDevFeeBps();
      await time.increase(ROUND * 20);
      await setFee(MIN);                       // 30 rounds after the accept
      expect(await token.devFeeBps()).to.equal(MIN);
    });

    it("a proposal may stand through the gap and be accepted once it opens", async function () {
      await setFee(MAX);
      await token.connect(governor).proposeDevFeeBps(2000n);
      await waitGap();
      await token.connect(governor).acceptDevFeeBps();
      expect(await token.devFeeBps()).to.equal(2000n);
    });
  });

  // ------------------------------------------------------------------
  describe("a rate change never revalues history", function () {
    it("moves no counter, in either direction", async function () {
      await time.increase(ROUND);
      await earn((await room()) / 2n);
      await token.connect(controller).accrueRewards(ethers.parseEther("1"));   // earned, unclaimed

      for (const bps of [MAX, MIN, 2000n]) {
        const before = [
          await token.generalAccrued(), await token.devFeeAccrued(),
          await token.generalMinted(), await token.devFeeMinted(),
        ];
        await setFee(bps);
        // Not "close to" — exactly: the accept writes the rate and nothing else.
        expect([
          await token.generalAccrued(), await token.devFeeAccrued(),
          await token.generalMinted(), await token.devFeeMinted(),
        ]).to.deep.equal(before);
        await waitGap();
      }
    });

    it("prices each report at the rate that was in force for it", async function () {
      const genesisFee = await token.devFeeAccrued();
      await time.increase(ROUND);
      const first = await room();
      await earn(first);
      const afterFirst = await token.devFeeAccrued();
      expect(afterFirst - genesisFee).to.equal(feeOn(first, DEFAULT_BPS));

      await setFee(MAX);                       // 25% from here on
      await time.increase(ROUND);
      const second = await room();
      await earn(second);

      // The first report keeps its 15%; only the second is charged 25%.
      expect(await token.devFeeAccrued()).to.equal(afterFirst + feeOn(second, MAX));
      const booked = (await token.devFeeAccrued()) - genesisFee;
      // And it is strictly MORE than charging the whole history at 15%...
      expect(booked).to.be.gt(feeOn(first + second, DEFAULT_BPS));
      // ...and strictly LESS than charging the whole history at 25%, which is
      // exactly what a mint-time fee would have done to an unclaimed credit.
      expect(booked).to.be.lt(feeOn(first + second, MAX));
      expect(booked).to.be.lt(feeOn(first, MAX) + feeOn(second, MAX));
    });

    it("never claws back a fee already pulled, and a cut takes nothing back", async function () {
      await time.increase(ROUND);
      await earn(await room());
      await token.mintDevFee();
      const pulled = await token.devFeeMinted();
      expect(pulled).to.be.gt(0n);

      await setFee(MIN);                       // a CUT, the dangerous direction
      expect(await token.devFeeMinted()).to.equal(pulled);
      expect(await token.devFeeAccrued()).to.equal(pulled);
      expect(await token.mintDevFee.staticCall()).to.equal(0n);
    });
  });

  // ------------------------------------------------------------------
  describe("every credit stays mintable, whatever the fee does", function () {
    it("a RAISE leaves what was reported mintable, to the wei", async function () {
      // THE M03 REGRESSION. Report a round's worth at 15%, raise to 25%, and
      // the room is unchanged: `rewardMint` reads accrued minus minted, and a
      // change touches neither. A mint-time fee would have priced the backlog
      // at the new rate and refused the last claimants.
      await time.increase(ROUND);
      const credited = await room();
      await token.connect(controller).accrueRewards(credited);
      const roomBefore = (await token.generalAccrued()) - (await token.generalMinted());
      expect(roomBefore).to.equal(credited);

      await setFee(MAX);

      expect((await token.generalAccrued()) - (await token.generalMinted())).to.equal(roomBefore);
      await expect(token.connect(controller).rewardMint(alice.address, credited)).to.not.be.reverted;
      await expect(token.connect(controller).rewardMint(alice.address, 1n))
        .to.be.revertedWithCustomError(token, "NotAccrued");
    });

    it("a raise narrows NEW reports' room in the envelope, a cut widens it", async function () {
      await time.increase(ROUND);
      await earn(await room());

      await setFee(MAX);
      await waitGap();
      // Start of a round, so both rooms below are read against one envelope:
      // the envelope grows every round, which would widen the second room at
      // any rate.
      const t = await time.latest();
      await time.increaseTo(Math.floor(t / ROUND) * ROUND + ROUND + 1);
      const round = await token.getCurrentRound();

      const atMax = await room();
      const accrue = (g) => token.connect(controller).accrueRewards.staticCall(g);
      await expect(accrue(atMax)).to.not.be.reverted;
      await expect(accrue(atMax + 1n)).to.be.revertedWithCustomError(token, "BudgetExceeded");

      await setFee(MIN);
      expect(await token.getCurrentRound()).to.equal(round);
      const atMin = await room();
      await expect(accrue(atMin)).to.not.be.reverted;
      await expect(accrue(atMin + 1n)).to.be.revertedWithCustomError(token, "BudgetExceeded");

      expect(atMin).to.be.gt(atMax);      // 5% books less fee than 25%
      expect(atMax).to.be.gt(0n);         // and 25% still leaves a real lane
    });

    it("the envelope holds at every rate: dev + general never exceeds the ceiling", async function () {
      // Walked across a sequence of changes with reporting and minting between.
      for (const bps of [MAX, MIN, 2000n, 1000n, DEFAULT_BPS]) {
        await setFee(bps);
        await time.increase(ROUND);
        const g = await room();
        if (g > 0n) await earn(g);
        expect((await token.devFeeAccrued()) + (await token.generalAccrued()))
          .to.be.lte(await token.rewardCeiling());
        // Realizing the fee keeps it true.
        await token.mintDevFee();
        expect(await token.totalRewardsMinted()).to.be.lte(await token.rewardCeiling());
        await waitGap();
      }
    });
  });
});
