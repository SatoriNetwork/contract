import { StreamValueDisplay } from './streamAdapterUI';

// ONE place that decides how a stream's stored value is presented, and what
// that means for the UP/DOWN buttons.
//
// The problem it solves: a Uniswap stream stores a raw TICK, because price is
// `1.0001^tick` — monotonic, so direction survives with no fixed-point maths in
// Solidity. Correct for scoring, unreadable for a person, and for many pools the
// readable orientation runs BACKWARDS against the tick.
//
// Base Sepolia's WETH/USDC pool, measured:
//
//   tick 213000  ->  0.00185741 WETH per USDC  ->  538.38 USDC per WETH
//   tick 213397  ->  0.00185034 WETH per USDC  ->  540.44 USDC per WETH
//
// The pool's own orientation rises with the tick. The readable one falls. So
// displaying the readable number means everything downstream of it has to
// invert too — the chart line, the sentiment bars, and the direction a button
// press submits. Get one of those wrong and a user reading the chart presses UP
// and the chain records the opposite. That is why this lives in one module with
// one flag rather than as five separate flips.
//
// The chain is untouched. It always scores the tick; only the presentation and
// the button mapping change.

export interface StreamOrientation {
  /// The stored value is a Uniswap tick and we know the pool's token pair, so it
  /// can be shown as a price at all.
  isTick: boolean;
  /// The pool's native price (token1 per token0) is below 1, so the readable
  /// quote is the inverse. Everything user-facing flips together when this is on.
  ///
  /// Derived from the POOL — token order is by address and effectively
  /// arbitrary — never from the stream's name. A name is free text: the same pool
  /// could be called "WETH/USDC" or "USDC/WETH" or "my eth thing", and none of
  /// that changes which token is token0.
  inverted: boolean;
  /// What to call the quote, e.g. "USDC per WETH".
  unitLabel: string;
}

export const NEUTRAL: StreamOrientation = { isTick: false, inverted: false, unitLabel: '' };

/// Work out a stream's orientation from its resolved value display.
export function orientationOf(display: StreamValueDisplay | null | undefined): StreamOrientation {
  const tp = display?.tickPrice;
  if (!tp) return NEUTRAL;
  // Native price at tick 0 decides the orientation for the whole pool: the
  // decimal gap dominates any realistic tick range, so this does not flip about
  // as the price moves. Using the live tick instead would let the orientation
  // change mid-chart, which would be far worse than an awkward unit.
  const nativeAtParity = Math.pow(10, tp.decimals0 - tp.decimals1);
  const inverted = nativeAtParity < 1;
  return {
    isTick: true,
    inverted,
    unitLabel: inverted
      ? `${tp.symbol0} per ${tp.symbol1}`
      : `${tp.symbol1} per ${tp.symbol0}`,
  };
}

/// The number to SHOW and to PLOT for a stored tick.
///
/// Returns null when the stream is not a tick stream, so callers keep rendering
/// the raw value exactly as before.
///
/// The chart plots this too, not the tick. That is the whole point: if the line
/// were drawn from ticks while the labels showed an inverted price, the line
/// would climb as the numbers fell.
export function displayValueOf(
  tick: number,
  display: StreamValueDisplay | null | undefined,
): number | null {
  const tp = display?.tickPrice;
  if (!tp || !Number.isFinite(tick)) return null;
  const native = Math.pow(1.0001, tick) * Math.pow(10, tp.decimals0 - tp.decimals1);
  if (!Number.isFinite(native) || native <= 0) return null;
  const o = orientationOf(display);
  const shown = o.inverted ? 1 / native : native;
  return Number.isFinite(shown) ? shown : null;
}

/// Format a display price as a NUMBER — nothing else.
///
/// A stream's value is a number, so it renders as one. The unit ("USDC per WETH")
/// is a property of the stream, not of the reading, and belongs in the label slot
/// beside it — `orientation.unitLabel`. Baking it into the value put a unit on
/// every axis tick and every tooltip, and made the reading read like prose.
export function formatOrientedPrice(value: number): string {
  const digits = Math.abs(value) >= 1 ? 2 : 6;
  return Math.abs(value) >= 1000
    ? value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : value.toFixed(digits);
}

// ---------------------------------------------------------------------------
// Per-stream registry
// ---------------------------------------------------------------------------
// Some surfaces know a stream's resolved display (the chart, the stream list —
// they did the probe). Others know only a streamId and a stored direction (the
// dashboard's Recent Predictions, which comes back game-keyed from chain). Those
// still have to render the direction the user actually pressed, so they need the
// same flag without repeating an RPC probe.
//
// So the probe sites register what they found here and everyone else reads it
// synchronously. Persisted to localStorage because a pool's token decimals are
// immutable — there is no staleness to manage, which is exactly why this is a
// plain forever-cache and not one of chainCache's policies.
//
// Unknown streamId returns NEUTRAL, i.e. render exactly as before. The one gap
// is a first-ever visit that lands on the dashboard before any stream list has
// loaded: those rows read unflipped until the first probe registers. That is
// today's behaviour rather than a new fault, and it cannot affect a submission —
// the submit path never consults the registry, it flips at the press using the
// display it already resolved.

const STORE_KEY = 'satori-stream-orientation-v1';

type TickInfo = NonNullable<StreamValueDisplay['tickPrice']>;

function loadStore(): Record<string, TickInfo> {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

let registry: Record<string, TickInfo> | null = null;

function store(): Record<string, TickInfo> {
  if (registry === null) registry = loadStore();
  return registry;
}

/// Record what a probe found for a stream. Safe to call repeatedly; a stream
/// that turned out not to be a tick stream is recorded as such (absent) and
/// costs nothing.
export function rememberOrientation(
  streamId: number,
  display: StreamValueDisplay | null | undefined,
): void {
  const tp = display?.tickPrice;
  if (!tp) return;
  const s = store();
  const key = String(streamId);
  const prev = s[key];
  // Skip the write when nothing changed, so re-probing a stream on every mount
  // doesn't churn localStorage.
  if (prev && prev.decimals0 === tp.decimals0 && prev.decimals1 === tp.decimals1
      && prev.symbol0 === tp.symbol0 && prev.symbol1 === tp.symbol1) return;
  s[key] = { ...tp };
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(s));
  } catch {
    // Quota or private-mode failure — the in-memory map still serves this session.
  }
}

/// Orientation for a stream by id, for surfaces that never resolved a display.
export function orientationFor(streamId: number | null | undefined): StreamOrientation {
  if (streamId == null) return NEUTRAL;
  const tp = store()[String(streamId)];
  if (!tp) return NEUTRAL;
  return orientationOf({ decimals: 0, unit: 'tick', label: 'tick', tickPrice: tp });
}

/// Test seam — drops both the in-memory map and the persisted copy.
export function resetOrientationRegistry(): void {
  registry = null;
  try {
    localStorage.removeItem(STORE_KEY);
  } catch {
    /* ignore */
  }
}

/// Map a button press to the direction the CHAIN should record.
///
/// 1 = UP, 2 = DOWN, matching SatoriTypes.Prediction.direction.
///
/// When the display is inverted, "the price I can see went up" is "the tick went
/// down", so the press must be inverted on the way out. This is the function
/// that costs money if it disagrees with the chart, which is why it takes the
/// same orientation object the chart does rather than deriving its own.
export function directionToChain(pressed: 1 | 2, o: StreamOrientation): 1 | 2 {
  if (!o.inverted) return pressed;
  return pressed === 1 ? 2 : 1;
}

/// Map a stored direction back to what the user should SEE. Same flip; the
/// inverse of directionToChain, which for a two-value swap is itself.
export function directionToDisplay(stored: number, o: StreamOrientation): number {
  if (!o.inverted) return stored;
  return stored === 1 ? 2 : stored === 2 ? 1 : stored;
}
