/**
 * rounds.cov2.test.js — SECOND round of adversarial coverage for `rounds`.
 *
 * MIGRATED to burn voting. The subsystem this file probes is the ROUND
 * DENOMINATOR — which games' weight sizes a round's reward pools, and which
 * do not. That question still exists; the machinery answering it changed
 * completely.
 *
 * OLD MODEL (gone): the eligible set was frozen by a once-per-round heap
 * snapshot, so a game could be eligible-but-quiet — holding a slice of the
 * frozen denominator while never producing a value. A second denominator
 * (`_activeVotes`, populated by `accrueProviderCut`) existed purely to
 * redistribute those stranded slices, with a `nominalAllocation` fallback for
 * the genesis window where `_activeVotes` was still zero. This file used to
 * pin which of those two branches was taken.
 *
 * NEW MODEL: there is ONE denominator. `SatoriVoting.roundVoteTotal[r]`
 * accumulates a game's frozen weight the first time that game is PREDICTED in
 * round r (`recordGameVotesForRound`), and predicting requires the stream to
 * have published a value that round. So a game that did not produce can never
 * enter the denominator, there is no stranded slice, and there is nothing to
 * redistribute or fall back to. `_activeVotes`, `accrueProviderCut` and the
 * genesis fallback are all gone.
 *
 * WHAT IS STILL ASSERTED HERE (same intent, current mechanism):
 *
 *   [MED] A voted-but-QUIET sibling game does NOT dilute a producing game's
 *         payout — it never joins `roundVoteTotal`, so it cannot shrink
 *         anyone's share. Asserted in BOTH the genesis window and a
 *         steady-state round, because governance is now same-round
 *         (`eligibilityRound(r) == r`) and there is no longer a genesis-only
 *         branch that could behave differently.
 *
 *   [MED] POSITIVE CONTROL (replaces the old genesis-fallback control): a
 *         sibling that IS predicted in the same round DOES dilute, by exactly
 *         its share of the denominator. Without this the equality above could
 *         be satisfied by a payout that ignores the denominator entirely.
 *
 * DELETED: the "[MED] default-game votes counted exactly once in _activeVotes
 * under accrueProviderCut's >10-game anti-grief fallback loop" case. Every
 * named component of it — `_activeVotes`, the provider cut, and its bounded
 * eligible-set fallback loop — was removed with the refactor.
 *
 * Fixtures: deploySatoriFixture, pack1, voteFor, VOTE from ../fixtures.
 */

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture, pack1, voteFor, VOTE } = require("../fixtures");

const UP = 1;

async function nextRound() {
  const t = await time.latest();
  const next = Math.floor(Number(t) / 86400) * 86400 + 86400;
  await time.increaseTo(next + 1);
}

// The streams below come from the 2-arg createSimpleDataStream, which now
// yields the finest cadence a PUBLIC caller may ask for: 2 rounds. Consecutive
// VALUE writes must be a whole cadence period apart, and scoring is the AB
// window (anchor = the value AT the predict round, post = the first value
// after it).
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

describe("rounds.cov2 — second adversarial coverage pass for the rounds subsystem", function () {
  this.timeout(120000);

  before(async function () {
    await time.increase(86400);
  });

  // ---------------------------------------------------------------------------
  // The round denominator counts PARTICIPATING games only.
  // ---------------------------------------------------------------------------
  //
  // `run()` builds a fixture where s1 is the game under measurement and an
  // optional sibling s2 carries EXACTLY THE SAME burnt weight. The sibling is
  // either:
  //   "none"      — no sibling at all (the baseline),
  //   "quiet"     — voted for, but never publishes a value and is never
  //                 predicted, so it must not enter roundVoteTotal,
  //   "predicted" — publishes and is predicted in the same round, so it MUST
  //                 enter roundVoteTotal and halve s1's slice.
  //
  // `warmup` decides whether the measured round is the genesis window or a
  // steady-state round that follows an already-finished round.
  //
  // Returns alice's settled payout for her s1 prediction.
  async function run(warmup, sibling) {
    const { satori, rewards, registry, owner, signers } = await deploySatoriFixture();
    const [, alice, bob, carol] = signers;
    await satori.transfer(alice.address, ethers.parseEther("100"));
    await satori.transfer(bob.address, ethers.parseEther("100"));
    await satori.transfer(carol.address, ethers.parseEther("100"));

    // The first stream a test creates is id 2 — id 1 is the default game.
    const s1 = await getStreamId(await satori.createSimpleDataStream("S1", owner.address), satori);
    await voteFor(satori, alice, s1, VOTE); // burn 10 SATORI -> weightOf(s1) == 10

    let s2;
    if (sibling !== "none") {
      s2 = await getStreamId(await satori.createSimpleDataStream("S2", owner.address), satori);
      // Same burn, so a participating sibling splits the denominator 50/50 and
      // a quiet one would have halved the payout if it had counted.
      await voteFor(satori, carol, s2, VOTE);
    }

    if (warmup) {
      // Close a prior round with real participation so the measured round below
      // is NOT the genesis window.
      await nextRound();
      await registry.setValue(s1, 90);
      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: s1, payload: pack1(UP) }]);
    }

    // ---- The measured round R. ----
    // A cadence-2 stream may only be written every 2 rounds, so the measured
    // round is a full cadence period after the warm-up round (and, without a
    // warm-up, simply the first round in which s1 publishes at all).
    await nextCadencePeriod();
    await registry.setValue(s1, 100);
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: s1, payload: pack1(UP) }]);
    if (sibling === "predicted") {
      await registry.setValue(s2, 100);
      await satori.connect(carol).predictMultipleWithPayloads([{ gameId: s2, payload: pack1(UP) }]);
    }

    // Resolve UP and settle (permissionless caller bob). The first post-anchor
    // value alone decides the AB window (150 > the anchor 100 at R).
    await nextCadencePeriod();
    await registry.setValue(s1, 150);
    await nextCadencePeriod();
    await registry.setValue(s1, 200);

    const before = await rewards.unclaimedRewards(alice.address);
    await satori.connect(bob).settlePrediction(alice.address, s1);
    const after = await rewards.unclaimedRewards(alice.address);
    return after - before;
  }

  it("[MED] steady-state round: a voted-but-QUIET sibling never joins roundVoteTotal, so it does not dilute the producer payout", async function () {
    const baseline = await run(true, "none");
    const withQuiet = await run(true, "quiet");
    expect(baseline).to.be.gt(0n);
    expect(withQuiet).to.be.gt(0n);
    // recordGameVotesForRound only fires on a prediction, and predicting
    // requires a value published that round. The quiet sibling did neither, so
    // the denominator is s1's weight alone in both runs.
    expect(withQuiet).to.equal(baseline);
  });

  it("[MED] genesis window behaves identically — there is no separate fallback branch any more", async function () {
    const baselineGenesis = await run(false, "none");
    const withQuietGenesis = await run(false, "quiet");
    expect(baselineGenesis).to.be.gt(0n);
    expect(withQuietGenesis).to.be.gt(0n);
    // Governance is same-round (eligibilityRound(r) == r), and the accumulated
    // denominator is built the same way on the very first active round as on
    // any later one. The old genesis-only `nominalAllocation` fallback — which
    // DID let a quiet sibling dilute — no longer exists.
    expect(withQuietGenesis).to.equal(baselineGenesis);
  });

  it("[MED] positive control: a sibling that IS predicted in the same round DOES dilute, by its exact share of the denominator", async function () {
    const baseline = await run(true, "none");
    const withActive = await run(true, "predicted");
    expect(baseline).to.be.gt(0n);
    expect(withActive).to.be.gt(0n);
    // Equal burns -> equal frozen weights -> roundVoteTotal doubles, so s1's
    // allocation is exactly halved. This proves the equalities above are not
    // vacuous: the payout really is denominator-sensitive.
    expect(withActive).to.be.lt(baseline);
    expect(withActive).to.equal(baseline / 2n);
  });
});
