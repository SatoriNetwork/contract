/**
 * RACE CONDITIONS TEST SUITE
 *
 * Systematically tests ordering of state-changing operations within the
 * same round. For each dangerous pair (A, B), tests both orderings and
 * verifies the outcomes are either identical or both correct.
 *
 * Tier 1: High risk (money / eligibility)
 *   - Vote (burn) + Predict
 *   - Transfer + Predict
 *   - Delegate prediction + Predict
 *   - Claim + Predict
 *   - (removed: setMaxEligibleStreams mid-round — setter no longer exists)
 *   - (removed: deleteStream block — streams are permanent now)
 *   - (removed: vote-delegation ordering — vote delegation no longer exists;
 *      weight is bought by burning and can never move)
 */

const { expect } = require("chai");
const { deploySatoriFixture, pack1, voteFor, VOTE } = require("./fixtures");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

// A round is 24h and a public caller may only create streams at cadence >= 2
// rounds — which is what `createSimpleDataStream(name, provider)` now hands out.
// So a "day" here is a real 24h day (CADENCE_ROUNDS rounds), which is also the
// spacing the streams below require between two value writes. The ordering
// hazards under test all play out INSIDE one round and are unaffected.
const ROUND = 86400;                            // 24h
const CADENCE_ROUNDS = 2;                       // daily

async function advanceOneDay() {
  await time.increase(ROUND * CADENCE_ROUNDS);
}

async function getStreamIdFromTx(tx, contract) {
  const receipt = await tx.wait();
  const event = receipt.logs.find(log => {
    try { return contract.interface.parseLog(log)?.name === 'DataStreamCreated'; }
    catch { return false; }
  });
  return contract.interface.parseLog(event).args.streamId;
}

describe("Race Conditions: Tier 1", function () {
  let satori, voting, rewards, bounties, registry;
  let owner, alice, bob, carol, dave;
  let stream1, stream2;
  const UP = 1;
  const DOWN = 2;

  beforeEach(async function () {
    const fix = await deploySatoriFixture();
    ({ satori, voting, rewards, bounties, registry, owner } = fix);
    [, alice, bob, carol, dave] = fix.signers;
    // The fixture already calls initializeDefaultStream() (as production does),
    // so the default stream/game occupies id 1 and S1/S2 below land at 2/3.

    // Distribute equal shares derived from INITIAL_MINT (4 × INITIAL_MINT/8
    // = half of bootstrap; preserves the equal-actor setup). Each actor burns
    // VOTE (10) below and keeps the remaining 80 to predict with.
    const INITIAL_MINT = await satori.INITIAL_MINT();
    const PER_ACTOR = INITIAL_MINT / 8n;
    await satori.transfer(alice.address, PER_ACTOR);
    await satori.transfer(bob.address, PER_ACTOR);
    await satori.transfer(carol.address, PER_ACTOR);
    await satori.transfer(dave.address, PER_ACTOR);

    // Create two streams (IDs 2 and 3, since 1 is the default stream)
    const tx1 = await satori.createSimpleDataStream("S1", owner.address);
    stream1 = await getStreamIdFromTx(tx1, satori);
    const tx2 = await satori.createSimpleDataStream("S2", owner.address);
    stream2 = await getStreamIdFromTx(tx2, satori);

    // Burn for both streams so each carries weight (any weight > 0 earns).
    await voteFor(satori, alice, stream1);
    await voteFor(satori, bob, stream1);
    await voteFor(satori, carol, stream2);
    await voteFor(satori, dave, stream2);

    // Advance and post values
    await advanceOneDay();
    await registry.setValue(stream1, 100);
    await registry.setValue(stream2, 200);
  });

  // ============================================================
  // VOTE (BURN) + PREDICT ORDERING
  // ============================================================
  describe("Vote + Predict ordering", function () {
    it("predict then vote: the frozen numerator ignores the later burn", async function () {
      const round = await satori.getCurrentRound();

      // Alice predicts first — this writes stream1's numerator for the round.
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);
      const frozen = await voting.getGameVotesAtRound(stream1, round);
      const totalBefore = await voting.roundVoteTotal(round);
      expect(frozen).to.equal(await voting.weightOf(stream1));

      // Bob burns MORE for stream1 AFTER the numerator was written.
      await voteFor(satori, bob, stream1);

      // The frozen numerator and the round denominator are unchanged — a burn
      // never retroactively raises a round that already recorded the game.
      expect(await voting.getGameVotesAtRound(stream1, round)).to.equal(frozen);
      expect(await voting.roundVoteTotal(round)).to.equal(totalBefore);
      // ...but the LIVE weight did grow, so the next round sees it.
      expect(await voting.weightOf(stream1)).to.equal(frozen + VOTE);
    });

    it("vote then predict: the frozen numerator includes the earlier burn", async function () {
      const round = await satori.getCurrentRound();
      const weightBefore = await voting.weightOf(stream1);

      // Bob burns before anyone has predicted on stream1 this round.
      await voteFor(satori, bob, stream1);

      // Then alice predicts — freezing the POST-burn weight into the round.
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      const frozen = await voting.getGameVotesAtRound(stream1, round);
      expect(frozen).to.equal(weightBefore + VOTE);
      expect(await voting.roundVoteTotal(round)).to.equal(frozen);
    });

    it("user votes for a stream then predicts on it in same round", async function () {
      await voteFor(satori, alice, stream1);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);
      // Should succeed without issue
    });

    it("user predicts then votes: the burn goes through despite the prediction lock", async function () {
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // Predicting locks alice's tokens (lane A) so she cannot shuttle them to
      // another address and predict twice. Burning DESTROYS tokens, so it can
      // never fund a second prediction — the hub therefore lets the vote
      // through, borrowing and restoring the lock around the burn. Her
      // prediction is already recorded and is unaffected.
      const w2 = await voting.weightOf(stream2);
      await voteFor(satori, alice, stream2);
      expect(await voting.weightOf(stream2)).to.equal(w2 + VOTE);

      const round = await satori.getCurrentRound();
      expect(await satori.predictedStreamsCount(alice.address, round)).to.equal(1);
    });

    it("burning for a weightless stream mid-round adds it to that round's denominator", async function () {
      // Create a new stream with no burnt weight (earns nothing).
      const tx = await satori.createSimpleDataStream("S3", owner.address);
      const stream3 = await getStreamIdFromTx(tx, satori);
      await registry.setValue(stream3, 300);

      const round = await satori.getCurrentRound();

      // Alice predicts on stream1 first — records stream1 into the round.
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);
      const totalAfterAlice = await voting.roundVoteTotal(round);
      expect(totalAfterAlice).to.be.gt(0);

      // stream3 carries no weight, so it is not eligible and could earn nothing.
      expect(await voting.isEligible(stream3)).to.equal(false);

      // Dave burns for stream3 mid-round. There is no round-totals lock any
      // more: the denominator ACCUMULATES, so stream3 joins this very round as
      // soon as someone predicts on it.
      await voteFor(satori, dave, stream3);
      expect(await voting.isEligible(stream3)).to.equal(true);

      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream3, payload: pack1(UP) }]);
      expect(await voting.getGameVotesAtRound(stream3, round)).to.equal(VOTE);
      expect(await voting.roundVoteTotal(round)).to.equal(totalAfterAlice + VOTE);
    });
  });

  // ============================================================
  // TRANSFER + PREDICT ORDERING
  // ============================================================
  describe("Transfer + Predict ordering", function () {
    it("predict then transfer: transfer blocked by lockedUntil", async function () {
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // 1 ether is comfortably within alice's balance, so the only reason this
      // can revert is the prediction lock.
      await expect(
        satori.connect(alice).transfer(bob.address, ethers.parseEther("1"))
      ).to.be.revertedWithCustomError(satori, "Locked");
    });

    it("transfer then predict: works with new balance", async function () {
      // Carol sends alice extra tokens
      await satori.connect(carol).transfer(alice.address, ethers.parseEther("50"));

      // Alice predicts — her prediction power includes the received tokens
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);
      const round = await satori.getCurrentRound();
      expect(await satori.predictedStreamsCount(alice.address, round)).to.equal(1);
    });

    it("receive tokens after someone else predicted: no double-use", async function () {
      // Alice predicts (locked)
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // Bob sends alice tokens — alice can't use them this round (already predicted)
      await satori.connect(bob).transfer(alice.address, ethers.parseEther("50"));

      // Alice can't predict again this round
      await expect(
        satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream2, payload: pack1(UP) }])
      ).to.be.revertedWithCustomError(satori, "AlreadyPredicted");
    });

    it("claim mints tokens then predict: prediction uses post-mint balance", async function () {
      // First generate claimable rewards: predict, advance, score
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);
      await advanceOneDay();
      await registry.setValue(stream1, 150); // UP
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]); // scores previous

      await advanceOneDay();
      await registry.setValue(stream1, 200);

      // Now: alice claims (mints tokens), then bob predicts.
      // The claim changes alice's balance, which raises her PREDICTION power
      // (balance + unclaimed). It no longer touches voting at all — burnt vote
      // weight is permanent and does not follow token balances.
      const aliceBalBefore = await satori.balanceOf(alice.address);
      await satori.connect(alice)["claim()"]();
      const aliceBalAfter = await satori.balanceOf(alice.address);

      if (aliceBalAfter > aliceBalBefore) {
        await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);
      }
    });
  });

  // ============================================================
  // PREDICTION DELEGATION + PREDICT ORDERING
  // ============================================================
  describe("Prediction delegation + Predict ordering", function () {
    it("predict then delegate: delegation blocked by lockedUntil", async function () {
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      await expect(
        satori.connect(alice).delegatePredictionPower(bob.address)
      ).to.be.revertedWithCustomError(satori, "Locked");
    });

    it("delegate then delegate predicts: normal flow", async function () {
      await satori.connect(alice).delegatePredictionPower(bob.address);
      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // Bob's prediction power should include alice's balance
      const round = await satori.getCurrentRound();
      expect(await satori.predictedStreamsCount(bob.address, round)).to.equal(1);
    });

    it("delegate predicts then delegator undelegates same round", async function () {
      await satori.connect(alice).delegatePredictionPower(bob.address);
      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // Alice undelegates — should be allowed (undelegation always works)
      await satori.connect(alice).delegatePredictionPower(ethers.ZeroAddress);

      // Alice is now locked until next round from the undelegation cooldown
      // She can't predict this round anyway
      await expect(
        satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }])
      ).to.be.reverted;
    });

    it("delegator cannot predict and then have delegate also predict same round", async function () {
      // Alice predicts (uses her own power, locks herself)
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // Alice tries to delegate — blocked because she's locked
      await expect(
        satori.connect(alice).delegatePredictionPower(bob.address)
      ).to.be.revertedWithCustomError(satori, "Locked");
    });

    it("delegate predicts on stream1, delegator cannot independently predict", async function () {
      await satori.connect(alice).delegatePredictionPower(bob.address);
      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // Alice can't predict — she's delegated
      await expect(
        satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream2, payload: pack1(UP) }])
      ).to.be.revertedWithCustomError(satori, "Delegated");
    });

    it("two users delegate to same delegate, delegate predicts once for both", async function () {
      await satori.connect(alice).delegatePredictionPower(carol.address);
      await satori.connect(bob).delegatePredictionPower(carol.address);

      // Carol predicts with combined power (own + alice + bob)
      await satori.connect(carol).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);
      const round = await satori.getCurrentRound();
      expect(await satori.predictedStreamsCount(carol.address, round)).to.equal(1);

      // Neither alice nor bob can predict
      await expect(satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream2, payload: pack1(UP) }])).to.be.revertedWithCustomError(satori, "Delegated");
      await expect(satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream2, payload: pack1(UP) }])).to.be.revertedWithCustomError(satori, "Delegated");
    });
  });

  // ============================================================
  // CLAIM + PREDICT ORDERING
  // ============================================================
  describe("Claim + Predict ordering", function () {
    it("claim then predict in same round: both succeed", async function () {
      // Generate rewards first
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);
      await advanceOneDay();
      await registry.setValue(stream1, 150);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);
      await advanceOneDay();
      await registry.setValue(stream1, 200);

      // Now: claim then predict in same round
      await satori.connect(alice)["claim()"]();
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);
    });

    it("predict then claim in same round: both succeed", async function () {
      // Generate rewards first
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);
      await advanceOneDay();
      await registry.setValue(stream1, 150);

      // Predict then claim in same round
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);
      await satori.connect(alice)["claim()"]();
    });

    it("claim delegation + predict delegation: no cross-contamination", async function () {
      // Alice delegates predictions to bob, claims to carol
      await satori.connect(alice).delegatePredictionPower(bob.address);
      await satori.connect(alice).delegateClaimAbility(carol.address);

      // Bob predicts with alice's power
      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // Alice can't self-claim (delegated to carol)
      await expect(
        satori.connect(alice)["claim()"]()
      ).to.be.revertedWithCustomError(rewards, "ClaimDelegatedAway");

      // Carol can claim for alice
      await expect(
        satori.connect(carol)["claimFor(address,address)"](alice.address, carol.address)
      ).to.not.be.reverted;
    });
  });

  // "setMaxEligibleStreams mid-round" suite removed: the setter no longer
  // exists, and neither does the round-totals lock it raced against. The
  // accumulate-as-you-go denominator is exercised directly by the
  // "burning for a weightless stream mid-round" case above.

  // The previous `deleteStream while predictions pending` block was removed:
  // streams are now permanent, so the scenarios it covered (predict → delete
  // → score; cannot-predict-on-deleted; etc.) no longer exist.
  // Stranded predictions on silent streams are exercised in
  // `StrandedPredictionRecovery.test.js` via the stale-anchor force-finalize.

  // The previous `Vote delegation + Vote ordering` block was removed: vote
  // delegation no longer exists. Weight is bought by BURNING SATORI and is
  // permanent — it cannot be delegated, moved, reduced, or revoked, so there
  // is no ordering hazard left to test.

  // ============================================================
  // CONCURRENT PREDICTIONS (same block, same stream)
  // ============================================================
  describe("Multiple users predicting simultaneously", function () {
    it("two users predict on same stream same round: both succeed independently", async function () {
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);
      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(DOWN) }]);

      const round = await satori.getCurrentRound();
      expect(await satori.predictedStreamsCount(alice.address, round)).to.equal(1);
      expect(await satori.predictedStreamsCount(bob.address, round)).to.equal(1);
    });

    it("first prediction records the game, second leaves the record untouched", async function () {
      const round = await satori.getCurrentRound();

      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);
      const frozen = await voting.getGameVotesAtRound(stream1, round);
      const total = await voting.roundVoteTotal(round);
      expect(frozen).to.be.gt(0);

      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // recordGameVotesForRound is write-once per (game, round): the second
      // predictor must not double-count stream1 into the denominator.
      expect(await voting.getGameVotesAtRound(stream1, round)).to.equal(frozen);
      expect(await voting.roundVoteTotal(round)).to.equal(total);
    });

    it("user A predicts stream1, user B predicts stream2: independent", async function () {
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);
      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream2, payload: pack1(DOWN) }]);

      const round = await satori.getCurrentRound();
      expect(await satori.predictedStreamsCount(alice.address, round)).to.equal(1);
      expect(await satori.predictedStreamsCount(bob.address, round)).to.equal(1);
    });
  });
});
