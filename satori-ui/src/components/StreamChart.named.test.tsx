import React from 'react';
import { render, screen } from '@testing-library/react';
import { StreamChart, type ChartStream } from './StreamChart';
import type { StreamValueDisplay } from '../lib/streamAdapterUI';

// A named stream's value is the network's own net prediction flow — a signed
// counter. The owner's rule: the UI must NEVER print it ("Bitcoin: 600" means
// nothing to anyone). The chart keeps its shape; the header shows a lean.
//
// Only the plain-DOM surfaces can be asserted here — recharts has no
// dimensions in jsdom, so the axis and tooltip never render (see
// StreamChart.orientation.test.tsx). Those go through lib/leanFormat, which has
// its own unit test.

/// What NamedStreamAdapter.valueDisplay() returns; left in place on purpose so
/// the test proves the named branch wins over the descriptor's formatter.
const NAMED_DISPLAY: StreamValueDisplay = { decimals: 18, unit: 'SATORI', label: 'Net prediction flow' };

const named = (values: number[]): ChartStream => ({
  id: 9,
  name: 'Bitcoin',
  isEligible: true,
  minCadenceMinutes: 60,
  isNamed: true,
  history: values.map((value, i) => ({ hour: 500000 + i, value })),
});

/// Every text node in the document, so "no number anywhere" is checkable.
const allText = () => document.body.textContent ?? '';

describe('StreamChart on a named stream', () => {
  it('never prints the raw counter', () => {
    render(<StreamChart stream={named([0, 600, -300])} valueDisplay={NAMED_DISPLAY} />);
    expect(allText()).not.toContain('600');
    expect(allText()).not.toContain('300');
    expect(allText()).not.toContain('SATORI');
    expect(screen.queryByTestId('stream-value-unit')).toBeNull();
  });

  it('shows the lean against the previous observation as the reading', () => {
    // 600 -> -300: a 150% fall against |600|.
    render(<StreamChart stream={named([0, 600, -300])} valueDisplay={NAMED_DISPLAY} />);
    const value = screen.getByTestId('stream-value').textContent!;
    expect(value).toBe('▼ −150.0%');
    const change = screen.getByTestId('stream-change');
    expect(change.textContent).toMatch(/vs last hour/);
    expect(change.className).toContain('text-red-600');
  });

  it('gives only a direction when the previous observation was 0', () => {
    render(<StreamChart stream={named([0, 600])} valueDisplay={NAMED_DISPLAY} />);
    expect(screen.getByTestId('stream-value').textContent).toBe('▲ up');
    expect(screen.getByTestId('stream-change').className).toContain('text-green-600');
  });

  it('measures a rise from a negative base as a rise', () => {
    render(<StreamChart stream={named([-300, -150])} valueDisplay={NAMED_DISPLAY} />);
    expect(screen.getByTestId('stream-value').textContent).toBe('▲ +50.0%');
    expect(screen.getByTestId('stream-change').className).toContain('text-green-600');
  });

  it('reads "— flat" on a lone first point and shows no change slot', () => {
    render(<StreamChart stream={named([0])} valueDisplay={NAMED_DISPLAY} />);
    expect(screen.getByTestId('stream-value').textContent).toBe('— flat');
    expect(screen.queryByTestId('stream-change')).toBeNull();
  });

  it('labels the stream as sentiment beside the other badges', () => {
    render(<StreamChart stream={named([0, 600])} valueDisplay={NAMED_DISPLAY} />);
    expect(screen.getByTestId('stream-named-badge').textContent).toBe('sentiment');
  });
});

describe('StreamChart on a non-named stream with the same descriptor shape', () => {
  it('still prints the formatted value — the branch is on isNamed, not on the descriptor', () => {
    const plain = { ...named([0, 600]), isNamed: false };
    render(<StreamChart stream={plain} valueDisplay={{ decimals: 0, unit: 'pts', label: 'Points' }} />);
    expect(screen.getByTestId('stream-value').textContent).toBe('600 pts');
    expect(screen.queryByTestId('stream-named-badge')).toBeNull();
  });

  it('measures the change against |prev| so a fall from a negative base reads as a fall', () => {
    // Custom adapters return int256: -300 -> -450 is a 50% FALL. Divided by
    // the signed prev it printed '+50.00%' in red.
    const plain = { ...named([-300, -450]), isNamed: false };
    render(<StreamChart stream={plain} valueDisplay={{ decimals: 0, unit: 'pts', label: 'Points' }} />);
    const change = screen.getByTestId('stream-change');
    expect(change.textContent).toContain('(-50.00%)');
    expect(change.className).toContain('text-red-600');
  });
});
