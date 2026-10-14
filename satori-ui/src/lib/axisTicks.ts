// Y-axis ticks for a stream chart: the numbers that are ABOUT the data.
//
// The chart pads its domain by 10% so the line never touches the frame, which
// looks right and stays. But with no explicit ticks, Recharts labels that
// PADDED range — so a stream whose values are all 0 and 1 showed an axis
// reading -0.1 and 1.1, two numbers the data never took and never could
// (a prediction count cannot be negative or fractional). Owner, 2026-08-22.
//
// The fix is to keep the padding and label the real thing: the low, the high,
// and where it is now.

/// Ticks for a padded axis: low, high, and current, in ascending order.
///
/// `current` is dropped when it sits within `minGapRatio` of an endpoint —
/// not to avoid overlap for its own sake, but because two labels a pixel apart
/// are unreadable and the endpoint already tells the reader where the line is.
/// An exact duplicate goes the same way.
///
/// Returns a single tick for a flat series, and [] for no data at all, which
/// leaves Recharts to its own devices rather than drawing a made-up scale.
export function valueTicks(
  values: number[],
  current?: number | null,
  minGapRatio = 0.08,
): number[] {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length === 0) return [];

  const low = Math.min(...finite);
  const high = Math.max(...finite);
  if (low === high) return [low];

  const span = high - low;
  const out = [low, high];

  if (current != null && Number.isFinite(current)) {
    const farFromLow = Math.abs(current - low) >= span * minGapRatio;
    const farFromHigh = Math.abs(high - current) >= span * minGapRatio;
    if (farFromLow && farFromHigh) out.push(current);
  }

  return out.sort((a, b) => a - b);
}
