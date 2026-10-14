import { ethers } from 'ethers';
import IGameUIDescriptorAbi from '../contracts/IGameUIDescriptor.json';
import {
  gameKind,
  directionOptions,
  encodePredictPayload,
  type GameKind,
} from './gameTypes';

// Resolve a game's PREDICT/CREATE UI by probing its adapter for an optional
// IGameUIDescriptor, with a guaranteed graceful fallback to the gameTypes.ts
// heuristics (W7). The descriptor is purely additive on-chain metadata — it is
// never enforced by the core — so a missing/partial descriptor MUST NOT throw
// to the caller. Every probe below is wrapped; the function always returns a
// valid ResolvedGameUI.
//
// Resolution order:
//   - gameTypeId === 0           -> source:'binary'   (no probe; built-in UP/DOWN)
//   - impl is zero / probe fails -> source:'heuristic' (gameKind -> yesno/generic)
//   - descriptor responds        -> source:'descriptor'

// One discrete predict choice: a human label + the exact predict payload bytes
// (0x-prefixed hex) that selects it.
export interface ResolvedOption {
  label: string;
  payloadHex: string;
}

// One create-game / create-stream config field parsed from a descriptor's
// configSchema(). `type` is the solidity abi type used to encode the field's
// value (in order). `min`/`max` are optional numeric UI hints only —
// encodeConfigFromFields ignores them.
export interface ConfigField {
  key: string;
  label: string;
  type: string;
  help?: string;
  min?: string;
  max?: string;
}

export interface ResolvedGameUI {
  source: 'descriptor' | 'heuristic' | 'binary';
  // Discrete predict choices (rendered as buttons). null when the game's input
  // is not discrete (use predictInput) or unknown (raw-hex field).
  options: ResolvedOption[] | null;
  // Parsed predictInputSchema() when options is null and the descriptor offers
  // a non-discrete form (number/text/...). null otherwise.
  predictInput: { kind: string; [k: string]: unknown } | null;
  // Create-game config fields from configSchema(). null => no descriptor schema;
  // the create form should fall back to the gameTypes.ts heuristic.
  configFields: ConfigField[] | null;
  // Best-effort human label for a winning bucket; falls back to '#<bucket>'.
  bucketLabel: (bucket: number) => string;
}

// The 7 descriptor fragments live on the hand-maintained ABI JSON.
const DESCRIPTOR_ABI = (IGameUIDescriptorAbi as { abi: ethers.InterfaceAbi }).abi;

// Default bucket labeller — used by every non-descriptor path and as the
// fallback inside the descriptor path. Buckets are 1-indexed on-chain (0 is the
// void/no-winner sentinel), so '#<bucket>' is the most honest generic label.
function defaultBucketLabel(bucket: number): string {
  return `#${bucket}`;
}

// Build the two-choice option set for a binary/yesno kind from the gameTypes.ts
// heuristic. Returns null for 'generic' (no known discrete choices) — the UI
// then shows the raw-hex predict field. Wrapped so a payload-encode hiccup
// degrades to null rather than throwing.
function heuristicOptions(kind: GameKind): ResolvedOption[] | null {
  const dirs = directionOptions(kind);
  if (!dirs) return null;
  try {
    return dirs.map((d) => ({
      label: d.label,
      payloadHex: encodePredictPayload(kind, { direction: d.value }),
    }));
  } catch {
    return null;
  }
}

// Parse a configSchema() JSON string into ConfigField[]. Best-effort: returns
// null on any parse/shape failure so the caller falls back to the heuristic
// create form. Only well-formed { key, type } entries survive.
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
      });
    }
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

// Parse a predictInputSchema() JSON string into the predictInput shape. The
// only required field is `kind`; everything else is passed through verbatim so
// the UI can read min/max/decimals/unit/encode etc. Returns null when the
// schema is empty (reference returns "") or malformed.
function parsePredictInput(json: string): { kind: string; [k: string]: unknown } | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object') return null;
    const kind = typeof parsed.kind === 'string' ? parsed.kind : '';
    if (!kind) return null;
    return { ...parsed, kind };
  } catch {
    return null;
  }
}

export interface ResolveGameUIOpts {
  gameId: number;
  gameTypeId: number;
  adapterName?: string;
  // The adapter implementation address; the caller resolves it via
  // contracts.games.gameAdapterFor(gameId). Zero/undefined => heuristic.
  impl?: string;
  // The dapp's read provider (useWallet().provider, an ethers.JsonRpcProvider).
  // Reused here so descriptor probes ride the same resilient RPC list. Contract
  // runners also satisfy ethers.Provider, so either works.
  provider: ethers.Provider;
}

// Probe a game's adapter for an IGameUIDescriptor and resolve its UI. Never
// throws — any failure degrades to the gameTypes.ts heuristic / binary path.
export async function resolveGameUI(opts: ResolveGameUIOpts): Promise<ResolvedGameUI> {
  const { gameId, gameTypeId, adapterName, impl, provider } = opts;

  // ---- Built-in binary game (type 0): no adapter, no probe. ----
  if (gameTypeId === 0) {
    return {
      source: 'binary',
      options: heuristicOptions('binary'),
      predictInput: null,
      configFields: null,
      bucketLabel: defaultBucketLabel,
    };
  }

  const kind = gameKind(gameTypeId, adapterName);

  // The heuristic fallback used whenever there is no usable descriptor.
  const heuristic = (): ResolvedGameUI => ({
    source: 'heuristic',
    options: heuristicOptions(kind),
    predictInput: null,
    configFields: null,
    bucketLabel: defaultBucketLabel,
  });

  // No implementation address to probe -> heuristic.
  if (!impl || !ethers.isAddress(impl) || impl === ethers.ZeroAddress) {
    return heuristic();
  }

  let descriptor: ethers.Contract;
  try {
    descriptor = new ethers.Contract(impl, DESCRIPTOR_ABI, provider);
  } catch {
    return heuristic();
  }

  // PROBE: uiSchemaVersion() is the cheapest "do you implement the interface?"
  // signal. If it reverts (adapter without the optional descriptor), fall back.
  try {
    await descriptor.uiSchemaVersion();
  } catch {
    return heuristic();
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

  // optionCount drives the discrete-vs-form decision.
  let count = 0;
  try {
    count = Number(await descriptor.optionCount(gameId));
  } catch {
    count = 0;
  }

  if (count > 0) {
    // Build the discrete options[] from optionLabel(i)/optionPayload(i). Also
    // pre-read bucketLabel for each option's bucket (index+1) so the result
    // labeller is synchronous and cheap — the on-chain bucketLabel(gameId,b)
    // call is optional/expensive and we don't want it on the render path.
    const options: ResolvedOption[] = [];
    const labelMap = new Map<number, string>();
    for (let i = 0; i < count; i++) {
      let label = `Option ${i + 1}`;
      let payloadHex = '0x';
      try {
        label = String(await descriptor.optionLabel(gameId, i));
      } catch {
        /* keep default label */
      }
      try {
        const raw = await descriptor.optionPayload(gameId, i);
        payloadHex = ethers.hexlify(raw);
      } catch {
        /* keep '0x'; UI gates empty payloads */
      }
      options.push({ label, payloadHex });

      // Pre-read the bucket label for bucket = index+1 (buckets are 1-indexed).
      const bucket = i + 1;
      try {
        const bl = String(await descriptor.bucketLabel(gameId, bucket));
        if (bl) labelMap.set(bucket, bl);
      } catch {
        /* leave unmapped -> falls back to '#<bucket>' */
      }
    }

    return {
      source: 'descriptor',
      options,
      predictInput: null,
      configFields,
      bucketLabel: (bucket: number) => labelMap.get(bucket) ?? defaultBucketLabel(bucket),
    };
  }

  // optionCount == 0 -> the descriptor describes a non-discrete input form.
  let predictInput: { kind: string; [k: string]: unknown } | null = null;
  try {
    const schema: string = await descriptor.predictInputSchema(gameId);
    predictInput = parsePredictInput(schema);
  } catch {
    predictInput = null;
  }

  return {
    source: 'descriptor',
    options: null,
    predictInput,
    configFields,
    bucketLabel: defaultBucketLabel,
  };
}

// ---- Config encoding from descriptor ConfigField[] ----

// Coerce a single string form value to the JS type ethers' AbiCoder expects for
// the given solidity abi type. Throws a readable Error on unsupported types so
// the caller (create-game form) can fall back to the raw-hex editor.
function coerceValue(type: string, raw: string): unknown {
  const t = type.trim();

  // int* / uint* (any bit width) -> bigint.
  if (/^u?int(\d+)?$/.test(t)) {
    const v = (raw ?? '').trim();
    if (v === '') throw new Error(`Field of type ${t} cannot be empty.`);
    try {
      return BigInt(v);
    } catch {
      throw new Error(`"${v}" is not a valid whole number for ${t}.`);
    }
  }

  // bool -> true/false from common spellings.
  if (t === 'bool') {
    const v = (raw ?? '').trim().toLowerCase();
    if (v === 'true' || v === '1') return true;
    if (v === 'false' || v === '0' || v === '') return false;
    throw new Error(`"${raw}" is not a valid boolean (use true/false).`);
  }

  // address -> validated checksum-agnostic address string.
  if (t === 'address') {
    const v = (raw ?? '').trim();
    if (!ethers.isAddress(v)) throw new Error(`"${raw}" is not a valid address.`);
    return v;
  }

  // string -> passthrough.
  if (t === 'string') {
    return raw ?? '';
  }

  // bytes / fixed bytesN -> must be 0x-prefixed hex.
  if (/^bytes(\d+)?$/.test(t)) {
    const v = (raw ?? '').trim();
    if (!ethers.isHexString(v)) {
      throw new Error(`Field of type ${t} must be a 0x-prefixed hex string.`);
    }
    return v;
  }

  throw new Error(`Unsupported config field type "${type}".`);
}

// ABI-encode a create-game config from a descriptor's ConfigField[] + the
// creator's string inputs. Types and order come from the schema; values are
// coerced per type. Throws a readable Error on any unsupported type or bad value
// so the UI can surface it / fall back to the raw-hex editor.
export function encodeConfigFromFields(
  fields: ConfigField[],
  values: Record<string, string>,
): string {
  const types = fields.map((f) => f.type);
  const coerced = fields.map((f) => coerceValue(f.type, values[f.key] ?? ''));
  try {
    return ethers.AbiCoder.defaultAbiCoder().encode(types, coerced);
  } catch (e: any) {
    throw new Error(
      `Could not encode the game config: ${e?.shortMessage || e?.message || 'invalid values'}.`,
    );
  }
}
