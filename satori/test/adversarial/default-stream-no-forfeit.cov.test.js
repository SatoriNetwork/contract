// COVERAGE / REGRESSION GUARD: a default-stream prediction must always be
// SCORABLE unless its anchor has aged out of the 768-entry value ring — it must
// never be silently forfeited by the 2-slot prediction-buffer overwrite.
//
// The default game is the Sentiment stream "satori": its value is the crowd's own
// signed flow, snapshotted at the first touch of each hour. A round-R prediction
// is scored against the snapshot taken at round R+1's first touch, so it is SCORED
// by the predictor's next prediction, long before the buffer would overflow.
//
// Scoring resolves up/down only when the value MOVES. A flat value (anchor ==
// post) is a legitimate `PredictionVoided` push — so this guard makes the other
// predictors lean UP in some rounds and DOWN in others, forcing real resolution
// of both kinds, and never leaves a round tied.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture, pack1 } = require("../fixtures");

const UP = 1;
const DOWN = 2;
const DEFAULT = 1;
async function toNextRound() {
  const t = await time.latest();
  await time.increaseTo(Math.floor(t / 86400) * 86400 + 86400 + 1);
}
async function predict(satori, who, dir = UP) {
  await satori.connect(who).predictMultipleWithPayloads([{ gameId: DEFAULT, payload: pack1(dir) }]);
}
async function aliceEvents(engine, alice) {
  const scored = (await engine.queryFilter(engine.filters.PredictionScored()))
    .filter(e => e.args[0] === alice.address && Number(e.args[1]) === DEFAULT)
    .map(e => ({ round: Number(e.args[2]), correct: e.args[3] }));
  const voided = (await engine.queryFilter(engine.filters.PredictionVoided()))
    .filter(e => e.args[0] === alice.address && Number(e.args[1]) === DEFAULT)
    .map(e => Number(e.args[2]));
  const unrec = (await engine.queryFilter(engine.filters.PredictionUnrecoverable()))
    .filter(e => e.args[0] === alice.address && Number(e.args[1]) === DEFAULT)
    .map(e => Number(e.args[2]));
  return { scored, voided, unrec };
}

describe("ADV-COV default stream: scorable unless 768-ring evicted (current-round indexing)", function () {
  this.timeout(600000);

  it("VARYING flow: every prediction leaving the 2-slot buffer is SCORED (correct/incorrect), never voided or forfeited", async function () {
    const fix = await deploySatoriFixture();
    const { satori, signers } = fix;
    const alice = signers[1];
    const fillers = signers.slice(2, 10);
    await satori.transfer(alice.address, ethers.parseEther("50"));
    for (const f of fillers) await satori.transfer(f.address, ethers.parseEther("10"));

    // Alice always predicts UP, first in the round. The others then lean UP or
    // DOWN by these counts, so she is right when the network leans UP after her
    // and wrong when it leans DOWN.
    const lean = [[2, 0], [0, 3], [3, 1], [1, 4], [4, 0], [0, 2]];
    const predicted = [];
    for (let i = 0; i < lean.length; i++) {
      await toNextRound();
      predicted.push(Number(await satori.getCurrentRound()));
      await predict(satori, alice);
      const [up, down] = lean[i];
      for (let j = 0; j < up; j++) await predict(satori, fillers[j], UP);
      for (let j = 0; j < down; j++) await predict(satori, fillers[up + j], DOWN);
    }

    const { scored, voided, unrec } = await aliceEvents(fix.engine, alice);
    const byRound = new Map(scored.map(s => [s.round, s.correct]));
    // The first 4 of 6 predictions have rolled out of the 2-slot buffer; with a
    // moving value each must be SCORED — not voided, not silently forfeited.
    for (const r of predicted.slice(0, 4)) {
      expect(byRound.has(r), `round ${r} must be SCORED (the value moved)`).to.equal(true);
    }
    // Both branches of the up/down resolution actually fire (rewards earned in
    // earlier rounds change each filler's power, so the exact pattern is not asserted).
    expect(scored.some(s => s.correct === true), "at least one correct").to.equal(true);
    expect(scored.some(s => s.correct === false), "at least one incorrect").to.equal(true);
    expect(unrec.length, "no ring evictions in a dense sequence").to.equal(0);
    expect(voided.length, "no voids when the flow moves every round").to.equal(0);
  });

  it("768-RING BOUNDARY: the ONLY non-scored terminal outcome is Unrecoverable (anchor evicted)", async function () {
    const fix = await deploySatoriFixture();
    const { satori, signers } = fix;
    const alice = signers[1];
    const churn = signers[2];
    await satori.transfer(alice.address, ethers.parseEther("50"));
    await satori.transfer(churn.address, ethers.parseEther("50"));
    // The fixture already calls initializeDefaultStream() (matching deploy.js).

    // Alice predicts once at R, then does NOT predict (R stays unscored in her
    // 2-slot buffer). `churn` predicts every round for 770 rounds, writing a
    // fresh default value each round and rolling the 768-entry ring well past
    // R's anchor. When Alice finally predicts again, scoring R finds its anchor
    // evicted => PredictionUnrecoverable — the one acceptable non-scored outcome.
    await toNextRound();
    const R = Number(await satori.getCurrentRound());
    await predict(satori, alice);

    for (let k = 0; k < 770; k++) {
      await toNextRound();
      await predict(satori, churn);
    }
    await toNextRound();
    await predict(satori, alice);

    const { unrec } = await aliceEvents(fix.engine, alice);
    expect(unrec.includes(R), "R must resolve as Unrecoverable (768-ring eviction), the only non-scorable case").to.equal(true);
  });
});
