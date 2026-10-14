/**
 * PostLockEligibilityInflation.test.js
 *
 * Round-denominator integrity — Issue #1, re-based on burn voting.
 *
 * HISTORY. The old model froze `roundTotals[D]` at the first prediction of the
 * round, then snapshotted numerators separately. A game that became eligible
 * AFTER that freeze could still get a non-zero `gameVotesAtRound` entry when
 * someone predicted it, so Σ numerators could exceed the frozen denominator and
 * the per-game allocations summed above 100% of the round budget.
 *
 * NOW. There is no freeze. The FIRST predictor of each GAME in a round writes
 * `gameVotesAtRound[g][r]` and adds exactly that amount to `roundVoteTotal[r]`,
 * in the same branch — so numerator and denominator cannot drift apart, and a
 * game that gains weight mid-round joins the SAME round's denominator instead
 * of being locked out of it.
 *
 * Invariant (unchanged in spirit, now exact):
 *     Σ gameVotesAtRound[i][D]  ==  roundVoteTotal[D]
 * i.e. per-game shares sum to exactly 1 and the budget is never overshot.
 */

const { expect } = require("chai");
const { deploySatoriFixture, pack1, voteFor } = require("./fixtures");
const { ethers } = require("hardhat");

const UP = 1;

async function getStreamIdFromTx(tx, satoriContract) {
  const receipt = await tx.wait();
  const event = receipt.logs.find((log) => {
    try {
      const parsed = satoriContract.interface.parseLog(log);
      return parsed && parsed.name === "DataStreamCreated";
    } catch {
      return false;
    }
  });
  if (!event) throw new Error("DataStreamCreated event not found");
  const parsed = satoriContract.interface.parseLog(event);
  return parsed.args.streamId;
}

describe("Mid-round eligibility cannot inflate reward payouts", function () {
  let satori, voting, rewards, registry;
  let owner, alice, bob, carol;
  let streamA, streamB, streamC;

  const BURN_A = ethers.parseEther("10");
  const BURN_B = ethers.parseEther("20");

  beforeEach(async function () {
    const fix = await deploySatoriFixture();
    ({ satori, voting, rewards, registry } = fix);
    [owner, alice, bob, carol] = fix.signers;

    // Three streams. A gets weight up front, B gets weight mid-round, C never
    // gets any — the modern stand-in for "ineligible".
    let tx = await satori.createSimpleDataStream("Stream A", owner.address);
    streamA = await getStreamIdFromTx(tx, satori);
    tx = await satori.createSimpleDataStream("Stream B", owner.address);
    streamB = await getStreamIdFromTx(tx, satori);
    tx = await satori.createSimpleDataStream("Stream C", owner.address);
    streamC = await getStreamIdFromTx(tx, satori);

    await satori.transfer(alice.address, ethers.parseEther("200"));
    await satori.transfer(bob.address, ethers.parseEther("300"));
    await satori.transfer(carol.address, ethers.parseEther("100"));
  });

  it("Σ gameVotesAtRound[*][D] equals roundVoteTotal[D]", async function () {
    // Alice burns for A → A is the only weighted game (besides the default,
    // which nobody predicts here, so it never enters the denominator).
    await voteFor(satori, alice, streamA, BURN_A);
    expect(await voting.isEligible(streamA)).to.equal(true);
    expect(await voting.isEligible(streamB)).to.equal(false);
    expect(await voting.isEligible(streamC)).to.equal(false);

    const today = await satori.getCurrentRound();

    // Alice predicts A → A's weight is written into today's denominator.
    await registry.setValue(streamA, 100);
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: streamA, payload: pack1(UP) }]);
    expect(await voting.roundVoteTotal(today)).to.equal(BURN_A);

    // MID-ROUND — bob buys B weight and predicts it. Under the old lock this
    // wrote a numerator with no matching denominator entry; now both move.
    await voteFor(satori, bob, streamB, BURN_B);
    expect(await voting.isEligible(streamB)).to.equal(true);
    await registry.setValue(streamB, 50);
    await satori.connect(bob).predictMultipleWithPayloads([{ gameId: streamB, payload: pack1(UP) }]);

    // And a game with zero burnt weight earns no numerator at all.
    await registry.setValue(streamC, 70);
    await satori.connect(carol).predictMultipleWithPayloads([{ gameId: streamC, payload: pack1(UP) }]);

    const numeratorA = await voting.getGameVotesAtRound(streamA, today);
    const numeratorB = await voting.getGameVotesAtRound(streamB, today);
    const numeratorC = await voting.getGameVotesAtRound(streamC, today);
    const denominator = await voting.roundVoteTotal(today);

    expect(numeratorA).to.equal(BURN_A);
    expect(numeratorB).to.equal(BURN_B);
    expect(numeratorC).to.equal(0n, "a game with no burnt weight earns nothing");

    // THE INVARIANT: the numerators sum to EXACTLY the denominator, so the
    // per-game allocations (budget * numerator / denominator) sum to exactly
    // the round budget — never above it.
    expect(numeratorA + numeratorB + numeratorC).to.equal(
      denominator,
      "numerators must sum to the round denominator"
    );
  });

  it("A game weighted mid-round joins the same round's denominator in lockstep", async function () {
    await voteFor(satori, alice, streamA, BURN_A);
    const today = await satori.getCurrentRound();

    await registry.setValue(streamA, 100);
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: streamA, payload: pack1(UP) }]);

    const denomBefore = await voting.roundVoteTotal(today);
    expect(denomBefore).to.equal(BURN_A);

    // B gains weight after the round's first prediction. Governance is
    // same-round now (eligibilityRound(r) === r), so B earns for TODAY — the
    // budget stays whole because its weight lands in the denominator too.
    expect(await satori.eligibilityRound(today)).to.equal(today);
    await voteFor(satori, bob, streamB, BURN_B);
    await registry.setValue(streamB, 50);
    await satori.connect(bob).predictMultipleWithPayloads([{ gameId: streamB, payload: pack1(UP) }]);

    expect(await voting.getGameVotesAtRound(streamB, today)).to.equal(BURN_B);
    expect((await voting.roundVoteTotal(today)) - denomBefore).to.equal(
      BURN_B,
      "the denominator must grow by exactly the joining game's weight"
    );

    // The denominator is only final once the round has ended — reading it while
    // the round is still accumulating would over-pay every share computed
    // against it, so the contract refuses.
    await expect(voting.roundDenominator(today))
      .to.be.revertedWithCustomError(voting, "RoundNotFinal");
  });

  it("A game weighted in an earlier round is recorded by its first predictor, untouched or not", async function () {
    // Regression guard: weight bought in a PREVIOUS round must still reach the
    // current round's denominator. There is no once-per-round snapshot pass any
    // more — the first predictor of the game does the write — so a game whose
    // weight has not changed all round must not be silently skipped.
    await voteFor(satori, alice, streamA, BURN_A);

    await ethers.provider.send("evm_increaseTime", [86400]);
    await ethers.provider.send("evm_mine", []);

    const today = await satori.getCurrentRound();

    // Nothing has touched A today, so it has no record yet.
    expect(await voting.getGameVotesAtRound(streamA, today)).to.equal(0n);

    await registry.setValue(streamA, 100);
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: streamA, payload: pack1(UP) }]);

    const numeratorA = await voting.getGameVotesAtRound(streamA, today);
    const denominator = await voting.roundVoteTotal(today);

    expect(numeratorA).to.equal(BURN_A, "the first predictor must record the game's standing weight");
    expect(numeratorA).to.equal(denominator);
  });
});
