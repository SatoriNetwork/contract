const { expect } = require("chai");
const { deploySatoriFixture, pack1, VOTE, voteFor } = require("./fixtures");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

// The fixture now initializes the DEFAULT stream at id 1 (exactly as production
// deploys it), so the first stream a test creates is id 2. Capture ids from the
// event rather than assuming.
async function getStreamIdFromTx(tx, satori) {
  const receipt = await tx.wait();
  const ev = receipt.logs.find(l => {
    try { return satori.interface.parseLog(l)?.name === "DataStreamCreated"; }
    catch { return false; }
  });
  if (!ev) throw new Error("DataStreamCreated event not found");
  return Number(satori.interface.parseLog(ev).args.streamId);
}

async function advanceToNextRound() {
  const currentTime = await time.latest();
  const nextMidnight = Math.floor(currentTime / 86400) * 86400 + 86400;
  await time.increaseTo(nextMidnight + 1);
}

// `createSimpleDataStream(name, provider)` hands out a 1440-minute stream —
// an EVERY-ROUND stream under 24h rounds. The three price streams below can
// be written once per round, so each "competition round" in this scenario is
// one protocol round: values are refreshed at the top of each round.
const CADENCE_ROUNDS = 1;

async function advanceCadence() {
  for (let i = 0; i < CADENCE_ROUNDS; i++) await advanceToNextRound();
}

describe("Phase 1: Multi-User Competition Tests", function () {
  let satori, rewards, bounties;
  let registry, voting;
  let owner;

  beforeEach(async function () {
    const fix = await deploySatoriFixture();
    ({ satori, rewards, bounties, registry, voting, owner } = fix);
  });

  describe("8-User Competition Test", function () {
    it("Should handle 8 users competing across 3 streams over 5 rounds", async function () {
      this.timeout(120000); // Increase timeout to 2 minutes

      // Get all 8 users
      const signers = await ethers.getSigners();
      const users = {
        alice: signers[1],
        bob: signers[2],
        carol: signers[3],
        dave: signers[4],
        eve: signers[5],
        frank: signers[6],
        grace: signers[7],
        henry: signers[8]
      };

      console.log("\n=== 8-USER COMPETITION TEST ===");

      // ========== SETUP ==========
      console.log("\n--- SETUP ---");

      // Enable test mode for rapid rounds
      console.log("Test mode enabled");

      // Create 3 streams (ETH/USD, BTC/USD, SOL/USD)
      const ethTx = await satori.createSimpleDataStream("ETH/USD", owner.address);
      const btcTx = await satori.createSimpleDataStream("BTC/USD", owner.address);
      const solTx = await satori.createSimpleDataStream("SOL/USD", owner.address);

      const streamIds = {
        eth: await getStreamIdFromTx(ethTx, satori),
        btc: await getStreamIdFromTx(btcTx, satori),
        sol: await getStreamIdFromTx(solTx, satori),
      };
      console.log(`Created 3 streams: ETH/USD (${streamIds.eth}), BTC/USD (${streamIds.btc}), SOL/USD (${streamIds.sol})`);

      // Advance to start of a fresh day so subsequent setValue calls
      // are always at least 23.5 hours apart (each advanceToNextRound is ~86400s).
      await advanceToNextRound();

      // Set initial stream values
      await registry.setValue(streamIds.eth, 2000);  // $2000
      await registry.setValue(streamIds.btc, 40000); // $40000
      await registry.setValue(streamIds.sol, 100);   // $100
      console.log("Set initial values: ETH=$2000, BTC=$40000, SOL=$100");

      // Distribute equal shares of INITIAL_MINT to all 8 users.
      // INITIAL_MINT/12 keeps the sum (8/12 of bootstrap) well under the cap.
      const INITIAL_MINT = await satori.INITIAL_MINT();
      const tokenAmount = INITIAL_MINT / 12n;
      for (const [name, user] of Object.entries(users)) {
        await satori.transfer(user.address, tokenAmount);
      }
      console.log("Distributed INITIAL_MINT/12 to each of 8 users");

      // Verify initial balances
      for (const [name, user] of Object.entries(users)) {
        const balance = await satori.balanceOf(user.address);
        expect(balance).to.equal(tokenAmount, `${name} should have 100 tokens`);
      }
      console.log("All balances verified");

      // Users BURN for the streams they back. Each burns one VOTE (10), so ETH
      // and BTC end on 30 apiece and SOL on 20; everyone keeps
      // tokenAmount - VOTE to predict with.
      await voteFor(satori, users.alice, streamIds.eth);
      await voteFor(satori, users.bob, streamIds.eth);
      await voteFor(satori, users.carol, streamIds.btc);
      await voteFor(satori, users.dave, streamIds.btc);
      await voteFor(satori, users.eve, streamIds.sol);
      await voteFor(satori, users.frank, streamIds.sol);
      await voteFor(satori, users.grace, streamIds.eth);
      await voteFor(satori, users.henry, streamIds.btc);
      console.log("All users burned for streams");

      expect(await voting.weightOf(streamIds.eth)).to.equal(VOTE * 3n);
      expect(await voting.weightOf(streamIds.btc)).to.equal(VOTE * 3n);
      expect(await voting.weightOf(streamIds.sol)).to.equal(VOTE * 2n);
      expect(await satori.balanceOf(users.alice.address)).to.equal(tokenAmount - VOTE);

      // There is no threshold and no top-N any more: every enabled game with
      // weight earns, in proportion. So SOL is eligible too, on 1/4 of the
      // burnt weight rather than shut out for placing third.
      expect(await voting.isEligible(streamIds.eth)).to.equal(true);
      expect(await voting.isEligible(streamIds.btc)).to.equal(true);
      expect(await voting.isEligible(streamIds.sol)).to.equal(true);
      // The default game (id 1) derives 1% of the round (total * 100/9900). At
      // 80e18 burnt, 1% (~0.8e18) is under the 1e18 floor, so it clamps to 1e18.
      expect(await voting.totalBurnedWeight()).to.equal(VOTE * 8n);
      expect(await voting.defaultDerivedWeight()).to.equal(ethers.parseEther("1"));
      console.log("All three streams eligible; default derives 1% (floored at 1e18)");

      // Advance to round 1 for predictions. One full cadence period, so the
      // round-1 value refresh below clears the streams' cadence gate.
      await advanceCadence();
      const round1 = await satori.getCurrentRound();

      // ========== ROUND 1 ==========
      console.log("\n--- ROUND 1 ---");

      // Set new values for round 1
      await registry.setValue(streamIds.eth, 2100);
      await registry.setValue(streamIds.btc, 41000);
      await registry.setValue(streamIds.sol, 110);

      // Alice and Bob predict ETH UP
      await satori.connect(users.alice).predictMultipleWithPayloads([{ gameId: streamIds.eth, payload: pack1(1) }]);
      await satori.connect(users.bob).predictMultipleWithPayloads([{ gameId: streamIds.eth, payload: pack1(1) }]);
      console.log("Alice, Bob predict ETH UP");

      // Carol and Dave predict BTC DOWN
      await satori.connect(users.carol).predictMultipleWithPayloads([{ gameId: streamIds.btc, payload: pack1(2) }]);
      await satori.connect(users.dave).predictMultipleWithPayloads([{ gameId: streamIds.btc, payload: pack1(2) }]);
      console.log("Carol, Dave predict BTC DOWN");

      // End Round 1
      await advanceCadence();
      const round2 = await satori.getCurrentRound();
      expect(round2).to.equal(round1 + BigInt(CADENCE_ROUNDS));
      console.log("Round 1 ended");

      // ========== ROUND 2 ==========
      console.log("\n--- ROUND 2 ---");

      // Set values for round 2
      await registry.setValue(streamIds.eth, 2200);  // ETH UP
      await registry.setValue(streamIds.btc, 40000); // BTC DOWN
      await registry.setValue(streamIds.sol, 120);   // SOL UP
      console.log("Set values: ETH=$2200, BTC=$40000, SOL=$120");

      // Eve delegates prediction power to Alice.
      // Note: Eve's tokens stay on SOL vote-stream (delegation doesn't change stream weights),
      // so both ETH and BTC remain eligible.
      await satori.connect(users.eve).delegatePredictionPower(users.alice.address);
      console.log("Eve delegates prediction power to Alice");

      // Documented case 1 of getPredictionPower (docs/narratives/
      // A_prediction_delegation.md "The prediction power view"): a user who has
      // delegated AWAY has exactly zero power of their own. Pinned here because
      // the end-of-test loop can only observe the undelegated case.
      expect(await rewards.getPredictionPower(users.eve.address),
        "Eve delegated away -> 0 prediction power").to.equal(0n);
      expect((await rewards.predictionDelegateInfo(users.eve.address)).delegate,
        "Eve's prediction delegate is Alice").to.equal(users.alice.address);

      // Alice predicts ETH UP (with Eve's delegation)
      await satori.connect(users.alice).predictMultipleWithPayloads([{ gameId: streamIds.eth, payload: pack1(1) }]);
      console.log("Alice predicts ETH UP (with Eve's delegation)");

      // Bob predicts BTC DOWN
      await satori.connect(users.bob).predictMultipleWithPayloads([{ gameId: streamIds.btc, payload: pack1(2) }]);
      console.log("Bob predicts BTC DOWN");

      // Carol and Dave predict BTC UP
      await satori.connect(users.carol).predictMultipleWithPayloads([{ gameId: streamIds.btc, payload: pack1(1) }]);
      await satori.connect(users.dave).predictMultipleWithPayloads([{ gameId: streamIds.btc, payload: pack1(1) }]);
      console.log("Carol, Dave predict BTC UP");

      // End Round 2
      await advanceCadence();
      const round3 = await satori.getCurrentRound();
      expect(round3).to.equal(round2 + BigInt(CADENCE_ROUNDS));
      console.log("Round 2 ended");

      // ========== ROUND 3 ==========
      console.log("\n--- ROUND 3 ---");

      // Update stream values
      await registry.setValue(streamIds.eth, 2300);  // ETH UP
      await registry.setValue(streamIds.btc, 41000); // BTC UP
      await registry.setValue(streamIds.sol, 105);   // SOL DOWN
      console.log("Updated values: ETH=$2300 (UP), BTC=$41000 (UP), SOL=$105 (DOWN)");

      // Grace and Henry join predictions
      await satori.connect(users.grace).predictMultipleWithPayloads([{ gameId: streamIds.eth, payload: pack1(2) }]);
      await satori.connect(users.henry).predictMultipleWithPayloads([{ gameId: streamIds.btc, payload: pack1(1) }]);
      console.log("Grace predicts ETH DOWN, Henry predicts BTC UP");

      await satori.connect(users.alice).predictMultipleWithPayloads([{ gameId: streamIds.eth, payload: pack1(1) }]);
      console.log("Alice predicts ETH UP");

      await satori.connect(users.bob).predictMultipleWithPayloads([{ gameId: streamIds.btc, payload: pack1(2) }]);
      console.log("Bob predicts BTC DOWN");

      // Carol predicts multiple streams
      await satori.connect(users.carol).predictMultipleWithPayloads([
        { gameId: streamIds.eth, payload: pack1(1) },
        { gameId: streamIds.btc, payload: pack1(1) }
      ]);
      console.log("Carol predicts ETH UP, BTC UP (multiple)");

      // End Round 3
      await advanceCadence();
      const round4 = await satori.getCurrentRound();
      expect(round4).to.equal(round3 + BigInt(CADENCE_ROUNDS));
      console.log("Round 3 ended");

      // ========== ROUND 4 ==========
      console.log("\n--- ROUND 4 ---");

      // Update stream values
      await registry.setValue(streamIds.eth, 2400);  // ETH UP
      await registry.setValue(streamIds.btc, 42000); // BTC UP
      await registry.setValue(streamIds.sol, 100);   // SOL DOWN
      console.log("Updated values: ETH=$2400 (UP), BTC=$42000 (UP), SOL=$100 (DOWN)");

      // Eve undelegates (self-delegates)
      await satori.connect(users.eve).delegatePredictionPower(users.eve.address);
      console.log("Eve undelegates (cannot predict this round)");

      // Multiple users predict (kept on ETH/BTC so the round's split stays legible)
      await satori.connect(users.alice).predictMultipleWithPayloads([{ gameId: streamIds.btc, payload: pack1(1) }]);
      console.log("Alice predicts BTC UP");

      await satori.connect(users.bob).predictMultipleWithPayloads([{ gameId: streamIds.eth, payload: pack1(2) }]);
      await satori.connect(users.carol).predictMultipleWithPayloads([{ gameId: streamIds.btc, payload: pack1(1) }]);
      await satori.connect(users.dave).predictMultipleWithPayloads([{ gameId: streamIds.btc, payload: pack1(2) }]);
      await satori.connect(users.frank).predictMultipleWithPayloads([{ gameId: streamIds.eth, payload: pack1(1) }]);
      await satori.connect(users.grace).predictMultipleWithPayloads([{ gameId: streamIds.eth, payload: pack1(2) }]);
      await satori.connect(users.henry).predictMultipleWithPayloads([{ gameId: streamIds.eth, payload: pack1(1) }]);
      console.log("Bob, Carol, Dave, Frank, Grace, Henry all predict");

      // End Round 4
      await advanceCadence();
      const round5 = await satori.getCurrentRound();
      expect(round5).to.equal(round4 + BigInt(CADENCE_ROUNDS));
      console.log("Round 4 ended");

      // ========== ROUND 5 (FINAL) ==========
      console.log("\n--- ROUND 5 (FINAL) ---");

      // Update final values
      await registry.setValue(streamIds.eth, 2500);  // ETH UP
      await registry.setValue(streamIds.btc, 43000); // BTC UP
      await registry.setValue(streamIds.sol, 95);    // SOL DOWN
      console.log("Updated values: ETH=$2500 (UP), BTC=$43000 (UP), SOL=$95 (DOWN)");

      // 7 users active (Eve cannot predict - still in undelegation cooldown)
      // Kept on ETH/BTC so the round's split stays legible
      await satori.connect(users.alice).predictMultipleWithPayloads([{ gameId: streamIds.eth, payload: pack1(1) }]);
      await satori.connect(users.bob).predictMultipleWithPayloads([{ gameId: streamIds.btc, payload: pack1(2) }]);
      await satori.connect(users.carol).predictMultipleWithPayloads([{ gameId: streamIds.btc, payload: pack1(1) }]);
      await satori.connect(users.dave).predictMultipleWithPayloads([{ gameId: streamIds.eth, payload: pack1(2) }]);
      // Eve skipped - undelegated in Round 4, cannot predict until Round 6
      await satori.connect(users.frank).predictMultipleWithPayloads([{ gameId: streamIds.eth, payload: pack1(2) }]);
      await satori.connect(users.grace).predictMultipleWithPayloads([{ gameId: streamIds.eth, payload: pack1(1) }]);
      await satori.connect(users.henry).predictMultipleWithPayloads([{ gameId: streamIds.btc, payload: pack1(1) }]);
      console.log("7 users predict (Eve in undelegation cooldown)");

      // End Round 5
      await advanceCadence();
      expect(await satori.getCurrentRound()).to.equal(round5 + BigInt(CADENCE_ROUNDS));
      console.log("Round 5 ended");

      // ========== VERIFICATION ==========
      console.log("\n--- VERIFICATION ---");

      // Verify all users have consistent state
      console.log("Checking user states...");
      for (const [name, user] of Object.entries(users)) {
        const balance = await satori.balanceOf(user.address);
        expect(balance).to.be.gt(0, `${name} should still have balance`);

        // P2 (type tautology): this used to be `predictionPower >= 0`, which
        // every uint256 satisfies — it held for the entire codomain of
        // getPredictionPower, including a build that returned 0 for all eight
        // users because delegation accounting had been wiped. Pin documented
        // case 2 instead (docs/narratives/A_prediction_delegation.md): for an
        // UNDELEGATED user, power == balanceOf + unclaimedRewards + inbound
        // delegated power. Every user is undelegated by now (Eve delegated to
        // Alice in round 2 and undelegated in round 4), and Alice's inbound pool
        // is back to zero, so the expected value is balance + unclaimed exactly.
        const delegateInfo = await rewards.predictionDelegateInfo(user.address);
        expect(delegateInfo.delegate, `${name} should be undelegated`).to.equal(ethers.ZeroAddress);

        const predictionPower = await rewards.getPredictionPower(user.address);
        const unclaimed = await rewards.unclaimedRewards(user.address);
        expect(predictionPower, `${name} power == balance + unclaimedRewards`)
          .to.equal(balance + unclaimed);
      }
      console.log("All user states valid");

      // Verify stream states
      console.log("Checking stream values...");
      const ethValue = await registry.getValue(streamIds.eth);
      const btcValue = await registry.getValue(streamIds.btc);
      const solValue = await registry.getValue(streamIds.sol);

      expect(ethValue).to.equal(2500);
      expect(btcValue).to.equal(43000);
      expect(solValue).to.equal(95);
      console.log("Stream values correct: ETH=$2500, BTC=$43000, SOL=$95");

      // Verify eligibility maintained. Weight is burnt, so it is permanent —
      // nothing that happened over five rounds can have moved it.
      console.log("Checking stream eligibility...");
      expect(await voting.isEligible(streamIds.eth)).to.equal(true);
      expect(await voting.isEligible(streamIds.btc)).to.equal(true);
      expect(await voting.isEligible(streamIds.sol)).to.equal(true);

      // The heap and getEligibleGames are gone; the leaderboard is a paginated
      // game-id-ordered scan that includes the default game at id 1.
      const round = await satori.getCurrentRound();
      const [ids, weights] = await voting.getGameWeights(1, 100, round);
      console.log(`Weighted games: ${ids.join(', ')}`);
      expect(ids.map(Number)).to.deep.equal([1, streamIds.eth, streamIds.btc, streamIds.sol]);
      // Default (id 1) is the floored derived weight (1% of 80e18 is under the
      // 1e18 floor); the three burned streams carry their exact burnt weight.
      expect(weights).to.deep.equal([ethers.parseEther("1"), VOTE * 3n, VOTE * 3n, VOTE * 2n]);
      console.log("Eligibility check passed");

      // Verify burnt weight. There is no per-voter vote pointer any more (the
      // tokens that bought the weight no longer exist), so what is provable is
      // that Alice's, Bob's and Grace's burns are still sitting on ETH.
      console.log("Checking burnt weight...");
      expect(await voting.weightOf(streamIds.eth)).to.equal(VOTE * 3n);
      console.log("Alice's burn still backing ETH confirmed");

      // Verify no state corruption. Genesis creates the default stream only
      // (id 1), so the three test streams make four.
      console.log("Checking stream count...");
      const streamCount = await registry.getDataStreamCount();
      expect(streamCount).to.equal(4);

      const allStreams = await registry.getAllDataStreams();
      expect(allStreams.length).to.equal(4);
      console.log("Stream count correct: 4 (default + 3)");

      // Verify delegation state.
      // P5 (assertion that restates a constant): this used to read
      // `voting.getDelegate(eve)` and expect `eve.address` — the VOTE-delegation
      // pointer, which Eve never touched, so it was true at block zero and
      // unaffected by every action in this test. Vote delegation has since been
      // removed outright (burnt weight cannot be delegated: it belongs to the
      // game, not to a holder). Eve's undelegation lives in the PREDICTION
      // delegate slot, where self-delegation is normalized to
      // address(0) (docs/narratives/A_prediction_delegation.md:44) — assert that,
      // plus the fact that Alice no longer carries Eve's delegated power.
      console.log("Checking delegation...");
      const eveDelegation = await rewards.predictionDelegateInfo(users.eve.address);
      expect(eveDelegation.delegate, "Eve's prediction delegation is cleared").to.equal(ethers.ZeroAddress);
      const aliceDelegation = await rewards.predictionDelegateInfo(users.alice.address);
      expect(aliceDelegation.power, "Alice no longer holds Eve's delegated power").to.equal(0n);
      console.log("Eve undelegated (prediction delegate normalized to address(0))");

      console.log("\n=== TEST SUMMARY ===");
      console.log("Rounds completed: 5");
      console.log("Users tested: 8");
      console.log("Streams tested: 3");
      console.log("All state checks: PASSED");
      console.log("No conflicts detected: PASSED");
      console.log("No corruption detected: PASSED");
      console.log("\nTest behaviors covered:");
      console.log("- Single predictions");
      console.log("- Multiple predictions (batch)");
      console.log("- Burn-backed voting");
      console.log("- Prediction delegation");
      console.log("- Undelegation timing");
      console.log("- Mixed user roles");
      console.log("\n=== 8-USER COMPETITION TEST COMPLETE ===");
    });
  });
});
