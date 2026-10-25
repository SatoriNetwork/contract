import { predictGate, reopenTime } from './predictGate';

// Mirrors SatoriEngine's predict gate: one prediction per game per address per
// round, with no clock-hour wait across the round boundary.

const ROUND = 41500;
const H0 = ROUND * 24;          // 00:00 UTC of the current round
const NAMED = { valueHour: 0, isNamed: true };
const PLAIN = { valueHour: H0 + 3, isNamed: false };

describe('predictGate — named streams', () => {
  it('offers a never-touched named stream, with no value written yet', () => {
    expect(predictGate(9, NAMED, undefined, ROUND)).toEqual({ active: true });
  });

  it('holds a named stream predicted this round, until the next round opens', () => {
    expect(predictGate(9, NAMED, { roundMade: ROUND }, ROUND)).toEqual({ active: false, reopenHour: H0 + 24 });
  });

  it('offers a named stream predicted late in the previous round (no 24-hour wait)', () => {
    expect(predictGate(9, NAMED, { roundMade: ROUND - 1 }, ROUND)).toEqual({ active: true });
  });

  it('does not wait on the stream being written (no StaleValue mirror for named)', () => {
    const g = predictGate(9, { valueHour: H0 - 30, isNamed: true }, { roundMade: ROUND - 1 }, ROUND);
    expect(g.active).toBe(true);
  });
});

describe('predictGate — plain streams', () => {
  it('the default stream (id 1) is the Sentiment stream "satori", gated like any other Sentiment stream', () => {
    expect(predictGate(1, NAMED, undefined, ROUND).active).toBe(true);
    expect(predictGate(1, NAMED, { roundMade: ROUND }, ROUND).active).toBe(false);
    // Without the stream's record it is left to the preflight.
    expect(predictGate(1, undefined, { roundMade: ROUND }, ROUND).active).toBe(true);
  });

  it('a stream not in the loaded list is left to the preflight', () => {
    expect(predictGate(9, undefined, undefined, ROUND).active).toBe(true);
  });

  it('a never-written stream cannot be predicted (EmptyStream)', () => {
    expect(predictGate(9, { valueHour: 0, isNamed: false }, undefined, ROUND).active).toBe(false);
  });

  it('a written stream with no prediction is active', () => {
    expect(predictGate(9, PLAIN, undefined, ROUND).active).toBe(true);
  });

  it('predicted this round is inactive, until the next round opens', () => {
    expect(predictGate(9, PLAIN, { roundMade: ROUND }, ROUND)).toEqual({ active: false, reopenHour: H0 + 24 });
  });

  it('a write in a later round than the prediction is fresh; one in the same round is stale', () => {
    expect(predictGate(9, PLAIN, { roundMade: ROUND - 1 }, ROUND).active).toBe(true);
    const sameRound = { valueHour: (ROUND - 1) * 24 + 20, isNamed: false };
    expect(predictGate(9, sameRound, { roundMade: ROUND - 1 }, ROUND).active).toBe(false);
  });
});

describe('reopenTime', () => {
  it('says only the hour when it is today', () => {
    expect(reopenTime(H0 + 14, H0 + 3)).toBe('14:00 UTC');
    expect(reopenTime(H0 + 9, H0)).toBe('09:00 UTC');
  });

  it('adds the UTC date when it is not today', () => {
    const tomorrow2am = Math.floor(Date.UTC(2026, 9, 15, 2) / 3_600_000);
    expect(reopenTime(tomorrow2am, tomorrow2am - 5)).toBe('02:00 UTC on Oct 15');
  });
});
