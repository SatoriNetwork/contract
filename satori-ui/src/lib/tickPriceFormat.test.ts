import { formatStreamValue, StreamValueDisplay } from './streamAdapterUI';

// formatStreamValue's job here is only to DELEGATE to lib/streamOrientation and
// to degrade safely. The conversion and flip rules are pinned in
// streamOrientation.test.ts; duplicating them here would let the two drift.
//
// This replaces tickPrice.test.ts, which asserted the display was NEVER
// inverted. That was right while inversion was display-only: the readable
// orientation moves opposite the tick, so an inverted label with un-flipped
// buttons would have had users predicting against the chart. Inverting became
// correct once the buttons, the plotted line and the sentiment bars flip with it.
const WETH_USDC: StreamValueDisplay = {
  decimals: 0, unit: 'tick', label: 'Uniswap V3 8h TWAP tick',
  tickPrice: { decimals0: 6, decimals1: 18, symbol0: 'USDC', symbol1: 'WETH' },
};

describe('formatStreamValue for tick streams', () => {
  it('renders the readable price with its pair label', () => {
    // A value is a NUMBER. The unit lives in the label slot beside it
    // (orientation.unitLabel), not inside the reading.
    expect(formatStreamValue(213397, WETH_USDC)).toBe('540.44');
  });

  it('falls back to the raw tick when the pool pair is unknown', () => {
    // tickPrice absent = the pool probe failed. The value must still render.
    const noPair: StreamValueDisplay = { decimals: 0, unit: 'tick', label: 'tick' };
    expect(formatStreamValue(213397, noPair)).toBe('213397 tick');
  });

  it('falls back rather than printing Infinity for an out-of-range tick', () => {
    const out = formatStreamValue(99_999_999, WETH_USDC);
    expect(out).not.toMatch(/Infinity|NaN/);
  });

  it('still formats non-tick streams as before', () => {
    expect(formatStreamValue(1234, { decimals: 2, unit: 'USD', label: 'x' })).toContain('USD');
    expect(formatStreamValue(7, null)).toBe('7');
  });
});
