// Delegation without loyalty: a delegate's delegator pot is divided pro rata to
// the delegators' capital, nothing evaporates, and the read model can rebuild
// every payout from `RewardSplit` and `DelegatorRateAccrued`. Also pins the
// batch-pinned own power (M13) and the claim walk's checkpoint handling (M14).

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixtureNoFee, pack1, VOTE } = require("../fixtures");

const UP = 1;
const SIMPLE3 = "createSimpleDataStream(string,address,uint24)";
const RATE_SCALE = 10n ** 24n; // SatoriRewards.SATORI_RATE_SCALE
const E = (n) => ethers.parseEther(String(n));

async function advanceRound() {
  const now = await time.latest();
  await time.increaseTo(Math.floor(now / 86400) * 86400 + 86400 + 1);
}

function events(rcpt, iface, name) {
  const out = [];
  for (const l of rcpt.logs) {
    try {
      const p = iface.parseLog(l);
      if (p && p.name === name) out.push(p.args);
    } catch (e) {}
  }
  return out;
}

describe("Delegation without loyalty: the pro-rata delegator pot", function () {
  this.timeout(1200000);
  let satori, rewards, registry, lens, owner, alice, bob, carol, dave, voter;

  async function newGame(name) {
    const rc = await (await satori.connect(owner)[SIMPLE3](name, owner.address, 1440)).wait();
    const sid = events(rc, registry.interface, "DataStreamCreated")[0].streamId;
    await satori.connect(voter).vote(sid, VOTE);
    return sid;
  }

  beforeEach(async function () {
    const fix = await deploySatoriFixtureNoFee();
    ({ satori, rewards, registry, lens } = fix);
    [owner, alice, bob, carol, dave, , , voter] = fix.signers;
    for (const [u, n] of [[alice, 100], [bob, 100], [carol, 300], [dave, 100], [voter, 100]]) {
      await satori.transfer(u.address, E(n));
    }
    await advanceRound();
  });

  it("pays two unequal delegators pro rata to capital on their very first round, nothing evaporating", async function () {
    const sid = await newGame("S");
    await registry.connect(owner).setValue(sid, 100);
    await satori.connect(alice).delegatePredictionPower(bob.address); // 100
    await satori.connect(carol).delegatePredictionPower(bob.address); // 300

    await satori.connect(bob).predictMultipleWithPayloads([{ gameId: sid, payload: pack1(UP) }]);
    await advanceRound();
    await registry.connect(owner).setValue(sid, 110);
    await advanceRound();
    await registry.connect(owner).setValue(sid, 120);
    const rc = await (await satori.settlePrediction(bob.address, sid)).wait();

    const split = events(rc, rewards.interface, "RewardSplit")[0];
    const rate = events(rc, rewards.interface, "DelegatorRateAccrued")[0];
    const pot = split.delegatorAmount;
    expect(pot, "the delegators' pot is paid on a first win").to.be.gt(0n);

    // The rate event carries the denominator and what it added.
    expect(rate.delegate).to.equal(bob.address);
    expect(rate.gameId).to.equal(sid);
    expect(rate.round).to.equal(split.round);
    expect(rate.delegatedPower).to.equal(E(400));
    expect(rate.rateAdded).to.equal((pot * RATE_SCALE) / E(400));
    expect(await rewards.delegatorRewardRatePerRound(bob.address, split.round)).to.equal(rate.rateAdded);
  });

  it("each delegator is credited capital x rate, and the credits sum to the pot within rounding", async function () {
    const sid = await newGame("S");
    await registry.connect(owner).setValue(sid, 100);
    await satori.connect(alice).delegatePredictionPower(bob.address); // 100
    await satori.connect(carol).delegatePredictionPower(bob.address); // 300
    await satori.connect(bob).predictMultipleWithPayloads([{ gameId: sid, payload: pack1(UP) }]);
    await advanceRound();
    await registry.connect(owner).setValue(sid, 110);
    await advanceRound();
    await registry.connect(owner).setValue(sid, 120);
    const settle = await (await satori.settlePrediction(bob.address, sid)).wait();
    const split = events(settle, rewards.interface, "RewardSplit")[0];
    const { rateAdded } = events(settle, rewards.interface, "DelegatorRateAccrued")[0];
    await advanceRound();

    // Undelegate first: a delegated wallet cannot claim.
    await satori.connect(alice).delegatePredictionPower(ethers.ZeroAddress);
    await satori.connect(carol).delegatePredictionPower(ethers.ZeroAddress);
    await advanceRound();
    const aliceRc = await (await satori.connect(alice)["claim()"]()).wait();
    const carolRc = await (await satori.connect(carol)["claim()"]()).wait();
    const a = events(aliceRc, rewards.interface, "DelegatorRewardsAccrued")[0].amount;
    const c = events(carolRc, rewards.interface, "DelegatorRewardsAccrued")[0].amount;

    expect(a).to.equal((E(100) * rateAdded) / RATE_SCALE);
    expect(c).to.equal((E(300) * rateAdded) / RATE_SCALE);
    expect(c).to.be.closeTo(a * 3n, 3n);
    const pot = split.delegatorAmount;
    expect(a + c).to.be.lte(pot);
    expect(pot - (a + c), "only rounding is left unpaid").to.be.lt(400n);
  });

  it("a prediction's own-power snapshot is pinned once per batch (M13)", async function () {
    const g1 = await newGame("G1");
    const g2 = await newGame("G2");
    await registry.connect(owner).setValue(g1, 100);
    await registry.connect(owner).setValue(g2, 100);
    await satori.connect(alice).delegatePredictionPower(bob.address);

    const batch = [{ gameId: g1, payload: pack1(UP) }, { gameId: g2, payload: pack1(UP) }];
    await satori.connect(bob).predictMultipleWithPayloads(batch);
    await advanceRound();
    for (const g of [g1, g2]) await registry.connect(owner).setValue(g, 110);
    await advanceRound();
    for (const g of [g1, g2]) await registry.connect(owner).setValue(g, 120);

    // The next batch settles g1's winner (crediting bob) before it commits g2.
    // Both snapshots must carry the power bob had when the batch started.
    const before = (await satori.balanceOf(bob.address)) + (await rewards.unclaimedRewards(bob.address));
    const rc = await (await satori.connect(bob).predictMultipleWithPayloads(batch)).wait();
    expect(events(rc, rewards.interface, "RewardSplit").length, "a win was credited inside the batch").to.be.gt(0n);
    const round = await satori.getCurrentRound();
    const own1 = (await rewards.predictionDelegationInfo(bob.address, g1, round)).ownPower;
    const own2 = (await rewards.predictionDelegationInfo(bob.address, g2, round)).ownPower;
    expect(own1).to.equal(before);
    expect(own2).to.equal(before);
  });

  it("a zero-value transfer to a delegated wallet writes no checkpoint (M14)", async function () {
    await satori.connect(alice).delegatePredictionPower(bob.address);
    const len = async () => (await rewards.delegationPeriodAt(alice.address, 0)).checkpointsLength;
    const before = await len();
    await satori.connect(bob).transfer(alice.address, 0);
    expect(await len()).to.equal(before);
    await satori.connect(bob).transfer(alice.address, 1);
    expect(await len()).to.equal(before + 1n);
  });

  it("a claim over a long checkpoint history stays cheap, and matches the lens (M14)", async function () {
    const sid = await newGame("S");
    await satori.connect(alice).delegatePredictionPower(bob.address);
    const ROUNDS = 60;
    let v = 100;
    for (let k = 0; k < ROUNDS; k++) {
      await advanceRound();
      v += 10;
      await registry.connect(owner).setValue(sid, v);
      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: sid, payload: pack1(UP) }]);
      // One receipt a round gives alice one checkpoint a round.
      await satori.connect(dave).transfer(alice.address, 1);
    }
    await advanceRound(); v += 10; await registry.connect(owner).setValue(sid, v);
    await satori.settlePrediction(bob.address, sid);
    await advanceRound(); v += 10; await registry.connect(owner).setValue(sid, v);
    await satori.settlePrediction(bob.address, sid);
    await advanceRound();

    const period = await rewards.delegationPeriodAt(alice.address, 0);
    expect(period.checkpointsLength, "one checkpoint per round").to.be.gte(ROUNDS - 2);

    const [pending] = await lens.pendingDelegatorRewards(alice.address);
    await satori.connect(alice).delegatePredictionPower(ethers.ZeroAddress);
    await advanceRound();
    const rc = await (await satori.connect(alice)["claim()"]()).wait();
    const accrued = events(rc, rewards.interface, "DelegatorRewardsAccrued")[0].amount;
    expect(accrued).to.be.gt(0n);
    expect(pending).to.equal(accrued);
    console.log("      claim over", ROUNDS, "rounds and checkpoints used", rc.gasUsed.toString(), "gas");
    expect(rc.gasUsed).to.be.lt(2_500_000n);
  });
});
