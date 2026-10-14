import { FIRST_CHUNKS, windowStart, nextChunks, isComplete } from './historyWindow';

// The history tab pages by BLOCK SPAN, not by row count — logs are not
// range-addressable by count, so "give me rows 26-50" has no cheap definition.
// See docs/design/dapp-history-tab.md §4.
//
// What these pin is the property the whole scheme rests on: the first paint
// costs a BOUNDED number of eth_getLogs requests no matter how long the contract
// has been live, and widening never re-reads what is already held.

describe('history scan window', () => {
  it('bounds the first window to FIRST_CHUNKS worth of blocks', () => {
    const head = 9_000_000;
    const start = windowStart(FIRST_CHUNKS, head, 1_000_000);
    expect(head - start + 1).toBe(FIRST_CHUNKS * 10_000);
  });

  it('never scans below the deployment block', () => {
    // A young chain: the whole history is smaller than one window. Reading
    // before deployment is not just wasteful, it is meaningless.
    expect(windowStart(FIRST_CHUNKS, 4_000, 500)).toBe(500);
    expect(windowStart(1_000_000, 9_000_000, 1_000_000)).toBe(1_000_000);
  });

  it('is complete exactly when the window has reached deployment', () => {
    expect(isComplete(windowStart(FIRST_CHUNKS, 4_000, 500), 500)).toBe(true);
    expect(isComplete(windowStart(FIRST_CHUNKS, 9_000_000, 1_000_000), 1_000_000)).toBe(false);
  });

  it('grows fast enough that deep history is a few clicks, not a dozen', () => {
    // x4, not x2. Later steps are expensive by construction; that is fine
    // because they are user-initiated, and a user asking for two-year-old
    // history should not have to click eleven times to get there.
    let c = FIRST_CHUNKS;
    const steps = [];
    for (let i = 0; i < 4; i++) { c = nextChunks(c); steps.push(c); }
    expect(steps).toEqual([48, 192, 768, 3072]);
    // ~30M blocks — past genesis on any chain this runs on.
    expect(c * 10_000).toBeGreaterThan(30_000_000);
  });

  it('moves the window strictly backwards as it grows', () => {
    const head = 9_000_000, deploy = 1_000;
    let c = FIRST_CHUNKS;
    let prev = windowStart(c, head, deploy);
    for (let i = 0; i < 3; i++) {
      c = nextChunks(c);
      const next = windowStart(c, head, deploy);
      expect(next).toBeLessThan(prev);
      prev = next;
    }
  });
});
