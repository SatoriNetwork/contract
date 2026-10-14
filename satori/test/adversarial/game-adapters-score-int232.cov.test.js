// Adversarial repro for finding (high, game-adapters):
//   "YesNoGame.score reverts on stream values outside int128 range, violating
//    the load-bearing 'score MUST NOT revert' invariant"
//   location: contracts/games/YesNoGame.sol (IStreamRegistryMin) and :142-143 (score)
//
// Intent (docs/narratives/A_game_adapters.md:21,41): the adapter's `score`
// function MUST NOT revert. Pending data is signaled by scored=false. A buggy
// or malicious adapter "can never brick the score path with a revert loop".
//
// The registry stores stream values as int232 and setValue(uint32, int232)
// accepts ANY int232 (SatoriRegistry.sol,447). YesNoGame's local interface
// declares getFirstValueAfter as returning int128 and decodes the returned
// word as int128 (YesNoGame.sol,142-143). For a stream value outside the
// int128 range (|v| > ~1.7e38, trivially within int232), the ABI return-data
// decoder validates the narrow signed type and REVERTS inside score().
//
// This test asserts the INTENDED behavior: settling a prediction whose
// resolving stream value is a valid int232 (but outside int128 range) MUST NOT
// revert. The protocol calls score() with no try/catch, so an adapter revert
// propagates and bricks settlePrediction (and every future score-first predict)
// for that game/round.

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time, impersonateAccount, setBalance } =
  require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture, pack1 } = require("../fixtures");

const ROUND = 86400;
const YES = 1;
const NO = 2;

async function advanceRounds(n) { await time.increase(ROUND * n); }

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

describe("adv_2 game-adapters — YesNoGame.score int128-decode revert on large int232 stream value", function () {
  this.timeout(120000);

  async function deploy() {
    const fix = await loadFixture(deploySatoriFixture);
    const { satori, rewards, registry, games, engine, owner } = fix;

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

    await satori.connect(owner)["createSimpleDataStream(string,address,uint24)"](
      "BTC-Test", owner.address
    , 2880);
    // Stream/game id 1 is the protocol's DEFAULT game (the fixture initializes it
    // exactly as production does), so the stream created here is id 2 — capture it
    // rather than hardcoding.
    const streamId = Number(await registry.nextStreamId()) - 1;
    // Initial value (small, within int128) so the stream exists.
    await registry.connect(owner).setValue(streamId, 100);

    // threshold within int128 range; the bug is triggered by the *resolving*
    // value being outside int128, not the threshold.
    const threshold = 150;
    const cfg = ethers.AbiCoder.defaultAbiCoder().encode(["int128"], [threshold]);
    const tx = await satori.connect(owner).createGame(streamId, 1, cfg, "BTC-yesno");
    const yesNoGameId = await gameIdFrom(tx, games);

    return { ...fix, yesNo, streamId, yesNoGameId, threshold };
  }

  it("settlePrediction MUST NOT revert when the resolving stream value is a valid int232 outside the int128 range", async function () {
    const { satori, rewards, registry, yesNo, yesNoGameId, streamId, signers, owner } =
      await loadFixture(deploy);
    const alice = signers[1];
    await satori.transfer(alice.address, ethers.parseEther("10"));

    // No vote: only the built-in binary game (gameTypeId 0) is mint-eligible, so
    // `vote` on an adapter game now reverts GameNotMintEligible. The vote was only
    // here to give the game a per-round allocation; the decode bug this test hunts
    // lives in score(), which runs on every settle regardless of allocation.

    // Alice predicts YES in round R.
    const predRound = await satori.getCurrentRound();
    await satori.connect(alice).predictMultipleWithPayloads([
      { gameId: yesNoGameId, payload: pack1(YES) },
    ]);

    // Advance two rounds and post the resolving value: 2**130. This is a valid
    // int232 (max ~6.9e69) but exceeds int128 max (~1.7e38). The provider
    // legitimately can post this; it respects the cadence guard. The host stream
    // is at a two-round (2880-minute) cadence, so the resolving write must land
    // >= 2 rounds (and >= the
    // wall-clock gap) after the deploy-time setValue(100) or it reverts.
    await advanceRounds(2);
    const bigValue = 2n ** 130n; // > int128 max, < int232 max
    await registry.connect(owner).setValue(streamId, bigValue);

    // Sanity: the registry round-trips the large value fine (int232 storage) —
    // this is the exact (streamId, afterHour) query the adapter's score()
    // makes (the hour-keyed ring is queried at round*24+23, the last hour of
    // the predict round), and it returns the value with found=true. The
    // registry side is healthy; only the adapter's narrow int128 decode is the
    // problem.
    const [vb, found] = await registry.getFirstValueAfter(streamId, predRound * 24n + 23n);
    expect(found).to.equal(true);
    expect(vb).to.equal(bigValue);

    // The bet is live on the adapter before the settle — so a cleared record
    // afterwards can only mean score() ran to completion (and not that the
    // settle silently did nothing).
    expect(await yesNo.pendingRound(yesNoGameId, alice.address)).to.equal(predRound);

    // INTENDED: score MUST NOT revert. settlePrediction should either credit
    // (YES wins, since bigValue > threshold) or no-op — but never revert.
    await expect(
      satori.settlePrediction(alice.address, yesNoGameId)
    ).to.not.be.reverted;

    // The settle really RESOLVED the round rather than bailing out: the adapter
    // decoded the large int232, cached the outcome as YES (bigValue > threshold)
    // and consumed alice's pending record. Under the narrow int128 decode this
    // whole path reverted, so these two reads are the direct repro.
    expect(await yesNo.roundOutcome(yesNoGameId, predRound)).to.equal(YES);
    expect(await yesNo.pendingRound(yesNoGameId, alice.address)).to.equal(0n);

    // Alice is paid NOTHING: an adapter game (gameTypeId > 0) can hold no voting
    // weight, so it draws no slice of the round budget. This used to assert
    // `> 0`; the resolve-vs-void proof it stood for is the two reads above.
    expect(await rewards.unclaimedRewards(alice.address)).to.equal(0n);
  });

  it("a poisoned round MUST NOT brick future score-first predicts on the game", async function () {
    const { satori, registry, yesNoGameId, streamId, signers, owner } =
      await loadFixture(deploy);
    const alice = signers[1];
    await satori.transfer(alice.address, ethers.parseEther("20"));

    // Round R: alice predicts.
    await satori.connect(alice).predictMultipleWithPayloads([
      { gameId: yesNoGameId, payload: pack1(YES) },
    ]);

    // Round R+2: provider posts a large int232 value resolving alice's bet. The
    // host stream is at a two-round (2880-minute) cadence, so the resolving write
    // must be spaced >= 2 rounds
    // after the deploy-time setValue(100) to clear the cadence guard.
    await advanceRounds(2);
    await registry.connect(owner).setValue(streamId, 2n ** 130n);

    // alice predicts again. predict is score-first: it must settle the pending
    // R-bet (which routes through score) before recording the new one. INTENDED:
    // this MUST NOT revert.
    await expect(
      satori.connect(alice).predictMultipleWithPayloads([
        { gameId: yesNoGameId, payload: pack1(NO) },
      ])
    ).to.not.be.reverted;
  });
});
