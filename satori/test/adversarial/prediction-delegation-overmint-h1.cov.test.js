// Adversarial verification of the H1 over-mint fix in delegatePredictionPower.
//
// H1 bug (now fixed): a prediction-delegation made to a delegate who ALREADY
// predicted this round let the new delegator collect that round's delegator
// reward share against a frozen split denominator that EXCLUDED them -> a
// phantom over-mint (~a full extra delegator share). The intended behavior is
// the inverse of the undelegate-mid-round forfeit: a late joiner earns NOTHING
// for the round in which the delegate had already predicted before they joined.
//
// Fix: in delegatePredictionPower's `delegate != address(0)` branch, if
// `_unsettledPredictionCount[delegate][today] > 0` the delegation is DEFERRED
// to today+1 (pool pending activation=today+1, period startBalance=0 plus a
// checkpoint at today+1==power). Otherwise it activates immediately.
//
// These probes try hard to BREAK the fix. The core invariant attacked:
//   Sum of delegator credits for a (delegate, round) MUST be <= the
//   delegatorsShare reserved at score time (emitted in RewardSplit), and a
//   late joiner must earn EXACTLY 0 for the already-predicted round.

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixtureNoFee, RAW_TOLERANCE, pack1, voteFor } = require("../fixtures");

const UP = 1;
const DEFAULT_GAME = 1;

// Use a full-round time increment (not snap-to-midnight): snap-to-midnight can
// leave a sub-cadence gap (< 86400 - 1800s) when the fixture deploys late in a
// round, tripping the registry's CadenceGapNotElapsed timestamp guard. A flat
// 86400s increment always clears the every-round cadence wait.
async function advanceRound() { await time.increase(86400); }

// Every stream below is created with an EXPLICIT every-round cadence (1440
// minutes = one write per 24h round). The streams are scaffolding: the subject
// is the H1 delegated-power over-mint path, so the every-round rhythm the
// probes are written against is kept.
const SIMPLE3 = "createSimpleDataStream(string,address,uint24)";

async function streamIdFrom(txPromise, satori) {
  const rcpt = await (await txPromise).wait();
  for (const log of rcpt.logs) {
    try {
      const p = satori.interface.parseLog(log);
      if (p && p.name === "DataStreamCreated") return p.args.streamId;
    } catch (e) {}
  }
  throw new Error("DataStreamCreated missing");
}

// Capture all RewardSplit events emitted by `rewards` during a tx, returning
// the reserved delegatorsShare keyed by `${predictor}:${gameId}:${round}`.
async function splitsFromTx(txPromise, rewards) {
  const rcpt = await (await txPromise).wait();
  const out = [];
  for (const log of rcpt.logs) {
    try {
      const p = rewards.interface.parseLog(log);
      if (p && p.name === "RewardSplit") {
        out.push({
          predictor: p.args.predictor,
          gameId: Number(p.args.gameId),
          round: Number(p.args.round),
          predictorAmount: p.args.predictorAmount,
          delegatorAmount: p.args.delegatorAmount,
        });
      }
    } catch (e) {}
  }
  return out;
}

// Capture RewardSplit events from an already-awaited receipt and fold the
// per-(round) delegatorsShare into the accumulator map (keyed by round number).
// Used by the continuous-run probes that need the reserved share PER round.
function foldSplits(rcpt, rewards, map) {
  for (const log of rcpt.logs) {
    try {
      const p = rewards.interface.parseLog(log);
      if (p && p.name === "RewardSplit") {
        map[Number(p.args.round)] = p.args.delegatorAmount;
      }
    } catch (e) {}
  }
}

// Common setup: deploy, zero the platform fee (so the budget is the clean
// per-round gross used by legacy delegation tests), seed balances, vote so the
// chosen stream is the sole eligible producer, advance one round so all of
// that becomes the governing snapshot.
async function setup() {
  const f = await loadFixture(deploySatoriFixtureNoFee);
  // Fixture deploys with a 0 bps platform fee for clean math.
  return f;
}

describe("verify H1 over-mint fix (delegatePredictionPower)", function () {
  // -------------------------------------------------------------------------
  // PROBE 1: Fresh delegation AFTER the delegate already predicted this round
  //          (the ORIGINAL bug). Late joiner must earn 0 for that round; the
  //          delegate's frozen split must be unaffected; no over-mint.
  // -------------------------------------------------------------------------
  it("PROBE 1: fresh delegation after delegate predicted -> late joiner earns 0 that round, no over-mint", async function () {
    const { satori, voting, registry, rewards, owner, signers } = await setup();
    const bob = signers[1];      // the delegate / predictor
    const dave = signers[2];     // early delegator (in the snapshot)
    const carol = signers[3];    // LATE delegator (joins after bob predicts)
    const voter = signers[4];

    await satori.transfer(bob.address, ethers.parseEther("100"));
    await satori.transfer(dave.address, ethers.parseEther("100"));
    await satori.transfer(carol.address, ethers.parseEther("100"));
    await satori.transfer(voter.address, ethers.parseEther("100"));

    const sid = await streamIdFrom(
      satori.connect(owner)[SIMPLE3]("S", owner.address, 1440), satori);
    await registry.connect(owner).setValue(sid, 100);
    await voteFor(satori, voter, sid);

    // Dave delegates BEFORE bob predicts -> in the snapshot.
    await satori.connect(dave).delegatePredictionPower(bob.address);

    await advanceRound();
    await registry.connect(owner).setValue(sid, 110);

    // Bob predicts. Snapshot: ownPower(bob)=100, delegatedPower=100 (dave only).
    const predRound = Number(await satori.getCurrentRound());
    await satori.connect(bob).predictMultipleWithPayloads([{ gameId: sid, payload: pack1(UP) }]);

    // CAROL JOINS LATE — bob already predicted THIS round. This is the H1 path.
    await satori.connect(carol).delegatePredictionPower(bob.address);

    await advanceRound();
    await registry.connect(owner).setValue(sid, 120);
    await advanceRound();
    await registry.connect(owner).setValue(sid, 130);

    // Settle bob's prediction (eager credit + records the delegator rate).
    const splits = await splitsFromTx(
      satori.settlePrediction(bob.address, sid), rewards);
    const split = splits.find(s => s.gameId === Number(sid) && s.round === predRound);
    expect(split, "RewardSplit for bob's prediction").to.not.be.undefined;
    const reserved = split.delegatorAmount;
    console.log("PROBE1 reserved delegatorsShare:", ethers.formatEther(reserved));

    // Claim both delegators. Carol must get 0 for predRound (she was excluded
    // from the snapshot). Dave gets the whole reserved share, less the 1%
    // referral skim taken at credit time (routed to MARKETING_FEE_RECIPIENT
    // since dave has no referral). We capture that skim from the marketing
    // bucket delta across dave's claim so the conservation stays EXACT.
    const mkt = await rewards.marketingFeeRecipient();
    const daveBefore = await satori.balanceOf(dave.address);
    const mktBeforeDave = await rewards.unclaimedRewards(mkt);
    await satori.connect(dave).claim();
    const daveGot = (await satori.balanceOf(dave.address)) - daveBefore;
    const daveSkim = (await rewards.unclaimedRewards(mkt)) - mktBeforeDave;

    const carolBefore = await satori.balanceOf(carol.address);
    const mktBeforeCarol = await rewards.unclaimedRewards(mkt);
    await satori.connect(carol).claim();
    const carolGot = (await satori.balanceOf(carol.address)) - carolBefore;
    const carolSkim = (await rewards.unclaimedRewards(mkt)) - mktBeforeCarol;

    console.log("PROBE1 dave got:", ethers.formatEther(daveGot),
                " carol(late) got:", ethers.formatEther(carolGot));

    // Carol earns NOTHING for the already-predicted round (and thus no skim).
    expect(carolGot).to.equal(0n);
    expect(carolSkim).to.equal(0n);
    // Dave gets the full reserved share once the 1% skim (now sitting in the
    // marketing bucket) is folded back in — exact conservation of the share.
    expect(daveGot + daveSkim).to.be.closeTo(reserved, RAW_TOLERANCE);
    // No over-mint: total delegator payout + its skim <= reserved.
    expect(daveGot + carolGot + daveSkim + carolSkim).to.be.lte(reserved + RAW_TOLERANCE);
  });

  // -------------------------------------------------------------------------
  // PROBE 2: SWITCH from an IDLE delegate to a delegate who ALREADY predicted
  //          this round. Flows through the same fixed branch.
  // -------------------------------------------------------------------------
  it("PROBE 2: switch from idle delegate to already-predicted delegate -> no over-mint", async function () {
    const { satori, voting, registry, rewards, owner, signers } = await setup();
    const bob = signers[1];      // active predictor (switch TARGET)
    const idle = signers[2];     // idle delegate (switch SOURCE), never predicts
    const dave = signers[3];     // early delegator to bob (in snapshot)
    const carol = signers[4];    // switches idle -> bob AFTER bob predicts
    const voter = signers[5];

    for (const u of [bob, idle, dave, carol, voter]) {
      await satori.transfer(u.address, ethers.parseEther("100"));
    }

    const sid = await streamIdFrom(
      satori.connect(owner)[SIMPLE3]("S", owner.address, 1440), satori);
    await registry.connect(owner).setValue(sid, 100);
    await voteFor(satori, voter, sid);

    // Carol first delegates to the IDLE delegate.
    await satori.connect(carol).delegatePredictionPower(idle.address);
    // Dave delegates to bob (early, in snapshot).
    await satori.connect(dave).delegatePredictionPower(bob.address);

    await advanceRound();
    await registry.connect(owner).setValue(sid, 110);

    const predRound = Number(await satori.getCurrentRound());
    // Bob predicts (snapshot: own 100 + dave 100). idle does NOT predict.
    await satori.connect(bob).predictMultipleWithPayloads([{ gameId: sid, payload: pack1(UP) }]);

    // Carol SWITCHES idle -> bob. idle has not predicted (no DelegateActive
    // revert at the core), so this flows into rewards' fixed branch with bob
    // already predicted -> must defer.
    await satori.connect(carol).delegatePredictionPower(bob.address);

    await advanceRound();
    await registry.connect(owner).setValue(sid, 120);
    await advanceRound();
    await registry.connect(owner).setValue(sid, 130);

    const splits = await splitsFromTx(
      satori.settlePrediction(bob.address, sid), rewards);
    const split = splits.find(s => s.gameId === Number(sid) && s.round === predRound);
    const reserved = split.delegatorAmount;
    console.log("PROBE2 reserved delegatorsShare:", ethers.formatEther(reserved));

    // Fold back the 1% referral skim (routed to MARKETING_FEE_RECIPIENT, since
    // these delegators have no referral) so the share conservation stays EXACT.
    const mkt = await rewards.marketingFeeRecipient();
    const daveBefore = await satori.balanceOf(dave.address);
    const mktBeforeDave = await rewards.unclaimedRewards(mkt);
    await satori.connect(dave).claim();
    const daveGot = (await satori.balanceOf(dave.address)) - daveBefore;
    const daveSkim = (await rewards.unclaimedRewards(mkt)) - mktBeforeDave;

    const carolBefore = await satori.balanceOf(carol.address);
    const mktBeforeCarol = await rewards.unclaimedRewards(mkt);
    await satori.connect(carol).claim();
    const carolGot = (await satori.balanceOf(carol.address)) - carolBefore;
    const carolSkim = (await rewards.unclaimedRewards(mkt)) - mktBeforeCarol;

    console.log("PROBE2 dave got:", ethers.formatEther(daveGot),
                " carol(switched-late) got:", ethers.formatEther(carolGot));

    expect(carolGot).to.equal(0n);
    expect(carolSkim).to.equal(0n);
    expect(daveGot + daveSkim).to.be.closeTo(reserved, RAW_TOLERANCE);
    expect(daveGot + carolGot + daveSkim + carolSkim).to.be.lte(reserved + RAW_TOLERANCE);
  });

  // -------------------------------------------------------------------------
  // PROBE 3: Delegation BEFORE the delegate predicts (same round). The fix
  //          must NOT have broken the legitimate immediate-activation case:
  //          the delegator MUST earn that round.
  // -------------------------------------------------------------------------
  it("PROBE 3: delegation before predict (same round) STILL earns that round (fix didn't break legit case)", async function () {
    const { satori, voting, registry, rewards, owner, signers } = await setup();
    const bob = signers[1];
    const carol = signers[2];   // delegates BEFORE bob predicts, SAME round
    const voter = signers[3];

    for (const u of [bob, carol, voter]) {
      await satori.transfer(u.address, ethers.parseEther("100"));
    }

    const sid = await streamIdFrom(
      satori.connect(owner)[SIMPLE3]("S", owner.address, 1440), satori);
    await registry.connect(owner).setValue(sid, 100);
    await voteFor(satori, voter, sid);

    await advanceRound();
    await registry.connect(owner).setValue(sid, 110);

    const predRound = Number(await satori.getCurrentRound());
    // Carol delegates THIS round, BEFORE bob predicts (bob has not predicted).
    await satori.connect(carol).delegatePredictionPower(bob.address);
    // Bob predicts AFTER carol delegated -> carol IS in the snapshot.
    await satori.connect(bob).predictMultipleWithPayloads([{ gameId: sid, payload: pack1(UP) }]);

    await advanceRound();
    await registry.connect(owner).setValue(sid, 120);
    await advanceRound();
    await registry.connect(owner).setValue(sid, 130);

    // IMMEDIATE ACTIVATION is read off the period directly: the H1 DEFERRED path
    // sets `startBalance` to 0 and stamps a checkpoint at today+1, the immediate
    // path banks the full power here.
    const [, startRound, , , startBalance] = await rewards.delegationPeriodAt(carol.address, 0);
    expect(startBalance).to.equal(ethers.parseEther("100"));
    expect(Number(startRound)).to.equal(predRound);

    const splits = await splitsFromTx(
      satori.settlePrediction(bob.address, sid), rewards);
    const split = splits.find(s => s.gameId === Number(sid) && s.round === predRound);
    const reserved = split.delegatorAmount;
    console.log("PROBE3 reserved delegatorsShare:", ethers.formatEther(reserved));
    expect(reserved).to.be.gt(0n);

    // Carol is the only delegator and was in the snapshot, so she takes the WHOLE
    // delegator share of her joining round, less the 1% referral skim taken at
    // credit time (to MARKETING_FEE_RECIPIENT) which is folded back in so the
    // conservation stays EXACT.
    const mkt = await rewards.marketingFeeRecipient();
    const carolBefore = await satori.balanceOf(carol.address);
    const mktBeforeCarol = await rewards.unclaimedRewards(mkt);
    await satori.connect(carol).claim();
    const carolGot = (await satori.balanceOf(carol.address)) - carolBefore;
    const carolSkim = (await rewards.unclaimedRewards(mkt)) - mktBeforeCarol;
    console.log("PROBE3 carol(early) got:", ethers.formatEther(carolGot));

    expect(carolGot + carolSkim).to.be.closeTo(reserved, RAW_TOLERANCE);
    expect(carolGot).to.be.gt(0n);
  });

  // -------------------------------------------------------------------------
  // PROBE 4: Multi-game. Delegate predicts game X AND game Y in the SAME round
  //          (one batch — core allows one predict per round). A delegator joins
  //          AFTER the batch. No over-mint and no double-count across games.
  // -------------------------------------------------------------------------
  it("PROBE 4: multi-game same-round predictions + late joiner -> no over-mint / no double-count", async function () {
    const { satori, voting, registry, rewards, owner, signers } = await setup();
    const bob = signers[1];
    const dave = signers[2];    // early delegator (in snapshot for both games)
    const carol = signers[3];   // late delegator
    const voter = signers[4];

    for (const u of [bob, dave, carol, voter]) {
      await satori.transfer(u.address, ethers.parseEther("100"));
    }

    const sX = await streamIdFrom(
      satori.connect(owner)[SIMPLE3]("X", owner.address, 1440), satori);
    const sY = await streamIdFrom(
      satori.connect(owner)[SIMPLE3]("Y", owner.address, 1440), satori);
    await registry.connect(owner).setValue(sX, 100);
    await registry.connect(owner).setValue(sY, 100);
    await voteFor(satori, voter, sX);
    await voteFor(satori, voter, sY);

    // Dave delegates to bob before any predict (in the snapshot for both games).
    await satori.connect(dave).delegatePredictionPower(bob.address);

    await advanceRound();
    await registry.connect(owner).setValue(sX, 110);
    await registry.connect(owner).setValue(sY, 110);

    const predRound = Number(await satori.getCurrentRound());
    // Bob predicts BOTH games in one batch (the only predict allowed this round).
    await satori.connect(bob).predictMultipleWithPayloads([
      { gameId: sX, payload: pack1(UP) },
      { gameId: sY, payload: pack1(UP) },
    ]);

    // Carol joins late — bob already predicted both games this round.
    await satori.connect(carol).delegatePredictionPower(bob.address);

    await advanceRound();
    await registry.connect(owner).setValue(sX, 120);
    await registry.connect(owner).setValue(sY, 120);
    await advanceRound();
    await registry.connect(owner).setValue(sX, 130);
    await registry.connect(owner).setValue(sY, 130);

    const splitsX = await splitsFromTx(satori.settlePrediction(bob.address, sX), rewards);
    const splitsY = await splitsFromTx(satori.settlePrediction(bob.address, sY), rewards);
    const rX = (splitsX.find(s => s.gameId === Number(sX) && s.round === predRound) || {}).delegatorAmount || 0n;
    const rY = (splitsY.find(s => s.gameId === Number(sY) && s.round === predRound) || {}).delegatorAmount || 0n;
    const reserved = rX + rY;
    console.log("PROBE4 reserved (X+Y):", ethers.formatEther(reserved),
                " X:", ethers.formatEther(rX), " Y:", ethers.formatEther(rY));

    // Fold back the 1% referral skim (to MARKETING_FEE_RECIPIENT) so the
    // combined-share conservation stays EXACT.
    const mkt = await rewards.marketingFeeRecipient();
    const daveBefore = await satori.balanceOf(dave.address);
    const mktBeforeDave = await rewards.unclaimedRewards(mkt);
    await satori.connect(dave).claim();
    const daveGot = (await satori.balanceOf(dave.address)) - daveBefore;
    const daveSkim = (await rewards.unclaimedRewards(mkt)) - mktBeforeDave;

    const carolBefore = await satori.balanceOf(carol.address);
    const mktBeforeCarol = await rewards.unclaimedRewards(mkt);
    await satori.connect(carol).claim();
    const carolGot = (await satori.balanceOf(carol.address)) - carolBefore;
    const carolSkim = (await rewards.unclaimedRewards(mkt)) - mktBeforeCarol;

    console.log("PROBE4 dave got:", ethers.formatEther(daveGot),
                " carol(late) got:", ethers.formatEther(carolGot));

    // Carol earns 0 for predRound across BOTH games (and thus no skim).
    expect(carolGot).to.equal(0n);
    expect(carolSkim).to.equal(0n);
    // Dave gets the combined reserved share (net + skim), not 2x (no double count).
    expect(daveGot + daveSkim).to.be.closeTo(reserved, RAW_TOLERANCE);
    expect(daveGot + carolGot + daveSkim + carolSkim).to.be.lte(reserved + RAW_TOLERANCE);
  });

  // -------------------------------------------------------------------------
  // PROBE 5: Interaction with a mid-round balance increase (syncPrediction
  //          delegation pending) to the SAME delegate. In the SAME round, a
  //          deferred LATE delegator (carol) AND a same-round token receipt by
  //          an existing delegator (dave) both target the delegate's today+1
  //          pending bucket. The two must NOT corrupt each other / double-count.
  //
  //          NOTE on harness mechanics: a predictor's weight is multiplied by a
  //          STREAK multiplier that is 0 at streak 0 (unless it's their first-
  //          ever prediction), only dust (mult = streak, so streak-1 → 1: a
  //          tiny non-zero weight) below the per-game threshold, and the real
  //          √streak×1000 band once streak reaches the threshold (>=4). A
  //          predictor's SECOND-ever prediction (made before the first settles)
  //          therefore still sits at streak 0 and carries ~no weight —
  //          documented, unrelated to H1. So this probe runs a CONTINUOUS
  //          multi-round prediction by bob (streak builds), and injects the
  //          late-delegation + same-round receipt mid-run, then checks exact
  //          conservation: Σ delegator payouts == Σ reserved delegatorsShare.
  // -------------------------------------------------------------------------
  it("PROBE 5: late delegation + same-round receipt both fold into today+1 pending -> exact conservation, no over/under-mint", async function () {
    const { satori, registry, rewards, owner, signers } = await setup();
    const bob = signers[1];
    const dave = signers[2];    // early delegator; ALSO receives tokens mid-run
    const carol = signers[3];   // LATE delegator (deferred to today+1)
    const voter = signers[4];
    const funder = signers[5];

    for (const u of [bob, dave, carol, voter, funder]) {
      await satori.transfer(u.address, ethers.parseEther("100"));
    }

    const sid = await streamIdFrom(
      satori.connect(owner)[SIMPLE3]("S", owner.address, 1440), satori);
    await registry.connect(owner).setValue(sid, 100);
    await voteFor(satori, voter, sid);
    await satori.connect(dave).delegatePredictionPower(bob.address);

    const reservedByRound = {};
    let injectionRound = null;
    let v = 100;
    // Continuous run: bob predicts every round; streak builds so later rounds
    // carry real weight. In iteration index 3, AFTER bob predicts, carol joins
    // late AND dave receives 50 more tokens -> both schedule today+1 pending.
    for (let k = 0; k < 7; k++) {
      await advanceRound();
      v += 10;
      await registry.connect(owner).setValue(sid, v);
      const rcpt = await (await satori.connect(bob)
        .predictMultipleWithPayloads([{ gameId: sid, payload: pack1(UP) }])).wait();
      foldSplits(rcpt, rewards, reservedByRound);
      if (k === 3) {
        injectionRound = Number(await satori.getCurrentRound());
        await satori.connect(carol).delegatePredictionPower(bob.address);     // defer -> today+1
        await satori.connect(funder).transfer(dave.address, ethers.parseEther("50")); // receipt -> today+1
      }
    }
    // Drain remaining unsettled predictions over a few more rounds.
    for (let k = 0; k < 5; k++) {
      await advanceRound();
      v += 10;
      await registry.connect(owner).setValue(sid, v);
      const rcpt = await (await satori.settlePrediction(bob.address, sid)).wait();
      foldSplits(rcpt, rewards, reservedByRound);
    }

    const reservedTotal = Object.values(reservedByRound).reduce((a, b) => a + b, 0n);
    // Carol's deferred round must reserve a share she does NOT earn -> her
    // contribution to injectionRound is 0.
    console.log("PROBE5 injectionRound:", injectionRound,
                " reservedTotal:", ethers.formatEther(reservedTotal));

    // Capture the 1% referral skim (routed to MARKETING_FEE_RECIPIENT for
    // these unreferred delegators) taken at credit time on each claim so the
    // conservation sum stays EXACT: net payouts + skims == reservedTotal.
    const mkt = await rewards.marketingFeeRecipient();
    const mktStart = await rewards.unclaimedRewards(mkt);
    const daveBefore = await satori.balanceOf(dave.address);
    await satori.connect(dave).claim();
    const daveGot = (await satori.balanceOf(dave.address)) - daveBefore;

    const carolBefore = await satori.balanceOf(carol.address);
    await satori.connect(carol).claim();
    const carolGot = (await satori.balanceOf(carol.address)) - carolBefore;
    const skim = (await rewards.unclaimedRewards(mkt)) - mktStart;

    console.log("PROBE5 dave got:", ethers.formatEther(daveGot),
                " carol got:", ethers.formatEther(carolGot),
                " skim:", ethers.formatEther(skim),
                " sum:", ethers.formatEther(daveGot + carolGot + skim));

    // EXACT CONSERVATION: every reserved delegatorsShare is paid out to a real
    // delegator (net) plus the 1% skim now in the marketing bucket, and never
    // more than was reserved. No over-mint, no orphan.
    expect(daveGot + carolGot + skim).to.be.lte(reservedTotal + RAW_TOLERANCE);
    expect(daveGot + carolGot + skim).to.be.closeTo(reservedTotal, RAW_TOLERANCE * 8n);
    // Carol genuinely earns from the activation round onward (today+1 pending
    // activated correctly; not stuck at 0, not corrupted by dave's receipt).
    expect(carolGot).to.be.gt(0n);
    // After her receipt dave holds 150 vs carol's 100 in the shared rounds, so
    // carol's slice of each shared round is 100/250 = 40%. Her total is
    // therefore strictly below dave's. (If H1 leaked, carol would have also
    // grabbed the deferred injection round's full pool, pushing her above this.)
    expect(carolGot).to.be.lt(daveGot);
  });

  // -------------------------------------------------------------------------
  // PROBE 6: Conservation across rounds. A deferred delegator earns EXACTLY 0
  //          for the deferred round and earns her correct half-share from the
  //          activation round onward. Verified by reconstructing the expected
  //          per-round split from the captured reserved shares.
  // -------------------------------------------------------------------------
  it("PROBE 6: deferred delegator earns 0 for deferred round, correct share from activation round (exact)", async function () {
    const { satori, registry, rewards, owner, signers } = await setup();
    const bob = signers[1];
    const dave = signers[2];    // early delegator (always active)
    const carol = signers[3];   // late delegator (deferred), active from join+1
    const voter = signers[4];

    for (const u of [bob, dave, carol, voter]) {
      await satori.transfer(u.address, ethers.parseEther("100"));
    }

    const sid = await streamIdFrom(
      satori.connect(owner)[SIMPLE3]("S", owner.address, 1440), satori);
    await registry.connect(owner).setValue(sid, 100);
    await voteFor(satori, voter, sid);
    await satori.connect(dave).delegatePredictionPower(bob.address);

    const reservedByRound = {};
    let joinRound = null;
    let v = 100;
    for (let k = 0; k < 7; k++) {
      await advanceRound();
      v += 10;
      await registry.connect(owner).setValue(sid, v);
      const rcpt = await (await satori.connect(bob)
        .predictMultipleWithPayloads([{ gameId: sid, payload: pack1(UP) }])).wait();
      foldSplits(rcpt, rewards, reservedByRound);
      if (k === 3) {
        joinRound = Number(await satori.getCurrentRound());
        // Carol joins AFTER bob predicted this round -> deferred to joinRound+1.
        await satori.connect(carol).delegatePredictionPower(bob.address);
      }
    }
    for (let k = 0; k < 5; k++) {
      await advanceRound();
      v += 10;
      await registry.connect(owner).setValue(sid, v);
      const rcpt = await (await satori.settlePrediction(bob.address, sid)).wait();
      foldSplits(rcpt, rewards, reservedByRound);
    }

    // Reconstruct the exact split. Dave holds 100 of the delegated power in every
    // round; carol's 100 is live from joinRound + 1 (the H1 deferral), so after the
    // join each reserved share divides 100/200 : 100/200 and before it dave takes
    // all of it.
    let reservedTotal = 0n;
    let expectedDave = 0n;
    let expectedCarol = 0n;
    for (const [round, share] of Object.entries(reservedByRound)) {
      reservedTotal += share;
      if (Number(round) <= joinRound) {
        expectedDave += share;
      } else {
        expectedDave += share / 2n;
        expectedCarol += share / 2n;
      }
    }
    console.log("PROBE6 joinRound:", joinRound,
                " reservedTotal:", ethers.formatEther(reservedTotal));

    // The reconstructed expectations above are GROSS reserved shares. The 1%
    // referral cut is skimmed at credit time (to MARKETING_FEE_RECIPIENT, as
    // these delegators are unreferred), so the minted amount is net. Capture
    // each delegator's skim from the marketing bucket delta across their claim
    // and gross the payouts back up so every equality stays EXACT.
    const mkt = await rewards.marketingFeeRecipient();
    const daveBefore = await satori.balanceOf(dave.address);
    const mktBeforeDave = await rewards.unclaimedRewards(mkt);
    await satori.connect(dave).claim();
    const daveGot = (await satori.balanceOf(dave.address)) - daveBefore;
    const daveSkim = (await rewards.unclaimedRewards(mkt)) - mktBeforeDave;

    const carolBefore = await satori.balanceOf(carol.address);
    const mktBeforeCarol = await rewards.unclaimedRewards(mkt);
    await satori.connect(carol).claim();
    const carolGot = (await satori.balanceOf(carol.address)) - carolBefore;
    const carolSkim = (await rewards.unclaimedRewards(mkt)) - mktBeforeCarol;

    console.log("PROBE6 dave got:", ethers.formatEther(daveGot),
                " carol got:", ethers.formatEther(carolGot));

    // 1. The DEFERRAL held: carol earns nothing for joinRound, only her half of
    //    every later round, and dave takes the rest.
    const roundsAfterJoin = Object.keys(reservedByRound)
      .map(Number).filter(r => r > joinRound).length;
    expect(roundsAfterJoin, "run must extend past the join to be meaningful").to.be.gt(0);
    expect(carolGot + carolSkim).to.be.closeTo(expectedCarol, RAW_TOLERANCE * 8n);
    expect(daveGot + daveSkim).to.be.closeTo(expectedDave, RAW_TOLERANCE * 8n);

    // 2. EXACT CONSERVATION across the whole run, which is the invariant the
    //    over-mint would actually break: nothing minted (net + skim) beyond
    //    what was reserved, and nothing orphaned.
    expect(daveGot + carolGot + daveSkim + carolSkim).to.be.lte(reservedTotal + RAW_TOLERANCE);
    expect(daveGot + carolGot + daveSkim + carolSkim).to.be.closeTo(reservedTotal, RAW_TOLERANCE * 8n);
  });
});
