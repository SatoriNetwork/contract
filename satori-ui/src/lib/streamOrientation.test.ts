import {
  orientationOf, displayValueOf, directionToChain, directionToDisplay, NEUTRAL,
  rememberOrientation, orientationFor, resetOrientationRegistry,
} from './streamOrientation';
import { StreamValueDisplay } from './streamAdapterUI';

// Numbers are the real Base Sepolia pool 0x94bfc057…, cross-checked against the
// deployed adapter: tick 213397 -> 0.00185034 WETH per USDC -> 540.44 the other
// way round.

/// token0 = USDC (6dp), token1 = WETH (18dp). Native price is tiny, so the
/// readable quote is the inverse and everything flips.
const INVERTED: StreamValueDisplay = {
  decimals: 0, unit: 'tick', label: 'tick',
  tickPrice: { decimals0: 6, decimals1: 18, symbol0: 'USDC', symbol1: 'WETH' },
};

/// The same pair with the token order swapped — which is decided by address, so
/// it is pure luck which way round a given pool is. Native price is already
/// readable, so nothing should flip.
///
/// Note the equivalent tick NEGATES: mirroring a pool is not just swapping the
/// decimals, because the same real price sits at -tick when the tokens trade
/// places. 540 USDC per WETH is tick +213397 in the USDC-first pool and about
/// -213397 in the WETH-first one.
const NOT_INVERTED: StreamValueDisplay = {
  decimals: 0, unit: 'tick', label: 'tick',
  tickPrice: { decimals0: 18, decimals1: 6, symbol0: 'WETH', symbol1: 'USDC' },
};

const PLAIN: StreamValueDisplay = { decimals: 0, unit: 'tick', label: 'tick' };

describe('orientationOf', () => {
  it('flips when the pool prices token1 far below token0', () => {
    const o = orientationOf(INVERTED);
    expect(o).toMatchObject({ isTick: true, inverted: true, unitLabel: 'USDC per WETH' });
  });

  it('does NOT flip a pool that is already readable', () => {
    // The load-bearing half. Flipping unconditionally would break every pool
    // whose token0 happens to be the volatile asset.
    const o = orientationOf(NOT_INVERTED);
    expect(o).toMatchObject({ isTick: true, inverted: false, unitLabel: 'USDC per WETH' });
  });

  it('is neutral for a stream that is not a tick stream', () => {
    expect(orientationOf(PLAIN)).toEqual(NEUTRAL);
    expect(orientationOf(null)).toEqual(NEUTRAL);
  });

  it('does not depend on the current tick', () => {
    // Orientation is fixed per pool. If it were derived from the live price it
    // could flip mid-chart, inverting the axis and the buttons under the user.
    const a = orientationOf(INVERTED);
    expect(orientationOf(INVERTED)).toEqual(a);
  });
});

describe('displayValueOf', () => {
  it('gives the readable price for the inverted pool', () => {
    expect(displayValueOf(213397, INVERTED)!).toBeCloseTo(540.44, 1);
  });

  it('gives the readable price directly when not inverted', () => {
    // Mirrored pool, so the same price lives at the negated tick and needs no
    // flip to read properly.
    expect(displayValueOf(-213397, NOT_INVERTED)!).toBeCloseTo(540.44, 1);
  });

  it('RISES with the tick when not inverted', () => {
    const a = displayValueOf(213000, NOT_INVERTED)!;
    const b = displayValueOf(213397, NOT_INVERTED)!;
    expect(b).toBeGreaterThan(a);
  });

  it('FALLS with the tick when inverted — the fact everything else follows from', () => {
    // 213000 -> 538.38, 213397 -> 540.44 the readable way round... no: inverted
    // means the readable number moves opposite the tick. Pinned explicitly
    // because it is unintuitive and it is why the buttons must flip.
    const a = displayValueOf(213000, INVERTED)!;
    const b = displayValueOf(213397, INVERTED)!;
    expect(b).toBeLessThan(a);
  });

  it('returns null for a non-tick stream so callers render the raw value', () => {
    expect(displayValueOf(213397, PLAIN)).toBeNull();
  });

  it('returns null rather than Infinity for an out-of-range tick', () => {
    // Uniswap ticks live in [-887272, 887272]; beyond that 1.0001^tick overflows.
    expect(displayValueOf(99_999_999, INVERTED)).toBeNull();
  });
});

describe('direction mapping', () => {
  const inv = orientationOf(INVERTED);
  const straight = orientationOf(NOT_INVERTED);

  it('passes the press straight through when nothing is inverted', () => {
    expect(directionToChain(1, straight)).toBe(1);
    expect(directionToChain(2, straight)).toBe(2);
    expect(directionToChain(1, NEUTRAL)).toBe(1);
  });

  it('inverts the press when the display is inverted', () => {
    // Pressing UP on a chart whose numbers fall as the tick rises must record
    // DOWN on chain. This is the function that costs money if it is wrong.
    expect(directionToChain(1, inv)).toBe(2);
    expect(directionToChain(2, inv)).toBe(1);
  });

  it('round-trips: what is shown is what was pressed', () => {
    // The safety property. Whatever a user pressed, reading it back through the
    // display mapping must return the same thing they pressed — otherwise the
    // dashboard would report a prediction they did not make.
    for (const o of [inv, straight, NEUTRAL]) {
      for (const pressed of [1, 2] as const) {
        expect(directionToDisplay(directionToChain(pressed, o), o)).toBe(pressed);
      }
    }
  });

  it('agrees with the chart: a rising DISPLAY means the chain records the winning side', () => {
    // End-to-end sanity on the inverted pool. The display rises when the tick
    // FALLS, so "display went up" is "tick went down" is chain direction 2.
    const before = displayValueOf(213397, INVERTED)!;
    const after = displayValueOf(213000, INVERTED)!;   // lower tick
    expect(after).toBeGreaterThan(before);             // display rose
    expect(directionToChain(1, inv)).toBe(2);          // pressing UP records DOWN
  });

  it('leaves an unknown stored direction alone', () => {
    // 0 = no prediction. Must not become 1 or 2 through the mapping.
    expect(directionToDisplay(0, inv)).toBe(0);
  });
});

describe('per-stream registry', () => {
  beforeEach(() => resetOrientationRegistry());

  it('is neutral for a stream nobody probed', () => {
    // The safe default: unknown means render exactly as before, never guess.
    expect(orientationFor(7)).toEqual(NEUTRAL);
    expect(orientationFor(null)).toEqual(NEUTRAL);
  });

  it('serves an orientation registered by a probe', () => {
    rememberOrientation(7, INVERTED);
    expect(orientationFor(7)).toMatchObject({ inverted: true, unitLabel: 'USDC per WETH' });
  });

  it('keeps streams apart', () => {
    rememberOrientation(7, INVERTED);
    rememberOrientation(8, NOT_INVERTED);
    expect(orientationFor(7).inverted).toBe(true);
    expect(orientationFor(8).inverted).toBe(false);
  });

  it('ignores a display with no pool info, rather than recording a false neutral', () => {
    rememberOrientation(9, PLAIN);
    rememberOrientation(9, null);
    expect(orientationFor(9)).toEqual(NEUTRAL);
  });

  it('persists so a reload does not need the probe again', () => {
    // Pool decimals are immutable, which is the whole reason this may be cached
    // forever rather than through one of chainCache's staleness policies.
    rememberOrientation(7, INVERTED);
    const raw = localStorage.getItem('satori-stream-orientation-v1');
    expect(raw && JSON.parse(raw)['7']).toMatchObject({ decimals0: 6, decimals1: 18 });
  });

  it('does not throw when localStorage is unavailable', () => {
    const spy = jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceeded');
    });
    expect(() => rememberOrientation(11, INVERTED)).not.toThrow();
    // Still correct for this session even though the write failed.
    expect(orientationFor(11).inverted).toBe(true);
    spy.mockRestore();
  });
});

describe('the press-to-chain boundary, as App wires it', () => {
  // Mirrors App.pressPrediction: the flip happens once at the press, and both
  // directions are kept. This test is the contract between the two.
  const press = (pressed: 1 | 2, display: StreamValueDisplay | null) => {
    const o = orientationOf(display);
    return { chain: directionToChain(pressed, o), displayDirection: pressed };
  };

  it('submits the flipped direction but remembers the press', () => {
    expect(press(1, INVERTED)).toEqual({ chain: 2, displayDirection: 1 });
    expect(press(2, INVERTED)).toEqual({ chain: 1, displayDirection: 2 });
  });

  it('leaves an ordinary stream completely untouched', () => {
    expect(press(1, NOT_INVERTED)).toEqual({ chain: 1, displayDirection: 1 });
    expect(press(1, null)).toEqual({ chain: 1, displayDirection: 1 });
  });

  it('the queue renders the press, so the button highlight matches the chart', () => {
    const entry = press(1, INVERTED);
    expect(entry.displayDirection ?? entry.chain).toBe(1); // shows UP, submits DOWN
  });

  it('a dashboard row read back from chain shows what was pressed', () => {
    // The full round trip through the two independent paths: the queue keeps the
    // press locally, the dashboard recovers it from the stored direction.
    rememberOrientation(42, INVERTED);
    const submitted = press(1, INVERTED).chain;
    expect(directionToDisplay(submitted, orientationFor(42))).toBe(1);
    resetOrientationRegistry();
  });
});
