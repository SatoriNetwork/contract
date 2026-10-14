// COVERAGE / REGRESSION GUARD: a default-stream prediction must always be
// SCORABLE unless its anchor has aged out of the 768-entry value ring — it must
// never be silently forfeited by the 2-slot prediction-buffer overwrite.
//
// The default game is cadence-1: its value is flushed once per round, holding
// LAST round's prediction count, indexed AT the current round. That current-
// round indexing keeps the value cadence in lockstep with the predict cadence,
// so a round-R prediction's two ABC values (the first two after R) land at
// rounds R+1 and R+2 — exactly as the user's 2-slot prediction buffer overflows
// on their third consecutive predict. The oldest prediction is therefore SCORED
// on the way out, never evicted unscored.
//
// Was the marathon-fuzz INV-R4 finding for the default stream (the value lagged
// one round behind the predicting under the former "yesterday" indexing, so the
// oldest prediction wasn't scorable until one round AFTER the buffer overflowed,
// and got silently evicted). The fix is current-round indexing; this guard
// proves the invariant the fix restores.
//
// IMPORTANT: scoring resolves up/down only when the value MOVES. A flat value
// (anchor == post) is a legitimate `PredictionVoided` push — so this guard
// VARIES the prediction count every round to force real up/down resolution,
// rather than the constant-count void of a single predictor.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture, pack1 } = require("../fixtures");

const UP = 1;
const DEFAULT = 1;
async function toNextRound() {
  const t = await time.latest();
  await time.increaseTo(Math.floor(t / 86400) * 86400 + 86400 + 1);
}
async function predict(satori, who) {
  await satori.connect(who).predictMultipleWithPayloads([{ gameId: DEFAULT, payload: pack1(UP) }]);
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

  it("VARYING count: every prediction leaving the 2-slot buffer is SCORED (correct/incorrect), never voided or forfeited", async function () {
    const fix = await deploySatoriFixture();
    const { satori, signers } = fix;
    const alice = signers[1];
    const fillers = signers.slice(2, 10);
    await satori.transfer(alice.address, ethers.parseEther("50"));
    for (const f of fillers) await satori.transfer(f.address, ethers.parseEther("10"));
    // The fixture already calls initializeDefaultStream() (matching deploy.js).

    // count(R) = 1 (alice) + fillersPerRound[i]; the sequence moves both up and
    // down so alice's UP prediction resolves correct AND incorrect (never flat).
    const fillersPerRound = [2, 5, 1, 4, 7, 3]; // counts: 3,6,2,5,8,4
    const predicted = [];
    for (let i = 0; i < fillersPerRound.length; i++) {
      await toNextRound();
      predicted.push(Number(await satori.getCurrentRound()));
      await predict(satori, alice);
      for (let j = 0; j < fillersPerRound[i]; j++) await predict(satori, fillers[j]);
    }

    const { scored, voided, unrec } = await aliceEvents(fix.engine, alice);
    const scoredRounds = new Set(scored.map(s => s.round));
    // The first 4 of 6 predictions have rolled out of the 2-slot buffer; with a
    // moving value each must be SCORED — not voided, not silently forfeited.
    for (const r of predicted.slice(0, 4)) {
      expect(scoredRounds.has(r), `round ${r} must be SCORED (the value moved)`).to.equal(true);
    }
    expect(unrec.length, "no ring evictions in a dense sequence").to.equal(0);
    expect(voided.length, "no voids when the count moves every round").to.equal(0);
    // Both branches of the up/down resolution actually fire.
    expect(scored.some(s => s.correct === true), "at least one correct").to.equal(true);
    expect(scored.some(s => s.correct === false), "at least one incorrect").to.equal(true);
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
