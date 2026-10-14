// v5 — eager-credit semantics.
//
// At score time, scoreCorrectPrediction:
//   1. Computes the SATORI reward.
//   2. Runs the 80/10/5/5 split (writes _delegatorRewardRatePerRound).
//   3. Credits unclaimedRewards[user] += predictorAmount immediately.
//   4. Updates totalUnclaimedRewards.
//
// As a result:
//   - unclaimedRewards[user] becomes the always-current SATORI shadow.
//   - getPredictionPower(user) = balance + unclaimedRewards + delegatedPredictionPower.
//   - A user can predict with their unclaimed rewards counting toward stake
//     without claiming them first.

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture, pack1, VOTE } = require("./fixtures");

const UP = 1;
async function advanceOneDay() { await time.increase(86400); }

async function createStream(satori, signer, name, authority) {
  // Every-round (1440-minute) stream — one value write per 24h round, which is
  // this suite's rhythm. 1440 is the finest PUBLIC cadence SatoriHub allows, so
  // no admin exemption is needed. `authority` stays the provider — it is who
  // may call `registry.setValue`.
  const tx = await satori.connect(signer)["createSimpleDataStream(string,address,uint24)"](name, authority, 1440);
  const rcpt = await tx.wait();
  for (const log of rcpt.logs) {
    try {
      const p = satori.interface.parseLog(log);
      if (p && p.name === "DataStreamCreated") return p.args.streamId;
    } catch (e) {}
  }
  throw new Error("DataStreamCreated event missing");
}

describe("EagerCredit — v5 score-time eager credit semantics", function () {
  let satori, rewards, registry, owner, alice, bob, authority, lens;
  let stream;

  beforeEach(async function () {
    const fix = await loadFixture(deploySatoriFixture);
    ({ satori, rewards, lens, registry, owner } = fix);
    [, alice, bob, authority] = fix.signers;

    await satori.transfer(alice.address, ethers.parseEther("100"));
    await satori.transfer(bob.address, ethers.parseEther("100"));
    await satori.transfer(authority.address, ethers.parseEther("100"));

    stream = await createStream(satori, owner, "S", authority.address);
    await satori.connect(alice).vote(stream, VOTE);
    await satori.connect(bob).vote(stream, VOTE);
  });

  it("unclaimedRewards[user] is populated at score time (before any claim)", async function () {
    expect(await rewards.unclaimedRewards(alice.address)).to.equal(0n);

    await registry.connect(authority).setValue(stream, 100);
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream, payload: pack1(UP) }]);

    // Before scoring, NOTHING is credited: the first-predictor liveness bonus
    // was removed, so predicting alone credits no SATORI at all and the whole
    // round budget stays with the scoring path.
    expect(await rewards.unclaimedRewards(alice.address)).to.equal(0n);

    await advanceOneDay();
    await registry.connect(authority).setValue(stream, 110);
    await advanceOneDay();
    await registry.connect(authority).setValue(stream, 120);

    // Score the prediction. Under eager credit, unclaimedRewards is
    // populated synchronously inside this call — NOT deferred to claim.
    await satori.settlePrediction(alice.address, stream);

    expect(await rewards.unclaimedRewards(alice.address)).to.be.gt(0n);
  });

  it("getPredictionPower returns balance + unclaimedRewards + delegatedPredictionPower (O(1))", async function () {
    // Pre-score: power == balance.
    const balance = await satori.balanceOf(alice.address);
    expect(await rewards.getPredictionPower(alice.address)).to.equal(balance);

    await registry.connect(authority).setValue(stream, 100);
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream, payload: pack1(UP) }]);
    await advanceOneDay();
    await registry.connect(authority).setValue(stream, 110);
    await advanceOneDay();
    await registry.connect(authority).setValue(stream, 120);
    await satori.settlePrediction(alice.address, stream);

    const aliceUnclaimed = await rewards.unclaimedRewards(alice.address);
    expect(aliceUnclaimed).to.be.gt(0n);

    // Post-score: power == balance + unclaimedRewards (alice has no delegated power).
    const power = await rewards.getPredictionPower(alice.address);
    expect(power).to.equal(balance + aliceUnclaimed);
  });

  it("a user can predict with their unclaimed rewards counting toward stake without claiming", async function () {
    // Under the new streak curve, predictions at streak <= 1 commit weight=0
    // (other than the very first on the stream). To verify perStreamPower
    // includes unclaimedRewards at predict time, we need Alice to be at
    // streak >= 2 when she makes the test prediction — that means two full
    // settle cycles first (cycles 1 and 2 below) and the testing predict
    // happens in cycle 3.

    // Cycle 1: first-ever predict on this stream → bypass mult=1 → wins.
    await registry.connect(authority).setValue(stream, 100);
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream, payload: pack1(UP) }]);
    await advanceOneDay();
    await registry.connect(authority).setValue(stream, 110);
    await advanceOneDay();
    await registry.connect(authority).setValue(stream, 120);
    await satori.settlePrediction(alice.address, stream); // streak: 0→1

    // Cycle 2: streak=1 at predict-time commit, mult=0 (no earnings this
    // cycle), but the scoring still increments streak after settle.
    await advanceOneDay();
    await registry.connect(authority).setValue(stream, 130);
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream, payload: pack1(UP) }]);
    await advanceOneDay();
    await registry.connect(authority).setValue(stream, 140);
    await advanceOneDay();
    await registry.connect(authority).setValue(stream, 150);
    await satori.settlePrediction(alice.address, stream); // streak: 1→2

    const aliceUnclaimed = await rewards.unclaimedRewards(alice.address);
    expect(aliceUnclaimed).to.be.gt(0n); // accrued from cycle 1's win

    // Cycle 3: Alice predicts again WITHOUT claiming. Now streak=2 at commit
    // → mult(2)=100, so userW > 0 and the per-stream power already includes
    // unclaimedRewards (eager-credit accumulation).
    await advanceOneDay();
    await registry.connect(authority).setValue(stream, 160);
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream, payload: pack1(UP) }]);
    const round = await satori.getCurrentRound();
    const userW = await lens.userWeightByDirection(alice.address, stream, round, UP);
    expect(userW).to.be.gt(0n);
  });

  it("getTotalClaimableRewards drops the deferred-walk arms — equals unclaimedRewards + pending delegator share", async function () {
    await registry.connect(authority).setValue(stream, 100);
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream, payload: pack1(UP) }]);
    await advanceOneDay();
    await registry.connect(authority).setValue(stream, 110);
    await advanceOneDay();
    await registry.connect(authority).setValue(stream, 120);
    await satori.settlePrediction(alice.address, stream);

    const direct = await rewards.unclaimedRewards(alice.address);
    const total = (await lens.getTotalClaimableRewards(alice.address))[0];
    // Alice has no delegation periods → pendingDelegatorRewardsView returns 0.
    expect(total).to.equal(direct);
  });

  it("after claim, unclaimedRewards returns to 0 and the SATORI balance grows by the claim net", async function () {
    await registry.connect(authority).setValue(stream, 100);
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream, payload: pack1(UP) }]);
    await advanceOneDay();
    await registry.connect(authority).setValue(stream, 110);
    await advanceOneDay();
    await registry.connect(authority).setValue(stream, 120);
    await satori.settlePrediction(alice.address, stream);

    const owed = await rewards.unclaimedRewards(alice.address);
    expect(owed).to.be.gt(0n);
    const balBefore = await satori.balanceOf(alice.address);
    await satori.connect(alice)['claim()']();
    expect(await rewards.unclaimedRewards(alice.address)).to.equal(0n);
    // Net minted to alice = owed (no referral set → no 1% cut).
    expect((await satori.balanceOf(alice.address)) - balBefore).to.equal(owed);
  });
});
