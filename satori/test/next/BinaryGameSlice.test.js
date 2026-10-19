// A binary game-round credits at most its slice P (sweep item B4).
//
// The engine scores each prediction on the values after its own hour, so on a
// game other than the default an UP at 01:00 and a DOWN at 13:00 can both be
// right. Such a game divides by both sides' committed weight; the default game,
// whose predictors of a round all read one pair of values, keeps dividing by
// its own side.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySplitFixture } = require("./splitFixture");

const HOUR = 3600;
const DAY = 86400;
const UP = 1;
const DOWN = 2;
const pack1 = (d) => ethers.hexlify(new Uint8Array([d]));
const E = (n) => ethers.parseEther(String(n));

// The launch bitmap; the admin creates, approves and votes an hourly stream's game.
async function setup(bobAmount) {
  const fix = await deploySplitFixture();
  const { token, hub, rewards, registry, games, voting, owner, signers } = fix;
  const [alice, bob, provider] = signers.slice(1, 4);
  await (await rewards.connect(owner).setCapabilities(1 << 5)).wait();
  await (await token.connect(owner).transfer(alice.address, E(60))).wait();
  await (await token.connect(owner).transfer(bob.address, bobAmount)).wait();

  const rc = await (await hub.connect(owner)["createSimpleDataStream(string,address,uint24)"](
    "HOURLY-PRICE", provider.address, 60)).wait();
  const sid = rc.logs.map((l) => { try { return registry.interface.parseLog(l); } catch { return null; } })
    .find((p) => p && p.name === "DataStreamCreated").args.streamId;
  const gid = await games.binaryGameByStream(sid);
  expect(gid).to.not.equal(1n);
  await (await voting.connect(owner).setGameApproved(gid, true)).wait();
  await (await hub.connect(owner).vote(gid, E(10))).wait();

  const base = (Math.floor((await time.latest()) / DAY) + 1) * DAY;
  const R = BigInt(base / DAY);
  const write = async (hourIdx, v) => {
    await time.increaseTo(base + hourIdx * HOUR + 10);
    await (await registry.connect(provider).setValue(sid, v)).wait();
  };
  return { ...fix, alice, bob, provider, sid, gid, base, R, write };
}

const predict = async (engine, user, gid, dir) =>
  (await engine.connect(user).predictMultipleWithPayloads([{ gameId: gid, payload: pack1(dir) }])).wait();

// SATORI a receipt credited to `user` (RewardSplit: predictor + delegator share),
// and the rounds it scored.
function creditsIn(rc, engine, rewards, user) {
  let credit = 0n;
  const scored = [];
  for (const log of rc.logs) {
    const a = log.address.toLowerCase();
    try {
      if (a === rewards.target.toLowerCase()) {
        const p = rewards.interface.parseLog(log);
        if (p && p.name === "RewardSplit" && p.args.predictor === user.address) {
          credit += p.args.predictorAmount + p.args.delegatorAmount;
        }
      } else if (a === engine.target.toLowerCase()) {
        const p = engine.interface.parseLog(log);
        if (p && p.name === "PredictionScored" && p.args.user === user.address) {
          scored.push({ round: p.args.round, correct: p.args.correct });
        }
      }
    } catch {}
  }
  return { credit, scored };
}

const settle = async (engine, rewards, user, gid) =>
  creditsIn(await (await engine.settlePrediction(user.address, gid)).wait(), engine, rewards, user);

async function slice(rewards, voting, gid, R) {
  const ev = await rewards.queryFilter(rewards.filters.RoundBudgetFrozen(R), 0, "latest");
  expect(ev.length).to.be.gt(0);
  const budget = ev[0].args.budget;
  return (budget * (await voting.getGameVotesAtRound(gid, R))) / (await voting.roundDenominator(R));
}

const grossUp = (x, bps) => (x * 10000n) / (10000n - bps);

describe("Binary game slice: no game-round credits more than its slice (B4)", function () {
  this.timeout(300000);

  it("UP at 01:00 and DOWN at 13:00 both win, and together are paid at most the slice", async function () {
    const { token, hub, engine, rewards, voting, lens, alice, bob, gid, R, write } = await setup(E(60));
    await write(1, 1000n);
    await predict(engine, alice, gid, UP);
    for (let k = 2; k <= 12; k++) await write(k, 1000n);
    await write(13, 1100n);
    await predict(engine, bob, gid, DOWN);
    for (let k = 14; k <= 38; k++) await write(k, 1050n);

    const issuedBefore = (await hub.emission()).issued;
    const a = await settle(engine, rewards, alice, gid);
    const b = await settle(engine, rewards, bob, gid);
    const issued = (await hub.emission()).issued - issuedBefore;
    expect(a.scored).to.deep.equal([{ round: R, correct: true }]);
    expect(b.scored).to.deep.equal([{ round: R, correct: true }]);

    const P = await slice(rewards, voting, gid, R);
    const wa = await lens.userWeightByDirection(alice.address, gid, R, UP);
    const wb = await lens.userWeightByDirection(bob.address, gid, R, DOWN);
    expect(wa).to.equal(wb);
    expect(a.credit).to.equal((P * wa) / (wa + wb));
    expect(b.credit).to.equal((P * wb) / (wa + wb));
    expect(a.credit + b.credit).to.be.lte(P);
    const bps = await token.devFeeBps();
    expect(issued).to.equal(grossUp(a.credit, bps) + grossUp(b.credit, bps));
  });

  it("a dust wallet on the other side is paid its weight's share, not the slice", async function () {
    const dust = 2n ** 41n;
    const { engine, rewards, voting, lens, alice, bob, gid, R, write } = await setup(dust);
    await write(1, 1000n);
    await predict(engine, alice, gid, UP);
    for (let k = 2; k <= 12; k++) await write(k, 1000n);
    await write(13, 1100n);
    await predict(engine, bob, gid, DOWN);
    for (let k = 14; k <= 38; k++) await write(k, 1050n);

    const a = await settle(engine, rewards, alice, gid);
    const b = await settle(engine, rewards, bob, gid);
    expect(b.scored).to.deep.equal([{ round: R, correct: true }]);
    const P = await slice(rewards, voting, gid, R);
    const wa = await lens.userWeightByDirection(alice.address, gid, R, UP);
    const wb = await lens.userWeightByDirection(bob.address, gid, R, DOWN);
    expect(b.credit).to.equal((P * wb) / (wa + wb));
    expect(a.credit).to.equal((P * wa) / (wa + wb));
    expect(b.credit).to.be.lt(P / 10n ** 6n);
  });

  it("a loser's weight still counts, and is not paid to the winner", async function () {
    const { engine, rewards, voting, lens, alice, bob, gid, R, write } = await setup(E(60));
    await write(1, 1000n);
    await predict(engine, alice, gid, UP);
    await predict(engine, bob, gid, DOWN);
    for (let k = 2; k <= 26; k++) await write(k, 1050n);

    const a = await settle(engine, rewards, alice, gid);
    const b = await settle(engine, rewards, bob, gid);
    expect(a.scored).to.deep.equal([{ round: R, correct: true }]);
    expect(b.scored).to.deep.equal([{ round: R, correct: false }]);
    const P = await slice(rewards, voting, gid, R);
    const wa = await lens.userWeightByDirection(alice.address, gid, R, UP);
    const wb = await lens.userWeightByDirection(bob.address, gid, R, DOWN);
    expect(a.credit).to.equal((P * wa) / (wa + wb));
    expect(b.credit).to.equal(0n);
  });

  it("two such rounds right after launch: credits stay within the slices and every claim succeeds", async function () {
    const { token, hub, engine, rewards, voting, alice, bob, gid, R, write } = await setup(E(60));
    // Hour-1 prices rise day over day (UP right); hour-13 prices fall (DOWN right).
    const v = (idx) => {
      const d = Math.floor(idx / 24), k = idx % 24;
      if (k === 0) return BigInt(2000 - 10 * (d - 1));
      return BigInt(k < 13 ? 1000 + 10 * d : 2000 - 10 * d);
    };
    let creditA = 0n, creditB = 0n;
    for (let idx = 1; idx <= 62; idx++) {
      await write(idx, v(idx));
      const d = Math.floor(idx / 24), k = idx % 24;
      if (d <= 1 && k === 1) creditA += creditsIn(await predict(engine, alice, gid, UP), engine, rewards, alice).credit;
      if (d <= 1 && k === 13) creditB += creditsIn(await predict(engine, bob, gid, DOWN), engine, rewards, bob).credit;
    }
    creditA += (await settle(engine, rewards, alice, gid)).credit;
    creditB += (await settle(engine, rewards, bob, gid)).credit;
    expect(await token.getCurrentRound()).to.equal(R + 2n);

    const sumP = (await slice(rewards, voting, gid, R)) + (await slice(rewards, voting, gid, R + 1n));
    expect(creditA).to.be.gt(0n);
    expect(creditB).to.be.gt(0n);
    expect(creditA + creditB).to.be.lte(sumP);

    const ua = await rewards.unclaimedRewards(alice.address);
    const ub = await rewards.unclaimedRewards(bob.address);
    await expect(hub.connect(alice).claim()).to.not.be.reverted;
    await expect(hub.connect(bob).claim()).to.not.be.reverted;
    expect(await token.balanceOf(alice.address)).to.be.gte(E(60) + ua);
    expect(await token.balanceOf(bob.address)).to.be.gte(E(60) + ub);
  });

  it("the default game still pays its winners the whole slice when a loser is present", async function () {
    const fix = await deploySplitFixture();
    const { token, engine, rewards, voting, owner, signers } = fix;
    const [alice, bob, carol, whale] = signers.slice(1, 5);
    for (const u of [alice, bob, carol]) await (await token.connect(owner).transfer(u.address, E(60))).wait();
    await (await token.connect(owner).transfer(whale.address, E(400))).wait();

    // Round R: two UP, one DOWN. Round R+1: the whale also predicts, so more
    // capital is deployed than in R and the default stream rises (UP wins).
    const R = BigInt(Math.floor((await time.latest()) / DAY) + 1);
    await time.increaseTo(Number(R) * DAY + 5 * HOUR);
    await predict(engine, alice, 1, UP);
    await predict(engine, bob, 1, UP);
    await predict(engine, carol, 1, DOWN);
    await time.increaseTo(Number(R + 1n) * DAY + 5 * HOUR);
    await predict(engine, whale, 1, UP);
    await time.increaseTo(Number(R + 2n) * DAY + 5 * HOUR);
    await engine.flushDefaultStream();

    const a = await settle(engine, rewards, alice, 1);
    const b = await settle(engine, rewards, bob, 1);
    const c = await settle(engine, rewards, carol, 1);
    expect(a.scored).to.deep.equal([{ round: R, correct: true }]);
    expect(b.scored).to.deep.equal([{ round: R, correct: true }]);
    expect(c.scored).to.deep.equal([{ round: R, correct: false }]);
    const P = await slice(rewards, voting, 1, R);
    expect(P).to.be.gt(0n);
    expect(a.credit + b.credit).to.be.lte(P);
    expect(a.credit + b.credit).to.be.gte(P - 2n);
  });
});
