/**
 * ADVERSARIAL COVERAGE — subsystem: rewards-distribution
 *
 * Targets the high/med-priority coverage gaps in
 * adversarial-findings/_raw_review.json (system == "rewards-distribution")
 * that the existing suite does NOT exercise:
 *
 *  - Round-denominator conservation WITH the default game active: the default
 *    game's DERIVED weight (a share of every OTHER game's burn) joins the
 *    round denominator exactly ONCE, a game that was never predicted never
 *    joins it at all, and the resulting split conserves the round budget.  [high]
 *  - setPredictorFee lock-boundary matrix around the default sentinel.      [med]
 *
 * MIGRATION NOTE (burn voting). Three of the original cases tested machinery
 * that no longer exists and were deleted rather than weakened:
 *   • the default-stream "top-dog guard" self-mint (accrueDefaultStreamCut /
 *     getMaxWeightAtRound) — the default game no longer takes a cut at all; its
 *     weight is derived outright from other games' burns;
 *   • "provider cut is the nominal slice; predictor absorbs redistribution" —
 *     value providers are not paid by the protocol any more, and there is no
 *     redistribution pass (a game that did not produce cannot be predicted, so
 *     it never enters the denominator and strands nothing);
 *   • the two first-predictor-bonus cases — the bonus and its budget
 *     reservation were both removed, so the whole on-chain gross is payable.
 *
 * All assertions reflect the DOCUMENTED intent (docs/narratives/A_rewards.md),
 * not the code's current output. RAW_TOLERANCE is used for reward comparisons
 * because of the rawPower quantization (see fixtures.js).
 */

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const {
  deploySatoriFixture,
  deploySatoriFixtureNoFee,
  RAW_TOLERANCE,
  pack1,
  VOTE,
  voteFor,
  onChainGrossNow,
} = require("../fixtures");

const UP = 1;
// The 4-arg overload carried the (now removed) valueProviderCutBps param;
// streams are created with (name, provider, minCadenceRounds).
const SIMPLE3 = "createSimpleDataStream(string,address,uint24)";
const DEFAULT_ID = 1;
// The senior 288 dev fee is carved off the 1440/round at the immutable token,
// leaving a 1152 on-chain gross. With the first-predictor bonus (and its
// reservation) gone, the PAYABLE round budget IS that gross.
// The on-chain game gross per round: the hub's emission net of the senior dev
// fee, READ FROM THE CHAIN in each test. It used to be `parseEther("1152")` —
// 1440 less a 288 dev fee — which held only while emission was a fixed 1440.
let ON_CHAIN_GROSS;
// Referral eager-credit: 5% is skimmed from every reward at credit time and,
// absent a referral, routed to the marketing bucket.
const netOfSkim = (amount) => amount - (amount * 500n) / 10000n;

async function advanceRound() {
  const t = await time.latest();
  await time.increaseTo(Math.floor(t / 86400) * 86400 + 86400 + 1);
}

async function streamIdFrom(tx, satori) {
  const r = await tx.wait();
  const ev = r.logs.find((l) => {
    try {
      return satori.interface.parseLog(l)?.name === "DataStreamCreated";
    } catch {
      return false;
    }
  });
  return satori.interface.parseLog(ev).args.streamId;
}

// Platform fees zeroed so the on-chain per-round budget is the clean residual.
// The fixture already runs initializeDefaultStream (exactly as production does),
// so the default game sits at id 1 and the first test-created stream is id 2.
async function deployStackWithDefault() {
  return deploySatoriFixtureNoFee();
}

describe("rewards-distribution adversarial coverage", function () {
  // -------------------------------------------------------------------------
  // HIGH: round-denominator conservation with the default game active.
  //
  // The default game's weight is DERIVED — 1% of a denominator that includes
  // itself, i.e. totalBurnedWeight * 100/9900, floored at 1e18 — and is never
  // burned for. It therefore counts burns made for games that stay QUIET (B
  // below) while those games themselves contribute nothing to the round
  // denominator, because only a game that was actually predicted is recorded
  // for the round.
  //
  // Here A and B are each burned 10 (total 20), so 1% is ~0.2e18 — UNDER the
  // 1e18 floor — and the default clamps to exactly the 1e18 floor:
  //   denominator(R) = weight(A) + weight(default) = 10 + 1 = 11   (B excluded)
  //   pool(A)        = budget * 10/11
  // and the default's slice is counted exactly ONCE — not once per burn, and
  // not again for the quiet game that fed it.
  // -------------------------------------------------------------------------
  it("HIGH: the derived default weight joins the round denominator once, a quiet game never joins, and the split conserves the budget", async function () {
    this.timeout(120000);
    const { satori, registry, rewards, voting, signers } = await deployStackWithDefault();
    ON_CHAIN_GROSS = await onChainGrossNow(satori);
    const [owner, alice, bob, carol, dave] = signers;
    await satori.transfer(alice.address, ethers.parseEther("100"));
    await satori.transfer(bob.address, ethers.parseEther("100"));
    await satori.transfer(carol.address, ethers.parseEther("100"));
    await satori.transfer(dave.address, ethers.parseEther("100"));
    await advanceRound();

    // default game is id 1; create A (id 2) and B (id 3).
    const A = await streamIdFrom(await satori[SIMPLE3]("A", owner.address, 1440), satori);
    const B = await streamIdFrom(await satori[SIMPLE3]("B", owner.address, 1440), satori);

    // Burn equally for A and B. B will stay quiet all round.
    await voteFor(satori, alice, A); // A: 10
    await voteFor(satori, bob, B);   // B: 10
    expect(await voting.totalBurnedWeight()).to.equal(VOTE * 2n);
    // Derived default weight: 1% of 20e18 is ~0.2e18, under the 1e18 floor, so
    // it clamps to the 1e18 floor — and still counts B's burn even though B
    // itself will earn nothing this round.
    const defWeight = await voting.defaultDerivedWeight();
    expect(defWeight).to.equal(ethers.parseEther("1"));

    await registry.setValue(A, 100);
    await registry.setValue(B, 100);
    // A warm-up predict in R-1 so nothing about R depends on being the very
    // first prediction of the protocol's life.
    await satori.connect(carol).predictMultipleWithPayloads([{ gameId: A, payload: pack1(UP) }]);
    await advanceRound(); // → R

    // R: only A produces (B stays quiet — never valued, never predicted).
    const roundR = await satori.getCurrentRound();
    await registry.setValue(A, 110);
    // dave predicts A AND the default game, so both are recorded for R. (The
    // default stream is auto-flushed at the top of every predict, so it always
    // carries a value for the current round.)
    await satori.connect(dave).predictMultipleWithPayloads([
      { gameId: A, payload: pack1(UP) },
      { gameId: DEFAULT_ID, payload: pack1(UP) },
    ]);

    // Governance is same-round now: R's allocation reads R's OWN record.
    expect(await satori.eligibilityRound(roundR)).to.equal(roundR);
    const defVotes = await voting.getGameVotesAtRound(DEFAULT_ID, roundR);
    const votesA = await voting.getGameVotesAtRound(A, roundR);
    const votesB = await voting.getGameVotesAtRound(B, roundR);
    expect(defVotes).to.equal(defWeight); // the derived weight, recorded once
    expect(votesA).to.equal(VOTE);
    expect(votesB).to.equal(0n);          // quiet game: never in the denominator

    await advanceRound();
    await registry.setValue(A, 120);
    await advanceRound();
    await registry.setValue(A, 130);
    await satori.settlePrediction(dave.address, A);

    // The round is finished, so the denominator reads back final: A + default.
    const denom = await voting.roundDenominator(roundR);
    expect(denom).to.equal(votesA + defVotes);
    expect(denom).to.equal(ethers.parseEther("11")); // A(10) + floored default(1)

    // dave is the sole predictor on A, so he takes A's whole pool:
    //   pool(A) = gross * votesA / denom
    // net of the 5% referral skim (dave has no referral → marketing).
    const expectedDaveSlice = (ON_CHAIN_GROSS * votesA) / denom;
    // 10/11 of the gross, to the wei — the dilution the default game causes.
    expect(expectedDaveSlice).to.equal((ON_CHAIN_GROSS * 10n) / 11n);
    const before = await satori.balanceOf(dave.address);
    await satori.connect(dave).claim();
    const got = (await satori.balanceOf(dave.address)) - before;
    expect(got).to.be.closeTo(netOfSkim(expectedDaveSlice), RAW_TOLERANCE);

    // Conservation ceiling: realized credit for the round can never exceed the
    // documented on-chain budget envelope (emission net of the senior dev fee).
    expect(got).to.be.lte(ON_CHAIN_GROSS);
    // And the default's presence genuinely diluted A: had the default not been
    // in the denominator, A's sole predictor would have taken the whole budget.
    expect(got).to.be.lt(netOfSkim(ON_CHAIN_GROSS));
    // …while B's burn, which only ever fed the DERIVED weight, earned B nothing.
    const marketing = await rewards.marketingFeeRecipient();
    expect(await rewards.unclaimedRewards(marketing)).to.be.gt(0n); // dave's skim landed here
    expect(await rewards.unclaimedRewards(bob.address)).to.equal(0n);
  });

  // -------------------------------------------------------------------------
  // MED: setPredictorFee lock-boundary matrix around the default sentinel.
  //
  // Per rewards.md:147 and SatoriRewards.setPredictorFee:
  //   - setting 1000 (the default) stores 0 → stays UNLOCKED (a later set works).
  //   - setting 0 stores 1000 → LOCKS (a later set reverts AlreadySet).
  //   - setting any other value stores it → LOCKS.
  //   - lens.predictorFeeBps reverse-decodes the stored sentinel.
  // -------------------------------------------------------------------------
  it("MED: setPredictorFee default sentinel leaves unlocked; explicit values lock; view round-trips", async function () {
    const { rewards, lens, signers } = await deploySatoriFixture();
    const [, u1, u2, u3, u4] = signers;

    // (a) setting the default (1000) stores 0 → still unlocked; a later set works.
    await rewards.connect(u1).setPredictorFee(1000);
    expect(await rewards.predictorFeeStored(u1.address)).to.equal(0);
    expect(await lens.predictorFeeBps(u1.address)).to.equal(1000); // decodes default
    await expect(rewards.connect(u1).setPredictorFee(500)).to.not.be.reverted; // unlocked
    expect(await rewards.predictorFeeStored(u1.address)).to.equal(500);
    expect(await lens.predictorFeeBps(u1.address)).to.equal(500);

    // (b) setting an explicit value (500) locks: a later set reverts AlreadySet.
    await rewards.connect(u2).setPredictorFee(500);
    await expect(rewards.connect(u2).setPredictorFee(700)).to.be.revertedWithCustomError(
      rewards,
      "AlreadySet"
    );

    // (c) setting 0 stores the sentinel 1000 → locks: a later set reverts.
    await rewards.connect(u3).setPredictorFee(0);
    expect(await rewards.predictorFeeStored(u3.address)).to.equal(1000); // sentinel
    expect(await lens.predictorFeeBps(u3.address)).to.equal(0); // decodes explicit-zero
    await expect(rewards.connect(u3).setPredictorFee(1000)).to.be.revertedWithCustomError(
      rewards,
      "AlreadySet"
    );

    // (d) above-cap reverts InvalidPredictorFee; view of an unset user = default.
    await expect(rewards.connect(u4).setPredictorFee(1001)).to.be.revertedWithCustomError(
      rewards,
      "InvalidPredictorFee"
    );
    expect(await lens.predictorFeeBps(u4.address)).to.equal(1000); // never-set → default
  });
});
