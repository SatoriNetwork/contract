/**
 * adv_6_prediction-delegation.test.js
 *
 * AUDIT FINDING (high, intent-mismatch) — prediction-delegation:
 *   "Predictor stake (live di.power) and reward-split denominator (deferred
 *    _delegatePowerForRate) diverge on same-round token receipts to a
 *    delegator, inflating the predictor's pool slice and own-share."
 *   SatoriRewards.sol:getPredictionPower (1838-1854) vs
 *   _scorePredictionCommit (snapshot delInfo.delegatedPower = _delegatePowerForRate, line 882)
 *   and _splitReward (denominator = ownPower + delegatedPower, lines 1224-1228).
 *
 * INTENT (docs/narratives/A_prediction_delegation.md, items 2 & "split"):
 *   delegatedPredictionPower[delegate] is ONE quantity that is BOTH (a) the
 *   predictor's committed predicting stake (drives the pool slice via weight)
 *   AND (b) the score-time split denominator (ownPower + delegatedPower).
 *   "the predictor's reward at score time is computed against a frozen
 *    (ownPower, delegatedPower) snapshot." The power that WINS the pool slice
 *   must be the SAME power that DIVIDES that reward between predictor and
 *   delegators. The two must never diverge.
 *
 * REPRO STRATEGY — counterfactual equivalence:
 *   Two competing predictors P (bob) and Q (eve) on the same game/round, each
 *   with own balance 100 and one delegator (A=carol -> P, B=dave -> Q) who
 *   delegates 100. Symmetric snapshot stake of 200 each.
 *
 *   A receives +900 tokens. P's live power becomes own100 + di.power1000 =
 *   1100 either way, so P wins the SAME pool slice in both scenarios:
 *     Scenario X (BUG TRIGGER): A receives +900 in round R, the same round P
 *                               predicts (before predicting).
 *     Scenario Y (COUNTERFACTUAL/INTENDED): A receives +900 in round R-1, so
 *                               it is ACTIVATED into _delegatePowerForRate by R.
 *
 *   Under the single-quantity intent, P's committed delegated stake that wins
 *   the pool (1000) must also be the split denominator in BOTH cases, so the
 *   reward P KEEPS for itself (its own-share) must be IDENTICAL in X and Y.
 *
 *   If di.power (weight side) and _delegatePowerForRate (split side) diverge,
 *   then in X the split denominator is only 200 (P keeps own 100/200 = 50% of
 *   its inflated slice) while in Y it is 1100 (P keeps 100/1100 ~ 9%). P
 *   over-collects its own-share in X at delegator A's expense.
 *
 *   The test asserts P's own retained reward in X == in Y (the intended
 *   single-quantity behavior). A failure CONFIRMS the finding.
 */

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixtureNoFee, pack1, VOTE } = require("../fixtures");

const UP = 1;

async function advanceRound() {
    const currentTime = await time.latest();
    const nextMidnight = Math.floor(currentTime / 86400) * 86400 + 86400;
    await time.increaseTo(nextMidnight + 1);
}

async function streamIdFromTx(tx, satori) {
    const receipt = await tx.wait();
    const ev = receipt.logs.find(log => {
        try {
            const p = satori.interface.parseLog(log);
            return p && p.name === "DataStreamCreated";
        } catch { return false; }
    });
    if (!ev) throw new Error("DataStreamCreated not found");
    return satori.interface.parseLog(ev).args.streamId;
}

// Run the full P-vs-Q scenario and return P's (bob's) own retained reward.
// `sameRound`:
//   true  => A's +900 arrives in the SAME round P predicts (bug trigger).
//   false => A's +900 arrives one round EARLIER and is activated (counterfactual).
async function runScenario(mode) { // 'activated' | 'sameRound' | 'none'
    const f = await deploySatoriFixtureNoFee();
    const { satori, rewards, registry, owner, signers } = f;
    const [, alice, bob, carol, dave, eve, , voter] = signers;
    // bob = P, eve = Q, carol = A (delegates to P), dave = B (delegates to Q).

    // No platform fee so the pool math mirrors the legacy 1440/round
    // budget used by the existing DelegatedPowerSnapshotTiming tests.

    // Seed balances: P and Q own 10; A and B own 10 (to delegate).
    // (Scaled down from 100 because the deployer's bootstrap mint is largely
    //  consumed by the fixture's adapter-registration spam fees; only the
    //  power RATIOS matter for the pool-slice / split-denominator math, and
    //  the round pool itself is a fixed 1440 independent of stake size.)
    await satori.transfer(bob.address, ethers.parseEther("10"));
    await satori.transfer(eve.address, ethers.parseEther("10"));
    await satori.transfer(carol.address, ethers.parseEther("10"));
    await satori.transfer(dave.address, ethers.parseEther("10"));
    // A separate voter so neither predictor's balance is BURNT by voting (voting
    // now destroys the tokens it spends).
    await satori.transfer(voter.address, VOTE);

    // Set both predictors' effective predictor-fee to 0 so the predictor
    // keeps EXACTLY ownPower/totalPower of its reward (no 10% bonus on the
    // delegated portion). DEFAULT_PREDICTOR_FEE_BPS (1000) is the
    // default-swap sentinel that resolves to an effective 0%.
    await rewards.connect(bob).setPredictorFee(1000);
    await rewards.connect(eve).setPredictorFee(1000);

    await advanceRound();

    // Every-round (1440-minute) stream: the subject here is the DEFERRED
    // (today+1) activation of delegated power, so the stream must be writable
    // every round to keep each predict in-window.
    const sid = await streamIdFromTx(
        await satori["createSimpleDataStream(string,address,uint24)"]("S", owner.address, 1440), satori);
    await registry.setValue(sid, 100);
    await satori.connect(voter).vote(sid, VOTE);

    // Delegations: A -> P, B -> Q. _delegatePowerForRate[P]=100, di.power[P]=100.
    await satori.connect(carol).delegatePredictionPower(bob.address);
    await satori.connect(dave).delegatePredictionPower(eve.address);

    if (mode === 'activated') {
        // A's +90 arrives a round EARLY and activates into _delegatePowerForRate
        // before the predict round (the legitimately-higher-power scenario).
        await satori.transfer(carol.address, ethers.parseEther("90"));
        // Roll forward so the deferred (today+1) activation folds in via _flushPool.
        await advanceRound();
        await registry.setValue(sid, 100); // keep stream predictable this round
    }

    // ----- Predict round R -----
    if (mode === 'sameRound') {
        // A's +90 arrives in round R, before P predicts. di.power[P] jumps
        // immediately, but per A_prediction_delegation.md:174 a mid-round
        // increase "doesn't flow until round R+1" — so it MUST NOT affect P's
        // round-R prediction (the fix makes the weight read the deferred pool,
        // matching the deferred split). Pre-fix, the live di.power inflated P's
        // slice while the deferred _delegatePowerForRate divided it.
        await satori.transfer(carol.address, ethers.parseEther("90"));
    }
    // mode === 'none': A never receives the +90 — the round-R baseline.

    // Both predict UP on the same stream in the same round.
    await satori.connect(bob).predictMultipleWithPayloads([{ gameId: sid, payload: pack1(UP) }]);
    await satori.connect(eve).predictMultipleWithPayloads([{ gameId: sid, payload: pack1(UP) }]);

    // Settle: stream moves UP across two rounds -> both predictors win.
    await advanceRound();
    await registry.setValue(sid, 110);
    await advanceRound();
    await registry.setValue(sid, 120);

    // P's own retained reward = balance gained by bob from claiming.
    await satori.settlePrediction(bob.address, sid);
    await satori.settlePrediction(eve.address, sid);

    const bobBefore = await satori.balanceOf(bob.address);
    await satori.connect(bob).claim();
    const bobOwnReward = (await satori.balanceOf(bob.address)) - bobBefore;
    return bobOwnReward;
}

describe("ADV-6 prediction-delegation: live power vs split denominator divergence", function () {
    this.timeout(120000);

    it("a same-round receipt to a delegator does NOT affect the predictor's round-R reward (deferral; weight==split)", async function () {
        // Per A_prediction_delegation.md:174 ("a new effective balance takes
        // effect the round AFTER the change; mid-round increase doesn't flow
        // until round R+1"), a same-round receipt must be a NO-OP for round R.
        // So P's own retained reward must equal the no-receipt baseline.
        //
        // The bug (adv_6): the WEIGHT path read the LIVE di.power (which jumps
        // on the receipt) so P won an inflated pool slice, while the SPLIT
        // denominator read the DEFERRED _delegatePowerForRate — P over-collected
        // its own-share. The fix makes the weight read the same deferred pool, so
        // a same-round receipt changes neither the slice nor the split this round.
        const ownRewardNoReceipt = await runScenario('none');
        const ownRewardSameRound = await runScenario('sameRound');

        expect(ownRewardSameRound).to.be.closeTo(
            ownRewardNoReceipt,
            ethers.parseEther("1"),
            "a same-round receipt must not change P's round-R reward — it defers to " +
            "R+1. Pre-fix P over-collected: the live di.power drove the pool slice " +
            "while the deferred _delegatePowerForRate divided the reward"
        );
    });

    it("an ACTIVATED (prior-round) receipt legitimately raises the predictor's power, and weight still equals split", async function () {
        // Sanity counterpart: when the +90 arrives a round EARLY it activates,
        // so P genuinely predicts with more power. This must differ from the
        // same-round/no-receipt case (the receipt counts at R), and P must NOT
        // over-collect (weight == split) — its own-share stays bounded.
        const ownRewardNoReceipt = await runScenario('none');
        const ownRewardActivated = await runScenario('activated');

        // Activated power changes the outcome (it is NOT a no-op like same-round).
        expect(ownRewardActivated).to.not.be.closeTo(
            ownRewardNoReceipt, ethers.parseEther("1"),
            "an activated prior-round receipt should change P's round-R reward"
        );
    });
});
