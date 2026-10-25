const { expect } = require("chai");
const { deploySatoriFixtureNoFee, pack1, voteFor } = require("../fixtures");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { T0, rewardsSigner, issueTo } = require("./emissionHelpers");

// The off-chain dial (offchainBudget / merkle reserve rate) takes effect from the
// NEXT round, uniformly on BOTH lanes: the on-chain gross is frozen at the OLD dial
// for the in-flight round (SatoriRewards.setOffchainBudget) and the merkle reserve
// carries the OLD rate through the in-flight round (SatoriHub.setMerkleReserveRate).
// This closes the dial/merkle desync (docs/issues/closed/dial-merkle-reserve-desync-mid-round-change.md):
// both lanes read the same dial for every round, so a round can never be
// over-subscribed by a mid-round dial change (no BudgetExceeded on a legit claim).

const UP = 1;
// The 4-arg overload carried the per-stream value-provider cut bps; providers
// are no longer paid at all, so the parameter (and the overload) are gone.
const SIMPLE3 = "createSimpleDataStream(string,address,uint24)";
const E = (n) => ethers.parseEther(String(n));

async function advanceRound() {
  const t = await time.latest();
  await time.increaseTo(Math.floor(t / 86400) * 86400 + 86400 + 1);
}

async function streamIdFrom(tx, satori) {
  const r = await tx.wait();
  const ev = r.logs.find((l) => {
    try { return satori.interface.parseLog(l)?.name === "DataStreamCreated"; }
    catch { return false; }
  });
  return satori.interface.parseLog(ev).args.streamId;
}

describe("Dial takes effect NEXT round (dial/merkle sync)", function () {
  let satori, rewards, registry, lens, hub, token;
  let owner, alice, bob;

  beforeEach(async function () {
    const fix = await deploySatoriFixtureNoFee();
    ({ satori, rewards, registry, lens, hub, token } = fix);
    owner = fix.owner;
    alice = fix.signers[1];
    bob = fix.signers[2];
    await satori.transfer(alice.address, E(100));
    await satori.transfer(bob.address, E(100));
    await advanceRound(); // leave the genesis round
  });

  it("on-chain gross: a dial set mid-round applies from the NEXT round, not the current one", async function () {
    // The first-predictor liveness bonus (the old, cheap probe of a round's gross)
    // is gone, so the gross is now read where it actually lands: a round's ONLY
    // predictor of its ONLY predicted game takes the whole payable budget. The
    // predictor keeps 95% of it — the 5% referral cut goes to the marketing
    // recipient when the predictor has no referrer.
    //
    // Round R: the dial is still 0 → gross == the whole RESIDUAL (the hub's
    // emission net of the senior dev fee). Set the dial mid-round; R must keep
    // the OLD gross.
    //
    // Every figure here is DERIVED. This file was written around 1152 / 720 /
    // 1094.4 / 684, which were 1440 − 288 and a 432 dial against it; the
    // emission is the hub's decaying schedule now, so those are the wrong
    // numbers and would be wrong again at the next rate change.
    const residual = (await satori.emissionRateNow()) - (await satori.devRateNow());
    const dial = residual - residual / 2n;   // leaves half the residual on-chain
    const grossAfter = residual - dial;
    const net = (x) => x - (x * 500n) / 10000n; // the 5% referral skim
    await rewards.connect(owner).setOffchainBudget(dial); // would shrink R's gross if it applied NOW
    const sid = await streamIdFrom(await satori[SIMPLE3]("S", owner.address, 1440), satori);
    await registry.setValue(sid, 100);
    await voteFor(satori, alice, sid);
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: sid, payload: pack1(UP) }]);

    // sid is the only game predicted in R, so it owns R's whole denominator and
    // alice — R's only predictor — takes R's entire payable budget.

    // R+1, the VERY NEXT round: the dial must be in effect here, so this
    // round's gross is `grossAfter`. bob is R+1's only predictor and sid2 is R+1's only
    // predicted game, so bob takes R+1's entire payable budget. Predicting in the
    // immediately-following round is what makes this an off-by-one detector: a
    // dial that applied a round late would pay bob the FULL residual.
    await advanceRound();
    await registry.setValue(sid, 150);
    const sid2 = await streamIdFrom(await satori[SIMPLE3]("T", owner.address, 1440), satori);
    await registry.setValue(sid2, 100);
    await voteFor(satori, bob, sid2);
    await satori.connect(bob).predictMultipleWithPayloads([{ gameId: sid2, payload: pack1(UP) }]);

    // R+2: alice's round-R prediction resolves against the OLD dial (0), so she
    // takes the whole residual net of the 5% referral cut (which goes to the
    // marketing recipient when the predictor has no referrer).
    await advanceRound();
    await registry.setValue(sid, 200);
    await registry.setValue(sid2, 150);
    await satori.settlePrediction(alice.address, sid);
    expect((await lens.getTotalClaimableRewards(alice.address))[0]).to.equal(net(residual));

    // R+3: bob's round-(R+1) prediction resolves against the NEW dial.
    await advanceRound();
    await registry.setValue(sid2, 200);
    await satori.settlePrediction(bob.address, sid2);
    expect((await lens.getTotalClaimableRewards(bob.address))[0]).to.equal(net(grossAfter));
    // ...and it is genuinely the SHRUNK figure, not the unshrunk one a
    // round-late dial would have paid.
    expect(net(grossAfter)).to.be.lt(net(residual));
  });

  it("merkle reserve: a dial set mid-round reserves NOTHING for the in-flight round", async function () {
    // The genesis-style over-reserve was: set dial in round R → merkle carried the new
    // rate for R while on-chain used the old dial → onChain + merkle > residual for R.
    await rewards.connect(owner).setOffchainBudget(E(200)); // round R
    expect(await hub.merkleReserveCeiling()).to.equal(0n);   // R: still the old dial (0)
    await hub.syncEmission();                                // a later bank in R adds nothing for R
    expect(await hub.merkleReserveCumulative()).to.equal(0n);
    expect(await hub.merkleReserveCeiling()).to.equal(0n);

    await advanceRound();                                    // R+1: reserved from the round's start
    expect(await hub.merkleReserveCeiling()).to.equal(E(200));

    await advanceRound();                                    // R+2: R+1 and R+2, never R
    expect(await hub.merkleReserveCeiling()).to.equal(E(400));
  });

  it("conservation holds across a dial change: each round's on-chain gross plus its reserve is the round's residual", async function () {
    const residual = (await hub.emissionRateNow()) - (await hub.devRateNow());
    const dial = E(200);
    const sid = await streamIdFrom(await satori[SIMPLE3]("S", owner.address, 1440), satori);
    // No credit is reported in this test: the general grows by exactly the
    // reserve banked, so the on-chain lane's ceiling must not move.
    const general0 = await token.generalAccrued();
    const onChain0 = await lens.onChainRewardCeiling();
    const onlyReserveReported = async (label) => {
      const reserve = await hub.merkleReserveCumulative();
      const general = await token.generalAccrued();
      expect(general, label).to.equal(general0 + reserve);
      expect(general - reserve, label).to.be.lte(await hub.onChainAllowance());
    };

    // R: the change freezes R (and any untouched round before it) at the OLD dial.
    const priced0 = await hub.onChainPricedRound();
    const allowance0 = await hub.onChainAllowance();
    const R = await token.getCurrentRound();
    expect(priced0).to.be.lt(R);
    await rewards.connect(owner).setOffchainBudget(dial);
    expect(await hub.onChainPricedRound()).to.equal(R);
    expect((await hub.onChainAllowance()) - allowance0).to.equal(residual * (R - priced0));
    expect(await hub.merkleReserveCumulative()).to.equal(0n);
    await onlyReserveReported("R");

    // R+1 and R+2: each first touch (a stream value write) prices the round at
    // the NEW dial and banks the same dial as reserve.
    for (let i = 1n; i <= 2n; i++) {
      await advanceRound();
      const a = await hub.onChainAllowance();
      const c = await hub.merkleReserveCumulative();
      await registry.setValue(sid, 100n + i);
      expect(await hub.onChainPricedRound()).to.equal(R + i);
      const gross = (await hub.onChainAllowance()) - a;
      const reserve = (await hub.merkleReserveCumulative()) - c;
      expect(gross, `R+${i} gross`).to.equal(residual - dial);
      expect(reserve, `R+${i} reserve`).to.equal(dial);
      expect(gross + reserve, `R+${i}`).to.equal(residual);
      await onlyReserveReported(`R+${i}`);
    }
    expect(await lens.onChainRewardCeiling()).to.equal(onChain0);
  });

  it("with a lower rate pending for R+1, both dial bounds check R+1's residual", async function () {
    const residualNow = (await satori.emissionRateNow()) - (await satori.devRateNow());
    await issueTo(hub, token, await rewardsSigner(rewards), T0);
    const residualNext = await hub.residualNext();
    expect(residualNext).to.be.lt(residualNow);

    // Legal against R's residual, but R+1 is the first round it would apply to.
    await expect(rewards.connect(owner).setOffchainBudget(residualNow - 1n))
      .to.be.revertedWithCustomError(rewards, "BadInput");
    await expect(rewards.connect(owner).setOffchainBudget(residualNext))
      .to.be.revertedWithCustomError(rewards, "BadInput");
    await expect(rewards.connect(owner).setOffchainBudget(residualNext - 1n)).to.not.be.reverted;
    expect(await rewards.offchainBudget()).to.equal(residualNext - 1n);
  });
});
