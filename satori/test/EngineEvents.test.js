// The engine's read model (docs/issues/events-are-the-read-model.md, step 4):
// the dust bar max(dustFloor, threshold) and every authority the engine trusts
// rebuild from logs, with no gameStreakState / curveConfig / role read.
const { expect } = require("chai");
const { deploySatoriFixture, pack1, VOTE } = require("./fixtures");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { ethers } = require("hardhat");

const UP = 1;

async function advanceRound() {
  const t = await time.latest();
  await time.increaseTo(Math.floor(t / 86400) * 86400 + 86400 + 1);
}

describe("Engine events", function () {
  this.timeout(300000);

  describe("wiring and authorities", function () {
    let fix, engine, owner, a, b;
    beforeEach(async function () {
      fix = await loadFixture(deploySatoriFixture);
      ({ engine, owner } = fix);
      [, a, b] = await ethers.getSigners();
    });

    it("initialize emits the effective default curve and dust target", async function () {
      const curve = await engine.queryFilter(engine.filters.CurveConfigSet(), 0);
      expect(curve.length).to.be.greaterThan(0);
      expect(curve[0].args.map(Number)).to.deep.equal([2, 3, 12, 0]);
      const target = await engine.queryFilter(engine.filters.DustTargetSet(), 0);
      expect(target.length).to.be.greaterThan(0);
      expect(Number(target[0].args.dustTargetBps)).to.equal(5000);
    });

    it("setHub emits HubSet with the wired hub", async function () {
      const logs = await engine.queryFilter(engine.filters.HubSet(), 0);
      expect(logs.length).to.equal(1);
      expect(logs[0].args.hub).to.equal(await engine.hub());
    });

    it("setCurveOperator emits the old and new operator", async function () {
      await expect(engine.connect(owner).setCurveOperator(a.address))
        .to.emit(engine, "CurveOperatorSet").withArgs(ethers.ZeroAddress, a.address);
      await expect(engine.connect(owner).setCurveOperator(b.address))
        .to.emit(engine, "CurveOperatorSet").withArgs(a.address, b.address);
      await expect(engine.connect(owner).setCurveOperator(ethers.ZeroAddress))
        .to.emit(engine, "CurveOperatorSet").withArgs(b.address, ethers.ZeroAddress);
    });

    it("setOffchainReporter emits the old and new reporter", async function () {
      await expect(engine.connect(owner).setOffchainReporter(a.address))
        .to.emit(engine, "OffchainReporterSet").withArgs(ethers.ZeroAddress, a.address);
      await expect(engine.connect(owner).setOffchainReporter(ethers.ZeroAddress))
        .to.emit(engine, "OffchainReporterSet").withArgs(a.address, ethers.ZeroAddress);
    });
  });

  describe("StreakThresholdSet", function () {
    let satori, engine, registry, owner, alice, bob, gameId;
    beforeEach(async function () {
      const fix = await deploySatoriFixture();
      ({ satori, engine, registry } = fix);
      [owner, alice, bob] = await ethers.getSigners();
      const rc = await (await satori["createSimpleDataStream(string,address,uint24)"]("BTC/USD", owner.address, 1440)).wait();
      const ev = rc.logs.map((l) => { try { return satori.interface.parseLog(l); } catch { return null; } })
        .find((p) => p && p.name === "DataStreamCreated");
      gameId = ev.args.streamId; // the fixture's binary game id coincides with the stream id
      await satori.transfer(alice.address, ethers.parseEther("100"));
      await satori.transfer(bob.address, ethers.parseEther("100"));
      await satori.connect(alice).vote(gameId, VOTE);
      await satori.connect(bob).vote(gameId, VOTE);
      await advanceRound();
    });

    const predict = (who) => satori.connect(who).predictMultipleWithPayloads([{ gameId, payload: pack1(UP) }]);

    it("the first prediction of a round emits the stored threshold and round; later ones in that round emit nothing", async function () {
      await registry.setValue(gameId, 100);
      const round = await engine.getCurrentRound();
      await expect(predict(alice)).to.emit(engine, "StreakThresholdSet").withArgs(gameId, round, 2);
      await expect(predict(bob)).to.not.emit(engine, "StreakThresholdSet");
    });

    it("every rollover's event equals gameStreakState after it, round after round", async function () {
      for (let i = 0; i < 6; i++) {
        await registry.setValue(gameId, 100 + i * 10);
        const rc = await (await predict(alice)).wait();
        const logs = rc.logs.filter((l) => l.address === engine.target)
          .map((l) => engine.interface.parseLog(l)).filter((p) => p && p.name === "StreakThresholdSet");
        expect(logs.length, `round ${i}`).to.equal(1);
        const gs = await engine.gameStreakState(gameId);
        expect(logs[0].args.threshold).to.equal(gs.threshold);
        expect(logs[0].args.round).to.equal(gs.round);
        await advanceRound();
      }
    });
  });
});
