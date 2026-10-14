import React from 'react';
import { render, screen } from '@testing-library/react';
import { StreamChart, type ChartStream } from './StreamChart';

// THE HORIZON BAND IS DELETED (rolling-24h-scoring.md §7.5). A prediction's
// target is a KNOWN duration (the game's targetMinutes) from a KNOWN anchor
// (the moment predicted), so there is no region of the chart to shade and no
// reserved future slots to hang it on. These tests pin that deletion — the
// band's testid must never come back — and check the hour-keyed rows still
// feed the plain-DOM surfaces (header reading, change, sentiment summary),
// which is everything jsdom can see: recharts has no dimensions here, so the
// plot itself never renders (see StreamChart.orientation.test.tsx's header).
//
// The old band/phantom-slot geometry tests lived in StreamChart.band.test.tsx,
// deleted with the feature; the slot arithmetic lived in
// lib/predictionHorizon.ts, also deleted (lib/hourAxis.ts keeps only the
// shared axis-label rule).

const base = (minCadenceMinutes?: number): ChartStream => ({
  id: 1,
  name: 'Satori Predictions',
  isEligible: true,
  minCadenceMinutes,
  // Hour-keyed rows: absolute hours (timestamp / 3600), one day apart.
  history: [
    { hour: 494400, value: 10, up: 5, down: 1, upCount: 2, downCount: 1 },
    { hour: 494424, value: 14, up: 8, down: 3, upCount: 4, downCount: 2 },
  ],
});

describe('the horizon band is gone', () => {
  it('renders no band overlay on the daily default', () => {
    render(<StreamChart stream={base(1440)} targetMinutes={1440} />);
    expect(screen.queryByTestId('horizon-band')).toBeNull();
  });

  it('renders no band on an hourly stream either', () => {
    // The old design banded cadence-1 streams specially; there is no special
    // cadence any more — the wording carries the rule on every stream.
    render(<StreamChart stream={base(60)} targetMinutes={60} />);
    expect(screen.queryByTestId('horizon-band')).toBeNull();
  });

  it('renders no band with an empty history', () => {
    render(<StreamChart stream={{ ...base(1440), history: [] }} />);
    expect(screen.queryByTestId('horizon-band')).toBeNull();
  });
});

describe('hour-keyed rows feed the readings', () => {
  // With the reserved slots gone the tail of the rendered array IS the newest
  // real point again — these keep guarding that the header reads it.
  it('names the newest value', () => {
    render(<StreamChart stream={base(1440)} />);
    expect(screen.getByTestId('stream-value').textContent).toBe('14');
  });

  it('measures the change between the last two points', () => {
    render(<StreamChart stream={base(1440)} />);
    // 14 - 10 = +4 on a base of 10.
    expect(screen.getByTestId('stream-change').textContent).toContain('+4');
    expect(screen.getByTestId('stream-change').textContent).toContain('40.00%');
  });

  it('reports the newest point\'s sentiment', () => {
    render(<StreamChart stream={base(1440)} />);
    expect(screen.getByText(/8 UP/)).toBeInTheDocument();
    expect(screen.getByText(/3 DOWN/)).toBeInTheDocument();
  });

  it('labels the cadence badge from minutes', () => {
    render(<StreamChart stream={base(1440)} />);
    expect(screen.getByText('Daily')).toBeInTheDocument();
  });

  it('labels an hourly cadence as Hourly', () => {
    render(<StreamChart stream={base(60)} />);
    expect(screen.getByText('Hourly')).toBeInTheDocument();
  });
});
