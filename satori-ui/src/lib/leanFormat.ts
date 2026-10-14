/// A named stream's reading: direction and percentage change against the
/// previous observation, never the counter itself. The series is SIGNED net
/// prediction flow, so the divisor is |prev| — divided by a negative prev a rise
/// would read as a fall. No prev, or prev 0, leaves only a direction to give.
export function leanLabel(value: number, prev: number | undefined): string {
  const base = prev ?? 0;
  if (base === 0) return value > 0 ? '▲ up' : value < 0 ? '▼ down' : '— flat';
  const pct = ((value - base) / Math.abs(base)) * 100;
  if (pct === 0) return '— unchanged';
  return pct > 0 ? `▲ +${pct.toFixed(1)}%` : `▼ −${Math.abs(pct).toFixed(1)}%`;
}

/// The lean of one plotted point against the point before it. The window's
/// first row may have a predecessor that was not loaded (`prevOfFirst`); the
/// stream's true first observation has none and gets a direction only.
export function leanAt(
  rows: readonly { value: number | null | undefined }[],
  index: number,
  prevOfFirst?: number,
): string {
  const value = rows[index]?.value ?? 0;
  const prev = index > 0 ? rows[index - 1]?.value ?? undefined : prevOfFirst;
  return leanLabel(value, prev);
}

/// The SIGN of the cumulative flow, for a row that knows no previous
/// observation. Worded apart from leanLabel so '▲' always means "rose since the
/// last reading" and never "net positive".
export function leanSignLabel(value: number): string {
  return value > 0 ? 'leaning up' : value < 0 ? 'leaning down' : 'neutral';
}
