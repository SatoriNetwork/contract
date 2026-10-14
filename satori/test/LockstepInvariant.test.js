/**
 * LockstepInvariant.test.js
 *
 * The original invariant (REWARD_BUGS #5) was: at the LOCK instant for a round,
 * Σ gameVotesAtRound[*][round] over the eligible heap must equal
 * roundTotals[round]. The heap, the lock, the once-per-round snapshot pass and
 * the LockstepBroken guard are all gone — but the property they existed to
 * defend is still the one thing the reward split depends on, so it is still
 * pinned here against the mechanism that replaced them.
 *
 * Now: `recordGameVotesForRound` writes a game's frozen weight and adds it to
 * the round total in the SAME branch, run by that game's first predictor of the
 * round. So the invariant
 *
 *     roundVoteTotal[r] == Σ gameVotesAtRound[g][r]
 *
 * holds by construction, and holds mid-round rather than only at a lock. These
 * tests confirm it across the flows that used to be the risky ones: games
 * joining the round late, weight bought DURING the round, and weight bought
 * after a game has already been frozen.
 */

const { expect } = require("chai");
const { deploySatoriFixture, pack1, VOTE, voteFor } = require("./fixtures");
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

// These streams come from the public 2-arg overload, so they are cadence 2
// (daily — the finest cadence a public caller may create). A cadence-2 stream
// may be written only once per 2-round period, so the round rhythm this file
// pins is measured in cadence periods: step forward two rounds at a time,
// landing just past a round boundary.
const ROUND = 86400;                              // 24h
const CADENCE_ROUNDS = 2;                         // daily

async function advanceCadencePeriod() {
  const currentTime = await time.latest();
  const nextBoundary = Math.floor(currentTime / ROUND) * ROUND + ROUND;
  await time.increaseTo(nextBoundary + 1);
  await time.increase(ROUND * (CADENCE_ROUNDS - 1));
}

async function sumStreamVotes(voting, streamIds, round) {
  let total = 0n;
  for (const sid of streamIds) {
    total += await voting.getGameVotesAtRound(sid, round);
  }
  return total;
}

describe("Round denominator — Σ gameVotesAtRound == roundVoteTotal", function () {
  let satori, voting, registry;
  let owner, alice, bob, carol, dave;

  beforeEach(async function () {
    [owner, alice, bob, carol, dave] = await ethers.getSigners();

    const fix = await deploySatoriFixture();
    ;({ satori, voting, registry } = fix);

    // Equal-actor setup; UNIT derived from INITIAL_MINT so the test scales
    // with the bootstrap. Actors each get INITIAL_MINT/16; owner keeps the
    // rest for in-test "bump" transfers.
    const INITIAL_MINT = await satori.INITIAL_MINT();
    const UNIT = INITIAL_MINT / 16n;
    await satori.transfer(alice.address, UNIT);
    await satori.transfer(bob.address, UNIT);
    await satori.transfer(carol.address, UNIT);
    await satori.transfer(dave.address, UNIT);
    this.UNIT = UNIT;
  });

  it("Only the games actually predicted enter the round total, and Σ tracks it exactly", async function () {
    // Three games, all backed *yesterday* by different voters.
    const tx1 = await satori.createSimpleDataStream("S1", owner.address);
    const s1 = await getStreamIdFromTx(tx1, satori);
    const tx2 = await satori.createSimpleDataStream("S2", owner.address);
    const s2 = await getStreamIdFromTx(tx2, satori);
    const tx3 = await satori.createSimpleDataStream("S3", owner.address);
    const s3 = await getStreamIdFromTx(tx3, satori);

    await voteFor(satori, alice, s1);
    await voteFor(satori, bob, s2);
    await voteFor(satori, carol, s3);

    // Roll to a fresh midnight, then write values. No prediction yet today, so
    // today's gameVotesAtRound slots are all 0.
    await advanceCadencePeriod();
    await registry.setValue(s1, 100);
    await registry.setValue(s2, 200);
    await registry.setValue(s3, 300);

    const today = await satori.getCurrentRound();
    expect(await voting.getGameVotesAtRound(s1, today)).to.equal(0n);
    expect(await voting.getGameVotesAtRound(s2, today)).to.equal(0n);
    expect(await voting.getGameVotesAtRound(s3, today)).to.equal(0n);
    expect(await voting.roundVoteTotal(today)).to.equal(0n);

    // S1's first predictor freezes S1 — and ONLY S1. There is no snapshot pass
    // sweeping every weighted game into the round any more.
    await satori.connect(dave).predictMultipleWithPayloads([{ gameId: s1, payload: pack1(UP) }]);

    expect(await voting.getGameVotesAtRound(s1, today)).to.equal(VOTE);
    expect(await voting.getGameVotesAtRound(s2, today)).to.equal(0n);
    expect(await voting.getGameVotesAtRound(s3, today)).to.equal(0n);
    expect(await voting.roundVoteTotal(today)).to.equal(VOTE);
    expect(await sumStreamVotes(voting, [s1, s2, s3], today)).to.equal(await voting.roundVoteTotal(today));

    // A second game joining mid-round grows the denominator by exactly its own
    // frozen weight; the invariant holds at every step, not just at a lock.
    await satori.connect(carol).predictMultipleWithPayloads([{ gameId: s2, payload: pack1(UP) }]);

    expect(await voting.roundVoteTotal(today)).to.equal(VOTE * 2n);
    expect(await sumStreamVotes(voting, [s1, s2, s3], today)).to.equal(await voting.roundVoteTotal(today));
    expect(await voting.getEligibleGamesAtRound(today)).to.deep.equal([s1, s2]);

    // The total is only readable once the round has closed.
    await expect(voting.roundDenominator(today)).to.be.revertedWithCustomError(voting, "RoundNotFinal");
    await advanceCadencePeriod();
    expect(await voting.roundDenominator(today)).to.equal(VOTE * 2n);
  });

  it("Weight bought DURING the round counts for that round, at its live value", async function () {
    // S1 and S2 backed yesterday.
    const tx1 = await satori.createSimpleDataStream("S1", owner.address);
    const s1 = await getStreamIdFromTx(tx1, satori);
    const tx2 = await satori.createSimpleDataStream("S2", owner.address);
    const s2 = await getStreamIdFromTx(tx2, satori);

    await voteFor(satori, alice, s1);
    await voteFor(satori, bob, s2);

    await advanceCadencePeriod();
    // Today: a third game is created and backed for the first time. Under
    // same-round governance it is live immediately — no promotion, no wait.
    const tx3 = await satori.createSimpleDataStream("S3", owner.address);
    const s3 = await getStreamIdFromTx(tx3, satori);
    await voteFor(satori, carol, s3);
    // ...and alice tops S1 up in the same round, before anyone has predicted it.
    await voteFor(satori, alice, s1);

    await registry.setValue(s1, 100);
    await registry.setValue(s2, 200);
    await registry.setValue(s3, 300);

    const today = await satori.getCurrentRound();
    expect(await voting.weightOf(s1)).to.equal(VOTE * 2n);
    expect(await voting.weightOf(s3)).to.equal(VOTE);
    // Burning does not record anything by itself — only a prediction does.
    expect(await voting.getGameVotesAtRound(s1, today)).to.equal(0n);
    expect(await voting.getGameVotesAtRound(s3, today)).to.equal(0n);
    // The per-round burn deltas DO see it straight away.
    expect(await voting.gameBurnAtRound(s3, today)).to.equal(VOTE);
    expect(await voting.totalBurnAtRound(today)).to.equal(VOTE * 2n);

    await satori.connect(dave).predictMultipleWithPayloads([
      { gameId: s1, payload: pack1(UP) },
      { gameId: s3, payload: pack1(UP) },
    ]);

    // S1 froze at its topped-up weight; S3 at the weight bought minutes ago.
    expect(await voting.getGameVotesAtRound(s1, today)).to.equal(VOTE * 2n);
    expect(await voting.getGameVotesAtRound(s3, today)).to.equal(VOTE);
    expect(await voting.getGameVotesAtRound(s2, today)).to.equal(0n); // never predicted
    expect(await sumStreamVotes(voting, [s1, s2, s3], today)).to.equal(await voting.roundVoteTotal(today));
  });

  it("A burn AFTER a game is frozen does not revise the round — numerator and denominator cannot drift", async function () {
    const tx1 = await satori.createSimpleDataStream("S1", owner.address);
    const s1 = await getStreamIdFromTx(tx1, satori);
    await voteFor(satori, alice, s1);

    await advanceCadencePeriod();
    await registry.setValue(s1, 100);
    const today = await satori.getCurrentRound();

    await satori.connect(carol).predictMultipleWithPayloads([{ gameId: s1, payload: pack1(UP) }]);
    expect(await voting.getGameVotesAtRound(s1, today)).to.equal(VOTE);
    expect(await voting.roundVoteTotal(today)).to.equal(VOTE);

    // Bob piles on AFTER the freeze. Live weight moves; the round's frozen
    // numerator and its denominator both stay put, in lockstep.
    await voteFor(satori, bob, s1);
    expect(await voting.weightOf(s1)).to.equal(VOTE * 2n);
    expect(await voting.getGameVotesAtRound(s1, today)).to.equal(VOTE);
    expect(await voting.roundVoteTotal(today)).to.equal(VOTE);
    expect(await sumStreamVotes(voting, [s1], today)).to.equal(await voting.roundVoteTotal(today));

    // The next cadence period picks the bigger weight up.
    await advanceCadencePeriod();
    await registry.setValue(s1, 110);
    const tomorrow = await satori.getCurrentRound();
    await satori.connect(dave).predictMultipleWithPayloads([{ gameId: s1, payload: pack1(UP) }]);
    expect(await voting.getGameVotesAtRound(s1, tomorrow)).to.equal(VOTE * 2n);
    expect(await sumStreamVotes(voting, [s1], tomorrow)).to.equal(await voting.roundVoteTotal(tomorrow));
  });

  it("A disabled game is skipped entirely — it joins no round's denominator", async function () {
    const tx1 = await satori.createSimpleDataStream("S1", owner.address);
    const s1 = await getStreamIdFromTx(tx1, satori);
    const tx2 = await satori.createSimpleDataStream("S2", owner.address);
    const s2 = await getStreamIdFromTx(tx2, satori);
    await voteFor(satori, alice, s1);
    await voteFor(satori, bob, s2);

    // The rewards admin (the deployer here) switches S1 off. Its burnt weight
    // is subtracted from the protocol total but preserved for a re-enable.
    await voting.connect(owner).setGameApproved(s1, false);
    expect(await voting.totalBurnedWeight()).to.equal(VOTE);

    await advanceCadencePeriod();
    await registry.setValue(s1, 100);
    await registry.setValue(s2, 200);
    const today = await satori.getCurrentRound();

    await satori.connect(dave).predictMultipleWithPayloads([
      { gameId: s1, payload: pack1(UP) },
      { gameId: s2, payload: pack1(UP) },
    ]);

    expect(await voting.getGameVotesAtRound(s1, today)).to.equal(0n);
    expect(await voting.getGameVotesAtRound(s2, today)).to.equal(VOTE);
    expect(await voting.roundVoteTotal(today)).to.equal(VOTE);
    expect(await sumStreamVotes(voting, [s1, s2], today)).to.equal(await voting.roundVoteTotal(today));
  });
});
