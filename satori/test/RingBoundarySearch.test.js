// Characterization tests for the ring's three scoring readers:
// getValueAtHour, getFirstValueAfter, getFirstTwoValuesAfter.
//
// Written 2026-09-06 before the phase-3 lookup rewrite and converted to the
// phase-6 HOUR-keyed ring: entries record the hour they landed in, queries
// take hours, and the ring holds 768 entries. Every edge is pinned: hour
// gaps (missed samples), ring wraparound, anchor eviction, queries beyond
// the newest entry, and the minimal two-entry ring. A JS reference model
// derived from getHistory() checks the whole surface, so the contract's
// answer is compared against the definition ("anchor = last entry at or
// before; B = first strictly after; C = next") rather than against the
// implementation's shape.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture } = require("./fixtures");

const HOUR = 3600;
const RING = 768;

describe("Ring boundary search (scoring readers)", function () {
  let satori, registry, owner, provider;

  beforeEach(async function () {
    const fix = await deploySatoriFixture();
    ({ satori, registry, owner } = fix);
    provider = fix.signers[1];
  });

  // Create an HOURLY stream (publicly creatable — the 60-minute registry
  // floor is the only cadence rule now) and write `deltas.length` values,
  // one per listed hour offset, advancing time so each lands in its own
  // hour. `deltas` must be strictly increasing hour offsets.
  async function streamWithHours(deltas, values) {
    const tx = await satori["createSimpleDataStream(string,address,uint24)"](
      "RING", provider.address, 60);
    const r = await tx.wait();
    let sid;
    for (const log of r.logs) {
      try {
        const p = registry.interface.parseLog(log);
        if (p && p.name === "DataStreamCreated") { sid = p.args.streamId; break; }
      } catch {}
    }
    let prev = -1;
    for (let i = 0; i < deltas.length; i++) {
      const jump = deltas[i] - prev;
      await time.increase(HOUR * jump + 1);
      prev = deltas[i];
      await registry.connect(provider).setValue(sid, values[i]);
    }
    return sid;
  }

  // JS reference model from getHistory(): the definition, not the walk.
  async function model(sid) {
    const [values, rounds] = await registry.getHistory(sid);
    const entries = values.map((v, i) => ({ v: BigInt(v), r: Number(rounds[i]) }));
    return {
      entries,
      valueAtRound(q) {
        let last = null;
        for (const e of entries) if (e.r <= q) last = e;
        return last ? last.v : 0n;
      },
      firstAfter(q) {
        const post = entries.filter((e) => e.r > q);
        const anchorExists = entries.some((e) => e.r <= q);
        if (entries.length < 2) return { v: 0n, found: false, evicted: false };
        if (!anchorExists) return { v: 0n, found: false, evicted: true };
        if (post.length < 1) return { v: 0n, found: false, evicted: false };
        return { v: post[0].v, found: true, evicted: false };
      },
      firstTwoAfter(q) {
        const post = entries.filter((e) => e.r > q);
        const anchorExists = entries.some((e) => e.r <= q);
        if (entries.length < 2) return { b: 0n, c: 0n, found: false, evicted: false };
        if (!anchorExists) return { b: 0n, c: 0n, found: false, evicted: true };
        if (post.length < 2) return { b: 0n, c: 0n, found: false, evicted: false };
        return { b: post[0].v, c: post[1].v, found: true, evicted: false };
      },
    };
  }

  async function checkAll(sid, queryRounds) {
    const m = await model(sid);
    for (const q of queryRounds) {
      expect(await registry.getValueAtHour(sid, q), `valueAtHour(${q})`)
        .to.equal(m.valueAtRound(q));
      const [vb, f1, e1] = await registry.getFirstValueAfter(sid, q);
      const w1 = m.firstAfter(q);
      expect([vb, f1, e1], `firstAfter(${q})`).to.deep.equal([w1.v, w1.found, w1.evicted]);
      const [b, c, f2, e2] = await registry.getFirstTwoValuesAfter(sid, q);
      const w2 = m.firstTwoAfter(q);
      expect([b, c, f2, e2], `firstTwoAfter(${q})`).to.deep.equal([w2.b, w2.c, w2.found, w2.evicted]);
    }
  }

  function queriesAround(rounds) {
    const qs = new Set();
    for (const r of rounds) { qs.add(r - 1); qs.add(r); qs.add(r + 1); }
    qs.add(0); qs.add(rounds[rounds.length - 1] + 100);
    return [...qs].filter((q) => q >= 0);
  }

  it("dense history: every boundary, exact hit, straddle, and beyond-newest query", async function () {
    const sid = await streamWithHours([0, 1, 2, 3, 4], [100, 200, 300, 400, 500]);
    const [, rounds] = await registry.getHistory(sid);
    await checkAll(sid, queriesAround(rounds.map(Number)));
  });

  it("gappy history (missed rounds): straddles resolve to the older entry", async function () {
    const sid = await streamWithHours([0, 3, 4, 9, 15], [10, 20, 30, 40, 50]);
    const [, rounds] = await registry.getHistory(sid);
    await checkAll(sid, queriesAround(rounds.map(Number)));
  });

  it("two entries: the minimal scoreable ring", async function () {
    const sid = await streamWithHours([0, 1], [7, 8]);
    const [, rounds] = await registry.getHistory(sid);
    await checkAll(sid, queriesAround(rounds.map(Number)));
  });

  it("one entry: firstAfter variants stay recoverable-false regardless of query", async function () {
    const sid = await streamWithHours([0], [42]);
    await checkAll(sid, [0, 1, 5]);
  });

  it("wrapped ring: RING+8 writes overwrite the oldest 8; evicted anchors are reported", async function () {
    this.timeout(900000);
    const deltas = [];
    const values = [];
    for (let i = 0; i < RING + 8; i++) { deltas.push(i); values.push(1000 + i); }
    const sid = await streamWithHours(deltas, values);
    const [, rounds, count] = await registry.getHistory(sid);
    expect(count).to.equal(RING);
    const kept = rounds.map(Number);
    // Anchors at and before the evicted region:
    const oldestKept = kept[0];
    await checkAll(sid, [oldestKept - 2, oldestKept - 1, oldestKept, ...queriesAround(kept)]);
  });

  it("randomized gappy history matches the reference model everywhere", async function () {
    this.timeout(240000);
    let d = 0;
    const deltas = [];
    const values = [];
    for (let i = 0; i < 20; i++) {
      deltas.push(d);
      values.push(5000 + i * 3);
      d += 1 + ((i * 7 + 3) % 4); // deterministic pseudo-gaps 1..4
    }
    const sid = await streamWithHours(deltas, values);
    const [, rounds] = await registry.getHistory(sid);
    const kept = rounds.map(Number);
    const qs = [];
    for (let q = kept[0] - 2; q <= kept[kept.length - 1] + 2; q++) qs.push(q);
    await checkAll(sid, qs.filter((q) => q >= 0));
  });
});
