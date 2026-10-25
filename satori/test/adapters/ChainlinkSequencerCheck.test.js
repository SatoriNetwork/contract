// ChainlinkV3Adapter — Base sequencer-uptime check (sweep G02).
//
// After a sequencer outage the feed's last answer can still be younger than
// maxFeedAge, so the age check alone would store a pre-outage price as current.
// With an uptime feed wired, reads revert while the sequencer is down and for a
// grace period after it restarts. Zero feed address (L1, local) keeps the old behaviour.

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const HOUR = 3600;
const MAX_AGE = 26 * HOUR;
const config = ethers.AbiCoder.defaultAbiCoder().encode(["uint64"], [MAX_AGE]);

async function setup(withUptimeFeed = true) {
  const Mock = await ethers.getContractFactory("MockChainlinkAggregator");
  const price = await Mock.deploy();
  const uptime = await Mock.deploy();
  const Adapter = await ethers.getContractFactory("ChainlinkV3Adapter");
  const adapter = await Adapter.deploy(withUptimeFeed ? await uptime.getAddress() : ethers.ZeroAddress);
  await price.setAnswer(3000n);
  return { adapter, price, uptime };
}

async function sequencerUpSince(uptime, startedAt) {
  await uptime.setRoundData(1, 0, startedAt, startedAt, 1);
}

async function sequencerDown(uptime) {
  const now = await time.latest();
  await uptime.setRoundData(2, 1, now, now, 2);
}

describe("ChainlinkV3Adapter — sequencer uptime (G02)", function () {
  it("reads normally once the sequencer has been up longer than the grace period", async function () {
    const { adapter, price, uptime } = await setup();
    await sequencerUpSince(uptime, (await time.latest()) - 2 * HOUR);
    expect(await adapter.readValue(await price.getAddress(), config)).to.equal(3000n);
  });

  it("reverts while the sequencer reports down", async function () {
    const { adapter, price, uptime } = await setup();
    await sequencerDown(uptime);
    await expect(adapter.readValue(await price.getAddress(), config))
      .to.be.revertedWithCustomError(adapter, "SequencerDown");
  });

  it("reverts inside the grace period after a restart, even though the price is fresh", async function () {
    const { adapter, price, uptime } = await setup();
    await sequencerDown(uptime);
    const restart = (await time.latest()) + 10;
    await time.setNextBlockTimestamp(restart);
    await uptime.setRoundData(3, 0, restart, restart, 3);
    await expect(adapter.readValue(await price.getAddress(), config))
      .to.be.revertedWithCustomError(adapter, "SequencerGracePeriod");
  });

  it("reads again once the grace period has passed", async function () {
    const { adapter, price, uptime } = await setup();
    const restart = await time.latest();
    await uptime.setRoundData(3, 0, restart, restart, 3);
    await time.increase(HOUR + 1);
    await price.setAnswer(3100n);
    expect(await adapter.readValue(await price.getAddress(), config)).to.equal(3100n);
  });

  it("treats an unstarted uptime round as down for reading", async function () {
    const { adapter, price, uptime } = await setup();
    await uptime.setRoundData(0, 0, 0, 0, 0);
    await expect(adapter.readValue(await price.getAddress(), config))
      .to.be.revertedWithCustomError(adapter, "SequencerGracePeriod");
  });

  it("with no uptime feed (L1, local) behaves as before", async function () {
    const { adapter, price } = await setup(false);
    expect(await adapter.SEQUENCER_UPTIME_FEED()).to.equal(ethers.ZeroAddress);
    expect(await adapter.readValue(await price.getAddress(), config)).to.equal(3000n);
  });

  it("exposes the feed and the grace period", async function () {
    const { adapter, uptime } = await setup();
    expect(await adapter.SEQUENCER_UPTIME_FEED()).to.equal(await uptime.getAddress());
    expect(await adapter.SEQUENCER_GRACE_PERIOD()).to.equal(HOUR);
  });
});
