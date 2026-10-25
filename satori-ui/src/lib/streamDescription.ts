import { StreamValueDisplay } from './streamAdapterUI';

// A plain-language "what is this stream?" line for the stream-name tooltip.
// There is no on-chain description field, so this is derived client-side, in
// order of confidence: the default participation stream (bespoke), a Uniswap
// tick pool (pair + averaging window, read from the decoded tickPrice/label),
// any adapter that a descriptor labels (Chainlink et al.), then a bare fallback
// for a custom stream with no descriptor — where the honest answer is that we
// do not know, so we say so and point at who created it.

function shortAddr(a: string): string {
  return a && a.length >= 10 ? `${a.slice(0, 6)}…${a.slice(-4)}` : (a || 'an unknown address');
}

// The averaging window is not decoded as a number anywhere; it survives only as
// text inside the descriptor label ("Uniswap V3 8h TWAP tick"). Pull it back out
// so the description can say "8h average" rather than guessing "half hour".
function twapWindow(label?: string): string | null {
  if (!label) return null;
  const m = label.match(/(\d+)\s*(min(?:ute)?s?|h(?:ours?)?|d(?:ays?)?)\s*TWAP/i);
  if (!m) return null;
  const n = m[1];
  const u = m[2].toLowerCase();
  if (u.startsWith('min')) return `${n}-minute`;
  if (u.startsWith('h')) return `${n}-hour`;
  return `${n}-day`;
}

export interface DescribableStream {
  id: number;
  provider: string;
  isCommunityAdapter: boolean;
  isNamed?: boolean;
}

export function describeStream(
  stream: DescribableStream,
  valueDisplay: StreamValueDisplay | null,
): string {
  // Before the label branch: the named adapter's descriptor does carry a label
  // ("Net prediction flow"), and the generic copy would call it a data feed.
  if (stream.isNamed) {
    return 'A stream that is just a name. Its value is the net prediction flow of Satori '
      + 'predictors on this game — UP adds, DOWN subtracts — so the chart shows its shape '
      + 'only, never a number. You predict whether the rest of the network will lean up or '
      + 'down over the next 24 hours. Pay-out is pari-mutuel: winners are paid from the side '
      + 'that bet against you.';
  }

  const tp = valueDisplay?.tickPrice;
  if (tp) {
    const win = twapWindow(valueDisplay?.label);
    return `${tp.symbol0}/${tp.symbol1} price from a Uniswap V3 pool, taken as a `
      + `${win ?? 'time-weighted'} average${win ? ' (TWAP)' : ''}. Predicting UP means you `
      + 'expect the price to rise over the round.';
  }

  const label = valueDisplay?.label?.trim();
  if (label) {
    const unit = valueDisplay?.unit && valueDisplay.unit !== 'tick' ? ` (in ${valueDisplay.unit})` : '';
    return `${label}${unit} — an external data feed this stream reads each round. `
      + 'Predicting UP means you expect that value to rise.';
  }

  const kind = stream.isCommunityAdapter ? 'community-run' : 'official';
  return `A ${kind} custom stream from ${shortAddr(stream.provider)}. It has no built-in `
    + 'description, so what its number means is up to whoever created it — check the '
    + 'source before predicting.';
}
