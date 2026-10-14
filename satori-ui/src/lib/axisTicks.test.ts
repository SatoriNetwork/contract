// The axis must label values the data actually took.
//
// Owner, 2026-08-22: the predictions chart read -0.1 to 1.1 on the y-axis for a
// series of 0s and 1s. Both numbers are impossible for a prediction count, and
// they came from the 10% domain padding rather than the data.
import { valueTicks } from './axisTicks';

describe('valueTicks', () => {
  it('labels the low and the high, never the padded frame', () => {
    // The exact case: values 0 and 1, padded domain [-0.1, 1.1].
    expect(valueTicks([0, 1], 1)).toEqual([0, 1]);
    expect(valueTicks([0, 1], 1)).not.toContain(-0.1);
    expect(valueTicks([0, 1], 1)).not.toContain(1.1);
  });

  it('includes the current value when it sits clear of both ends', () => {
    expect(valueTicks([0, 50, 100], 50)).toEqual([0, 50, 100]);
  });

  it('drops a current value that would collide with an endpoint', () => {
    // 99 of a 0..100 span is 1% from the top: two labels, one pixel apart.
    expect(valueTicks([0, 100], 99)).toEqual([0, 100]);
  });

  it('drops a current value equal to an endpoint rather than duplicating it', () => {
    expect(valueTicks([0, 1, 0], 1)).toEqual([0, 1]);
    expect(valueTicks([5, 9], 5)).toEqual([5, 9]);
  });

  it('returns one tick for a flat series', () => {
    expect(valueTicks([3, 3, 3], 3)).toEqual([3]);
  });

  it('returns nothing for no data, leaving the chart to its own scale', () => {
    expect(valueTicks([], 0)).toEqual([]);
    expect(valueTicks([NaN, Infinity], 1)).toEqual([]);
  });

  it('handles negatives and returns ascending order', () => {
    expect(valueTicks([-40, 10, -5], -5)).toEqual([-40, -5, 10]);
  });

  it('tolerates a missing current value', () => {
    expect(valueTicks([2, 8])).toEqual([2, 8]);
    expect(valueTicks([2, 8], null)).toEqual([2, 8]);
  });
});
