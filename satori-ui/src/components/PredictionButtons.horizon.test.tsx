import React from 'react';
import { render, screen } from '@testing-library/react';
import { PredictionButtons, formatTargetDuration } from './PredictionButtons';

// The sub-label asks the game's actual question. A prediction's target is a
// KNOWN duration (the game's targetMinutes) from a KNOWN anchor (the moment you
// predict), so "Higher in 24 hours?" is the whole rule — there is no shaded
// "target area" on the chart any more and nothing for the button to point at.
// The old banded/plain wording split (and its blue phrase) is deleted with the
// band itself.

const props = {
  streamId: 1,
  onPredict: () => {},
  onSkip: () => {},
};

describe('the sub-label asks the game\'s question', () => {
  it('asks "Higher in 24 hours?" on the default daily game', () => {
    render(<PredictionButtons {...props} targetMinutes={1440} />);
    expect(screen.getByTestId('btn-up-note').textContent).toBe('Higher in 24 hours?');
    expect(screen.getByTestId('btn-down-note').textContent).toBe('Lower in 24 hours?');
  });

  it('asks in days on a weekly game', () => {
    render(<PredictionButtons {...props} targetMinutes={10080} />);
    expect(screen.getByTestId('btn-up-note').textContent).toBe('Higher in 7 days?');
    expect(screen.getByTestId('btn-down-note').textContent).toBe('Lower in 7 days?');
  });

  it('asks in days on a monthly game', () => {
    render(<PredictionButtons {...props} targetMinutes={43200} />);
    expect(screen.getByTestId('btn-up-note').textContent).toBe('Higher in 30 days?');
  });

  it('asks in hours on a sub-day game', () => {
    render(<PredictionButtons {...props} targetMinutes={60} />);
    expect(screen.getByTestId('btn-up-note').textContent).toBe('Higher in 1 hour?');
  });

  it('defaults to the 24-hour question while the game meta loads', () => {
    render(<PredictionButtons {...props} />);
    expect(screen.getByTestId('btn-up-note').textContent).toBe('Higher in 24 hours?');
    expect(screen.getByTestId('btn-down-note').textContent).toBe('Lower in 24 hours?');
  });

  it('never promises the value itself will simply move', () => {
    // The old wording ("Value will increase") described a different scoring
    // rule; it must not come back on any horizon.
    render(<PredictionButtons {...props} targetMinutes={10080} />);
    expect(screen.queryByText('Value will increase')).toBeNull();
    expect(screen.queryByText('Value will decrease')).toBeNull();
  });
});

describe('the target-area styling is gone with the band', () => {
  it('renders no blue "target area" phrase on any horizon', () => {
    for (const targetMinutes of [60, 1440, 10080]) {
      const { unmount } = render(<PredictionButtons {...props} targetMinutes={targetMinutes} />);
      expect(screen.queryByTestId('btn-up-target')).toBeNull();
      expect(screen.queryByTestId('btn-down-target')).toBeNull();
      expect(screen.getByTestId('btn-up-note').className).not.toContain('blue');
      expect(screen.getByTestId('btn-down-note').className).not.toContain('blue');
      unmount();
    }
  });

  it('keeps the sentence green on UP and red on DOWN', () => {
    render(<PredictionButtons {...props} targetMinutes={1440} />);
    expect(screen.getByTestId('btn-up-note').className).toContain('text-green-500');
    expect(screen.getByTestId('btn-down-note').className).toContain('text-red-500');
  });

  it('keeps the UP and DOWN words themselves green and red', () => {
    render(<PredictionButtons {...props} targetMinutes={1440} />);
    expect(screen.getByText('UP').className).toContain('green');
    expect(screen.getByText('DOWN').className).toContain('red');
  });
});

describe('formatTargetDuration', () => {
  it('phrases the default game as hours, not "1 day"', () => {
    expect(formatTargetDuration(1440)).toBe('24 hours');
  });
  it('phrases longer horizons in days', () => {
    expect(formatTargetDuration(10080)).toBe('7 days');
    expect(formatTargetDuration(43200)).toBe('30 days');
  });
  it('phrases sub-day horizons in hours', () => {
    expect(formatTargetDuration(60)).toBe('1 hour');
    expect(formatTargetDuration(360)).toBe('6 hours');
  });
  it('falls back to the 24-hour default when unknown', () => {
    expect(formatTargetDuration(undefined)).toBe('24 hours');
    expect(formatTargetDuration(0)).toBe('24 hours');
  });
});
