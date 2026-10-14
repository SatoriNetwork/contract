// End-to-end exercise of the games-primary architecture's adapter path.
//
// The user calls Satori.predict / Satori.settlePrediction. The protocol
// dispatches into the registered IPredictionGame adapter for any game
// whose gameTypeId != 0. The adapter only SCORES (returns a weight); it never
// credits SATORI directly.
//
// And under the mint-eligibility rule the protocol does not credit SATORI for
// it either: only the built-in binary game (type 0) earns from the mint, so an
// adapter game cannot be voted for, holds no weight, and draws a zero round
// allocation. The dispatch, the record/score bookkeeping and the settle path
// are all exercised here exactly as before — what changed is that a winning
// adapter bet resolves to a payout of zero.

const { expect } = require("chai");

let rewardsRef; // set in the fixture hook; the inner describes close over it
const { ethers } = require("hardhat");
const { loadFixture, time, impersonateAccount, setBalance } =
  require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture, pack1, voteFor } = require("./fixtures");

const ROUND = 86400;
const YES = 1;
const NO = 2;

async function advanceRounds(n) { await time.increase(ROUND * n); }

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

describe("YesNoGame — adapter end-to-end via the protocol's dispatch", function () {
  async function deploy() {
    const fix = await loadFixture(deploySatoriFixture);
    const { satori, engine, voting, rewards, registry, games, owner, signers } = fix;
    rewardsRef = rewards;

    // Deploy + register the YesNoGame adapter at gameTypeId = 1.
    // The ENGINE is the caller of record/score, so it is the adapter's core.
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

    // Create a stream the adapter game will resolve against — 2880 minutes
    // (two rounds), the finest cadence that may host an adapter game. The core
    // also auto-creates its binary game (gameId == streamId). The fixture
    // already initialized the DEFAULT stream at id 1, so this one lands at
    // id 2 — captured from the event rather than hardcoded.
    const streamId = await streamIdFrom(
      await satori.connect(owner)["createSimpleDataStream(string,address,uint24)"](
        "BTC-Test", owner.address, 2880),
      satori);
    await registry.connect(owner).setValue(streamId, 100);

    // Build a yes/no game on this stream, type 1. Threshold-only config —
    // no resolutionRound. Each prediction is scored against the first
    // stream value after the prediction's round.
    const threshold = 150;
    const cfg = ethers.AbiCoder.defaultAbiCoder().encode(
      ["int128"], [threshold]
    );
    const tx = await satori.connect(owner).createGame(streamId, 1, cfg, "BTC-yesno");
    const yesNoGameId = await gameIdFrom(tx, games);

    return { ...fix, yesNo, streamId, yesNoGameId, threshold };
  }

  describe("Setup", function () {
    it("registers the adapter at type 1 and the adapter is known to Satori", async function () {
      const { yesNo, games } = await loadFixture(deploy);
      expect(await games.gameAdapter(1)).to.equal(await yesNo.getAddress());
      expect(await games.isRegisteredGameAdapter(await yesNo.getAddress())).to.equal(true);
    });

    it("creates a yes/no game with frozen config", async function () {
      const { satori, yesNo, games, streamId, yesNoGameId, threshold, owner, signers } =
        await loadFixture(deploy);
      const alice = signers[1];

      // The body used to be `expect(yesNoGameId).to.be.greaterThan(0)` plus
      // comments conceding the freeze was unchecked. That assertion cannot
      // fail: gameIdFrom() throws when no GameCreated log exists, and
      // SatoriGames.createGame assigns `gameId = uint32(games.length)` AFTER
      // the push, so the id is >= 1 unconditionally. It only restated "the
      // fixture did not throw". Assert the config the test is named for.

      // GameMeta round-trip: right stream, right adapter type, config bytes intact.
      expect(await games.dataStreamId(yesNoGameId)).to.equal(streamId);
      expect(await games.gameTypeIdOf(yesNoGameId)).to.equal(1);
      const [storedThreshold] = ethers.AbiCoder.defaultAbiCoder().decode(
        ["int128"], await games.gameConfig(yesNoGameId)
      );
      expect(storedThreshold).to.equal(threshold);

      // The adapter's freeze is the LAZY `_ensureConfig` latch: untouched
      // before the first record...
      expect(await yesNo.configFrozen(yesNoGameId)).to.equal(false);
      expect(await yesNo.configs(yesNoGameId)).to.equal(0);

      // ...and the first predict latches EXACTLY the created threshold.
      await satori.transfer(alice.address, ethers.parseEther("10"));
      await satori.connect(alice).predictMultipleWithPayloads(
        [{ gameId: yesNoGameId, payload: pack1(YES) }]
      );
      expect(await yesNo.configFrozen(yesNoGameId)).to.equal(true);
      expect(await yesNo.configs(yesNoGameId)).to.equal(threshold);

      // validateForStream runs once at create time and reverts on a bad config
      // (A_game_adapters.md:48), so a malformed blob never reaches the latch.
      await expect(
        satori.connect(owner).createGame(streamId, 1, "0x1234", "bad-cfg")
      ).to.be.revertedWithCustomError(yesNo, "InvalidConfig");
    });
  });

  describe("Predict via Satori.predict", function () {
    it("user calls Satori.predictMultipleWithPayloads([{ gameId: gameId, payload: pack1(YES) }]); the adapter records the bet under the score/total model", async function () {
      const { satori, yesNo, yesNoGameId, signers, owner } = await loadFixture(deploy);
      const alice = signers[1], bob = signers[2];
      await satori.transfer(alice.address, ethers.parseEther("10"));
      await satori.transfer(bob.address, ethers.parseEther("10"));
      // No burn: an adapter game is not mint-eligible, so vote() reverts
      // GameNotMintEligible. Nothing below needs it — these are the ADAPTER's
      // own per-bet records, which it keeps whether or not the game ever draws
      // from the mint.
      const round = await satori.getCurrentRound();
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: yesNoGameId, payload: pack1(YES) }]);

      // Under the score/total model the protocol stores NO bucket/weight — the
      // adapter owns its own per-bet state (there is no `adapterUserRecord` /
      // `adapterBucketWeight` getter anymore). Confirm the adapter remembered
      // alice's YES bet for this round.
      expect(await yesNo.pendingDir(yesNoGameId, alice.address)).to.equal(YES);
      expect(await yesNo.pendingRound(yesNoGameId, alice.address)).to.equal(round);
      // The adapter is handed the predictor's REAL undivided power, not a dead
      // zero. Adapter games earn nothing from the mint (vote() reverts
      // GameNotMintEligible, so they carry no weight and get no allocation) —
      // but that zero belongs in the PAYOUT, not in the information the adapter
      // receives. It is not divided across the batch either: that split exists
      // only to apportion SATORI, and there is none here to apportion.
      const alicePower = await rewardsRef.getPredictionPower(alice.address);
      expect(alicePower).to.be.gt(0n);
      expect(await yesNo.pendingWeight(yesNoGameId, alice.address)).to.equal(alicePower);
      expect(await yesNo.dirWeight(yesNoGameId, round, YES)).to.equal(alicePower);
    });

    it("rejects double prediction on the same game", async function () {
      const { satori, yesNoGameId, signers } = await loadFixture(deploy);
      const alice = signers[1];
      await satori.transfer(alice.address, ethers.parseEther("10"));
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: yesNoGameId, payload: pack1(YES) }]);
      // Alice's `predictedStreamsCount` is already non-zero for this round.
      await expect(
        satori.connect(alice).predictMultipleWithPayloads([{ gameId: yesNoGameId, payload: pack1(NO) }])
      ).to.be.reverted;
    });

    it("rejects invalid direction (0 or > 2)", async function () {
      const { satori, yesNoGameId, signers } = await loadFixture(deploy);
      const alice = signers[1];
      await satori.transfer(alice.address, ethers.parseEther("10"));
      await expect(satori.connect(alice).predictMultipleWithPayloads([{ gameId: yesNoGameId, payload: pack1(0) }])).to.be.reverted;
      await expect(satori.connect(alice).predictMultipleWithPayloads([{ gameId: yesNoGameId, payload: pack1(3) }])).to.be.reverted;
    });
  });

  describe("Settle via Satori.settlePrediction", function () {
    it("YES wins and the adapter resolves it, but the winner is credited ZERO — an adapter game earns nothing from the mint", async function () {
      const {
        satori, rewards, registry, voting, yesNo, yesNoGameId,
        streamId, signers, owner
      } = await loadFixture(deploy);
      const alice = signers[1], bob = signers[2];
      await satori.transfer(alice.address, ethers.parseEther("10"));
      await satori.transfer(bob.address, ethers.parseEther("10"));
      // The game CANNOT be given weight: only the built-in binary game is
      // mint-eligible, so vote() on an adapter game reverts GameNotMintEligible.
      // With no weight the game draws no allocation from the round budget, so a
      // correct bet on it settles normally and pays nothing.
      await expect(voteFor(satori, owner, yesNoGameId))
        .to.be.revertedWithCustomError(voting, "GameNotMintEligible");
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: yesNoGameId, payload: pack1(YES) }]);

      // Score against the first stream value AFTER alice's prediction's
      // round. Drive that value > threshold so YES wins.
      // Two-round (2880-minute) stream: the deploy's setValue(100) was written this round, so
      // the next provider write must wait 2 rounds (and >= 84600s). Advancing an
      // extra round doesn't change the outcome — the adapter scores against the
      // first value AFTER the prediction's round, which this still is.
      await advanceRounds(2);
      await registry.connect(owner).setValue(streamId, 200);

      const ucBefore = await rewards.unclaimedRewards(alice.address);
      await satori.settlePrediction(alice.address, yesNoGameId);
      const ucAfter = await rewards.unclaimedRewards(alice.address);

      // This really was a settle, not a data-not-ready no-op: the adapter's
      // score() consumed alice's WINNING bet and cleared her pending record.
      expect(await yesNo.pendingRound(yesNoGameId, alice.address)).to.equal(0);
      expect(await yesNo.pendingDir(yesNoGameId, alice.address)).to.equal(0);
      // And it credited nothing. The game has no weight, so its round
      // allocation is zero and there is no pool for the winner to take.
      expect(ucAfter).to.equal(ucBefore);

      // Re-settling still credits nothing (the pending flag is consumed).
      await satori.settlePrediction(alice.address, yesNoGameId);
      expect(await rewards.unclaimedRewards(alice.address)).to.equal(ucBefore);
    });

    it("loser gets zero credit", async function () {
      const {
        satori, rewards, registry, yesNoGameId,
        streamId, signers, owner
      } = await loadFixture(deploy);
      const bob = signers[2];
      await satori.transfer(bob.address, ethers.parseEther("10"));
      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: yesNoGameId, payload: pack1(NO) }]);
      // First value after bob's round is > threshold → YES wins, NO loses.
      // Two-round (2880-minute) stream: the deploy's setValue(100) was written this round, so
      // the next provider write must wait 2 rounds (and >= 84600s). Advancing an
      // extra round doesn't change the outcome — the adapter scores against the
      // first value AFTER the prediction's round, which this still is.
      await advanceRounds(2);
      await registry.connect(owner).setValue(streamId, 200);
      const ucBefore = await rewards.unclaimedRewards(bob.address);
      await satori.settlePrediction(bob.address, yesNoGameId);
      const ucAfter = await rewards.unclaimedRewards(bob.address);
      expect(ucAfter).to.equal(ucBefore);
    });

    it("multi-user split — there is no pool to split: winners and loser alike are credited ZERO", async function () {
      const {
        satori, rewards, registry, yesNo, yesNoGameId,
        streamId, signers, owner
      } = await loadFixture(deploy);
      const alice = signers[1], bob = signers[2], carol = signers[3];
      await satori.transfer(alice.address, ethers.parseEther("30"));
      await satori.transfer(bob.address, ethers.parseEther("10"));
      await satori.transfer(carol.address, ethers.parseEther("5"));
      // No burn is possible: an adapter game is not mint-eligible, so it can
      // hold no weight and draws no allocation. The adapter still does its own
      // proportional bookkeeping — that is asserted below — but the protocol
      // mints nothing for it, so the "share" all three would split is zero.
      // All three predict YES in the same round.
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: yesNoGameId, payload: pack1(YES) }]);
      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: yesNoGameId, payload: pack1(YES) }]);
      await satori.connect(carol).predictMultipleWithPayloads([{ gameId: yesNoGameId, payload: pack1(NO) }]);
      // Next stream value > threshold → YES wins.
      // Two-round (2880-minute) stream: the deploy's setValue(100) was written this round, so
      // the next provider write must wait 2 rounds (and >= 84600s). Advancing an
      // extra round doesn't change the outcome — the adapter scores against the
      // first value AFTER the prediction's round, which this still is.
      await advanceRounds(2);
      await registry.connect(owner).setValue(streamId, 200);

      // Every bet is on the adapter's books with its direction and round, but
      // with ZERO weight: the engine hands a per-game power of 0 to any game
      // with no voting weight, and an adapter game can never hold any. Balances
      // of 30 / 10 / 5 would have made a 3:1 winners' split — there is simply
      // no pool to split it out of.
      const predRound = await yesNo.pendingRound(yesNoGameId, alice.address);
      expect(predRound).to.be.gt(0);
      // Both bets recorded at their own real power — the adapter sees genuine
      // per-player weight. What stays zero is the SATORI credited below.
      const aPow = await rewards.getPredictionPower(alice.address);
      const bPow = await rewards.getPredictionPower(bob.address);
      expect(await yesNo.pendingWeight(yesNoGameId, alice.address)).to.equal(aPow);
      expect(await yesNo.pendingWeight(yesNoGameId, bob.address)).to.equal(bPow);
      expect(await yesNo.dirWeight(yesNoGameId, predRound, YES)).to.be.gt(0n);

      const aBefore = await rewards.unclaimedRewards(alice.address);
      const bBefore = await rewards.unclaimedRewards(bob.address);
      const cBefore = await rewards.unclaimedRewards(carol.address);
      await satori.settlePrediction(alice.address, yesNoGameId);
      await satori.settlePrediction(bob.address, yesNoGameId);
      await satori.settlePrediction(carol.address, yesNoGameId);
      const aGained = (await rewards.unclaimedRewards(alice.address)) - aBefore;
      const bGained = (await rewards.unclaimedRewards(bob.address)) - bBefore;
      const cGained = (await rewards.unclaimedRewards(carol.address)) - cBefore;

      // All three bets really were scored — the adapter consumed every pending
      // record — so the zeros below are a resolved outcome, not a stalled one.
      expect(await yesNo.pendingRound(yesNoGameId, alice.address)).to.equal(0);
      expect(await yesNo.pendingRound(yesNoGameId, bob.address)).to.equal(0);
      expect(await yesNo.pendingRound(yesNoGameId, carol.address)).to.equal(0);

      // Carol bet NO and lost. Alice and Bob bet YES and won — and are paid the
      // same as her, because the game is not mint-eligible: it holds no weight,
      // so its round allocation is zero and 3x of nothing is still nothing.
      expect(cGained).to.equal(0);
      expect(aGained).to.equal(0);
      expect(bGained).to.equal(0);

      // Conservation, stated at its new floor: the total credited across ALL
      // predictors of this (game, round) is exactly zero. A game's per-round
      // pool is a share of the round budget proportional to its voting weight,
      // and only the built-in binary game can hold weight at all.
      const totalCredited = aGained + bGained + cGained;
      expect(totalCredited).to.equal(0);

      // No-double-pay / no-strand: re-settling every predictor credits nothing
      // more — the pending flags are consumed.
      await satori.settlePrediction(alice.address, yesNoGameId);
      await satori.settlePrediction(bob.address, yesNoGameId);
      await satori.settlePrediction(carol.address, yesNoGameId);
      expect((await rewards.unclaimedRewards(alice.address)) - aBefore).to.equal(aGained);
      expect((await rewards.unclaimedRewards(bob.address)) - bBefore).to.equal(bGained);
      expect((await rewards.unclaimedRewards(carol.address)) - cBefore).to.equal(cGained);
    });

    it("settle before next stream value is a no-op (data not ready)", async function () {
      const { satori, rewards, yesNoGameId, signers } = await loadFixture(deploy);
      const alice = signers[1];
      await satori.transfer(alice.address, ethers.parseEther("10"));
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: yesNoGameId, payload: pack1(YES) }]);
      // Don't advance to resolution. Settle: should not revert; just no-op.
      const before = await rewards.unclaimedRewards(alice.address);
      await satori.settlePrediction(alice.address, yesNoGameId);
      const after = await rewards.unclaimedRewards(alice.address);
      expect(after).to.equal(before);
    });
  });
});
