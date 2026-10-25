// G13: the lens carries its own copy of the delegator claim walk
// (SatoriRewardsLens.pendingDelegatorRewards). It must agree with what
// SatoriRewards actually credits, including after the delegator's balance moves
// (checkpoints), a delegator who joins late, a round the delegate skips, and a
// claim in the middle of the walk.

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture, pack1, VOTE } = require("../fixtures");

async function nextRound() {
  const now = await time.latest();
  await time.increaseTo(Math.floor(now / 86400) * 86400 + 86400 + 1);
}

describe("Lens delegator claim walk matches SatoriRewards (G13)", function () {
  it("predicts the exact amount a delegator is paid, at every point of the walk", async function () {
    const fix = await deploySatoriFixture();
    const { satori, rewards, registry, lens, owner } = fix;
    const [, alice, bob, carol, voter] = fix.signers;

    await satori.transfer(alice.address, ethers.parseEther("100"));
    await satori.transfer(bob.address, ethers.parseEther("100"));
    await satori.transfer(carol.address, ethers.parseEther("60"));
    await satori.transfer(voter.address, ethers.parseEther("20"));

    const tx = await satori.connect(owner)["createSimpleDataStream(string,address,uint24)"]("ETH/USD", owner.address, 1440);
    const rcpt = await tx.wait();
    const gid = Number(satori.interface.parseLog(
      rcpt.logs.find((l) => { try { return satori.interface.parseLog(l)?.name === "DataStreamCreated"; } catch { return false; } })
    ).args.streamId);
    await satori.connect(voter).vote(gid, VOTE);

    let value = 1000;
    const step = async () => { value += 100; await registry.setValue(gid, value); };

    await nextRound();
    await step();
    await satori.connect(alice).delegatePredictionPower(bob.address);

    // R1: bob predicts. R2: alice's balance grows (a checkpoint) and carol joins.
    // R3: bob skips. R4: bob predicts again.
    await nextRound(); await step();
    await satori.connect(bob).predictMultipleWithPayloads([{ gameId: gid, payload: pack1(1) }]);

    await nextRound(); await step();
    await satori.connect(bob).predictMultipleWithPayloads([{ gameId: gid, payload: pack1(1) }]);
    await satori.connect(carol).delegatePredictionPower(bob.address);
    await satori.transfer(alice.address, ethers.parseEther("20"));

    await nextRound(); await step();
    await satori.settlePrediction(bob.address, gid);

    await nextRound(); await step();
    await satori.connect(bob).predictMultipleWithPayloads([{ gameId: gid, payload: pack1(1) }]);

    // Scoring reads the first two values after the prediction, so it needs two more samples.
    await nextRound(); await step();
    await nextRound(); await step();
    await satori.settlePrediction(bob.address, gid);

    const paid = async (who) => {
      const [predicted, complete] = await lens.getTotalClaimableRewards(who.address);
      const before = await satori.balanceOf(who.address);
      await satori.connect(who)["claim()"]();
      const minted = (await satori.balanceOf(who.address)) - before;
      return { predicted, complete, minted };
    };

    const a1 = await paid(alice);
    expect(a1.complete).to.equal(true);
    expect(a1.predicted).to.be.gt(0n);
    expect(a1.minted).to.equal(a1.predicted);

    const c1 = await paid(carol);
    expect(c1.complete).to.equal(true);
    expect(c1.predicted).to.be.gt(0n);
    expect(c1.minted).to.equal(c1.predicted);

    // Nothing is left to walk, and the lens agrees.
    expect((await lens.getTotalClaimableRewards(alice.address))[0]).to.equal(0n);

    // One more scored round after the claims: the walk resumes from the cursor.
    await nextRound(); await step();
    await satori.connect(bob).predictMultipleWithPayloads([{ gameId: gid, payload: pack1(1) }]);
    await nextRound(); await step();
    await nextRound(); await step();
    await satori.settlePrediction(bob.address, gid);
    await nextRound();

    const a2 = await paid(alice);
    expect(a2.predicted).to.be.gt(0n);
    expect(a2.minted).to.equal(a2.predicted);
  });
});
