/**
 * RoundTotalsCorrectness.test.js
 *
 * Round-denominator correctness under BURN VOTING.
 *
 * The old round-totals LOCK is gone: `roundTotals` / `isRoundTotalLocked` no
 * longer exist, and the denominator is ACCUMULATED as games join a round rather
 * than frozen in one pass. What both original cases actually proved — that a
 * round's recorded numbers describe THAT round and are never rewritten by later
 * activity — is still a live guarantee, now carried by
 * `recordGameVotesForRound`:
 *
 *   Case 1: `gameVotesAtRound[g][r]` is written once, by the first predictor of
 *           g in r. Burning more weight for g later in r must not change it, and
 *           burning for a game nobody predicted must not enter r's denominator.
 *   Case 2: scoring a past round r from a much later round must not overwrite
 *           r's numbers with today's (much larger) weights.
 *
 * Plus the new guard that replaces the lock: `roundDenominator(r)` reverts
 * `RoundNotFinal` while r is still open, because the running sum is partial.
 */

const { expect } = require("chai");
const { deploySatoriFixture, pack1, VOTE, voteFor } = require("./fixtures");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const UP = 1;
const DOWN = 2;

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

describe("RoundTotals Correctness", function () {
  let satori, voting, owner, alice, bob, carol, registry;
  let stream1, stream2;

  beforeEach(async function () {
    const fix = await deploySatoriFixture();
    ;({ satori, voting, registry, owner } = fix);
    [owner, alice, bob, carol] = fix.signers;

    // Give users tokens
    await satori.transfer(alice.address, ethers.parseEther("100"));
    await satori.transfer(bob.address, ethers.parseEther("200"));
    await satori.transfer(carol.address, ethers.parseEther("50"));

    // Create streams (the default stream owns id 1, so these are 2 and 3)
    let tx = await satori.createSimpleDataStream("Stream 1", owner.address);
    stream1 = await getStreamIdFromTx(tx, satori);

    tx = await satori.createSimpleDataStream("Stream 2", owner.address);
    stream2 = await getStreamIdFromTx(tx, satori);
  });

  describe("Case 1: a round's recorded votes are written once", function () {
    it("Should not change gameVotesAtRound/roundVoteTotal for day1 after the first prediction records them", async function () {
      // Alice burns 10 for stream1, giving it weight.
      await voteFor(satori, alice, stream1);
      expect(await voting.weightOf(stream1)).to.equal(VOTE);

      // Set stream value so alice can predict
      await registry.setValue(stream1, 100);

      const day1 = await satori.getCurrentRound();

      // Alice predicts — the FIRST predictor of stream1 in day1 records its
      // weight as day1's numerator and adds it to day1's denominator.
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      const recorded = await voting.getGameVotesAtRound(stream1, day1);
      expect(recorded).to.equal(VOTE, "stream1's day1 numerator is its weight at first prediction");
      expect(await voting.roundVoteTotal(day1)).to.equal(recorded,
        "stream1 is the only game predicted in day1, so it IS the denominator");

      // Bob now buys stream1 a lot more weight, in the same round.
      await voteFor(satori, bob, stream1, ethers.parseEther("50"));
      expect(await voting.weightOf(stream1)).to.equal(VOTE + ethers.parseEther("50"));

      // ...and buys weight for a game nobody predicted this round.
      await voteFor(satori, bob, stream2, ethers.parseEther("50"));
      expect(await voting.weightOf(stream2)).to.equal(ethers.parseEther("50"));

      // Neither burn may touch day1's already-recorded numbers.
      expect(await voting.getGameVotesAtRound(stream1, day1)).to.equal(recorded,
        "gameVotesAtRound[stream1][day1] must not change after it has been recorded");
      expect(await voting.getGameVotesAtRound(stream2, day1)).to.equal(0n,
        "a game nobody predicted in day1 has no day1 numerator");
      expect(await voting.roundVoteTotal(day1)).to.equal(recorded,
        "day1's denominator must not change after the fact");
    });

    it("Should refuse to report a denominator while the round is still open", async function () {
      await voteFor(satori, alice, stream1);
      await registry.setValue(stream1, 100);
      const day1 = await satori.getCurrentRound();
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // The total accumulates as games join, so mid-round it is a partial sum.
      await expect(voting.roundDenominator(day1))
        .to.be.revertedWithCustomError(voting, "RoundNotFinal");

      // Once the round has ended it settles to exactly what was recorded.
      await time.increase(86400);
      expect(await voting.roundDenominator(day1)).to.equal(VOTE);
    });
  });

  describe("Case 2: Late-scoring uses the correct day1 denominator", function () {
    it("Once day1's votes are recorded, later rounds' burns and scoring must not overwrite them", async function () {
      // Alice buys stream1 weight and predicts on day1.
      await voteFor(satori, alice, stream1);
      await registry.setValue(stream1, 100);
      const day1 = await satori.getCurrentRound();
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      const day1Recorded = await voting.getGameVotesAtRound(stream1, day1);
      const day1Denominator = await voting.roundVoteTotal(day1);
      expect(day1Recorded).to.equal(VOTE);
      expect(day1Denominator).to.equal(VOTE);

      // Advance 2 rounds
      await time.increase(86400 * 2);
      const day3 = await satori.getCurrentRound();
      expect(day3).to.equal(day1 + 2n);

      // Bob buys both games a lot of weight on day3 — today's weights are now
      // far larger than day1's.
      await voteFor(satori, bob, stream1, ethers.parseEther("100"));
      await voteFor(satori, bob, stream2, ethers.parseEther("60"));
      expect(await voting.weightOf(stream1)).to.be.gt(day1Recorded);

      // Alice predicts again on day3, which scores her day1 prediction.
      await registry.setValue(stream1, 110);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(DOWN) }]);

      // day1's numbers are history and must be untouched.
      expect(await voting.getGameVotesAtRound(stream1, day1)).to.equal(day1Recorded,
        "day1's numerator must survive scoring performed on day3");
      expect(await voting.roundVoteTotal(day1)).to.equal(day1Denominator,
        "day1's denominator must remain the day1 figure after late scoring");

      // day3 records the CURRENT weight, independently of day1.
      expect(await voting.getGameVotesAtRound(stream1, day3))
        .to.equal(await voting.weightOf(stream1));
    });
  });
});
