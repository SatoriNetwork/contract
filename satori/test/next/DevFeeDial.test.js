const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

// THE DAO'S FEE DIAL — a BOUNDED, TWO-STEP lever on the dev fee.
//
// humble.md 1b, owner-ruled 2026-09-11. The fee ships at 15% and the governor
// (later: the DAO) may move it, but only inside [5%, 25%]. The band is made of
// constants in the immutable token, so the DAO chooses inside a range the
// constitution fixes and the range itself is as unalterable as the old flat
// rate was.
//
// This reverses the earlier "the fee gets no key, ever" ruling, and the trade is
// real: whoever holds `governor` can take a quarter of all emission. What these
// tests hold the line on is that they cannot go outside the band, cannot do it
// in one transaction, and — the load-bearing one — cannot revalue history by
// doing it.
//
// THE PROPERTY THAT MATTERS. The naive implementation recomputes the general
// lane's cap as a flat `(10000 - bps)` of the ceiling. Under a RAISE that
// applies retroactively to everything already minted: generalMinted() can
// already sit above the new cap, and every reward mint reverts until the
// ceiling grows out from under it. The protocol bricks on a governance action
// that looked routine. The segmented form cannot do that, for any rate in the
// band, and `cannot brick the mint path` below is written to fail against the
// naive one.

const ROUND = 86400;
const PLACEHOLDER = "0x000000000000000000000000000000000000dEaD";

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
  });

  // Move the fee to `bps`, both steps, in two different blocks.
  async function setFee(bps) {
    await token.connect(governor).proposeDevFeeBps(bps);
    await token.connect(governor).acceptDevFeeBps();
  }

  // Mint `amount` into the general lane as the controller.
  const mint = (amount) => token.connect(controller).rewardMint(alice.address, amount);

  // Whatever general-lane headroom stands right now.
  const headroom = async () =>
    (await token.generalCeiling()) - (await token.generalMinted());

  // ------------------------------------------------------------------
  describe("the band", function () {
    it("ships at 15% inside a [5%, 25%] band, with the checkpoints empty", async function () {
      expect(DEFAULT_BPS).to.equal(1500n);
      expect(MIN).to.equal(500n);
      expect(MAX).to.equal(2500n);
      expect(await token.devFeeBps()).to.equal(DEFAULT_BPS);
      // The first segment runs from nothing minted, so the genesis mint is
      // valued by the same formula every later mint uses — no special case.
      expect(await token.devAccruedCheckpoint()).to.equal(0n);
      expect(await token.generalMintedCheckpoint()).to.equal(0n);
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
      await token.connect(governor).acceptDevFeeBps();
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
  describe("a rate change never revalues history", function () {
    it("devFeeCeiling is CONTINUOUS across the change, in both directions", async function () {
      await time.increase(ROUND);
      await mint(await headroom());

      for (const bps of [MAX, MIN, 2000n]) {
        const before = await token.devFeeCeiling();
        await setFee(bps);
        // Not "close to" — exactly. The new segment starts at zero width, so
        // the value is devAccruedCheckpoint on both sides of the switch.
        expect(await token.devFeeCeiling()).to.equal(before);
        expect(await token.devAccruedCheckpoint()).to.equal(before);
        expect(await token.generalMintedCheckpoint()).to.equal(await token.generalMinted());
      }
    });

    it("prices each segment at the rate that was in force for it", async function () {
      await time.increase(ROUND);
      const first = await headroom();
      await mint(first);
      const afterFirst = await token.devFeeCeiling();

      await setFee(MAX);                       // 25% from here on
      await time.increase(ROUND);
      const second = await headroom();
      await mint(second);

      // The first segment keeps its 15%; only the second is charged 25%.
      const expected = afterFirst + (second * MAX) / (10000n - MAX);
      expect(await token.devFeeCeiling()).to.equal(expected);
      // And it is strictly MORE than charging the whole history at 15%...
      const allAtDefault = ((first + second) * DEFAULT_BPS) / (10000n - DEFAULT_BPS);
      expect(await token.devFeeCeiling()).to.be.gt(allAtDefault);
      // ...and strictly LESS than charging the whole history at 25%, which is
      // exactly what a naive un-segmented implementation would have done.
      const allAtMax = ((first + second) * MAX) / (10000n - MAX);
      expect(await token.devFeeCeiling()).to.be.lt(allAtMax);
    });

    it("never claws back a fee already pulled", async function () {
      await time.increase(ROUND);
      await mint(await headroom());
      await token.mintDevFee();
      const pulled = await token.devFeeMinted();
      expect(pulled).to.be.gt(0n);

      await setFee(MIN);                       // a CUT, the dangerous direction
      expect(await token.devFeeMinted()).to.equal(pulled);
      // The entitlement did not fall below what was already paid, so the pull
      // saturates at zero rather than underflowing.
      expect(await token.devFeeCeiling()).to.be.gte(pulled - 1n);
      expect(await token.mintDevFee.staticCall()).to.equal(0n);
    });
  });

  // ------------------------------------------------------------------
  describe("the reservation moves without bricking the mint path", function () {
    it("a RAISE cannot push the cap below what is already minted", async function () {
      // THE REGRESSION. Fill the general lane to its cap at 15%, then raise to
      // 25%. A flat `ceiling * 75%` cap would now sit BELOW generalMinted, and
      // every mint would revert until the ceiling grew past it.
      await time.increase(ROUND);
      await mint(await headroom());
      const mintedAtCap = await token.generalMinted();
      expect(await token.generalCeiling()).to.equal(mintedAtCap); // exactly full

      await setFee(MAX);

      // The cap must not have moved BELOW the minted figure...
      expect(await token.generalCeiling()).to.be.gte(mintedAtCap);
      // ...and the naive figure genuinely would have, so this proves something.
      const naive = ((await token.rewardCeiling()) * (10000n - MAX)) / 10000n;
      expect(naive).to.be.lt(mintedAtCap);

      // A zero-value mint is still accepted (the lane is full, not broken)...
      await expect(mint(0n)).to.not.be.reverted;
      // ...and the round after, the lane is live again with real headroom.
      await time.increase(ROUND);
      expect(await headroom()).to.be.gt(0n);
      await expect(mint(await headroom())).to.not.be.reverted;
    });

    it("a raise narrows the general lane's NEW headroom, a cut widens it", async function () {
      await time.increase(ROUND);
      await mint(await headroom());

      await setFee(MAX);
      await time.increase(ROUND);
      const atMax = await headroom();

      // Same elapsed rounds, from the same full state, at the other edge.
      await setFee(MIN);
      const atMin = await headroom();

      expect(atMin).to.be.gt(atMax);      // 5% reserves less than 25%
      expect(atMax).to.be.gt(0n);         // and 25% still leaves a real lane
    });

    it("the reservation holds at every rate: dev + general never exceeds the ceiling", async function () {
      // The invariant the whole segmented form exists to preserve, walked across
      // a sequence of changes with minting in between.
      for (const bps of [MAX, MIN, 2000n, 1000n, DEFAULT_BPS]) {
        await setFee(bps);
        await time.increase(ROUND);
        const room = await headroom();
        if (room > 0n) await mint(room);
        expect((await token.devFeeCeiling()) + (await token.generalMinted()))
          .to.be.lte(await token.rewardCeiling());
        // Realizing the fee keeps it true.
        await token.mintDevFee();
        expect(await token.totalRewardsMinted()).to.be.lte(await token.rewardCeiling());
      }
    });

    it("generalCeilingFor answers for ANY ceiling — that is how the hub asks", async function () {
      // The hub supplies its own, stricter ceiling (its decaying emission
      // schedule) and takes the answer, rather than keeping a second copy of
      // the formula that would have to be kept in step by hand.
      const own = await token.generalCeiling();
      expect(own).to.equal(await token.generalCeilingFor(await token.rewardCeiling()));
      // Monotone in the ceiling, and never above it.
      const half = (await token.rewardCeiling()) / 2n;
      expect(await token.generalCeilingFor(half)).to.be.lt(own);
      expect(await token.generalCeilingFor(half)).to.be.lte(half);
    });
  });
});
