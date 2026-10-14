const { expect } = require("chai");
const { deploySatoriFixture, pack1, VOTE, warmUpLoyalty } = require("./fixtures");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

async function getStreamIdFromTx(tx, satoriContract) {
  const receipt = await tx.wait();
  const event = receipt.logs.find(log => {
    try {
      const parsed = satoriContract.interface.parseLog(log);
      return parsed && parsed.name === 'DataStreamCreated';
    } catch { return false; }
  });
  if (!event) throw new Error("DataStreamCreated event not found");
  const parsed = satoriContract.interface.parseLog(event);
  return parsed.args.streamId;
}

async function advanceToNextRound() {
  await time.increase(86400);
}

describe("Double-mint guard for prediction delegators", function () {
  let satori, voting, rewards, bounties, registry;
  let owner, alice, bob, carol;
  let stream1, stream2;
  const UP = 1;

  beforeEach(async function () {
    [owner, alice, bob, carol] = await ethers.getSigners();

    const fix = await deploySatoriFixture();
    ({ satori, voting, rewards, bounties, registry } = fix);
    owner = fix.owner;

    // Every-round (1440-minute) streams. The subject is the double-mint guard
    // on delegator claims; the rounds below exist to walk a predict -> settle
    // -> claim cycle, not to exercise the stream's rhythm, so the every-round
    // cadence is kept.
    const tx1 = await satori.connect(owner)["createSimpleDataStream(string,address,uint24)"]("Stream 1", owner.address, 1440);
    stream1 = await getStreamIdFromTx(tx1, satori);
    const tx2 = await satori.connect(owner)["createSimpleDataStream(string,address,uint24)"]("Stream 2", owner.address, 1440);
    stream2 = await getStreamIdFromTx(tx2, satori);

    await satori.transfer(alice.address, ethers.parseEther("400"));
    await satori.transfer(bob.address, ethers.parseEther("200"));

    // Burn once for each stream to give it permanent weight. Weight bought by
    // a burn never decays and never has to be refreshed, so unlike the old
    // balance-tracking vote there is nothing to re-cast each round.
    await satori.connect(alice).vote(stream1, VOTE);
    await satori.connect(bob).vote(stream2, VOTE);

    await advanceToNextRound();
  });

  it("delegator cannot double-claim her share across repeated claims", async function () {
    // Alice delegates to Bob (alice = delegator, bob = predictor)
    await satori.connect(alice).delegatePredictionPower(bob.address);
    // Delegator weight is capital x loyalty and a fresh delegation starts at
    // L = 0, so alice has nothing to double-claim without a warm-up. Drains to
    // `carol`, who only votes here, so no balance the test relies on moves.
    await warmUpLoyalty(satori, registry, null, bob, [alice], carol, stream1);

    // R1: Bob predicts (stream1's weight is already permanent from beforeEach)
    await registry.setValue(stream1, 100);
    await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

    // R2: Value goes up (bob correct)
    await advanceToNextRound();
    await registry.setValue(stream1, 150);
    await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

    // R3: Score R1
    await advanceToNextRound();
    await registry.setValue(stream1, 200);
    await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

    // Bob claims his own predictor share first; Alice's share is pull-based.
    const aliceBalBeforeBobClaim = await satori.balanceOf(alice.address);
    await satori.connect(bob)['claim()']();
    const aliceBalAfterBobClaim = await satori.balanceOf(alice.address);
    expect(aliceBalAfterBobClaim).to.equal(
      aliceBalBeforeBobClaim,
      "Alice balance should not change from Bob's claim in pull-based model"
    );

    // Alice claims her delegator share
    await satori.connect(alice)['claim()']();
    const aliceBalAfterFirstClaim = await satori.balanceOf(alice.address);
    expect(aliceBalAfterFirstClaim).to.be.gt(aliceBalAfterBobClaim, "Alice should have received rewards");

    // unclaimedRewards[alice] should be 0 after claiming
    const aliceUnclaimedAfterClaim = await rewards.unclaimedRewards(alice.address);
    expect(aliceUnclaimedAfterClaim).to.equal(0n, "Alice unclaimedRewards should be 0 after claim");

    // Alice claims again — idempotent, no additional mint
    await satori.connect(alice)['claim()']();
    const aliceBalAfterSecondClaim = await satori.balanceOf(alice.address);
    expect(aliceBalAfterSecondClaim).to.equal(
      aliceBalAfterFirstClaim,
      "Alice's repeat claim should mint nothing"
    );

    // Bob claims again — nothing new, Alice unaffected
    await satori.connect(bob)['claim()']();
    const aliceBalAfterBobSecondClaim = await satori.balanceOf(alice.address);
    expect(aliceBalAfterBobSecondClaim).to.equal(
      aliceBalAfterFirstClaim,
      "Alice should not receive tokens from Bob's repeat claim"
    );
  });

  it("delegator who has NOT claimed can still claim after predictor claims", async function () {
    // Alice delegates to Bob
    await satori.connect(alice).delegatePredictionPower(bob.address);
    // Delegator weight is capital x loyalty and a fresh delegation starts at
    // L = 0, so alice has nothing to double-claim without a warm-up. Drains to
    // `carol`, who only votes here, so no balance the test relies on moves.
    await warmUpLoyalty(satori, registry, null, bob, [alice], carol, stream1);

    // R1: Bob predicts (stream1's weight is already permanent from beforeEach)
    await registry.setValue(stream1, 100);
    await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

    // R2: Value goes up
    await advanceToNextRound();
    await registry.setValue(stream1, 150);
    await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

    // R3: Score R1
    await advanceToNextRound();
    await registry.setValue(stream1, 200);
    await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

    // Bob claims first
    await satori.connect(bob)['claim()']();

    // Alice claims independently (pull-based) and receives her share
    const aliceBalBefore = await satori.balanceOf(alice.address);
    await satori.connect(alice)['claim()']();
    const aliceBalAfter = await satori.balanceOf(alice.address);
    expect(aliceBalAfter).to.be.gt(aliceBalBefore, "Alice should receive tokens from her own claim");
  });
});
