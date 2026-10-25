// A daily game takes one prediction per round, with no clock-hour wait across the
// round boundary (M22 reverted by the owner, 2026-10-25). The cost, accepted: on a
// daily game over an hourly non-named stream that goes quiet, a third prediction
// displaces the older, unresolved one without scoring it.

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture, pack1 } = require("../fixtures");

const HOUR = 3600;
const DAY = 86400;

describe("A daily game takes one prediction per round", function () {
  this.timeout(300000);

  async function setup() {
    const fix = await loadFixture(deploySatoriFixture);
    const { satori, registry, games } = fix;
    const [, alice, provider] = fix.signers;
    await satori.transfer(alice.address, ethers.parseEther("60"));
    const tx = await satori["createSimpleDataStream(string,address,uint24)"]("HOURLY", provider.address, 60);
    const rcpt = await tx.wait();
    let sid;
    for (const log of rcpt.logs) {
      try {
        const p = registry.interface.parseLog(log);
        if (p && p.name === "DataStreamCreated") sid = p.args.streamId;
      } catch {}
    }
    const gid = await games.binaryGameByStream(sid);
    const engine = await ethers.getContractAt("SatoriEngine", await satori.engine());
    const midnight = Math.floor((await time.latest()) / DAY) * DAY + 2 * DAY;
    return { ...fix, alice, provider, sid, gid, engine, midnight };
  }

  async function write(registry, provider, sid, at, value) {
    await time.increaseTo(at);
    await registry.connect(provider).setValue(sid, value);
  }

  const predict = (satori, alice, gid) =>
    satori.connect(alice).predictMultipleWithPayloads([{ gameId: gid, payload: pack1(1) }]);

  it("a 23:00 then 00:30 pair on a daily game is allowed", async function () {
    const { satori, registry, alice, provider, sid, gid, midnight } = await setup();

    await write(registry, provider, sid, midnight + 23 * HOUR + 5, 100);
    await predict(satori, alice, gid);

    await write(registry, provider, sid, midnight + DAY + 30 * 60, 101);
    await expect(predict(satori, alice, gid)).to.not.be.reverted;
  });

  it("a second prediction in the same round is refused", async function () {
    const { satori, registry, engine, alice, provider, sid, gid, midnight } = await setup();

    await write(registry, provider, sid, midnight + 1 * HOUR + 5, 100);
    await predict(satori, alice, gid);

    await write(registry, provider, sid, midnight + 5 * HOUR + 5, 101);
    await expect(predict(satori, alice, gid)).to.be.revertedWithCustomError(engine, "AlreadyPredicted");
  });

  it("accepted cost: a quiet hourly stream lets a third prediction displace an unresolved one", async function () {
    const { satori, registry, engine, alice, provider, sid, gid, midnight } = await setup();

    await write(registry, provider, sid, midnight + 23 * HOUR + 5, 100);   // A at R:23
    await predict(satori, alice, gid);
    await write(registry, provider, sid, midnight + DAY + 5, 101);         // B at R+1:00
    await predict(satori, alice, gid);
    await write(registry, provider, sid, midnight + DAY + 2 * HOUR + 5, 102);

    // No write at or after A's hour + 24; the third prediction lands at R+2:00.
    await time.increaseTo(midnight + 2 * DAY + 10);
    await expect(predict(satori, alice, gid)).to.emit(engine, "PredictionDisplaced");
  });
});
