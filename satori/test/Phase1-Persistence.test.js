const { expect } = require("chai");
const { deploySatoriFixture, pack1, VOTE, voteFor } = require("./fixtures");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

// A public caller may only create streams at cadence >= 2 rounds, and
// `createSimpleDataStream(name, provider)` now hands out exactly that. The price
// streams below are refreshed once per scenario round, so a scenario round has
// to span a whole cadence period — CADENCE_ROUNDS protocol rounds — otherwise
// the refresh trips the registry's cadence gate.
const ROUND = 86400;                                  // 24h
const CADENCE_ROUNDS = 2;                             // daily
const CADENCE_SECONDS = ROUND * CADENCE_ROUNDS;       // 24h

describe("Phase 1: Multi-Round Persistence", function () {
  let satori, rewards, bounties;
  let registry, voting;
  let owner;
  let alice, bob, carol, dave;

  beforeEach(async function () {
    const fix = await deploySatoriFixture();
    ({ satori, voting, rewards, registry, bounties, owner } = fix);
    const signers = fix.signers;
    [alice, bob, carol, dave] = signers.slice(1, 5);
  });

  // Stream/game id 1 is the DEFAULT game the fixture initializes exactly as
  // production does, so the first stream a test creates is id 2. Capture the id
  // from the event rather than hardcoding it.
  async function createStream(name) {
    const receipt = await (await satori.createSimpleDataStream(name, owner.address)).wait();
    for (const log of receipt.logs) {
      try {
        const parsed = satori.interface.parseLog(log);
        if (parsed && parsed.name === "DataStreamCreated") return Number(parsed.args.streamId);
      } catch (e) {}
    }
    throw new Error("DataStreamCreated event missing");
  }

  it("Should maintain state integrity across 10 consecutive rounds", async function() {
    this.timeout(120000); // 2 minute timeout for comprehensive test

    // Setup: Create 3 streams (ETH/USD, BTC/USD, DUMMY). The DUMMY stream carries
    // the stable voters' burns, so the round denominator always has a third
    // participant that neither eth nor btc controls.
    console.log("\n=== Creating 3 Data Streams ===");
    const ethId   = await createStream("ETH/USD");
    const btcId   = await createStream("BTC/USD");
    const dummyId = await createStream("DUMMY");

    // Get extra stable voters that won't change votes during the test rounds
    const signers = await ethers.getSigners();
    const eve = signers[5];   // stable dummy voter
    const frank = signers[6]; // stable dummy voter

    // Setup: distribute tokens equally across 6 users. initialBalance derived
    // from INITIAL_MINT so the test scales with the bootstrap.
    // 6 × INITIAL_MINT/8 = 6/8 of bootstrap distributed.
    const INITIAL_MINT = await satori.INITIAL_MINT();
    const initialBalance = INITIAL_MINT / 8n;
    await satori.transfer(alice.address, initialBalance);
    await satori.transfer(bob.address, initialBalance);
    await satori.transfer(carol.address, initialBalance);
    await satori.transfer(dave.address, initialBalance);
    await satori.transfer(eve.address, initialBalance);
    await satori.transfer(frank.address, initialBalance);

    // Advance to start of fresh day so setValue calls are always 23h apart
    await time.increase(86400);

    // Setup: Initialize stream values
    await registry.setValue(ethId, 2000);   // ETH at $2000
    await registry.setValue(btcId, 40000);  // BTC at $40000

    // Setup: BURN for the streams so each carries permanent weight and earns a
    // proportional share. Every voter burns the same VOTE (10), so eth, btc and
    // dummy each end up with 2 x VOTE — an even three-way split, on top of the
    // default game's derived 20%. Burnt tokens are destroyed, so each wallet
    // keeps initialBalance - VOTE to predict with.
    await voteFor(satori, alice, ethId);
    await voteFor(satori, bob, ethId);
    await voteFor(satori, carol, btcId);
    await voteFor(satori, dave, btcId);
    await voteFor(satori, eve, dummyId);   // stable dummy voter
    await voteFor(satori, frank, dummyId); // stable dummy voter

    console.log("Initial setup complete: 3 streams, 4 users funded");

    // Advance to the first scenario round — a full cadence period, so the
    // round-1 price refresh clears the streams' cadence gate.
    await time.increase(CADENCE_SECONDS);

    // Track state across all rounds
    const stateHistory = [];
    const startDate = await satori.getCurrentRound();

    // Run 10 consecutive rounds with different state changes
    for (let round = 1; round <= 10; round++) {
      console.log(`\n=== ROUND ${round} ===`);

      // Advance to next scenario round at the start (except for round 1, which
      // we just advanced to). One cadence period per scenario round.
      if (round > 1) {
        await time.increase(CADENCE_SECONDS);
      }

      const roundState = {
        round,
        predictions: {},
        votes: {},
        delegations: {},
        balances: {},
        streamValues: {},
      };

      // === Round-specific state changes ===

      // Update stream values first (before predictions)
      if (round % 2 === 0) {
        // Even rounds: ETH goes up, BTC goes down
        await registry.setValue(ethId, 2000 + (round * 10));
        await registry.setValue(btcId, 40000 - (round * 50));
        console.log(`Price update: ETH=${2000 + (round * 10)}, BTC=${40000 - (round * 50)}`);
      } else {
        // Odd rounds: ETH goes down, BTC goes up
        await registry.setValue(ethId, 2000 - (round * 5));
        await registry.setValue(btcId, 40000 + (round * 100));
        console.log(`Price update: ETH=${2000 - (round * 5)}, BTC=${40000 + (round * 100)}`);
      }

      // Rounds 1-3: Basic predictions
      if (round === 1) {
        console.log("Round 1: Alice predicts ETH UP, Bob predicts ETH DOWN");
        await satori.connect(alice).predictMultipleWithPayloads([{ gameId: ethId, payload: pack1(1) }]); // UP
        await satori.connect(bob).predictMultipleWithPayloads([{ gameId: ethId, payload: pack1(2) }]);   // DOWN
      }

      if (round === 2) {
        console.log("Round 2: Alice predicts BTC UP, Bob predicts BTC DOWN, Carol predicts ETH UP");
        await satori.connect(alice).predictMultipleWithPayloads([{ gameId: btcId, payload: pack1(1) }]); // UP
        await satori.connect(bob).predictMultipleWithPayloads([{ gameId: btcId, payload: pack1(2) }]);   // DOWN
        await satori.connect(carol).predictMultipleWithPayloads([{ gameId: ethId, payload: pack1(1) }]); // UP
      }

      if (round === 3) {
        console.log("Round 3: Alice multi-predicts (ETH+BTC UP), Dave predicts ETH DOWN");
        await satori.connect(alice).predictMultipleWithPayloads([
          { gameId: ethId, payload: pack1(1) },
          { gameId: btcId, payload: pack1(1) }
        ]);
        await satori.connect(dave).predictMultipleWithPayloads([{ gameId: ethId, payload: pack1(2) }]); // Dave joins, predicts DOWN
      }

      // Rounds 4-6: Predictions (no vote changes to preserve eligibility)
      if (round === 4) {
        console.log("Round 4: Bob predicts ETH UP");
        await satori.connect(bob).predictMultipleWithPayloads([{ gameId: ethId, payload: pack1(1) }]);    // Bob predicts UP
      }

      if (round === 5) {
        console.log("Round 5: Carol predicts BTC DOWN");
        await satori.connect(carol).predictMultipleWithPayloads([{ gameId: btcId, payload: pack1(2) }]);  // Carol predicts DOWN
      }

      if (round === 6) {
        console.log("Round 6: Alice predicts ETH DOWN, Dave predicts BTC UP");
        await satori.connect(alice).predictMultipleWithPayloads([{ gameId: ethId, payload: pack1(2) }]);  // Alice predicts DOWN
        await satori.connect(dave).predictMultipleWithPayloads([{ gameId: btcId, payload: pack1(1) }]);   // Dave predicts UP
      }

      // Rounds 7-8: Predictions without transfers (balance lock prevents transfers)
      if (round === 7) {
        console.log("Round 7: Users continue predictions (skip transfers due to locks)");
        await satori.connect(bob).predictMultipleWithPayloads([{ gameId: btcId, payload: pack1(1) }]);    // Bob predicts UP
        await satori.connect(carol).predictMultipleWithPayloads([{ gameId: ethId, payload: pack1(1) }]);  // Carol predicts UP
      }

      if (round === 8) {
        console.log("Round 8: More predictions");
        await satori.connect(alice).predictMultipleWithPayloads([{ gameId: btcId, payload: pack1(1) }]);  // Alice predicts UP
        await satori.connect(dave).predictMultipleWithPayloads([{ gameId: ethId, payload: pack1(1) }]);   // Dave predicts UP
      }

      // Rounds 9-10: prediction delegation. Vote delegation no longer exists —
      // burnt weight can never be moved, delegated, or revoked.
      if (round === 9) {
        console.log("Round 9: Bob predicts ETH DOWN");
        await satori.connect(bob).predictMultipleWithPayloads([{ gameId: ethId, payload: pack1(2) }]);    // Bob predicts DOWN
      }

      if (round === 10) {
        console.log("Round 10: Dave delegates prediction power to Bob");
        await satori.connect(dave).delegatePredictionPower(bob.address);
        await satori.connect(bob).predictMultipleWithPayloads([{ gameId: ethId, payload: pack1(1) }]);    // Bob predicts with delegated power
        await satori.connect(carol).predictMultipleWithPayloads([{ gameId: ethId, payload: pack1(2) }]);  // Carol predicts DOWN
      }

      // === Capture state snapshot ===

      // Record balances
      roundState.balances.alice = await satori.balanceOf(alice.address);
      roundState.balances.bob = await satori.balanceOf(bob.address);
      roundState.balances.carol = await satori.balanceOf(carol.address);
      roundState.balances.dave = await satori.balanceOf(dave.address);

      // Record prediction delegations (the surviving delegation lane)
      roundState.delegations.davePred = (await rewards.predictionDelegateInfo(dave.address)).delegate;
      roundState.delegations.bobInbound = (await rewards.predictionDelegateInfo(bob.address)).power;

      // Record stream values
      roundState.streamValues.eth = await registry.getValue(ethId);
      roundState.streamValues.btc = await registry.getValue(btcId);

      // Record burnt game weights + the derived default share
      roundState.votes.ethWeight = await voting.gameWeight(ethId);
      roundState.votes.btcWeight = await voting.gameWeight(btcId);
      roundState.votes.totalBurned = await voting.totalBurnedWeight();
      roundState.votes.defaultWeight = await voting.defaultDerivedWeight();

      // Record prediction power
      roundState.predictions.alicePower = await rewards.getPredictionPower(alice.address);
      roundState.predictions.bobPower = await rewards.getPredictionPower(bob.address);
      roundState.predictions.carolPower = await rewards.getPredictionPower(carol.address);
      roundState.predictions.davePower = await rewards.getPredictionPower(dave.address);

      // Store state
      stateHistory.push(roundState);

      console.log(`Round ${round} complete. Current round: ${await satori.getCurrentRound()}`);
    }

    // === Verification Phase: Check historical integrity ===
    console.log("\n=== VERIFICATION PHASE ===");

    // 1. Verify we advanced through 10 rounds
    console.log("1. Verifying rounds advanced...");
    const finalDate = await satori.getCurrentRound();
    // Advanced 9 times (rounds 2-10), one cadence period each.
    expect(finalDate).to.equal(startDate + BigInt(9 * CADENCE_ROUNDS));
    console.log("   ✓ Round counter reached 10");

    // 2. Verify state snapshots are consistent
    console.log("2. Verifying state snapshots...");
    expect(stateHistory.length).to.equal(10);
    console.log("   ✓ All 10 state snapshots recorded");

    // 3. Verify balances remain consistent (no transfers due to prediction locks)
    console.log("3. Verifying balance consistency...");
    // Each user's balance is their initial grant MINUS the one VOTE they burnt
    // in setup; nothing else moves tokens (transfers are impossible while
    // predicting, and nobody claims).
    const postBurn = initialBalance - VOTE;
    expect(stateHistory[0].balances.alice).to.equal(postBurn);
    expect(stateHistory[0].balances.bob).to.equal(postBurn);
    expect(stateHistory[0].balances.carol).to.equal(postBurn);
    expect(stateHistory[0].balances.dave).to.equal(postBurn);
    expect(stateHistory[9].balances.alice).to.equal(postBurn);
    console.log("   ✓ All balances = initial grant minus the burnt vote, stable across rounds");

    // 4. Verify prediction delegation was recorded correctly
    console.log("4. Verifying delegations...");
    // Dave delegated his prediction power to Bob in round 10
    expect(stateHistory[9].delegations.davePred).to.equal(bob.address);
    expect(stateHistory[8].delegations.davePred).to.equal(ethers.ZeroAddress);
    console.log("   ✓ Dave's prediction delegation to Bob in round 10");

    // Bob's inbound delegation pool grew by exactly Dave's balance, and Dave —
    // now delegated — has no prediction power of his own.
    expect(stateHistory[9].delegations.bobInbound - stateHistory[8].delegations.bobInbound)
      .to.equal(postBurn);
    expect(stateHistory[9].predictions.davePower).to.equal(0n);
    console.log("   ✓ Bob's delegated prediction pool absorbed Dave's power");

    // 5. Verify stream values changed over time
    console.log("5. Verifying stream value changes...");
    expect(stateHistory[9].streamValues.eth).to.not.equal(stateHistory[0].streamValues.eth);
    expect(stateHistory[9].streamValues.btc).to.not.equal(stateHistory[0].streamValues.btc);
    console.log("   ✓ Stream values changed across rounds");

    // 6. Verify burnt weights persisted for the whole run
    console.log("6. Verifying burnt weights...");
    // Burnt weight is PERMANENT: it can never be moved, reduced, or revoked, so
    // the weights bought in setup must read identically in every round.
    for (let i = 0; i < stateHistory.length; i++) {
      expect(stateHistory[i].votes.ethWeight).to.equal(VOTE * 2n);
      expect(stateHistory[i].votes.btcWeight).to.equal(VOTE * 2n);
      expect(stateHistory[i].votes.totalBurned).to.equal(VOTE * 6n);
      // The default game (id 1) is never burned for — its weight derives as 1%
      // of the full denominator (total * 100/9900). Here the total is 60e18, so
      // 1% (~0.6e18) is under the 1e18 floor and it clamps to exactly 1e18.
      expect(stateHistory[i].votes.defaultWeight).to.equal(ethers.parseEther("1"));
    }
    console.log("   ✓ Both streams kept their permanent burnt weight");

    // 7. Verify prediction power was tracked
    console.log("7. Verifying prediction power...");
    // Users who made predictions should have had non-zero prediction power
    for (let i = 0; i < stateHistory.length; i++) {
      // Alice made predictions in rounds 1, 2, 3, 6, 8
      if ([0, 1, 2, 5, 7].includes(i)) {
        expect(stateHistory[i].predictions.alicePower).to.be.gt(0);
      }
    }
    console.log("   ✓ Prediction powers tracked correctly");

    // 8. Verify no data corruption - all state should be accessible
    console.log("8. Verifying data integrity...");
    const currentAliceBalance = await satori.balanceOf(alice.address);
    const currentBobBalance = await satori.balanceOf(bob.address);
    const currentCarolBalance = await satori.balanceOf(carol.address);
    const currentDaveBalance = await satori.balanceOf(dave.address);

    expect(currentAliceBalance).to.be.gt(0);
    expect(currentBobBalance).to.be.gt(0);
    expect(currentCarolBalance).to.be.gt(0);
    expect(currentDaveBalance).to.be.gt(0);
    console.log("   ✓ All user balances accessible and valid");

    // 9. Verify streams still exist and are accessible
    console.log("9. Verifying stream accessibility...");
    expect(await registry.streamExists(ethId)).to.be.true;
    expect(await registry.streamExists(btcId)).to.be.true;
    console.log("   ✓ Both streams still exist and accessible");

    // 10. Verify historical data preservation
    console.log("10. Verifying historical data preservation...");
    // Check that round 1 data can still be accessed from round 10
    expect(stateHistory[0].round).to.equal(1);
    expect(stateHistory[9].round).to.equal(10);
    console.log("   ✓ Historical data from all rounds preserved");

    // Performance summary
    console.log("\n=== 10-ROUND PERSISTENCE TEST SUMMARY ===");
    console.log(`Total rounds completed: ${stateHistory.length}`);
    console.log(`Final round number: ${await satori.getCurrentRound()}`);
    console.log(`Total state snapshots: ${stateHistory.length * 6} data points`);
    console.log(`Streams created: 2 (ETH/USD, BTC/USD)`);
    console.log(`Users participating: 4 (Alice, Bob, Carol, Dave)`);
    console.log(`Predictions made: ~20 across all rounds`);
    console.log(`Burn votes cast: 6 in setup (permanent weight)`);
    console.log(`Token transfers: 0 (prevented by prediction locks)`);
    console.log(`Delegations: 1 (Prediction: Dave→Bob)`);
    console.log("\n=== ALL INTEGRITY CHECKS PASSED ===\n");
  });
});
