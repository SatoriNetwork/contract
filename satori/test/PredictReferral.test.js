const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture, pack1, voteFor } = require("./fixtures");

const ROUND = 86400;
const UP = 1;
const DOWN = 2;

async function getStreamIdFromTx(tx, satori) {
  const r = await tx.wait();
  for (const log of r.logs) {
    try {
      const p = satori.interface.parseLog(log);
      if (p && p.name === "DataStreamCreated") return Number(p.args.streamId);
    } catch {}
  }
  throw new Error("DataStreamCreated event missing");
}

async function advanceToNextRound() {
  const now = await time.latest();
  const nextBoundary = Math.floor(now / ROUND) * ROUND + ROUND;
  await time.increaseTo(nextBoundary + 1);
}

describe("predictMultipleWithReferral", function () {
  let satori, voting, rewards, registry, games, bounties;
  let owner, user, refA, refB;
  let stream1, stream2, stream3;

  beforeEach(async function () {
    const fix = await deploySatoriFixture();
    ({ satori, voting, rewards, registry, games, bounties, owner } = fix);
    [, user, refA, refB] = fix.signers;

    // Three type-0 binary streams (each auto-creates its paired binary game).
    stream1 = await getStreamIdFromTx(
      await satori.createSimpleDataStream("S1", owner.address), satori
    );
    stream2 = await getStreamIdFromTx(
      await satori.createSimpleDataStream("S2", owner.address), satori
    );
    stream3 = await getStreamIdFromTx(
      await satori.createSimpleDataStream("S3", owner.address), satori
    );

    // Fund the predicting user and vote streams eligible.
    const initialMint = await satori.INITIAL_MINT();
    const perActor = initialMint / 8n;
    await satori.transfer(user.address, perActor);

    const sigs = await ethers.getSigners();
    for (let i = 4; i <= 7; i++) {
      await satori.transfer(sigs[i].address, perActor);
    }
    await voteFor(satori, sigs[4], stream1);
    await voteFor(satori, sigs[5], stream2);
    await voteFor(satori, sigs[6], stream3);

    await advanceToNextRound();

    // Set fresh values so the round-aligned predict window matches.
    await registry.setValue(stream1, 100);
    await registry.setValue(stream2, 200);
    await registry.setValue(stream3, 300);
  });

  function buildRequests() {
    return [
      { gameId: stream1, payload: pack1(UP) },
      { gameId: stream2, payload: pack1(DOWN) },
      { gameId: stream3, payload: pack1(UP) },
    ];
  }

  it("fresh user: sets referral, records prediction, emits ReferralSet", async function () {
    const round = await satori.getCurrentRound();

    await expect(
      satori.connect(user).predictMultipleWithReferral(refA.address, buildRequests())
    )
      .to.emit(rewards, "ReferralSet")
      .withArgs(user.address, refA.address);

    // Referral pointer stored.
    expect(await rewards.referral(user.address)).to.equal(refA.address);

    // Prediction recorded.
    const p1 = await satori.predictions(user.address, stream1, round);
    const p2 = await satori.predictions(user.address, stream2, round);
    const p3 = await satori.predictions(user.address, stream3, round);
    expect(p1.direction).to.equal(UP);
    expect(p2.direction).to.equal(DOWN);
    expect(p3.direction).to.equal(UP);
  });

  it("already-set: keeps existing referral, does not revert, records prediction", async function () {
    // User registers refA directly first.
    await rewards.connect(user).setReferral(refA.address);
    expect(await rewards.referral(user.address)).to.equal(refA.address);

    const round = await satori.getCurrentRound();

    // Now predict with a DIFFERENT referrer — must not revert and must not
    // overwrite the existing referral.
    await expect(
      satori.connect(user).predictMultipleWithReferral(refB.address, buildRequests())
    ).to.not.be.reverted;

    expect(await rewards.referral(user.address)).to.equal(refA.address);

    const p1 = await satori.predictions(user.address, stream1, round);
    expect(p1.direction).to.equal(UP);
  });

  it("zero referrer: no-op referral, does not revert, records prediction", async function () {
    const round = await satori.getCurrentRound();

    await expect(
      satori.connect(user).predictMultipleWithReferral(ethers.ZeroAddress, buildRequests())
    ).to.not.be.reverted;

    expect(await rewards.referral(user.address)).to.equal(ethers.ZeroAddress);

    const p2 = await satori.predictions(user.address, stream2, round);
    expect(p2.direction).to.equal(DOWN);
  });

  it("self referrer: no self-ref stored, does not revert, records prediction", async function () {
    const round = await satori.getCurrentRound();

    await expect(
      satori.connect(user).predictMultipleWithReferral(user.address, buildRequests())
    ).to.not.be.reverted;

    expect(await rewards.referral(user.address)).to.equal(ethers.ZeroAddress);

    const p3 = await satori.predictions(user.address, stream3, round);
    expect(p3.direction).to.equal(UP);
  });

  it("setReferralFor is onlyCore: a direct non-core call reverts", async function () {
    await expect(
      rewards.connect(refA).setReferralFor(user.address, refB.address)
    ).to.be.revertedWithCustomError(rewards, "Unauthorized");
  });
});
