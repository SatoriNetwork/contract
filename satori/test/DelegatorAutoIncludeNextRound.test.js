/**
 * DelegatorAutoIncludeNextRound.test.js
 *
 * Receipts to a delegator should auto-include in the delegated pool —
 * but only starting at the next round, not the same round. This avoids
 * the same-round timing bug (predict-time pool snapshots a higher value
 * than the per-delegator lookups will sum to) without requiring users to
 * manually un-delegate and re-delegate to capture wallet growth.
 *
 * Same-day semantics: round D's predictions see the pre-receipt pool.
 *   Σ delegators (pre-receipt balance) == pool (pre-receipt). No drift.
 * Next-day semantics: round D+1 onward sees the post-receipt pool.
 *   Σ delegators (post-receipt balance) == pool (post-receipt).
 *
 * Implementation: per-delegator effective-balance checkpoints written at
 * round D+1 on a day-D receipt. Pool gets a pending bucket activated at
 * D+1, lazily flushed on next read. Re-delegation discards the period's
 * pending (the new period captures the live balance via its own
 * startBalance).
 */

const { expect } = require("chai");
const { deploySatoriFixtureNoFee, RAW_TOLERANCE, pack1, VOTE } = require("./fixtures");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const UP = 1;

// Explicit 3-arg overload. Every stream below is created at 1440 minutes,
// i.e. writable every round: the D / D+1 boundaries these tests straddle are
// DELEGATION checkpoint boundaries, not stream write boundaries, so the
// every-round rhythm must be preserved.
const SIMPLE3 = "createSimpleDataStream(string,address,uint24)";

async function advanceRound() {
    const currentTime = await time.latest();
    const nextMidnight = Math.floor(currentTime / 86400) * 86400 + 86400;
    await time.increaseTo(nextMidnight + 1);
}

async function getStreamIdFromTx(tx, satori) {
    const receipt = await tx.wait();
    const event = receipt.logs.find(log => {
        try {
            const parsed = satori.interface.parseLog(log);
            return parsed && parsed.name === 'DataStreamCreated';
        } catch {
            return false;
        }
    });
    if (!event) throw new Error("DataStreamCreated event not found");
    return satori.interface.parseLog(event).args.streamId;
}

describe("Delegator next-round auto-include", function () {
    let satori, voting, rewards, bounties, registry;
    let owner, alice, bob, carol, dave, eve, platform;
    // The on-chain game gross: the hub's emission net of the senior dev fee.
    // Read from the hub — the 1152 this file was written around was 1440 − 288,
    // and the emission is the hub's decaying schedule now.
    let GROSS;
    const NET = (x) => x - (x * 500n) / 10000n; // net of the 5% eager-referral skim

    beforeEach(async function () {
        [owner, alice, bob, carol, dave, eve, platform] = await ethers.getSigners();
        ({ satori, voting, rewards, registry } = await deploySatoriFixtureNoFee());

        await satori.transfer(alice.address, ethers.parseEther("100"));
        await satori.transfer(bob.address, ethers.parseEther("100"));
        await satori.transfer(carol.address, ethers.parseEther("100"));
        await satori.transfer(dave.address, ethers.parseEther("100"));

        GROSS = (await satori.emissionRateNow()) - (await satori.devRateNow());
        await advanceRound();
    });

    it("receipt on day D auto-includes for predict on day D+1", async function () {
        // Setup: bob has 100 own. Single voter dave so streamAllocation = the
        // residual on-chain gross GROSS (emission net of the senior dev fee).
        const sid = await getStreamIdFromTx(
            await satori.connect(owner)[SIMPLE3]("S", owner.address, 1440), satori);
        await registry.setValue(sid, 100);
        await satori.connect(dave).vote(sid, VOTE);

        // Day D: Carol delegates 100 to Bob, then receives 50. Pool stays
        // at 100 effective for round D (pending 50 buffered for D+1). Carol's
        // checkpoint stamped at D+1 with effective 150.
        await satori.connect(carol).delegatePredictionPower(bob.address);
        await satori.transfer(carol.address, ethers.parseEther("50"));

        // No prediction on day D — skip straight to D+1.
        await advanceRound();
        await registry.setValue(sid, 100);

        // Day D+1: Bob predicts. Lazy flush activates the pending → pool=150.
        // ownPower=100, delegatedPower=150, totalPower=250.
        // delegatedReward = GROSS * 150/250. delegatorsShare = 90% of that.
        // rate_{D+1} = (622.08 * SCALE) / 150.
        await satori.connect(bob).predictMultipleWithPayloads([{ gameId: sid, payload: pack1(UP) }]);

        await advanceRound();
        await registry.setValue(sid, 110);
        await advanceRound();
        await registry.setValue(sid, 120);

        await satori.settlePrediction(bob.address, sid);

        // Carol's lookup at D+1 hits her checkpoint = 150.
        // credit = 150 * 622.08/150 = 622.08.
        // Referral model: the 5% (REFERRAL_BPS=500) is skimmed from Carol's
        // delegator-share credit at settle time and routed to the marketing
        // bucket (Carol has no referral). Carol's own net claim is therefore
        // 622.08 * 0.95 = 590.976. The skimmed 31.104 lives in
        // unclaimedRewards(MARKETING_FEE_RECIPIENT); conservation is checked
        // explicitly below. (The pool-linear credit scales with the residual
        // on-chain gross — GROSS under 24h rounds.)
        const marketing = await rewards.marketingFeeRecipient();
        const marketingBefore = await rewards.unclaimedRewards(marketing);
        const carolBefore = await satori.balanceOf(carol.address);
        await satori.connect(carol).claim();
        const carolReward = (await satori.balanceOf(carol.address)) - carolBefore;
        const share1 = (((GROSS * 150n) / 250n) * 90n) / 100n;
        expect(carolReward).to.be.closeTo(NET(share1), RAW_TOLERANCE);
        // The 5% skim landed in the marketing bucket: net + skim == gross 622.08.
        const marketingCut = (await rewards.unclaimedRewards(marketing)) - marketingBefore;
        expect(carolReward + marketingCut).to.be.closeTo(share1, RAW_TOLERANCE);
    });

    it("receipt on day D does NOT count for predict on same day D", async function () {
        const sid = await getStreamIdFromTx(
            await satori.connect(owner)[SIMPLE3]("S", owner.address, 1440), satori);
        await registry.setValue(sid, 100);
        await satori.connect(dave).vote(sid, VOTE);

        // Day D: delegate, receive, predict — all same day. Pool stays at
        // 100 effective for day D's predictions. Pre-receipt invariant.
        await satori.connect(carol).delegatePredictionPower(bob.address);
        await advanceRound();
        await registry.setValue(sid, 100);
        await satori.transfer(carol.address, ethers.parseEther("50"));
        await satori.connect(bob).predictMultipleWithPayloads([{ gameId: sid, payload: pack1(UP) }]);

        await advanceRound();
        await registry.setValue(sid, 110);
        await advanceRound();
        await registry.setValue(sid, 120);

        await satori.settlePrediction(bob.address, sid);

        // ownPower=100, delegatedPower=100, totalPower=200.
        // delegatedReward = GROSS * 100/200. delegatorsShare = 90% of that.
        // Carol's lookup at D = startBalance = 100 (her D+1 checkpoint
        // is > D, doesn't apply).
        // Referral model: 5% of Carol's delegator-share credit is skimmed to
        // the marketing bucket at settle. Carol's own net claim is
        // credited at 95%; net + skim reconstructs the gross.
        const marketing = await rewards.marketingFeeRecipient();
        const marketingBefore = await rewards.unclaimedRewards(marketing);
        const carolBefore = await satori.balanceOf(carol.address);
        await satori.connect(carol).claim();
        const carolReward = (await satori.balanceOf(carol.address)) - carolBefore;
        const share2 = (((GROSS * 100n) / 200n) * 90n) / 100n;
        expect(carolReward).to.be.closeTo(NET(share2), RAW_TOLERANCE);
        const marketingCut = (await rewards.unclaimedRewards(marketing)) - marketingBefore;
        expect(carolReward + marketingCut).to.be.closeTo(share2, RAW_TOLERANCE);
    });

    it("re-delegation discards prior period's pending; new period captures live balance", async function () {
        const sid = await getStreamIdFromTx(
            await satori.connect(owner)[SIMPLE3]("S", owner.address, 1440), satori);
        await registry.setValue(sid, 100);
        await satori.connect(dave).vote(sid, VOTE);

        // Day D: Carol delegates 100 to Bob, receives 50 (pending for
        // D+1 in Bob's pool), then re-delegates to Eve.
        // Re-delegation must:
        //   1. Subtract 100 (Carol's effective at D) from Bob's pool.
        //   2. Subtract 50 (Carol's pending) from Bob's pool pending.
        //      Otherwise Eve's predict at D+1 would walk a stale Bob-side
        //      pending and Carol could be double-counted.
        //   3. Open Period 2 with Eve at startBalance = 150 (live).
        await satori.connect(carol).delegatePredictionPower(bob.address);
        await satori.transfer(carol.address, ethers.parseEther("50"));
        await satori.connect(carol).delegatePredictionPower(eve.address);

        // "New period captures live balance" is read off the period directly:
        // `startBalance` is the sharp observable, and it is the value the pool
        // decrements were supposed to produce — 150 live, not 100 with a stale 50
        // pending on Bob's side.
        const [p2delegate, , , , p2start] = await rewards.delegationPeriodAt(carol.address, 1);
        expect(p2delegate).to.equal(eve.address);
        expect(p2start).to.equal(ethers.parseEther("150"));

        // Eve's own power is 0, so her whole slice is the delegator pot and Carol
        // takes all of it — the 150/150 arithmetic the pinned wei below encode.
        await advanceRound();
        await registry.setValue(sid, 100);
        await satori.connect(eve).predictMultipleWithPayloads([{ gameId: sid, payload: pack1(UP) }]);

        await advanceRound();
        await registry.setValue(sid, 110);
        await advanceRound();
        await registry.setValue(sid, 120);

        await satori.settlePrediction(eve.address, sid);

        // Period 1 (Bob): closed at D, walks D, rate=0 (Bob never predicted).
        // Period 2 (Eve): walks D, rate populated. lookup = 150 (period 2
        // startBalance). credit = the whole delegator share.
        // Referral model: 5% of Carol's delegator-share credit is skimmed to
        // the marketing bucket at settle. Carol's own net claim is
        // credited at 95%; net + skim reconstructs the gross.
        const marketing = await rewards.marketingFeeRecipient();
        const marketingBefore = await rewards.unclaimedRewards(marketing);
        const carolBefore = await satori.balanceOf(carol.address);
        await satori.connect(carol).claim();
        const carolReward = (await satori.balanceOf(carol.address)) - carolBefore;
        const share3 = (GROSS * 90n) / 100n;
        expect(carolReward).to.be.closeTo(NET(share3), RAW_TOLERANCE);
        const marketingCut = (await rewards.unclaimedRewards(marketing)) - marketingBefore;
        expect(carolReward + marketingCut).to.be.closeTo(share3, RAW_TOLERANCE);
    });
});
