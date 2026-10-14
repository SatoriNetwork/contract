/**
 * EligibleOnlyPowerSplit.test.js
 *
 * Prediction power is split across ELIGIBLE streams only. Predicting on an
 * ineligible stream costs nothing — it's recorded with 0 power (weightless),
 * and the power that would have gone to it stays concentrated on the eligible
 * picks. So a batch of 2 eligible + 2 ineligible gives each eligible stream
 * HALF your power (not a quarter), and the ineligibles get zero.
 */

const { expect } = require("chai");
const { deploySatoriFixture, RAW_TOLERANCE, pack1, VOTE } = require("./fixtures");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const UP = 1;

async function streamIdFromTx(tx, satori) {
  const r = await tx.wait();
  for (const log of r.logs) {
    try {
      const p = satori.interface.parseLog(log);
      if (p && p.name === 'DataStreamCreated') return p.args.streamId;
    } catch { /* not this log */ }
  }
  throw new Error("DataStreamCreated not found");
}

async function advanceRound() {
  const t = await time.latest();
  await time.increaseTo(Math.floor(t / 86400) * 86400 + 86400 + 1);
}

describe("Power splits across eligible streams only", function () {
  let satori, voting, registry, rewards;
  let owner, alice, bob, carol;
  let streams; // 4 streams; [0],[1] eligible, [2],[3] ineligible

  beforeEach(async function () {
    [owner, alice, bob, carol] = await ethers.getSigners();

    const fix = await deploySatoriFixture();
    ({ satori, voting, rewards, registry } = fix);
    // The fixture initializes the default stream itself now (game id 1).

    streams = [];
    for (let i = 0; i < 4; i++) {
      streams.push(await streamIdFromTx(await satori.createSimpleDataStream(`S${i}`, owner.address), satori));
    }

    await satori.transfer(alice.address, ethers.parseEther("100"));
    await satori.transfer(bob.address, ethers.parseEther("100"));
    await satori.transfer(carol.address, ethers.parseEther("100"));

    // Make ONLY streams[0] and streams[1] eligible; [2],[3] stay unvoted, so
    // they carry zero burned weight. Eligibility is now exactly "weight > 0" —
    // no threshold and no top-N — so an unvoted game is the ineligible case.
    await satori.connect(bob).vote(streams[0], VOTE);
    await satori.connect(carol).vote(streams[1], VOTE);

    await advanceRound();
    for (let i = 0; i < 4; i++) await registry.setValue(streams[i], 100 + i);
  });

  const rawPower = async (id, round) =>
    (await satori.predictions(alice.address, id, round)).rawPredictionPower;

  it("2 eligible + 2 ineligible: each eligible gets HALF, ineligibles get 0", async function () {
    const total = await rewards.getPredictionPower(alice.address);
    const round = await satori.getCurrentRound();

    await satori.connect(alice).predictMultipleWithPayloads(
      streams.map(id => ({ gameId: id, payload: pack1(UP) }))
    );

    // Eligible streams share the full power between just the two of them.
    expect(await rawPower(streams[0], round)).to.be.closeTo(total / 2n, RAW_TOLERANCE);
    expect(await rawPower(streams[1], round)).to.be.closeTo(total / 2n, RAW_TOLERANCE);
    // Ineligible streams: recorded but weightless.
    expect(await rawPower(streams[2], round)).to.equal(0n);
    expect(await rawPower(streams[3], round)).to.equal(0n);
  });

  it("one eligible + one ineligible: the eligible one gets the FULL power", async function () {
    const total = await rewards.getPredictionPower(alice.address);
    const round = await satori.getCurrentRound();

    await satori.connect(alice).predictMultipleWithPayloads([
      { gameId: streams[0], payload: pack1(UP) }, // eligible
      { gameId: streams[2], payload: pack1(UP) }, // ineligible
    ]);

    expect(await rawPower(streams[0], round)).to.be.closeTo(total, RAW_TOLERANCE);
    expect(await rawPower(streams[2], round)).to.equal(0n);
  });

  it("eligible power across the batch is conserved (≈ total, dust only)", async function () {
    const total = await rewards.getPredictionPower(alice.address);
    const round = await satori.getCurrentRound();

    await satori.connect(alice).predictMultipleWithPayloads(
      streams.map(id => ({ gameId: id, payload: pack1(UP) }))
    );

    const sum = (await rawPower(streams[0], round)) + (await rawPower(streams[1], round));
    const dust = total - sum;
    expect(dust).to.be.gte(0n);
    expect(dust).to.be.lt(2n * (1n << 40n) + 1n); // 2 eligible streams' quantization + division residual
  });

  it("all-ineligible batch is a harmless no-op (0 power, no revert)", async function () {
    const round = await satori.getCurrentRound();
    await expect(satori.connect(alice).predictMultipleWithPayloads([
      { gameId: streams[2], payload: pack1(UP) },
      { gameId: streams[3], payload: pack1(UP) },
    ])).to.not.be.reverted;
    expect(await rawPower(streams[2], round)).to.equal(0n);
    expect(await rawPower(streams[3], round)).to.equal(0n);
  });
});
