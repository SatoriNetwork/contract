/**
 * Allowed delegator — RED tests.
 *
 * Spec: docs/design/allowed-delegator.md
 *
 * A predictor may nominate ONE address permitted to delegate to them.
 * address(0) (the default) means anyone may. The check runs at delegation time
 * only: nominating one never evicts anyone already delegated.
 *
 * The subtle one is `burnForVote`. It undelegates and re-delegates the caller
 * around the burn, so a grandfathered delegator whose predictor has since
 * excluded them must still be able to vote — otherwise the "never evicts"
 * promise is void in practice, since voting would force them out.
 */

const { expect } = require("chai");
const { deploySatoriFixtureNoFee, pack1, VOTE } = require("./fixtures");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const SIMPLE3 = "createSimpleDataStream(string,address,uint24)";

async function advanceRound() {
  const t = await time.latest();
  await time.increaseTo(Math.floor(t / 86400) * 86400 + 86400 + 1);
}

async function streamIdFrom(tx, satori) {
  const r = await tx.wait();
  const ev = r.logs.find(l => {
    try { return satori.interface.parseLog(l)?.name === "DataStreamCreated"; }
    catch { return false; }
  });
  return satori.interface.parseLog(ev).args.streamId;
}

describe("Allowed delegator", function () {
  let satori, hub, rewards, registry;
  let owner, cold, hot, outsider, other, voter;
  let sid;

  beforeEach(async function () {
    [owner, cold, hot, outsider, other, voter] = await ethers.getSigners();
    const fix = await deploySatoriFixtureNoFee();
    ({ satori, rewards, registry } = fix);
    hub = fix.hub ?? satori;

    for (const s of [cold, hot, outsider, other, voter]) {
      await satori.transfer(s.address, ethers.parseEther("100"));
    }
    sid = await streamIdFrom(await satori[SIMPLE3]("S", owner.address, 720), satori);
    await satori.connect(voter).vote(sid, VOTE);
    await advanceRound();
  });

  // ------------------------------------------------------------------
  // Default: open
  // ------------------------------------------------------------------

  it("defaults to open — anyone may delegate when nothing is set", async function () {
    expect(await satori.allowedDelegator(hot.address)).to.equal(ethers.ZeroAddress);
    await satori.connect(outsider).delegatePredictionPower(hot.address);
    expect((await rewards.predictionDelegateInfo(outsider.address)).delegate).to.equal(hot.address);
  });

  // ------------------------------------------------------------------
  // Restricting
  // ------------------------------------------------------------------

  it("restricts delegation to the nominated address", async function () {
    await satori.connect(hot).setAllowedDelegator(cold.address);
    expect(await satori.allowedDelegator(hot.address)).to.equal(cold.address);

    await satori.connect(cold).delegatePredictionPower(hot.address);
    expect((await rewards.predictionDelegateInfo(cold.address)).delegate).to.equal(hot.address);
  });

  it("rejects a delegation from anyone else", async function () {
    await satori.connect(hot).setAllowedDelegator(cold.address);
    await expect(satori.connect(outsider).delegatePredictionPower(hot.address))
      .to.be.revertedWithCustomError(satori, "DelegatorNotAllowed");
  });

  it("only restricts the predictor who set it — other predictors stay open", async function () {
    await satori.connect(hot).setAllowedDelegator(cold.address);
    // `other` never set one, so outsider may still delegate there.
    await satori.connect(outsider).delegatePredictionPower(other.address);
    expect((await rewards.predictionDelegateInfo(outsider.address)).delegate).to.equal(other.address);
  });

  it("emits AllowedDelegatorSet, and is mutable — re-point and reopen both work", async function () {
    await expect(satori.connect(hot).setAllowedDelegator(cold.address))
      .to.emit(satori, "AllowedDelegatorSet").withArgs(hot.address, cold.address);

    // Re-point to a rotated cold wallet.
    await satori.connect(hot).setAllowedDelegator(other.address);
    await expect(satori.connect(cold).delegatePredictionPower(hot.address))
      .to.be.revertedWithCustomError(satori, "DelegatorNotAllowed");
    await satori.connect(other).delegatePredictionPower(hot.address);

    // Reopen.
    await expect(satori.connect(hot).setAllowedDelegator(ethers.ZeroAddress))
      .to.emit(satori, "AllowedDelegatorSet").withArgs(hot.address, ethers.ZeroAddress);
    await satori.connect(outsider).delegatePredictionPower(hot.address);
    expect((await rewards.predictionDelegateInfo(outsider.address)).delegate).to.equal(hot.address);
  });

  // ------------------------------------------------------------------
  // Never evicts (design §3)
  // ------------------------------------------------------------------

  it("does not evict an existing delegator when set afterwards", async function () {
    await satori.connect(outsider).delegatePredictionPower(hot.address);
    await satori.connect(hot).setAllowedDelegator(cold.address);

    // Still delegated, still contributing power.
    expect((await rewards.predictionDelegateInfo(outsider.address)).delegate).to.equal(hot.address);
    expect((await rewards.predictionDelegateInfo(hot.address)).power)
      .to.equal(ethers.parseEther("100"));
  });

  it("a grandfathered delegator can still burn-vote (the restore is not gated)", async function () {
    await satori.connect(outsider).delegatePredictionPower(hot.address);
    await satori.connect(hot).setAllowedDelegator(cold.address);

    // burnForVote undelegates and RE-delegates around the burn. Gating that
    // restore would make voting the thing that evicts them — exactly what §3
    // promises will not happen.
    await expect(satori.connect(outsider).vote(sid, VOTE)).to.not.be.reverted;
    expect((await rewards.predictionDelegateInfo(outsider.address)).delegate).to.equal(hot.address);
  });

  // ------------------------------------------------------------------
  // Exits are never gated (design §5)
  // ------------------------------------------------------------------

  it("never blocks undelegation, even for an excluded delegator", async function () {
    await satori.connect(outsider).delegatePredictionPower(hot.address);
    await satori.connect(hot).setAllowedDelegator(cold.address);

    await satori.connect(outsider).delegatePredictionPower(ethers.ZeroAddress);
    expect((await rewards.predictionDelegateInfo(outsider.address)).delegate)
      .to.equal(ethers.ZeroAddress);
  });

  it("never blocks self-delegation, which normalises to an exit", async function () {
    await satori.connect(outsider).delegatePredictionPower(hot.address);
    await satori.connect(hot).setAllowedDelegator(cold.address);

    // Self-delegation is normalised to address(0) before the check runs.
    await satori.connect(outsider).delegatePredictionPower(outsider.address);
    expect((await rewards.predictionDelegateInfo(outsider.address)).delegate)
      .to.equal(ethers.ZeroAddress);
  });

  it("an excluded delegator who leaves cannot get back in", async function () {
    await satori.connect(outsider).delegatePredictionPower(hot.address);
    await satori.connect(hot).setAllowedDelegator(cold.address);
    await satori.connect(outsider).delegatePredictionPower(ethers.ZeroAddress);
    await advanceRound(); // clear the undelegation lock

    await expect(satori.connect(outsider).delegatePredictionPower(hot.address))
      .to.be.revertedWithCustomError(satori, "DelegatorNotAllowed");
  });

  // ------------------------------------------------------------------
  // The motivating case
  // ------------------------------------------------------------------

  it("cold/hot pair: the operator's cold wallet is the sole delegator", async function () {
    await satori.connect(hot).setAllowedDelegator(cold.address);
    await satori.connect(cold).delegatePredictionPower(hot.address);

    await expect(satori.connect(outsider).delegatePredictionPower(hot.address))
      .to.be.revertedWithCustomError(satori, "DelegatorNotAllowed");

    // Hot wallet predicts carrying only its own + cold's power.
    await registry.setValue(sid, 100);
    await satori.connect(hot).predictMultipleWithPayloads([{ gameId: sid, payload: pack1(1) }]);
    expect((await rewards.predictionDelegateInfo(hot.address)).power)
      .to.equal(ethers.parseEther("100"));
  });
});
