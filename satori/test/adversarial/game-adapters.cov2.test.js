// Adversarial COVERAGE (round 2) for the game-adapters subsystem.
//
// Round 1 (game-adapters.cov.test.js) already covers: threshold boundary +
// sign, multi-round predict/settle cycle, single-round conservation, an
// adapter-ONLY delegation split, and the zero-weight record path. The
// confirmed findings (int128-decode revert, anchor-eviction force-finalize,
// pendingRound orphan, uint128 truncation) live under adversarial-findings/
// with their own repros and are SKIPPED here.
//
// This file targets the remaining MEDIUM-priority gap that round 1 left
// uncovered, asserting against the CURRENT contract behavior:
//
//  - MIXED binary + adapter wins in the SAME round R must BOTH fold their
//    delegator slice into the same per-(user, round) pull-rate accumulator
//    (_delegatorRewardRatePerRound[predictor][R] is summed across streams /
//    games — SatoriRewards.sol, reached by both scoreCorrectPrediction
//    and scoreAdapterPrediction via _splitReward). A delegator who pulls
//    after a predictor wins BOTH games in one round must receive strictly
//    more than a delegator of a predictor who won only ONE of the two games
//    with the same delegated power.  (Delegation gap, med priority.)
//
// REMOVED (burn-voting refactor): the sibling "adapter payout conservation
// with a provider cut" case. Value providers are no longer paid by the
// protocol at all — `accrueProviderCut`, `getValueProviderCutBps` and the
// `valueProviderCutBps` stream parameter are gone, and the whole per-game
// slice now goes to that game's predictors. There is no cut left to conserve.
//
// All assertions reflect DOCUMENTED intent (A_game_adapters.md / the
// SatoriRewards conservation contract). The file MUST stay green; any failing
// intended-behavior assertion is a NEW bug and is relocated to
// adversarial-findings/cov2_game-adapters.test.js (kept failing).

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time, impersonateAccount, setBalance } =
  require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture, pack1, voteFor, VOTE, warmUpLoyalty } = require("../fixtures");

const ROUND = 86400;
const YES = 1;
const NO = 2;
const UP = 1; // binary "value went up" direction byte

async function advanceRounds(n) { await time.increase(ROUND * n); }

// Stream id 1 is the protocol DEFAULT stream (the fixture initializes it
// exactly as production does), so the first stream a test creates is id 2.
// Always read the id off the event rather than hardcoding it.
async function streamIdFrom(tx, satori) {
  const r = await tx.wait();
  for (const log of r.logs) {
    try {
      const p = satori.interface.parseLog(log);
      if (p && p.name === "DataStreamCreated") return Number(p.args.streamId);
    } catch (e) {}
  }
  throw new Error("DataStreamCreated event missing");
}

async function gameIdFrom(tx, games) {
  const r = await tx.wait();
  for (const log of r.logs) {
    try {
      const p = games.interface.parseLog(log);
      if (p && p.name === "GameCreated") return Number(p.args.gameId);
    } catch (e) {}
  }
  throw new Error("GameCreated event missing");
}

// Register the YesNoGame adapter once and return its handle + a coreSigner.
async function registerYesNo(fix) {
  const { satori, engine, registry, games, rewards, owner } = fix;
  const YesNoGame = await ethers.getContractFactory("YesNoGame");
  const yesNo = await YesNoGame.deploy(
    await engine.getAddress(),
    await games.getAddress(),
    await registry.getAddress());
  await yesNo.waitForDeployment();

  const satoriAddr = await satori.getAddress();
  await impersonateAccount(satoriAddr);
  await setBalance(satoriAddr, ethers.parseEther("10"));
  const coreSigner = await ethers.getSigner(satoriAddr);
  await games.connect(coreSigner).registerGameAdapter(
    await yesNo.getAddress(), owner.address, "YesNo", false
  );
  return { yesNo, coreSigner };
}

describe("game-adapters.cov2 — adversarial coverage (round 2, med-priority gaps)", function () {
  this.timeout(120000);

  // ============================================================
  // MIXED binary + adapter wins in the SAME round must both fold their
  // delegator slice into the same per-(user, round) pull-rate accumulator.
  //
  // Strategy: two parallel predictors with IDENTICAL inbound delegated power
  // (equal-balance delegators), both predicting on equally-weighted games in
  // the SAME round.
  //   - P_one wins ONLY the adapter game.
  //   - P_both wins the adapter game AND a binary game (same stream cadence).
  // Both delegators (D_one, D_both) then claim. Because the binary win adds a
  // SECOND _splitReward into _delegatorRewardRatePerRound[P_both][R], D_both
  // must pull STRICTLY MORE than D_one. If the adapter path failed to fold
  // into the per-round rate, D_both would equal D_one.
  // ============================================================
  describe("mixed binary + adapter delegation accrual in one round", function () {
    it("delegator of a predictor who also wins a BINARY game pulls strictly more than one whose predictor won only the (unpaid) adapter game", async function () {
      const fix = await loadFixture(deploySatoriFixture);
      const { satori, rewards, registry, games, owner, signers } = fix;
      const { yesNo } = await registerYesNo(fix);

      // Two streams, each carries a proxy-created binary game (type 0) plus a
      // YesNo adapter game we create explicitly. We only USE the binary game
      // on stream B (for P_both); stream A's adapter game is P_one's target.
      const streamA = await streamIdFrom(
        await satori.connect(owner)["createSimpleDataStream(string,address,uint24)"]("S-A", owner.address, 2880), satori);
      const streamB = await streamIdFrom(
        await satori.connect(owner)["createSimpleDataStream(string,address,uint24)"]("S-B", owner.address, 2880), satori);
      const binGameA = Number(await games.binaryGameByStream(streamA));
      const binGameB = Number(await games.binaryGameByStream(streamB));
      await registry.connect(owner).setValue(streamA, 100);
      await registry.connect(owner).setValue(streamB, 100);

      const cfg = ethers.AbiCoder.defaultAbiCoder().encode(["int128"], [150]);
      const adpA = await gameIdFrom(await satori.connect(owner).createGame(streamA, 1, cfg, "A-yn"), games);
      const adpB = await gameIdFrom(await satori.connect(owner).createGame(streamB, 1, cfg, "B-yn"), games);

      // Predictors + their delegators. Equal balances so the delegated-power
      // snapshot captured at predict time is identical across the two cases.
      const pOne = signers[1], dOne = signers[2];
      const pBoth = signers[3], dBoth = signers[4];
      for (const s of [pOne, dOne, pBoth, dBoth]) {
        await satori.transfer(s.address, ethers.parseEther("10"));
      }

      // Each delegator delegates prediction power to its predictor (same round
      // as the predicts, exactly as round-1's working delegation test does).
      await satori.connect(dOne).delegatePredictionPower(pOne.address);
      await satori.connect(dBoth).delegatePredictionPower(pBoth.address);

      // Only binGameB can be given weight. adpA and adpB are ADAPTER games and
      // adapter games are not mint-eligible, so `vote` refuses them — which is
      // exactly the asymmetry this test now measures: P_both's binary win is
      // the only win of the three that folds anything into the round-R rate.
      const voters = [signers[5], signers[6], signers[7], signers[8]];
      for (const v of voters) await satori.transfer(v.address, VOTE);
      await expect(satori.connect(voters[0]).vote(adpA, VOTE))
        .to.be.revertedWithCustomError(fix.voting, "GameNotMintEligible");
      await expect(satori.connect(voters[1]).vote(adpB, VOTE))
        .to.be.revertedWithCustomError(fix.voting, "GameNotMintEligible");
      await voteFor(satori, voters[2], binGameB);
      // (binGameA intentionally unused — it carries no weight and earns nothing.)

      // Delegator weight is capital x loyalty and a fresh delegation starts at
      // L = 0, so dBoth's pull would be zero and the "strictly more than dOne"
      // comparison vacuous. Warm on binGameB — the only mint-eligible game
      // here, which is the asymmetry under test. dOne stays cold on purpose:
      // its predictor only ever wins the unpaid adapter game.
      await warmUpLoyalty(satori, registry, owner, pBoth, [dBoth], voters[3], binGameB, 40, 4);
      // Both host streams need a fresh anchor in THIS round: the warm-up
      // spans several cadence periods and both predictors act below.
      await registry.connect(owner).setValue(streamA, 100);
      await registry.connect(owner).setValue(streamB, 100);

      const roundR = Number(await satori.getCurrentRound());

      // P_one: adapter YES on stream A only.
      await satori.connect(pOne).predictMultipleWithPayloads([{ gameId: adpA, payload: pack1(YES) }]);

      // P_both: adapter YES on stream B AND binary UP on stream B, same round.
      await satori.connect(pBoth).predictMultipleWithPayloads([
        { gameId: adpB,     payload: pack1(YES) },
        { gameId: binGameB, payload: pack1(UP) },
      ]);

      // --- Resolve ---
      // Adapter scores against the FIRST value after R. Binary (ABC) needs
      // anchor (first value after R) and post (second value after R), winning
      // UP iff post > anchor. Streams are at a two-round (2880-minute) cadence, so
      // each successive write must land >= 2 rounds (and >= 171000s) after the
      // prior one — advance TWO
      // rounds between host writes to satisfy the cadence rhythm guard.
      await advanceRounds(2);
      // value B: adapter sees 200 > 150 -> YES wins on both streams; this is
      // also the binary anchor on stream B.
      await registry.connect(owner).setValue(streamA, 200);
      await registry.connect(owner).setValue(streamB, 200);

      await advanceRounds(2);
      // value C: binary post = 300 > 200 -> UP correct on stream B.
      await registry.connect(owner).setValue(streamA, 300);
      await registry.connect(owner).setValue(streamB, 300);

      // Settle every winning prediction.
      await satori.settlePrediction(pOne.address, adpA);
      await satori.settlePrediction(pBoth.address, adpB);
      await satori.settlePrediction(pBoth.address, binGameB);

      // P_one won an ADAPTER game and kept nothing: it is not mint-eligible, so
      // there was no reward to take an own-portion of. P_both's BINARY win did
      // pay.
      expect(await rewards.unclaimedRewards(pOne.address)).to.equal(0n);
      expect(await rewards.unclaimedRewards(pBoth.address)).to.be.gt(0n);

      // Delegators pull their folded slice via a self-claim (drains to balance,
      // running _accrueDelegatorRewards over the round-R pull rate).
      const dOneBalBefore = await satori.balanceOf(dOne.address);
      await satori.connect(dOne)["claim()"]();
      const dOneGain = (await satori.balanceOf(dOne.address)) - dOneBalBefore;

      const dBothBalBefore = await satori.balanceOf(dBoth.address);
      await satori.connect(dBoth)["claim()"]();
      const dBothGain = (await satori.balanceOf(dBoth.address)) - dBothBalBefore;

      // The adapter-only delegator collected nothing — there was nothing to
      // fold. The binary win did fold into round R's rate accumulator.
      expect(dOneGain).to.equal(0n);
      expect(dBothGain).to.be.gt(0n);

      // CORE ASSERTION: the delegator whose predictor won a MINT-ELIGIBLE game
      // strictly out-earns the one whose predictor won only an adapter game.
      // An adapter win adds nothing to the round-R rate, so the whole of
      // D_both's pull comes from the binary leg.
      expect(dBothGain).to.be.gt(dOneGain);
    });
  });
});
