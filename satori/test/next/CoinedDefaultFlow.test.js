// The default game is a Sentiment game. Two scoring rules matter most there:
//
//   M23  The hourly snapshot is the anchor, so flow other predictors added earlier
//        in the same hour is added back to a prediction's anchor at settle: a late
//        joiner is not rewarded for a move it had already seen.
//   M24  A winning side is paid from the losing side's weight and capped by its
//        own: pot = P x min(side, other) / (side + other). A dust wallet alone on
//        the thin side earns dust, not the slice.
//
// Scenarios run on game 1 (the Sentiment stream "satori"), with no vote and no
// authority writing the value.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySplitFixture } = require("./splitFixture");

const HOUR = 3600;
const DAY = 86400;
const UP = 1;
const DOWN = 2;
const GAME = 1;
const pack1 = (d) => ethers.hexlify(new Uint8Array([d]));
const E = (n) => ethers.parseEther(String(n));

async function setup(funds) {
  const fix = await deploySplitFixture();
  const { token, owner, signers } = fix;
  const wallets = signers.slice(1, 1 + funds.length);
  for (let i = 0; i < funds.length; i++) {
    await (await token.connect(owner).transfer(wallets[i].address, funds[i])).wait();
  }
  const base = (Math.floor((await time.latest()) / DAY) + 1) * DAY;
  const R = BigInt(base / DAY);
  const at = (hoursFromBase) => time.increaseTo(base + Math.round(hoursFromBase * HOUR) + 10);
  return { ...fix, wallets, base, R, at };
}

const predict = (engine, user, dir) =>
  engine.connect(user).predictMultipleWithPayloads([{ gameId: GAME, payload: pack1(dir) }]).then((t) => t.wait());

function eventsOf(rc, engine, rewards, user) {
  let credit = 0n;
  let correct = null;
  let voided = false;
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
        if (p && p.name === "PredictionScored" && p.args.user === user.address) correct = p.args.correct;
        if (p && p.name === "PredictionVoided" && p.args.user === user.address) voided = true;
      }
    } catch {}
  }
  return { credit, correct, voided };
}

const settle = async (engine, rewards, user) =>
  eventsOf(await (await engine.settlePrediction(user.address, GAME)).wait(), engine, rewards, user);

async function slice(rewards, voting, R) {
  const ev = await rewards.queryFilter(rewards.filters.RoundBudgetFrozen(R), 0, "latest");
  expect(ev.length).to.be.gt(0);
  return (ev[0].args.budget * (await voting.getGameVotesAtRound(GAME, R))) / (await voting.roundDenominator(R));
}

describe("The default game pays and scores like a Sentiment game (M23, M24)", function () {
  this.timeout(600000);

  it("M23: a late joiner who only follows a move already made in its hour is not rewarded for it", async function () {
    const { engine, rewards, registry, wallets, at } = await setup([E(100), E(100)]);
    const [early, late] = wallets;
    await at(10);
    await predict(engine, early, UP);
    await predict(engine, late, UP);   // same hour: sees early's flow already in the counter
    await at(10 + 24);                  // first touch of the hour 24h on writes the post sample
    await (await registry.updateValue(GAME)).wait();

    const e = await settle(engine, rewards, early);
    const l = await settle(engine, rewards, late);
    // early moved first and the network (late) leaned its way afterwards.
    expect(e.voided).to.equal(false);
    expect(e.correct).to.equal(true);
    // Nothing came after late: before the fix the move early made counted for late
    // too and late won; now it is a void (no reward, streak kept).
    expect(l.voided).to.equal(true);
    expect(l.credit).to.equal(0n);
  });

  it("M23: a first-in-hour predictor is unaffected (no earlier flow to add back)", async function () {
    const { engine, rewards, registry, wallets, at } = await setup([E(100), E(100)]);
    const [first, second] = wallets;
    await at(10);
    await predict(engine, first, UP);
    await at(11);                       // next hour: the second predictor is first in ITS hour
    await predict(engine, second, UP);
    await at(10 + 24);
    await registry.updateValue(GAME);
    await at(11 + 24);
    await registry.updateValue(GAME);
    const f = await settle(engine, rewards, first);
    expect(f.correct).to.equal(true);
  });

  it("M24: a dust wallet alone on the winning side earns dust, not the slice", async function () {
    const dustPower = 2n ** 41n;
    const { engine, rewards, voting, lens, registry, wallets, R, at, token, owner } =
      await setup([E(400), dustPower, E(400)]);
    const [whale, dust, whale2] = wallets;

    // Round R: the whale leans DOWN at hour 22; the dust wallet takes UP at hour 23.
    await at(22);
    await predict(engine, whale, DOWN);
    await at(23);
    await predict(engine, dust, UP);
    // Round R+1, hour 0: the whale's other wallet leans UP. That flow lands inside
    // the dust wallet's 24h window but is weighed in round R+1, so the dust wallet
    // is alone on the UP side of round R.
    await at(24);
    await predict(engine, whale2, UP);
    await at(23 + 24);
    await registry.updateValue(GAME);

    const d = await settle(engine, rewards, dust);
    expect(d.correct).to.equal(true);

    const P = await slice(rewards, voting, R);
    const w = await lens.userWeightByDirection(dust.address, GAME, R, UP);
    const other = await lens.userWeightByDirection(whale.address, GAME, R, DOWN);
    expect(w).to.be.gt(0n);
    expect(other).to.be.gt(w);
    const smaller = w < other ? w : other;
    const pot = (P * smaller) / (w + other);
    expect(d.credit).to.equal(pot);
    // The old rule, P x other / (side + other), would have paid nearly all of P.
    const oldPot = (P * other) / (w + other);
    expect(oldPot).to.be.gt(P - P / 1000n);
    expect(d.credit).to.be.lt(P / 1000n);
  });
});
