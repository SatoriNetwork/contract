const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { anyValue: anyRound } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");
const { deploySatoriFixtureNoFee, pack1, VOTE } = require("../fixtures");
const { rewardsSigner, advanceRound } = require("./emissionHelpers");

// G10 — an on-chain claim larger than the lane's headroom pays the headroom and
// leaves the rest in `unclaimedRewards`, like the merkle lane does, instead of
// reverting and locking the largest balances out first.
//
// The shortfall is made by minting through the rewards address (the hub accepts
// that caller) until less than one player's bucket is left, which moves
// `onChainMinted` without touching anyone's credit.

const UP = 1;
const SIMPLE3 = "createSimpleDataStream(string,address,uint24)";
const E = (n) => ethers.parseEther(String(n));

async function streamIdFrom(tx, satori) {
  const r = await tx.wait();
  const ev = r.logs.find((l) => {
    try { return satori.interface.parseLog(l)?.name === "DataStreamCreated"; }
    catch { return false; }
  });
  return satori.interface.parseLog(ev).args.streamId;
}

describe("Partial pay for on-chain claims (G10)", function () {
  this.timeout(600000);
  let fix, satori, hub, token, rewards, registry, owner, alice, bob, voter, sink;
  let gameA, base;

  beforeEach(async function () {
    fix = await loadFixture(deploySatoriFixtureNoFee);
    ({ satori, hub, token, rewards, registry, owner } = fix);
    [, alice, bob, voter, sink] = fix.signers;
    for (const p of [alice, bob]) await satori.transfer(p.address, E(100));
    await satori.transfer(voter.address, E(50));
    gameA = await streamIdFrom(await satori[SIMPLE3]("A", owner.address, 1440), satori);
    await satori.connect(voter).vote(gameA, VOTE);
    await advanceRound();
    base = 1000;
  });

  async function winningCycle() {
    await advanceRound();
    await registry.setValue(gameA, base);
    for (const p of [alice, bob]) {
      await satori.connect(p).predictMultipleWithPayloads([{ gameId: gameA, payload: pack1(UP) }]);
    }
    await advanceRound();
    await registry.setValue(gameA, base + 10);
    await advanceRound();
    await registry.setValue(gameA, base + 20);
    for (const p of [alice, bob]) await satori.connect(voter).settlePrediction(p.address, gameA);
    base += 100;
  }

  const headroom = async () =>
    (await token.generalAccrued()) - (await hub.onChainMinted()) - (await hub.merkleReserveCumulative());

  /** Mint through the rewards address until exactly `left` of headroom remains. */
  async function leaveHeadroom(left) {
    const rw = await rewardsSigner(rewards);
    const burn = (await headroom()) - left;
    expect(burn).to.be.gte(0n);
    if (burn > 0n) await hub.connect(rw).rewardMint(sink.address, burn);
    expect(await headroom()).to.equal(left);
  }

  it("pays the headroom, keeps the rest, and the remainder is claimable once the lane grows", async function () {
    await winningCycle();
    const owed = await rewards.unclaimedRewards(alice.address);
    expect(owed).to.be.gt(0n);
    const half = owed / 2n;
    await leaveHeadroom(half);

    const before = await token.balanceOf(alice.address);
    await expect(satori.connect(alice)["claim()"]())
      .to.emit(rewards, "RewardsClaimed").withArgs(alice.address, alice.address, half, anyRound);
    expect((await token.balanceOf(alice.address)) - before).to.equal(half);
    expect(await rewards.unclaimedRewards(alice.address)).to.equal(owed - half);
    expect(await headroom()).to.equal(0n);

    // Nothing is left, so a second claim still reverts at the hub.
    await expect(satori.connect(alice)["claim()"]()).to.be.revertedWithCustomError(hub, "BudgetExceeded");

    // New wins grow the lane; the remainder then pays in full.
    await winningCycle();
    const owedNow = await rewards.unclaimedRewards(alice.address);
    expect(owedNow).to.be.gt(owed - half);
    const before2 = await token.balanceOf(alice.address);
    await satori.connect(alice)["claim()"]();
    expect((await token.balanceOf(alice.address)) - before2).to.equal(owedNow);
    expect(await rewards.unclaimedRewards(alice.address)).to.equal(0n);
  });

  it("a bucket that fits is paid whole, as before", async function () {
    await winningCycle();
    const owed = await rewards.unclaimedRewards(alice.address);
    await leaveHeadroom(owed);
    await satori.connect(alice)["claim()"]();
    expect(await rewards.unclaimedRewards(alice.address)).to.equal(0n);
  });

  it("zero headroom still reverts BudgetExceeded and keeps the bucket", async function () {
    await winningCycle();
    const owed = await rewards.unclaimedRewards(alice.address);
    await leaveHeadroom(0n);
    await expect(satori.connect(alice)["claim()"]()).to.be.revertedWithCustomError(hub, "BudgetExceeded");
    expect(await rewards.unclaimedRewards(alice.address)).to.equal(owed);
  });

  it("a relay fee larger than the headroom reverts BadInput; one that fits is paid out of the partial amount", async function () {
    await winningCycle();
    const owed = await rewards.unclaimedRewards(alice.address);
    const half = owed / 2n;
    await leaveHeadroom(half);
    const h = await rewardsSigner(hub);

    await expect(rewards.connect(h).claimWithFee(alice.address, alice.address, bob.address, half + 1n))
      .to.be.revertedWithCustomError(rewards, "BadInput");

    const fee = half / 10n;
    const a0 = await token.balanceOf(alice.address);
    const b0 = await token.balanceOf(bob.address);
    await rewards.connect(h).claimWithFee(alice.address, alice.address, bob.address, fee);
    expect((await token.balanceOf(bob.address)) - b0).to.equal(fee);
    expect((await token.balanceOf(alice.address)) - a0).to.equal(half - fee);
    expect(await rewards.unclaimedRewards(alice.address)).to.equal(owed - half);
  });
});
