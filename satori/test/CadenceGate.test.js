const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture } = require("./fixtures");

// FEATURE: adapter games (gameTypeId > 0) may only be created on streams whose
// minCadenceRounds >= 2. Only the built-in binary game (type 0) has the ABC
// scoring that handles a cadence-1 (every-round) stream, so adapters are gated
// to cadence >= 2 to keep game authoring simple. Create-time gate; the revert
// is GameCadenceTooShort.

describe("Cadence gate — adapters require host stream cadence >= 2", function () {
  let satori, registry, games, owner, provider;

  async function setup() {
    const fix = await loadFixture(deploySatoriFixture);
    ({ satori, registry, games, owner } = fix);
    provider = fix.signers[4];
    // Register a simple adapter (PartialCreditGame) to get a gameTypeId > 0.
    const Mock = await ethers.getContractFactory("PartialCreditGame");
    const mock = await Mock.deploy(await satori.getAddress());
    await mock.waitForDeployment();
    const rc = await (await satori.connect(owner).registerGameAdapter(await mock.getAddress(), "pc")).wait();
    let typeId;
    for (const log of rc.logs) {
      try {
        const p = games.interface.parseLog(log);
        if (p && p.name === "GameAdapterRegistered") { typeId = Number(p.args.gameTypeId); break; }
      } catch (e) {}
    }
    if (typeId === undefined) throw new Error("GameAdapterRegistered missing");
    return { typeId };
  }

  // Create a simple stream at `cadence` and return its id (the next stream id).
  async function createStream(cadence) {
    const before = Number(await registry.getDataStreamCount());
    await (await satori.connect(owner)["createSimpleDataStream(string,address,uint24)"]("S", provider.address, cadence)).wait();
    return before + 1;
  }

  it("adapter game on a cadence-1 stream reverts GameCadenceTooShort", async function () {
    const { typeId } = await setup();
    const streamId = await createStream(720);
    await expect(satori.connect(owner).createGame(streamId, typeId, "0x", "g"))
      .to.be.revertedWithCustomError(games, "GameCadenceTooShort");
  });

  it("adapter game on an every-round (daily, 24h) stream reverts too", async function () {
    // Under 24h rounds a daily stream IS every-round; the adapter-game gate
    // still requires two rounds between values.
    const { typeId } = await setup();
    const streamId = await createStream(1440);
    await expect(satori.connect(owner).createGame(streamId, typeId, "0x", "g"))
      .to.be.revertedWithCustomError(games, "GameCadenceTooShort");
  });

  it("adapter game on a two-day (two-round) stream is allowed", async function () {
    const { typeId } = await setup();
    const streamId = await createStream(2880);
    await expect(satori.connect(owner).createGame(streamId, typeId, "0x", "g")).to.not.be.reverted;
  });

  it("adapter game on a coarser (weekly) stream is allowed", async function () {
    const { typeId } = await setup();
    const streamId = await createStream(10080);
    await expect(satori.connect(owner).createGame(streamId, typeId, "0x", "g")).to.not.be.reverted;
  });

  it("the built-in binary game (type 0) is fine on a cadence-1 stream", async function () {
    await setup();
    // createSimpleDataStream auto-creates the type-0 game on the cadence-1 stream.
    await expect(
      satori.connect(owner)["createSimpleDataStream(string,address,uint24)"]("B", provider.address, 720)
    ).to.not.be.reverted;
  });
});
