// M20 — a prediction is refused when its stream's due pull did not land.
//
// A failed pull used to be skipped silently, so the first prediction on a game
// anchored on whatever value was last stored, however old. `updateValuesStrict`
// reports the first stream whose pull was due and whose read failed, and the
// engine reverts the batch naming it, whatever made the read fail.

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture, createChainlinkStream, pack1 } = require("../fixtures");

const HOUR = 3600;
const SIMPLE3 = "createSimpleDataStream(string,address,uint24)";

describe("A due pull that fails refuses the prediction (M20)", function () {
  this.timeout(300000);

  async function setup() {
    const fix = await loadFixture(deploySatoriFixture);
    const { satori, registry, games, owner } = fix;
    const [, alice, provider] = fix.signers;
    await satori.transfer(alice.address, ethers.parseEther("60"));
    const engine = await ethers.getContractAt("SatoriEngine", await satori.engine());

    const feed = await (await ethers.getContractFactory("MockChainlinkAggregator")).deploy();
    await feed.setAnswer(1000n);
    const burner = await (await ethers.getContractFactory("ToggleBurnAggregator")).deploy();

    async function chainlinkStream(name, target, maxFeedAge = 3600) {
      const sid = await registry.nextStreamId();
      await (await createChainlinkStream(satori.connect(owner), name, target, null, 60, maxFeedAge)).wait();
      await registry.updateValue(sid); // first value
      return { sid, gid: await games.binaryGameByStream(sid) };
    }
    const predict = (gid, opts = {}) =>
      satori.connect(alice).predictMultipleWithPayloads([{ gameId: gid, payload: pack1(1) }], opts);
    return { ...fix, alice, provider, engine, feed, burner, chainlinkStream, predict };
  }

  it("refuses when the read fails on a due pull, naming the stream, and accepts once the feed is live again", async function () {
    const { engine, feed, chainlinkStream, predict } = await setup();
    const { sid, gid } = await chainlinkStream("ETH", await feed.getAddress());

    await time.increase(2 * HOUR); // due, and the feed is older than maxFeedAge
    await expect(predict(gid)).to.be.revertedWithCustomError(engine, "StreamPullFailed").withArgs(sid);

    await feed.setAnswer(1001n); // the pull can land now
    await expect(predict(gid)).to.not.be.reverted;
  });

  it("does not touch a stream that is not due, even if its feed went stale inside the cadence", async function () {
    const { feed, chainlinkStream, predict } = await setup();
    const { gid } = await chainlinkStream("ETH", await feed.getAddress(), 60);
    await time.increase(10 * 60); // stale (60 s) but the 60-minute cadence has not elapsed
    await expect(predict(gid)).to.not.be.reverted;
  });

  it("leaves Simple and Sentiment streams alone", async function () {
    const { satori, registry, games, owner, provider, predict } = await setup();

    // Simple: not a pull stream.
    const simple = await registry.nextStreamId();
    await (await satori.connect(owner)[SIMPLE3]("S", provider.address, 60)).wait();
    const now = await time.latest();
    await time.increaseTo(Math.floor(now / HOUR) * HOUR + HOUR + 5);
    await registry.connect(provider).setValue(simple, 100);
    await expect(predict(await games.binaryGameByStream(simple))).to.not.be.reverted;

    // Sentiment: the default stream, pulled from the engine's own counter.
    await time.increase(25 * HOUR);
    await expect(predict(1)).to.not.be.reverted;
  });

  it("refuses a read that runs out of gas, too", async function () {
    const { engine, burner, chainlinkStream, predict } = await setup();
    const { sid, gid } = await chainlinkStream("BURN", await burner.getAddress());

    await burner.setBurn(true);
    await time.increase(2 * HOUR);
    await expect(predict(gid, { gasLimit: 3_000_000 }))
      .to.be.revertedWithCustomError(engine, "StreamPullFailed").withArgs(sid);

    await burner.setBurn(false); // same stream, same due pull: it lands, so the cause really was the burn
    await expect(predict(gid)).to.not.be.reverted;
  });

  it("plain updateValues stays best-effort: a failed due pull is skipped, not reverted", async function () {
    const { registry, feed, owner, chainlinkStream } = await setup();
    const { sid } = await chainlinkStream("ETH", await feed.getAddress());
    await time.increase(2 * HOUR);
    const tx = await registry.updateValues([sid]);
    await expect(tx).to.emit(registry, "StreamValuesBatchUpdated").withArgs(owner.address, 1, 0);
    await expect(tx).to.not.emit(registry, "StreamValueUpdated");
  });
});
