// Phase 7: explicit game targets — the creation half of the approved ladder
// (daily / weekly / monthly games on the same hourly stream, question 6).
// The default rule (stream cadence when above a day, else 1440) came with
// phase 6; this adds the explicit-target overload and its validation.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture, VOTE, pack1 } = require("./fixtures");

const HOUR = 3600;

describe("Game targets (explicit overload + ladder rules)", function () {
  let satori, registry, voting, games, engine, owner, alice, provider;

  beforeEach(async function () {
    const fix = await deploySatoriFixture();
    ({ satori, registry, voting, games } = fix);
    owner = fix.owner;
    [alice, provider] = fix.signers.slice(1, 3);
    engine = await ethers.getContractAt("SatoriEngine", await satori.engine());
    await satori.transfer(alice.address, ethers.parseEther("60"));
  });

  async function hourlyStream() {
    const tx = await satori["createSimpleDataStream(string,address,uint24)"](
      "HOURLY", provider.address, 60);
    const r = await tx.wait();
    for (const log of r.logs) {
      try {
        const p = registry.interface.parseLog(log);
        if (p && p.name === "DataStreamCreated") return p.args.streamId;
      } catch {}
    }
  }

  it("default rule recap: hourly stream's auto game is daily; a 2880 stream's is 2880", async function () {
    const sid = await hourlyStream();
    expect(await games.targetMinutes(sid)).to.equal(1440);
    const tx = await satori["createSimpleDataStream(string,address,uint24)"]("COARSE", provider.address, 2880);
    await tx.wait();
    const sid2 = Number(await registry.getDataStreamCount());
    expect(await games.targetMinutes(sid2)).to.equal(2880);
  });

  it("GameCreated carries the resolved target and the authority", async function () {
    const sid = await hourlyStream();
    const next = Number(await games.gameCount()) + 1;
    const [me] = await ethers.getSigners();
    await expect(satori["createGame(uint32,uint32,bytes,string,uint24)"](sid, 0, "0x", "weekly", 10080))
      .to.emit(games, "GameCreated")
      .withArgs(next, sid, me.address, 0, 10080, "weekly", "0x");
  });

  it("creates a WEEKLY game on an hourly stream with an explicit target", async function () {
    const sid = await hourlyStream();
    const before = await games.gameCount();
    await satori["createGame(uint32,uint32,bytes,string,uint24)"](sid, 0, "0x", "weekly", 10080)
      .then((tx) => tx.wait())
      .catch(async () => {
        // The stream's auto binary game exists; a SECOND type-0 game reverts
        // DuplicateBinaryGame — so ladder rungs beyond the first need... no:
        // this catch exists only to surface a real revert loudly.
        throw new Error("explicit-target creation reverted");
      });
    const gid = Number(await games.gameCount());
    expect(gid).to.equal(Number(before) + 1);
    expect(await games.targetMinutes(gid)).to.equal(10080);
    expect(await games.dataStreamId(gid)).to.equal(sid);
  });

  it("rejects sub-daily targets and targets below the stream's cadence", async function () {
    const sid = await hourlyStream();
    await expect(
      satori["createGame(uint32,uint32,bytes,string,uint24)"](sid, 0, "0x", "6h", 360)
    ).to.be.revertedWithCustomError(games, "InvalidTarget");
    const tx = await satori["createSimpleDataStream(string,address,uint24)"]("COARSE", provider.address, 2880);
    await tx.wait();
    const sid2 = Number(await registry.getDataStreamCount());
    await expect(
      satori["createGame(uint32,uint32,bytes,string,uint24)"](sid2, 0, "0x", "daily-on-2day", 1440)
    ).to.be.revertedWithCustomError(games, "InvalidTarget");
  });

  it("refuses a rung longer than the stream's history ring can reach, and accepts one that just fits", async function () {
    const sid = await hourlyStream();
    // 768 entries x a 60-minute cadence = 46080 minutes (32 days).
    await expect(
      satori["createGame(uint32,uint32,bytes,string,uint24)"](sid, 0, "0x", "too-long", 46140)
    ).to.be.revertedWithCustomError(games, "InvalidTarget");
    await expect(
      satori["createGame(uint32,uint32,bytes,string,uint24)"](sid, 0, "0x", "fits", 46080)
    ).to.not.be.reverted;
  });

  it("refuses a second binary game at a target the stream already has, however many games it holds", async function () {
    const sid = await hourlyStream();
    await satori["createGame(uint32,uint32,bytes,string,uint24)"](sid, 0, "0x", "weekly", 10080);
    await expect(
      satori["createGame(uint32,uint32,bytes,string,uint24)"](sid, 0, "0x", "weekly-again", 10080)
    ).to.be.revertedWithCustomError(games, "DuplicateBinaryGame");
    // The auto-created daily game holds the 1440 target.
    await expect(
      satori["createGame(uint32,uint32,bytes,string,uint24)"](sid, 0, "0x", "daily-again", 1440)
    ).to.be.revertedWithCustomError(games, "DuplicateBinaryGame");
  });

  it("weekly game clock: once per target period", async function () {
    const sid = await hourlyStream();
    // Align + seed the stream.
    const now = await time.latest();
    await time.increaseTo(Math.floor(now / HOUR) * HOUR + HOUR + 5);
    await registry.connect(provider).setValue(sid, 100);

    await (await satori["createGame(uint32,uint32,bytes,string,uint24)"](sid, 0, "0x", "weekly", 10080)).wait();
    const gid = Number(await games.gameCount());
    await voting.connect(owner).setGameApproved(gid, true);
    await satori.connect(alice).vote(gid, VOTE);

    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: gid, payload: pack1(1) }]);

    // Three days later, fresh value: still inside the weekly period.
    await time.increase(3 * 24 * HOUR);
    await registry.connect(provider).setValue(sid, 105);
    await expect(
      satori.connect(alice).predictMultipleWithPayloads([{ gameId: gid, payload: pack1(1) }])
    ).to.be.revertedWithCustomError(engine, "DuplicatePrediction");

    // Past the week (and a fresh value): allowed.
    await time.increase(5 * 24 * HOUR);
    await registry.connect(provider).setValue(sid, 110);
    await expect(
      satori.connect(alice).predictMultipleWithPayloads([{ gameId: gid, payload: pack1(1) }])
    ).to.not.be.reverted;
  });
});
