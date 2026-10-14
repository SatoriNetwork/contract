/**
 * rounds.cov.test.js — adversarial coverage for the `rounds` subsystem.
 *
 * Targets the high/med-priority coverage gaps from
 * adversarial-findings/_raw_review.json (system == "rounds"):
 *
 *   [HIGH] Location-independence of scoring across a multi-round settle gap
 *          (narrative line 93). A round-R prediction settled via permissionless
 *          settlePrediction many rounds later — with NO predict/flush/setValue
 *          in the intervening rounds — must pay identically to immediate
 *          settlement, because scoring reads R's FROZEN per-round records
 *          (gameVotesAtRound[*][R], roundVoteTotal[R], _roundBudget[R]).
 *          Tested for a single earning game AND with a second co-weighted game
 *          that stays quiet (so it never enters R's denominator).
 *
 *   [HIGH] The per-round vote record is a localized, write-once-per-game fact,
 *          not a protocol brick. Once the first predictor of a game in round R
 *          writes gameVotesAtRound[g][R] and adds it to roundVoteTotal[R],
 *          later BURNS in the same round cannot mutate that record, and later
 *          rounds still record normally at the NEW (larger) weight.
 *
 *   [MED]  Genesis zero-weight predict (no burns anywhere): the round records
 *          nothing (roundVoteTotal == 0) but the predict's side effects still
 *          fire (lockedUntil set, predicted-streams slot consumed) and the
 *          prediction yields zero reward — the round "burns". The NEXT round,
 *          once weight exists, records/rewards normally (recovery).
 *
 * Fixtures: deploySatoriFixture, pack1, voteFor from ../fixtures.
 *
 * MIGRATION NOTE (burn voting): the round-totals LOCK is gone. There is no
 * `roundTotals` / `isRoundTotalLocked` / `LockstepBroken` any more — the
 * denominator is ACCUMULATED as each game's first predictor of the round
 * arrives (`SatoriVoting.recordGameVotesForRound`), and is read back as
 * `voting.roundVoteTotal(r)` (running) or `voting.roundDenominator(r)` (final,
 * reverts `RoundNotFinal` while r is open). The old
 * "predict/transfer lock asymmetry under BOTH lock kinds" case was dropped
 * outright: the voting lock, `votingLockedUntil`, `setVoteDelegation` and the
 * vote bounties it was built from no longer exist.
 */

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture, pack1, VOTE, voteFor } = require("../fixtures");

const UP = 1;

async function nextRound() {
  const t = await time.latest();
  const next = Math.floor(Number(t) / 86400) * 86400 + 86400;
  await time.increaseTo(next + 1);
}

// Streams here go through the 2-arg createSimpleDataStream, which now yields
// the finest cadence a PUBLIC caller may ask for: 2 rounds. Consecutive VALUE
// writes must therefore be a whole cadence period apart, and scoring is the AB
// window (anchor = the value AT the predict round, post = the first value
// after it). Rounds advanced for a NON-value reason — the quiet settle gap
// these tests are built around — stay single ROUNDS, since "5 quiet rounds" is
// exactly what is being held constant.
const CADENCE_ROUNDS = 2;
async function nextCadencePeriod() {
  for (let i = 0; i < CADENCE_ROUNDS; i++) await nextRound();
}

async function getStreamId(tx, satori) {
  const r = await tx.wait();
  for (const log of r.logs) {
    try {
      const p = satori.interface.parseLog(log);
      if (p && p.name === "DataStreamCreated") return p.args.streamId;
    } catch (_) {}
  }
  throw new Error("DataStreamCreated event not found");
}

describe("rounds.cov — adversarial coverage for the rounds subsystem", function () {
  this.timeout(120000);

  // ---------------------------------------------------------------------------
  // [HIGH] Scoring is location-independent across a multi-round settle gap.
  // ---------------------------------------------------------------------------
  //
  // Runs the IDENTICAL on-chain sequence twice from a fresh deploy. In run A the
  // round-R prediction is settled immediately (R+2, the first round its value is
  // resolvable). In run B nothing at all happens in R+3..R+(2+gap) — no predict,
  // no flush, no setValue — and only THEN is settlePrediction called. The payout
  // must be byte-for-byte identical because scoring reads R's frozen snapshots.
  async function singleStreamScenario(extraQuietRounds) {
    const { satori, rewards, registry, owner, signers } = await deploySatoriFixture();
    const [, alice, bob] = signers;
    await satori.transfer(alice.address, ethers.parseEther("100"));
    await satori.transfer(bob.address, ethers.parseEther("100"));

    const s1 = await getStreamId(await satori.createSimpleDataStream("S1", owner.address), satori);
    await voteFor(satori, alice, s1);

    await nextRound();
    await registry.setValue(s1, 100);

    // Round R: alice predicts UP. This is the ONLY state-changing touch of R, so
    // R's snapshot (totalPower, gameVotes, budget, activeVotes) freezes here.
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: s1, payload: pack1(UP) }]);

    // R+2, R+4: provider posts rising values on its 2-round cadence. The first
    // post alone resolves the AB window (150 > the anchor 100 at R -> UP wins);
    // the second just shows the stream still producing.
    await nextCadencePeriod();
    await registry.setValue(s1, 150);
    await nextCadencePeriod();
    await registry.setValue(s1, 200);

    // Quiet gap: NO predict / flush / setValue by anyone.
    for (let i = 0; i < extraQuietRounds; i++) await nextRound();

    const before = await rewards.unclaimedRewards(alice.address);
    await satori.connect(bob).settlePrediction(alice.address, s1);
    const after = await rewards.unclaimedRewards(alice.address);
    return after - before;
  }

  it("[HIGH] single-stream payout is identical immediate vs +5-round-gap settle", async function () {
    const immediate = await singleStreamScenario(0);
    const delayed = await singleStreamScenario(5);
    expect(immediate).to.be.gt(0n); // sanity: the prediction actually won
    expect(delayed).to.equal(immediate);
  });

  // Same property, but with a SECOND weighted game that never gets predicted,
  // so the round's ACCUMULATED denominator has to exclude it — and has to keep
  // excluding it however long the settle is deferred.
  async function quietPeerScenario(extraQuietRounds) {
    const { satori, rewards, registry, owner, signers } = await deploySatoriFixture();
    const [, alice, bob, carol] = signers;
    await satori.transfer(alice.address, ethers.parseEther("100"));
    await satori.transfer(bob.address, ethers.parseEther("100"));
    await satori.transfer(carol.address, ethers.parseEther("100"));

    const s1 = await getStreamId(await satori.createSimpleDataStream("S1", owner.address), satori);
    const s2 = await getStreamId(await satori.createSimpleDataStream("S2", owner.address), satori);
    await voteFor(satori, alice, s1);
    await voteFor(satori, carol, s2); // carries weight but stays quiet all round

    await nextRound();
    await registry.setValue(s1, 100); // s2 gets no value -> non-producing in R

    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: s1, payload: pack1(UP) }]);

    await nextCadencePeriod();
    await registry.setValue(s1, 150);
    await nextCadencePeriod();
    await registry.setValue(s1, 200);

    for (let i = 0; i < extraQuietRounds; i++) await nextRound();

    const before = await rewards.unclaimedRewards(alice.address);
    await satori.connect(bob).settlePrediction(alice.address, s1);
    const after = await rewards.unclaimedRewards(alice.address);
    return after - before;
  }

  it("[HIGH] quiet-peer payout is identical immediate vs +5-round-gap settle", async function () {
    const immediate = await quietPeerScenario(0);
    const delayed = await quietPeerScenario(5);
    expect(immediate).to.be.gt(0n);
    expect(delayed).to.equal(immediate);
  });

  // ---------------------------------------------------------------------------
  // [HIGH] The per-round vote record is localized + write-once, not a brick.
  // ---------------------------------------------------------------------------
  it("[HIGH] a round's recorded weight is not mutated by later burns, and later rounds record the new weight", async function () {
    const { satori, voting, registry, owner, signers } = await deploySatoriFixture();
    const [, alice, bob, carol] = signers;
    await satori.transfer(alice.address, ethers.parseEther("100"));
    await satori.transfer(bob.address, ethers.parseEther("100"));
    await satori.transfer(carol.address, ethers.parseEther("100"));

    const s1 = await getStreamId(await satori.createSimpleDataStream("S1", owner.address), satori);
    const s2 = await getStreamId(await satori.createSimpleDataStream("S2", owner.address), satori);
    await voteFor(satori, alice, s1);

    await nextRound();
    await registry.setValue(s1, 100);

    // Round R: the first predictor of s1 records s1's LIVE weight into R and
    // adds exactly that much to R's accumulating denominator.
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: s1, payload: pack1(UP) }]);
    const R = await satori.getCurrentRound();
    const recordedTotal = await voting.roundVoteTotal(R);
    const recordedS1 = await voting.getGameVotesAtRound(s1, R);
    expect(recordedS1).to.equal(VOTE);
    expect(recordedTotal).to.be.gt(0n);
    // Only games actually PREDICTED this round join the denominator: s2 carries
    // no weight yet and was never predicted, so R's total is exactly s1's entry.
    expect(await voting.getGameVotesAtRound(s2, R)).to.equal(0n);
    expect(recordedS1).to.equal(recordedTotal);

    // Heavy in-round burning AFTER the record: bob burns for s1, carol for s2.
    await voteFor(satori, bob, s1);
    await voteFor(satori, carol, s2);
    // Live weight grew, but R's RECORD must be untouched — the write is
    // once-per-(game, round) and the denominator only ever gains new games.
    expect(await voting.weightOf(s1)).to.equal(VOTE * 2n);
    expect(await voting.weightOf(s1)).to.be.gt(recordedTotal);
    expect(await voting.roundVoteTotal(R)).to.equal(recordedTotal);
    expect(await voting.getGameVotesAtRound(s1, R)).to.equal(recordedS1);
    // s2 gained weight mid-round but was still never predicted in R, so it
    // never enters R's denominator.
    expect(await voting.getGameVotesAtRound(s2, R)).to.equal(0n);

    // The next PRODUCING round records normally (no brick), now at the LARGER
    // weight. On a cadence-2 stream that is R+2, the first round the provider
    // may post again.
    await nextCadencePeriod();
    await registry.setValue(s1, 110);
    await satori.connect(bob).predictMultipleWithPayloads([{ gameId: s1, payload: pack1(UP) }]);
    const R2 = await satori.getCurrentRound();
    const total2 = await voting.roundVoteTotal(R2);
    expect(await voting.getGameVotesAtRound(s1, R2)).to.equal(VOTE * 2n);
    expect(total2).to.be.gt(recordedTotal);
    expect(
      (await voting.getGameVotesAtRound(s1, R2)) + (await voting.getGameVotesAtRound(s2, R2))
    ).to.equal(total2);

    // R is now a FINISHED round: its final denominator reads back through the
    // guarded accessor and still equals what was recorded then.
    expect(await voting.roundDenominator(R)).to.equal(recordedTotal);
    expect(await voting.getGameVotesAtRound(s1, R)).to.equal(recordedS1);
    // …and the OPEN round R2 refuses to hand out a partial denominator.
    await expect(voting.roundDenominator(R2)).to.be.revertedWithCustomError(
      voting, "RoundNotFinal"
    );
  });

  // ---------------------------------------------------------------------------
  // [MED] Genesis zero-weight predict burns the round but the protocol recovers.
  // ---------------------------------------------------------------------------
  it("[MED] genesis zero-weight predict burns the round (nothing recorded, zero reward) but recovers next round", async function () {
    const { satori, voting, rewards, registry, owner, signers } = await deploySatoriFixture();
    const [, alice, bob] = signers;
    await satori.transfer(alice.address, ethers.parseEther("100"));
    await satori.transfer(bob.address, ethers.parseEther("100"));

    const s1 = await getStreamId(await satori.createSimpleDataStream("S1", owner.address), satori);

    // Nobody has burned anything -> totalBurnedWeight == 0 and s1 has no weight,
    // so it is not eligible. The provider can still post a value (setValue is
    // gated on provider identity, not eligibility).
    expect(await voting.totalBurnedWeight()).to.equal(0n);
    expect(await voting.weightOf(s1)).to.equal(0n);
    expect(await voting.isEligible(s1)).to.equal(false);

    await nextRound();
    await registry.setValue(s1, 100);
    const Rg = await satori.getCurrentRound();

    // Genesis-window predict on a zero-weight game.
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: s1, payload: pack1(UP) }]);

    // Nothing was recorded for the round ("burns with no possible reward")...
    expect(await voting.getGameVotesAtRound(s1, Rg)).to.equal(0n);
    expect(await voting.roundVoteTotal(Rg)).to.equal(0n);
    expect(await voting.getEligibleGamesAtRound(Rg)).to.deep.equal([]);
    // ...but the predict's side effects still fired:
    expect(await satori.predictedStreamsCount(alice.address, Rg)).to.equal(1n); // slot consumed
    expect(await satori.lockedUntil(alice.address)).to.equal(Rg + 1n);          // lock set

    // Resolve and settle: the burned-round prediction yields zero reward.
    await nextCadencePeriod();
    await registry.setValue(s1, 150);
    await nextCadencePeriod();
    await registry.setValue(s1, 200);
    const before = await rewards.unclaimedRewards(alice.address);
    await satori.settlePrediction(alice.address, s1);
    expect((await rewards.unclaimedRewards(alice.address)) - before).to.equal(0n);
    // The finished genesis round confirms a zero denominator — nothing to divide.
    expect(await voting.roundDenominator(Rg)).to.equal(0n);

    // Recovery: now that weight exists, the next round records/rewards normally.
    await voteFor(satori, alice, s1);
    await nextCadencePeriod();
    await registry.setValue(s1, 250);
    const Rnext = await satori.getCurrentRound();
    await satori.connect(bob).predictMultipleWithPayloads([{ gameId: s1, payload: pack1(UP) }]);
    expect(await voting.getGameVotesAtRound(s1, Rnext)).to.equal(VOTE);
    expect(await voting.roundVoteTotal(Rnext)).to.be.gt(0n);
  });
});
