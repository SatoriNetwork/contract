// The farming threshold — docs/design/farming-threshold.md.
//
// Below a flat minimum (1 SATORI) of TOTAL prediction power, a correct call pays
// as normal but does not GROW the streak. It does not take away a streak already
// earned.
//
// This replaces a defence that never worked. `ZeroBalance` only refused a power of
// exactly zero, and raw power truncates below ~0.0000011 SATORI, so a one-wei
// wallet earned nothing and built streaks for the price of gas. That bypass is
// what `DustStreakFarming.test.js` demonstrated; the last test here is the same
// scenario, now closed.

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture, pack1 } = require("./fixtures");

describe("Farming threshold", function () {
  let fix, satori, token, hub, lens, registry, rewards, owner, alice, dust;
  let gameId;

  beforeEach(async function () {
    fix = await loadFixture(deploySatoriFixture);
    ({ satori, token, hub, lens, registry, rewards, owner } = fix);
    [, alice, dust] = fix.signers;

    await satori.createSimpleDataStream("Threshold Stream", owner.address);
    gameId = await fix.games.gameCount();

    await satori.transfer(alice.address, ethers.parseEther("50"));
    await token.connect(alice).approve(await hub.getAddress(), ethers.MaxUint256);
    await satori.connect(alice).vote(gameId, ethers.parseEther("10"));
  });

  /// One correct prediction on `gameId`, settled. Cadence 2 = two rounds a step.
  async function predictAndWin(user, base) {
    const step = 86400 * 2;
    await time.increase(step);
    await registry.connect(owner).setValue(gameId, base);
    await satori.connect(user).predictMultipleWithPayloads([{ gameId, payload: pack1(1) }]);
    await time.increase(step);
    await registry.connect(owner).setValue(gameId, base + 10);
    await time.increase(step);
    await registry.connect(owner).setValue(gameId, base + 20);
    await satori.settlePrediction(user.address, gameId);
  }

  describe("the number itself", function () {
    it("is a flat 1 SATORI, and the hub and lens agree exactly", async function () {
      const fromHub = await hub.farmingThreshold();
      const fromLens = await lens.farmingThreshold();
      expect(fromHub).to.equal(fromLens);
      expect(fromHub).to.equal(ethers.parseEther("1"));
    });

    it("sits FAR above the dust truncation, so it bites from the first round", async function () {
      // Raw power drops its low 40 bits, so anything under this earns nothing.
      const truncation = 2n ** 40n;
      expect(await hub.farmingThreshold()).to.be.gt(truncation * 1000n);
    });

    it("is FLAT — does not change as rounds elapse", async function () {
      const before = await hub.farmingThreshold();
      await time.increase(86400 * 400);
      expect(await hub.farmingThreshold()).to.equal(before);
    });

  });

  describe("above the threshold", function () {
    it("a funded predictor grows a streak normally", async function () {
      expect(await token.balanceOf(alice.address)).to.be.gt(await hub.farmingThreshold());

      let base = 1000;
      for (let i = 0; i < 3; i++) { await predictAndWin(alice, base); base += 100; }

      expect(await satori.streaks(alice.address, gameId)).to.equal(3n);
    });
  });

  describe("below the threshold", function () {
    beforeEach(async function () {
      // Enough to predict, far below the threshold. This is the exact wallet that
      // used to farm streaks for free.
      await satori.transfer(dust.address, 1n);
      expect(await rewards.getPredictionPower(dust.address)).to.be.lt(await hub.farmingThreshold());
    });

    it("CANNOT grow a streak, however many correct calls it makes", async function () {
      let base = 1000;
      for (let i = 0; i < 4; i++) { await predictAndWin(dust, base); base += 100; }

      expect(
        await satori.streaks(dust.address, gameId),
        "a sub-threshold wallet must never leave streak 0",
      ).to.equal(0n);
    });

    it("is still allowed to predict, and is still paid what it earns", async function () {
      // The rule gates the STREAK, not participation. A one-wei holder earns zero
      // because its weight rounds to zero, not because it was refused.
      await time.increase(86400 * 2);
      await registry.connect(owner).setValue(gameId, 7000);
      await expect(
        satori.connect(dust).predictMultipleWithPayloads([{ gameId, payload: pack1(1) }]),
      ).to.not.be.reverted;
    });

    it("KEEPS a streak it already earned — growth stops, nothing is taken away", async function () {
      // Earn a streak of 2 while funded...
      const rich = fix.signers[7];
      await satori.transfer(rich.address, ethers.parseEther("20"));
      let base = 2000;
      for (let i = 0; i < 2; i++) { await predictAndWin(rich, base); base += 100; }
      expect(await satori.streaks(rich.address, gameId)).to.equal(2n);

      // ...then drop below the threshold and keep winning.
      //
      // Prediction power is balance PLUS unclaimed rewards, so shipping the
      // balance out is not enough on its own: the winnings would hold them above
      // the line. Claim first, then send everything.
      await satori.connect(rich).claim();
      const bal = await token.balanceOf(rich.address);
      await token.connect(rich).transfer(owner.address, bal - 1n);
      expect(await rewards.getPredictionPower(rich.address)).to.be.lt(await hub.farmingThreshold());

      await predictAndWin(rich, base);

      expect(
        await satori.streaks(rich.address, gameId),
        "the earned streak survives; only the increment stops",
      ).to.equal(2n);
    });

    it("closes the dust-fleet farm that the ZeroBalance gate never did", async function () {
      // The scenario from DustStreakFarming.test.js, now defeated: correct calls,
      // zero earnings, and NO streak to sell.
      let base = 5000;
      for (let i = 0; i < 3; i++) { await predictAndWin(dust, base); base += 100; }

      expect(await satori.streaks(dust.address, gameId)).to.equal(0n);
      expect(await rewards.unclaimedRewards(dust.address)).to.equal(0n);
    });
  });

  describe("what it must NOT break", function () {
    it("audit F16 survives: a correct call on an INELIGIBLE stream still builds a streak", async function () {
      // The flag is about the PREDICTOR's total power, not the stream's
      // eligibility, so an unvoted non-paying stream still sources reputation.
      await satori.createSimpleDataStream("Unvoted Stream", owner.address);
      const unvoted = await fix.games.gameCount();
      expect(await fix.voting.gameWeight(unvoted)).to.equal(0n);

      const step = 86400 * 2;
      await time.increase(step);
      await registry.connect(owner).setValue(unvoted, 100);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: unvoted, payload: pack1(1) }]);
      await time.increase(step);
      await registry.connect(owner).setValue(unvoted, 110);
      await time.increase(step);
      await registry.connect(owner).setValue(unvoted, 120);
      await satori.settlePrediction(alice.address, unvoted);

      expect(
        await satori.streaks(alice.address, unvoted),
        "ineligible-stream sourcing must be untouched (audit F16)",
      ).to.equal(1n);
    });

    it("predicting many games at once does not push you under your own floor", async function () {
      // The flag is computed from TOTAL power, once per batch. If it were computed
      // from the per-stream share, a wide batch would divide a funded user below
      // the line and silently stop their streaks.
      const ids = [gameId];
      for (let i = 0; i < 3; i++) {
        await satori.createSimpleDataStream(`Wide ${i}`, owner.address);
        const g = await fix.games.gameCount();
        await satori.connect(alice).vote(g, ethers.parseEther("2"));
        ids.push(g);
      }

      const step = 86400 * 2;
      await time.increase(step);
      for (const g of ids) await registry.connect(owner).setValue(g, 400);
      await satori.connect(alice).predictMultipleWithPayloads(
        ids.map((g) => ({ gameId: g, payload: pack1(1) })),
      );
      await time.increase(step);
      for (const g of ids) await registry.connect(owner).setValue(g, 410);
      await time.increase(step);
      for (const g of ids) await registry.connect(owner).setValue(g, 420);
      for (const g of ids) await satori.settlePrediction(alice.address, g);

      for (const g of ids) {
        expect(
          await satori.streaks(alice.address, g),
          `game ${g}: a wide batch must not cost the streak`,
        ).to.equal(1n);
      }
    });

    it("the multiplier still round-trips through the narrowed field", async function () {
      // PR_MULT went 48 -> 47 bits to free the flag. Real multipliers need 37, so
      // this must be lossless: the stored multiplier drives the payout, and a
      // truncated one would silently misprice every win.
      let base = 9000;
      for (let i = 0; i < 2; i++) { await predictAndWin(alice, base); base += 100; }

      // Third win, capturing the round so the packed prediction can be read back.
      const step = 86400 * 2;
      await time.increase(step);
      await registry.connect(owner).setValue(gameId, base);
      const madeAt = await satori.getCurrentRound();
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId, payload: pack1(1) }]);
      await time.increase(step);
      await registry.connect(owner).setValue(gameId, base + 10);
      await time.increase(step);
      await registry.connect(owner).setValue(gameId, base + 20);
      await satori.settlePrediction(alice.address, gameId);

      const pred = await satori.predictions(alice.address, gameId, madeAt);
      expect(await satori.streaks(alice.address, gameId)).to.equal(3n);
      expect(pred.multiplier, "multiplier must survive the narrower field").to.be.gt(0n);
      expect(pred.multiplier, "and must not have been truncated into the flag bit").to.be.lt(2n ** 47n);
    });
  });

  describe("no barrier to entry", function () {
    it("an EMPTY wallet may predict — the ZeroBalance gate is gone", async function () {
      const empty = fix.signers[8];
      expect(await token.balanceOf(empty.address)).to.equal(0n);
      expect(await rewards.getPredictionPower(empty.address)).to.equal(0n);

      await time.increase(86400 * 2);
      await registry.connect(owner).setValue(gameId, 3000);
      await expect(
        satori.connect(empty).predictMultipleWithPayloads([{ gameId, payload: pack1(1) }]),
      ).to.not.be.reverted;
    });

    it("and earns nothing and grows no streak, which is why letting it in is safe", async function () {
      const empty = fix.signers[8];
      let base = 3000;
      for (let i = 0; i < 3; i++) { await predictAndWin(empty, base); base += 100; }

      expect(await satori.streaks(empty.address, gameId), "no streak from nothing").to.equal(0n);
      expect(await rewards.unclaimedRewards(empty.address), "no reward from nothing").to.equal(0n);
    });

    it("a zero-power prediction does not move the adaptive bar", async function () {
      // The controller is power-weighted (`_dustSignal += perStreamPower * ...`),
      // so an empty wallet contributes exactly zero to it. If it did not, opening
      // the door would hand anyone a free lever on everybody else's payout curve.
      const empty = fix.signers[8];
      // Bootstrap the game's controller state first. Its threshold is unset (0)
      // until a round touches it, and that first touch stamps the floor — which
      // would otherwise read as the bar moving.
      await predictAndWin(alice, 6000);
      const before = (await fix.engine.gameStreakState(gameId)).threshold;
      expect(before).to.be.gt(0n);

      let base = 6100;
      for (let i = 0; i < 3; i++) { await predictAndWin(empty, base); base += 100; }
      const after = (await fix.engine.gameStreakState(gameId)).threshold;
      expect(after, "an empty wallet must not be able to move the bar").to.equal(before);
    });
  });
});
