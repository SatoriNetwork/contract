/**
 * DelegatedPowerSnapshotTiming.test.js
 *
 * scorePrediction snapshots the delegated-pool size used as the rate
 * denominator. The denominator must match what the per-delegator
 * lookups will sum to at claim time. Before the fix it read the live
 * delegatedPredictionPower, which drifts above the lookup sum whenever
 * a delegator's balance changes mid-day — a transfer-in pushed the
 * live total up immediately while the per-delegator effective balance
 * for that round stayed at its pre-transfer value. The difference was
 * permanently orphaned.
 *
 * The fix introduces _delegatePowerForRate, separate from the live
 * delegatedPredictionPower. Token receipts schedule a next-round
 * activation (pool pending bucket + per-delegator cp at today+1)
 * rather than bumping the rate pool on the same day. Same-day
 * predictions therefore see the pre-receipt pool, and the lookup at
 * round D returns the pre-receipt effective balance — denominator and
 * numerator stay on the same frame.
 */

const { expect } = require("chai");
const { deploySatoriFixtureNoFee, RAW_TOLERANCE, pack1, VOTE } = require("./fixtures");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const UP = 1;

// Explicit 3-arg overload. Every stream below is created at 1440 minutes,
// i.e. writable every round: the same-day vs next-day frames these tests
// compare are DELEGATION checkpoint frames, not stream write frames, so the
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

describe("Delegated-power snapshot timing", function () {
    let satori, voting, rewards, bounties, registry;
    let owner, alice, bob, carol, dave, eve, platform;
    // The on-chain game gross for a round: the hub's emission net of the senior
    // dev fee. Read from the hub — the 1152 this file used to be written around
    // was 1440 − 288, and the emission is the hub's decaying schedule now.
    let GROSS;
    const NET = (x) => x - (x * 500n) / 10000n; // net of the 5% eager-referral skim

    beforeEach(async function () {
        [owner, alice, bob, carol, dave, eve, platform] = await ethers.getSigners();
        const fix = await deploySatoriFixtureNoFee();
        ({ satori, voting, rewards, registry } = fix);

        await satori.transfer(alice.address, ethers.parseEther("100"));
        await satori.transfer(bob.address, ethers.parseEther("100"));
        await satori.transfer(carol.address, ethers.parseEther("100"));
        await satori.transfer(dave.address, ethers.parseEther("100"));

        GROSS = (await satori.emissionRateNow()) - (await satori.devRateNow());
        await advanceRound();
    });

    it("delegator with mid-day balance increase before predict gets full fair share", async function () {
        // Carol delegates to Bob, then receives more tokens mid-day,
        // then Bob predicts. Before the fix, the live denominator (post
        // -receipt) overshot Carol's start-of-period checkpoint and
        // about a third of delegatorsShare was orphaned.
        const sid = await getStreamIdFromTx(
            await satori.connect(owner)[SIMPLE3]("S", owner.address, 1440), satori);
        await registry.setValue(sid, 100);
        await satori.connect(dave).vote(sid, VOTE);

        await satori.connect(carol).delegatePredictionPower(bob.address);
        await time.increase(86400);
        await registry.setValue(sid, 100);

        // Mid-day: Carol receives 50 more tokens. delegatedPredictionPower
        // (live) grows from 100 to 150, but _delegatePowerForRate stays
        // at 100 (only delegate/undelegate move it).
        await satori.transfer(carol.address, ethers.parseEther("50"));

        // Bob predicts. Snapshot reads _delegatePowerForRate = 100.
        await satori.connect(bob).predictMultipleWithPayloads([{ gameId: sid, payload: pack1(UP) }]);

        await advanceRound();
        await registry.setValue(sid, 110);
        await advanceRound();
        await registry.setValue(sid, 120);

        await satori.settlePrediction(bob.address, sid);

        // On-chain game budget is GROSS/round (the senior dev fee is carved out
        // of the immutable token) and the WHOLE of it is payable: the
        // first-predictor bonus reservation and the value-provider cut are both
        // gone. `sid` is the only game predicted this round, so it is the only
        // entry in the round denominator and takes all of GROSS.
        // ownPower = 100e18, delegatedPower = 100e18, total = 200e18, so the
        // delegated half of the reward is GROSS/2 and delegators take 90% of it.
        // Under the eager-referral model the 5% (REFERRAL_BPS=500) is
        // skimmed at credit time before it lands in Carol's unclaimed
        // bucket, so her claim mints the net 0.95 * gross. Carol has no
        // referral, so the 5% went to MARKETING_FEE_RECIPIENT (asserted
        // below). Net = 518.4 - floor(518.4*500/10000) = 492.48e18.
        // Carol's pending delegator share is credited at HER claim (via
        // _creditReward), so the marketing bucket delta across her claim
        // isolates exactly her 5% cut — independent of Bob's predictor cut.
        // gross == net minted + that delta.
        const marketing = await rewards.marketingFeeRecipient();
        const carolMktBefore = await rewards.unclaimedRewards(marketing);
        const carolBefore = await satori.balanceOf(carol.address);
        await satori.connect(carol).claim();
        const carolReward = (await satori.balanceOf(carol.address)) - carolBefore;
        const carolCut = (await rewards.unclaimedRewards(marketing)) - carolMktBefore;
        // delegated half, delegators' 90% of it, net of the 5% skim
        expect(carolReward).to.be.closeTo(NET(((GROSS / 2n) * 90n) / 100n), RAW_TOLERANCE);

        // The skimmed 5% is conserved, not burned: it sits in the
        // marketing bucket, claimable separately. gross == net + skim.
        expect(carolReward + carolCut).to.be.closeTo(((GROSS / 2n) * 90n) / 100n, RAW_TOLERANCE);
    });

    it("two delegators: Σ delegator credits == delegatorsShare (no orphan dust)", async function () {
        await satori.transfer(eve.address, ethers.parseEther("100"));

        const sid = await getStreamIdFromTx(
            await satori.connect(owner)[SIMPLE3]("S", owner.address, 1440), satori);
        await registry.setValue(sid, 100);
        await satori.connect(alice).vote(sid, VOTE);

        await satori.connect(dave).delegatePredictionPower(bob.address);
        await satori.connect(eve).delegatePredictionPower(bob.address);
        await time.increase(86400);
        await registry.setValue(sid, 100);

        // _delegatePowerForRate[bob] = 200 after both delegations.
        // Eve receives 50 mid-day. delegatedPredictionPower grows to
        // 250 live, but _delegatePowerForRate stays at 200.
        await satori.transfer(eve.address, ethers.parseEther("50"));

        await satori.connect(bob).predictMultipleWithPayloads([{ gameId: sid, payload: pack1(UP) }]);

        await advanceRound();
        await registry.setValue(sid, 110);
        await advanceRound();
        await registry.setValue(sid, 120);

        await satori.settlePrediction(bob.address, sid);

        // ownPower = 100e18, delegatedPower = 200e18, total = 300e18.
        // On-chain game budget is GROSS/round and the whole of it is payable (no
        // bonus reservation, no provider cut); `sid` is the only predicted game,
        // so it takes all of it. The delegated 2/3 goes to delegators at 90%,
        // split equally (no orphan dust — the whole delegatorsShare is split
        // between them). The eager-referral skim takes 5% off each credit at
        // settle; neither has a referral, so both cuts route to
        // MARKETING_FEE_RECIPIENT.
        // Each delegator's pending share is credited at THEIR claim (via
        // _creditReward), so the marketing bucket delta across a single
        // delegator's claim isolates exactly that delegator's 5% cut —
        // independent of Bob's predictor cut. gross_delegator = net_minted +
        // own_marketing_delta, and Σ gross must equal the full delegatorsShare
        // split (691.2e18) with no dust.
        const marketing = await rewards.marketingFeeRecipient();

        const daveMktBefore = await rewards.unclaimedRewards(marketing);
        const daveBefore = await satori.balanceOf(dave.address);
        await satori.connect(dave).claim();
        const daveReward = (await satori.balanceOf(dave.address)) - daveBefore;
        const daveCut = (await rewards.unclaimedRewards(marketing)) - daveMktBefore;
        // delegated 2/3, delegators' 90% of it, split in two, net of the skim
        expect(daveReward).to.be.closeTo(NET((((GROSS * 2n) / 3n) * 90n) / 100n / 2n), RAW_TOLERANCE);

        const eveMktBefore = await rewards.unclaimedRewards(marketing);
        const eveBefore = await satori.balanceOf(eve.address);
        await satori.connect(eve).claim();
        const eveReward = (await satori.balanceOf(eve.address)) - eveBefore;
        const eveCut = (await rewards.unclaimedRewards(marketing)) - eveMktBefore;
        expect(eveReward).to.be.closeTo(NET((((GROSS * 2n) / 3n) * 90n) / 100n / 2n), RAW_TOLERANCE);

        // No-orphan-dust invariant, restated for the eager-referral model:
        // (net minted to each delegator) + (each delegator's own 5% cut)
        // == the full delegatorsShare split (345.6 + 345.6 = 691.2e18).
        expect(daveReward + daveCut + eveReward + eveCut)
            .to.be.closeTo((((GROSS * 2n) / 3n) * 90n) / 100n, RAW_TOLERANCE);
    });

    it("re-delegation unwinds only the original contribution from the rate pool", async function () {
        // Carol delegates 100 to Bob. Receives 50 more tokens. Re-delegates
        // to Eve. The rate pool on Bob must drop by exactly 100 (Carol's
        // original contribution), not 150 (her live balance) — otherwise
        // the unwind underflows or over-shrinks the pool.
        const sid = await getStreamIdFromTx(
            await satori.connect(owner)[SIMPLE3]("S", owner.address, 1440), satori);
        await registry.setValue(sid, 100);
        await satori.connect(dave).vote(sid, VOTE);

        // Bob predicts on his own first so we can confirm his rate-pool
        // path stays consistent.
        await satori.connect(carol).delegatePredictionPower(bob.address);
        await time.increase(86400);
        await registry.setValue(sid, 100);
        await satori.transfer(carol.address, ethers.parseEther("50"));

        // Carol redelegates to eve. Live balance is 150 but only 100 was
        // ever credited to _delegatePowerForRate[bob].
        await satori.connect(carol).delegatePredictionPower(eve.address);

        // The unwind is what this test is about, and it is visible in the new
        // period's startBalance: 150 live, not the 100 that was in Bob's rate
        // pool. Read it directly — the payout on the switch round is zero
        // either way now, since the switch opens a fresh period at L = 0.
        const [p2delegate, , , , p2start] = await rewards.delegationPeriodAt(carol.address, 1);
        expect(p2delegate).to.equal(eve.address);
        expect(p2start).to.equal(ethers.parseEther("150"));

        // Warm Carol's NEW relationship so her share against Eve is measurable.
        await time.increase(86400);
        await registry.setValue(sid, 100);

        // Eve predicts (on Carol's 150 of live delegated power, but
        // _delegatePowerForRate[eve] = 150 because the new period opens
        // at the live balance).
        await satori.connect(eve).predictMultipleWithPayloads([{ gameId: sid, payload: pack1(UP) }]);

        await advanceRound();
        await registry.setValue(sid, 110);
        await advanceRound();
        await registry.setValue(sid, 120);

        await satori.settlePrediction(eve.address, sid);

        // Eve has 0 own balance, full delegated pool 150. Total = 150, so the
        // reward is 100% delegated. On-chain game budget is GROSS/round and the
        // whole of it is payable (no bonus reservation, no provider cut); `sid`
        // is the only predicted game, so it takes all of it. Delegators take 90%.
        // The eager-referral model skims 5% when the share is credited (at her
        // claim, via _creditReward); Carol has no referral, so it routes to
        // MARKETING_FEE_RECIPIENT. Net = gross - floor(gross*500/10000). The
        // marketing bucket delta across her claim isolates exactly her cut.
        const marketing = await rewards.marketingFeeRecipient();
        const carolMktBefore = await rewards.unclaimedRewards(marketing);
        const carolBefore = await satori.balanceOf(carol.address);
        await satori.connect(carol).claim();
        const carolReward = (await satori.balanceOf(carol.address)) - carolBefore;
        const carolCut = (await rewards.unclaimedRewards(marketing)) - carolMktBefore;
        // 100% delegated, delegators' 90%, net of the 5% skim
        expect(carolReward).to.be.closeTo(NET((GROSS * 90n) / 100n), RAW_TOLERANCE);

        // The skimmed 5% is conserved in the marketing bucket:
        // net + skim == gross.
        expect(carolReward + carolCut).to.be.closeTo((GROSS * 90n) / 100n, RAW_TOLERANCE);
    });
});
