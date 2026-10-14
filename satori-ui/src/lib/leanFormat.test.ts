import { leanLabel, leanAt, leanSignLabel } from './leanFormat';

// The owner's rule for a named stream: never the raw counter, only the
// direction and the percentage change from the PREVIOUS observation. The
// series is SIGNED (net prediction flow around 0), so the divisor is |prev|,
// and a zero or missing previous point has no percentage to give.

describe('leanLabel', () => {
  it('reports a rise and a fall against |prev| with one decimal', () => {
    expect(leanLabel(674, 600)).toBe('▲ +12.3%');
    expect(leanLabel(581.4, 600)).toBe('▼ −3.1%');
  });

  it('divides by |prev| so a negative base does not flip the sign', () => {
    // -300 -> -150 is a RISE of 50%. Divided by signed prev it would read -50%.
    expect(leanLabel(-150, -300)).toBe('▲ +50.0%');
    expect(leanLabel(-450, -300)).toBe('▼ −50.0%');
  });

  it('says unchanged when the two readings are equal', () => {
    expect(leanLabel(600, 600)).toBe('— unchanged');
    expect(leanLabel(-7, -7)).toBe('— unchanged');
  });

  it('gives only a direction when prev is 0 or absent', () => {
    expect(leanLabel(600, 0)).toBe('▲ up');
    expect(leanLabel(-300, 0)).toBe('▼ down');
    expect(leanLabel(0, 0)).toBe('— flat');
    expect(leanLabel(5, undefined)).toBe('▲ up');
    expect(leanLabel(-5, undefined)).toBe('▼ down');
    expect(leanLabel(0, undefined)).toBe('— flat');
  });

  it('never leaks the raw values', () => {
    const s = leanLabel(650, -300);
    expect(s).toBe('▲ +316.7%');
    expect(s).not.toContain('650');
    expect(s).not.toContain('300');
  });
});

describe('leanAt', () => {
  const rows = [{ value: 0 }, { value: 600 }, { value: -300 }];

  it('reads each row against the row before it', () => {
    expect(leanAt(rows, 1)).toBe('▲ up');
    expect(leanAt(rows, 2)).toBe('▼ −150.0%');
  });

  it('gives the true first observation a direction only', () => {
    expect(leanAt(rows, 0)).toBe('— flat');
    expect(leanAt([{ value: 5 }], 0)).toBe('▲ up');
  });

  it('uses the off-window predecessor for the first plotted row', () => {
    // The ring holds older entries than the chart loads: the window's first
    // row rose from 400, not from nothing.
    expect(leanAt([{ value: 600 }, { value: 300 }], 0, 400)).toBe('▲ +50.0%');
    expect(leanAt([{ value: 600 }, { value: 300 }], 1, 400)).toBe('▼ −50.0%');
  });
});

describe('leanSignLabel', () => {
  it('names the sign of the cumulative flow without the change arrows', () => {
    expect(leanSignLabel(600)).toBe('leaning up');
    expect(leanSignLabel(-1)).toBe('leaning down');
    expect(leanSignLabel(0)).toBe('neutral');
    expect(leanSignLabel(600)).not.toContain('600');
  });
});
