// The exact scenario the owner hit on 2026-08-22, translated onto the 24h
// hour-keyed ring (the story happened in the 12h era; the shape is identical,
// only the stamps are absolute HOURS now — round * 24 for stream 1's writes).
//
// Predicted once in round 2, nothing in round 1, then opened the chart during
// round 3 and saw zero for both rounds. On chain at that moment:
//
//   getHistory(1)     -> stamped hour 496488 = 0, hour 496512 = 0
//   currentRound      -> 20689
//   deploymentRound   -> 20687     (496488 = 20687 * 24)
//
// Nothing was lost. The value stamped round N (hour N*24) describes round N-1,
// and round 3's value had never been written because the flush is lazy and
// nobody had predicted in round 3 yet.
//
// HISTORICAL NOTE, so nobody re-adds it. This module also carried a TAIL FILL
// that read `roundPredictionCount(round)` for rounds the lazy flush never
// stamped, and two owner regressions (2026-08-22, 2026-08-26) were fixed in it.
// It was removed on 2026-09-08: the stream stopped carrying a prediction COUNT
// and now carries a 1e18-scaled participation RATIO, so the count was injecting
// values ~18 orders of magnitude too small into the same line. It cannot be
// repaired — the ratio needs `deployedBalance` and the engine exposes no getter
// — so unstamped rounds are now drawn as the gaps they actually are.
import {
  shiftToDescribedRound,
  streamValueDisplayFor,
  DEFAULT_STREAM_ID,
  DEFAULT_STREAM_DISPLAY_NAME,
  DEFAULT_STREAM_VALUE_DISPLAY,
} from './defaultStreamSeries';
import { formatStreamValue } from './streamAdapterUI';

const DEP = 20687;   // deployment ROUND; display round 1
const display = (r: number) => r - DEP + 1;

// What getHistory returns: stamps are absolute hours, round * 24 exactly.
const ON_CHAIN = [
  { value: 0, round: 20687 * 24 },  // genesis seed
  { value: 0, round: 20688 * 24 },  // = round 1's ratio
];

describe('values sit on the round they describe', () => {
  it('drops the genesis seed rather than plotting it before round 1', () => {
    const s = shiftToDescribedRound(ON_CHAIN, DEP);
    expect(s.map((p) => p.round)).not.toContain(DEP - 1);
    expect(s).toHaveLength(1);
  });

  it('puts round 1 on round 1, where it was always zero', () => {
    const s = shiftToDescribedRound(ON_CHAIN, DEP);
    expect(display(s[0].round)).toBe(1);
    expect(s[0].value).toBe(0);
  });

  it('preserves the sentiment fields it is handed', () => {
    const rich = [{ value: 5, round: 20688 * 24, up: 3, down: 2, upCount: 1, downCount: 1 }];
    const [out] = shiftToDescribedRound(rich, DEP);
    expect(out).toMatchObject({ value: 5, round: 20687, up: 3, down: 2, upCount: 1, downCount: 1 });
  });

  it('leaves an unstamped round as a gap rather than inventing a point', () => {
    // Round 2 (20688) was never stamped — nobody predicted in round 3. The
    // series must simply not contain it; the old fill is what made this a
    // wrong-unit point instead of an honest hole.
    const s = shiftToDescribedRound(ON_CHAIN, DEP);
    expect(s.map((p) => p.round)).toEqual([20687]);
  });
});

// The 2026-08-26 regression was "I predicted and the chart showed LESS data".
// The fill is gone, but the property it was fixed to guarantee still has to
// hold, and now holds structurally: the shift is a pure map+filter, so a new
// stamp can only ever add a point.
describe('predicting cannot shrink the series', () => {
  const D = 100;
  const SPARSE = [
    { value: 0, round: 100 * 24 },
    { value: 1, round: 103 * 24 },
  ];

  it('adds a point and removes none when a new round is stamped', () => {
    const before = shiftToDescribedRound(SPARSE, D);
    const after = shiftToDescribedRound([...SPARSE, { value: 2, round: 107 * 24 }], D);
    expect(after.length).toBeGreaterThan(before.length);
    for (const p of before) {
      expect(after.some((q) => q.round === p.round && q.value === p.value)).toBe(true);
    }
  });
});

describe('stream 1 is labelled and formatted as a participation share', () => {
  it('is called Satori Participation, not Satori Predictions', () => {
    expect(DEFAULT_STREAM_DISPLAY_NAME).toBe('Satori Participation');
    expect(DEFAULT_STREAM_DISPLAY_NAME).not.toMatch(/Predictions/);
  });

  it('overrides the null display a Simple stream probe returns', () => {
    expect(streamValueDisplayFor(DEFAULT_STREAM_ID, null)).toBe(DEFAULT_STREAM_VALUE_DISPLAY);
  });

  it('leaves every other stream on whatever its adapter resolved', () => {
    const chainlink = { decimals: 8, unit: 'USD', label: 'ETH / USD' };
    expect(streamValueDisplayFor(2, chainlink)).toBe(chainlink);
    expect(streamValueDisplayFor(2, null)).toBeNull();
  });

  // The bug this exists to prevent: the raw value is a fraction of supply
  // scaled by 1e18, so rendering it undecorated prints a 19-digit integer.
  it('renders the 1e18-scaled ratio as a percentage', () => {
    const d = DEFAULT_STREAM_VALUE_DISPLAY;
    expect(formatStreamValue(BigInt('420000000000000000'), d)).toBe('42 %');   // 42%
    expect(formatStreamValue(BigInt('1000000000000000000'), d)).toBe('100 %'); // everyone
    expect(formatStreamValue(BigInt(0), d)).toBe('0 %');                     // nobody
    expect(formatStreamValue(BigInt('5000000000000000'), d)).toBe('0.5 %');    // a sliver
  });

  it('does not print the raw integer', () => {
    expect(formatStreamValue(BigInt('420000000000000000'), DEFAULT_STREAM_VALUE_DISPLAY))
      .not.toContain('420000000000000000');
  });
});
