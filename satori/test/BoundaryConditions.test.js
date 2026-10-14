const { expect } = require("chai");
const { deploySatoriFixture, RAW_TOLERANCE, pack1, VOTE, voteFor } = require("./fixtures");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

// `createSimpleDataStream(name, provider)` hands out a 1440-minute
// (every-round) stream. Anywhere this file writes a stream REPEATEDLY, the
// writes are spaced two rounds apart — comfortably past the cadence gap; a
// single write on a never-written stream needs no wait, and rounds advanced
// for other reasons (closing a round, waiting out a lock) stay single rounds.
const ROUND = 86400;                            // 24h
const CADENCE_ROUNDS = 2;                       // write spacing, in rounds
const CADENCE_SECONDS = ROUND * CADENCE_ROUNDS;

// Helper function to extract streamId from DataStreamCreated event
async function getStreamIdFromTx(tx, satoriContract) {
  const receipt = await tx.wait();
  const event = receipt.logs.find(log => {
    try {
      const parsed = satoriContract.interface.parseLog(log);
      return parsed && parsed.name === 'DataStreamCreated';
    } catch {
      return false;
    }
  });

  if (!event) throw new Error("DataStreamCreated event not found");
  const parsed = satoriContract.interface.parseLog(event);
  return parsed.args.streamId;
}

describe("Phase 3: Boundary Condition Tests", function() {
  let satori, rewards, bounties;
  let registry, voting;
  let owner;
  let addr1;
  let addr2;
  let addr3;
  let addr4;

  beforeEach(async function () {
    [owner, addr1, addr2, addr3, addr4] = await ethers.getSigners();

    const fix = await deploySatoriFixture();
    ;({ satori, voting, rewards, registry, bounties, owner } = fix);
  });

  // Burn voting has NO eligibility threshold, no top-N cap and no minimum
  // stake: `isEligible(g)` is exactly `weightOf(g) > 0`. This test replaces the
  // old "exactly 80% of supply" boundary — that bar does not exist any more —
  // with the boundary that does: the smallest possible non-zero burn.
  it("Should have no eligibility threshold — the smallest non-zero burn earns", async function() {
    const tx = await satori.createSimpleDataStream("ETH/USD", owner.address);
    const streamId = await getStreamIdFromTx(tx, satori);

    // Nothing burnt yet: no weight, not eligible.
    expect(await voting.weightOf(streamId)).to.equal(0n);
    expect(await voting.isEligible(streamId)).to.be.false;

    await satori.transfer(addr1.address, ethers.parseEther("100"));
    await satori.transfer(addr2.address, ethers.parseEther("100"));

    // A zero burn is rejected outright rather than silently doing nothing.
    await expect(satori.connect(addr1).vote(streamId, 0))
      .to.be.revertedWithCustomError(voting, "ZeroVote");

    // ONE WEI is enough. There is no 80%-of-supply bar to clear.
    await satori.connect(addr1).vote(streamId, 1n);
    expect(await voting.weightOf(streamId)).to.equal(1n);
    expect(await voting.isEligible(streamId)).to.be.true;

    // A second game burning 50 SATORI — five billion billion times as much —
    // does not push the 1-wei game out. Both earn, in proportion.
    const tx2 = await satori.createSimpleDataStream("BTC/USD", owner.address);
    const streamId2 = await getStreamIdFromTx(tx2, satori);
    await satori.connect(addr2).vote(streamId2, ethers.parseEther("50"));

    expect(await voting.isEligible(streamId)).to.be.true;
    expect(await voting.isEligible(streamId2)).to.be.true;
    expect(await voting.totalBurnedWeight()).to.equal(ethers.parseEther("50") + 1n);
  });

  it("Should handle 1 wei predictions", async function() {

    const tx = await satori.createSimpleDataStream("ETH/USD", owner.address);
    const streamId = await getStreamIdFromTx(tx, satori);

    // Make stream eligible — any non-zero burn does it.
    await satori.transfer(addr1.address, ethers.parseEther("100"));
    await voteFor(satori, addr1, streamId);

    await time.increase(86400);

    // Give addr2 exactly 1 wei, and addr3 more for comparison
    await satori.transfer(addr2.address, 1n);
    await satori.transfer(addr3.address, ethers.parseEther("100"));

    // Set initial value for the stream
    await registry.setValue(streamId, 1000);

    // Make prediction with 1 wei balance
    await satori.connect(addr2).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(1) }]); // UP
    // Also make prediction with addr3 for comparison
    await satori.connect(addr3).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(1) }]); // UP

    // Verify prediction recorded with 1 wei
    const prediction = await satori.predictions(addr2.address, streamId, await satori.getCurrentRound());
    expect(prediction.rawPredictionPower).to.be.closeTo(1n, RAW_TOLERANCE);

    // Close the cadence period with a correct outcome (value went UP)
    await time.increase(CADENCE_SECONDS);
    await registry.setValue(streamId, 1100);

    // Wait for scoring
    await time.increase(CADENCE_SECONDS);
    await registry.setValue(streamId, 1200);
    await satori.connect(addr2).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(1) }]);
    await satori.connect(addr3).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(1) }]);

    // Claim rewards - use the parameterless claim function
    const balanceBefore = await satori.balanceOf(addr2.address);
    await satori.connect(addr2).claim();
    const balanceAfter = await satori.balanceOf(addr2.address);

    // With 1 wei prediction power, reward might be 0 due to rounding
    // The test is really checking that the system handles 1 wei without errors
    expect(balanceAfter).to.be.greaterThanOrEqual(balanceBefore);
  });

  it("Should handle single stream monopoly", async function() {

    // Create 10 streams
    const streams = [];
    for (let i = 0; i < 10; i++) {
      const tx = await satori.createSimpleDataStream(`Stream ${i}`, owner.address);
      const streamId = await getStreamIdFromTx(tx, satori);
      streams.push(streamId);
    }

    // Transfer most of the bootstrap to addr1 (this user does all the burning)
    const INITIAL_MINT = await satori.INITIAL_MINT();
    await satori.transfer(addr1.address, (INITIAL_MINT * 3n) / 4n);

    // Burn 100 SATORI on stream 0 only.
    const MONOPOLY = ethers.parseEther("100");
    await voteFor(satori, addr1, streams[0], MONOPOLY);

    // Only stream 0 carries weight; the other nine earn nothing.
    expect(await voting.weightOf(streams[0])).to.equal(MONOPOLY);
    for (let i = 1; i < streams.length; i++) {
      expect(await voting.isEligible(streams[i])).to.be.false;
    }
    expect(await voting.totalBurnedWeight()).to.equal(MONOPOLY);

    // The default game is the only OTHER earner, and it takes exactly its
    // derived 1% of the denominator — d = total * 100 / 9900 — a monopolist
    // cannot squeeze it out. At a 100-ether burn, 1% clears the 1e18 floor.
    expect(await voting.weightOf(1)).to.equal((MONOPOLY * 100n) / 9900n);

    // System should still function normally
    await time.increase(86400);
    await registry.setValue(streams[0], 1000);
    await satori.connect(addr1).predictMultipleWithPayloads([{ gameId: streams[0], payload: pack1(1) }]);
    await time.increase(86400);
  });

  // Vote delegation is gone (weight is bought by BURNING your own tokens, so
  // there is no transferable voting power left to hand over). The remaining two
  // delegations — prediction and claim — must still stack on one delegate.
  it("Should handle both delegations from all users simultaneously", async function() {
    const [alice, bob, carol, dave] = [addr1, addr2, addr3, addr4];


    // Distribute tokens evenly: 4 actors × INITIAL_MINT/5 fits under budget.
    const INITIAL_MINT = await satori.INITIAL_MINT();
    const PER_ACTOR = INITIAL_MINT / 5n;
    await satori.transfer(alice.address, PER_ACTOR);
    await satori.transfer(bob.address, PER_ACTOR);
    await satori.transfer(carol.address, PER_ACTOR);
    await satori.transfer(dave.address, PER_ACTOR);

    // Everyone delegates everything they still CAN delegate to Bob
    await satori.connect(alice).delegatePredictionPower(bob.address);
    await satori.connect(alice).delegateClaimAbility(bob.address);

    await satori.connect(carol).delegatePredictionPower(bob.address);
    await satori.connect(carol).delegateClaimAbility(bob.address);

    await satori.connect(dave).delegatePredictionPower(bob.address);
    await satori.connect(dave).delegateClaimAbility(bob.address);

    // Bob now has prediction power from all 3 users plus his own
    expect(await rewards.getPredictionPower(bob.address)).to.equal(PER_ACTOR * 4n);

    // Create stream and back it with Bob's OWN burn — the delegated balances
    // are not his to burn, and burning is the only way to buy weight.
    const tx = await satori.createSimpleDataStream("ETH/USD", owner.address);
    const streamId = await getStreamIdFromTx(tx, satori);

    await voteFor(satori, bob, streamId);
    expect(await voting.weightOf(streamId)).to.equal(VOTE);

    // Bob's own burn is the ONLY thing that came out of the pooled power.
    const expectedPower = PER_ACTOR * 4n - VOTE;
    expect(await rewards.getPredictionPower(bob.address)).to.equal(expectedPower);

    // Verify Bob can predict with all delegated power
    await time.increase(86400);
    await registry.setValue(streamId, 1000);

    // Bob makes prediction
    await satori.connect(bob).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(1) }]);

    // Verify prediction power includes delegated amounts
    const prediction = await satori.predictions(bob.address, streamId, await satori.getCurrentRound());
    expect(prediction.rawPredictionPower).to.be.closeTo(expectedPower, RAW_TOLERANCE);
  });

  it("Should handle precision and rounding correctly", async function() {

    const tx = await satori.createSimpleDataStream("BTC/USD", owner.address);
    const streamId = await getStreamIdFromTx(tx, satori);

    // Deliberately not a round number, right down to the wei: the burnt amount
    // must be credited in FULL precision, with no truncation or rounding.
    const oddAmount = ethers.parseEther("33") + 7n;
    await satori.transfer(addr1.address, oddAmount);
    await satori.connect(addr1).vote(streamId, oddAmount);

    expect(await voting.weightOf(streamId)).to.equal(oddAmount);
    expect(await voting.totalBurnedWeight()).to.equal(oddAmount);

    // A second, WEAKER game on another non-divisible amount. There is no
    // ordering and no bar to clear — both simply carry their exact weight, and
    // the running total is their exact sum.
    const odd2 = ethers.parseEther("17");
    await satori.transfer(addr2.address, odd2);
    const tx2 = await satori.createSimpleDataStream("LTC/USD", owner.address);
    const streamId2 = await getStreamIdFromTx(tx2, satori);
    await satori.connect(addr2).vote(streamId2, odd2);

    expect(await voting.weightOf(streamId2)).to.equal(odd2);
    expect(await voting.totalBurnedWeight()).to.equal(oddAmount + odd2); // 50e18 + 7 wei

    // The default game's derived weight is d = total * 100 / 9900 (1% of the
    // denominator that includes itself). At this small total, 1% of 50e18+7 is
    // ~0.505e18 — UNDER the 1e18 floor — so the contract clamps to exactly the
    // 1e18 floor. Genesis is non-zero; it never rounds up or over-issues.
    expect(await voting.defaultDerivedWeight()).to.equal(ethers.parseEther("1"));
    expect(await voting.weightOf(1)).to.equal(ethers.parseEther("1"));
  });

  it("Should handle extreme streak values", async function() {

    const tx = await satori.createSimpleDataStream("TEST/USD", owner.address);
    const streamId = await getStreamIdFromTx(tx, satori);

    // Make stream eligible, keeping plenty of balance to predict with
    await satori.transfer(addr1.address, ethers.parseEther("200"));
    await voteFor(satori, addr1, streamId);

    // Build up a streak. Each iteration writes an anchor value + predicts UP,
    // then writes a higher value one cadence period later, so every prediction
    // is correct. A cadence-2 stream is NOT on the A-B-C window (SatoriEngine:
    // `isABC = minCadenceRounds <= 1`) — a prediction resolves against the value
    // at its own round versus the NEXT value written — and settlement is lazy:
    // each predict settles exactly one older pending prediction.
    for (let i = 0; i < 5; i++) {
      await time.increase(CADENCE_SECONDS);

      // Set initial value
      await registry.setValue(streamId, 1000 + i * 100);

      // Make prediction (UP)
      await satori.connect(addr1).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(1) }]);

      // Move to the next cadence slot
      await time.increase(CADENCE_SECONDS);

      // Set higher value (correct prediction)
      await registry.setValue(streamId, 1000 + i * 100 + 50);
    }

    // 5 predictions were made; predictions 2..5 each settled the one before
    // them, so 4 have scored — all correct — and the 5th is still pending.
    const streak = await satori.streaks(addr1.address, streamId);
    expect(streak).to.equal(4);

    // Skip a whole cadence slot: no value written, no prediction made.
    await time.increase(CADENCE_SECONDS);

    // Make another prediction after the skip. This settles prediction 5
    // (anchor 1400, next value 1450 → correct), taking the streak to 5.
    await time.increase(CADENCE_SECONDS);
    await registry.setValue(streamId, 2000);
    await satori.connect(addr1).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(1) }]);
    expect(await satori.streaks(addr1.address, streamId)).to.equal(5);

    // One more value, so the prediction just made has something to resolve
    // against...
    await time.increase(CADENCE_SECONDS);
    await registry.setValue(streamId, 2100); // Make it correct

    // ...and one more prediction to trigger its settlement.
    await time.increase(CADENCE_SECONDS);
    await registry.setValue(streamId, 2200);
    await satori.connect(addr1).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(1) }]);

    // The streak keeps building across the skipped slot: an unbroken run of
    // correct calls is never reset by simply not predicting for a while.
    const streakAfterSkip = await satori.streaks(addr1.address, streamId);
    expect(streakAfterSkip).to.equal(6);
  });

  it("Should handle zero-balance edge cases", async function() {

    const tx = await satori.createSimpleDataStream("ZERO/TEST", owner.address);
    const streamId = await getStreamIdFromTx(tx, satori);

    // addr4 has zero balance - cannot vote, because voting BURNS.
    const balanceBefore = await satori.balanceOf(addr4.address);
    expect(balanceBefore).to.equal(0);

    // Not "a vote with no weight" any more — a vote with nothing to burn simply
    // cannot be cast.
    await expect(satori.connect(addr4).vote(streamId, 1n)).to.be.reverted;

    // Nobody bought the stream any weight, so it is not eligible.
    expect(await voting.weightOf(streamId)).to.equal(0n);
    expect(await voting.isEligible(streamId)).to.be.false;

    // CAN predict, on both counts. An ineligible stream is deliberately
    // predictable — that is how the protocol sources calls on streams that do not
    // yet pay (audit F16) — and the zero-power entry gate is gone, since a wallet
    // with nothing earns nothing and cannot grow a streak anyway
    // (docs/design/farming-threshold.md).
    await time.increase(86400);
    await registry.setValue(streamId, 100);
    await expect(
      satori.connect(addr4).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(1) }])
    ).to.not.be.reverted;

    // And it bought them nothing: no weight committed, so no reward can follow.
    expect(await rewards.getPredictionPower(addr4.address)).to.equal(0n);
  });

  describe("Failure Recovery Tests", function() {
    it("Should recover when every created game becomes ineligible", async function() {

      // Create 3 streams
      const streams = [];
      for (let i = 0; i < 3; i++) {
        const tx = await satori.createSimpleDataStream(`Stream ${i}`, owner.address);
        const streamId = await getStreamIdFromTx(tx, satori);
        streams.push(streamId);
      }

      console.log(`\n=== Created 3 streams: ${streams.join(', ')} ===`);

      // addr1 holds most of the bootstrap and burns for stream[0] — eligible.
      const INITIAL_MINT = await satori.INITIAL_MINT();
      await satori.transfer(addr1.address, (INITIAL_MINT * 3n) / 4n);
      await voteFor(satori, addr1, streams[0]);

      expect(await voting.isEligible(streams[0])).to.be.true;
      expect(await voting.totalBurnedWeight()).to.equal(VOTE);

      await time.increase(86400); // Round 1 → 2 (we start at round 1)
      console.log("Round 1 → 2");

      // Burnt weight is PERMANENT: the tokens that bought it no longer exist, so
      // moving a balance around can no longer strip a game of its weight.
      const stash = await satori.balanceOf(addr1.address);
      await satori.connect(addr1).transfer(addr3.address, stash);
      expect(await voting.isEligible(streams[0])).to.be.true;

      // The one lever that takes a game out of the earning set is the rewards
      // admin's disable switch.
      await voting.connect(owner).setGameApproved(streams[0], false);
      for (const s of streams) expect(await voting.isEligible(s)).to.be.false;
      expect(await voting.totalBurnedWeight()).to.equal(0n);
      console.log("All created games disabled");

      // System should still function (round can close)
      const roundBefore = await satori.getCurrentRound();
      await time.increase(86400);
      console.log("Round advanced (no eligible streams)");

      const currentRound = await satori.getCurrentRound();
      expect(currentRound).to.be.greaterThan(roundBefore);

      // Recovery: re-enabling restores the EXACT weight that was burnt.
      await voting.connect(owner).setGameApproved(streams[0], true);
      expect(await voting.isEligible(streams[0])).to.be.true;
      expect(await voting.weightOf(streams[0])).to.equal(VOTE);
      expect(await voting.totalBurnedWeight()).to.equal(VOTE);
      console.log("Stream 0 re-enabled with its weight intact");

      // Verify system fully recovered
      await satori.transfer(addr2.address, ethers.parseEther("100"));
      await registry.setValue(streams[0], 100);
      await satori.connect(addr2).predictMultipleWithPayloads([{ gameId: streams[0], payload: pack1(1) }]);
      await time.increase(86400);

      console.log("✓ System recovered - predictions and rounds working");
      const finalRound = await satori.getCurrentRound();
      expect(finalRound).to.be.greaterThan(currentRound);
    });

    it("Should handle rounds with zero predictions gracefully", async function() {

      const tx = await satori.createSimpleDataStream("ETH/USD", owner.address);
      const streamId = await getStreamIdFromTx(tx, satori);

      console.log(`\n=== Testing zero-prediction rounds with stream ${streamId} ===`);

      // Make stream eligible
      const INITIAL_MINT = await satori.INITIAL_MINT();
      await satori.transfer(addr1.address, (INITIAL_MINT * 3n) / 4n);
      await voteFor(satori, addr1, streamId);

      const round1 = await satori.getCurrentRound();
      await time.increase(86400);
      console.log("Round advanced");

      // No one makes predictions - just close the round
      await time.increase(86400);
      console.log("Round advanced (zero predictions)");

      // Verify:
      // - Round closed successfully
      // - No rewards distributed (no predictions)
      // - System remains stable

      const currentRound = await satori.getCurrentRound();
      expect(currentRound).to.be.greaterThan(round1);
      console.log(`✓ Round closed successfully`);

      // Verify system still functional - make a prediction
      await registry.setValue(streamId, 1000); // Set initial value
      await satori.transfer(addr2.address, ethers.parseEther("100"));
      await satori.connect(addr2).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(1) }]);

      await time.increase(86400);
      const finalRound = await satori.getCurrentRound();
      expect(finalRound).to.be.greaterThan(currentRound);
      console.log("✓ System remains functional after zero-prediction round");
    });

    it("Should handle creating stream with zero address authority", async function () {
      console.log("\n=== Testing zero address authority ===");

      // Attempt to create stream with zero address authority
      // This should either:
      // a) Revert with error (preferred)
      // b) Default to msg.sender

      await expect(
        satori.createSimpleDataStream("Test", ethers.ZeroAddress)
      ).to.be.reverted;

      console.log("✓ Zero address authority properly rejected");
    });

    it("Should handle prediction after stream becomes ineligible", async function() {

      const tx = await satori.createSimpleDataStream("ETH/USD", owner.address);
      const streamId = await getStreamIdFromTx(tx, satori);

      console.log(`\n=== Testing prediction on ineligible stream ${streamId} ===`);

      // Make stream eligible
      const INITIAL_MINT = await satori.INITIAL_MINT();
      await satori.transfer(addr1.address, (INITIAL_MINT * 3n) / 4n);
      await voteFor(satori, addr1, streamId);

      expect(await voting.isEligible(streamId)).to.be.true;

      await time.increase(86400); // Round 1 → 2
      console.log("Round 1 → 2");

      // Set initial value for the stream
      await registry.setValue(streamId, 1000);

      // Stream is eligible, make prediction
      await satori.transfer(addr2.address, ethers.parseEther("100"));
      const predictionRound = await satori.getCurrentRound();
      await satori.connect(addr2).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(1) }]);
      console.log("✓ Prediction made while stream eligible");

      // The rewards admin switches the game off — its weight stops earning.
      await voting.connect(owner).setGameApproved(streamId, false);
      expect(await voting.isEligible(streamId)).to.be.false;
      expect(await voting.weightOf(streamId)).to.equal(0n);
      console.log("Stream disabled");

      // Close round
      await time.increase(86400);
      console.log("Round advanced");

      // Even though the game was switched off, the prediction was made when it
      // was eligible — the record itself survives untouched.
      const prediction = await satori.predictions(addr2.address, streamId, predictionRound);
      expect(prediction.rawPredictionPower).to.be.greaterThan(0);
      console.log(`✓ Prediction preserved (power: ${ethers.formatEther(prediction.rawPredictionPower)})`);

      // System should still be functional
      const newRound = await satori.getCurrentRound();
      expect(newRound).to.be.greaterThan(predictionRound);
      console.log("✓ System remains stable");
    });

    it("Should handle zero eligible streams gracefully", async function() {

      console.log("\n=== Testing system with zero eligible streams ===");

      // Create streams but don't vote on them
      const tx1 = await satori.createSimpleDataStream("Stream 1", owner.address);
      const stream1 = await getStreamIdFromTx(tx1, satori);

      const tx2 = await satori.createSimpleDataStream("Stream 2", owner.address);
      const stream2 = await getStreamIdFromTx(tx2, satori);

      console.log(`Created streams: ${stream1}, ${stream2}`);

      // Verify no created stream is eligible — nothing was burnt for them.
      expect(await voting.isEligible(stream1)).to.be.false;
      expect(await voting.isEligible(stream2)).to.be.false;
      expect(await voting.totalBurnedWeight()).to.equal(0n);
      // The default game is the floor of the system: it is eligible from genesis
      // by construction and cannot be voted away.
      expect(await voting.isEligible(1)).to.be.true;
      console.log(`✓ Zero eligible created streams confirmed`);

      // System should still allow round closing
      const round1 = await satori.getCurrentRound();
      await time.increase(86400);
      const round2 = await satori.getCurrentRound();
      expect(round2).to.be.greaterThan(round1);
      console.log("✓ Round closed with zero eligible streams");

      // Another round
      await time.increase(86400);
      const round3 = await satori.getCurrentRound();
      expect(round3).to.be.greaterThan(round2);
      console.log("✓ Multiple rounds possible with zero eligible streams");
    });

    it("Should handle recovery from multiple failure scenarios in sequence", async function() {

      console.log("\n=== Testing sequential failure recovery ===");

      const tx = await satori.createSimpleDataStream("BTC/USD", owner.address);
      const streamId = await getStreamIdFromTx(tx, satori);

      // Distribute tokens — 2 actors share most of the bootstrap.
      // The createSimpleDataStream above consumed 14 SATORI from owner;
      // account for that in addr2's allocation to avoid an underflow.
      const INITIAL_MINT = await satori.INITIAL_MINT();
      await satori.transfer(addr1.address, INITIAL_MINT / 2n);
      await satori.transfer(addr2.address, INITIAL_MINT / 2n - ethers.parseEther("15"));

      // Start normal operation
      await voteFor(satori, addr1, streamId);
      await time.increase(86400);
      console.log("Round advanced: Normal operation");

      // Make prediction, then the game is switched off underneath it
      await registry.setValue(streamId, 100);
      await satori.connect(addr2).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(1) }]);
      await voting.connect(owner).setGameApproved(streamId, false);
      await time.increase(86400);
      console.log("Round advanced: Prediction with ineligible stream");

      // Zero predictions, zero eligible streams
      await time.increase(86400);
      console.log("Round advanced: Zero predictions, zero eligible");

      // Recovery - switch the game back on; the burnt weight is still there
      await voting.connect(owner).setGameApproved(streamId, true);
      expect(await voting.weightOf(streamId)).to.equal(VOTE);
      const recoveryRound = await satori.getCurrentRound();
      await registry.setValue(streamId, 200);
      await satori.connect(addr2).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(2) }]);
      await time.increase(86400);
      console.log("Round advanced: Recovery successful");

      // Verify system fully operational
      const finalRound = await satori.getCurrentRound();
      expect(finalRound).to.be.greaterThan(recoveryRound);

      const prediction = await satori.predictions(addr2.address, streamId, recoveryRound);
      expect(prediction.rawPredictionPower).to.be.greaterThan(0);

      console.log("✓ System recovered from multiple sequential failures");
      console.log(`  - Stream ineligibility`);
      console.log(`  - Zero predictions`);
      console.log(`  - Full recovery`);
    });

    it("Should handle attempting to predict on non-existent stream", async function() {

      console.log("\n=== Testing prediction on non-existent stream ===");

      const fakeStreamId = 99999;

      await satori.transfer(addr1.address, ethers.parseEther("100"));

      // Attempt to predict on non-existent stream
      await expect(
        satori.connect(addr1).predictMultipleWithPayloads([{ gameId: fakeStreamId, payload: pack1(1) }])
      ).to.be.reverted;

      console.log("✓ Prediction on non-existent stream properly rejected");
    });
  });
});
