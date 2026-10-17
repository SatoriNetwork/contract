import { predictGate, reopenTime } from './predictGate';

// Mirrors SatoriEngine's predict gate; a named game takes one prediction per
// address per 24 clock hours, on top of once per round.

const ROUND = 41500;
const H0 = ROUND * 24;          // 00:00 UTC of the current round
const NOW = H0 + 14;            // 14:xx UTC
const NAMED = { valueHour: 0, isNamed: true };
const PLAIN = { valueHour: H0 + 3, isNamed: false };

describe('predictGate — named streams', () => {
  it('offers a never-touched named stream, with no value written yet', () => {
    expect(predictGate(9, NAMED, undefined, ROUND, NOW)).toEqual({ active: true });
  });

  it('holds a named stream predicted this round, until hour + 24', () => {
    const g = predictGate(9, NAMED, { roundMade: ROUND, hour: H0 + 2 }, ROUND, NOW);
    expect(g).toEqual({ active: false, reopenHour: H0 + 26 });
  });

  it('holds a named stream predicted this round even when the hour is unknown', () => {
    expect(predictGate(9, NAMED, { roundMade: ROUND, hour: null }, ROUND, NOW)).toEqual({ active: false, reopenHour: undefined });
  });

  it('holds a named stream predicted 23 hours ago in the previous round, and says when it reopens', () => {
    const hour = NOW - 23;
    const g = predictGate(9, NAMED, { roundMade: ROUND - 1, hour }, ROUND, NOW);
    expect(g).toEqual({ active: false, reopenHour: NOW + 1 });
  });

  it('reopens a named stream exactly 24 hours after the last prediction', () => {
    const hour = NOW - 24;
    expect(predictGate(9, NAMED, { roundMade: ROUND - 1, hour }, ROUND, NOW)).toEqual({ active: true });
  });

  it('does not wait on the stream being written (no StaleValue mirror for named)', () => {
    const g = predictGate(9, { valueHour: NOW - 30, isNamed: true }, { roundMade: ROUND - 1, hour: NOW - 30 }, ROUND, NOW);
    expect(g.active).toBe(true);
  });

  it('treats an unknown hour from a previous round as open (the preflight is the backstop)', () => {
    expect(predictGate(9, NAMED, { roundMade: ROUND - 1, hour: null }, ROUND, NOW)).toEqual({ active: true });
  });

  it('ignores an indexer hour older than the chain\'s latest prediction', () => {
    const g = predictGate(9, NAMED, { roundMade: ROUND, hour: NOW - 72 }, ROUND, NOW);
    expect(g).toEqual({ active: false, reopenHour: undefined });
  });
});

describe('predictGate — every other stream, unchanged', () => {
  it('the default stream: active unless predicted this round', () => {
    expect(predictGate(1, { valueHour: 0, isNamed: false }, undefined, ROUND, NOW).active).toBe(true);
    expect(predictGate(1, undefined, { roundMade: ROUND, hour: null }, ROUND, NOW).active).toBe(false);
    expect(predictGate(1, undefined, { roundMade: ROUND - 1, hour: null }, ROUND, NOW).active).toBe(true);
  });

  it('a stream not in the loaded list is left to the preflight', () => {
    expect(predictGate(9, undefined, undefined, ROUND, NOW).active).toBe(true);
  });

  it('a never-written stream cannot be predicted (EmptyStream)', () => {
    expect(predictGate(9, { valueHour: 0, isNamed: false }, undefined, ROUND, NOW).active).toBe(false);
  });

  it('a written stream with no prediction is active', () => {
    expect(predictGate(9, PLAIN, undefined, ROUND, NOW).active).toBe(true);
  });

  it('predicted this round is inactive, with no reopen hour', () => {
    expect(predictGate(9, PLAIN, { roundMade: ROUND, hour: H0 + 1 }, ROUND, NOW)).toEqual({ active: false });
  });

  it('a write in a later round than the prediction is fresh; one in the same round is stale', () => {
    expect(predictGate(9, PLAIN, { roundMade: ROUND - 1, hour: null }, ROUND, NOW).active).toBe(true);
    const sameRound = { valueHour: (ROUND - 1) * 24 + 20, isNamed: false };
    expect(predictGate(9, sameRound, { roundMade: ROUND - 1, hour: null }, ROUND, NOW).active).toBe(false);
  });

  it('ignores the 24h wait off a named stream', () => {
    expect(predictGate(9, PLAIN, { roundMade: ROUND - 1, hour: H0 - 2 }, ROUND, NOW).active).toBe(true);
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
