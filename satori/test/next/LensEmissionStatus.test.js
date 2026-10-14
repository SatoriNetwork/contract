const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture } = require("../fixtures");
const {
  ONE, BASE, PHI_INV, RATE_CAP, NO_STEP, T0,
  stepRate, ladder, grossUp, rewardsSigner, issueTo, advanceRound,
} = require("./emissionHelpers");

describe("SatoriRewardsLens.emissionStatus", function () {
  this.timeout(600000);
  let fix, hub, token, rewards, lens, owner, rw;

  beforeEach(async function () {
    fix = await loadFixture(deploySatoriFixture);
    ({ hub, token, rewards, lens, owner } = fix);
    rw = await rewardsSigner(rewards);
    await advanceRound();
  });

  it("reads the genesis schedule", async function () {
    const st = await lens.emissionStatus();
    expect(st.rateNow).to.equal(BASE);
    expect(st.rateNext).to.equal(BASE);
    expect(st.rateAfterStep).to.equal(stepRate(BASE, PHI_INV));
    expect(st.ratioWad).to.equal(PHI_INV);
    expect(st.stepsTaken).to.equal(0n);
    expect(st.issued).to.equal(BASE);
    expect(st.issuedProjected).to.equal(BASE);
    expect(st.nextStepAt).to.equal(T0);
    expect(st.stepsActive).to.equal(true);
    expect(st.holder).to.equal(await hub.emissionHolder());
    expect(st.dial).to.equal(0n);
    expect(st.dialEffective).to.equal(0n);
  });

  it("a crossing moves rateNext and the next rung, not this round's rate", async function () {
    const rows = ladder();
    await issueTo(hub, token, rw, T0);
    const st = await lens.emissionStatus();
    expect(st.rateNow).to.equal(BASE);
    expect(st.rateNext).to.equal(rows[0].rate);
    expect(st.rateAfterStep).to.equal(rows[1].rate);
    expect(st.nextStepAt).to.equal(rows[0].next);
    expect(st.stepsTaken).to.equal(1n);
    await advanceRound();
    expect((await lens.emissionStatus()).rateNow).to.equal(rows[0].rate);
  });

  it("ratio 1.0 reports no step pending; 2.0 clamps at 1440; dust steps to zero", async function () {
    await hub.connect(owner).setEmissionRatio(ONE);
    let st = await lens.emissionStatus();
    expect(st.stepsActive).to.equal(false);
    expect(st.rateAfterStep).to.equal(st.rateNext);

    await hub.connect(owner).setEmissionRatio(2n * ONE);
    st = await lens.emissionStatus();
    expect(st.stepsActive).to.equal(true);
    expect(st.rateAfterStep).to.equal(2n * BASE > RATE_CAP ? RATE_CAP : 2n * BASE);

    await hub.connect(owner).setEmissionRatio(1n); // dust: 0 itself reverts
    st = await lens.emissionStatus();
    expect(st.stepsActive).to.equal(true);
    expect(st.rateAfterStep).to.equal(BASE / ONE);

    await issueTo(hub, token, rw, st.nextStepAt + ONE);
    st = await lens.emissionStatus();
    expect(st.rateNext).to.equal(0n);
    expect(st.nextStepAt).to.equal(NO_STEP);
    expect(st.stepsActive).to.equal(false);
  });

  it("issuedProjected is what banking the accrued reserve would count", async function () {
    const dial = ethers.parseEther("100");
    await rewards.connect(owner).setOffchainBudget(dial);
    await advanceRound();
    await advanceRound();
    await advanceRound();
    const st = await lens.emissionStatus();
    const bps = await token.devFeeBps();
    const due = (await hub.merkleReserveCeiling()) - (await hub.merkleReserveCumulative());
    expect(due).to.be.gt(0n);
    expect(st.issuedProjected).to.equal(st.issued + grossUp(due, bps));
    await hub.syncEmission();
    expect((await hub.emission()).issued).to.equal(st.issuedProjected);
  });

  it("dialEffective yields to residualNext − 1 when a step lands under the dial", async function () {
    const residual0 = await hub.residualNext();
    await rewards.connect(owner).setOffchainBudget(residual0 - 1n);
    let st = await lens.emissionStatus();
    expect(st.dial).to.equal(residual0 - 1n);
    expect(st.dialEffective).to.equal(residual0 - 1n);

    await issueTo(hub, token, rw, T0);
    st = await lens.emissionStatus();
    const residual1 = await hub.residualNext();
    expect(residual1).to.be.lt(residual0);
    expect(st.dial).to.equal(residual0 - 1n);
    expect(st.dialEffective).to.equal(residual1 - 1n);
  });
});
