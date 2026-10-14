import { ethers } from 'ethers';
import { displayValueOf, formatOrientedPrice } from './streamOrientation';
import IStreamAdapterUIDescriptorAbi from '../contracts/IStreamAdapterUIDescriptor.json';
import { type ConfigField } from './gameUI';

// Resolve a STREAM adapter's create-form + value-display UI by probing its
// implementation for an optional IStreamAdapterUIDescriptor, with a guaranteed
// graceful fallback. Mirrors the W8 gameUI.ts resolver. The descriptor is
// purely additive on-chain metadata — the frozen core never enforces it — so a
// missing/partial descriptor MUST NOT throw to the caller. Every probe below is
// wrapped; the function always returns a valid ResolvedStreamAdapterUI.
//
// Resolution order:
//   - adapterId === 0          -> source:'simple'    (built-in Simple stream; no probe)
//   - impl missing/zero/fails  -> source:'hardcoded' (caller uses the existing
//                                                     hardcoded/generic create-form path)
//   - descriptor responds      -> source:'descriptor'

// Re-export ConfigField so stream-side callers can import it from here without
// also reaching into gameUI.ts.
export type { ConfigField } from './gameUI';

// How to render a stream's value: a decimal scale, a unit suffix, and a human
// label (e.g. Chainlink decimals/description, or "Uniswap V3 8h TWAP tick").
export interface StreamValueDisplay {
  decimals: number;
  unit: string;
  label: string;
  /// Present when the stored value is a Uniswap V3 TICK and we know enough about
  /// the pool to show it as a price instead.
  ///
  /// The contract stores the raw tick deliberately: price is `1.0001^tick`, which
  /// is monotonic, so UP and DOWN survive without any fixed-point arithmetic in
  /// Solidity. That is right for scoring and unreadable for a person — 213397
  /// means nothing, "540.44 USDC per WETH" means something.
  ///
  /// Converting in the UI is safe here in a way that copying a protocol rule
  /// would not be: this number feeds no decision the chain makes, and because the
  /// transform is monotonic, predicting UP on the price is exactly predicting UP
  /// on the tick. A wrong conversion would misinform, but it could never change
  /// an outcome.
  ///
  /// Declarative rather than a closure so it survives React state without
  /// tripping the setState-updater overload, and so it can be tested directly.
  tickPrice?: {
    decimals0: number;
    decimals1: number;
    symbol0: string;
    symbol1: string;
  };
}

export interface ResolvedStreamAdapterUI {
  source: 'descriptor' | 'hardcoded' | 'simple';
  // Parsed from the descriptor's configSchema(). null => no descriptor schema;
  // the caller falls back to its existing hardcoded/generic create-form path.
  configFields: ConfigField[] | null;
  // Parsed from the descriptor's valueDisplay(target, config). null => render
  // the raw value.
  valueDisplay: StreamValueDisplay | null;
}

// The descriptor fragments live on the hand-maintained ABI JSON.
const DESCRIPTOR_ABI = (IStreamAdapterUIDescriptorAbi as { abi: ethers.InterfaceAbi }).abi;

// Parse a configSchema() JSON string into ConfigField[]. Best-effort: returns
// null on any parse/shape failure so the caller falls back to its hardcoded
// create form. Only well-formed { key, type } entries survive; optional
// label/help/min/max are passed through as UI hints.
function parseConfigSchema(json: string): ConfigField[] | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as { fields?: unknown };
    const fields = parsed?.fields;
    if (!Array.isArray(fields)) return null;
    const out: ConfigField[] = [];
    for (const f of fields) {
      if (!f || typeof f !== 'object') continue;
      const rec = f as Record<string, unknown>;
      const key = typeof rec.key === 'string' ? rec.key : '';
      const type = typeof rec.type === 'string' ? rec.type : '';
      if (!key || !type) continue;
      out.push({
        key,
        type,
        label: typeof rec.label === 'string' ? rec.label : key,
        help: typeof rec.help === 'string' ? rec.help : undefined,
        min: typeof rec.min === 'string' ? rec.min : undefined,
        max: typeof rec.max === 'string' ? rec.max : undefined,
      });
    }
    // An empty fields[] is a valid descriptor answer ("this adapter takes no
    // config"); keep it as [] so the caller knows the descriptor responded.
    return out;
  } catch {
    return null;
  }
}

export interface ResolveStreamAdapterUIOpts {
  // Stream adapterId. 0 = built-in Simple stream (no probe).
  adapterId: number;
  // The adapter implementation address; the caller resolves it via
  // contracts.registry.adapter(adapterId). Zero/undefined => hardcoded.
  impl?: string;
  // This stream's provider/target address — passed verbatim to valueDisplay.
  target?: string;
  // This stream's adapter config bytes (0x-prefixed) — passed verbatim to
  // valueDisplay.
  config?: string;
  // The dapp's read provider (useWallet().provider). Contract runners also
  // satisfy ethers.Provider, so either works.
  provider: ethers.Provider;
}

// Probe a stream adapter for an IStreamAdapterUIDescriptor and resolve its UI.
// Never throws — any failure degrades to source:'hardcoded' with null fields.
export async function resolveStreamAdapterUI(
  opts: ResolveStreamAdapterUIOpts,
): Promise<ResolvedStreamAdapterUI> {
  const { adapterId, impl, target, config, provider } = opts;

  // ---- Built-in Simple stream (adapterId 0): no adapter, no probe. ----
  if (adapterId === 0) {
    return { source: 'simple', configFields: null, valueDisplay: null };
  }

  // The fallback used whenever there is no usable descriptor.
  const hardcoded = (): ResolvedStreamAdapterUI => ({
    source: 'hardcoded',
    configFields: null,
    valueDisplay: null,
  });

  // No implementation address to probe -> hardcoded.
  if (!impl || !ethers.isAddress(impl) || impl === ethers.ZeroAddress) {
    return hardcoded();
  }

  let descriptor: ethers.Contract;
  try {
    descriptor = new ethers.Contract(impl, DESCRIPTOR_ABI, provider);
  } catch {
    return hardcoded();
  }

  // PROBE: uiSchemaVersion() is the cheapest "do you implement the interface?"
  // signal. If it reverts (adapter without the optional descriptor), fall back.
  try {
    await descriptor.uiSchemaVersion();
  } catch {
    return hardcoded();
  }

  // Descriptor is present. From here we keep degrading gracefully field-by-field
  // rather than abandoning the whole descriptor on one sub-call failure.

  // configFields: best-effort; null on missing/parse failure.
  let configFields: ConfigField[] | null = null;
  try {
    const schema: string = await descriptor.configSchema();
    configFields = parseConfigSchema(schema);
  } catch {
    configFields = null;
  }

  // valueDisplay: parameterized by (target, config) like readValue. The
  // descriptor contract guarantees this never reverts, but probe-side errors
  // (bad target, RPC hiccup) still degrade to null.
  let valueDisplay: StreamValueDisplay | null = null;
  try {
    const t = target && ethers.isAddress(target) ? target : ethers.ZeroAddress;
    const c = config && ethers.isHexString(config) ? config : '0x';
    const res = await descriptor.valueDisplay(t, c);
    valueDisplay = {
      decimals: Number(res[0]),
      unit: String(res[1]),
      label: String(res[2]),
    };

    // A "tick" unit means the stored value is a Uniswap V3 tick, and `target` is
    // the pool. Ask the pool for its token pair so the UI can show a price.
    //
    // Best-effort and additive: on any failure the tick is still rendered as
    // before. Nothing downstream depends on this succeeding, which is the only
    // reason it is acceptable to reach into a third-party contract from here.
    if (valueDisplay.unit.toLowerCase() === 'tick' && t !== ethers.ZeroAddress) {
      try {
        const pool = new ethers.Contract(t, [
          'function token0() view returns (address)',
          'function token1() view returns (address)',
        ], provider);
        const [a0, a1] = await Promise.all([pool.token0(), pool.token1()]);
        const erc = (addr: string) => new ethers.Contract(addr, [
          'function symbol() view returns (string)',
          'function decimals() view returns (uint8)',
        ], provider);
        const [s0, d0, s1, d1] = await Promise.all([
          erc(a0).symbol(), erc(a0).decimals(), erc(a1).symbol(), erc(a1).decimals(),
        ]);
        valueDisplay.tickPrice = {
          decimals0: Number(d0), decimals1: Number(d1),
          symbol0: String(s0), symbol1: String(s1),
        };
      } catch {
        // Not a Uniswap-shaped pool, or unreadable. Keep the raw tick.
      }
    }
  } catch {
    valueDisplay = null;
  }

  return { source: 'descriptor', configFields, valueDisplay };
}

// Pure formatter (no contract calls). Renders a stream's raw value per its
// StreamValueDisplay. Never throws — any failure falls back to String(rawValue).
//   - display null or decimals 0 -> integer string (+ ' '+unit if unit present)
//   - decimals > 0               -> scale by 10^decimals, trim trailing zeros,
//                                    append unit
export function formatStreamValue(
  rawValue: bigint | number | string,
  display: StreamValueDisplay | null,
): string {
  try {
    // Uniswap tick -> price. The maths and the flip decision live in
    // lib/streamOrientation so that this label, the chart's plotted line, the
    // sentiment bars and the UP/DOWN buttons all read the SAME orientation from
    // one place. Five independent flips is how you end up with a chart that
    // disagrees with the button under it.
    if (display?.tickPrice) {
      const shown = displayValueOf(Number(rawValue), display);
      if (shown !== null) return formatOrientedPrice(shown);
    }

    const unit = display?.unit ? ` ${display.unit}` : '';
    const decimals = display?.decimals ?? 0;

    if (!display || decimals <= 0) {
      // Integer rendering. BigInt() handles bigint/number/decimal-free string;
      // anything else falls through to String() below.
      const asInt =
        typeof rawValue === 'bigint'
          ? rawValue
          : BigInt(typeof rawValue === 'number' ? Math.trunc(rawValue) : rawValue);
      return `${asInt.toString()}${unit}`;
    }

    // Scale by 10^decimals via ethers.formatUnits (handles bigint/number/string).
    const asBig =
      typeof rawValue === 'bigint'
        ? rawValue
        : BigInt(typeof rawValue === 'number' ? Math.trunc(rawValue) : rawValue);
    const formatted = ethers.formatUnits(asBig, decimals);
    // Trim trailing zeros (and a dangling decimal point) for a clean display.
    const trimmed = formatted.includes('.')
      ? formatted.replace(/\.?0+$/, '')
      : formatted;
    return `${trimmed}${unit}`;
  } catch {
    return String(rawValue);
  }
}
