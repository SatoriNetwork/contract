/// Fixed-decimal display without trailing zeros: 0.0 -> "0", 50.0 -> "50",
/// 50.1 -> "50.1". For SATORI amounts and quantities where a fixed decimal is
/// noise, not precision. Sub-precision values (dust) belong in formatSatori.
export function trimZeros(value: string | number, decimals = 1): string {
  const n = typeof value === 'string' ? parseFloat(value) : value;
  if (!isFinite(n)) return '0';
  return parseFloat(n.toFixed(decimals)).toString();
}

/// Weight/amount display that never rounds a genuine nonzero value down to
/// "0" — a vote of 0.000101 SATORI is real weight and must not read as a
/// failed vote. Above 0.1 it matches trimZeros (clean fixed decimal); a
/// smaller nonzero value keeps two significant figures so it stays visibly
/// nonzero; exact zero is "0".
export function formatWeight(v: number): string {
  if (!isFinite(v) || v === 0) return '0';
  if (Math.abs(v) >= 0.1) return trimZeros(v);
  return parseFloat(v.toPrecision(2)).toString();
}

/// Balance display that can NEVER show more than the holder actually has.
///
/// Takes the full-precision string from ethers.formatEther and TRUNCATES toward
/// zero to `dp` decimals (default 6), then trims trailing zeros: exactly 50 ->
/// "50", 49.998899 -> "49.998899", 49.9988991234 -> "49.998899". Rounding is
/// forbidden here — toFixed(1) turned 49.9989 into "50.0", overstating funds,
/// which for a wallet balance is never acceptable. String-based, so no float
/// error ever enters. Pair with `fullBalance` for a tap-to-reveal exact view.
export function formatBalance(value: string, dp = 6): string {
  if (!value) return '0';
  const neg = value.startsWith('-');
  const s = neg ? value.slice(1) : value;
  const [intPart, fracRaw = ''] = s.split('.');
  const frac = fracRaw.slice(0, dp).replace(/0+$/, '');
  const out = frac ? `${intPart}.${frac}` : intPart;
  return neg && out !== '0' ? `-${out}` : out;
}

/// Every digit the holder has, trailing zeros trimmed — the tap-to-reveal view.
export function fullBalance(value: string): string {
  if (!value) return '0';
  if (!value.includes('.')) return value;
  const trimmed = value.replace(/0+$/, '').replace(/\.$/, '');
  return trimmed || '0';
}

export function formatCompact(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1e9) return trimZeros(v / 1e9, 2) + 'B';
  if (abs >= 1e6) return trimZeros(v / 1e6, 2) + 'M';
  if (abs >= 1e4) return trimZeros(v / 1e3, 1) + 'K';
  if (abs >= 100) return v.toLocaleString(undefined, { maximumFractionDigits: 0 });
  return v.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

/**
 * Format a SATORI amount for display.
 *
 *   value >= 0.0001 SATORI  → "0.xxxx SATORI" (4 decimals)
 *   0 < value < 0.0001       → switch to micro-SATORI: "X.XX µSAT"
 *   value == 0               → "0 SATORI"
 *
 * The µSAT switch exists so that first-prediction-bypass rewards and other
 * sub-0.0001 dust earnings show as a real, visible number ("72 µSAT")
 * instead of rendering as "0.0000 SATORI" — feedback that the system
 * credited the user something, even when the SATORI amount is microscopic.
 *
 * @param value SATORI amount as a string (from formatEther) or number.
 *              Negatives are supported (rendered with a leading "-").
 */
export function formatSatori(value: string | number): string {
  const n = typeof value === 'string' ? parseFloat(value) : value;
  if (!isFinite(n) || n === 0) return '0 SATORI';
  if (n < 0) return `-${formatSatori(-n)}`;
  if (n >= 0.0001) {
    // TRUNCATE, never round — the same rule the balance obeys. toFixed(4) would
    // round 49.99889 up to "49.9989", overstating what the holder has.
    const truncated = Math.floor(n * 1e4) / 1e4;
    return `${truncated.toFixed(4)} SATORI`;
  }
  // sub-0.0001 SATORI: display in micro-SATORI (µSAT). 1 SATORI = 1e6 µSAT.
  // Precision scales with magnitude: integers above 10, one decimal in
  // [1, 10), two decimals in [0.01, 1), and a "<0.01" guard below.
  const micros = n * 1_000_000;
  if (micros >= 10)  return `${micros.toFixed(0)} µSAT`;
  if (micros >= 1)   return `${micros.toFixed(1)} µSAT`;
  if (micros >= 0.01) return `${micros.toFixed(2)} µSAT`;
  return '<0.01 µSAT';
}

/**
 * Same as `formatSatori`, but split into `{ value, unit }` for components
 * that render the numeric magnitude and the unit separately (e.g. the
 * dashboard stat cards: large bold value above small grey unit).
 */
export function formatSatoriParts(value: string | number): { value: string; unit: string } {
  const s = formatSatori(value);
  const idx = s.lastIndexOf(' ');
  if (idx < 0) return { value: s, unit: 'SATORI' };
  return { value: s.slice(0, idx), unit: s.slice(idx + 1) };
}
