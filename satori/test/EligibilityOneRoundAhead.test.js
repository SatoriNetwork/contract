/**
 * ELIGIBILITY IS GOVERNED SAME-ROUND
 *
 * (Filename kept for continuity; the behaviour it covers has INVERTED.)
 *
 * The eligible set used to be frozen one round AHEAD: round R was paid against
 * the snapshot taken during R-1, so a game that only became eligible in R did
 * not count until R+1. Burn voting removed that lever — weight is permanent and
 * can only ever be ADDED to a game, never moved off it to chase a prediction
 * already placed — so `SatoriEngine.eligibilityRound` is now the identity and a
 * prediction is paid against its OWN round's weights.
 *
 * Consequences proven here:
 *   - eligibilityRound(r) == r, at genesis and after rounds are populated.
 *   - a game that is first backed DURING round R is eligible for round-R
 *     predictions immediately (the old design said "not until R+1").
 *   - the round denominator ACCUMULATES over the round and is only readable
 *     once the round has closed (`RoundNotFinal` while it is open).
 */

const { expect } = require("chai");
const { deploySatoriFixture, pack1, voteFor, VOTE } = require("./fixtures");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const UP = 1;

async function advanceRound() {
  const currentTime = await time.latest();
  const nextMidnight = Math.floor(currentTime / 86400) * 86400 + 86400;
  await time.increaseTo(nextMidnight + 1);
}

// Streams here come from the 2-arg createSimpleDataStream, i.e. what a public
// caller now gets: 1440 minutes (every round). The "later round" in which A is
// refreshed below is kept at R0 + 2 — comfortably past the write cadence.
// That is a VALUE-write constraint only — eligibility itself is still
// governed same-round, which is exactly what the assertions pin.
const CADENCE_ROUNDS = 2;
async function advanceCadencePeriod() {
  for (let i = 0; i < CADENCE_ROUNDS; i++) await advanceRound();
}

async function getStreamIdFromTx(tx, satori) {
  const receipt = await tx.wait();
  const ev = receipt.logs.find(l => {
    try { return satori.interface.parseLog(l)?.name === "DataStreamCreated"; }
    catch { return false; }
  });
  if (!ev) throw new Error("DataStreamCreated event not found");
  return satori.interface.parseLog(ev).args.streamId;
}

describe("Eligibility governed same-round", function () {
  let satori, voting, rewards, bounties, registry, engine;
  let owner, alice, bob, carol, dave, platform;

  beforeEach(async function () {
    [owner, alice, bob, carol, dave, platform] = await ethers.getSigners();
    const fix = await deploySatoriFixture();
    ({ satori, voting, rewards, registry, engine } = fix);
    owner = fix.owner;
    await satori.transfer(alice.address, ethers.parseEther("100"));
    await satori.transfer(bob.address, ethers.parseEther("100"));
    await satori.transfer(carol.address, ethers.parseEther("100"));
    await satori.transfer(dave.address, ethers.parseEther("100"));
    await advanceRound();
  });

  it("eligibilityRound is the identity — every round is governed by its own weights", async function () {
    const A = await getStreamIdFromTx(
      await satori.createSimpleDataStream("A", owner.address), satori);
    await registry.setValue(A, 100);
    await voteFor(satori, alice, A);

    const r0 = await satori.getCurrentRound();
    expect(await satori.eligibilityRound(r0)).to.equal(r0);

    // The first predictor of A in r0 freezes A's weight into r0 and adds it to
    // r0's running denominator.
    await satori.connect(bob).predictMultipleWithPayloads([{ gameId: A, payload: pack1(UP) }]);
    expect(await voting.roundVoteTotal(r0)).to.equal(VOTE);
    expect(await satori.eligibilityRound(r0)).to.equal(r0);

    // The denominator is accumulated, not locked: it cannot be read while the
    // round is still open, because more games may still join it.
    await expect(voting.roundDenominator(r0)).to.be.revertedWithCustomError(voting, "RoundNotFinal");

    // Next round is governed by ITSELF too, and r0's total is now final.
    await advanceRound();
    const r1 = await satori.getCurrentRound();
    expect(r1).to.equal(r0 + 1n);
    expect(await satori.eligibilityRound(r1)).to.equal(r1);
    expect(await voting.roundDenominator(r0)).to.equal(VOTE);
  });

  it("a game first backed during round R IS eligible for round-R predictions", async function () {
    // R0: game A backed and predicted.
    const A = await getStreamIdFromTx(
      await satori.createSimpleDataStream("A", owner.address), satori);
    await registry.setValue(A, 100);
    await voteFor(satori, alice, A);

    const r0 = await satori.getCurrentRound();
    await satori.connect(bob).predictMultipleWithPayloads([{ gameId: A, payload: pack1(UP) }]);
    expect((await satori.predictions(bob.address, A, r0)).eligible).to.equal(true);

    // R1: introduce game B and back it NOW (only as of R1). R1 is two rounds
    // after R0 because A has to be re-written there for bob to re-predict it,
    // and the spacing clears A's write cadence with room to spare.
    await advanceCadencePeriod();
    const r1 = await satori.getCurrentRound();
    expect(r1).to.equal(r0 + BigInt(CADENCE_ROUNDS));
    expect(await satori.eligibilityRound(r1)).to.equal(r1); // governed by itself

    const B = await getStreamIdFromTx(
      await satori.createSimpleDataStream("B", owner.address), satori);
    await registry.setValue(B, 50);
    await voteFor(satori, carol, B);
    // Refresh A's value so it stays predictable this round.
    await registry.setValue(A, 110);

    // bob re-predicts A; dave predicts the freshly-backed B.
    await satori.connect(bob).predictMultipleWithPayloads([{ gameId: A, payload: pack1(UP) }]);
    await satori.connect(dave).predictMultipleWithPayloads([{ gameId: B, payload: pack1(UP) }]);

    expect((await satori.predictions(bob.address, A, r1)).eligible).to.equal(true);
    // B carries live burnt weight, so it counts for R1 straight away — the old
    // one-round-ahead design made this false until R2.
    expect((await satori.predictions(dave.address, B, r1)).eligible).to.equal(true);

    // B is recorded into R1 (and not into R0, which predates it).
    expect(await voting.getGameVotesAtRound(B, r1)).to.equal(VOTE);
    expect(await voting.getGameVotesAtRound(B, r0)).to.equal(0);
    // R1's denominator carries BOTH games.
    expect(await voting.roundVoteTotal(r1)).to.equal(VOTE * 2n);
  });
});
