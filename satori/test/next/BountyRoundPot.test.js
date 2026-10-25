// B3 (docs/issues/predeploy-sweep-2026-10-17): a bounty round pays one pot.
// A 2h-cadence stream scores its daily game on the first two samples after the
// prediction (the ABC band), so those samples exist hours later, inside the
// same round. A winner settled then was divided by the boost placed so far.

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySplitFixture } = require("./splitFixture");

const UP = 1;
const DOWN = 2;
const HOUR = 3600;
const DAY = 86400;
const E = (n) => ethers.parseEther(String(n));
const pack1 = (d) => ethers.hexlify(new Uint8Array([d]));

describe("B3: a bounty round never pays more than its pot", function () {
  const POOL = E(150);
  const RATE = E(100);
  const STAKE = E(100);

  async function setup() {
    const f = await deploySplitFixture();
    const { hub, registry, games, voting, bounties, engine, token, owner } = f;
    const [, alice, bob, carol, dave, funder, provider] = f.signers;
    for (const u of [alice, bob, carol, dave, funder]) await token.connect(owner).transfer(u.address, E(100));

    const rc = await (await hub.connect(owner)["createSimpleDataStream(string,address,uint24)"](
      "BTC-2h", provider.address, 120)).wait();
    const streamId = rc.logs.map((l) => { try { return registry.interface.parseLog(l); } catch { return null; } })
      .find((p) => p && p.name === "DataStreamCreated").args.streamId;
    const gid = await games.binaryGameByStream(streamId);
    await voting.connect(owner).setGameApproved(gid, true);

    // Streak 1 for each predictor (streak 0 takes no bounty), before any bounty exists.
    const predictors = [alice, bob, carol];
    await time.increase(DAY);
    await registry.connect(provider).setValue(streamId, 1000);
    for (const u of predictors) await engine.connect(u).predictMultipleWithPayloads([{ gameId: gid, payload: pack1(UP) }]);
    await time.increase(DAY);
    await registry.connect(provider).setValue(streamId, 1010);
    await time.increase(DAY);
    await registry.connect(provider).setValue(streamId, 1020);
    for (const u of predictors) await engine.settlePrediction(u.address, gid);
    for (const u of predictors) expect(await engine.streaks(u.address, gid)).to.equal(1n);
    await time.increase(DAY);

    const usd = await (await ethers.getContractFactory("MockERC20")).deploy("USDC", "USDC");
    await usd.waitForDeployment();
    const usdAddr = await usd.getAddress();
    const bAddr = await bounties.getAddress();
    await usd.mint(funder.address, POOL);
    await usd.connect(funder).approve(bAddr, POOL);
    await bounties.connect(funder).fundBounty(gid, usdAddr, POOL, RATE);
    // Dave stakes and never predicts: his 100 must always come back.
    for (const u of [alice, bob, carol, dave]) {
      await usd.mint(u.address, STAKE);
      await usd.connect(u).approve(bAddr, STAKE);
      await bounties.connect(u).stakeBountyToken(usdAddr, STAKE);
    }

    const base = Math.floor((await time.latest()) / DAY) * DAY + DAY; // round R starts at the next midnight
    const at = (h, m) => time.increaseTo(base + h * HOUR + m * 60);
    const set = (v) => registry.connect(provider).setValue(streamId, v);
    const predict = (u, dir = UP) => engine.connect(u).predictMultipleWithPayloads([{ gameId: gid, payload: pack1(dir) }]);
    const earned = async (u) => (await bounties.bountyStake(u.address, usdAddr)) - STAKE;
    return { ...f, alice, bob, carol, dave, provider, streamId, gid, usd, usdAddr, bAddr, base, at, set, predict, earned };
  }

  it("a settle inside the prediction's round waits; after midnight the round's winners share one pot", async function () {
    const t = await loadFixture(setup);
    const { engine, bounties, token, alice, bob, carol, dave, gid, usd, usdAddr, bAddr, at, set, predict, earned } = t;
    const round = (await token.getCurrentRound()) + 1n;

    // The repro's timeline: each winner's two samples land, and it is settled, before the next predicts.
    const steps = [[alice, [1, 5], [2, 40], [4, 45], [4, 50]],
                   [bob,   [5, 0], [6, 50], [8, 55], [9, 0]],
                   [carol, [9, 5], [11, 0], [13, 5], [13, 10]]];
    let v = 100;
    await at(0, 30); await set(v);
    for (const [u, p, s1, s2, settle] of steps) {
      await at(...p); await predict(u);
      await at(...s1); await set(v += 10);
      await at(...s2); await set(v += 10);
      await at(...settle);
      await expect(engine.settlePrediction(u.address, gid)).to.not.emit(engine, "PredictionScored");
      expect(await engine.streaks(u.address, gid)).to.equal(1n);
    }
    expect(await token.getCurrentRound()).to.equal(round);
    expect(await bounties.roundBountyPot(gid, round, usdAddr)).to.equal(RATE);
    expect(await bounties.roundBountyPotClaimed(gid, round, usdAddr)).to.equal(0n);

    await time.increaseTo(t.base + DAY + 60);
    for (const u of [alice, bob, carol]) {
      await expect(engine.settlePrediction(u.address, gid)).to.emit(engine, "PredictionScored");
      expect(await engine.streaks(u.address, gid)).to.equal(2n);
    }
    const pot = await bounties.roundBountyPot(gid, round, usdAddr);
    expect(pot).to.equal(RATE);
    for (const u of [alice, bob, carol]) expect(await earned(u)).to.equal(pot / 3n);
    expect(await bounties.roundBountyPotClaimed(gid, round, usdAddr)).to.be.lte(pot);

    for (const u of [alice, bob, carol, dave]) {
      const s = await bounties.bountyStake(u.address, usdAddr);
      await bounties.connect(u).unstakeBountyToken(usdAddr, s, u.address);
    }
    expect(await usd.balanceOf(dave.address)).to.equal(STAKE);
    const dust = pot - (await bounties.roundBountyPotClaimed(gid, round, usdAddr));
    expect(await usd.balanceOf(bAddr)).to.equal((await bounties.pool(gid, usdAddr)) + dust);
  });

  it("a loss inside the round keeps the streak until the round ends", async function () {
    const t = await loadFixture(setup);
    const { engine, alice, gid, at, set, predict } = t;
    await at(0, 30); await set(100);
    await at(1, 5); await predict(alice, DOWN);
    await at(2, 40); await set(110);
    await at(4, 45); await set(120);
    await at(4, 50);
    await engine.settlePrediction(alice.address, gid);
    expect(await engine.streaks(alice.address, gid)).to.equal(1n);

    await time.increaseTo(t.base + DAY + 60);
    await engine.settlePrediction(alice.address, gid);
    expect(await engine.streaks(alice.address, gid)).to.equal(0n);
  });

  it("a weighted winner settled inside the round waits instead of reverting, then earns", async function () {
    const t = await loadFixture(setup);
    const { engine, hub, rewards, alice, bob, gid, at, set, predict } = t;
    await hub.connect(bob).vote(gid, E(10));
    await at(0, 30); await set(100);
    await at(1, 5); await predict(alice);
    await at(2, 40); await set(110);
    await at(4, 45); await set(120);
    await at(4, 50);
    await expect(engine.settlePrediction(alice.address, gid)).to.not.emit(engine, "PredictionScored");

    await time.increaseTo(t.base + DAY + 60);
    const before = await rewards.unclaimedRewards(alice.address);
    await expect(engine.settlePrediction(alice.address, gid)).to.emit(engine, "PredictionScored");
    expect(await rewards.unclaimedRewards(alice.address)).to.be.gt(before);
  });
});
