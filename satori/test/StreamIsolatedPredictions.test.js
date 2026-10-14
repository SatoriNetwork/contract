const { expect } = require("chai");
const { deploySatoriFixture, pack1, voteFor } = require("./fixtures");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("Stream-Isolated Predictions", function () {
  let owner, alice, bob;
  let satori, registry, rewards, bounties, voting;
  let stream1, stream2;

  beforeEach(async function () {
    [owner, alice, bob] = await ethers.getSigners();

    // Deploy the restructured Satori stack via the shared fixture (2000 bps platform fee)
    const fix = await deploySatoriFixture();
    ({ satori, voting, rewards, registry, bounties } = fix);
    owner = fix.owner;

    // Transfer tokens to Alice and Bob. Each burns 10 for "their" stream and
    // keeps 190 to predict with.
    await satori.transfer(alice.address, ethers.parseEther("200"));
    await satori.transfer(bob.address, ethers.parseEther("200"));

    // Create two streams
    const tx1 = await satori.createSimpleDataStream("Stream1", owner.address);
    const receipt1 = await tx1.wait();
    const event1 = receipt1.logs.find(log => {
      try {
        const parsed = satori.interface.parseLog(log);
        return parsed && parsed.name === 'DataStreamCreated';
      } catch { return false; }
    });
    stream1 = satori.interface.parseLog(event1).args.streamId;

    const tx2 = await satori.createSimpleDataStream("Stream2", owner.address);
    const receipt2 = await tx2.wait();
    const event2 = receipt2.logs.find(log => {
      try {
        const parsed = satori.interface.parseLog(log);
        return parsed && parsed.name === 'DataStreamCreated';
      } catch { return false; }
    });
    stream2 = satori.interface.parseLog(event2).args.streamId;

    // Burn to buy each stream's game some weight. There is no eligibility
    // threshold and no top-N cap any more, so the old pair of dummy voters +
    // dummy streams (which existed purely to dilute past the 50% threshold) is
    // gone: one burn per game is enough.
    await voteFor(satori, alice, stream1);
    await voteFor(satori, bob, stream2);

    // Set initial values
    await registry.setValue(stream1, 100);
    await registry.setValue(stream2, 200);
  });

  it("Should prevent second predict() call due to global lock", async function () {
    // Alice predicts on Stream1
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(1) }]); // UP
    console.log("✓ Alice predicted on Stream1");

    // Alice tries to predict on Stream2 (should fail - global lock)
    await expect(
      satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream2, payload: pack1(2) }]) // DOWN
    ).to.be.revertedWithCustomError(satori, "AlreadyPredicted");
    console.log("✓ Second predict() call correctly rejected (global lock for power division)");

    // This demonstrates that predict() enforces one batch per day
    // Users must use predictMultiple() for multi-stream predictions
  });

  it("Should allow batch predictions on multiple streams using predictMultiple()", async function () {
    const requests = [
      { gameId: stream1, payload: pack1(1) }, // UP
      { gameId: stream2, payload: pack1(2) }  // DOWN
    ];

    await satori.connect(bob).predictMultipleWithPayloads(requests);
    console.log("✓ Bob made batch predictions");

    // Verify both predictions were recorded — packed slot now stores the
    // prediction data inline; query via the public `predictions(user, game, round)`
    // view (round-keyed lookup, returns a synthesized Prediction).
    const round = await satori.getCurrentRound();
    const pred1 = await satori.predictions(bob.address, stream1, round);
    const pred2 = await satori.predictions(bob.address, stream2, round);
    expect(pred1.direction).to.equal(1); // UP
    expect(pred2.direction).to.equal(2); // DOWN
    console.log("✓ Both predictions recorded");

    // Verify stream count is 2
    const streamCount = await satori.predictedStreamsCount(bob.address, round);
    expect(streamCount).to.equal(2);
    console.log("✓ Stream count is 2");
  });

  it("Should prevent batch prediction with duplicate streams", async function () {
    const requests = [
      { gameId: stream1, payload: pack1(1) }, // UP
      { gameId: stream1, payload: pack1(2) }  // DOWN (duplicate!)
    ];

    await expect(
      satori.connect(bob).predictMultipleWithPayloads(requests)
    ).to.be.revertedWithCustomError(satori, "DuplicatePrediction");
    console.log("✓ Dup correctly rejected");
  });

  it("Should prevent using predict() after predictMultiple() in same round", async function () {
    // Bob uses predictMultiple first
    const requests = [
      { gameId: stream1, payload: pack1(1) }
    ];
    await satori.connect(bob).predictMultipleWithPayloads(requests);
    console.log("✓ Bob made batch prediction");

    // Bob tries to use predict() for another stream (should fail - global lock)
    await expect(
      satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream2, payload: pack1(2) }])
    ).to.be.revertedWithCustomError(satori, "AlreadyPredicted");
    console.log("✓ predict() after predictMultiple() correctly rejected (global lock)");
  });
});
