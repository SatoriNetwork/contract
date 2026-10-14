const { expect } = require("chai");
const { deploySatoriFixture, pack1, VOTE } = require("./fixtures");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

async function getStreamIdFromTx(tx, satoriContract) {
  const receipt = await tx.wait();
  const event = receipt.logs.find(log => {
    try {
      const parsed = satoriContract.interface.parseLog(log);
      return parsed && parsed.name === 'DataStreamCreated';
    } catch {
      return false;
    }
  });
  if (!event) throw new Error("DataStreamCreated event not found");
  const parsed = satoriContract.interface.parseLog(event);
  return parsed.args.streamId;
}

async function advanceToNextRound() {
  await time.increase(86400);
}

describe("ClaimableBreakdown Accuracy", function () {
  let owner, alice, bob;
  let satori, rewards, bounties, registry, lens;
  let streamId;
  const UP = 1;

  beforeEach(async function () {
    const fix = await deploySatoriFixture();
    satori = fix.satori;
    rewards = fix.rewards;
    lens = fix.lens;
    registry = fix.registry;
    owner = fix.owner;
    [, alice, bob] = fix.signers;

    await satori.transfer(alice.address, ethers.parseEther("400"));
    await satori.transfer(bob.address, ethers.parseEther("200"));

    // Every-round (1440-minute) stream — the streak-building loop below writes
    // a value every 24h round.
    const tx = await satori["createSimpleDataStream(string,address,uint24)"]("Stream 1", owner.address, 1440);
    streamId = await getStreamIdFromTx(tx, satori);
  });

  /**
   * Build streaks to get rewards scored for the test round.
   * Uses the same pattern as TopThirdFilter.test.js.
   * roundUsers: array of user arrays, one per prediction round.
   * Returns the test round number.
   */
  async function buildStreaks(roundUsers) {
    const N = roundUsers.length;

    // Initial price and a single burn to make the stream eligible. Burnt weight
    // is permanent, so the per-round re-votes this loop used to make are gone.
    await registry.setValue(streamId, 1000);
    await satori.connect(alice).vote(streamId, VOTE);
    await advanceToNextRound();

    let price = 1050;
    const roundNumbers = [];

    for (let r = 0; r < N; r++) {
      await registry.setValue(streamId, price);

      const roundNum = await satori.getCurrentRound();
      roundNumbers.push(roundNum);

      for (const u of roundUsers[r]) {
        await satori.connect(u).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(UP) }]);
      }

      await advanceToNextRound();
      price += 50;
    }

    // N+1 extra trigger rounds to score all predictions
    const lastUsers = roundUsers[N - 1];
    for (let t = 0; t < N + 1; t++) {
      await registry.setValue(streamId, price);
      for (const u of lastUsers) {
        await satori.connect(u).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(UP) }]);
      }
      await advanceToNextRound();
      price += 50;
    }

    return roundNumbers[N - 1];
  }

  it("getClaimableBreakdown total should match actual tokens minted (single predictor)", async function () {
    this.timeout(60000);

    // Single user: gross == actual (no eligibleWeight change after scoring)
    await buildStreaks([[alice]]);

    // Rewards are computed at claim time — use getTotalClaimableRewards for pre-claim check
    const totalClaimable = (await lens.getTotalClaimableRewards(alice.address))[0];

    expect(totalClaimable).to.be.gt(0n, "Alice should have rewards");

    const balanceBefore = await satori.balanceOf(alice.address);
    await satori.connect(alice)['claim()']();
    const balanceAfter = await satori.balanceOf(alice.address);
    const actualMinted = balanceAfter - balanceBefore;

    const diff = totalClaimable > actualMinted
      ? totalClaimable - actualMinted
      : actualMinted - totalClaimable;
    expect(diff).to.be.lte(1n,
      `getTotalClaimableRewards ${totalClaimable} should match actual minted ${actualMinted}`);
  });

  it("getClaimableBreakdown total should match actual tokens minted (two predictors, eligibleWeight shifts)", async function () {
    this.timeout(60000);

    // Two predictors in same round: rewards computed at claim time using final totalWeight
    await buildStreaks([[alice, bob]]);

    // Check alice — use getTotalClaimableRewards since rewards are computed at claim time
    const totalClaimableA = (await lens.getTotalClaimableRewards(alice.address))[0];

    expect(totalClaimableA).to.be.gt(0n, "Alice should have rewards");

    const aliceBefore = await satori.balanceOf(alice.address);
    await satori.connect(alice)['claim()']();
    const aliceAfter = await satori.balanceOf(alice.address);
    const aliceMinted = aliceAfter - aliceBefore;

    const diffA = totalClaimableA > aliceMinted
      ? totalClaimableA - aliceMinted
      : aliceMinted - totalClaimableA;
    expect(diffA).to.be.lte(1n,
      `Alice: getTotalClaimableRewards ${totalClaimableA} should match actual minted ${aliceMinted}`);

    // Check bob
    const totalClaimableB = (await lens.getTotalClaimableRewards(bob.address))[0];

    expect(totalClaimableB).to.be.gt(0n, "Bob should have rewards");

    const bobBefore = await satori.balanceOf(bob.address);
    await satori.connect(bob)['claim()']();
    const bobAfter = await satori.balanceOf(bob.address);
    const bobMinted = bobAfter - bobBefore;

    const diffB = totalClaimableB > bobMinted
      ? totalClaimableB - bobMinted
      : bobMinted - totalClaimableB;
    expect(diffB).to.be.lte(1n,
      `Bob: getTotalClaimableRewards ${totalClaimableB} should match actual minted ${bobMinted}`);
  });
});
