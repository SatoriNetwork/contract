/**
 * Delegation loyalty weighting — RED tests.
 *
 * Spec: docs/design/delegation-loyalty-weighting.md
 *
 * Each DelegationPeriod carries a loyalty score L, starting at 0, updated once
 * per round from the predictor's fraction of that round's predictions that were
 * correct (q):
 *
 *     L' = q(aL + 1) + (1 - q)(0.618 L)        a = 0.97 (shipped)
 *
 * Payout weight is capital x L (LINEAR in both), and the predictor's delegator
 * pot for the round is split by weight. The round denominator
 * W = sum(capital x L) is maintained as a single running number
 * (W' = alpha*W + beta*C), so nothing here may introduce per-delegator
 * iteration at score time.
 *
 * These tests assert SPECIFIED BEHAVIOUR, not implementation arithmetic —
 * relations and boundary cases rather than pinned wei. Exact values get pinned
 * in the green phase once the fixed-point scale and rounding are settled.
 *
 * Test scaffolding notes (mirrors DelegatorDeltaClaim.test.js):
 *  - Voting BURNS SATORI to buy a game permanent weight, so votes come from
 *    dedicated holders (carol, eve) whose balances are not otherwise used.
 *  - Delegators claim to a SINK address so their own balance — and therefore
 *    their delegated capital — stays fixed across the comparison.
 */

const { expect } = require("chai");
const { deploySatoriFixtureNoFee, pack1, VOTE } = require("./fixtures");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const UP = 1;
const SIMPLE3 = "createSimpleDataStream(string,address,uint24)";

async function streamIdFrom(tx, satori) {
  const r = await tx.wait();
  const ev = r.logs.find(l => {
    try { return satori.interface.parseLog(l)?.name === "DataStreamCreated"; }
    catch { return false; }
  });
  return satori.interface.parseLog(ev).args.streamId;
}

async function advanceRound() {
  const t = await time.latest();
  await time.increaseTo(Math.floor(t / 86400) * 86400 + 86400 + 1);
}

describe("Delegation loyalty weighting", function () {
  let satori, voting, rewards, registry;
  let owner, alice, bob, carol, dave, eve, sink;
  let gameA, gameB;

  beforeEach(async function () {
    [owner, alice, bob, carol, dave, eve, sink] = await ethers.getSigners();

    const fix = await deploySatoriFixtureNoFee();
    ({ satori, voting, rewards, registry } = fix);

    // alice + dave are delegators with IDENTICAL capital, so any difference in
    // their payout is attributable to loyalty alone. bob is the predictor.
    // carol + eve exist only to burn votes. Total <= INITIAL_MINT (720).
    await satori.transfer(alice.address, ethers.parseEther("200"));
    await satori.transfer(dave.address,  ethers.parseEther("200"));
    await satori.transfer(bob.address,   ethers.parseEther("100"));
    await satori.transfer(carol.address, ethers.parseEther("50"));
    await satori.transfer(eve.address,   ethers.parseEther("50"));

    gameA = await streamIdFrom(await satori[SIMPLE3]("A", owner.address, 1440), satori);
    gameB = await streamIdFrom(await satori[SIMPLE3]("B", owner.address, 1440), satori);

    await satori.connect(carol).vote(gameA, VOTE);
    await satori.connect(eve).vote(gameB, VOTE);

    await advanceRound();
  });

  /** bob predicts UP on `gameId`; the next two values decide it. */
  async function predict(gameId, base) {
    await registry.setValue(gameId, base);
    await satori.connect(bob).predictMultipleWithPayloads([{ gameId, payload: pack1(UP) }]);
  }

  /** Resolve bob's outstanding prediction on `gameId` as a win or a loss. */
  async function resolve(gameId, base, win) {
    await advanceRound();
    await registry.setValue(gameId, base + 10);              // B (anchor)
    await advanceRound();
    await registry.setValue(gameId, win ? base + 20 : base); // C (post)
    await satori.connect(carol).settlePrediction(bob.address, gameId);
  }

  /** A full win round on gameA: predict, resolve, land back on a fresh round. */
  async function winRound(base) {
    await predict(gameA, base);
    await resolve(gameA, base, true);
    await advanceRound();
  }

  async function claimTo(who, recipient) {
    const before = await satori.balanceOf(recipient);
    await satori.connect(who)["claim(address)"](recipient);
    return (await satori.balanceOf(recipient)) - before;
  }

  // ------------------------------------------------------------------
  // 1. W == 0 evaporates  (design §7)
  // ------------------------------------------------------------------

  it("evaporates the delegator share when every delegator is still at L = 0", async function () {
    await satori.connect(alice).delegatePredictionPower(bob.address);

    // bob's FIRST winning round with a delegator. alice joined at L = 0, so
    // W == 0 and the whole delegatorsShare is never minted.
    await winRound(100);

    const aliceGain = await claimTo(alice, sink.address);
    expect(aliceGain).to.equal(0n);
  });

  it("does not revert the settle path when W == 0", async function () {
    await satori.connect(alice).delegatePredictionPower(bob.address);
    await predict(gameA, 100);

    // Unguarded this is a division by zero inside scoreCorrectPrediction,
    // i.e. a Panic 0x12 that reverts the engine's settle path entirely.
    await advanceRound();
    await registry.setValue(gameA, 110);
    await advanceRound();
    await registry.setValue(gameA, 120);
    await expect(satori.connect(carol).settlePrediction(bob.address, gameA))
      .to.not.be.reverted;
  });

  it("evaporation does not divert the delegator share to the predictor", async function () {
    // Baseline: bob wins one round with NO delegators at all.
    await winRound(100);
    const soloTake = await claimTo(bob, sink.address);

    // Same single winning round, but with a fresh L=0 delegator attached. The
    // delegator earns nothing (W == 0) and bob must not pick up the remainder:
    // routing it to him would pay predictors to churn their delegators.
    await satori.connect(alice).delegatePredictionPower(bob.address);
    await winRound(200);
    const withDelegatorTake = await claimTo(bob, sink.address);

    expect(withDelegatorTake).to.be.lt(soloTake);
  });

  // ------------------------------------------------------------------
  // 2. Loyalty differentiates  (design §2, §11.2)
  // ------------------------------------------------------------------

  it("a tenured delegator out-earns an equal-capital newcomer", async function () {
    await satori.connect(alice).delegatePredictionPower(bob.address);

    // alice builds loyalty over several winning rounds.
    for (const base of [100, 200, 300, 400]) await winRound(base);

    // Drain alice's accrual to the sink so her own balance — and therefore her
    // delegated capital — is unchanged when dave joins at the same 200.
    await claimTo(alice, sink.address);
    expect(await satori.balanceOf(alice.address)).to.equal(await satori.balanceOf(dave.address));

    await satori.connect(dave).delegatePredictionPower(bob.address);

    // dave's joining round: he is at L = 0, so he earns nothing while alice,
    // carrying loyalty, takes the whole pot.
    await winRound(500);
    expect(await claimTo(dave, sink.address)).to.equal(0n);
    expect(await claimTo(alice, sink.address)).to.be.gt(0n);

    // Next round dave has L = q > 0 and starts earning, but still trails alice
    // on identical capital.
    await winRound(600);
    const daveGain  = await claimTo(dave, sink.address);
    const aliceGain = await claimTo(alice, sink.address);
    expect(daveGain).to.be.gt(0n);
    expect(aliceGain).to.be.gt(daveGain);
  });

  it("switching predictors resets loyalty to zero", async function () {
    await satori.connect(alice).delegatePredictionPower(bob.address);
    await satori.connect(dave).delegatePredictionPower(bob.address);

    for (const base of [100, 200, 300, 400]) await winRound(base);
    await claimTo(alice, sink.address);
    await claimTo(dave, sink.address);

    // alice leaves and comes back — a new period at L = 0. dave never moved.
    // (Undelegating is never blocked; re-delegating in the same round is a
    // clean close-and-reopen.)
    await satori.connect(alice).delegatePredictionPower(ethers.ZeroAddress);
    await advanceRound();
    await satori.connect(alice).delegatePredictionPower(bob.address);

    await winRound(500);

    // Equal capital, but alice restarted: dave takes the round, alice takes
    // nothing on her first round back.
    expect(await claimTo(alice, sink.address)).to.equal(0n);
    expect(await claimTo(dave, sink.address)).to.be.gt(0n);
  });

  it("a loss decays loyalty rather than resetting it", async function () {
    await satori.connect(alice).delegatePredictionPower(bob.address);
    for (const base of [100, 200, 300, 400]) await winRound(base);
    await claimTo(alice, sink.address);

    // A fully-wrong round: q = 0, so L *= 0.618. Not zero.
    await predict(gameA, 500);
    await resolve(gameA, 500, false);
    await advanceRound();

    // dave joins AFTER the loss, at L = 0. alice's decayed loyalty must still
    // beat a standing start — proving the loss decayed rather than reset.
    await satori.connect(dave).delegatePredictionPower(bob.address);
    await winRound(600);
    await claimTo(dave, sink.address);
    await claimTo(alice, sink.address);

    await winRound(700);
    const daveGain  = await claimTo(dave, sink.address);
    const aliceGain = await claimTo(alice, sink.address);
    expect(aliceGain).to.be.gt(daveGain);
  });

  // ------------------------------------------------------------------
  // 3. q blend  (design §5)
  // ------------------------------------------------------------------

  it("a partially-correct round builds less loyalty than a fully-correct one", async function () {
    await satori.connect(alice).delegatePredictionPower(bob.address);

    // alice: one round at q = 1/2 (bob splits gameA / gameB).
    await registry.setValue(gameA, 100);
    await registry.setValue(gameB, 100);
    await satori.connect(bob).predictMultipleWithPayloads([
      { gameId: gameA, payload: pack1(UP) },
      { gameId: gameB, payload: pack1(UP) },
    ]);
    await advanceRound();
    await registry.setValue(gameA, 110);
    await registry.setValue(gameB, 110);
    await advanceRound();
    await registry.setValue(gameA, 120); // gameA wins
    await registry.setValue(gameB, 100); // gameB loses
    await satori.connect(carol).settlePrediction(bob.address, gameA);
    await satori.connect(carol).settlePrediction(bob.address, gameB);
    await advanceRound();

    // Loyalty is materialised lazily by the claim walk, and the fold is LAGGED
    // by LOY_LAG rounds (a round's q is not knowable until it settles), so the
    // walk has to reach round X + LOY_LAG before round X folds in. Advance past
    // that, then claim to materialise it.
    for (let i = 0; i < 6; i++) await advanceRound();
    await claimTo(alice, sink.address);
    const halfRoundL = await rewards.delegationLoyaltyAt(alice.address, 0);

    // dave: one round at q = 1, same capital, same predictor.
    await satori.connect(dave).delegatePredictionPower(bob.address);
    await winRound(300);
    for (let i = 0; i < 6; i++) await advanceRound();
    await claimTo(dave, sink.address);
    const fullRoundL = await rewards.delegationLoyaltyAt(dave.address, 0);

    expect(halfRoundL).to.be.gt(0n);
    expect(fullRoundL).to.be.gt(halfRoundL);
  });

  // ------------------------------------------------------------------
  // 4. Frozen q — a slow stream must not stall loyalty  (design §5)
  // ------------------------------------------------------------------

  it("loyalty keeps progressing past a round with a permanently unsettled prediction", async function () {
    await satori.connect(alice).delegatePredictionPower(bob.address);

    // R0: bob predicts gameB and it is NEVER resolved — q(R0) must be frozen
    // at first crossing rather than blocking every later round's update.
    await registry.setValue(gameB, 100);
    await satori.connect(bob).predictMultipleWithPayloads([{ gameId: gameB, payload: pack1(UP) }]);
    await advanceRound();

    // Several clean winning rounds on gameA behind the stuck one.
    for (const base of [200, 300, 400]) await winRound(base);

    // alice must be able to collect them. A naive implementation that halts
    // the loyalty walk at the unsettled round freezes this indefinitely — the
    // exact failure the frozen-q rule exists to prevent.
    expect(await claimTo(alice, sink.address)).to.be.gt(0n);

    // And loyalty must have actually advanced, not sat pinned at the stall.
    expect(await rewards.delegationLoyaltyAt(alice.address, 0)).to.be.gt(0n);
  });

  it("a late settlement pays its reward delta but never revises frozen q", async function () {
    await satori.connect(alice).delegatePredictionPower(bob.address);

    // Build loyalty FIRST — at L = 0 alice carries no weight, so a delta from
    // the stalled round would legitimately be zero and prove nothing.
    for (const base of [100, 200]) await winRound(base);

    await registry.setValue(gameB, 300);
    await satori.connect(bob).predictMultipleWithPayloads([{ gameId: gameB, payload: pack1(UP) }]);
    await advanceRound();
    for (const base of [400, 500]) await winRound(base);

    await claimTo(alice, sink.address);
    const loyaltyBefore = await rewards.delegationLoyaltyAt(alice.address, 0);

    // gameB finally resolves, long after its round was crossed.
    await registry.setValue(gameB, 110);
    await advanceRound();
    await registry.setValue(gameB, 120);
    await satori.connect(carol).settlePrediction(bob.address, gameB);

    // The reward delta is still paid (existing OpenRound machinery)...
    expect(await claimTo(alice, sink.address)).to.be.gt(0n);
    // ...but the frozen q is canonical, so loyalty for that round is untouched.
    expect(await rewards.delegationLoyaltyAt(alice.address, 0)).to.equal(loyaltyBefore);
  });

  // ------------------------------------------------------------------
  // 5. Conservation  (design §10) — invariant guard
  // ------------------------------------------------------------------

  it("total delegator credits never exceed the round's delegator pot", async function () {
    await satori.connect(alice).delegatePredictionPower(bob.address);
    await satori.connect(dave).delegatePredictionPower(bob.address);

    for (const base of [100, 200, 300]) await winRound(base);

    // Adversarial ordering: dave leaves mid-stream and returns, so W absorbs a
    // subtract-and-re-add while alice keeps accruing. Sum(capital x L) <= W
    // must hold throughout or the pot over-pays.
    await satori.connect(dave).delegatePredictionPower(ethers.ZeroAddress);
    await advanceRound();
    await satori.connect(dave).delegatePredictionPower(bob.address);
    for (const base of [400, 500]) await winRound(base);

    const aliceTotal = await claimTo(alice, sink.address);
    const daveTotal  = await claimTo(dave, sink.address);
    const bobTotal   = await claimTo(bob, sink.address);

    // Five winning rounds, each drawing at most one full round budget. The
    // ceiling is deliberately loose — this guards the direction of the error
    // (never over-mint), not the exact split.
    const ceiling = ethers.parseEther("1440") * 5n;
    expect(aliceTotal + daveTotal + bobTotal).to.be.lte(ceiling);
    expect(aliceTotal + daveTotal).to.be.gt(0n);
  });
});
