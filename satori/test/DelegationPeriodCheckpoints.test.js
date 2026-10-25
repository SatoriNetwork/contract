const { expect } = require("chai");
const { deploySatoriFixture, pack1, VOTE } = require("./fixtures");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const UP = 1;

async function getStreamIdFromTx(tx, satoriContract) {
  const receipt = await tx.wait();
  const event = receipt.logs.find(log => {
    try {
      const parsed = satoriContract.interface.parseLog(log);
      return parsed && parsed.name === 'DataStreamCreated';
    } catch { return false; }
  });
  if (!event) throw new Error("DataStreamCreated event not found");
  return satoriContract.interface.parseLog(event).args.streamId;
}

async function advanceRound() {
  const currentTime = await time.latest();
  const nextMidnight = Math.floor(currentTime / 86400) * 86400 + 86400;
  await time.increaseTo(nextMidnight + 1);
}

describe("Per-period delegation checkpoints", function () {
  let satori, voting, rewards, bounties, registry;
  let owner, alice, bob, carol, dave, platform1, platform2;
  let stream1;

  beforeEach(async function () {
    [owner, alice, bob, carol, dave, platform1, platform2] = await ethers.getSigners();

    const fix = await deploySatoriFixture();
    ;({ satori, voting, rewards, registry, bounties } = fix);

    // Distribute in 4:2:3:1 ratio derived from INITIAL_MINT (sum = 10/16 of
    // bootstrap; original 400/200/300/100 ratios preserved).
    const INITIAL_MINT = await satori.INITIAL_MINT();
    const UNIT = INITIAL_MINT / 16n;
    await satori.transfer(alice.address, UNIT * 4n);
    await satori.transfer(bob.address, UNIT * 2n);
    await satori.transfer(carol.address, UNIT * 3n);
    await satori.transfer(dave.address, UNIT);

    // Every-round (1440-minute) stream. These scenarios are about delegation
    // PERIODS and claim accounting, not the stream's rhythm, so the rounds
    // below stay one apart.
    const tx = await satori.connect(owner)["createSimpleDataStream(string,address,uint24)"]("Stream 1", owner.address, 1440);
    stream1 = await getStreamIdFromTx(tx, satori);

    // One burn makes stream1 eligible forever — burnt weight is permanent, so
    // the per-round re-votes these scenarios used to make are gone. OWNER pays
    // it: alice and bob spend the whole file delegated or predicting, and a vote
    // would destroy the very balance those flows measure.
    await satori.connect(owner).vote(stream1, VOTE);
    await advanceRound();
  });

  it("delegator can claim earlier-period rewards after undelegating", async function () {
    // Alice delegates to Bob and Bob makes a correct prediction.
    await satori.connect(alice).delegatePredictionPower(bob.address);
    await time.increase(86400);

    await registry.setValue(stream1, 100);
    await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

    await advanceRound();
    await registry.setValue(stream1, 150);
    await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

    await advanceRound();
    await registry.setValue(stream1, 200);
    await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]); // triggers scoring of R1

    // Alice undelegates BEFORE claiming.
    await satori.connect(alice).delegatePredictionPower(ethers.ZeroAddress);

    // Advance past the lock-on-undelegation guard.
    await advanceRound();

    // Alice's earlier-period delegator reward should still be claimable.
    const aliceBefore = await satori.balanceOf(alice.address);
    await satori.connect(alice)['claim()']();
    const aliceAfter = await satori.balanceOf(alice.address);

    expect(aliceAfter).to.be.gt(aliceBefore, "Alice should still receive reward from prior delegation period");
  });

  it("same-delegate re-delegation is a no-op (no duplicate period)", async function () {
    await satori.connect(alice).delegatePredictionPower(bob.address);
    await time.increase(86400);

    // Re-delegate to the same delegate — should early-return without pool accounting change.
    const bobPoolBefore = (await rewards.predictionDelegateInfo(bob.address)).power;
    await satori.connect(alice).delegatePredictionPower(bob.address);
    await time.increase(86400);
    const bobPoolAfter = (await rewards.predictionDelegateInfo(bob.address)).power;

    expect(bobPoolAfter).to.equal(bobPoolBefore, "Pool must not double-count");

    // Delegate and reward flow still work.
    await registry.setValue(stream1, 100);
    await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

    await advanceRound();
    await registry.setValue(stream1, 150);
    await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

    await advanceRound();
    await registry.setValue(stream1, 200);
    await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

    const aliceBefore = await satori.balanceOf(alice.address);
    await satori.connect(bob)['claim()']();
    await satori.connect(alice)['claim()']();
    const aliceAfter = await satori.balanceOf(alice.address);

    expect(aliceAfter).to.be.gt(aliceBefore, "Delegator reward flow still works after same-delegate re-delegation");
  });

  it("delegator claiming before delegate still receives share (lazy settle)", async function () {
    await satori.connect(alice).delegatePredictionPower(bob.address);
    await time.increase(86400);

    await registry.setValue(stream1, 100);
    await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

    await advanceRound();
    await registry.setValue(stream1, 150);
    await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

    await advanceRound();
    await registry.setValue(stream1, 200);
    await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

    // Alice claims BEFORE Bob. _accrueDelegatorRewards must settle Bob first
    // so that per-round rates are populated.
    const aliceBefore = await satori.balanceOf(alice.address);
    await satori.connect(alice)['claim()']();
    const aliceAfter = await satori.balanceOf(alice.address);

    expect(aliceAfter).to.be.gt(aliceBefore, "Alice should receive delegator reward even if she claims first");
  });

  it("delegator balance change between periods credits share against correct balance", async function () {
    // Period 1: Alice (400) delegates to Bob.
    await satori.connect(alice).delegatePredictionPower(bob.address);
    await time.increase(86400);

    await registry.setValue(stream1, 100);
    await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

    await advanceRound();
    await registry.setValue(stream1, 150);
    await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

    await advanceRound();
    await registry.setValue(stream1, 200);
    await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]); // scores R1

    // Alice settles her period-1 reward.
    await satori.connect(bob)['claim()']();
    await satori.connect(alice)['claim()']();
    const aliceAfterPeriod1 = await satori.balanceOf(alice.address);

    // Alice undelegates, advances, re-delegates with same power.
    await satori.connect(alice).delegatePredictionPower(ethers.ZeroAddress);
    await advanceRound();
    await satori.connect(alice).delegatePredictionPower(bob.address);
    await time.increase(86400);

    // Period 2: Bob keeps predicting correctly.
    await registry.setValue(stream1, 250);
    await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

    await advanceRound();
    await registry.setValue(stream1, 300);
    await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

    await advanceRound();
    await registry.setValue(stream1, 350);
    await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

    await satori.connect(bob)['claim()']();
    await satori.connect(alice)['claim()']();
    const aliceAfterPeriod2 = await satori.balanceOf(alice.address);

    // Alice should have received additional rewards in period 2.
    expect(aliceAfterPeriod2).to.be.gt(aliceAfterPeriod1, "Alice should earn in period 2 after re-delegating");
  });

  it("predictions settled after undelegation still credit the old delegator", async function () {
    // Alice delegates to Bob on R0.
    await satori.connect(alice).delegatePredictionPower(bob.address);
    await time.increase(86400);

    // Bob predicts on R1.
    await registry.setValue(stream1, 100);
    await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

    // R2: value moves up.
    await advanceRound();
    await registry.setValue(stream1, 150);

    // Alice undelegates BEFORE R1 is scored.
    await satori.connect(alice).delegatePredictionPower(ethers.ZeroAddress);

    // R3: value moves up again; settle R1.
    await advanceRound();
    await registry.setValue(stream1, 200);
    await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]); // scores R1

    // Advance past undelegation lockout so Alice can claim.
    await advanceRound();

    // Alice's claim must still credit her for the R1 prediction — it was made
    // during the delegation period, even though settlement happened after.
    const aliceBefore = await satori.balanceOf(alice.address);
    await satori.connect(bob)['claim()']();
    await satori.connect(alice)['claim()']();
    const aliceAfter = await satori.balanceOf(alice.address);

    expect(aliceAfter).to.be.gt(aliceBefore, "Alice should earn R1 reward despite undelegating before settlement");
  });

  it("repeat claim is idempotent for delegator", async function () {
    await satori.connect(alice).delegatePredictionPower(bob.address);
    await time.increase(86400);

    await registry.setValue(stream1, 100);
    await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

    await advanceRound();
    await registry.setValue(stream1, 150);
    await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

    await advanceRound();
    await registry.setValue(stream1, 200);
    await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

    await satori.connect(bob)['claim()']();
    await satori.connect(alice)['claim()']();
    const aliceAfterFirst = await satori.balanceOf(alice.address);

    // Second and third claims must mint nothing.
    await satori.connect(alice)['claim()']();
    await satori.connect(alice)['claim()']();
    expect(await satori.balanceOf(alice.address)).to.equal(aliceAfterFirst);
  });
});
