// AUDIT C-10 — the two-slot prediction ring must never silently discard a live bet.
//
// Each (user, game) has two prediction slots. When both hold UNSETTLED predictions
// the engine overwrites the older one. The new prediction lands either way — that
// branch only picks the slot — but the DISPLACED bet has to be finalized, or its
// `_unsettledPredictionCount` is stranded forever. That counter is the delegator
// walk's round-closed test, so a stuck one pins an `openRounds` entry that can never
// pop and quietly eats the budgeted replay on every future claim by every inbound
// delegator: a slow degradation with no trail back to the prediction that caused it.
//
// The branch is believed UNREACHABLE, held up by two guards in a different function:
//   1. `PredictExpired` — you cannot predict unless the stream updated THIS round.
//   2. `_scorePreviousPrediction` runs BEFORE `_makePrediction` on the same game.
// Together: every predict-enabling round adds a value, so by a third prediction
// there are always the >= 2 post-anchor values ABC scoring needs, and the older slot
// is always settled before the write.
//
// These tests pin that. If `PredictionDisplaced` ever fires, one of the two guards
// changed — and the event is the alarm that says so.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { deploySatoriFixture, pack1, voteFor } = require("../fixtures");

const E = (n) => ethers.parseEther(String(n));
const UP = 1;

describe("Two-slot displacement never silently drops a bet (audit C-10)", function () {
  this.timeout(300000);

  let satori, registry, engine, rewards, owner, alice, streamId;

  const advanceRound = async () => {
    await ethers.provider.send("evm_increaseTime", [86400]);
    await ethers.provider.send("evm_mine", []);
  };
  // The stream comes from the 2-arg createSimpleDataStream, i.e. what a public
  // caller now gets: cadence 2. Its DENSEST legal rhythm is one value (and so
  // one predict) per CADENCE_ROUNDS rounds, and scoring is the AB window —
  // anchor = the value AT the predict round, post = the first value after it.
  const CADENCE_ROUNDS = 2;
  const advanceCadencePeriod = async () => {
    for (let i = 0; i < CADENCE_ROUNDS; i++) await advanceRound();
  };
  const setValue = (v) => registry.connect(owner).setValue(streamId, v);
  const predict = () => satori.connect(alice).predictMultipleWithPayloads(
    [{ gameId: streamId, payload: pack1(UP) }]);

  beforeEach(async function () {
    const signers = await ethers.getSigners();
    [, alice] = signers;
    const fix = await deploySatoriFixture();
    ({ satori, registry, engine, rewards } = fix);
    owner = fix.owner;

    // The fixture initializes the DEFAULT stream at id 1, so this one is id 2 —
    // read off the event rather than assumed.
    const rc = await (await satori.createSimpleDataStream("S", owner.address)).wait();
    streamId = BigInt(rc.logs
      .map((l) => { try { return satori.interface.parseLog(l); } catch { return null; } })
      .find((p) => p && p.name === "DataStreamCreated").args.streamId);
    await (await satori.transfer(alice.address, E(100))).wait();
    // Burn 10 for the game; alice keeps 90 to predict with.
    await (await voteFor(satori, alice, streamId)).wait();
  });

  it("a long run of back-to-back predictions never displaces a live bet", async function () {
    // Every cadence period: write a value, predict. This is the densest legal
    // rhythm for the stream and the case most likely to outrun settlement, since
    // a prediction is placed before the previous one has its post-anchor value.
    let v = 1000;
    for (let i = 0; i < 20; i++) {
      await advanceCadencePeriod();
      await setValue(v);
      v += 10;
      await (await predict()).wait();
    }

    const displaced = await engine.queryFilter(engine.filters.PredictionDisplaced());
    expect(displaced.length,
      "settle-before-write should have kept a slot free every round — if this fires, " +
      "the guards in _scorePreviousPrediction / PredictExpired changed"
    ).to.equal(0);
  });

  it("an intermittent stream (predict only when it ticks) also never displaces", async function () {
    // Gaps are the other shape that could outrun settlement: the stream skips
    // periods, so a prediction can sit unsettled while a newer one is placed.
    // Skipping a whole cadence period keeps this genuinely SPARSER than the
    // back-to-back case above (which already runs at every 2 rounds).
    let v = 5000;
    for (let i = 0; i < 12; i++) {
      await advanceCadencePeriod();
      await advanceCadencePeriod();  // skip a period — no value, so no predict is possible
      await setValue(v);
      v += 10;
      await (await predict()).wait();
    }

    const displaced = await engine.queryFilter(engine.filters.PredictionDisplaced());
    expect(displaced.length, "an intermittent stream must not displace either").to.equal(0);
  });

  it("a stalled-then-resumed stream — the shape closest to reaching the branch — still never displaces", async function () {
    // The only way into the branch is for _scorePreviousPrediction to FAIL to
    // score the older slot while a predict is still allowed. A long stall is the
    // closest approach: a prediction sits unsettled with too few post-anchor
    // values, and the moment the stream resumes a new prediction becomes legal.
    let v = 7000;
    await advanceCadencePeriod();
    await setValue(v); v += 10;
    await (await predict()).wait();               // slot A, now unsettled

    // Stream stalls: no values. Six ROUNDS is the stall length (three cadence
    // periods) — a stall is measured in rounds of silence, not in cadence steps.
    for (let i = 0; i < 6; i++) await advanceRound();

    await setValue(v); v += 10;                   // resumes -> predict legal again
    await (await predict()).wait();               // slot B (A still unsettled)

    await advanceCadencePeriod();
    await setValue(v); v += 10;                   // A now has its post-anchor value
    await (await predict()).wait();               // the write that would displace, if it could

    await advanceCadencePeriod();
    await setValue(v); v += 10;
    await (await predict()).wait();

    const displaced = await engine.queryFilter(engine.filters.PredictionDisplaced());
    expect(displaced.length,
      "a stall followed by a resume must still settle the older slot before the write"
    ).to.equal(0);
  });
});
