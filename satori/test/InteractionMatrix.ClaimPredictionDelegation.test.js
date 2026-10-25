const { expect } = require("chai");
const { deploySatoriFixture, pack1, VOTE } = require("./fixtures");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

async function advanceToNextRound() {
  const now = await time.latest();
  const nextMidnight = Math.floor(now / 86400) * 86400 + 86400;
  await time.increaseTo(nextMidnight + 1);
}

async function streamIdFrom(tx, satori) {
  const r = await tx.wait();
  const ev = r.logs.find(l => {
    try { return satori.interface.parseLog(l)?.name === "DataStreamCreated"; }
    catch { return false; }
  });
  return Number(satori.interface.parseLog(ev).args.streamId);
}

describe("InteractionMatrix: Claim x Prediction Delegation", function () {
  let satori, voting, rewards, bounties, registry;
  let owner, alice, bob, carol;
  // Game id 1 is now the protocol's DEFAULT game (created by the fixture), so
  // the stream this test creates lands at id 2. Captured from the event rather
  // than hardcoded.
  let gid;

  beforeEach(async function () {
    [owner, alice, bob, carol] = await ethers.getSigners();

    const fix = await deploySatoriFixture();
    ;({ satori, voting, rewards, registry, bounties, owner } = fix);

    await satori.transfer(alice.address, ethers.parseEther("100"));
    await satori.transfer(bob.address, ethers.parseEther("100"));

    // Every-round (1440-minute) stream: this matrix is about how claim
    // delegation and prediction delegation interact, and the rounds below
    // just walk a predict/settle cycle.
    gid = await streamIdFrom(await satori.connect(owner)["createSimpleDataStream(string,address,uint24)"]("ETH/USD", owner.address, 1440), satori);
    await satori.connect(alice).vote(gid, VOTE);

    await advanceToNextRound();
    await registry.setValue(gid, 1000);

    // Alice delegates predictions to Bob, claim ability to Carol
    await satori.connect(alice).delegatePredictionPower(bob.address);
    await time.increase(86400);
    await registry.setValue(gid, 1000);
    await satori.connect(alice).delegateClaimAbility(carol.address);

    // Bob predicts across 3 rounds to generate scorable rewards
    await satori.connect(bob).predictMultipleWithPayloads([{ gameId: gid, payload: pack1(1) }]);

    await advanceToNextRound();
    await registry.setValue(gid, 1100);
    await satori.connect(bob).predictMultipleWithPayloads([{ gameId: gid, payload: pack1(1) }]);

    await advanceToNextRound();
    await registry.setValue(gid, 1200);
    await satori.connect(bob).predictMultipleWithPayloads([{ gameId: gid, payload: pack1(1) }]);

    await advanceToNextRound();
    await registry.setValue(gid, 1300);
  });

  it("alice cannot self-claim while claim-delegated", async function () {
    await expect(
      satori.connect(alice)["claim()"]()
    ).to.be.revertedWithCustomError(rewards, "ClaimDelegatedAway");
  });

  it("bob (non-delegate) cannot claimFor alice", async function () {
    await expect(
      satori.connect(bob)["claimFor(address,address)"](alice.address, bob.address)
    ).to.be.revertedWithCustomError(rewards, "Unauthorized");
  });

  it("carol (claim delegate) can claimFor alice and rewards are positive", async function () {
    const carolBefore = await satori.balanceOf(carol.address);

    await satori.connect(carol)["claimFor(address,address)"](alice.address, carol.address);

    const carolAfter = await satori.balanceOf(carol.address);
    expect(carolAfter - carolBefore).to.be.gt(0n);
  });

  it("alice's delegator rewards accrue correctly through claimFor", async function () {
    // Carol claims Alice's rewards to Alice's own address
    const aliceBefore = await satori.balanceOf(alice.address);

    await satori.connect(carol)["claimFor(address,address)"](alice.address, alice.address);

    const aliceAfter = await satori.balanceOf(alice.address);
    const aliceReward = aliceAfter - aliceBefore;
    expect(aliceReward).to.be.gt(0n);

    // Bob also has predictor rewards from his own power
    const bobBefore = await satori.balanceOf(bob.address);
    await satori.connect(bob)["claim()"]();
    const bobAfter = await satori.balanceOf(bob.address);
    const bobReward = bobAfter - bobBefore;
    expect(bobReward).to.be.gt(0n);
  });

  it("second claimFor yields zero (cursors advanced)", async function () {
    await satori.connect(carol)["claimFor(address,address)"](alice.address, carol.address);

    const carolBefore = await satori.balanceOf(carol.address);
    await satori.connect(carol)["claimFor(address,address)"](alice.address, carol.address);
    const carolAfter = await satori.balanceOf(carol.address);

    expect(carolAfter).to.equal(carolBefore);
  });

  it("alice can claim immediately after undelegating claim ability (no cooldown)", async function () {
    // Alice undelegates claim ability
    await satori.connect(alice).delegateClaimAbility(ethers.ZeroAddress);

    // Same-round claim succeeds.
    const aliceBefore = await satori.balanceOf(alice.address);
    await satori.connect(alice)["claim()"]();
    const aliceAfter = await satori.balanceOf(alice.address);
    expect(aliceAfter - aliceBefore).to.be.gt(0n);
  });
});
