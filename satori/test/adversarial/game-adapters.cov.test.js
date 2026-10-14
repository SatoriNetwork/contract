// Adversarial COVERAGE for the game-adapters subsystem.
//
// Targets the high/med-priority coverage gaps from _raw_review.json that are
// NOT already covered by confirmed-finding repros (int128 decode revert,
// anchor-eviction force-finalize, pendingRound orphan, uint128 truncation are
// SKIPPED here — they live under adversarial-findings/).
//
// Gaps covered (re-expressed for the SCORE/TOTAL model — the protocol stores
// no per-bet bucket/weight; the adapter owns scoring and answers
// (userScore, multiplier, total) at score time; the protocol pins the first
// scorer's `total` per (game,round) and caps the running paid numerators at it):
//  - Multi-round predict/settle cycle on the SAME adapter game (clean rollover);
//    the adapter's per-user pending state is consumed on score and a re-predict
//    opens a fresh, independent record.
//  - Threshold boundary: value == threshold => NO wins; just-above => YES;
//    negative threshold + negative values (sign correctness).
//  - Solo-winner conservation: userScore×multiplier == total => the lone winner's
//    numerator IS the round's whole denominator, so at most one pool can ever be
//    allocated and nothing strands; a second settle finalizes nothing further.
//  - Conservation: a two-winner split's numerators sum to exactly the same
//    denominator as a solo winner's, losers commit to the losing side, and the
//    no-winner case resolves with an empty winning side.
//  - Delegation interacting with adapter scoring (predictor with a delegator wins
//    an adapter game AND a mint-eligible binary game in the same round; the
//    adapter leg folds NOTHING into the delegator pull-rate accumulator while the
//    binary leg splits by predictorFeeBps).
//
// MINT ELIGIBILITY (the reason every SATORI assertion below reads zero): only
// the built-in binary game (gameTypeId 0) earns from the mint. `vote` on an
// adapter game reverts GameNotMintEligible, so an adapter game can never carry
// voting weight, its `streamPool` is ZERO, and a winning bet on it resolves to a
// payout of zero. The scoring machinery is unchanged and fully exercised — what
// inverted is the realized SATORI, which is now always 0. Every such zero below
// is therefore PAIRED with proof the settle genuinely ran (the adapter's
// pendingRound consumed and/or its `roundOutcome` written), so a zero can never
// be confused with a stalled no-op. The conservation properties themselves are
// asserted where they still live and are still exact: on the adapter's own
// numerator/denominator books.
//
// DROPPED (obsolete under the score/total model): the bucket-0 probe
// (Bucket0Game.sol deleted; buckets are meaningless) and the protocol-side
// zero-weight / adapterUserRecord / adapterBucketWeight reads (those getters
// and the per-bet weight state were removed entirely).
//
// All assertions reflect the DOCUMENTED intent (A_game_adapters.md). The file
// must stay 100% green; any failing intended-behavior assertion is a NEW bug
// and is relocated to adversarial-findings/cov_game-adapters.test.js.

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

// Genesis initializes the DEFAULT stream at id 1 plus its derived family at
// ids 2..4 exactly as production does, so the first stream a test creates is
// id 5. Never hardcode it — read it off the event.
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

// Deploy the standard fixture, register a YesNoGame adapter, and create one
// YesNo game on a fresh stream with the supplied threshold (default 150).
// The host stream is 2880 minutes (two rounds) — the finest an adapter game's
// host may be — so every
// host write must sit >= 2 rounds after the previous one.
async function deployWithYesNo(threshold = 150) {
  const fix = await loadFixture(deploySatoriFixture);
  const { satori, registry, games, owner } = fix;

  const YesNoGame = await ethers.getContractFactory("YesNoGame");
  const yesNo = await YesNoGame.deploy(
    await fix.engine.getAddress(),
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

  // Fresh stream (the core also auto-creates its binary type-0 game).
  const streamId = await streamIdFrom(
    await satori.connect(owner)["createSimpleDataStream(string,address,uint24)"](
      "BTC-Test", owner.address, 2880),
    satori);
  const binaryGameId = Number(await games.binaryGameByStream(streamId));
  // A predict requires the host stream to have been written in the CURRENT
  // round (PredictExpired), so seed the value here.
  await registry.connect(owner).setValue(streamId, 100);

  const cfg = ethers.AbiCoder.defaultAbiCoder().encode(["int128"], [threshold]);
  const tx = await satori.connect(owner).createGame(streamId, 1, cfg, "BTC-yesno");
  const yesNoGameId = await gameIdFrom(tx, games);

  return { ...fix, yesNo, streamId, binaryGameId, yesNoGameId, threshold };
}

describe("game-adapters.cov — adversarial coverage for the adapter score/record path", function () {

  // ============================================================
  // Threshold boundary + sign correctness (med-priority gap).
  // Intent: YES wins iff value > threshold (strict). value == threshold
  // => NO wins. int256 comparison must be sign-correct for negatives.
  //
  // The winning direction used to be read out of the payouts (winner > 0,
  // loser == 0). An adapter game draws no pool, so both payouts are now 0 and
  // could no longer tell the two sides apart. The boundary is therefore read
  // where the adapter actually decides it: `roundOutcome(gameId, round)`, which
  // score() writes with the resolved direction. That is a STRICTER probe than
  // the payout ever was (it names the winner outright instead of inferring it),
  // and it doubles as proof the settle ran.
  // ============================================================
  describe("threshold boundary and sign", function () {
    // Runs one boundary case end-to-end and asserts the resolved direction.
    // `resolveValue` is the first host value after the prediction round;
    // `expectedWinner` is the direction the adapter must pick.
    async function boundaryCase(threshold, resolveValue, expectedWinner) {
      const { satori, rewards, registry, yesNo, yesNoGameId, streamId, signers, owner } =
        await deployWithYesNo(threshold);
      const yesBettor = signers[1], noBettor = signers[2];
      await satori.transfer(yesBettor.address, ethers.parseEther("10"));
      await satori.transfer(noBettor.address, ethers.parseEther("10"));
      // No burn: `vote` on an adapter game reverts GameNotMintEligible, so the
      // game holds no weight and draws no pool. The adapter's own scoring —
      // what this case is about — is unaffected.
      const round = Number(await satori.getCurrentRound());

      await satori.connect(yesBettor).predictMultipleWithPayloads(
        [{ gameId: yesNoGameId, payload: pack1(YES) }]);
      await satori.connect(noBettor).predictMultipleWithPayloads(
        [{ gameId: yesNoGameId, payload: pack1(NO) }]);

      // Both sides really committed weight, so neither is "winning" by default.
      expect(await yesNo.dirWeight(yesNoGameId, round, YES)).to.be.gt(0n);
      expect(await yesNo.dirWeight(yesNoGameId, round, NO)).to.be.gt(0n);

      // Cadence-2 host stream: the next write must land >= 2 rounds later.
      await advanceRounds(2);
      await registry.connect(owner).setValue(streamId, resolveValue);

      const yBefore = await rewards.unclaimedRewards(yesBettor.address);
      const nBefore = await rewards.unclaimedRewards(noBettor.address);
      await satori.settlePrediction(yesBettor.address, yesNoGameId);
      await satori.settlePrediction(noBettor.address, yesNoGameId);
      const yGain = (await rewards.unclaimedRewards(yesBettor.address)) - yBefore;
      const nGain = (await rewards.unclaimedRewards(noBettor.address)) - nBefore;

      // THE BOUNDARY: score() resolved the round to exactly one direction and
      // cached it. This is the assertion the test is named for.
      expect(await yesNo.roundOutcome(yesNoGameId, round)).to.equal(expectedWinner);

      // ...and it really was a settle: both bets were consumed, not left open.
      for (const p of [yesBettor, noBettor]) {
        expect(await yesNo.pendingRound(yesNoGameId, p.address)).to.equal(0n);
        expect(await yesNo.pendingWeight(yesNoGameId, p.address)).to.equal(0n);
      }

      // INVERTED (mint eligibility): the winner used to take a pool. An adapter
      // game is not mint-eligible, so winner and loser are paid alike — nothing.
      expect(yGain).to.equal(0n);
      expect(nGain).to.equal(0n);
    }

    it("value == threshold => NO wins (strict '>' boundary), and neither side is paid", async function () {
      // Resolving value exactly equals threshold → NOT > threshold → NO wins.
      await boundaryCase(150, 150, NO);
    });

    it("value just above threshold => YES wins", async function () {
      await boundaryCase(150, 151, YES); // strictly above
    });

    it("negative threshold with negative resolving value: sign-correct comparison", async function () {
      // threshold = -100. A value of -50 is > -100 → YES wins.
      await boundaryCase(-100, -50, YES);
    });

    it("negative threshold with a more-negative value: NO wins", async function () {
      // threshold = -100. A value of -200 is NOT > -100 → NO wins.
      await boundaryCase(-100, -200, NO);
    });
  });

  // ============================================================
  // Multi-round predict/settle cycle on the SAME adapter game.
  // Intent: a clean predict R → resolve → settle → predict R+1 cycle
  // should work repeatedly. Each round's record is independent; the
  // pendingRound pointer is cleared on score-success and reused cleanly.
  // ============================================================
  describe("multi-round predict/settle cycle on the same adapter game", function () {
    it("predict, settle (clean), then predict again in a later round and settle again", async function () {
      this.timeout(120000);
      const { satori, rewards, registry, yesNo, yesNoGameId, streamId, signers, owner } =
        await deployWithYesNo(150);
      const alice = signers[1];
      await satori.transfer(alice.address, ethers.parseEther("20"));
      const roundR = Number(await satori.getCurrentRound());

      // --- Round R: predict YES ---
      // The adapter is handed the predictor's UNDIVIDED prediction power, not
      // the apportioned SATORI weight (which is 0 here) — so its books carry a
      // real number even though the game earns nothing.
      const powerR = await rewards.getPredictionPower(alice.address);
      expect(powerR).to.be.gt(0n);
      await satori.connect(alice).predictMultipleWithPayloads(
        [{ gameId: yesNoGameId, payload: pack1(YES) }]);
      expect(await yesNo.pendingRound(yesNoGameId, alice.address)).to.equal(roundR);
      expect(await yesNo.pendingWeight(yesNoGameId, alice.address)).to.equal(powerR);

      // --- Round R+2: resolving value > threshold → YES wins; settle cleanly ---
      await advanceRounds(2);
      await registry.connect(owner).setValue(streamId, 200);
      const ucBefore1 = await rewards.unclaimedRewards(alice.address);
      await satori.settlePrediction(alice.address, yesNoGameId);
      const ucAfter1 = await rewards.unclaimedRewards(alice.address);

      // Round R resolved YES and alice called it — the settle genuinely ran.
      expect(await yesNo.roundOutcome(yesNoGameId, roundR)).to.equal(YES);
      // INVERTED (mint eligibility): winning round R credited nothing, because
      // an adapter game holds no voting weight and so draws no pool.
      expect(ucAfter1).to.equal(ucBefore1);

      // Score-success cleared the adapter's per-user pending state (the
      // protocol no longer stores a per-(user,gameId,R) record under the
      // score/total model — the adapter owns its own state and deletes it on
      // score). pendingRound back to 0, direction/weight wiped.
      expect(await yesNo.pendingRound(yesNoGameId, alice.address)).to.equal(0n);
      expect(await yesNo.pendingDir(yesNoGameId, alice.address)).to.equal(0n);
      expect(await yesNo.pendingWeight(yesNoGameId, alice.address)).to.equal(0n);

      // --- Round R+2: predict again (a fresh, independent record) ---
      const roundR1 = Number(await satori.getCurrentRound());
      expect(roundR1).to.be.gt(roundR);
      const powerR1 = await rewards.getPredictionPower(alice.address);
      await satori.connect(alice).predictMultipleWithPayloads(
        [{ gameId: yesNoGameId, payload: pack1(YES) }]);
      // Fresh, independent record on the adapter: new round, YES direction,
      // the predictor's full undivided power (and a fresh per-direction total).
      expect(await yesNo.pendingRound(yesNoGameId, alice.address)).to.equal(roundR1);
      expect(await yesNo.pendingDir(yesNoGameId, alice.address)).to.equal(YES);
      expect(await yesNo.pendingWeight(yesNoGameId, alice.address)).to.equal(powerR1);
      expect(powerR1).to.be.gt(0n);
      expect(await yesNo.dirWeight(yesNoGameId, roundR1, YES)).to.equal(powerR1);

      // --- Round R+4: resolve YES again, settle cleanly ---
      await advanceRounds(2);
      await registry.connect(owner).setValue(streamId, 300);
      const ucBefore2 = await rewards.unclaimedRewards(alice.address);
      await satori.settlePrediction(alice.address, yesNoGameId);
      const ucAfter2 = await rewards.unclaimedRewards(alice.address);
      // Second cycle resolved and finalized just like the first — and paid the
      // same nothing.
      expect(await yesNo.roundOutcome(yesNoGameId, roundR1)).to.equal(YES);
      expect(ucAfter2).to.equal(ucBefore2);
      expect(await yesNo.pendingRound(yesNoGameId, alice.address)).to.equal(0n);
    });

    it("a second settle on an already-settled adapter prediction is a no-op (no double finalize)", async function () {
      const { satori, rewards, registry, yesNo, yesNoGameId, streamId, signers, owner } =
        await deployWithYesNo(150);
      const alice = signers[1];
      await satori.transfer(alice.address, ethers.parseEther("10"));
      const round = Number(await satori.getCurrentRound());
      await satori.connect(alice).predictMultipleWithPayloads(
        [{ gameId: yesNoGameId, payload: pack1(YES) }]);
      expect(await yesNo.pendingRound(yesNoGameId, alice.address)).to.equal(round);

      await advanceRounds(2);
      await registry.connect(owner).setValue(streamId, 200);
      await satori.settlePrediction(alice.address, yesNoGameId);
      const afterFirst = await rewards.unclaimedRewards(alice.address);

      // The first settle really consumed the bet — that is what makes the
      // second one a no-op, and it is the fact under test. (The credit itself
      // is zero: an adapter game draws no pool.)
      expect(await yesNo.roundOutcome(yesNoGameId, round)).to.equal(YES);
      expect(await yesNo.pendingRound(yesNoGameId, alice.address)).to.equal(0n);
      expect(afterFirst).to.equal(0n);

      // Settle again — record is consumed; must not revert and must not credit.
      await expect(satori.settlePrediction(alice.address, yesNoGameId)).to.not.be.reverted;
      expect(await rewards.unclaimedRewards(alice.address)).to.equal(afterFirst);
      expect(await yesNo.pendingRound(yesNoGameId, alice.address)).to.equal(0n);
    });
  });

  // ============================================================
  // Conservation, stated where it still lives: the adapter's numerator /
  // denominator books.
  //
  // The protocol pays `pool × (userScore × multiplier) / total` and caps the
  // running sum of paid numerators at the pinned `total`. So "the winners split
  // exactly one pool, no more" is the statement Σ(numerators) == total. With an
  // adapter game the realized pool is ZERO, so that identity can no longer be
  // observed through payouts — but it is observable EXACTLY (not within dust)
  // on the adapter's own books, which is where the split is decided.
  // ============================================================
  describe("payout conservation vs streamPool", function () {
    it("a two-winner split's numerators sum to the same denominator as a solo winner's, and both pay zero", async function () {
      this.timeout(120000);
      // Strategy: a single YES winner with ALL the direction weight has
      // numerator == denominator (takes the entire pool). Two YES winners
      // splitting that same direction weight must, summed, reach the same
      // denominator — i.e. one pool between them, never two. We run two
      // identical games in the same fixture/round so the inputs are identical.
      const fix = await loadFixture(deploySatoriFixture);
      const { satori, rewards, registry, games, owner, signers } = fix;

      const YesNoGame = await ethers.getContractFactory("YesNoGame");
      const yesNo = await YesNoGame.deploy(
        await fix.engine.getAddress(), await games.getAddress(),
        await registry.getAddress());
      await yesNo.waitForDeployment();
      const satoriAddr = await satori.getAddress();
      await impersonateAccount(satoriAddr);
      await setBalance(satoriAddr, ethers.parseEther("10"));
      const coreSigner = await ethers.getSigner(satoriAddr);
      await games.connect(coreSigner).registerGameAdapter(
        await yesNo.getAddress(), owner.address, "YesNo", false);

      // Two streams + two YesNo games with identical config.
      const streamA = await streamIdFrom(
        await satori.connect(owner)["createSimpleDataStream(string,address,uint24)"]("S-A", owner.address, 2880), satori);
      const streamB = await streamIdFrom(
        await satori.connect(owner)["createSimpleDataStream(string,address,uint24)"]("S-B", owner.address, 2880), satori);
      await registry.connect(owner).setValue(streamA, 100);
      await registry.connect(owner).setValue(streamB, 100);
      const cfg = ethers.AbiCoder.defaultAbiCoder().encode(["int128"], [150]);
      const gA = await gameIdFrom(await satori.connect(owner).createGame(streamA, 1, cfg, "A"), games);
      const gB = await gameIdFrom(await satori.connect(owner).createGame(streamB, 1, cfg, "B"), games);

      // No votes: both games are ADAPTER games, and `vote` refuses those
      // (GameNotMintEligible). Neither can hold weight, so neither draws a
      // pool — which is exactly why the conservation identity below is asserted
      // on the adapter's books rather than on payouts. The would-be voter is
      // funded first so the refusal is the eligibility rule, not a short balance.
      const voter = signers[8];
      await satori.transfer(voter.address, VOTE);
      await expect(satori.connect(voter).vote(gA, VOTE))
        .to.be.revertedWithCustomError(fix.voting, "GameNotMintEligible");
      await expect(satori.connect(voter).vote(gB, VOTE))
        .to.be.revertedWithCustomError(fix.voting, "GameNotMintEligible");

      const round = Number(await satori.getCurrentRound());

      // Game A: ONE winner (solo) — numerator == denominator.
      const solo = signers[1];
      await satori.transfer(solo.address, ethers.parseEther("10"));
      await satori.connect(solo).predictMultipleWithPayloads([{ gameId: gA, payload: pack1(YES) }]);

      // Game B: TWO winners split the same total weight (7 + 3 = 10).
      const w1 = signers[2], w2 = signers[3];
      await satori.transfer(w1.address, ethers.parseEther("7"));
      await satori.transfer(w2.address, ethers.parseEther("3"));
      await satori.connect(w1).predictMultipleWithPayloads([{ gameId: gB, payload: pack1(YES) }]);
      await satori.connect(w2).predictMultipleWithPayloads([{ gameId: gB, payload: pack1(YES) }]);

      // --- CONSERVATION, on the numerators the protocol actually divides by ---
      const soloW = await yesNo.pendingWeight(gA, solo.address);
      const totalA = await yesNo.dirWeight(gA, round, YES);
      const w1W = await yesNo.pendingWeight(gB, w1.address);
      const w2W = await yesNo.pendingWeight(gB, w2.address);
      const totalB = await yesNo.dirWeight(gB, round, YES);

      expect(soloW).to.be.gt(0n);
      expect(soloW).to.equal(totalA);          // solo takes the WHOLE pool
      expect(w1W + w2W).to.equal(totalB);      // and the split sums to one pool
      expect(totalB).to.equal(totalA);         // the same pool in both games
      // Proportional shares, now EXACT rather than within-dust: w1 (7) is 70%
      // of the denominator, w2 (3) is 30%.
      expect((w1W * 100n) / totalB).to.equal(70n);
      expect((w2W * 100n) / totalB).to.equal(30n);

      // Resolve both YES.
      await advanceRounds(2);
      await registry.connect(owner).setValue(streamA, 200);
      await registry.connect(owner).setValue(streamB, 200);

      const soloBefore = await rewards.unclaimedRewards(solo.address);
      await satori.settlePrediction(solo.address, gA);
      const soloPool = (await rewards.unclaimedRewards(solo.address)) - soloBefore;

      const w1Before = await rewards.unclaimedRewards(w1.address);
      const w2Before = await rewards.unclaimedRewards(w2.address);
      await satori.settlePrediction(w1.address, gB);
      await satori.settlePrediction(w2.address, gB);
      const splitTotal =
        ((await rewards.unclaimedRewards(w1.address)) - w1Before) +
        ((await rewards.unclaimedRewards(w2.address)) - w2Before);

      // Every bet really was scored on its way to the numbers below.
      expect(await yesNo.roundOutcome(gA, round)).to.equal(YES);
      expect(await yesNo.roundOutcome(gB, round)).to.equal(YES);
      for (const [p, g] of [[solo, gA], [w1, gB], [w2, gB]]) {
        expect(await yesNo.pendingRound(g, p.address)).to.equal(0n);
      }

      // INVERTED (mint eligibility): the realized pool is ZERO on both sides, so
      // the two-winner split still sums to exactly the solo winner's take.
      // Conservation holds at its new floor — one pool of nothing, never two.
      expect(soloPool).to.equal(0n);
      expect(splitTotal).to.equal(soloPool);
    });

    it("no winner on the resolved direction: the winning side is empty and nothing is minted", async function () {
      // Everyone bets NO, but the value resolves so YES is the winning
      // direction. No YES weight exists, so every NO bettor scores userScore 0
      // → the protocol mints nothing to them.
      const { satori, rewards, registry, yesNo, yesNoGameId, streamId, signers, owner } =
        await deployWithYesNo(150);
      const a = signers[1], b = signers[2];
      await satori.transfer(a.address, ethers.parseEther("10"));
      await satori.transfer(b.address, ethers.parseEther("10"));
      const round = Number(await satori.getCurrentRound());
      await satori.connect(a).predictMultipleWithPayloads([{ gameId: yesNoGameId, payload: pack1(NO) }]);
      await satori.connect(b).predictMultipleWithPayloads([{ gameId: yesNoGameId, payload: pack1(NO) }]);

      await advanceRounds(2);
      await registry.connect(owner).setValue(streamId, 200); // YES is the winning bucket

      const aBefore = await rewards.unclaimedRewards(a.address);
      const bBefore = await rewards.unclaimedRewards(b.address);
      await satori.settlePrediction(a.address, yesNoGameId);
      await satori.settlePrediction(b.address, yesNoGameId);

      // The round really resolved YES, and the winning side carries NO weight
      // at all while the losing side carries all of it — the exact shape the
      // "no winner" case is named for.
      expect(await yesNo.roundOutcome(yesNoGameId, round)).to.equal(YES);
      expect(await yesNo.dirWeight(yesNoGameId, round, YES)).to.equal(0n);
      expect(await yesNo.dirWeight(yesNoGameId, round, NO)).to.be.gt(0n);
      // Both bets were consumed — settled, not stalled.
      for (const p of [a, b]) {
        expect(await yesNo.pendingRound(yesNoGameId, p.address)).to.equal(0n);
      }

      // Both bet NO; YES won; NO bettors lose → 0. (No YES bettor existed.)
      expect((await rewards.unclaimedRewards(a.address)) - aBefore).to.equal(0n);
      expect((await rewards.unclaimedRewards(b.address)) - bBefore).to.equal(0n);
    });
  });

  // ============================================================
  // Delegation interacting with adapter scoring (med-priority gap).
  // Intent: a predictor with inbound delegated power who wins splits the reward
  // by predictorFeeBps (default 10% to the predictor on the delegated portion,
  // 90% to delegators): predictor portion + delegators' pulled share == the full
  // reward.
  //
  // INVERTED half: an ADAPTER win contributes NOTHING to that split — the game
  // is not mint-eligible, its pool is zero, so `_splitReward` is never reached
  // and nothing is folded into the round's delegator pull-rate accumulator. The
  // same predictor's BINARY win in the SAME round is the positive control: it
  // proves the delegation machinery is live, so the adapter's zero is an
  // adapter-specific fact and not a broken setup. The 55/45 arithmetic is then
  // asserted against the binary leg — the whole of it, since the adapter leg
  // contributed none of it.
  // ============================================================
  describe("adapter winner delegation split", function () {
    it("an adapter win folds nothing into the delegator rate; the same round's binary win splits 55/45", async function () {
      this.timeout(120000);
      const { satori, rewards, registry, voting, yesNo, yesNoGameId, binaryGameId,
              streamId, signers, owner } = await deployWithYesNo(150);
      const predictor = signers[1], delegator = signers[2], voter = signers[3];
      // Give both equal balance so the delegated portion is a clean 1/2.
      await satori.transfer(predictor.address, ethers.parseEther("10"));
      await satori.transfer(delegator.address, ethers.parseEther("10"));
      await satori.transfer(voter.address, VOTE);

      // Delegator delegates prediction power to the predictor.
      await satori.connect(delegator).delegatePredictionPower(predictor.address);

      // Only the BINARY game can be made eligible — `vote` on the adapter game
      // reverts GameNotMintEligible, which is the asymmetry under test.
      await expect(voteFor(satori, voter, yesNoGameId))
        .to.be.revertedWithCustomError(voting, "GameNotMintEligible");
      await voteFor(satori, voter, binaryGameId);
      // Delegator weight is capital x loyalty and a fresh delegation starts at
      // L = 0. Warm on the BINARY game -- the adapter game is deliberately
      // ineligible here, which is the asymmetry under test.
      await warmUpLoyalty(satori, registry, null, predictor, [delegator], voter, binaryGameId, 40, 4);
      // The warm-up spans several cadence periods, so the host stream needs a
      // fresh anchor in THIS round or the predict below reverts PredictExpired.
      await registry.connect(owner).setValue(streamId, 100);

      // Predictor predicts YES on the adapter game AND UP on the binary game,
      // both on the same stream, in the same round, using own + delegated power.
      const round = Number(await satori.getCurrentRound());
      await satori.connect(predictor).predictMultipleWithPayloads([
        { gameId: yesNoGameId, payload: pack1(YES) },
        { gameId: binaryGameId, payload: pack1(UP) },
      ]);

      // Resolve: the host stream's next value is 200. For the adapter that is
      // the first value after R (200 > 150 → YES wins). For the two-round-cadence
      // binary game it is the post value against the anchor written in round R
      // (200 > 100 → UP is correct).
      await advanceRounds(2);
      await registry.connect(owner).setValue(streamId, 200);

      // --- Adapter leg: settles, resolves, and credits NOTHING ---
      const predBefore = await rewards.unclaimedRewards(predictor.address);
      await satori.settlePrediction(predictor.address, yesNoGameId);
      const afterAdapter = await rewards.unclaimedRewards(predictor.address);
      expect(await yesNo.roundOutcome(yesNoGameId, round)).to.equal(YES);
      expect(await yesNo.pendingRound(yesNoGameId, predictor.address)).to.equal(0n);
      expect(afterAdapter - predBefore).to.equal(0n);

      // --- Binary leg: settles and pays; the delegated slice folds into the
      //     round's pull-rate accumulator ---
      await satori.settlePrediction(predictor.address, binaryGameId);
      const predPortion = (await rewards.unclaimedRewards(predictor.address)) - afterAdapter;
      expect(predPortion).to.be.gt(0n);

      // Delegator pulls their share via a self-claim (drains to balance).
      const delBalBefore = await satori.balanceOf(delegator.address);
      await satori.connect(delegator)["claim()"]();
      const delGain = (await satori.balanceOf(delegator.address)) - delBalBefore;
      expect(delGain).to.be.gt(0n);

      // The predictor portion + delegator share == the full reward, and the
      // full reward is the BINARY win alone (the adapter added zero to both).
      // With equal own/delegated power (50/50) and default 10% predictor fee:
      //   delegatedReward = reward/2
      //   predictorBonus  = delegatedReward * 10%
      //   delegatorsShare = delegatedReward * 90%
      //   userPortion     = reward/2 + delegatedReward*10%
      // So predPortion / delGain ≈ (0.5 + 0.05) / 0.45 = 0.55/0.45.
      const total = predPortion + delGain;
      const expectedPred = (total * 55n) / 100n;
      const expectedDel = total - expectedPred;
      const tol = total / 50n; // 2% tolerance for integer/quantization dust
      expect(predPortion).to.be.closeTo(expectedPred, tol);
      expect(delGain).to.be.closeTo(expectedDel, tol);
    });
  });

  // ============================================================
  // Solo-winner pool conservation (score/total model).
  //
  // (The old "zero-weight adapter prediction" probe is DROPPED: it read the
  // removed protocol-side getters `adapterUserRecord` / `adapterBucketWeight`
  // and modeled a "weight 0 / bucket-total" guard that no longer exists —
  // the protocol stores no per-bet weight, and the adapter decides the share
  // entirely at score time. Its salvageable intent — "a lone winner takes the
  // FULL pool, with the userScore numerator exactly equal to the round's
  // denominator (`total`), so nothing strands and nothing over-mints" — is
  // re-expressed here behaviorally against the adapter's own state.)
  // ============================================================
  describe("solo-winner pool conservation", function () {
    it("a lone winner's numerator equals the round's total → it takes the whole pool, nothing strands", async function () {
      this.timeout(120000);
      const { satori, rewards, registry, yesNo, yesNoGameId, streamId, signers, owner } =
        await deployWithYesNo(150);
      const real = signers[1];
      await satori.transfer(real.address, ethers.parseEther("10"));

      const round = Number(await satori.getCurrentRound());
      await satori.connect(real).predictMultipleWithPayloads(
        [{ gameId: yesNoGameId, payload: pack1(YES) }]);

      // The lone predictor's committed weight (the score/total numerator on a
      // YES win) equals the round's whole YES-direction total (the shared
      // denominator). numerator == denominator ⇒ a sole winner's
      // pool × userScore / total == the FULL pool, with no ghost weight
      // diluting the denominator.
      const w = await yesNo.pendingWeight(yesNoGameId, real.address);
      const dirTotal = await yesNo.dirWeight(yesNoGameId, round, YES);
      expect(w).to.be.gt(0n);
      expect(w).to.equal(dirTotal);

      // Resolve YES. Conservation is structural: with numerator == denominator
      // the pinned round can pay out at most exactly one pool
      // (Σ paid numerators ≤ total ⇒ minted ≤ pool).
      await advanceRounds(2);
      await registry.connect(owner).setValue(streamId, 200);
      const before = await rewards.unclaimedRewards(real.address);
      await satori.settlePrediction(real.address, yesNoGameId);
      const gain = (await rewards.unclaimedRewards(real.address)) - before;

      // The settle ran: the round resolved YES and the bet was consumed.
      expect(await yesNo.roundOutcome(yesNoGameId, round)).to.equal(YES);
      expect(await yesNo.pendingRound(yesNoGameId, real.address)).to.equal(0n);
      expect(await yesNo.pendingWeight(yesNoGameId, real.address)).to.equal(0n);
      // INVERTED (mint eligibility): that "full pool" is ZERO for an adapter
      // game — it can hold no voting weight, so it draws no allocation.
      expect(gain).to.equal(0n);

      // A second settle finalizes nothing further — the bet was consumed at
      // score time (no double-pay, no strand of a second pool).
      await satori.settlePrediction(real.address, yesNoGameId);
      expect((await rewards.unclaimedRewards(real.address)) - before).to.equal(gain);
      expect(await yesNo.pendingRound(yesNoGameId, real.address)).to.equal(0n);
    });
  });
});
