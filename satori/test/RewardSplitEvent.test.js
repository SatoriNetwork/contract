const { expect } = require("chai");
const { deploySatoriFixture, pack1, voteFor } = require("./fixtures");
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

describe("RewardSplit Event correctness", function () {
  let satori, voting, rewards, bounties, registry;
  let owner, alice, bob, platform;
  let stream1, stream2;
  const UP = 1;

  beforeEach(async function () {
    [owner, alice, bob, platform] = await ethers.getSigners();

    const fix = await deploySatoriFixture();
    ;({ satori, voting, rewards, registry, bounties } = fix);
    owner = fix.owner;

    // Create streams. The three-round A-B-C rhythm below (predict, B, C) is
    // how a cadence-1 (every-round) stream resolves, and the RewardSplit this
    // file pins must carry the ORIGINAL prediction round — so these are
    // admin-created cadence-1 streams (`owner` is the rewards admin).
    const tx1 = await satori["createSimpleDataStream(string,address,uint24)"]("Stream 1", owner.address, 1440);
    stream1 = await getStreamIdFromTx(tx1, registry);

    const tx2 = await satori["createSimpleDataStream(string,address,uint24)"]("Stream 2", owner.address, 1440);
    stream2 = await getStreamIdFromTx(tx2, registry);

    // Give users tokens: alice=400, bob=200
    await satori.transfer(alice.address, ethers.parseEther("400"));
    await satori.transfer(bob.address, ethers.parseEther("200"));

    // Burn so both streams carry weight. The burn is PERMANENT, so this one
    // pass covers every round below — there is no per-round re-voting any more
    // (and none would be possible after a predict, which transfer-locks the
    // balance a burn comes out of).
    await voteFor(satori, alice, stream1);
    await voteFor(satori, bob, stream2);

    // Advance one round for vote snapshots
    await advanceToNextRound();

    // Alice delegates to Bob (so bob predicts using alice+bob power)
    await satori.connect(alice).delegatePredictionPower(bob.address);
  });

  it("RewardSplit event emits correct streamId and round (not zeros)", async function () {

    // R1: Bob predicts with alice's delegated power
    await registry.setValue(stream1, 100);
    await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

    // Capture the round for R1
    const predictionRound = await satori.getCurrentRound();

    // R2: Value goes up - bob was correct
    await advanceToNextRound();
    await registry.setValue(stream1, 150);
    await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

    // R3: Score R1 prediction (this predict call runs _scorePreviousPrediction
    //     which under v5 eager credit emits the RewardSplit at score time).
    await advanceToNextRound();
    await registry.setValue(stream1, 200);
    const scoreTx = await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);
    const receipt = await scoreTx.wait();

    // v5: RewardSplit is emitted at score time, not at claim time. Capture
    // the events from the scoring transaction (R3's predict scores R1).
    // P5: the `&& parsed.args.streamId !== 0n` clause that used to live in this
    // filter silently dropped the exact event shape this file guards against, so
    // the streamId checks below could only ever see survivors. Take every
    // RewardSplit.
    const rewardSplitEvents = receipt.logs.filter(log => {
      try {
        const parsed = rewards.interface.parseLog(log);
        return parsed && parsed.name === 'RewardSplit';
      } catch {
        return false;
      }
    }).map(log => rewards.interface.parseLog(log));

    expect(rewardSplitEvents.length).to.be.gt(0, "Expected at least one RewardSplit event during scoring");

    for (const event of rewardSplitEvents) {
      expect(event.args.gameId).to.not.equal(0n, "RewardSplit streamId should not be 0");
      expect(event.args.round).to.not.equal(0n, "RewardSplit round should not be 0");
      expect(event.args.gameId).to.equal(stream1, "RewardSplit streamId should match stream1");
      expect(event.args.round).to.equal(predictionRound, "RewardSplit round should match prediction round");
    }
  });

  it("RewardSplit event emitted during claim has correct stream and round values", async function () {

    // R1: Bob predicts with alice's delegated power
    await registry.setValue(stream1, 100);
    await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

    // Capture the prediction round
    const predictionRound = await satori.getCurrentRound();

    // R2: Value goes up (bob correct)
    await advanceToNextRound();
    await registry.setValue(stream1, 150);
    await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

    // R3: Score R1 prediction (under v5 eager credit, RewardSplit fires here,
    //     not at claim time).
    await advanceToNextRound();
    await registry.setValue(stream1, 200);
    const scoreTx = await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);
    const receipt = await scoreTx.wait();

    // P5: the filter used to carry `&& parsed.args.streamId !== 0n`, which
    // discarded exactly and only the pathology this file is named for — the
    // loop below then "verified" streamId != 0 on an array from which every
    // zero-streamId event had already been removed (an assertion restating its
    // own filter). Collect EVERY RewardSplit and pin the real values, so a
    // partial regression that emits a zero-field split alongside a good one
    // (which indexers key off) fails loudly instead of being filtered away.
    const scoreTimeEvents = receipt.logs.filter(log => {
      try {
        const parsed = rewards.interface.parseLog(log);
        return parsed && parsed.name === 'RewardSplit';
      } catch {
        return false;
      }
    }).map(log => rewards.interface.parseLog(log));

    expect(scoreTimeEvents.length).to.be.gt(0, "Expected RewardSplit event during scoring");

    for (const event of scoreTimeEvents) {
      expect(event.args.round).to.not.equal(0n, "Round should not be 0 in RewardSplit event");
      expect(event.args.gameId).to.not.equal(0n, "StreamId should not be 0 in RewardSplit event");
      expect(event.args.gameId).to.equal(stream1, "RewardSplit streamId should be the scored stream");
      expect(event.args.round).to.equal(predictionRound, "RewardSplit round should be the prediction round");
    }
  });
});
