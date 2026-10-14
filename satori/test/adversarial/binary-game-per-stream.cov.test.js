// Dedicated REGRESSION coverage for the "one binary game per stream" refactor.
//
// THE REFACTOR (code is the source of truth):
//   1. Satori.createSimpleDataStream AND createAdapterDataStream now AUTO-CREATE
//      exactly one core-owned, UNNAMED binary (type-0) game at stream creation,
//      calling satoriGames.createGame(address(this), streamId, 0, "", "")
//      DIRECTLY (bypassing the fee-charging createGame wrapper — the
//      stream-creation spam fee already covers it). The game's authority is the
//      core itself; its display name derives from the (live) stream name.
//   2. SatoriGames exposes `binaryGameByStream[streamId]` (0 if none yet) and
//      createGame reverts DuplicateBinaryGame() on a SECOND type-0 game for a
//      stream that already has one.
//   3. NET: at most ONE binary game per stream. Adapter (type-1+) games are
//      still PERMITTED as additional games on the same stream.
//
// These are STRONG assertions against the TRUE contract behavior — no assertion
// is weakened to go green. Where reality differs from the brief, the comment
// notes the actual behavior.

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { impersonateAccount, setBalance } = require("@nomicfoundation/hardhat-network-helpers");
const {
  deploySatoriFixture,
  createCustomStream,
} = require("../fixtures");

const BUILTIN_BINARY = 0;

// Pull the freshly-created stream id out of the DataStreamCreated event that
// the core emits. The wrapper returns the underlying tx, so .wait() works and
// the satori interface can parse the log.
async function streamIdFrom(tx, satori) {
  const r = await tx.wait();
  const ev = r.logs.find((l) => {
    try { return satori.interface.parseLog(l)?.name === "DataStreamCreated"; }
    catch { return false; }
  });
  expect(ev, "DataStreamCreated event should be emitted").to.not.equal(undefined);
  return Number(satori.interface.parseLog(ev).args.streamId);
}

describe("COVERAGE: one binary (type-0) game auto-created per stream + dup guard", function () {
  this.timeout(120000);

  it("simple stream auto-creates EXACTLY ONE core-owned unnamed binary game", async function () {
    const { satori, games } = await loadFixture(deploySatoriFixture);

    const streamId = await streamIdFrom(
      await satori.createSimpleDataStream("BTC simple", (await ethers.getSigners())[0].address),
      satori
    );

    // EXACTLY one game on the stream.
    expect(await games.gamesByStreamCount(streamId)).to.equal(1);

    // The binary index points at a non-zero game id.
    const gameId = Number(await games.binaryGameByStream(streamId));
    expect(gameId).to.not.equal(0);

    // That game must be the one game on the stream.
    const list = (await games.gamesByStream(streamId)).map(Number);
    expect(list).to.deep.equal([gameId]);

    // It is a type-0 binary, unnamed, core-owned.
    const meta = await games.gameMeta(gameId);
    expect(meta.gameTypeId).to.equal(BUILTIN_BINARY);
    expect(meta.name).to.equal("");
    expect(meta.dataStreamId).to.equal(streamId);
    expect(meta.authority).to.equal(await satori.getAddress());
  });

  it("adapter stream auto-creates EXACTLY ONE core-owned unnamed binary game", async function () {
    const { satori, games, signers } = await loadFixture(deploySatoriFixture);

    // ADAPTER_ID_CUSTOM with "0x" config via the fixture helper.
    const streamId = await streamIdFrom(
      await createCustomStream(satori, "Custom adapter", signers[1].address),
      satori
    );

    expect(await games.gamesByStreamCount(streamId)).to.equal(1);

    const gameId = Number(await games.binaryGameByStream(streamId));
    expect(gameId).to.not.equal(0);

    const list = (await games.gamesByStream(streamId)).map(Number);
    expect(list).to.deep.equal([gameId]);

    const meta = await games.gameMeta(gameId);
    expect(meta.gameTypeId).to.equal(BUILTIN_BINARY);
    expect(meta.name).to.equal("");
    expect(meta.dataStreamId).to.equal(streamId);
    expect(meta.authority).to.equal(await satori.getAddress());
  });

  it("GUARD: a SECOND binary game on the same stream reverts DuplicateBinaryGame", async function () {
    const { satori, games, owner } = await loadFixture(deploySatoriFixture);

    const streamId = await streamIdFrom(
      await satori.createSimpleDataStream("Dup target", owner.address),
      satori
    );
    // Pre-condition: the auto-created binary game already exists.
    expect(Number(await games.binaryGameByStream(streamId))).to.not.equal(0);

    // The core's createGame wrapper charges the spam fee; owner holds the
    // bootstrap mint so it can pay. The revert must be DuplicateBinaryGame —
    // NOT a fee/balance error — proving the guard, not an out-of-funds path.
    expect(await satori.balanceOf(owner.address)).to.be.gt(await satori.gameBurn());

    await expect(
      satori.connect(owner).createGame(streamId, 0, "0x", "dup")
    ).to.be.revertedWithCustomError(games, "DuplicateBinaryGame");

    // Guard did not mutate state: still exactly one game, same binary id.
    expect(await games.gamesByStreamCount(streamId)).to.equal(1);
  });

  it("POSITIVE: an ADAPTER (type-1) game CAN be added as a second game on the same stream", async function () {
    const { satori, games, registry, rewards, owner } = await loadFixture(deploySatoriFixture);

    const streamId = await streamIdFrom(
      await satori["createSimpleDataStream(string,address,uint24)"]("Multi-game stream", owner.address, 2880),
      satori
    );
    const binaryGameId = Number(await games.binaryGameByStream(streamId));
    expect(binaryGameId).to.not.equal(0);
    expect(await games.gamesByStreamCount(streamId)).to.equal(1);

    // Deploy + register a YesNoGame adapter (type 1) directly via the games
    // contract, impersonating the core (the only authorized caller).
    const YesNoGame = await ethers.getContractFactory("YesNoGame");
    const yesNo = await YesNoGame.deploy(
      await satori.getAddress(),
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

    // type 1 = first registered game adapter. Config is an abi-encoded int128
    // threshold (32 bytes — what YesNoGame.validateForStream requires).
    const cfg = ethers.AbiCoder.defaultAbiCoder().encode(["int128"], [150]);
    const tx = await satori.connect(owner).createGame(streamId, 1, cfg, "yesno");
    const rcpt = await tx.wait();

    // Parse the new gameId out of the GameCreated event on `games`.
    const gcEv = rcpt.logs
      .map((l) => { try { return games.interface.parseLog(l); } catch { return null; } })
      .find((p) => p && p.name === "GameCreated");
    expect(gcEv, "GameCreated should be emitted on games").to.not.equal(undefined);
    const adapterGameId = Number(gcEv.args.gameId);
    expect(adapterGameId).to.not.equal(binaryGameId);
    expect(Number(gcEv.args.gameTypeId)).to.equal(1);

    // Now TWO games on the stream...
    expect(await games.gamesByStreamCount(streamId)).to.equal(2);
    const list = (await games.gamesByStream(streamId)).map(Number);
    expect(list).to.deep.equal([binaryGameId, adapterGameId]);

    // ...but the binary index is UNCHANGED (guard is binary-specific).
    expect(Number(await games.binaryGameByStream(streamId))).to.equal(binaryGameId);

    // The adapter game really is type 1.
    const meta = await games.gameMeta(adapterGameId);
    expect(meta.gameTypeId).to.equal(1);
    expect(meta.dataStreamId).to.equal(streamId);
  });

  it("DEFAULT STREAM: bootstrap binary game exists and a second binary reverts", async function () {
    const { satori, games, owner } = await loadFixture(deploySatoriFixture);

    // The fixture now calls initializeDefaultStream() itself (matching
    // scripts/deploy.js), which is what creates the default stream + its single
    // binary game during bootstrap. Calling it again reverts AlreadySet().
    const DEFAULT_STREAM_ID = Number(await satori.DEFAULT_STREAM_ID());

    // The default stream already has its one binary game from bootstrap.
    const defGameId = Number(await games.binaryGameByStream(DEFAULT_STREAM_ID));
    expect(defGameId).to.not.equal(0);

    // It is type-0 and core-owned (its name is the bootstrap label, not "").
    const meta = await games.gameMeta(defGameId);
    expect(meta.gameTypeId).to.equal(BUILTIN_BINARY);
    expect(meta.authority).to.equal(await satori.getAddress());
    expect(meta.dataStreamId).to.equal(DEFAULT_STREAM_ID);

    // Creating a SECOND binary game on the default stream reverts the guard.
    await expect(
      satori.connect(owner).createGame(DEFAULT_STREAM_ID, 0, "0x", "dup-default")
    ).to.be.revertedWithCustomError(games, "DuplicateBinaryGame");
  });
});
