const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixtureNoFee, pack1, voteFor } = require("../fixtures");
const {
  ONE, BASE, DEFAULT_RATIO, T0, stepRate, grossUp, rewardsSigner, issueTo,
  currentRound, atRound, advanceRound,
} = require("./emissionHelpers");

// The off-chain split is a share of each round's residual, so when the rate
// falls — by issuance (an automatic step) or by an admin ratio cut that the
// next step applies — both lanes follow the new residual instead of a fixed
// amount overrunning it. These run at the deepest legal share (9999 bps), where
// a fixed amount would have overrun soonest. Each test pins one site.
//
// The default schedule steps every round's worth, so the rate falls a little at
// almost every touch. To read each lane against ONE known fall, these hold the
// rate with the lever (ratio 1.0) on either side of it, and take the fall as a
// single step: the same mechanism, isolated.

const SIMPLE3 = "createSimpleDataStream(string,address,uint24)";
const net = (x) => x - (x * 500n) / 10000n;
const SHARE = 9999n;
const part = (residual) => (residual * SHARE) / 10000n;

function leafOf(addr, amount) {
  const inner = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [addr, amount])
  );
  return ethers.keccak256(inner);
}

async function deployWired() {
  const fix = await deploySatoriFixtureNoFee();
  await fix.hub.connect(fix.owner).setSatoriMerkle(await fix.merkle.getAddress());
  await fix.merkle.connect(fix.owner).setSatoriCore(await fix.hub.getAddress());
  return fix;
}

async function streamIdFrom(tx, satori) {
  const r = await tx.wait();
  const ev = r.logs.find((l) => {
    try { return satori.interface.parseLog(l)?.name === "DataStreamCreated"; }
    catch { return false; }
  });
  return satori.interface.parseLog(ev).args.streamId;
}

const TRIGGERS = [
  { name: "issuance past the first threshold", ratio: null },
  { name: "an admin ratio cut applied by the next step", ratio: ONE / 10n },
];

describe("Decay audit — rate falls under a standing share", function () {
  this.timeout(600000);
  let fix, satori, hub, rewards, merkle, token, rw, bps;
  let owner, alice, bob, publisher;

  beforeEach(async function () {
    fix = await loadFixture(deployWired);
    ({ satori, hub, rewards, merkle, token, owner } = fix);
    [, alice, bob] = fix.signers;
    publisher = fix.merklePublisher;
    bps = await token.devFeeBps();
    rw = await rewardsSigner(rewards);
  });

  const residualOf = (rate) => rate - (rate * bps) / 10000n;

  /** The token's books: everything reported fits the envelope, the lanes' mints match the token's, and each lane stays inside the bound the hub enforces on it. */
  async function expectBooksHold() {
    const general = await token.generalAccrued();
    const reserve = await hub.merkleReserveCumulative();
    expect(general + (await token.devFeeAccrued())).to.be.lte(await token.rewardCeiling());
    expect((await hub.onChainMinted()) + (await hub.merkleMinted())).to.equal(await token.generalMinted());
    expect(await token.generalMinted()).to.be.lte(general);
    expect(general - reserve, "noteIssued's bound").to.be.lte(await hub.onChainAllowance());
    expect((await hub.onChainMinted()) + reserve, "rewardMint's on-chain bound").to.be.lte(general);
    expect(await hub.merkleMinted(), "rewardMint's merkle bound").to.be.lte(reserve);
  }

  /** Holds the rate, so the next round's is this one's. */
  async function holdRate() {
    await hub.connect(owner).setEmissionRatio(ONE);
    await advanceRound();
    const rate = await hub.emissionRateNow();
    expect(await hub.emissionRateNext()).to.equal(rate);
    return rate;
  }

  /** Banks through this round, then takes exactly one step at `ratio` and holds again. */
  async function oneFall(ratio) {
    await hub.syncEmission();
    await hub.connect(owner).setEmissionRatio(ratio);   // leaving 1.0 re-bases one round's worth out
    const steps = (await hub.emission()).stepsTaken;
    await issueTo(hub, token, rw, (await hub.emission()).nextStepAt);
    expect((await hub.emission()).stepsTaken).to.equal(steps + 1n);
    await hub.connect(owner).setEmissionRatio(ONE);
  }

  /** Sets the deepest share, then makes the rate fall three rounds later, in round x. */
  async function maxShareThenFall(trigger) {
    const rate0 = await holdRate();
    const residual0 = residualOf(rate0);
    const r = await currentRound(token);
    await rewards.connect(owner).setOffchainShareBps(SHARE);   // prices round r at the old share
    const allowanceAtR = await hub.onChainAllowance();
    await atRound(token, r + 3n);
    const x = await currentRound(token);
    await oneFall(trigger.ratio ?? DEFAULT_RATIO);
    const rate1 = stepRate(rate0, trigger.ratio ?? DEFAULT_RATIO);
    expect(await hub.emissionRateNext()).to.equal(rate1);
    const residual1 = residualOf(rate1);
    // What the schedule pays the general lanes over the share's rounds (r, cur].
    const scheduleResidual = (cur) => residual0 * (x - r) + residual1 * (cur - x);
    return { r, x, residual0, residual1, allowanceAtR, scheduleResidual };
  }

  for (const trigger of TRIGGERS) {
    describe(`triggered by ${trigger.name}`, function () {
      it("the merkle reserve follows the new residual and the two lanes sum to the schedule's residual", async function () {
        const { r, x, residual0, residual1, allowanceAtR, scheduleResidual } = await maxShareThenFall(trigger);
        await atRound(token, x + 40n);
        const cur = await currentRound(token);
        const owed = scheduleResidual(cur);

        // An amount fixed at the old residual would have banked past the schedule: the scenario is real.
        const fixed = part(residual0) * (cur - r);
        expect(fixed, "a fixed amount must actually overrun").to.be.gt(owed);

        const expected = part(residual0) * (x - r) + part(residual1) * (cur - x);
        expect(await hub.merkleReserveCeiling()).to.equal(expected);

        // Pricing the round banks the reserve the projection showed, and prices
        // the untouched rounds at the new residual's on-chain part.
        await hub.connect(rw).freezeRoundGross(cur);
        expect(await hub.merkleReserveCumulative()).to.equal(expected);
        expect(await hub.onChainGrossNow()).to.equal(residual1 - part(residual1));
        const allowanceGrowth = (await hub.onChainAllowance()) - allowanceAtR;
        // freezeRoundGross prices every round untouched since r at the gross live
        // now, so the pre-step rounds (r, x] get the post-step on-chain room while
        // their reserve banked at the pre-step residual. The on-chain lane is
        // short by exactly that, never over: nobody was credited in those rounds.
        const gross0 = residual0 - part(residual0);
        const gross1 = residual1 - part(residual1);
        expect(allowanceGrowth).to.equal(gross1 * (cur - r));
        expect(allowanceGrowth + expected, "reserve + on-chain room, short only by the late pricing")
          .to.equal(owed - (gross0 - gross1) * (x - r));
        expect(allowanceGrowth + expected).to.be.lte(owed);
        expect(expected).to.be.lte((await token.generalAccrued()) - (await hub.onChainMinted()));
        await expectBooksHold();
      });

      it("a merkle claim after the fall pays only the reserve the share banked", async function () {
        const { r, x, residual0, residual1, scheduleResidual } = await maxShareThenFall(trigger);
        await atRound(token, x + 40n);
        const cur = await currentRound(token);
        const huge = (await hub.emissionCeiling()) * 10n;
        await merkle.connect(publisher).setMerkleRoot(leafOf(alice.address, huge));
        await merkle.connect(alice).claimMerkle(huge, []);

        const expected = part(residual0) * (x - r) + part(residual1) * (cur - x);
        expect(await hub.merkleMinted()).to.equal(expected);
        expect(await hub.merkleMinted()).to.equal(await hub.merkleReserveCumulative());
        expect(await token.balanceOf(alice.address)).to.equal(expected);
        expect(expected).to.be.lt(scheduleResidual(cur));
        await expectBooksHold();
        // The token's envelope alone would have let a fixed amount through: the share is what holds.
        const stale = part(residual0) * (cur - r);
        const room = (await token.rewardCeiling()) - (await token.generalAccrued()) - (await token.devFeeAccrued());
        expect(room).to.be.gte(grossUp(stale - expected, bps));
      });

      it("the share stays legal when the residual falls, and can still be changed", async function () {
        const { x, residual1 } = await maxShareThenFall(trigger);
        await atRound(token, x + 40n);
        expect(residualOf(await hub.emissionRateNow())).to.equal(residual1);
        expect(await rewards.offchainShareBps()).to.equal(SHARE);
        await expect(rewards.connect(owner).setOffchainShareBps(0n)).to.not.be.reverted;
      });
    });
  }

  it("after an automatic step under the deepest share: both lanes split the new residual, pre-step credit still claims", async function () {
    await satori.transfer(alice.address, ethers.parseEther("100"));
    await satori.transfer(bob.address, ethers.parseEther("100"));
    const rate0 = await holdRate();
    const registry = fix.registry;
    const sid = await streamIdFrom(await satori[SIMPLE3]("S", owner.address, 1440), satori);

    // Round R0: alice predicts at share 0; the deepest share lands from R0+1.
    await registry.setValue(sid, 100);
    await voteFor(satori, alice, sid);
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: sid, payload: pack1(1) }]);
    const residual0 = residualOf(await hub.emissionRateNow());
    await rewards.connect(owner).setOffchainShareBps(SHARE);

    await advanceRound();
    await registry.setValue(sid, 110);
    await advanceRound();
    await registry.setValue(sid, 120);
    await satori.settlePrediction(alice.address, sid);
    const earned = await rewards.unclaimedRewards(alice.address);
    expect(earned).to.equal(net(residual0));

    await oneFall(DEFAULT_RATIO); // the step lands under the deepest share
    const residual1 = residualOf(stepRate(rate0, DEFAULT_RATIO));
    await advanceRound();
    expect(residualOf(await hub.emissionRateNow())).to.equal(residual1);

    await registry.setValue(sid, 130);
    await voteFor(satori, bob, sid);
    await satori.connect(bob).predictMultipleWithPayloads([{ gameId: sid, payload: pack1(1) }]);
    const m0 = await hub.merkleReserveCeiling();
    await advanceRound();
    await registry.setValue(sid, 140);
    const m1 = await hub.merkleReserveCeiling();
    expect(m1 - m0, "reserve accrues the share of the new residual").to.equal(part(residual1));
    await advanceRound();
    await registry.setValue(sid, 150);
    await satori.settlePrediction(bob.address, sid);
    expect(await rewards.unclaimedRewards(bob.address), "on-chain gross is the rest of the new residual")
      .to.equal(net(residual1 - part(residual1)));

    for (let i = 0; i < 10; i++) await advanceRound();
    const bal = await token.balanceOf(alice.address);
    await expect(satori.connect(alice)["claim()"]()).to.not.be.reverted;
    expect(await token.balanceOf(alice.address)).to.equal(bal + earned);
  });
});
