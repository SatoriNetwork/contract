/**
 * GAP: setPredictorFee read FRESH at score time → retroactive skim of an
 *      already-committed (default-fee) delegated prediction.
 *
 * _splitReward (SatoriRewards.sol ~1315) reads predictorFeeStored[user]
 * directly at scoring time — there is NO snapshot of the rate at predict
 * time. The contract comment (SatoriRewards.sol) claims the
 * one-shot setPredictorFee "locks on first use ... so the score path reads
 * the rate directly with no snapshot and no risk of a mid-cycle change."
 *
 * That claim only holds once a NON-default rate is ALREADY stored. From the
 * default (stored == 0) state, the FIRST set is reachable AFTER a prediction
 * has been committed (predict) and BEFORE it scores (settle). Because the
 * score path reads the fee fresh, that first set retroactively re-splits the
 * already-committed prediction.
 *
 * SINCE the cap was lowered to 10% (== the default), that retroactive re-split
 * is now ONE-SIDED: the most a predictor can commit is the 10% baseline the
 * delegator already saw, so the fresh read can only HOLD or IMPROVE the
 * delegator's share (a predictor can commit a LOWER rate, never a higher one).
 * The harmful direction that previously cut delegators from 90% to 80% is
 * closed by the cap. This file pins that the fresh read still happens and that
 * its effect on the delegator is now bounded below by the default.
 *
 * Existing PredictorFee.test.js "split behavior" tests ALL call
 * setPredictorFee BEFORE the predict, so the rate is fixed before the
 * prediction is committed. NONE of them set the fee in the
 * predict→score window. This file pins the deviation so an immutable
 * single launch never accidentally "fixes" it (or, if it should be
 * snapshotted, documents it).
 *
 * NOTE: per task rules this file does NOT edit the contract. It pins the
 * CURRENT (retroactive) behavior. If the assertion ever flips to the
 * snapshot semantics, that is a deliberate contract change and this test
 * is the canary.
 */

const { expect } = require("chai");
const { deploySatoriFixtureNoFee, RAW_TOLERANCE, pack1, VOTE, warmUpLoyalty } = require("../fixtures");
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
    try { return satori.interface.parseLog(log)?.name === 'DataStreamCreated'; }
    catch { return false; }
  });
  if (!event) throw new Error("DataStreamCreated event not found");
  return satori.interface.parseLog(event).args.streamId;
}

async function deployStack(platform) {
  // Restructured split stack behind the monolith-shaped compat shim. Deployed
  // with a 0 bps platform fee (deploySatoriFixtureNoFee) so the delegated split
  // math is uncluttered by any in-rewards fee. NOTE: the on-chain per-round game
  // gross is the hub's emission NET of the senior dev fee, which is carved first
  // on the immutable token (see test/next/DevFee.test.js) and is UNCONDITIONAL,
  // so even the "NoFee" fixture never sees the full emission in the pool. (The
  // `platform` signer arg is retained for call-site compatibility.)
  const fix = await deploySatoriFixtureNoFee();
  return {
    satori: fix.satori,
    voting: fix.voting,
    rewards: fix.rewards,
    registry: fix.registry,
    lens: fix.lens,
  };
}

describe("GAP: predictor fee read fresh at score time → retroactive skim", function () {
  let satori, voting, rewards, registry, lens;
  let owner, alice, bob, carol, dave, platform;
  // The on-chain gross and the delegated half of it, read from the hub — the old
  // 1152 literal was 1440 − 288, and the emission is the hub's schedule now.
  let GROSS, HALF;
  const NET = (x) => (x * 95n) / 100n; // net of the 5% eager-referral skim

  beforeEach(async function () {
    [owner, alice, bob, carol, dave, platform] = await ethers.getSigners();
    ({ satori, voting, rewards, registry, lens } = await deployStack(platform));
    await satori.transfer(alice.address, ethers.parseEther("100"));
    await satori.transfer(bob.address, ethers.parseEther("100"));
    await satori.transfer(carol.address, ethers.parseEther("100"));
    await satori.transfer(dave.address, ethers.parseEther("100"));
    GROSS = (await satori.emissionRateNow()) - (await satori.devRateNow());
    HALF = GROSS / 2n;
    await advanceRound();
  });

  // Same scoring flow as PredictorFee.test.js's runDelegatedWin, but the
  // caller decides WHEN to set the predictor fee relative to predict/score.
  //   - mode "before": set BEFORE predict (the existing, snapshot-safe path)
  //   - mode "midwindow": set AFTER predict, BEFORE the prediction scores
  //   - mode "never": never set (the default 10%)
  // Carol delegates to Bob; Bob predicts UP with own 100 + delegated 100.
  // The on-chain GROSS is the emission minus the senior dev fee, and the WHOLE
  // of it is the payable budget — the flat first-predictor bonus and its
  // upfront reservation are both gone. delegatedReward = HALF. Carol takes
  // (1 − feeBps) of HALF; Bob keeps his own HALF + the feeBps bonus.
  async function runDelegatedWin({ setFeeBps, when }) {
    // Admin-created 720-minute (sub-round) stream: this file is about WHEN the
    // predictor fee is read (predict vs score), not about stream cadence, so
    // the every-round ABC rhythm below is kept. `satori` is connected to
    // `owner`, who is rewards.admin() and therefore exempt from the
    // 1440-minute public cadence floor.
    const sid = await getStreamIdFromTx(
      await satori["createSimpleDataStream(string,address,uint24)"]("S", owner.address, 720), satori);
    await registry.setValue(sid, 100);
    await satori.connect(dave).vote(sid, VOTE);

    if (when === "before") {
      await rewards.connect(bob).setPredictorFee(setFeeBps);
    }

    await satori.connect(carol).delegatePredictionPower(bob.address);
    // Delegator weight is capital x loyalty and a fresh delegation starts at
    // L = 0, so every figure below reads zero without a warm-up. The fee
    // arithmetic is untouched by loyalty -- the fee splits the DELEGATED HALF
    // predictor-vs-delegators, loyalty only divides the delegator side, and
    // with one delegator there is nothing to divide. Drains to `owner` so
    // bob's ownPower and carol's capital stay where the comments assume.
    await warmUpLoyalty(satori, registry, null, bob, [carol], owner, sid);
    await registry.setValue(sid, 100);
    // Marketing bucket DELTA from HERE: the warm-up is itself a scored round
    // that skims into the same bucket, and the PREDICTOR's skim is credited
    // eagerly at settle -- so the snapshot has to precede the predict, not the
    // claims.
    const mktStart = await rewards.unclaimedRewards(await rewards.marketingFeeRecipient());
    await satori.connect(bob).predictMultipleWithPayloads([{ gameId: sid, payload: pack1(UP) }]);

    // At predict time Bob is unset → delegators see the visible 10% default.
    if (when === "midwindow") {
      expect(await lens.predictorFeeBps(bob.address)).to.equal(1000);
      // The prediction is committed; the round has NOT scored yet. Bob now
      // commits a non-default rate from the previously-untouched state.
      await rewards.connect(bob).setPredictorFee(setFeeBps);
      expect(await lens.predictorFeeBps(bob.address)).to.equal(setFeeBps);
    }

    await advanceRound();
    await registry.setValue(sid, 110);
    await advanceRound();
    await registry.setValue(sid, 120);

    await satori.settlePrediction(bob.address, sid);

    const carolBefore = await satori.balanceOf(carol.address);
    const bobBefore = await satori.balanceOf(bob.address);
    await satori.connect(carol).claim();
    await satori.connect(bob).claim();
    // Eager-credit referral model: a flat 5% (REFERRAL_BPS) is skimmed from
    // EVERY reward credit — the delegator share AND the predictor reward.
    // Neither Carol nor Bob set a referral,
    // so each earner's 5% routes to MARKETING_FEE_RECIPIENT's UNCLAIMED bucket
    // (claimable by it, not minted to Carol/Bob). Carol's cut is diverted when
    // her pending delegator share is credited at claim; Bob's when his predictor
    // reward is credited at score. We surface that bucket so the round-budget
    // conservation stays EXACT: earner_net + diverted_5% == the full budget.
    const marketing = await rewards.marketingFeeRecipient();
    return {
      carolGained: (await satori.balanceOf(carol.address)) - carolBefore,
      bobGained: (await satori.balanceOf(bob.address)) - bobBefore,
      marketingCut: (await rewards.unclaimedRewards(marketing)) - mktStart,
    };
  }

  it("baseline: prediction left at the default 10% → delegator gets 90% of the delegated half, net of the 5% skim", async function () {
    const { carolGained, bobGained, marketingCut } = await runDelegatedWin({ when: "never" });
    // Gross delegator share is 90% of HALF; the 5% referral skim nets it down.
    expect(carolGained).to.be.closeTo(NET((HALF * 90n) / 100n), RAW_TOLERANCE);
    // Bob's gross is his own HALF + the 10% bonus, each netted at 95%.
    expect(bobGained).to.be.closeTo(NET(HALF) + NET((HALF * 10n) / 100n), RAW_TOLERANCE);
    // Conservation is EXACT once the diverted 5% (now in the marketing bucket)
    // is counted: earner_net + marketing == the full on-chain gross.
    expect(carolGained + bobGained + marketingCut).to.be.closeTo(GROSS, RAW_TOLERANCE);
  });

  it("RETROACTIVE is now bounded by cap == default: a mid-window commit can never cut the delegator BELOW the ~90% visible at predict time (the harmful direction is closed)", async function () {
    // Carol delegated / was predicted with while Bob was at the default 10%.
    // Before the cap was lowered to 10%, Bob could bump to 20% mid-window and
    // cut Carol from 90% to 80%. Now the largest fee he can COMMIT is 999 bps
    // (1000 == the unlocked default), i.e. 9.99% — so Carol lands at 90.01%,
    // never below the 90% she saw. The fresh read still fires; its effect is
    // one-sided.
    const { carolGained, bobGained, marketingCut } = await runDelegatedWin({ setFeeBps: 999, when: "midwindow" });

    // At the max lockable 9.99% Carol gets 90.01% of HALF → ≥ the netted default
    // 90% share, NOT below it. Pin the one-sided bound.
    const defaultNet = NET((HALF * 90n) / 100n);
    expect(carolGained).to.be.gte(defaultNet - RAW_TOLERANCE);

    // Conservation still holds — the fee move is a transfer, not an over-mint —
    // and the referral skim only redistributes, so earner_net + marketing == GROSS.
    expect(carolGained + bobGained + marketingCut).to.be.closeTo(GROSS, RAW_TOLERANCE);
  });

  it("RETROACTIVE both directions: setPredictorFee(0) AFTER predict gives the delegator MORE (full 100%) than the 90% visible at predict time", async function () {
    // Symmetry check: the fresh-read also lets a predictor RAISE the
    // delegator's share retroactively. Pins that the score path takes the
    // post-predict value in both directions (so a fix would need a snapshot,
    // not a one-sided guard).
    const { carolGained, bobGained, marketingCut } = await runDelegatedWin({ setFeeBps: 0, when: "midwindow" });
    // The full HALF is Carol's gross (was 90% of it at the default); net of the
    // 5% skim that is still MORE than the netted default share, so the
    // retroactive raise helps her.
    expect(carolGained).to.be.closeTo(NET(HALF), RAW_TOLERANCE);
    // Bob's gross: his own HALF and no bonus.
    expect(bobGained).to.be.closeTo(NET(HALF), RAW_TOLERANCE);
    // Exact conservation once the diverted 5% (marketing bucket) is counted.
    expect(carolGained + bobGained + marketingCut).to.be.closeTo(GROSS, RAW_TOLERANCE);
  });

  it("equivalence: the midwindow set produces the SAME split as setting BEFORE predict — confirming the rate is never snapshotted at predict time", async function () {
    // If the prediction's split were frozen at predict time, the midwindow
    // set would differ from the before-predict set. It does not.
    const mid = await runDelegatedWin({ setFeeBps: 500, when: "midwindow" });

    // Fresh stack so Bob is unset again for the "before" run.
    ({ satori, voting, rewards, registry, lens } = await deployStack(platform));
    await satori.transfer(carol.address, ethers.parseEther("100"));
    await satori.transfer(bob.address, ethers.parseEther("100"));
    await satori.transfer(dave.address, ethers.parseEther("100"));
    GROSS = (await satori.emissionRateNow()) - (await satori.devRateNow());
    HALF = GROSS / 2n;
    await advanceRound();
    const before = await runDelegatedWin({ setFeeBps: 500, when: "before" });

    expect(mid.carolGained).to.be.closeTo(before.carolGained, RAW_TOLERANCE);
    expect(mid.bobGained).to.be.closeTo(before.bobGained, RAW_TOLERANCE);
  });
});
