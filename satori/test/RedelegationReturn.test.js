// The same-round return exemption: undelegating locks lane A until next round,
// but RETURNING to the delegate you just left passes — it is the user-facing
// twin of burnForVote's internal undelegate->re-delegate dance, and the rewards
// over-mint guard (audit H1) already quarantines the one hot sub-case (delegate
// predicted first). What must NOT pass: a different delegate this round, and a
// SELF-PREDICTOR joining any pool (their lock has the same value; the record's
// round is what tells the cases apart).

const { expect } = require("chai");
const { deploySatoriFixture, pack1, VOTE } = require("./fixtures");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

async function getStreamIdFromTx(tx, satoriContract) {
  const receipt = await tx.wait();
  for (const log of receipt.logs) {
    try {
      const parsed = satoriContract.interface.parseLog(log);
      if (parsed && parsed.name === "DataStreamCreated") return parsed.args.streamId;
    } catch {}
  }
  throw new Error("DataStreamCreated event not found");
}

async function advanceToNextRound() {
  const currentTime = await time.latest();
  const nextMidnight = Math.floor(currentTime / 86400) * 86400 + 86400;
  await time.increaseTo(nextMidnight + 1);
  await time.increase(86400);
}

describe("Same-round re-delegation return", function () {
  let fix, satori, token, hub, rewards, registry;
  let owner, alice, bob, carol;
  let stream1;

  beforeEach(async function () {
    fix = await loadFixture(deploySatoriFixture);
    ;({ satori, token, hub, rewards, registry, owner } = fix);
    [, alice, bob, carol] = fix.signers;

    const tx1 = await satori.createSimpleDataStream("Stream 1", owner.address);
    stream1 = await getStreamIdFromTx(tx1, satori);

    await satori.transfer(alice.address, ethers.parseEther("100"));
    await satori.transfer(bob.address, ethers.parseEther("100"));
    await satori.transfer(carol.address, ethers.parseEther("50"));
    await satori.connect(owner).vote(stream1, VOTE);
    await advanceToNextRound();
  });

  const delegateOf = async (who) =>
    (await rewards.predictionDelegateInfo(who.address))[0];

  it("returns to the delegate left this round (the feature)", async function () {
    await satori.connect(alice).delegatePredictionPower(bob.address);
    await satori.connect(alice).delegatePredictionPower(ethers.ZeroAddress); // leave -> locked
    await satori.connect(alice).delegatePredictionPower(bob.address);        // return: passes
    expect(await delegateOf(alice)).to.equal(bob.address);
  });

  it("still refuses a DIFFERENT delegate in the same round", async function () {
    await satori.connect(alice).delegatePredictionPower(bob.address);
    await satori.connect(alice).delegatePredictionPower(ethers.ZeroAddress);
    await expect(satori.connect(alice).delegatePredictionPower(carol.address))
      .to.be.revertedWithCustomError(hub, "Locked");
  });

  it("still refuses a SELF-PREDICTOR joining any pool — even a stale last delegate", async function () {
    // Round R: alice delegates to bob then leaves (record: bob @ R).
    await satori.connect(alice).delegatePredictionPower(bob.address);
    await satori.connect(alice).delegatePredictionPower(ethers.ZeroAddress);
    await advanceToNextRound();
    // Round R+1: alice predicts HERSELF -> lane-A lock with the SAME value an
    // undelegation would leave. The record still names bob, but from round R.
    await registry.setValue(stream1, 100);
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(1) }]);
    await expect(satori.connect(alice).delegatePredictionPower(bob.address))
      .to.be.revertedWithCustomError(hub, "Locked");
  });

  it("next round, a different delegate works as before", async function () {
    await satori.connect(alice).delegatePredictionPower(bob.address);
    await satori.connect(alice).delegatePredictionPower(ethers.ZeroAddress);
    await advanceToNextRound();
    await satori.connect(alice).delegatePredictionPower(carol.address);
    expect(await delegateOf(alice)).to.equal(carol.address);
  });

  it("the return still respects an allowed-delegator nomination", async function () {
    await satori.connect(alice).delegatePredictionPower(bob.address);
    await satori.connect(alice).delegatePredictionPower(ethers.ZeroAddress);
    // Bob closes his door to everyone but carol while alice is outside.
    await satori.connect(bob).setAllowedDelegator(carol.address);
    await expect(satori.connect(alice).delegatePredictionPower(bob.address))
      .to.be.revertedWithCustomError(hub, "DelegatorNotAllowed");
  });

  it("returns even when the delegate already predicted (H1 guard defers the power)", async function () {
    await satori.connect(alice).delegatePredictionPower(bob.address);
    await registry.setValue(stream1, 100);
    await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(1) }]);
    await satori.connect(alice).delegatePredictionPower(ethers.ZeroAddress);
    await satori.connect(alice).delegatePredictionPower(bob.address);
    expect(await delegateOf(alice)).to.equal(bob.address);
  });

  it("after a switch, the door leads to the delegate actually left — not the first one", async function () {
    await satori.connect(alice).delegatePredictionPower(bob.address);
    await satori.connect(alice).delegatePredictionPower(carol.address); // switch (carol idle)
    await satori.connect(alice).delegatePredictionPower(ethers.ZeroAddress); // leave carol
    await expect(satori.connect(alice).delegatePredictionPower(bob.address))
      .to.be.revertedWithCustomError(hub, "Locked");
    await satori.connect(alice).delegatePredictionPower(carol.address);
    expect(await delegateOf(alice)).to.equal(carol.address);
  });

  it("leave-and-return loops within one round keep working", async function () {
    await satori.connect(alice).delegatePredictionPower(bob.address);
    for (let i = 0; i < 3; i++) {
      await satori.connect(alice).delegatePredictionPower(ethers.ZeroAddress);
      await satori.connect(alice).delegatePredictionPower(bob.address);
    }
    expect(await delegateOf(alice)).to.equal(bob.address);
  });
});
