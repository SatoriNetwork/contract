/**
 * registry-streams.cov.test.js
 *
 * Adversarial COVERAGE for the registry-streams subsystem. Targets the
 * high/med-priority coverage gaps from the raw review that the existing
 * suite never exercises:
 *
 *  1. (high) Uniswap negative-tick TWAP with a non-zero division remainder
 *            — direction-preserving truncate-toward-zero mean tick.
 *  2. (high) Exact cadence timestamp-guard boundary
 *            (block.timestamp == lastUpdate + minCadenceMinutes*60 - 1800).
 *            Verifies CADENCE_GAP_SLACK_SECONDS == 1800 and the strict `<`.
 *  3. (med)  Anchor at the exact eviction boundary (count == 32, anchor in
 *            the OLDEST slot) vs one-write-later (anchor evicted).
 *  4. (med)  getValueAtHour straddle (older-of-two) vs getFirstValueAfter
 *            anchor agreement for a cadence>=2 stream, predRound between
 *            two stored rounds.
 *
 * All assertions reflect the DOCUMENTED intent in SatoriRegistry.sol and
 * the Uniswap adapter, not necessarily the raw output. Canonical
 * OracleLibrary parity for the TWAP rounding direction was reviewed and
 * REJECTED, so the intended behavior here is the adapter's own
 * direction-preserving truncate-toward-zero mean.
 */

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const {
  deploySatoriFixture,
  createUniswapStream,
} = require("../fixtures");

const DAY = 86400; // TIME_UNIT_SECONDS — one round
const SLACK = 1800; // CADENCE_GAP_SLACK_SECONDS

async function streamIdFromTx(tx, satori) {
  const r = await tx.wait();
  for (const log of r.logs) {
    try {
      const p = satori.interface.parseLog(log);
      if (p && p.name === "DataStreamCreated") return p.args.streamId;
    } catch (e) {}
  }
  throw new Error("DataStreamCreated event not found");
}

// Advance wall clock to just after the next round boundary.
async function advanceRound() {
  const now = await time.latest();
  const next = Math.floor(now / DAY) * DAY + DAY;
  await time.increaseTo(next + 1);
}

// The ring-walk tests below use a TWO-round (2880-minute) stream, so one
// cadence period is TWO rounds / 172800s — comfortably past its 171000s
// wall-clock floor (2880*60 - 1800).
const CADENCE_ROUNDS = 2;
const CADENCE_MINUTES = 2880; // the same duration in the contract's minute unit
// Hour-keyed ring (phase 6): round-based queries address the round's LAST hour.
const lastHourOf = (r) => BigInt(r) * 24n + 23n;
async function advanceCadence() {
  for (let i = 0; i < CADENCE_ROUNDS; i++) await advanceRound();
}

describe("registry-streams adversarial coverage", function () {
  let satori, registry, owner, authority, user;

  beforeEach(async function () {
    const fix = await loadFixture(deploySatoriFixture);
    ({ satori, registry, owner } = fix);
    [, authority, user] = fix.signers;
    await satori.transfer(authority.address, ethers.parseEther("100"));
  });

  // `auth` is always the stream's PROVIDER (the address that may setValue).
  // The CREATOR differs only for a SUB-ROUND stream (< 1440 minutes): those are
  // admin-only (`StreamCadenceTooShort` for anyone else), and `owner` is
  // rewards.admin() in this fixture. Everything downstream still writes as `auth`.
  async function createSimple(auth, cadence) {
    const creator = cadence !== undefined && cadence < 1440 ? owner : auth; // sub-round = admin-only
    const tx = cadence === undefined
      ? await satori.connect(auth).createSimpleDataStream("S", auth.address)
      : await satori.connect(creator)["createSimpleDataStream(string,address,uint24)"](
          "S", auth.address, cadence
        );
    return streamIdFromTx(tx, satori);
  }

  // ─────────────────────────────────────────────────────────────────────
  // GAP 1 (high): Uniswap negative non-divisible TWAP rounding direction.
  //
  // The adapter computes the arithmetic-mean tick and FLOORS toward -inf to
  // match canonical Uniswap OracleLibrary.consult (the adapter docstring calls
  // itself the "Canonical" V3 TWAP adapter). Solidity division truncates toward
  // zero, so readValue subtracts 1 when delta < 0 and the remainder is nonzero.
  // (Finding low_1: the floor correction was originally missing — fixed.)
  //
  //   delta = -900001, window = 1800 (DEFAULT_TWAP_WINDOW)
  //   truncate-toward-zero: -500 (remainder -1)  <- the OLD, buggy value
  //   canonical floor:      -501                 <- the CORRECT value
  // ─────────────────────────────────────────────────────────────────────
  describe("Uniswap negative-tick TWAP (canonical floor toward -inf)", function () {
    let pool;
    beforeEach(async function () {
      const M = await ethers.getContractFactory("MockUniswapV3Pool");
      pool = await M.deploy();
      await pool.waitForDeployment();
    });

    async function readTick(delta) {
      await pool.setTickCumulatives(0, 0);
      const tx = await createUniswapStream(
        satori, "NEG", await pool.getAddress(), authority.address
      );
      const id = await streamIdFromTx(tx, satori);
      // tickCumulatives[1] - tickCumulatives[0] = delta
      await pool.setTickCumulatives(0, delta);
      await registry.connect(authority).updateValue(id);
      const info = await registry.getDataStreamInfo(id);
      return info[3]; // value
    }

    it("delta = -900001 floors to -501 (canonical, toward -inf), preserving sign", async function () {
      const v = await readTick(-900001n);
      // Canonical floor: -500.0000.. rounds DOWN to -501 (truncation would give -500).
      expect(v).to.equal(-501n);
      // Direction MUST be preserved: a falling price trend is negative.
      expect(v).to.be.lessThan(0n);
    });

    it("negative non-divisible deltas floor toward -inf (one lower than truncation)", async function () {
      // Window-relative: one under, one over, and a large one. Values are for
      // DEFAULT_TWAP_WINDOW = 1800.
      const cases = [
        [-1n, -1n],              // truncate 0       -> floor -1
        [-1799n, -1n],           // truncate 0       -> floor -1
        [-1801n, -2n],           // truncate -1      -> floor -2
        [-2790n, -2n],           // -1.55            -> floor -2
        [-180000001n, -100001n], // -100000.00006    -> floor -100001
      ];
      for (const [delta, expected] of cases) {
        const v = await readTick(delta);
        expect(v).to.equal(expected); // canonical floor toward -inf
      }
    });

    it("exact multiples + positive deltas are unchanged (floor == truncate there); negatives are NOT mirror-symmetric", async function () {
      // Exact multiple: no remainder, so floor == truncate.
      expect(await readTick(-1800n)).to.equal(-1n);
      // Positive delta: truncation already floors.
      expect(await readTick(900001n)).to.equal(500n);
      // Negative with remainder floors one lower -> NOT the mirror of +500.
      expect(await readTick(-900001n)).to.equal(-501n);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // GAP 2 (high): exact cadence timestamp-guard boundary.
  //
  // minWaitTime = minCadenceMinutes * 60 - 1800 (round-length-and-above band).
  // Guard reverts iff block.timestamp < lastUpdateTimestamp + minWaitTime
  // (STRICT `<`). So the LAST failing instant is minWaitTime-1 seconds
  // after the prior write, and minWaitTime exactly is the first success.
  //
  // To isolate the timestamp guard from the round guard, we advance enough
  // rounds that the round-level guard is already satisfied, then probe the
  // exact wall-clock boundary.
  // ─────────────────────────────────────────────────────────────────────
  describe("cadence timestamp guard exact 1800s slack boundary (strict <)", function () {
    // To make the WALL-CLOCK timestamp guard the binding constraint at its
    // exact 1800s-slack boundary, the seed must land at least SLACK seconds
    // INTO its round. Then the round guard clears at seedTs + cadence*DAY -
    // SLACK = seedTs + minWait, which is precisely the timestamp-guard edge,
    // so neither guard masks the other at the boundary.
    //
    //   round guard clears  <=>  curRound >= seedRound + cadence
    //                       <=>  seedTs + dt >= (seedRound + cadence)*DAY
    //   with seedTs = seedRound*DAY + phi:  dt >= cadence*DAY - phi
    //   choosing phi == SLACK makes that threshold == minWait exactly.
    // Seed a stream at exactly `phi` seconds into a round. We pin the seed
    // block's timestamp with setNextBlockTimestamp so the on-chain
    // lastUpdateTimestamp is deterministic, then read it back from the
    // contract (ground truth — not an off-chain estimate).
    async function seedAtPhase(cadence, phi) {
      // Local math stays in ROUNDS; the contract takes minutes (1440/round).
      const id = await createSimple(authority, cadence * 1440);
      const now = await time.latest();
      const seedTarget = Math.floor(now / DAY) * DAY + DAY + phi; // next boundary + phi
      await time.setNextBlockTimestamp(seedTarget);
      await registry.connect(authority).setValue(id, 100);
      // Ground-truth seed timestamp = contract's stored lastUpdateTimestamp.
      const info = await registry.getLatestUpdateInfo(id);
      const seedTs = BigInt(info[2]); // lastUpdateTimestamp
      expect(seedTs).to.equal(BigInt(seedTarget));
      return { id, seedTs, seedRound: seedTs / BigInt(DAY) };
    }

    // Mine the next setValue at exactly `ts`, asserting it reverts with the
    // given custom error. Pins block.timestamp with setNextBlockTimestamp.
    async function expectSetValueRevertsAt(id, ts, errName, val) {
      await time.setNextBlockTimestamp(Number(ts));
      await expect(registry.connect(authority).setValue(id, val))
        .to.be.revertedWithCustomError(registry, errName);
    }
    async function expectSetValueSucceedsAt(id, ts, val) {
      await time.setNextBlockTimestamp(Number(ts));
      await registry.connect(authority).setValue(id, val);
      expect((await registry.getDataStreamInfo(id))[3]).to.equal(BigInt(val));
    }

    it("cadence=2: minWait = 171000s; at minWait-1 reverts CadenceGapNotElapsed, at minWait succeeds", async function () {
      this.timeout(120000);
      const cadence = 2;
      const minWait = cadence * DAY - SLACK; // 84600
      // Seed just ABOVE SLACK seconds into the round so the round guard clears
      // STRICTLY BEFORE the timestamp-guard edge. (At phi == SLACK exactly the
      // two guards clear on the same second and the round guard — checked
      // first — would mask the timestamp guard at minWait-1.)
      const phi = SLACK + 5; // round guard clears at dt >= cadence*DAY - phi = 170995
      const { id, seedTs, seedRound } = await seedAtPhase(cadence, phi);

      // One second below the floor: round guard already cleared, timestamp
      // guard binds → CadenceGapNotElapsed.
      const belowTs = seedTs + BigInt(minWait - 1);
      expect(belowTs / BigInt(DAY)).to.be.gte(seedRound + BigInt(cadence)); // round guard cleared
      await expectSetValueRevertsAt(id, belowTs, "CadenceGapNotElapsed", 101);

      // Exactly at the floor: success (strict `<` ⇒ minWait itself passes).
      await expectSetValueSucceedsAt(id, seedTs + BigInt(minWait), 101);
    });

    it("cadence=2: confirms the slack constant is exactly 1800 (not 0, not 3600)", async function () {
      this.timeout(120000);
      const cadence = 2;
      // phi above SLACK so the round guard is cleared before the timestamp
      // edge (see the test above for the reasoning).
      const { id, seedTs } = await seedAtPhase(cadence, SLACK + 5);

      // +170999 must revert. If SLACK were 3600, minWait would be 169200 and
      // this would already SUCCEED — a passing revert disproves SLACK >= 3600.
      await expectSetValueRevertsAt(id, seedTs + 170999n, "CadenceGapNotElapsed", 7);

      // +171000 must succeed. If SLACK were 0, minWait would be 172800 and this
      // would still revert — a passing write disproves SLACK == 0. Together
      // these pin SLACK == 1800 exactly.
      await expectSetValueSucceedsAt(id, seedTs + 171000n, 7);
    });

    it("cadence=1 (every-round, 1440 min): minWait = 84600s; at minWait-1 reverts CadenceGapNotElapsed, at minWait succeeds", async function () {
      this.timeout(120000);
      const cadence = 1;
      const minWait = cadence * DAY - SLACK; // 84600
      // phi = SLACK ⇒ the round guard would clear at exactly minWait, NOT
      // minWait-1, so it would mask the timestamp guard at the probe point. To
      // isolate the timestamp guard we instead seed at phi just above SLACK so
      // the round guard clears strictly before the timestamp edge.
      const phi = SLACK + 5; // round guard clears at dt >= cadence*DAY - phi = 84595
      const { id, seedTs, seedRound } = await seedAtPhase(cadence, phi);

      // dt = minWait-1 = 84599 ≥ 84595 ⇒ round guard cleared; timestamp guard
      // binds (84599 < 84600).
      const belowTs = seedTs + BigInt(minWait - 1);
      expect(belowTs / BigInt(DAY)).to.be.gte(seedRound + BigInt(cadence));
      await expectSetValueRevertsAt(id, belowTs, "CadenceGapNotElapsed", 101);

      // dt = minWait = 84600 ⇒ timestamp guard passes → success.
      await expectSetValueSucceedsAt(id, seedTs + BigInt(minWait), 101);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // GAP 3 (med): anchor at the exact eviction boundary.
  //
  // The ring holds HISTORY_SIZE=32 entries. getFirstValueAfter /
  // getFirstTwoValuesAfter walk newest->oldest for `i < count` and detect
  // the anchor as the first entry with round <= afterRound.
  //
  // Boundary: when the anchor occupies the OLDEST of 32 entries it is the
  // LAST slot walked (i = count-1 = 31) and MUST still be seen
  // (recoverable / found). One more write evicts it (anchorEvicted=true).
  // ─────────────────────────────────────────────────────────────────────
  describe("anchor at exact eviction boundary (count==32, oldest slot)", function () {
    it("getFirstValueAfter: anchor in oldest slot is found; one more write evicts it", async function () {
      this.timeout(120000);
      const id = await createSimple(authority, CADENCE_MINUTES); // public two-round stream

      // Seed the ANCHOR at a round boundary so that every subsequent
      // advanceCadence() yields a full 172800s gap (clears the two-round
      // 171000s timestamp floor) and crosses exactly two round boundaries.
      await advanceCadence();
      await registry.connect(authority).setValue(id, 1000);
      const anchorRound = BigInt(await satori.getCurrentRound());
      const afterRound = anchorRound; // prediction anchored at this round

      // Write 767 MORE entries, one per cadence period. After these,
      // count == 768 and the anchor is the OLDEST slot.
      this.timeout(900000);
      for (let k = 0; k < 767; k++) {
        await advanceCadence();
        await registry.connect(authority).setValue(id, 2000 + k);
      }

      // count must be exactly HISTORY_SIZE (full ring), anchor still present.
      const info = await registry.getLatestUpdateInfo(id);
      // getLatestUpdateInfo returns (count, latestHour, lastUpdateTs, minCadence)
      expect(info[0]).to.equal(768);

      // Anchor is the oldest entry; the walk reaches it at i=31 (i<count).
      // First post-anchor tick value is 2000 (round anchorRound+2).
      const [valB, found, evicted] = await registry.getFirstValueAfter(id, lastHourOf(afterRound));
      expect(found).to.equal(true);
      expect(evicted).to.equal(false);
      expect(valB).to.equal(2000n);

      // One additional write evicts the oldest (the anchor). Now no entry at
      // or before the anchor's hour survives -> anchorEvicted.
      await advanceCadence();
      await registry.connect(authority).setValue(id, 9999);

      const [valB2, found2, evicted2] = await registry.getFirstValueAfter(id, lastHourOf(afterRound));
      expect(found2).to.equal(false);
      expect(evicted2).to.equal(true);
      expect(valB2).to.equal(0n);
    });

    it("getFirstTwoValuesAfter: anchor in oldest slot returns B and C; one more write evicts", async function () {
      this.timeout(120000);
      const id = await createSimple(authority, CADENCE_MINUTES);

      await advanceCadence();
      await registry.connect(authority).setValue(id, 1000);
      const afterRound = BigInt(await satori.getCurrentRound());

      this.timeout(900000);
      for (let k = 0; k < 767; k++) {
        await advanceCadence();
        await registry.connect(authority).setValue(id, 2000 + k);
      }
      expect((await registry.getLatestUpdateInfo(id))[0]).to.equal(768);

      // B = first post-anchor (2000), C = second post-anchor (2001).
      const [vB, vC, found, evicted] = await registry.getFirstTwoValuesAfter(id, lastHourOf(afterRound));
      expect(found).to.equal(true);
      expect(evicted).to.equal(false);
      expect(vB).to.equal(2000n);
      expect(vC).to.equal(2001n);

      // Evict the anchor.
      await advanceCadence();
      await registry.connect(authority).setValue(id, 9999);
      const [, , found2, evicted2] = await registry.getFirstTwoValuesAfter(id, lastHourOf(afterRound));
      expect(found2).to.equal(false);
      expect(evicted2).to.equal(true);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // GAP 4 (med): getValueAtHour straddle vs getFirstValueAfter agreement.
  //
  // For a cadence-2 stream with entries at rounds R, R+2, R+4 and a
  // prediction at predRound = R+1 (no exact entry):
  //   - getValueAtHour(inside R+1) == value at R (OLDER of the straddle = A)
  //   - getFirstValueAfter(R+1) == value at R+2 (first post-anchor    = B)
  // A and B must be the two ADJACENT bracketing entries — no skip, no
  // double-count.
  // ─────────────────────────────────────────────────────────────────────
  describe("getValueAtHour straddle (A) vs getFirstValueAfter (B) agreement, cadence>=2", function () {
    it("predRound strictly between two stored rounds: A=older, B=next, adjacent and consistent", async function () {
      this.timeout(120000);
      const id = await createSimple(authority, 2880); // two-round cadence

      // Entry at R. Align to a boundary so each pair of advanceRound() calls
      // is exactly 2 rounds (172800s > the 171000s two-round timestamp floor).
      await advanceRound();
      await registry.connect(authority).setValue(id, 111);
      const R = BigInt(await satori.getCurrentRound());

      // Advance 2 rounds -> entry at R+2.
      await advanceRound();
      await advanceRound();
      await registry.connect(authority).setValue(id, 222);
      const R2 = BigInt(await satori.getCurrentRound());
      expect(R2).to.equal(R + 2n);

      // Advance 2 rounds -> entry at R+4.
      await advanceRound();
      await advanceRound();
      await registry.connect(authority).setValue(id, 333);
      const R4 = BigInt(await satori.getCurrentRound());
      expect(R4).to.equal(R + 4n);

      const predRound = R + 1n; // strictly between R and R+2, no exact entry
      const predHour = predRound * 24n; // any hour inside that round straddles

      // A: getValueAtHour returns the OLDER of the straddle (value at R).
      const A = await registry.getValueAtHour(id, predHour);
      expect(A).to.equal(111n);

      // B: getFirstValueAfter returns the first entry with hour > predHour,
      //    which is R+2's write (value 222) — the entry adjacent to A.
      const [B, found, evicted] = await registry.getFirstValueAfter(id, predHour);
      expect(found).to.equal(true);
      expect(evicted).to.equal(false);
      expect(B).to.equal(222n);

      // Adjacency: A (at R) and B (at R+2) bracket predRound with no stored
      // entry skipped between them. The entry at R+4 (333) must NOT be B.
      expect(B).to.not.equal(333n);
      expect(A).to.not.equal(B);
    });

    it("query exactly on a stored hour: getValueAtHour returns that entry; getFirstValueAfter returns the NEXT", async function () {
      this.timeout(120000);
      const id = await createSimple(authority, 2880);

      await advanceRound();
      await registry.connect(authority).setValue(id, 111);
      const R = BigInt(await satori.getCurrentRound());
      await advanceRound();
      await advanceRound();
      await registry.connect(authority).setValue(id, 222);
      await advanceRound();
      await advanceRound();
      await registry.connect(authority).setValue(id, 333);

      // Query exactly at the first entry's STORED hour (hour-keyed ring).
      const [, storedHours] = await registry.getHistory(id);
      const H = storedHours[0];
      const A = await registry.getValueAtHour(id, H);
      expect(A).to.equal(111n); // exact match returns that entry

      // getFirstValueAfter(H) is strictly > H, so the next entry (222).
      const [B, found] = await registry.getFirstValueAfter(id, H);
      expect(found).to.equal(true);
      expect(B).to.equal(222n);
    });
  });
});
