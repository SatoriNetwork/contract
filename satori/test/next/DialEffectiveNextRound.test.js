const { expect } = require("chai");
const { deploySatoriFixtureNoFee, pack1, voteFor } = require("../fixtures");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { T0, rewardsSigner, issueTo } = require("./emissionHelpers");

// The off-chain share (offchainShareBps / the hub's merkle reserve bps) takes
// effect from the NEXT round, uniformly on BOTH lanes: the on-chain gross is frozen
// at the OLD share for the in-flight round (SatoriRewards.setOffchainShareBps) and
// the merkle reserve carries the OLD share through the in-flight round
// (SatoriHub.setMerkleReserveBps).
// This closes the dial/merkle desync (docs/issues/closed/dial-merkle-reserve-desync-mid-round-change.md):
// both lanes read the same dial for every round, so a round can never be
// over-subscribed by a mid-round dial change (no BudgetExceeded on a legit claim).

const UP = 1;
// The 4-arg overload carried the per-stream value-provider cut bps; providers
// are no longer paid at all, so the parameter (and the overload) are gone.
const SIMPLE3 = "createSimpleDataStream(string,address,uint24)";
const E = (n) => ethers.parseEther(String(n));
const SHARE = 5000n;
const part = (residual, bps) => residual * bps / 10000n;

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
    // Each round's own rate: the schedule steps every round's worth issued, so
    // R+1's residual is read in R+1, not carried from R.
    const residualNow = async () => (await satori.emissionRateNow()) - (await satori.devRateNow());
    const residual = await residualNow();
    const net = (x) => x - (x * 500n) / 10000n; // the 5% referral skim
    await rewards.connect(owner).setOffchainShareBps(SHARE); // would shrink R's gross if it applied NOW
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
    const residual1 = await residualNow();
    const grossAfter = residual1 - part(residual1, SHARE); // half R+1's residual stays on-chain
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
    expect(net(grossAfter)).to.be.lt(net(residual1));
  });

  it("merkle reserve: a dial set mid-round reserves NOTHING for the in-flight round", async function () {
    // The genesis-style over-reserve was: set dial in round R → merkle carried the new
    // rate for R while on-chain used the old dial → onChain + merkle > residual for R.
    await rewards.connect(owner).setOffchainShareBps(SHARE); // round R
    const per = part(await hub.residualNext(), SHARE);       // read after the set: its banking may step
    expect(await hub.merkleReserveCeiling()).to.equal(0n);   // R: still the old share (0)
    await hub.syncEmission();                                // a later bank in R adds nothing for R
    expect(await hub.merkleReserveCumulative()).to.equal(0n);
    expect(await hub.merkleReserveCeiling()).to.equal(0n);

    await advanceRound();                                    // R+1: reserved from the round's start
    expect(await hub.merkleReserveCeiling()).to.equal(per);

    await advanceRound();                                    // R+2: R+1 and R+2, never R
    expect(await hub.merkleReserveCeiling()).to.equal(2n * per);
  });

  it("conservation holds across a dial change: each round's on-chain gross plus its reserve is the round's residual", async function () {
    const residual = (await hub.emissionRateNow()) - (await hub.devRateNow());
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
    await rewards.connect(owner).setOffchainShareBps(SHARE);
    expect(await hub.onChainPricedRound()).to.equal(R);
    expect((await hub.onChainAllowance()) - allowance0).to.equal(residual * (R - priced0));
    expect(await hub.merkleReserveCumulative()).to.equal(0n);
    await onlyReserveReported("R");

    // R+1 and R+2: each first touch (a stream value write) prices the round at
    // the NEW dial and banks the same dial as reserve.
    for (let i = 1n; i <= 2n; i++) {
      await advanceRound();
      const residualI = (await hub.emissionRateNow()) - (await hub.devRateNow());
      const dial = part(residualI, SHARE);
      const a = await hub.onChainAllowance();
      const c = await hub.merkleReserveCumulative();
      await registry.setValue(sid, 100n + i);
      expect(await hub.onChainPricedRound()).to.equal(R + i);
      const gross = (await hub.onChainAllowance()) - a;
      const reserve = (await hub.merkleReserveCumulative()) - c;
      expect(gross, `R+${i} gross`).to.equal(residualI - dial);
      expect(reserve, `R+${i} reserve`).to.equal(dial);
      expect(gross + reserve, `R+${i}`).to.equal(residualI);
      await onlyReserveReported(`R+${i}`);
    }
    expect(await lens.onChainRewardCeiling()).to.equal(onChain0);
  });

  it("with a lower rate pending for R+1, the share applies to R+1's residual", async function () {
    const residualNow = (await satori.emissionRateNow()) - (await satori.devRateNow());
    await issueTo(hub, token, await rewardsSigner(rewards), T0);
    const residualNext = await hub.residualNext();
    expect(residualNext).to.be.lt(residualNow);

    // The bound is the share itself, not a residual that can move under it.
    await expect(rewards.connect(owner).setOffchainShareBps(10000))
      .to.be.revertedWithCustomError(rewards, "BadInput");
    await expect(rewards.connect(owner).setOffchainShareBps(SHARE)).to.not.be.reverted;
    expect(await rewards.offchainShareBps()).to.equal(SHARE);
    await advanceRound();
    expect(await hub.merkleReserveCeiling() - (await hub.merkleReserveCumulative()))
      .to.equal(part(residualNext, SHARE));
  });
});
