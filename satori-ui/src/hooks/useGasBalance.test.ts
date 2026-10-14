import { gasToneClass } from './useGasBalance';

// The gas readout earns attention only by changing colour, so the bands are
// the whole feature: under 15 predictions is urgent, under 30 is a nudge,
// above that is fine. Boundaries are asserted exactly because "less than 15"
// and "15 or more" is precisely the kind of edge that drifts in a refactor.
describe('gasToneClass', () => {
  const red = (n: number | null) => expect(gasToneClass(n)).toMatch(/red/);
  const yellow = (n: number | null) => expect(gasToneClass(n)).toMatch(/yellow/);
  const green = (n: number | null) => expect(gasToneClass(n)).toMatch(/green/);

  it('is red below 15 predictions of gas', () => {
    [0, 1, 14].forEach(red);
  });

  it('is yellow from 15 up to but not including 30', () => {
    [15, 29].forEach(yellow);
  });

  it('is green from 30 up', () => {
    [30, 31, 5000].forEach(green);
  });

  it('is neutral — never an alarm — when the count is unknown', () => {
    // A failed read must not accuse someone of being low on gas.
    expect(gasToneClass(null)).toMatch(/gray/);
    expect(gasToneClass(null)).not.toMatch(/red|yellow|green/);
  });
});
