/**
 * EXTENDED EDGE CASES TEST SUITE
 *
 * Tests for boundary conditions, extreme values, and unusual scenarios.
 * Critical for ensuring robustness across all possible states.
 */

const { expect } = require("chai");
const { deploySatoriFixture, RAW_TOLERANCE, pack1, VOTE, voteFor } = require("./fixtures");
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
  return satoriContract.interface.parseLog(event).args.streamId;
}

async function advanceRound() {
  const currentTime = await time.latest();
  const nextMidnight = Math.floor(currentTime / 86400) * 86400 + 86400;
  await time.increaseTo(nextMidnight + 1);
  await time.increase(86400);
}

describe("Extended Edge Cases", function () {
  let satori, token, voting, rewards, bounties, registry, engine, hub;
  let owner, alice, bob, carol, dave;
  let stream1, stream2;
  let PER_ACTOR;
  // Every actor burns exactly one VOTE in the setup below, so their spendable
  // balance is PER_ACTOR - VOTE from here on.
  let SPENDABLE;
  const UP = 1, DOWN = 2;

  beforeEach(async function () {
    [owner, alice, bob, carol, dave] = await ethers.getSigners();

    const fix = await deploySatoriFixture();
    ({ satori, token, voting, rewards, registry, bounties, engine, hub } = fix);
    owner = fix.owner;

    const tx1 = await satori.createSimpleDataStream("ETH/USD", owner.address);
    stream1 = await getStreamIdFromTx(tx1, satori);
    const tx2 = await satori.createSimpleDataStream("BTC/USD", owner.address);
    stream2 = await getStreamIdFromTx(tx2, satori);

    // PER_ACTOR = INITIAL_MINT/8 so 3 actors get 3/8 of bootstrap, owner
    // keeps 5/8 for in-test "bump" transfers.
    const INITIAL_MINT = await satori.INITIAL_MINT();
    PER_ACTOR = INITIAL_MINT / 8n;
    SPENDABLE = PER_ACTOR - VOTE;
    await satori.transfer(alice.address, PER_ACTOR);
    await satori.transfer(bob.address, PER_ACTOR);
    await satori.transfer(carol.address, PER_ACTOR);

    // Burn-backed voting: each burn buys the game permanent weight.
    await voteFor(satori, alice, stream1);
    await voteFor(satori, carol, stream1); // second backer, so stream1 outweighs stream2
    await voteFor(satori, bob, stream2);
    await advanceRound();
  });

  describe("1. Zero Balance User Actions", function () {
    it("Should allow prediction with 0 tokens, and pay nothing for it", async function () {
      // Dave has 0 tokens
      expect(await satori.balanceOf(dave.address)).to.equal(0);

      await registry.setValue(stream1, 1000);

      await expect(
        satori.connect(dave).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }])
      // A zero-power wallet is ADMITTED now. It earns nothing (weight is
      // power x multiplier) and cannot grow a streak (the farming threshold), so
      // there is nothing to gain and no reason to lock it out.
      // docs/design/farming-threshold.md; substantive coverage in
      // test/FarmingThreshold.test.js.
      ).to.not.be.reverted;
    });

    it("Should prevent voting with 0 tokens (there is nothing to burn)", async function () {
      // Weight is bought by BURNING, so a zero-balance account cannot buy any.
      // (The old vote() staked a balance and a zero balance simply carried zero
      // weight; now the burn itself fails.)
      const before = await voting.weightOf(stream1);

      await expect(
        satori.connect(dave).vote(stream1, VOTE)
      ).to.be.revertedWithCustomError(token, "ERC20InsufficientBalance");

      // A zero AMOUNT is rejected outright rather than accepted as a no-op.
      await expect(
        satori.connect(alice).vote(stream1, 0)
      ).to.be.revertedWithCustomError(voting, "ZeroVote");

      expect(await voting.weightOf(stream1)).to.equal(before);
    });

    it("Should allow claiming with 0 tokens (if has unclaimed rewards)", async function () {
      // Pile more weight onto stream1 so it clearly dominates the round.
      await voteFor(satori, bob, stream1);
      await advanceRound();

      // Setup: Alice predicts, transfers all tokens, then claims
      await registry.setValue(stream1, 1000);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      await advanceRound();
      await registry.setValue(stream1, 1100);

      await advanceRound();
      await registry.setValue(stream1, 1200);

      // Alice predicts again to trigger scoring of her first prediction
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // Advance 2 rounds to unlock Alice's balance from prediction lock
      await advanceRound();
      await advanceRound();

      // Alice transfers all remaining tokens away (but keeps her unclaimed
      // rewards). She burned one VOTE in the setup, so this is PER_ACTOR - VOTE.
      expect(await satori.balanceOf(alice.address)).to.equal(SPENDABLE);
      await satori.connect(alice).transfer(bob.address, SPENDABLE);
      expect(await satori.balanceOf(alice.address)).to.equal(0);

      // Alice can still claim her earned rewards even with 0 balance
      const claimed = await hub.connect(alice).claim.staticCall();
      expect(claimed).to.be.greaterThan(0);
    });
  });

  describe("2. Maximum Value Predictions", function () {
    it("Should handle very large prediction power", async function () {
      // Give Alice another 2× PER_ACTOR on top of her initial balance.
      await satori.transfer(alice.address, PER_ACTOR * 2n);

      // Advance to ensure we're in a fresh round with no time issues
      await advanceRound();

      // Set value and predict immediately (within same transaction block)
      await registry.setValue(stream1, 1000);
      const currentRound = await satori.getCurrentRound();

      // Predict immediately after setValue (within the 23-hour window)
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      const prediction = await satori.predictions(alice.address, stream1, currentRound);
      // Alice has PER_ACTOR (initial) - VOTE (burnt) + 2*PER_ACTOR (extra)
      expect(prediction.rawPredictionPower).to.be.closeTo(PER_ACTOR * 3n - VOTE, RAW_TOLERANCE);
    });
  });

  describe("3. Minimum Viable Prediction", function () {
    it("Should allow prediction with 1 wei", async function () {
      // Transfer almost all tokens away, leaving 1 wei
      await satori.connect(alice).transfer(bob.address, SPENDABLE - 1n);

      expect(await satori.balanceOf(alice.address)).to.equal(1);

      await registry.setValue(stream1, 1000);
      const currentRound = await satori.getCurrentRound();
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      const prediction = await satori.predictions(alice.address, stream1, currentRound);
      expect(prediction.rawPredictionPower).to.be.closeTo(1, RAW_TOLERANCE);
    });
  });

  describe("4. Stream with Zero Weight", function () {
    it("Should allow predictions on a stream nobody has burnt for (to settle orphaned predictions)", async function () {
      // Burnt weight is permanent, so a game can no longer *lose* its weight to
      // a vote switch. The zero-weight case is now a game nobody has backed.
      const tx3 = await satori.createSimpleDataStream("SOL/USD", owner.address);
      const stream3 = await getStreamIdFromTx(tx3, satori);

      expect(await voting.weightOf(stream3)).to.equal(0);
      expect(await voting.isEligible(stream3)).to.equal(false);

      // Predictions are still permitted — the gating happens at reward time
      // (nothing is recorded for the round, so there is no numerator to earn on).
      await registry.setValue(stream3, 1000);
      const round = await satori.getCurrentRound();
      await expect(
        satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream3, payload: pack1(UP) }])
      ).to.emit(engine, "PredictionMade");

      expect(await voting.getGameVotesAtRound(stream3, round)).to.equal(0);
      expect((await satori.predictions(alice.address, stream3, round)).eligible).to.equal(false);
    });

    it("Should allow predictions on a DISABLED game, which also earns nothing", async function () {
      // Disabling is the only way a game's weight can go away now.
      await voting.connect(owner).setGameApproved(stream1, false);
      expect(await voting.weightOf(stream1)).to.equal(0);
      expect(await voting.isEligible(stream1)).to.equal(false);

      await registry.setValue(stream1, 1000);
      const round = await satori.getCurrentRound();
      await expect(
        satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }])
      ).to.emit(engine, "PredictionMade");

      // recordGameVotesForRound is a no-op for a disabled game, so it never
      // enters the round's denominator and can never be scored.
      expect(await voting.getGameVotesAtRound(stream1, round)).to.equal(0);
      expect((await satori.predictions(alice.address, stream1, round)).eligible).to.equal(false);
    });
  });

  describe("5. All Users Predict One Direction", function () {
    it("Should handle 100% UP predictions", async function () {
      await registry.setValue(stream1, 1000);

      // Everyone predicts UP
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);
      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);
      await satori.connect(carol).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      await advanceRound();
      await registry.setValue(stream1, 1100); // UP is correct

      await advanceRound();
      await registry.setValue(stream1, 1200);
      // Finalize all three predictions so the per-(stream, round) gate releases.
      // (Round-4 refactor: claims halt until every prediction on the round is scored;
      //  this avoids the cross-user totalWeight drift that previously over-minted.)
      await satori.settlePrediction(alice.address, stream1);
      await satori.settlePrediction(bob.address, stream1);
      await satori.settlePrediction(carol.address, stream1);

      // Everyone should get proportional rewards
      await satori.connect(alice).claim();
      await satori.connect(bob).claim();
      await satori.connect(carol).claim();

      // SPENDABLE is exactly Alice's pre-claim balance, so this still proves she
      // was paid something.
      expect(await satori.balanceOf(alice.address)).to.be.greaterThan(SPENDABLE);
    });

    it("Should handle 100% wrong predictions (no rewards)", async function () {
      await registry.setValue(stream1, 1000);

      // Everyone predicts UP
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);
      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      await advanceRound();
      await registry.setValue(stream1, 900); // DOWN - everyone wrong

      await advanceRound();
      await advanceRound();

      // Nobody gets anything. The first-predictor-of-the-round bonus is gone —
      // it paid whoever bore the gas of locking the round total and sweeping the
      // eligible heap, and neither of those exists any more — so Alice's
      // being first no longer earns her the old 0.44.
      const aliceClaim = await hub.connect(alice).claim.staticCall();
      const bobClaim = await hub.connect(bob).claim.staticCall();

      expect(aliceClaim).to.equal(0);
      expect(bobClaim).to.equal(0);
    });
  });

  describe("6. Perfect Tie Scenario", function () {
    it("Should handle equal UP and DOWN predictions", async function () {
      await registry.setValue(stream1, 1000);

      // Alice predicts UP with 1000
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // Bob predicts DOWN with 1000
      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(DOWN) }]);

      await advanceRound();
      await registry.setValue(stream1, 1100); // UP wins

      await advanceRound();
      await registry.setValue(stream1, 1200);
      // Round-4 refactor: finalize both predictions before claiming so the
      // per-(stream, round) gate releases.
      await satori.settlePrediction(alice.address, stream1);
      await satori.settlePrediction(bob.address, stream1);

      // Only Alice gets rewards
      const aliceClaim = await hub.connect(alice).claim.staticCall();
      const bobClaim = await hub.connect(bob).claim.staticCall();

      expect(aliceClaim).to.be.greaterThan(0);
      expect(bobClaim).to.equal(0);
    });
  });

  describe("7. Single User System", function () {
    it("Should work correctly with only one user", async function () {
      // Only Alice participates
      await registry.setValue(stream1, 1000);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      await advanceRound();
      await registry.setValue(stream1, 1100);

      await advanceRound();
      await registry.setValue(stream1, 1200);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // Alice gets all rewards
      const claimed = await hub.connect(alice).claim.staticCall();
      expect(claimed).to.be.greaterThan(0);
    });
  });

  describe("8. Rapid Successive Actions", function () {
    it("Should handle vote+predict in same transaction block", async function () {
      await registry.setValue(stream1, 1000);

      // These happen in rapid succession. The vote goes FIRST: predicting takes
      // a transfer lock through round+1, and a vote burns tokens, so a predictor
      // cannot also vote in the same round any more.
      const currentRound = await satori.getCurrentRound();
      await voteFor(satori, alice, stream2);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // Both succeeded.
      const prediction = await satori.predictions(alice.address, stream1, currentRound);
      expect(prediction.direction).to.equal(UP);
      expect(await voting.weightOf(stream2)).to.equal(VOTE * 2n);

      // ...and the reverse order works too. A prediction lock stops you moving
      // tokens to a second address to predict again; burning DESTROYS them, so
      // it cannot fund a second prediction and is allowed through.
      const w2 = await voting.weightOf(stream2);
      await voteFor(satori, alice, stream2);
      expect(await voting.weightOf(stream2)).to.equal(w2 + VOTE);
    });
  });

  describe("9. Extreme Streak Values", function () {
    it("Should handle building a 10+ streak", async function () {
      // Make 12 correct predictions in a row to ensure all get scored
      for (let i = 0; i < 12; i++) {
        await registry.setValue(stream1, 1000 + i * 100);
        await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);
        await advanceRound();
      }

      // Additional rounds to ensure all predictions are scored
      await registry.setValue(stream1, 2200);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // Check final streak (should be at least 10)
      const streak = await satori.streaks(alice.address, stream1);
      expect(streak).to.be.greaterThanOrEqual(10);

      // Claim accumulated rewards (higher rounds weighted more by streak)
      const claimed = await hub.connect(alice).claim.staticCall();
      expect(claimed).to.be.greaterThan(0);
    });

    it("Should reset streak on wrong prediction", async function () {
      // Build streak with first correct prediction
      await registry.setValue(stream1, 1000);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);
      await advanceRound();
      await registry.setValue(stream1, 1100); // Correct

      await advanceRound();
      await registry.setValue(stream1, 1200);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]); // Triggers scoring of first prediction

      expect(await satori.streaks(alice.address, stream1)).to.equal(1);

      // Make wrong prediction to reset streak
      await advanceRound();
      await registry.setValue(stream1, 1100); // DOWN from 1200
      await advanceRound();
      await registry.setValue(stream1, 1000); // DOWN again
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(DOWN) }]); // Triggers scoring of wrong UP prediction

      // Streak should reset to 0, then this DOWN prediction will be scored later
      const streakAfter = await satori.streaks(alice.address, stream1);
      expect(streakAfter).to.equal(0);
    });
  });
});
