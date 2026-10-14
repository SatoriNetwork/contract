// Verifies the newest-to-oldest scoring walk in SatoriRegistry:
//   - Active-daily path: gas-cheap (early-exit after ~3 iterations).
//   - Eviction path: streak resets to 0 (ring-eviction is the predictor's
//     own inaction).
//   - B-before-C ordering is correct on the ABC scoring path.
//   - AB B lookup returns the smallest-hour post-anchor entry.
//
// Phase 6 (targets-on-games): the registry ring is HOUR-keyed, so the
// getFirstValueAfter / getFirstTwoValuesAfter views take the prediction's
// HOUR (block.timestamp/3600 at predict time), not its pool round. The ring
// is 768 slots, so eviction takes 768+ post-anchor writes.

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture, pack1, voteFor } = require("./fixtures");

const UP = 1;
const ROUND = 86400;
// The hub's default-overload cadence is 1440 minutes (one 24h round); writes
// in the eviction test are spaced two rounds apart to clear the cadence gap
// comfortably.
const CADENCE_ROUNDS = 2;
const CADENCE_SECONDS = ROUND * CADENCE_ROUNDS; // 48h — two rounds per write

async function getStreamId(tx, satori) {
  const rc = await tx.wait();
  for (const log of rc.logs) {
    try {
      const p = satori.interface.parseLog(log);
      if (p && p.name === "DataStreamCreated") return Number(p.args.streamId);
    } catch (_) {}
  }
  throw new Error("DataStreamCreated missing");
}

describe("Scoring-walk direction (newest-to-oldest)", function () {
  it("ABC: B-before-C ordering preserved across many ring entries", async function () {
    this.timeout(120000);
    const fix = await loadFixture(deploySatoriFixture);
    const { satori, registry, owner, signers } = fix;
    const [, alice, bob] = signers;
    const INITIAL = await satori.INITIAL_MINT();
    await satori.transfer(alice.address, INITIAL / 4n);
    await satori.transfer(bob.address, INITIAL / 4n);

    // ABC scoring (phase 6 band 2) runs when cadence <= 1440 and the game's
    // targetMinutes (default 1440 here) < 24*cadence. A 720-minute stream
    // qualifies — and with the public cadence floor deleted, anyone could
    // create it; the owner does so here for convenience.
    const tx = await satori["createSimpleDataStream(string,address,uint24)"]("S", owner.address, 720);
    const sid = await getStreamId(tx, satori);
    await registry.setValue(sid, 1000);
    await voteFor(satori, alice, sid);
    await voteFor(satori, bob, sid);

    // Fill the ring with ~20 entries before the prediction so the anchor
    // is buried mid-ring.
    for (let v = 1100; v < 1100 + 20 * 10; v += 10) {
      await time.increase(ROUND);
      await registry.setValue(sid, v);
    }

    // Predict at the anchor round.
    await time.increase(ROUND);
    await registry.setValue(sid, 5000);  // A
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: sid, payload: pack1(UP) }]);
    // Hour-keyed ring (phase 6): the scoring views take the prediction's
    // HOUR, not its pool round. The predict tx just mined, so time.latest()
    // is its block timestamp.
    const aHour = Math.floor(Number(await time.latest()) / 3600);

    // Set B then C.
    await time.increase(ROUND);
    await registry.setValue(sid, 5100);  // B = 5100
    await time.increase(ROUND);
    await registry.setValue(sid, 5200);  // C = 5200

    // Read getFirstTwoValuesAfter directly and confirm B and C are
    // returned in the correct positions.
    const result = await registry.getFirstTwoValuesAfter(sid, aHour);
    // result is [valueB, valueC, found, anchorEvicted]
    expect(result[2]).to.equal(true, "found");
    expect(result[3]).to.equal(false, "not evicted");
    expect(result[0]).to.equal(5100n, "B is the smaller-hour post-anchor value");
    expect(result[1]).to.equal(5200n, "C is the larger-hour post-anchor value");

    // And settling end-to-end produces a CORRECT prediction (UP wins: C > B).
    await satori.settlePrediction(alice.address, sid);
    expect(await satori.streaks(alice.address, sid)).to.equal(1n);
  });

  it("AB: B is the smallest-round post-anchor entry", async function () {
    this.timeout(120000);
    const fix = await loadFixture(deploySatoriFixture);
    const { satori, registry, owner, signers } = fix;
    const [, alice, bob] = signers;
    const INITIAL = await satori.INITIAL_MINT();
    await satori.transfer(alice.address, INITIAL / 4n);
    await satori.transfer(bob.address, INITIAL / 4n);

    // Next-sample scoring (phase 6 band 3, the old AB outcome) requires
    // cadence > 1440 minutes; 2880 = two 24h rounds. targetMinutes defaults
    // to the cadence, so the target is simply the first post-anchor entry.
    const tx = await satori["createSimpleDataStream(string,address,uint24)"]("S", owner.address, 2880);
    const sid = await getStreamId(tx, satori);
    await registry.setValue(sid, 1000);
    await voteFor(satori, alice, sid);
    await voteFor(satori, bob, sid);

    // Fill ring with ~10 entries so anchor is buried.
    for (let v = 1100; v < 1100 + 10 * 10; v += 10) {
      await time.increase(2 * ROUND);
      await registry.setValue(sid, v);
    }

    // Anchor + predict.
    await time.increase(2 * ROUND);
    await registry.setValue(sid, 5000);
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: sid, payload: pack1(UP) }]);
    // Hour-keyed ring (phase 6): getFirstValueAfter takes the prediction's
    // HOUR (its block timestamp / 3600), not its pool round.
    const aHour = Math.floor(Number(await time.latest()) / 3600);

    // Set B and a few entries after it.
    await time.increase(2 * ROUND);
    await registry.setValue(sid, 5100);  // B should resolve to this
    await time.increase(2 * ROUND);
    await registry.setValue(sid, 5200);  // Later entry — must NOT be returned as B
    await time.increase(2 * ROUND);
    await registry.setValue(sid, 5300);

    const result = await registry.getFirstValueAfter(sid, aHour);
    // result is [valueB, found, anchorEvicted]
    expect(result[1]).to.equal(true);
    expect(result[2]).to.equal(false);
    expect(result[0]).to.equal(5100n, "B is the smallest-hour entry > afterHour");

    // End-to-end: UP wins because 5100 > 5000.
    await satori.settlePrediction(alice.address, sid);
    expect(await satori.streaks(alice.address, sid)).to.equal(1n);
  });

  it("streak resets to 0 when an orphaned prediction force-finalizes via ring-eviction", async function () {
    this.timeout(600000);
    const fix = await loadFixture(deploySatoriFixture);
    const { satori, registry, owner, signers } = fix;
    const [, alice, bob] = signers;
    const INITIAL = await satori.INITIAL_MINT();
    await satori.transfer(alice.address, INITIAL / 4n);
    await satori.transfer(bob.address, INITIAL / 4n);

    // Ring eviction is a property of the ring, not of ABC scoring, so this one
    // runs on the stream a real user gets: the default overload (1440-minute
    // cadence). Every write is CADENCE_SECONDS (2 rounds) apart.
    const tx = await satori.createSimpleDataStream("S", owner.address);
    const sid = await getStreamId(tx, satori);
    await registry.setValue(sid, 1000);
    await voteFor(satori, alice, sid);
    await voteFor(satori, bob, sid);

    // Build alice a small streak first: 3 correct predictions in a row.
    for (let i = 0; i < 4; i++) {
      await time.increase(CADENCE_SECONDS);
      await registry.setValue(sid, 1000 + i * 100);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: sid, payload: pack1(UP) }]);
    }
    // Score the most recent batch via two more setValues + settle.
    await time.increase(CADENCE_SECONDS);
    await registry.setValue(sid, 9000);
    await time.increase(CADENCE_SECONDS);
    await registry.setValue(sid, 9100);
    await satori.settlePrediction(alice.address, sid);
    await satori.settlePrediction(alice.address, sid);
    await satori.settlePrediction(alice.address, sid);

    const streakBefore = await satori.streaks(alice.address, sid);
    expect(streakBefore).to.be.gt(0n);

    // Make ONE more prediction, then walk the ring past it (769 ticks — the
    // ring is 768 slots in phase 6, so eviction takes 768+ post-anchor writes)
    // without ever settling it. Bob keeps the stream actively updated, so
    // this is RING-EVICTION (the anchor is pushed out while the stream keeps
    // producing) — the predictor's own inaction, not stream silence.
    await time.increase(CADENCE_SECONDS);
    await registry.setValue(sid, 9200);
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: sid, payload: pack1(UP) }]);

    for (let i = 0; i < 769; i++) {
      await time.increase(CADENCE_SECONDS);
      await registry.setValue(sid, 10000 + i * 10);
    }

    // Now alice predicts again, triggering scoring of the orphaned slot.
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: sid, payload: pack1(UP) }]);

    // Ring-eviction is the predictor's inaction → streak resets to 0.
    // (Stale silence would instead preserve it — see
    // RingEvictionStreakReset.test.js.)
    const streakAfter = await satori.streaks(alice.address, sid);
    expect(streakAfter).to.equal(0n, "ring-eviction resets streak");
  });

  it("active-daily scoring is cheap (newest-to-oldest short-circuit)", async function () {
    this.timeout(180000);
    const fix = await loadFixture(deploySatoriFixture);
    const { satori, registry, owner, signers } = fix;
    const [, alice, bob] = signers;
    const INITIAL = await satori.INITIAL_MINT();
    await satori.transfer(alice.address, INITIAL / 4n);
    await satori.transfer(bob.address, INITIAL / 4n);

    // The short-circuit under test is the ABC walk (getFirstTwoValuesAfter), which
    // only runs on a cadence-1 stream, and the gas bound below is calibrated for
    // it. Admin-created every-round stream (see the first test).
    const tx = await satori["createSimpleDataStream(string,address,uint24)"]("S", owner.address, 720);
    const sid = await getStreamId(tx, satori);
    await registry.setValue(sid, 1000);
    await voteFor(satori, alice, sid);
    await voteFor(satori, bob, sid);

    // Fill ring with 32 entries to maximize the worst-case walk-cost
    // for the old oldest-to-newest direction.
    for (let i = 0; i < 31; i++) {
      await time.increase(ROUND);
      await registry.setValue(sid, 1100 + i * 10);
    }
    // Alice predicts (her anchor is buried 30 deep in the ring).
    await time.increase(ROUND);
    await registry.setValue(sid, 5000);
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: sid, payload: pack1(UP) }]);

    // Set B and C, then settle. With newest-to-oldest, the walk finds
    // C → B → anchor in 3 iterations regardless of how many entries the
    // ring already holds.
    await time.increase(ROUND);
    await registry.setValue(sid, 5100);
    await time.increase(ROUND);
    await registry.setValue(sid, 5200);

    const tx2 = await satori.settlePrediction(alice.address, sid);
    const rc = await tx2.wait();
    console.log(`    settle gas (anchor buried 30 deep in full ring): ${Number(rc.gasUsed).toLocaleString()}`);
    // Loose sanity: should be well under what an O(32-walk) would cost
    // (~+60-120k over the short-circuit). Bound raised 180k -> 220k for
    // phase 2: the settle path now crosses four child PROXIES (registry/
    // games/rewards/bounties), ~10k of uniform delegatecall overhead —
    // measured 190,233 post-conversion.
    //
    // Raised again to 240k under burn voting. Governance is now SAME-round
    // (`eligibilityRound(r) === r`), so this settle actually credits a reward
    // where the old one-round-ahead rule left the game with no governing-round
    // weight and paid nothing — the extra gas is the reward SSTOREs, not extra
    // ring walking. Measured 232,118.
    //
    // 240k -> 260k for loyalty weighting
    // (docs/design/delegation-loyalty-weighting.md). The settle path now also
    // counts the round's win (`_roundWins`) and reads the predict-time weight
    // pin, and this scenario's predictor has delegators, so it walks the
    // loyalty accumulator too. Measured 248,777 — a ~7% rise, still far below
    // the O(32-walk) regression this bound exists to catch. The bound is a
    // short-circuit guard, not a micro-budget.
    //
    // 260k -> 280k for the issuance-indexed emission schedule: a winning score
    // reports to the hub's counter (SatoriHub.noteIssued), ~14k cold in a
    // single-score tx. Measured 270,263 (255,242 without it).
    expect(Number(rc.gasUsed)).to.be.lt(280_000);
  });
});
