/**
 * Bounty key regression: bounties are keyed by gameId, not streamId.
 *
 * Now that games carry custom logic, a funder bounties a SPECIFIC game/market,
 * not the underlying data stream. The whole bounty path — `fundBounty`, the
 * predict-time `applyBoost` snapshot, the per-prediction "boosted" bit, and
 * `creditBountyForWin` — keys on gameId. The consequence pinned here:
 *   - A bounty on one game does NOT leak to a DIFFERENT game on the same
 *     stream (per-game isolation).
 *
 * (Historical note: bounty state was previously stream-keyed — the "A1" fix
 * threaded streamId into scoreCorrectPrediction so a game with gameId !=
 * streamId still hit the stream's bounty list. The games migration supersedes
 * that: a stream can host many games with independent logic, so the bounty
 * unit is the game.)
 *
 * SCOPE NOTE (post games-migration): to put a SECOND game on a stream it must
 * be an ADAPTER game (gameTypeId >= 1) — a duplicate type-0 binary game reverts
 * DuplicateBinaryGame, so a *binary* game with gameId != streamId can no longer
 * exist. Both halves of the original case therefore run on a YesNoGame ADAPTER
 * game (gameId != streamId): it carries the funded bounty and pays its own
 * predictors, and that bounty must not leak to the stream's default BINARY game.
 *
 * (This note previously claimed the bounty drip was "type-0-binary-only by
 * design", quoting a NatSpec that exists nowhere in contracts/, and the first
 * test was skipped on that basis. Adapter games pay a bounty on their own rail —
 * see the comment on that test.)
 *
 * Setup: a stream via the fixture's Proxy (which auto-creates a binary game,
 * gameId==streamId), then a SECOND game on the same stream that is a YesNoGame
 * adapter (gameId != streamId).
 */

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture, pack1, deployAndRegisterYesNoGame, createYesNoGame, VOTE } = require("./fixtures");

const UP = 1;

// The stream that hosts the adapter game is created at a two-round cadence
// (2880 minutes; see createStream), so its setValue rhythm must clear both the
// round-level guard (>= 2 rounds elapsed) and the timestamp guard
// (>= 2*86400 - 1800 = 171000s); two full rounds (172800s) satisfy both.
async function advanceTwoRounds() { await time.increase(2 * 86400); }

async function deployMockToken(sym = "USDC") {
  const M = await ethers.getContractFactory("MockERC20");
  const t = await M.deploy(sym, sym);
  await t.waitForDeployment();
  return t;
}

async function createStream(satori, signer, name, authority) {
  // Two-round cadence (2880 minutes): this stream hosts an ADAPTER game (the
  // YesNoGame below), and the create-time gate rejects adapter games on
  // streams finer than two rounds (GameCadenceTooShort).
  const tx = await satori.connect(signer)["createSimpleDataStream(string,address,uint24)"](name, authority, 2880);
  const rcpt = await tx.wait();
  for (const log of rcpt.logs) {
    try {
      const p = satori.interface.parseLog(log);
      if (p && p.name === "DataStreamCreated") return Number(p.args.streamId);
    } catch (e) {}
  }
  throw new Error("DataStreamCreated event missing");
}

async function stakeFor(rewards, bounties, user, token, amount) {
  await token.mint(user.address, amount);
  await token.connect(user).approve(await bounties.getAddress(), amount);
  await bounties.connect(user).stakeBountyToken(await token.getAddress(), amount);
}

describe("A1 — bounty pays out when gameId != streamId", function () {
  let satori, rewards, bounties, registry, games, owner, alice, bob, funder, authority;
  let streamId, gameId, usd;

  beforeEach(async function () {
    const fix = await loadFixture(deploySatoriFixture);
    ({ satori, rewards, bounties, registry, games, owner } = fix);
    [, alice, bob, funder, authority] = fix.signers;

    await satori.transfer(alice.address, ethers.parseEther("100"));
    await satori.transfer(bob.address, ethers.parseEther("100"));
    await satori.transfer(funder.address, ethers.parseEther("100"));
    await satori.transfer(authority.address, ethers.parseEther("100"));

    // Create the data stream the case needs. Fixture's Proxy wrapper also
    // auto-creates the stream's single binary game on it (gameId == streamId).
    streamId = await createStream(satori, authority, "S", authority.address);

    // Add a SECOND game on the same stream. A duplicate type-0 binary game
    // reverts DuplicateBinaryGame, so the extra game must be an ADAPTER game.
    // Register a YesNoGame (type-1) once and create it on `streamId` — its
    // gameId is the next id, so gameId != streamId (the per-game case).
    const { gameTypeId } = await deployAndRegisterYesNoGame(fix);
    // threshold 0: a YES (direction 1) bet wins iff the first stream value
    // after the bet's round is > 0 (every value used below is positive).
    gameId = await createYesNoGame(
      satori.connect(authority), gameTypeId, streamId, 0, "extra"
    );
    expect(gameId).to.not.equal(streamId); // <-- the per-game case

    // Burn for the default BINARY game only, so the isolation test's binary
    // prediction on `streamId` actually scores. The adapter game gets no burn:
    // only type-0 games are mint-eligible, so voting for it reverts
    // GameNotMintEligible. That costs this suite nothing — bounties are
    // separately funded escrow and pay on every game type, which is precisely
    // what these tests are about.
    await satori.connect(alice).vote(streamId, VOTE);
    await satori.connect(bob).vote(streamId, VOTE);

    // USDC mock + subscribe + stake.
    usd = await deployMockToken("USDC");
    await usd.mint(funder.address, ethers.parseEther("10000"));
    await usd.connect(funder).approve(await bounties.getAddress(), ethers.parseEther("10000"));
    await stakeFor(rewards, bounties, alice, usd, ethers.parseEther("100"));
  });

  // RE-ENABLED (P5 — an it.skip asserts nothing, and the justification was false).
  // The skip note claimed adapter-game winners "receive NO bounty drip by design",
  // quoting a SatoriRewards.scoreAdapterPrediction NatSpec — "Bounties are
  // type-0-binary-only (Option A)" — that appears nowhere in contracts/ (grep
  // returns zero hits outside test comments). The shipping code does the
  // opposite: scoreAdapterPrediction calls
  // ISatoriBounties.creditAdapterBounty(user, gameId, round, userScore,
  // bountyTotal) against the predict-time snapshotAdapterStake, i.e. adapter
  // games pay a SEPARATE, stake-weighted bounty rail — exactly what
  // docs/narratives/A_bounties.md:41 documents ("Adapter games (gameTypeId != 0)
  // pay a DIFFERENT bounty ... share = pot × bountyNum / bountyTotal").
  // The body passes unmodified against the current contracts.
  it("a non-default game (gameId != streamId) carries its own bounty and pays its predictors", async function () {
    // Bounty funded on the GAME (gameId != streamId), the unit a funder
    // actually endorses now that games carry custom logic.
    await bounties.connect(funder).fundBounty(
      gameId, await usd.getAddress(),
      ethers.parseEther("1000"), ethers.parseEther("200")
    );

    // A (anchor at predict round).
    await registry.connect(authority).setValue(streamId, 100);
    // Predict on that game (1-byte YES == direction 1 == pack1(UP)).
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: gameId, payload: pack1(UP) }]);

    // First stream value AFTER the bet's round resolves the YES/NO outcome.
    await advanceTwoRounds();
    await registry.connect(authority).setValue(streamId, 110);
    await advanceTwoRounds();
    await registry.connect(authority).setValue(streamId, 120);

    await satori.settlePrediction(alice.address, gameId);

    const usdAddr = await usd.getAddress();
    const earned =
      (await bounties.bountyStake(alice.address, usdAddr)) - ethers.parseEther("100");

    // The bounty is keyed by gameId throughout — funded on `gameId`, snapshotted
    // at predict on `gameId`, credited at settle on `gameId` — so this game's
    // predictor is paid out of this game's pot.
    expect(earned).to.be.gt(0n);
  });

  it("per-game isolation: a bounty on one game does NOT pay predictors of another game on the same stream", async function () {
    // Fund ONLY the extra (adapter) game's bounty.
    await bounties.connect(funder).fundBounty(
      gameId, await usd.getAddress(),
      ethers.parseEther("1000"), ethers.parseEther("200")
    );

    // Alice predicts the PAIRED game (gameId == streamId) — same data stream,
    // different market (the default BINARY game) — which has NO bounty funded.
    await registry.connect(authority).setValue(streamId, 100);
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(UP) }]);

    await advanceTwoRounds();
    await registry.connect(authority).setValue(streamId, 110);
    await advanceTwoRounds();
    await registry.connect(authority).setValue(streamId, 120);

    await satori.settlePrediction(alice.address, streamId);

    const usdAddr = await usd.getAddress();
    const earned =
      (await bounties.bountyStake(alice.address, usdAddr)) - ethers.parseEther("100");

    // The extra game's bounty must not leak to a different game on the same
    // stream. earned == 0.
    expect(earned).to.equal(0n);
  });
});
