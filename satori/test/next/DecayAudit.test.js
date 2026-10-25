const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixtureNoFee, pack1, voteFor } = require("../fixtures");
const {
  ONE, BASE, PHI_INV, T0, stepRate, grossUp, rewardsSigner, issueTo,
  currentRound, atRound, advanceRound,
} = require("./emissionHelpers");

// A bound checked when a value is SET does not stay true once the rate falls
// under it. The rate falls by issuance (an automatic step) or by an admin
// ratio cut that the next step applies; either can land under a dial that was
// legal against the old residual. Each test pins one site that must survive.

const SIMPLE3 = "createSimpleDataStream(string,address,uint24)";
const net = (x) => x - (x * 500n) / 10000n;

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

describe("Decay audit — rate falls under a standing dial", function () {
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

  /** Sets the deepest dial legal now, then makes the rate fall three rounds later, in round x. */
  async function maxDialThenFall(trigger) {
    await advanceRound();
    const residual0 = residualOf(await hub.emissionRateNow());
    const r = await currentRound(token);
    await rewards.connect(owner).setOffchainBudget(residual0 - 1n);   // prices round r at the old dial
    const allowanceAtR = await hub.onChainAllowance();
    if (trigger.ratio !== null) await hub.connect(owner).setEmissionRatio(trigger.ratio);
    await atRound(token, r + 3n);
    const x = await currentRound(token);
    await issueTo(hub, token, rw, T0);
    const rate1 = stepRate(BASE, trigger.ratio ?? PHI_INV);
    expect(await hub.emissionRateNext()).to.equal(rate1);
    const residual1 = residualOf(rate1);
    // What the schedule pays the general lanes over the dial's rounds (r, cur].
    const scheduleResidual = (cur) => residual0 * (x - r) + residual1 * (cur - x);
    return { r, x, residual0, residual1, allowanceAtR, scheduleResidual };
  }

  for (const trigger of TRIGGERS) {
    describe(`triggered by ${trigger.name}`, function () {
      it("the merkle reserve yields to the new residual and the two lanes sum to the schedule's residual", async function () {
        const { r, x, residual0, residual1, allowanceAtR, scheduleResidual } = await maxDialThenFall(trigger);
        await atRound(token, x + 40n);
        const cur = await currentRound(token);
        const owed = scheduleResidual(cur);

        // The old dial kept running would have banked past the residual: the scenario is real.
        const unyielded = (residual0 - 1n) * (cur - r);
        expect(unyielded, "the stale dial must actually overrun").to.be.gt(owed);

        const expected = (residual0 - 1n) * (x - r) + (residual1 - 1n) * (cur - x);
        expect(await hub.merkleReserveCeiling()).to.equal(expected);

        // Pricing the round banks the reserve the projection showed, and prices
        // the untouched rounds at the 1-wei gross the yield leaves the on-chain lane.
        await hub.connect(rw).freezeRoundGross(cur);
        expect(await hub.merkleReserveCumulative()).to.equal(expected);
        expect(await hub.onChainGrossNow()).to.equal(1n);
        const allowanceGrowth = (await hub.onChainAllowance()) - allowanceAtR;
        expect(allowanceGrowth + expected, "reserve + on-chain room == residual, round by round").to.equal(owed);
        expect(expected).to.be.lte((await token.generalAccrued()) - (await hub.onChainMinted()));
        await expectBooksHold();
      });

      it("a merkle claim on a stale dial pays only the yielded reserve", async function () {
        const { r, x, residual0, residual1, scheduleResidual } = await maxDialThenFall(trigger);
        await atRound(token, x + 40n);
        const cur = await currentRound(token);
        const huge = (await hub.emissionCeiling()) * 10n;
        await merkle.connect(publisher).setMerkleRoot(leafOf(alice.address, huge));
        await merkle.connect(alice).claimMerkle(huge, []);

        const expected = (residual0 - 1n) * (x - r) + (residual1 - 1n) * (cur - x);
        expect(await hub.merkleMinted()).to.equal(expected);
        expect(await hub.merkleMinted()).to.equal(await hub.merkleReserveCumulative());
        expect(await token.balanceOf(alice.address)).to.equal(expected);
        expect(expected).to.be.lt(scheduleResidual(cur));
        await expectBooksHold();
        // The token's envelope alone would have let the stale dial through: the yield is what holds.
        const stale = (residual0 - 1n) * (cur - r);
        const room = (await token.rewardCeiling()) - (await token.generalAccrued()) - (await token.devFeeAccrued());
        expect(room).to.be.gte(grossUp(stale - expected, bps));
      });

      it("the on-chain dial yields instead of reverting when the residual falls under it", async function () {
        const { x } = await maxDialThenFall(trigger);
        await atRound(token, x + 40n);
        const shrunk = residualOf(await hub.emissionRateNow());
        expect(await rewards.offchainBudget()).to.be.gt(shrunk);
        await expect(rewards.connect(owner).setOffchainBudget(0n)).to.not.be.reverted;
      });
    });
  }

  it("a fee raise under a standing dial never shrinks the banked reserve, and all of it still claims", async function () {
    await advanceRound();
    await rewards.connect(owner).setOffchainBudget(residualOf(await hub.emissionRateNow()) - 1n);
    await atRound(token, (await token.deploymentRound()) + 30n);   // the fee dial's gap counts from genesis
    await hub.syncEmission();
    const banked = await hub.merkleReserveCumulative();
    const feeBooked = await token.devFeeAccrued();
    await token.connect(owner).proposeDevFeeBps(2500);
    await token.connect(owner).acceptDevFeeBps();
    expect(await token.devFeeAccrued(), "the raise rebooks nothing already reported").to.equal(feeBooked);
    expect(await hub.merkleReserveCumulative()).to.equal(banked);
    bps = await token.devFeeBps();
    await advanceRound();

    const rc = await (await hub.syncEmission()).wait();
    const logged = rc.logs.filter((l) => l.address === hub.target)
      .map((l) => { try { return hub.interface.parseLog(l); } catch { return null; } })
      .filter((p) => p && p.name === "MerkleReserveBanked");
    const grown = banked + residualOf(await hub.emissionRateNow()) - 1n;   // yields to the new residual
    expect(logged.length).to.equal(1);
    expect(logged[0].args.throughRoundExclusive).to.equal((await currentRound(token)) + 1n);
    expect(logged[0].args.cumulative).to.equal(grown);
    expect(await hub.merkleReserveCumulative()).to.equal(grown);
    await expectBooksHold();

    const huge = (await hub.emissionCeiling()) * 10n;
    await merkle.connect(publisher).setMerkleRoot(leafOf(alice.address, huge));
    await merkle.connect(alice).claimMerkle(huge, []);
    expect(await token.balanceOf(alice.address)).to.equal(grown);
    await expectBooksHold();
  });

  it("after an automatic step under a max dial: reserve takes residual-1, on-chain gross is 1 wei, pre-step credit still claims", async function () {
    await satori.transfer(alice.address, ethers.parseEther("100"));
    await satori.transfer(bob.address, ethers.parseEther("100"));
    await advanceRound();
    const registry = fix.registry;
    const sid = await streamIdFrom(await satori[SIMPLE3]("S", owner.address, 1440), satori);

    // Round R0: alice predicts at dial 0; the max dial lands from R0+1.
    await registry.setValue(sid, 100);
    await voteFor(satori, alice, sid);
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: sid, payload: pack1(1) }]);
    const residual0 = residualOf(await hub.emissionRateNow());
    await rewards.connect(owner).setOffchainBudget(residual0 - 1n);

    await advanceRound();
    await registry.setValue(sid, 110);
    await advanceRound();
    await registry.setValue(sid, 120);
    await satori.settlePrediction(alice.address, sid);
    const earned = await rewards.unclaimedRewards(alice.address);
    expect(earned).to.equal(net(residual0));

    await issueTo(hub, token, rw, T0); // the step lands under the max dial
    const residual1 = residualOf(stepRate(BASE, PHI_INV));
    await advanceRound();
    expect(residualOf(await hub.emissionRateNow())).to.equal(residual1);

    await registry.setValue(sid, 130);
    await voteFor(satori, bob, sid);
    await satori.connect(bob).predictMultipleWithPayloads([{ gameId: sid, payload: pack1(1) }]);
    const m0 = await hub.merkleReserveCeiling();
    await advanceRound();
    await registry.setValue(sid, 140);
    const m1 = await hub.merkleReserveCeiling();
    expect(m1 - m0, "reserve accrues residual-1 per round").to.equal(residual1 - 1n);
    await advanceRound();
    await registry.setValue(sid, 150);
    await satori.settlePrediction(bob.address, sid);
    expect(await rewards.unclaimedRewards(bob.address), "on-chain gross yields to 1 wei").to.equal(1n);

    for (let i = 0; i < 10; i++) await advanceRound();
    const bal = await token.balanceOf(alice.address);
    await expect(satori.connect(alice)["claim()"]()).to.not.be.reverted;
    expect(await token.balanceOf(alice.address)).to.equal(bal + earned);
  });
});
