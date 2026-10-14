const { expect } = require("chai");
const { ethers } = require("hardhat");
const { deploySatoriFixture, deployAndRegisterYesNoGame } = require("./fixtures");

/**
 * Phase 6 (targets-on-games) DELETED the hub's public cadence floor and
 * StreamCadenceTooShort: anyone may create streams down to 60-minute cadence.
 * The floor that remains is the registry's hour grid — the ring stores at
 * most one entry per hour, so a cadence under 60 minutes cannot be
 * represented and reverts `InvalidCadence` for EVERY caller, admin included.
 *
 * The adapter-game gate survives unchanged: `SatoriGames.createGame` still
 * refuses any adapter or off-chain game on a stream finer than two rounds —
 * 2880 minutes — (`GameCadenceTooShort`). Fine streams are legitimate, just
 * limited to the built-in binary game.
 */
describe("stream cadence floor", function () {
  this.timeout(120000);

  let satori, registry, rewards, owner, signers, stranger;

  beforeEach(async function () {
    const fx = await deploySatoriFixture();
    ({ satori, registry, rewards, owner, signers } = fx);
    stranger = signers[5];
    await satori.transfer(stranger.address, ethers.parseEther("100"));
  });

  const SIMPLE3 = "createSimpleDataStream(string,address,uint24)";
  const SIMPLE2 = "createSimpleDataStream(string,address)";

  it("rejects a sub-hour cadence from EVERYONE — the ring's hour grid cannot represent it", async function () {
    // 59 minutes: below the hour grid → registry InvalidCadence, public...
    await expect(
      satori.connect(stranger)[SIMPLE3]("TooFine", stranger.address, 59)
    ).to.be.revertedWithCustomError(registry, "InvalidCadence");
    // ...and admin alike (the grid is physics, not a capability gate).
    await expect(
      satori.connect(owner)[SIMPLE3]("TooFineAdmin", owner.address, 59)
    ).to.be.revertedWithCustomError(registry, "InvalidCadence");
    // Zero for good measure.
    await expect(
      satori.connect(stranger)[SIMPLE3]("Zero", stranger.address, 0)
    ).to.be.revertedWithCustomError(registry, "InvalidCadence");
  });

  it("accepts 60 minutes (hourly) and above from the public — the old 1440 floor is gone", async function () {
    await expect(satori.connect(stranger)[SIMPLE3]("Hourly", stranger.address, 60))
      .to.not.be.reverted;
    let id = Number(await registry.getDataStreamCount());
    expect(Number(await registry.streamMinCadenceMinutes(id))).to.equal(60);

    await expect(satori.connect(stranger)[SIMPLE3]("Daily", stranger.address, 1440))
      .to.not.be.reverted;
    await expect(satori.connect(stranger)[SIMPLE3]("Weekly", stranger.address, 10080))
      .to.not.be.reverted;
  });

  it("the no-cadence convenience overload defaults to daily (1440 minutes)", async function () {
    await satori.connect(stranger)[SIMPLE2]("Default", stranger.address);
    const id = Number(await registry.getDataStreamCount());
    expect(Number(await registry.streamMinCadenceMinutes(id))).to.equal(1440);
  });

  it("a sub-round (720-minute) stream needs NO admin privilege any more", async function () {
    // Pre-phase-6 this was the admin's exclusive bypass; now a stranger may.
    await expect(satori.connect(stranger)[SIMPLE3]("SubRound", stranger.address, 720))
      .to.not.be.reverted;
    const id = Number(await registry.getDataStreamCount());
    expect(Number(await registry.streamMinCadenceMinutes(id))).to.equal(720);
  });

  it("adapter games need a two-round (2880-minute) stream; finer streams are refused", async function () {
    // The GameCadenceTooShort gate survives phase 6: sub-round and
    // every-round streams cannot host adapter games — only the built-in
    // binary game handles them.
    const { gameTypeId } = await deployAndRegisterYesNoGame({
      satori, registry, rewards, owner,
      games: (await ethers.getContractAt("SatoriGames", await satori.games())),
      engine: (await ethers.getContractAt("SatoriEngine", await satori.engine())),
    });
    const cfg = ethers.AbiCoder.defaultAbiCoder().encode(["int128"], [100]);

    // admin's sub-round stream: adapter game refused
    await satori.connect(owner)[SIMPLE3]("AdminFine", owner.address, 720);
    const fineId = Number(await registry.getDataStreamCount());
    await expect(satori.connect(owner).createGame(fineId, gameTypeId, cfg, "nope"))
      .to.be.reverted;

    // a public every-round (1440-minute) stream: still refused
    await satori.connect(stranger)[SIMPLE3]("PublicDaily", stranger.address, 1440);
    const dailyId = Number(await registry.getDataStreamCount());
    await expect(satori.connect(stranger).createGame(dailyId, gameTypeId, cfg, "nope"))
      .to.be.reverted;

    // a public two-round (2880-minute) stream: accepted
    await satori.connect(stranger)[SIMPLE3]("PublicTwoRound", stranger.address, 2880);
    const twoRoundId = Number(await registry.getDataStreamCount());
    await expect(satori.connect(stranger).createGame(twoRoundId, gameTypeId, cfg, "yes"))
      .to.not.be.reverted;
  });
});
