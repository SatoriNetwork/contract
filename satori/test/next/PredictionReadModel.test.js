const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture, pack1 } = require("../fixtures");

// M31 — a reader rebuilds the pools and the Sentiment counter from the log:
// `PredictionMade` carries the multiplier and the weight, Rewards announces the
// pool after every write, and the engine announces the Sentiment counter after
// every flow change.

const E = (n) => ethers.parseEther(String(n));
const UP = 1;
const DOWN = 2;
const HALF = (1n << 128n) - 1n;

function find(rcpt, iface, name) {
  for (const l of rcpt.logs) {
    try {
      const p = iface.parseLog(l);
      if (p && p.name === name) return p;
    } catch { /* not this interface */ }
  }
  return null;
}

describe("Prediction read model (M31)", function () {
  this.timeout(600000);

  async function setup() {
    const fix = await loadFixture(deploySatoriFixture);
    const { satori, rewards } = fix;
    const [, alice, bob] = fix.signers;
    const engine = await ethers.getContractAt("SatoriEngine", await satori.engine());
    for (const u of [alice, bob]) await satori.transfer(u.address, E(100));
    return { ...fix, alice, bob, engine, rewards };
  }

  async function predict(satori, who, gameId, dir) {
    const tx = await satori.connect(who).predictMultipleWithPayloads([{ gameId, payload: pack1(dir) }]);
    return { tx, rcpt: await tx.wait() };
  }

  it("PredictionMade ends with the multiplier and the weight added to the pool", async function () {
    const { satori, engine, rewards, alice } = await setup();
    const { rcpt } = await predict(satori, alice, 1, UP);
    const made = find(rcpt, engine.interface, "PredictionMade");
    expect(made, "PredictionMade").to.not.equal(null);
    const { round, multiplier, weight, predictionPower } = made.args;
    expect(multiplier).to.be.gt(0n);
    expect(weight).to.be.gt(0n);
    // The weight is the pool's UP side after this first prediction.
    const packed = await rewards.totalWeightPacked(1, round);
    expect(packed >> 128n).to.equal(weight);
    expect(packed & HALF).to.equal(0n);
    expect(weight).to.be.lte(predictionPower * multiplier);
  });

  it("Rewards announces the pool after each write, both sides", async function () {
    const { satori, rewards, alice, bob } = await setup();
    const first = await predict(satori, alice, 1, UP);
    const ev1 = find(first.rcpt, rewards.interface, "GameRoundWeight");
    expect(ev1, "GameRoundWeight").to.not.equal(null);
    const round = ev1.args.round;
    const packed1 = await rewards.totalWeightPacked(1, round);
    expect(ev1.args.gameId).to.equal(1n);
    expect(ev1.args.up).to.equal(packed1 >> 128n);
    expect(ev1.args.down).to.equal(packed1 & HALF);

    const second = await predict(satori, bob, 1, DOWN);
    const ev2 = find(second.rcpt, rewards.interface, "GameRoundWeight");
    const packed2 = await rewards.totalWeightPacked(1, round);
    expect(ev2.args.up).to.equal(packed2 >> 128n);
    expect(ev2.args.up).to.equal(ev1.args.up);
    expect(ev2.args.down).to.equal(packed2 & HALF);
    expect(ev2.args.down).to.be.gt(0n);
  });

  it("NamedCounterMoved carries the counter after each Sentiment flow change", async function () {
    const { satori, engine, alice, bob } = await setup();
    const first = await predict(satori, alice, 1, UP);
    const c1 = await engine.namedStreamValue(1);
    expect(c1).to.be.gt(0n);
    expect(find(first.rcpt, engine.interface, "NamedCounterMoved").args.value).to.equal(c1);

    const second = await predict(satori, bob, 1, DOWN);
    const c2 = await engine.namedStreamValue(1);
    expect(c2).to.be.lt(c1);
    const ev = find(second.rcpt, engine.interface, "NamedCounterMoved");
    expect(ev.args.gameId).to.equal(1n);
    expect(ev.args.value).to.equal(c2);
  });
});
