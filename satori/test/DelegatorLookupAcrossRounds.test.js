/**
 * DelegatorLookupAcrossRounds.test.js
 *
 * Companion to DelegatedPowerSnapshotTiming. The earlier per-receipt
 * checkpoint scheme returned the post-receipt live balance for any round
 * NOT covered by a checkpoint. So if the delegate predicted again the
 * day AFTER the receipt, the rate pool stayed at the original delegated
 * balance while the lookup returned the post-receipt live balance. The
 * numerator overshot the denominator — protocol overpaid by
 * `(liveBalance - startBalance) * delegatorsShare / startBalance` per
 * post-checkpoint round.
 *
 * Fix: receipts schedule a next-round activation. The pool pending
 * bucket and the per-delegator cp at today+1 both fold in lazily on the
 * next read. Same-day predictions still see the pre-receipt pool;
 * next-day predictions see the post-receipt pool, and the lookup at
 * that round returns the post-receipt cp value. Rate pool and lookup
 * agree by construction in both regimes.
 */

const { expect } = require("chai");
const { deploySatoriFixtureNoFee, RAW_TOLERANCE, pack1, VOTE, warmUpLoyalty } = require("./fixtures");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const UP = 1;

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

describe("Delegator lookup across rounds", function () {
    let satori, voting, rewards, bounties, registry;
    let owner, alice, bob, carol, dave, platform;
    // The on-chain game gross: the hub's emission net of the senior dev fee.
    // Read from the hub — the 1152 this file was written around was 1440 − 288,
    // and the emission is the hub's decaying schedule now.
    let GROSS;
    const NET = (x) => x - (x * 500n) / 10000n; // net of the 5% eager-referral skim

    beforeEach(async function () {
        [owner, alice, bob, carol, dave, platform] = await ethers.getSigners();
        const fix = await deploySatoriFixtureNoFee();
        ({ satori, voting, rewards, registry } = fix);

        await satori.transfer(alice.address, ethers.parseEther("100"));
        await satori.transfer(carol.address, ethers.parseEther("100"));
        await satori.transfer(dave.address, ethers.parseEther("100"));

        GROSS = (await satori.emissionRateNow()) - (await satori.devRateNow());
        await advanceRound();
    });

    it("delegator lookup and rate pool stay aligned across rounds after a mid-period receipt", async function () {
        // Setup: two streams so Bob can predict on different rounds. The
        // per-stream provider cut is gone (providers are not paid at all), so
        // the 3-arg cadence-only overload is the whole signature now.
        const s1 = await getStreamIdFromTx(
            await satori["createSimpleDataStream(string,address,uint24)"]("S1", owner.address, 1440), satori);
        const s2 = await getStreamIdFromTx(
            await satori["createSimpleDataStream(string,address,uint24)"]("S2", owner.address, 1440), satori);
        await registry.setValue(s1, 100);
        await registry.setValue(s2, 100);
        await satori.connect(dave).vote(s1, VOTE);
        await satori.connect(alice).vote(s2, VOTE);

        // Day D: Carol delegates 100 to Bob, then receives 50 more,
        // then Bob predicts on s1. The receipt schedules cp(D+1)=150
        // and pool pending {50, D+1}; rate pool stays at 100 for
        // round-D predictions.
        await satori.connect(carol).delegatePredictionPower(bob.address);
        // Delegator weight is capital x loyalty and a fresh delegation starts
        // at L = 0, so the credits measured below read zero without a warm-up.
        // Drains to `platform`, leaving carol's balance (her delegated capital)
        // and bob's ownPower exactly as set up. The warm-up eats rounds, so the
        // stream needs a fresh value before the next predict.
        await warmUpLoyalty(satori, registry, null, bob, [carol], platform, s1);
        await registry.setValue(s1, 100);
        await satori.transfer(carol.address, ethers.parseEther("50"));
        await satori.connect(bob).predictMultipleWithPayloads([{ gameId: s1, payload: pack1(UP) }]);

        // Day D+1: Bob predicts on s2. Pending activates → rate pool=150
        // and lookup at D+1 = cp(D+1)=150. Pool and lookup agree:
        // delegatorsShare per round / Carol's effective per round =
        // (delegatorsShare/pool) and Carol's credit = pool * that, so
        // she always nets exactly delegatorsShare per winning round.
        await advanceRound();
        await registry.setValue(s1, 110);
        await registry.setValue(s2, 100);
        await satori.connect(bob).predictMultipleWithPayloads([{ gameId: s2, payload: pack1(UP) }]);

        // Settle both predictions.
        await advanceRound();
        await registry.setValue(s1, 120);
        await registry.setValue(s2, 110);

        await advanceRound();
        await registry.setValue(s2, 120);

        await satori.settlePrediction(bob.address, s1);
        await satori.settlePrediction(bob.address, s2);

        // ownPower=0 (bob has no own balance). totalPower per round =
        // delegatedPower per round → delegatedReward = streamAllocation.
        //
        // BURN-VOTING DENOMINATOR: a round's denominator is the sum of the
        // frozen weights of the games actually PREDICTED that round, not of
        // every weighted game. Bob predicts s1 alone on day D and s2 alone on
        // day D+1, so each round's denominator is that one game's 10-ether burn
        // and its allocation is the FULL residual on-chain gross GROSS
        // (emission net of the senior dev fee). The old 100/200 halving is gone
        // with the round-totals lock that produced it: dave's and alice's burns
        // never sit in the same denominator, because their games are never
        // predicted in the same round.
        //
        // Round D pool=100, round D+1 pool=150; the lookup tracks each, so
        // Carol nets the same per-round credit either way — which is the
        // alignment this test exists to prove. Gross per round is the
        // delegators' 90% of GROSS, over two rounds.
        //
        // Referral-eager-credit: Carol's delegator share routes through
        // _creditReward at settle, which skims REFERRAL_BPS (5%) off every
        // credit. Carol has no referral, so the 5% lands in the
        // MARKETING_FEE_RECIPIENT bucket and her own net (what claim() mints)
        // is gross − floor(gross * 500 / 10000) (the missing 5% is the
        // marketing bucket; total still conserved).
        const carolBefore = await satori.balanceOf(carol.address);
        await satori.connect(carol).claim();
        const carolReward = (await satori.balanceOf(carol.address)) - carolBefore;
        expect(carolReward).to.be.closeTo(NET(((GROSS * 90n) / 100n) * 2n), RAW_TOLERANCE);
    });

    it("multiple receipts during a single period don't compound the over-credit", async function () {
        // Every-round (1440-minute) stream, matching the two above: the D/D+1/D+2
        // steps here are DELEGATION checkpoint boundaries, so the stream must
        // stay writable every round.
        const sid = await getStreamIdFromTx(
            await satori.connect(owner)["createSimpleDataStream(string,address,uint24)"]("S", owner.address, 1440), satori);
        await registry.setValue(sid, 100);
        await satori.connect(dave).vote(sid, VOTE);

        // Day D: Carol delegates 100 to Bob. Receives 25 mid-day-D —
        // schedules cp(D+1)=125 and pool pending {25, D+1}.
        await satori.connect(carol).delegatePredictionPower(bob.address);
        // Delegator weight is capital x loyalty and a fresh delegation starts
        // at L = 0, so the credits measured below read zero without a warm-up.
        // Drains to `platform`, leaving carol's balance (her delegated capital)
        // and bob's ownPower exactly as set up. The warm-up eats rounds, so the
        // stream needs a fresh value before the next predict.
        await warmUpLoyalty(satori, registry, null, bob, [carol], platform, sid);
        await registry.setValue(sid, 100);
        await satori.transfer(carol.address, ethers.parseEther("25"));

        // Advance to D+1. The next sync flushes the prior pending →
        // pool=125, then schedules cp(D+2)=150 and pending {25, D+2}.
        // Bob predicts on D+1 with pool=125.
        await advanceRound();
        await registry.setValue(sid, 100);
        await satori.transfer(carol.address, ethers.parseEther("25"));
        await satori.connect(bob).predictMultipleWithPayloads([{ gameId: sid, payload: pack1(UP) }]);

        // Settle.
        await advanceRound();
        await registry.setValue(sid, 110);
        await advanceRound();
        await registry.setValue(sid, 120);

        await satori.settlePrediction(bob.address, sid);

        // One predicted game, so it is the whole round denominator and
        // streamAllocation = the residual on-chain gross GROSS (emission net of
        // the senior dev fee). ownPower=0, delegatedPower at D+1 = 125 →
        // delegatedReward = the full allocation. Lookup at D+1 = cp(D+1) = 125,
        // so Carol's credit is the whole delegator pool exactly once. Old
        // (broken) logic: checkpoint at D+1 stored pre-receive 125 → numerator
        // 125 over a 100-locked denominator → credit overshot the pool.
        //
        // Gross = the full delegator share (90%) of the round gross.
        //
        // Referral-eager-credit: Carol's delegator share is credited via
        // _creditReward at settle, which skims REFERRAL_BPS (5%). Carol has no
        // referral, so the cut goes to MARKETING_FEE_RECIPIENT and her own net
        // (minted by claim()) is gross − floor(gross * 500 / 10000); the skim
        // is claimable from the marketing bucket, so the total is conserved.
        const carolBefore = await satori.balanceOf(carol.address);
        await satori.connect(carol).claim();
        const carolReward = (await satori.balanceOf(carol.address)) - carolBefore;
        expect(carolReward).to.be.closeTo(NET((GROSS * 90n) / 100n), RAW_TOLERANCE);
    });
});
