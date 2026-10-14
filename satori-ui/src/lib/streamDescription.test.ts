import { describeStream } from './streamDescription';
import type { StreamValueDisplay } from './streamAdapterUI';

/// What NamedStreamAdapter.valueDisplay() returns. Without the named branch
/// the label path would describe this as "an external data feed", which is
/// exactly what a named stream is not.
const NAMED_DISPLAY: StreamValueDisplay = { decimals: 18, unit: 'SATORI', label: 'Net prediction flow' };

describe('describeStream for a named stream', () => {
  const stream = { id: 7, provider: '0x0DCd1Bf9A1b36cE34237eEaFef220932846BCD82', isCommunityAdapter: false, isNamed: true };

  it('explains the self-referential counter instead of calling it a data feed', () => {
    const s = describeStream(stream, NAMED_DISPLAY);
    expect(s).toMatch(/just a name/i);
    expect(s).toMatch(/net prediction flow/i);
    expect(s).toMatch(/UP adds/i);
    expect(s).toMatch(/DOWN subtracts/i);
    expect(s).not.toMatch(/external data feed/i);
  });

  it('says the chart is shape only, what you predict, and that pay-out is pari-mutuel', () => {
    const s = describeStream(stream, NAMED_DISPLAY);
    expect(s).toMatch(/shape/i);
    expect(s).toMatch(/lean up or down over the next 24 hours/i);
    expect(s).toMatch(/pari-mutuel/i);
    expect(s).toMatch(/side that bet against you/i);
  });

  it('wins over the descriptor label even when one is present', () => {
    expect(describeStream(stream, NAMED_DISPLAY)).not.toMatch(/Net prediction flow \(in SATORI\)/);
  });
});

describe('describeStream for everything else', () => {
  it('still uses the descriptor label for a labelled adapter stream', () => {
    const s = describeStream(
      { id: 3, provider: '0xabc', isCommunityAdapter: false },
      { decimals: 8, unit: 'USD', label: 'BTC / USD' },
    );
    expect(s).toMatch(/^BTC \/ USD \(in USD\) — an external data feed/);
  });
});
