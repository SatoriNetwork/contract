// Adversarial repro for finding (high, game-adapters):
//   "Adapter score path never force-finalizes on anchor eviction,
//    permanently stranding predictions (binary path does)"
//   location: contracts/games/YesNoGame.sol score() anchorEvicted branch;
//   contrast contracts/Satori.sol _scorePreviousPrediction eviction branch.
//
// THEORY OF THE BUG
// -----------------
// registry.getFirstValueAfter(streamId, afterHour) returns
//   (value, found, anchorEvicted). Three observable outcomes (per the
//   registry's own doc):
//     - found=true                : score it now.
//     - found=false, evicted=false: recoverable, "data not ready", retry later.
//     - found=false, evicted=true : IRRECOVERABLE — the 768-entry ring rolled
//                                   past the prediction's anchor; the slot MUST
//                                   be force-finalized.
// The inline binary scorer honors the third case (marks scored, resets streak,
// _notifyFinalized, emits PredictionUnrecoverable). YesNoGame.score must do the
// equivalent in the score/total model: on anchorEvicted it clears its own
// per-user pending record and returns scored=true with total==0, so the core's
// scoreAdapterPrediction pins total 0 (pays nothing) AND _notifyFinalized
// decrements the predict-time _unsettledPredictionCount bump — i.e. the bet
// reaches a TERMINAL state instead of being stranded forever.
//
// THE REFACTOR (bucket -> score/total): SatoriRewards.adapterUserRecord and the
// per-bet bucket/weight it exposed are GONE. The adapter now owns its per-user
// state. Terminal state is therefore verified BEHAVIORALLY:
//   1. PRE-state: the adapter's own public record is live —
//      yesNo.pendingRound/pendingDir/pendingWeight reflect the open YES bet.
//   2. POST force-finalize (settle after eviction): score() cleared the
//      adapter's pending record (pendingRound/pendingWeight read back 0) AND a
//      SECOND settle is a clean no-op (score returns scored=false because the
//      record is gone, so _scoreAdapterPrediction early-returns; no revert,
//      no double-finalize).
//   3. NO-STRAND: a genuinely co-pending prediction made by the SAME user in
//      the SAME round still settles. The binary and adapter paths share one
//      per-(user,round) _unsettledPredictionCount; if the adapter eviction
//      branch failed to decrement it (the stranding bug), the count would be
//      wrong, but more directly the adapter bet's record would remain live.
//      We co-stage a binary bet in round R, evict both, and show BOTH reach a
//      terminal state (the binary one via PredictionUnrecoverable, the adapter
//      one via its cleared record) — neither strands the other.
//
// A binary (type-0) control in the same eviction scenario shows the contrast:
// the binary path emits PredictionUnrecoverable and force-finalizes.

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time, impersonateAccount, setBalance } =
  require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture, pack1 } = require("../fixtures");

const ROUND = 86400;
const YES = 1;
const NO = 2;
const UP = 1;

// HISTORY_SIZE = 768 (the phase-6 hour-keyed ring). To evict the anchor that
// stands at the prediction's moment we must push >= 768 strictly-later entries
// into the ring so it rolls entirely past the anchor.
const HISTORY_SIZE = 768;

async function advanceRounds(n) { await time.increase(ROUND * n); }

// Genesis creates the DEFAULT stream at id 1 and its derived family at ids 2..4,
// so the first stream a test creates is id 5. Read it off the event rather than
// hardcoding — id 1 is the default stream, whose provider is the hub.
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

describe("adv_3 game-adapters: adapter must force-finalize on anchor eviction", function () {
  this.timeout(600000);

  async function deploy() {
    const fix = await loadFixture(deploySatoriFixture);
    const { satori, engine, rewards, registry, games, owner } = fix;

    // Deploy + register the YesNoGame adapter at gameTypeId = 1.
    // The adapter's record/score entrypoints are called by the ENGINE, so the
    // engine is the authorized "core" for _onlyCore.
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

    // Stream (its auto-created binary type-0 game) + threshold yes/no game
    // (type 1). An adapter game's host stream must be >= 2880 minutes (two
    // rounds), so both the eviction
    // ticks and the binary game's anchor->next scoring run on a 2-round rhythm.
    const streamId = await streamIdFrom(
      await satori.connect(owner)["createSimpleDataStream(string,address,uint24)"](
        "BTC-Test", owner.address, 2880),
      satori);
    // The stream's own binary game — NOT gameId 1, which is the protocol
    // default game on the default stream.
    const binaryGameId = Number(await games.binaryGameByStream(streamId));
    // A predict requires a value written in the CURRENT round (PredictExpired);
    // it is also the anchor the two-round-cadence binary game scores against.
    await registry.connect(owner).setValue(streamId, 100);

    const threshold = 150;
    const cfg = ethers.AbiCoder.defaultAbiCoder().encode(["int128"], [threshold]);
    const tx = await satori.connect(owner).createGame(streamId, 1, cfg, "BTC-yesno");
    const yesNoGameId = await gameIdFrom(tx, games);

    return { ...fix, yesNo, streamId, binaryGameId, yesNoGameId, threshold };
  }

  it("after the anchor is evicted, a settled adapter prediction reaches a terminal state (record cleared)", async function () {
    const { satori, rewards, registry, yesNo, yesNoGameId, streamId, signers, owner } =
      await loadFixture(deploy);

    const alice = signers[1];
    await satori.transfer(alice.address, ethers.parseEther("10"));
    // NO vote: `vote` on an adapter game reverts GameNotMintEligible, so the
    // game can never be made mint-eligible. It does not need to be: the adapter
    // is handed the predictor's UNDIVIDED prediction power regardless of
    // eligibility, so its record below is genuinely non-zero and the stranding
    // this file guards against is a real loss of committed weight.

    // Round R: alice predicts YES on the adapter game. record() stores the
    // adapter's own per-user state {round=R, dir=YES, weight=alice's power} and
    // the core bumps _unsettledPredictionCount[alice][R].
    const R = Number(await satori.getCurrentRound());
    const alicePower = await rewards.getPredictionPower(alice.address);
    expect(alicePower).to.be.gt(0n);
    await satori.connect(alice).predictMultipleWithPayloads([
      { gameId: yesNoGameId, payload: pack1(YES) },
    ]);

    // PRE-state lives on the adapter (the core no longer stores bucket/weight).
    expect(await yesNo.pendingRound(yesNoGameId, alice.address)).to.equal(R);
    expect(await yesNo.pendingDir(yesNoGameId, alice.address)).to.equal(YES);
    expect(await yesNo.pendingWeight(yesNoGameId, alice.address)).to.equal(alicePower);

    // Push HISTORY_SIZE+1 strictly-later stream entries WITHOUT alice settling.
    // The anchor at round R rolls entirely out of the 768-entry ring -> evicted.
    for (let i = 0; i < HISTORY_SIZE + 1; i++) {
      await advanceRounds(2);
      // alternate values; irrelevant to eviction, just must satisfy cadence.
      await registry.connect(owner).setValue(streamId, 200 + i);
    }

    // Sanity: the registry now reports the anchor as evicted (found=false,
    // anchorEvicted=true) for round R — probed at R*24+23, the last hour of
    // round R, which is exactly the hour-keyed query the adapter's score()
    // makes. This is the irrecoverable case it is supposed to force-finalize.
    const probe = await registry.getFirstValueAfter(streamId, R * 24 + 23);
    // probe = [valueB, found, anchorEvicted]
    expect(probe[1]).to.equal(false, "expected found=false after eviction");
    expect(probe[2]).to.equal(true, "expected anchorEvicted=true after eviction");

    // Anyone settles alice's stranded adapter prediction.
    await satori.settlePrediction(alice.address, yesNoGameId);

    // INTENDED: the prediction reached a terminal state. score() honored
    // anchorEvicted (returned scored=true,total=0) so the core finalized the
    // bet and the adapter CLEARED its own per-user record. If the adapter
    // ignored anchorEvicted, score() would have returned scored=false, the
    // core would never finalize, and the record (weight == alicePower) would be
    // stranded forever.
    expect(await yesNo.pendingRound(yesNoGameId, alice.address)).to.equal(
      0n,
      "adapter prediction must reach a terminal state on anchor eviction " +
      "(record cleared); a live pendingRound means it is permanently stranded"
    );
    expect(await yesNo.pendingWeight(yesNoGameId, alice.address)).to.equal(0n);

    // A SECOND settle is a clean no-op: with the record gone, score() returns
    // scored=false, _scoreAdapterPrediction early-returns, nothing double-pays
    // or double-finalizes (no revert).
    await expect(satori.settlePrediction(alice.address, yesNoGameId)).to.not.be.reverted;
    expect(await yesNo.pendingRound(yesNoGameId, alice.address)).to.equal(0n);
  });

  it("NO-STRAND: a co-pending bet in the same round still finalizes after the adapter eviction-finalize", async function () {
    // The adapter and binary scoring paths share ONE per-(user,round)
    // _unsettledPredictionCount. This proves the adapter eviction branch
    // settles ITS OWN bet (clears its record) without corrupting / stranding a
    // genuinely co-pending bet the same user made in the same round.
    const { satori, engine, rewards, registry, yesNo, yesNoGameId, binaryGameId,
            streamId, signers, owner } = await loadFixture(deploy);

    const carol = signers[3];
    await satori.transfer(carol.address, ethers.parseEther("10"));

    // Round R: carol makes TWO bets in one batch — the adapter YES bet and the
    // SAME STREAM's binary UP bet. Both bump the SAME
    // _unsettledPredictionCount[carol][R] (counter == 2), and both anchor on
    // the same stream round, so one eviction loop strands both.
    const R = Number(await satori.getCurrentRound());
    const carolPower = await rewards.getPredictionPower(carol.address);
    await satori.connect(carol).predictMultipleWithPayloads([
      { gameId: yesNoGameId, payload: pack1(YES) },
      { gameId: binaryGameId, payload: pack1(UP) },
    ]);
    expect(await yesNo.pendingRound(yesNoGameId, carol.address)).to.equal(R);
    // The adapter's committed weight is the predictor's UNDIVIDED power — it is
    // NOT split across the 2-game batch (that split only apportions SATORI, and
    // an adapter game draws none). So there is real weight here to strand.
    expect(await yesNo.pendingWeight(yesNoGameId, carol.address)).to.equal(carolPower);

    // Evict BOTH anchors (same stream): roll the ring past round R.
    for (let i = 0; i < HISTORY_SIZE + 1; i++) {
      await advanceRounds(2);
      await registry.connect(owner).setValue(streamId, 300 + i);
    }
    // Probe at R*24+23 — the adapter's own hour-keyed query for round R.
    const probe = await registry.getFirstValueAfter(streamId, R * 24 + 23);
    expect(probe[1]).to.equal(false);
    expect(probe[2]).to.equal(true);

    // Force-finalize the adapter bet first. Its record clears (terminal).
    await satori.settlePrediction(carol.address, yesNoGameId);
    expect(await yesNo.pendingRound(yesNoGameId, carol.address)).to.equal(0n);
    expect(await yesNo.pendingWeight(yesNoGameId, carol.address)).to.equal(0n);

    // The co-pending BINARY bet is NOT stranded by the adapter finalize: it
    // still force-finalizes on its own evicted anchor (PredictionUnrecoverable).
    // notifyPredictionFinalized would revert NoPendingPrediction if the shared
    // counter had been corrupted, so this also proves clean bookkeeping.
    await expect(satori.settlePrediction(carol.address, binaryGameId))
      .to.emit(engine, "PredictionUnrecoverable");
  });

  it("CONTROL: the inline binary (type-0) path force-finalizes the same eviction", async function () {
    const { satori, engine, registry, streamId, binaryGameId, signers, owner } =
      await loadFixture(deploy);

    const bob = signers[2];
    await satori.transfer(bob.address, ethers.parseEther("10"));

    // The stream's own auto-created inline binary game (type 0).
    await satori.connect(bob).predictMultipleWithPayloads([
      { gameId: binaryGameId, payload: pack1(UP) },
    ]);

    for (let i = 0; i < HISTORY_SIZE + 1; i++) {
      await advanceRounds(2);
      await registry.connect(owner).setValue(streamId, 200 + i);
    }

    // The binary scorer honors anchorEvicted (Satori.sol (pre-split)) and emits
    // PredictionUnrecoverable as it force-finalizes the stranded slot.
    await expect(satori.settlePrediction(bob.address, binaryGameId))
      .to.emit(engine, "PredictionUnrecoverable");
  });
});
