// THE CURVE TUNING KEY.
//
// The five curve dials are the only GOVERNOR powers that are routine rather than
// rare. upgradeTo / setController / setHook / setGovernor are once-in-a-long-
// while and catastrophic if wrong — a multisig is exactly right for those.
// Tuning a gradient is the opposite: repeated, reversible, done while watching
// how the field responds. A knob that costs a three-signature ceremony does not
// get turned.
//
// What makes it safe to delegate is that the dials are bounded IN THE SETTERS,
// not by the caller's judgement — so this key can never reach a value the
// governor could not. These tests pin both halves: that the key works, and that
// it buys no extra reach.
const { expect } = require("chai");
const { deploySatoriFixture } = require("./fixtures");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { ethers } = require("hardhat");

describe("Curve operator", function () {
  let engine, token, owner, tuner, mallory;

  beforeEach(async function () {
    const fix = await loadFixture(deploySatoriFixture);
    ;({ engine, token, owner } = fix);
    [, tuner, mallory] = fix.signers;
  });

  describe("the key", function () {
    it("starts unset, leaving tuning governor-only — the prior behaviour", async function () {
      expect(await engine.curveOperator()).to.equal(ethers.ZeroAddress);
      await expect(engine.connect(tuner).setDustFloor(5))
        .to.be.revertedWithCustomError(engine, "NotCurveOperator");
      // The governor still tunes, exactly as before this key existed.
      await engine.connect(owner).setDustFloor(5);
      expect((await engine.curveConfig())[0]).to.equal(5);
    });

    it("is set by the GOVERNOR, not the rewards admin", async function () {
      // The power being delegated is the governor's, so the governor delegates
      // it. Routing this through the admin would let the admin grant itself a
      // governor power.
      expect(await token.rootAuthority()).to.equal(owner.address);
      await engine.connect(owner).setCurveOperator(tuner.address);
      expect(await engine.curveOperator()).to.equal(tuner.address);
    });

    it("cannot be set by anyone else — including the operator itself", async function () {
      await engine.connect(owner).setCurveOperator(tuner.address);
      await expect(engine.connect(mallory).setCurveOperator(mallory.address))
        .to.be.revertedWithCustomError(engine, "Unauthorized");
      await expect(engine.connect(tuner).setCurveOperator(tuner.address))
        .to.be.revertedWithCustomError(engine, "Unauthorized");
    });

    it("is rotatable, and the old key goes cold at once", async function () {
      await engine.connect(owner).setCurveOperator(tuner.address);
      await engine.connect(owner).setCurveOperator(mallory.address);
      await expect(engine.connect(tuner).setDustFloor(5))
        .to.be.revertedWithCustomError(engine, "NotCurveOperator");
      await engine.connect(mallory).setDustFloor(5);
    });

    it("is revoked by setting it back to zero", async function () {
      await engine.connect(owner).setCurveOperator(tuner.address);
      await engine.connect(owner).setCurveOperator(ethers.ZeroAddress);
      await expect(engine.connect(tuner).setDustFloor(5))
        .to.be.revertedWithCustomError(engine, "NotCurveOperator");
    });

    it("never displaces the governor — delegation is additive", async function () {
      // A lost or rotated operator key must always be repairable from the
      // multisig, which means the governor keeps the dials too.
      await engine.connect(owner).setCurveOperator(tuner.address);
      await engine.connect(owner).setDustFloor(6);
      expect((await engine.curveConfig())[0]).to.equal(6);
    });
  });

  describe("what the key can turn", function () {
    beforeEach(async function () {
      await engine.connect(owner).setCurveOperator(tuner.address);
    });

    it("moves all five dials", async function () {
      await engine.connect(tuner).setDustFloor(6);
      await engine.connect(tuner).setBottomGradient(20);   // raise r before g
      await engine.connect(tuner).setTopGradient(4);
      await engine.connect(tuner).setTopShift(3);
      await engine.connect(tuner).setDustTarget(7000);

      const cfg = await engine.curveConfig();
      expect(cfg[0]).to.equal(6);
      expect(cfg[1]).to.equal(4);
      expect(cfg[2]).to.equal(20);
      expect(cfg[3]).to.equal(3);
      expect(await engine.dustTargetBps()).to.equal(7000);
    });

    it("reaches nothing beyond the dials", async function () {
      // The whole argument for a warm key is that its blast radius is the five
      // bounded dials. If it could reach an upgrade or a pointer, the argument
      // collapses.
      await expect(engine.connect(tuner).setHub(mallory.address))
        .to.be.revertedWithCustomError(engine, "Unauthorized");
      await expect(engine.connect(tuner).setCurveOperator(mallory.address))
        .to.be.revertedWithCustomError(engine, "Unauthorized");
    });
  });

  describe("the bounds hold for the delegated key exactly as for the governor", function () {
    beforeEach(async function () {
      await engine.connect(owner).setCurveOperator(tuner.address);
    });

    it("rejects an out-of-range floor", async function () {
      await expect(engine.connect(tuner).setDustFloor(0)).to.be.revertedWithCustomError(engine, "BadInput");
      await expect(engine.connect(tuner).setDustFloor(65)).to.be.revertedWithCustomError(engine, "BadInput");
    });

    it("still enforces monotonicity (r >= g) from both directions", async function () {
      // The invariant that keeps a longer streak from ever earning less. It is
      // checked in the setter, so delegation cannot weaken it.
      await expect(engine.connect(tuner).setTopGradient(9)).to.be.revertedWithCustomError(engine, "BadInput");
      await engine.connect(tuner).setBottomGradient(4);
      await expect(engine.connect(tuner).setTopGradient(5)).to.be.revertedWithCustomError(engine, "BadInput");
    });

    it("caps the shift and the controller setpoint", async function () {
      await expect(engine.connect(tuner).setTopShift(65)).to.be.revertedWithCustomError(engine, "BadInput");
      await expect(engine.connect(tuner).setDustTarget(10000)).to.be.revertedWithCustomError(engine, "BadInput");
    });

    it("cannot reach a value the governor could not", async function () {
      // Same rejection, same reason, whoever calls.
      await expect(engine.connect(owner).setDustFloor(65)).to.be.revertedWithCustomError(engine, "BadInput");
      await expect(engine.connect(tuner).setDustFloor(65)).to.be.revertedWithCustomError(engine, "BadInput");
    });
  });
});
