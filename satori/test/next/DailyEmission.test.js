const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixtureNoFee } = require("../fixtures");
const { ONE, BASE, rewardsSigner, issueTo, issueBelow, advanceRound, eventsNamed } = require("./emissionHelpers");

// Owner ruling 2026-10-27: the same issuance-indexed decay, stepping every
// round's worth from day 1, by 1 − base/2,900,000, so lifetime emission
// approaches 2,900,000 (4,000,000 with the 1.1M airdrop).
const LIFETIME = ethers.parseEther("2900000");
const RATIO = ONE - (BASE * ONE + LIFETIME - 1n) / LIFETIME; // 1 − base/2.9M, truncated
const step = (r, q = RATIO) => (r * q) / ONE;

describe("SatoriHub — a step every round's worth, approaching 2.9M", function () {
  this.timeout(600000);
  let hub, token, rewards, owner, rw;

  beforeEach(async function () {
    const fix = await loadFixture(deploySatoriFixtureNoFee);
    ({ hub, token, rewards, owner } = fix);
    rw = await rewardsSigner(rewards);
  });

  // Issue up to the next threshold: nothing steps short of it, one step at it.
  async function stepOnce() {
    const e = await hub.emission();
    if (e.nextStepAt > e.issued + 1n) {
      const { tx } = await issueBelow(hub, token, rw, e.nextStepAt);
      await expect(tx).to.not.emit(hub, "EmissionStepped");
    }
    const { tx } = await issueTo(hub, token, rw, (await hub.emission()).nextStepAt);
    const ev = eventsNamed(await tx.wait(), hub, "EmissionStepped");
    expect(ev.length).to.equal(1);
    return { ev: ev[0], prevNext: e.nextStepAt };
  }

  it("defaults: one round's worth flat, one round's worth per step, ratio 1 − base/2.9M", async function () {
    expect(await hub.FLAT_ROUNDS()).to.equal(1n);
    expect(await hub.STEP_ROUNDS()).to.equal(1n);
    expect(await hub.DEFAULT_EMISSION_RATIO()).to.equal(999708061412966511n);
    expect(await hub.DEFAULT_EMISSION_RATIO()).to.equal(RATIO);
    expect((await hub.emission()).ratioWad).to.equal(RATIO);
    const lifetime = (BASE * ONE) / (ONE - RATIO);
    expect(lifetime > LIFETIME ? lifetime - LIFETIME : LIFETIME - lifetime).to.be.lessThan(10n ** 12n);
  });

  it("the first threshold is the genesis round's worth: day 1 pays the base", async function () {
    const e = await hub.emission();
    expect(e.nextStepAt).to.equal(BASE);
    expect(e.issued).to.be.at.least(BASE);
    expect(await hub.emissionRateNow()).to.equal(BASE);
  });

  it("each round's worth issued takes the NEXT round down by the ratio, ten rounds running", async function () {
    let rate = await hub.emissionRateNext();
    for (let i = 0; i < 10; i++) {
      const before = await hub.emissionRateNow();
      const { ev, prevNext } = await stepOnce();
      expect(ev.args.newRate, `step ${i + 1}`).to.equal(step(rate));
      expect(ev.args.nextStepAt).to.equal(prevNext + step(rate)); // one round's worth further
      expect(await hub.emissionRateNow(), "the round in flight keeps its rate").to.equal(before);
      await advanceRound();
      rate = step(rate);
      expect(await hub.emissionRateNow()).to.equal(rate);
    }
  });

  it("the off-chain reserve banked for each round is exactly that round's share of its own rate", async function () {
    await rewards.connect(owner).setOffchainShareBps(5000);
    await advanceRound();
    for (let i = 0; i < 4; i++) {
      await stepOnce();          // steps the rate for next round
      await advanceRound();
      const residual = (await hub.emissionRateNow()) - (await hub.devRateNow());
      const rc = await (await hub.syncEmission()).wait();
      const [bank] = eventsNamed(rc, hub, "MerkleReserveBanked");
      expect(bank.args.throughRoundExclusive - bank.args.fromRound).to.equal(1n);
      expect(bank.args.perRound, `round ${i + 1}`).to.equal((residual * 5000n) / 10000n);
    }
  });

  it("the lever: 1.0 stops the steps, and switching back re-bases one round's worth out", async function () {
    await hub.connect(owner).setEmissionRatio(ONE);
    const rate = await hub.emissionRateNext();
    const { tx } = await issueTo(hub, token, rw, (await hub.emission()).issued + 30n * BASE);
    await expect(tx).to.not.emit(hub, "EmissionStepped");
    await advanceRound();
    expect(await hub.emissionRateNow()).to.equal(rate);

    await hub.connect(owner).setEmissionRatio(RATIO);
    const e = await hub.emission();
    expect(e.nextStepAt).to.equal(e.issued + rate);
  });

  it("the lever: a ratio above 1 raises the rate, clamped at 1440", async function () {
    await hub.connect(owner).setEmissionRatio(ONE + ONE / 1000n); // +0.1% a step
    const rate = await hub.emissionRateNext();
    const { ev } = await stepOnce();
    expect(ev.args.newRate).to.equal(step(rate, ONE + ONE / 1000n));
    expect(ev.args.newRate).to.be.greaterThan(rate);
  });
});
