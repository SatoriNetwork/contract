// AUDIT C-2. `SatoriRewardsLens.userWeightByDirection` is a HAND-COPIED mirror of
// `SatoriEngine._deriveWeight` — two separate pieces of code computing the same
// number, one for real money (the reward split) and one for the dapp to display.
// Nothing in the compiler ties them together, so a change to one silently makes
// the other lie. That is exactly how C-2 happened in the first place: the curve
// was rescaled by CURVE_SCALE and the streak-0 constant was not, and nothing
// caught it. The lens already carries the same scar with REFERRAL_BPS, which
// drifted 1% -> 5% and had to be hand-synced.
//
// This pins them together. It asserts the lens reproduces the weight the ENGINE
// actually used — read out of the PredictionScored event, which is the engine's
// own number — across the cases where the two formulas could plausibly diverge:
// the flat streak-0 dust, a real streak, and different holding sizes.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { deploySatoriFixture, voteFor } = require("../fixtures");

const E = (n) => ethers.parseEther(String(n));
const UP = 1;
const pack1 = (d) => "0x0" + d;

describe("Lens/engine weight parity (audit C-2)", function () {
  this.timeout(180000);

  let satori, voting, lens, registry, engine, owner, alice, bob, authority, streamId;

  async function advanceRound() {
    await ethers.provider.send("evm_increaseTime", [86400]);
    await ethers.provider.send("evm_mine", []);
  }

  // The stream runs at an explicit two-round cadence (2880 minutes). One value
  // per CADENCE_ROUNDS rounds, and the scoring window is AB — anchor = the
  // value AT the predict round, post = the first value written after it.
  // Weight parity is cadence-independent; the rhythm below is simply the one
  // such a stream runs at.
  const CADENCE_ROUNDS = 2;
  async function advanceCadencePeriod() {
    for (let i = 0; i < CADENCE_ROUNDS; i++) await advanceRound();
  }

  beforeEach(async function () {
    const signers = await ethers.getSigners();
    [, alice, bob, authority] = signers;
    const fix = await deploySatoriFixture();
    ({ satori, voting, lens, registry, engine } = fix);
    owner = fix.owner;

    // The fixture initializes the DEFAULT stream at id 1, so this one is id 2 —
    // read off the event rather than assumed.
    const rc = await (await satori["createSimpleDataStream(string,address,uint24)"]("S1", authority.address, 2880)).wait();
    streamId = BigInt(rc.logs
      .map((l) => { try { return satori.interface.parseLog(l); } catch { return null; } })
      .find((p) => p && p.name === "DataStreamCreated").args.streamId);

    // Deliberately LOPSIDED holdings: if the dust were proportional to holdings
    // (the thing the flat design avoids) alice and bob would diverge here.
    await (await satori.transfer(alice.address, E(500))).wait();
    await (await satori.transfer(bob.address, E(5))).wait();
    // The OWNER burns for the game. Voting destroys tokens, and the 100:1
    // alice:bob holding ratio is precisely what this test measures.
    await voteFor(satori, owner, streamId);
  });

  /// The weight the ENGINE actually used, taken from its own event.
  async function engineWeightFor(user, round) {
    const evs = await engine.queryFilter(engine.filters.PredictionScored(user, streamId));
    const hit = evs.filter((e) => e.args.round === BigInt(round));
    return hit.length ? hit[hit.length - 1].args.scaledWeight : null;
  }

  it("lens matches the engine at streak 0 (flat dust) and at a real streak", async function () {
    // --- round 1: both predict from streak 0 ---
    await (await registry.connect(authority).setValue(streamId, 100)).wait();
    for (const u of [alice, bob]) {
      await (await satori.connect(u).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(UP) }])).wait();
    }
    const r1 = await satori.getCurrentRound();

    // drive both correct, then settle (AB: 110 > the anchor 100 at r1)
    await advanceCadencePeriod();
    await (await registry.connect(authority).setValue(streamId, 110)).wait();
    for (const u of [alice, bob]) {
      await (await satori.settlePrediction(u.address, streamId)).wait();
    }

    for (const u of [alice, bob]) {
      const fromEngine = await engineWeightFor(u.address, r1);
      const fromLens = await lens.userWeightByDirection(u.address, streamId, r1, UP);
      expect(fromEngine !== null, "engine must have scored a weight").to.equal(true);
      expect(fromLens, `lens must match the engine for ${u.address}`).to.equal(fromEngine);
    }

    // Streak-0 dust is a MULTIPLIER, so it stays PROPORTIONAL to holdings. That is
    // what makes it un-sybil-able: splitting a balance across N addresses splits the
    // dust N ways instead of paying N flat floors. Alice holds 100x bob, so she
    // earns ~100x his dust — and both are non-zero, which is the whole point.
    const aliceR1 = await lens.userWeightByDirection(alice.address, streamId, r1, UP);
    const bobR1 = await lens.userWeightByDirection(bob.address, streamId, r1, UP);
    expect(bobR1, "a streak-0 win must pay something, never zero").to.be.gt(0);
    expect(aliceR1, "streak-0 dust is proportional, so the larger holder earns more").to.be.gt(bobR1);

    // --- both now carry streak 1: the curve dominates and holdings DO matter ---
    await (await satori.connect(alice).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(UP) }])).wait();
    await (await satori.connect(bob).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(UP) }])).wait();
    const r2 = await satori.getCurrentRound();
    await advanceCadencePeriod();
    await (await registry.connect(authority).setValue(streamId, 130)).wait();
    for (const u of [alice, bob]) {
      await (await satori.settlePrediction(u.address, streamId)).wait();
    }

    for (const u of [alice, bob]) {
      const fromEngine = await engineWeightFor(u.address, r2);
      const fromLens = await lens.userWeightByDirection(u.address, streamId, r2, UP);
      expect(fromLens, `lens must match the engine at a real streak for ${u.address}`).to.equal(fromEngine);
    }
    // Sanity: with a real streak the bigger holder now genuinely earns more.
    expect(await lens.userWeightByDirection(alice.address, streamId, r2, UP))
      .to.be.gt(await lens.userWeightByDirection(bob.address, streamId, r2, UP));
  });

  it("the mirror has teeth: a streak-0 weight is non-zero in the lens too", async function () {
    // A streak-0 prediction's bare curve term is exactly 0 (multiplier 0). If the
    // lens ever loses the dust it would report 0 here, which is the drift this
    // file exists to catch.
    await (await registry.connect(authority).setValue(streamId, 100)).wait();
    await (await satori.connect(bob).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(UP) }])).wait();
    const r = await satori.getCurrentRound();
    const pred = await satori.predictions(bob.address, streamId, r);
    // Dust is the SMALLEST non-zero multiplier; bounties are excluded at the
    // applyBoost call site instead, not by zeroing this.
    expect(pred.multiplier, "streak-0 carries the dust multiplier").to.equal(1n);
    expect(await lens.userWeightByDirection(bob.address, streamId, r, UP)).to.be.gt(0n);
  });
});
