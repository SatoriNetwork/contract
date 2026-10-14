// Regression tests for the predict-time totals refactor. The finality gate
// is gone — `totalWeightByDirection` is written at predict time, so every
// claim reads a final denominator. Conservation is structural.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture, RAW_TOLERANCE, pack1, voteFor, onChainGrossNow } = require("./fixtures");

const UP = 1;
// The stream is created by a public (non-admin) caller at 2880 minutes (two
// 24h rounds), so ONE "day" step below is exactly one cadence period, and
// scoring is the AB window: anchor = the value AT the predict round, post = the
// FIRST value written after it. (A 1440-minute stream would score ABC — not
// this file's point.)
const ROUND = 86400;
const CADENCE_ROUNDS = 2;
async function advanceOneDay() { await time.increase(ROUND * CADENCE_ROUNDS); }

async function createStream(satori, signer, name, authority) {
  const fee = await satori.streamBurn();
  if ((await satori.balanceOf(signer.address)) < fee) {
    await satori.transfer(signer.address, fee);
  }
  const tx = await satori.connect(signer)["createSimpleDataStream(string,address,uint24)"](name, authority, 2880);
  const rcpt = await tx.wait();
  for (const log of rcpt.logs) {
    try {
      const p = satori.interface.parseLog(log);
      if (p && p.name === "DataStreamCreated") return p.args.streamId;
    } catch (e) {}
  }
  throw new Error("DataStreamCreated event missing");
}

describe("SATORI predict-time totals (gate-free conservation)", function () {
  let satori, voting, rewards, registry, owner, alice, bob, authority, lens;
  let stream;
  // The on-chain round pool, read from the chain (was the 1440 − 288 literal).
  let GROSS;

  beforeEach(async function () {
    const fix = await loadFixture(deploySatoriFixture);
    ({ satori, voting, rewards, lens, registry, owner } = fix);
    [, alice, bob, authority] = fix.signers;
    GROSS = await onChainGrossNow(satori);
    await satori.transfer(alice.address, ethers.parseEther("100"));
    await satori.transfer(bob.address, ethers.parseEther("100"));
    await satori.transfer(authority.address, ethers.parseEther("100"));
    stream = await createStream(satori, authority, "stream", authority.address);
    // Burn so the stream carries weight (and therefore earns).
    await voteFor(satori, owner, stream);
  });

  it("late claimer is NOT short-changed even without a finality gate", async function () {
    // Old trace: Alice scores first and claims; Bob scores later. Without a
    // gate, the OLD design over-minted (Alice took the whole streamAllocation,
    // Bob got a fractional share, sum > allocation). With predict-time totals
    // the denominator is already final at claim time, so both shares are
    // proportional and sum to streamAllocation.
    await registry.connect(authority).setValue(stream, 100);
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream, payload: pack1(UP) }]);
    await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream, payload: pack1(UP) }]);

    // One post-anchor value resolves the AB window: 110 > the anchor 100.
    await advanceOneDay();
    await registry.connect(authority).setValue(stream, 110);

    // Alice scored first; Bob still pending.
    await satori.settlePrediction(alice.address, stream);

    const aliceBefore = await satori.balanceOf(alice.address);
    // Alice claims while Bob is still pending. Under predict-time totals,
    // Alice's share is correctly proportional (no inflated streamAllocation).
    await satori.connect(alice).claim();
    const aliceFirst = (await satori.balanceOf(alice.address)) - aliceBefore;
    expect(aliceFirst).to.be.gt(0);

    // Now Bob scores and claims.
    await satori.settlePrediction(bob.address, stream);
    const bobBefore = await satori.balanceOf(bob.address);
    await satori.connect(bob).claim();
    const bobFirst = (await satori.balanceOf(bob.address)) - bobBefore;
    expect(bobFirst).to.be.gt(0);

    // Conservation: alice + bob fit within the round's payable gross
    // (1440 budget − 288 senior dev fee = 1152). No "Budget" revert, no
    // over-mint.
    const total = aliceFirst + bobFirst;
    expect(total).to.be.lte(GROSS);
    // Equal weights (both have 100 SATORI, both predicted correctly with
    // streak=1 → multiplier=1) → IDENTICAL payouts. The first-predictor
    // liveness bonus is gone, so there is no longer any premium for being the
    // round's first predictor: the two shares are exactly equal.
    const diff = aliceFirst > bobFirst ? aliceFirst - bobFirst : bobFirst - aliceFirst;
    expect(diff).to.equal(0n);
  });

  it("single-predictor case still works (sanity)", async function () {
    await registry.connect(authority).setValue(stream, 100);
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream, payload: pack1(UP) }]);
    await advanceOneDay();
    await registry.connect(authority).setValue(stream, 110); // post > anchor -> correct
    await satori.settlePrediction(alice.address, stream);
    const before = await satori.balanceOf(alice.address);
    await satori.connect(alice).claim();
    const after = await satori.balanceOf(alice.address);
    expect(after - before).to.be.gt(0);
  });

  it("totalWeightByDirection is final by predict-deadline (writes at predict time)", async function () {
    // Both predictions in the same round. After the second predict() the
    // direction's totalWeight should already be the sum.
    await registry.connect(authority).setValue(stream, 100);
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream, payload: pack1(UP) }]);
    const round = await satori.getCurrentRound();
    const t1 = await lens.totalWeightByDirection(stream, round, UP);
    await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream, payload: pack1(UP) }]);
    const t2 = await lens.totalWeightByDirection(stream, round, UP);
    expect(t1).to.be.gt(0);
    expect(t2).to.be.closeTo(t1 + (await lens.userWeightByDirection(bob.address, stream, round, UP)), RAW_TOLERANCE);
  });
});
