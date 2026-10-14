// AUDIT C-3 — pins a DELIBERATE asymmetry in SatoriEngine._scorePreviousPrediction.
//
//   * an UNSCOREABLE prediction (the stream's 768-entry history ring rolled past
//     the anchor, so the outcome can never be judged) ZEROES the user's streak;
//   * a VOID (anchor == post — the value simply did not move) LEAVES IT ALONE.
//
// Both are outcomes the user did not cause, so the asymmetry reads like a bug —
// which is exactly why it needs pinning. Preserving the streak on eviction would
// create STREAK INSURANCE: a user who predicts and then realises they are going to
// be WRONG could stall (never predict that game again — predicting is what triggers
// settlement), wait out the ring, and have the losing prediction evaporate with the
// streak intact, while still predicting every other game meanwhile. Zeroing makes
// stalling never better than taking the loss.
//
// If either assertion here fails, the fix is almost certainly NOT to change the test.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { deploySatoriFixture, pack1, voteFor } = require("../fixtures");

const E = (n) => ethers.parseEther(String(n));
const UP = 1;
const HISTORY_SIZE = 768;

describe("Streak on unscoreable vs void outcomes (audit C-3)", function () {
  this.timeout(600000);

  let satori, registry, engine, owner, alice, streamId;

  const advanceRound = async () => {
    await ethers.provider.send("evm_increaseTime", [86400]);
    await ethers.provider.send("evm_mine", []);
  };
  // The stream below runs at an explicit two-round cadence (2880 minutes). A
  // value may only be written every CADENCE_ROUNDS rounds, and scoring is the
  // next-sample window — anchor = the sample standing at the prediction's own
  // hour, post = the FIRST value written after it (every-round streams are the
  // ones that score ABC).
  // Ring eviction and the void are both properties of that window, so the
  // whole rhythm below steps a cadence period at a time.
  const CADENCE_ROUNDS = 2;
  const advanceCadencePeriod = async () => {
    // One jump of CADENCE_ROUNDS rounds (equivalent to stepping them singly;
    // nothing here depends on the intermediate blocks, and the 768-entry ring
    // makes eviction loops long enough that the RPC count matters).
    await ethers.provider.send("evm_increaseTime", [86400 * CADENCE_ROUNDS]);
    await ethers.provider.send("evm_mine", []);
  };
  const setValue = async (v) => registry.connect(owner).setValue(streamId, v);
  const streak = async () => engine.streaks(alice.address, streamId);

  beforeEach(async function () {
    const signers = await ethers.getSigners();
    [, alice] = signers;
    const fix = await deploySatoriFixture();
    ({ satori, registry, engine } = fix);
    owner = fix.owner;

    // The fixture initializes the DEFAULT stream at id 1, so this one is id 2 —
    // read off the event rather than assumed.
    const rc = await (await satori["createSimpleDataStream(string,address,uint24)"]("S", owner.address, 2880)).wait();
    streamId = BigInt(rc.logs
      .map((l) => { try { return satori.interface.parseLog(l); } catch { return null; } })
      .find((p) => p && p.name === "DataStreamCreated").args.streamId);
    await (await satori.transfer(alice.address, E(100))).wait();
    // Burn 10 for the game; alice keeps 90 to predict with.
    await (await voteFor(satori, alice, streamId)).wait();

    // Build a real streak first: predict, win, settle -> streak 1. Both cases below
    // are about what happens to an EXISTING streak.
    await advanceCadencePeriod();
    await setValue(1000);                      // anchor A
    await (await satori.connect(alice).predictMultipleWithPayloads(
      [{ gameId: streamId, payload: pack1(UP) }])).wait();
    await advanceCadencePeriod();
    await setValue(1010);                      // post > anchor -> UP correct
    await (await satori.settlePrediction(alice.address, streamId)).wait();
    expect(await streak(), "warm-up must leave alice on a real streak").to.equal(1n);
  });

  it("an evicted anchor ZEROES the streak — deliberate, prevents streak insurance", async function () {
    await advanceCadencePeriod();
    await setValue(2000);
    await (await satori.connect(alice).predictMultipleWithPayloads(
      [{ gameId: streamId, payload: pack1(UP) }])).wait();
    expect(await streak(), "streak survives up to the moment of settlement").to.equal(1n);

    // Roll the 768-entry ring clean past alice's anchor WITHOUT settling her. This is
    // the stalling window: she never predicts this game again, so nothing settles it.
    let v = 3000;
    for (let i = 0; i < HISTORY_SIZE + 2; i++) {
      await advanceCadencePeriod();
      await setValue(v);
      v += 10;
    }

    // Anyone may settle (it is permissionless) — the outcome is simply unjudgeable.
    await expect(satori.settlePrediction(alice.address, streamId))
      .to.emit(engine, "PredictionUnrecoverable");

    expect(await streak(), "an unscoreable prediction must zero the streak").to.equal(0n);
  });

  it("a VOID (value did not move) PRESERVES the streak", async function () {
    await advanceCadencePeriod();
    await setValue(2000);
    await (await satori.connect(alice).predictMultipleWithPayloads(
      [{ gameId: streamId, payload: pack1(UP) }])).wait();

    // AB scoring compares the FIRST value recorded after the predict round
    // against the value AT that round. Re-posting the anchor's own value makes
    // anchor == post, i.e. a genuine no-move.
    await advanceCadencePeriod();
    await setValue(2000);

    await expect(satori.settlePrediction(alice.address, streamId))
      .to.emit(engine, "PredictionVoided");

    expect(await streak(), "a void must leave the streak untouched").to.equal(1n);
  });

  it("the two paths really are different — same user, same streak, opposite results", async function () {
    // Guards against a future refactor collapsing both into one branch: whatever
    // else changes, these two outcomes must not converge.
    const before = await streak();
    expect(before).to.equal(1n);

    await advanceCadencePeriod();
    await setValue(3000);
    await (await satori.connect(alice).predictMultipleWithPayloads(
      [{ gameId: streamId, payload: pack1(UP) }])).wait();
    await advanceCadencePeriod();
    await setValue(3000);                      // post == anchor -> VOID
    await (await satori.settlePrediction(alice.address, streamId)).wait();
    const afterVoid = await streak();

    await advanceCadencePeriod();
    await setValue(4000);
    await (await satori.connect(alice).predictMultipleWithPayloads(
      [{ gameId: streamId, payload: pack1(UP) }])).wait();
    let v = 5000;
    for (let i = 0; i < HISTORY_SIZE + 2; i++) {
      await advanceCadencePeriod();
      await setValue(v);
      v += 10;
    }
    await (await satori.settlePrediction(alice.address, streamId)).wait();
    const afterEviction = await streak();

    expect(afterVoid, "void preserves").to.equal(before);
    expect(afterEviction, "eviction zeroes").to.equal(0n);
    expect(afterVoid).to.not.equal(afterEviction);
  });
});
