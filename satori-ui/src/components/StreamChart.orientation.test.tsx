import React from 'react';
import { render, screen } from '@testing-library/react';
import { StreamChart, type ChartStream } from './StreamChart';
import type { StreamValueDisplay } from '../lib/streamAdapterUI';

// Renders the chart's plain-DOM surfaces (header value, change, sentiment
// summary). The recharts plot itself has no dimensions in jsdom, so the bars
// can't be asserted directly — but the sentiment summary is driven by the SAME
// chartData row the bars are, so it proves the side swap landed.

/// Base Sepolia's real pool: token0 = USDC (6dp), token1 = WETH (18dp), so the
/// readable quote is the inverse of the pool's native price and everything flips.
const INVERTED: StreamValueDisplay = {
  decimals: 0, unit: 'tick', label: 'tick',
  tickPrice: { decimals0: 6, decimals1: 18, symbol0: 'USDC', symbol1: 'WETH' },
};

/// Two rounds where the TICK ROSE. The readable price therefore FELL, so a
/// correct chart must show a fall. The two rounds also disagree on sentiment, so
/// the swap is observable.
const stream: ChartStream = {
  id: 1,
  name: 'WETH/USDC',
  isEligible: true,
  history: [
    { hour: 2400, value: 213000, up: 10, down: 0, upCount: 1, downCount: 0 },
    { hour: 2424, value: 213397, up: 30, down: 7, upCount: 3, downCount: 1 },
  ],
};

describe('StreamChart on an inverted tick stream', () => {
  it('shows the readable price, not the raw tick', () => {
    render(<StreamChart stream={stream} valueDisplay={INVERTED} />);
    const shown = screen.getByTestId('stream-value').textContent!;
    // The reading is a bare number — ~540, not 213397, and no unit inside it.
    expect(shown).toBe('540.44');
    // The unit sits beside it in its own slot.
    expect(screen.getByTestId('stream-value-unit').textContent).toBe('USDC per WETH');
  });

  it('reports the change in the direction the reader sees', () => {
    // The tick rose 213000 -> 213397. The readable price fell. A green "+" here
    // would be the chart contradicting its own line.
    render(<StreamChart stream={stream} valueDisplay={INVERTED} />);
    const change = screen.getByTestId('stream-change');
    expect(change.textContent).toMatch(/^-/);
    expect(change.className).toContain('text-red-600');
  });

  it('swaps the sentiment sides to match what the reader sees', () => {
    // Latest round had 30 power on a rising TICK and 7 against. To a reader of
    // the inverted price that is 7 UP and 30 DOWN.
    render(<StreamChart stream={stream} valueDisplay={INVERTED} />);
    expect(screen.getByText(/7 UP/)).toBeInTheDocument();
    expect(screen.getByText(/30 DOWN/)).toBeInTheDocument();
  });
});

describe('StreamChart on a plain stream', () => {
  it('is completely unchanged — no inversion, no price conversion', () => {
    // The load-bearing no-regression case: every Simple stream and every
    // non-Uniswap adapter must render exactly as it did before this feature.
    render(<StreamChart stream={stream} valueDisplay={null} />);
    expect(screen.getByTestId('stream-value').textContent).toContain('213');
    // No unit slot at all — nothing to say, so nothing rendered.
    expect(screen.queryByTestId('stream-value-unit')).toBeNull();
    expect(screen.getByTestId('stream-change').className).toContain('text-green-600');
    expect(screen.getByText(/30 UP/)).toBeInTheDocument();
    expect(screen.getByText(/7 DOWN/)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Which moment the reading belongs to, and gaps in the history
// ---------------------------------------------------------------------------
// The default stream stores a value only for rounds in which someone predicted,
// and the value stamped on round N is the number of predictions made in round
// N-1. Both facts made a correct chart look broken: the newest value is often
// not the current round's, and the X axis is indexed by POINT, so two bars days
// apart look adjacent. Rows are HOUR-keyed now (the registry ring is hour-keyed);
// the default stream writes once per 24h round, so its hours step in 24s and the
// quiet rounds simply have no row.

/// Stream 1's stored history, hour-keyed (round N -> hour N*24).
const withGaps: ChartStream = {
  id: 1,
  name: 'Satori Predictions',
  isEligible: true,
  history: [
    { hour: 41333 * 24, value: 0 },
    { hour: 41335 * 24, value: 0 },   // round 41334 has no value
    { hour: 41336 * 24, value: 1 },
    { hour: 41340 * 24, value: 2 },
    { hour: 41342 * 24, value: 0 },   // round 41341 has no value
    { hour: 41343 * 24, value: 1 },
  ],
};

describe('a history with rounds missing', () => {
  // THE "as of round N" LINE WAS REMOVED on 2026-08-22 at the owner's request.
  //
  // Four tests lived here asserting it, and they were not idle: a stream only
  // stores a value for rounds in which it actually UPDATED, so the newest
  // reading is often not the current round's, and the line existed because that
  // had already been reported as confusing once.
  //
  // The information is not gone — every point's round is on the X axis and in
  // its tooltip — but the HEADLINE number no longer names its round. If the
  // "why is this number stale" question comes back, this comment is where the
  // previous answer is buried.
  //
  // Not asserted here that the axis still carries the rounds: recharts has no
  // dimensions in jsdom (see this file's header), so no tick ever renders. A
  // test claiming to check it would be checking nothing.
  it('no longer prints an as-of-round line', () => {
    render(<StreamChart stream={withGaps} />);
    expect(screen.queryByTestId('stream-value-round')).toBeNull();
    expect(screen.queryByText(/as of round/i)).toBeNull();
  });

  // The explanation moved from a "what this counts" link to a "?" sitting with
  // the stream id and badges — where a reader already looks to find out what a
  // stream IS.
  it('offers the explanation as a "?" only when given a note', () => {
    const { unmount } = render(<StreamChart stream={withGaps} />);
    expect(screen.queryByLabelText('What this counts')).toBeNull();
    unmount();
    render(<StreamChart stream={withGaps} valueNote="counts the previous round" />);
    expect(screen.getByLabelText('What this counts')).toBeInTheDocument();
    // The old link text is gone, not merely relocated.
    expect(screen.queryByText(/what this counts/)).toBeNull();
  });
});
