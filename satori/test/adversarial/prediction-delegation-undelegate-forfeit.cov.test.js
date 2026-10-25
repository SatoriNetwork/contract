// Adversarial repro — finding adv_7 (prediction-delegation), severity medium:
//
//   "Delegator who undelegates in the same round their delegate predicted
//    with their power loses (orphans) their earned share of that round"
//
// Location: SatoriRewards.sol _accrueDelegatorRewards close-period walk
//   (lines 1366-1378, `to = endRound - 1`) interacting with
//   delegatePredictionPower close-out (the live pool is decremented but the
//   per-(delegate,game,round) FROZEN snapshot delegatedPower captured at
//   predict time is NOT touched, lines ~1779-1801) and the _splitReward rate
//   denominator (lines 1251-1252).
//
// INTENT (A_prediction_delegation.md): the predictor's reward at score time
// is computed against a FROZEN (ownPower, delegatedPower) snapshot taken at
// predict time. A delegator who was part of that snapshot earned their slice
// of that round — "the delegators' share ... accumulates as a rate the
// delegators can later walk to recover their own income." A delegator who was
// in the winning snapshot for round R should be able to collect their
// proportional slice of round R's delegator reward.
//
// SCENARIO:
//  - A and B both delegate to D with EQUAL balances.
//  - In round R, D predicts (frozen snapshot delegatedPower = A + B).
//  - STILL in round R, A undelegates. The live rate pool drops to B, but the
//    frozen snapshot for round R stays A + B, and A's delegation period gets
//    endRound = R.
//  - D's round-R prediction scores in a later round. rate[D][R] is sized with
//    A in the denominator (A + B).
//  - B claims and collects B_balance * rate = its round-R slice.
//  - A claims; A's period endRound = R so the walk only covers rounds up to
//    R-1 — A is NEVER credited for round R despite being in the winning
//    frozen snapshot.
//
// To isolate round R, D predicts ONLY in round R. Both A and B have equal
// balances and equal delegation timing, so per intent A and B must earn the
// SAME amount for round R. The test asserts A's total gain == B's total gain.

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixtureNoFee, pack1, VOTE, voteFor } = require("../fixtures");

const UP = 1;

async function nextRound() {
  await time.increase(86400);
}

async function getStreamId(tx, satori) {
  const rcpt = await tx.wait();
  for (const log of rcpt.logs) {
    try {
      const p = satori.interface.parseLog(log);
      if (p && p.name === "DataStreamCreated") return p.args.streamId;
    } catch (e) {}
  }
  throw new Error("DataStreamCreated not found");
}

// RESOLUTION (owner): NOT A BUG — intended design. "Undelegation is always
// allowed" is a deliberate, explicitly-tested invariant (double-use is prevented
// by stopping the delegator from RE-USING the power that round, not by blocking
// the undelegate). Undelegating mid-round FORFEITS that round's pending delegator
// share: it is simply never minted (A's slice is orphaned, B keeps exactly its
// own — no over-mint, no theft, no solvency risk). This guard pins that intended
// behavior so the orphan is never naively "fixed" (e.g. endRound=today+1, which
// would over-mint when a delegator undelegates before / between the delegate's
// predictions). See memory: satori-prediction-delegation-undelegate-forfeit.
describe("adv_7 prediction-delegation: undelegating mid-round forfeits that round's share (intended)", function () {
  this.timeout(120000);

  it("a delegator who undelegates in the round the delegate predicted FORFEITS that round's share (allowed; orphaned not stolen)", async function () {
    const { satori, rewards, registry, owner, signers } = await deploySatoriFixtureNoFee();

    const D = signers[1]; // delegate / predictor
    const A = signers[2]; // delegator who undelegates in round R
    const B = signers[3]; // delegator who stays
    // Voting BURNS, so a dedicated voter buys the game its weight — that keeps
    // D/A/B's balances at exactly STAKE, which the delegated-power assertions
    // below depend on.
    const V = signers[4];

    // The reward budget is the full per-round amount (no platform fee) so the
    // delegator-split math is not shaved by the flat fee.

    // Fund the actors. A and B get EQUAL balances so their round-R slices
    // must be equal per intent.
    const STAKE = ethers.parseEther("100");
    await satori.transfer(D.address, STAKE);
    await satori.transfer(A.address, STAKE);
    await satori.transfer(B.address, STAKE);
    await satori.transfer(V.address, VOTE);

    // Create a binary stream. (The value-provider cut is gone, so there is no
    // cut argument any more.) The fixture wrap auto-creates a 1:1 binary game.
    const tx = await satori["createSimpleDataStream(string,address,uint24)"](
      "advStream", owner.address, 1440
    );
    const stream = await getStreamId(tx, satori);
    const gameId = stream; // 1:1 by creation order in the fixture wrap

    // One burn buys the game permanent weight — that is all eligibility needs
    // now (no threshold, no top-N). Advance a round so the prediction below is
    // cleanly separated from setup.
    await voteFor(satori, V, stream);
    await nextRound();

    // A and B delegate their EQUAL stakes to D.
    await satori.connect(A).delegatePredictionPower(D.address);
    await satori.connect(B).delegatePredictionPower(D.address);
    await time.increase(86400);

    // Sanity: D's delegated power = A + B.
    expect((await rewards.predictionDelegateInfo(D.address)).power).to.equal(STAKE * 2n);

    // ===== Round R: D predicts with the full delegated snapshot (A + B). =====
    await registry.setValue(stream, 100);
    const R = await satori.getCurrentRound();
    await satori.connect(D).predictMultipleWithPayloads([{ gameId, payload: pack1(UP) }]);

    // The frozen snapshot for round R captured BOTH A and B.
    const delInfo = await rewards.predictionDelegationInfo(D.address, gameId, R);
    expect(delInfo.delegatedPower).to.equal(STAKE * 2n);

    // ===== Still in round R: A undelegates — ALWAYS ALLOWED (intended). =====
    // Live pool drops to B, but the frozen snapshot for round R stays A + B.
    // A is choosing to leave mid-round and thereby FORFEITS round R's pending
    // delegator share (her endRound = R, so the payout walk excludes R).
    await satori.connect(A).delegatePredictionPower(ethers.ZeroAddress);
    expect((await rewards.predictionDelegateInfo(D.address)).power).to.equal(STAKE);

    // ===== Later rounds: provide the two post-prediction values so D's
    // round-R binary prediction can resolve (value B then value C), and
    // settle it. D does NOT predict again — round R is the only round with a
    // delegated prediction, so each delegator's TOTAL gain equals exactly
    // their round-R slice. =====
    await nextRound();
    await registry.setValue(stream, 150); // value B (first update after predict)
    await nextRound();
    await registry.setValue(stream, 200); // value C (second update) -> UP wins
    await nextRound();

    // Settle D's round-R prediction (binary: two score steps).
    await satori.connect(owner).settlePrediction(D.address, gameId);

    // ===== Both delegators claim. =====
    const aBefore = await satori.balanceOf(A.address);
    const bBefore = await satori.balanceOf(B.address);

    await satori.connect(A)["claim()"]();
    await satori.connect(B)["claim()"]();

    const aGained = (await satori.balanceOf(A.address)) - aBefore;
    const bGained = (await satori.balanceOf(B.address)) - bBefore;

    // B (who stayed delegated) earned a positive round-R slice — the round paid out.
    expect(bGained).to.be.gt(0n);

    // INTENDED (owner-confirmed): A FORFEITS round R's share by undelegating
    // mid-round — she is credited 0 for it (endRound = R excludes the round).
    // A's slice is orphaned (never minted), NOT redistributed to B, so this is a
    // benign under-distribution: B got exactly its own portion, nobody got A's.
    expect(aGained).to.equal(0n);
    // Sanity that this is the forfeit, not equality: A < B.
    expect(aGained).to.be.lt(bGained);
  });
});
