import { earningGames, canTickNow, nextTickTime } from './round';

describe('earningGames — the set the predictable list is built from', () => {
  it('uses the frozen snapshot once it exists', () => {
    // The normal case, and the one that must not regress: the chain settles
    // against the snapshot, so promising anything else promises unpaid rewards.
    expect(earningGames([1, 2], [1, 2, 3], true)).toEqual([1, 2]);
  });

  it('falls back to the live heap before the snapshot is written', () => {
    // THE DEADLOCK. The snapshot is written by the round's first prediction, so
    // gating the predictable list on it means no stream is offered, so no
    // prediction is made, so the snapshot is never written. Refreshing does not
    // help. This is what took the live dapp out after one quiet round.
    expect(earningGames([], [1], false)).toEqual([1]);
  });

  it('reports nothing when the heap is empty too', () => {
    // A genuinely empty protocol still reads empty — the fallback must not invent
    // a stream to predict on.
    expect(earningGames([], [], false)).toEqual([]);
  });

  it('prefers the frozen set even when it is SMALLER than the live heap', () => {
    // A stream that entered the heap after the snapshot cannot earn this round.
    // ISatoriVoting is explicit about it, and the fallback must not leak it in.
    expect(earningGames([1], [1, 2, 3], true)).toEqual([1]);
  });

  it('prefers the frozen set even when it is EMPTY but written', () => {
    // Snapshot taken with nothing eligible is a real answer, not a missing one.
    // Falling back here would offer streams the round has already excluded.
    expect(earningGames([], [1, 2], true)).toEqual([]);
  });
});

describe('canTickNow / nextTickTime — the three-band cadence guard, before the tap', () => {
  // Mirrors SatoriRegistry._cadenceGuard: cadence is minutes, the ring is
  // hour-keyed, and a wrong band here hands out a guaranteed revert (or holds a
  // button closed that the chain would accept).
  const DAY = 86400;

  it('sub-round cadence waits its full period, with NO slack', () => {
    // Hourly stream, last written at 05:00. The 30-minute slack applies only to
    // round-length-and-above cadences; an hourly tick one second early reverts.
    const T = 20000 * DAY + 5 * 3600;
    const H = Math.floor(T / 3600);
    expect(canTickNow(H, 60, T, T + 3599)).toBe(false);
    expect(canTickNow(H, 60, T, T + 3600)).toBe(true);
    expect(nextTickTime(H, 60, T)).toBe(T + 3600);
  });

  it('always allows the very first tick', () => {
    // A never-ticked stream carries hour 0 and timestamp 0; every band is then
    // satisfied by any present-day clock. Same as on chain: the guards only
    // bind once there is history.
    const now = 20000 * DAY;
    expect(canTickNow(0, 60, 0, now)).toBe(true);
    expect(canTickNow(0, 1440, 0, now)).toBe(true);
    expect(canTickNow(0, 43200, 0, now)).toBe(true);
  });

  it('daily stream written mid-day: the wall-clock gap governs', () => {
    // Written 05:00 on day D. The round turns at midnight, but the gap band
    // (24h minus the 30-minute slack) holds the next write until 04:30 —
    // GUARD_GAP, the band the old round-only model could not see.
    const D = 20000;
    const T = D * DAY + 5 * 3600;
    const H = D * 24 + 5;
    const legal = T + DAY - 1800; // 04:30 on day D+1
    expect(canTickNow(H, 1440, T, (D + 1) * DAY)).toBe(false); // new round, gap open
    expect(canTickNow(H, 1440, T, legal - 1)).toBe(false);
    expect(canTickNow(H, 1440, T, legal)).toBe(true);
    expect(nextTickTime(H, 1440, T)).toBe(legal);
  });

  it('daily stream written at midnight: the round boundary governs', () => {
    // The gap band would clear at 23:30 the same day, but one write per round
    // is the promise — GUARD_ROUNDS holds it to the next midnight.
    const D = 20000;
    const T = D * DAY;
    const H = D * 24;
    expect(canTickNow(H, 1440, T, T + DAY - 1800)).toBe(false); // 23:30, same round
    expect(canTickNow(H, 1440, T, (D + 1) * DAY - 1)).toBe(false);
    expect(canTickNow(H, 1440, T, (D + 1) * DAY)).toBe(true);
    expect(nextTickTime(H, 1440, T)).toBe((D + 1) * DAY);
  });

  it('holds a weekly stream for its whole period', () => {
    const D = 20000;
    const T = D * DAY;
    const H = D * 24;
    expect(canTickNow(H, 10080, T, (D + 7) * DAY - 1)).toBe(false);
    expect(canTickNow(H, 10080, T, (D + 7) * DAY)).toBe(true);
  });

  it('a cadence between round multiples waits for the LATER round (ceil)', () => {
    // 25h (1500 min): the gap clears after 25h, but ceil(25h / 24h) = 2 rounds,
    // so the round band holds the write until day D+2. Off-by-one here would
    // re-enable the button a whole round early.
    const D = 20000;
    const T = D * DAY;
    const H = D * 24;
    expect(nextTickTime(H, 1500, T)).toBe((D + 2) * DAY);
    expect(canTickNow(H, 1500, T, T + 1500 * 60)).toBe(false); // 25h later, round 1 of 2
    expect(canTickNow(H, 1500, T, (D + 2) * DAY)).toBe(true);
  });
});
