import { formatEther, getBytes, hexlify, keccak256, toUtf8Bytes } from 'ethers';

/// trimName / nameProblem / localIdOf are COPIED from
/// /code/coined/ui/src/lib/values.ts — Coined's client mirror of its contract's
/// text rules (CoinedState._checkText, Coined.idOf). A named stream's name is a
/// Coined term, so the id predicted here must be the one Coined computes: keep
/// these byte-for-byte with that file whenever it changes (last copied at
/// coined d2a101d).

/// The same trimming the contract does, so the UI can show a user what their
/// text will actually become before they send it.
export function trimName(text: string): string {
  /// FOLD THE INVISIBLE: Unicode lets the same visible text arrive as
  /// different bytes (é as one codepoint, or e plus a combining accent), and
  /// the market can only choose between things it can SEE — so every name
  /// leaves the client in canonical composed form (NFC), one spelling per
  /// appearance. The contract stays byte-blind; this is the client canon,
  /// exactly like the contract's own trim of invisible outer whitespace.
  /// In the same spirit every space separator folds to the plain space: a
  /// pasted "free<NBSP>speech" renders as "free speech" and so IS "free
  /// speech" — the contract refuses the odd space outright; the client sends
  /// (and looks up) the one name both spellings mean. The C1 controls and the
  /// line and paragraph separators are not spaces to anyone and stay refused.
  return text.normalize('NFC').replace(SPACE_SEPARATOR, ' ').replace(/^[\s]+|[\s]+$/g, '');
}

const SPACE_SEPARATOR = /[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/g;

/// WHAT THE CONTRACT WILL REFUSE, said here first. Mirrors CoinedState
/// _checkText: printable text in one writing system, nothing invisible.
/// Returns the reason, or null for a name the chain will take.
export function nameProblem(text: string): string | null {
  const t = trimName(text);
  if (!t) return 'a value needs a name';
  let script = 0;
  for (const ch of t) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x20 || cp === 0x7f || (cp >= 0x80 && cp <= 0x9f)) return 'a name cannot hold a control character';
    if (INVISIBLE(cp)) return 'a name cannot hold an invisible character';
    const s = scriptOf(cp);
    if (s === 0) continue;
    if (script === 0) script = s;
    else if (s !== script) return 'a name keeps to one alphabet — a letter here is from another';
  }
  return null;
}

/// the contract's _scriptOf refusal list, less the C1 controls (reported as
/// controls above). It takes in every space but 0x20: trimName has already
/// folded the separators to plain spaces, so what reaches here is the line
/// and paragraph separators, which render as a break and are refused as such.
/// The rest is Unicode's Default_Ignorable set in full (hangul fillers, the
/// khmer and mongolian ignorables, the musical and shorthand format controls)
/// plus the braille blank — a blank that is not a space is not folded, since
/// nobody types one meaning a space; it is refused like any invisible.
export const INVISIBLE = (cp: number) =>
  cp === 0xa0 || cp === 0xad || cp === 0x34f || cp === 0x61c || cp === 0x115f || cp === 0x1160 || cp === 0x1680 ||
  cp === 0x17b4 || cp === 0x17b5 || (cp >= 0x180b && cp <= 0x180f) || (cp >= 0x2000 && cp <= 0x200f) ||
  (cp >= 0x2028 && cp <= 0x202f) || (cp >= 0x205f && cp <= 0x206f) || cp === 0x2800 || cp === 0x3000 ||
  cp === 0x3164 || (cp >= 0xe000 && cp <= 0xf8ff) || (cp >= 0xfe00 && cp <= 0xfe0f) || cp === 0xfeff ||
  cp === 0xffa0 || (cp >= 0xfff0 && cp <= 0xffff) || (cp >= 0x1bca0 && cp <= 0x1bca3) ||
  (cp >= 0x1d173 && cp <= 0x1d17a) || (cp >= 0xe0000 && cp <= 0xe0fff) || cp >= 0xf0000;

/// the contract's ladder, as [below, script] steps; 0 binds to no alphabet,
/// -1 is "a block of its own" (1000 + block on chain)
const LADDER: [number, number][] = [
  [0xc0, 0], [0x300, 1], [0x370, 0], [0x400, 2], [0x530, 3], [0x590, 4], [0x600, 5], [0x900, 6],
  [0xf00, -2], [0x1100, -1], [0x1200, 30], [0x13a0, -1], [0x1400, 31], [0x1e00, -1], [0x1f00, 1],
  [0x2000, 2], [0x2100, 0], [0x2190, 1], [0x2460, 0], [0x2500, 1], [0x2c00, 0], [0x2c60, -1],
  [0x2c80, 1], [0x2e80, -1], [0x3000, 30], [0x3040, 0], [0xa000, 30], [0xa4d0, -1], [0xa500, 32],
  [0xa640, -1], [0xa6a0, 3], [0xa720, 0], [0xa800, 1], [0xab30, -1], [0xab70, 1], [0xabc0, 31],
  [0xac00, -1], [0xd7b0, 30], [0xf900, -1], [0xfb00, 30], [0xfb07, 1], [0xfb50, -1], [0xfe00, 6],
  [0xfe70, 0], [0xff00, 6], [0xff21, 0], [0xff5b, 1], [0xff66, 0], [0xffe0, 30], [0x10000, 0],
  [0x1d400, -1], [0x1d6a8, 1], [0x1d7cc, 2], [0x1d800, 0], [0x1f000, -1], [0x20000, 0], [0x40000, 30],
];

function scriptOf(cp: number): number {
  if (cp < 0x80) return (cp | 0x20) >= 0x61 && (cp | 0x20) <= 0x7a ? 1 : 0;
  if (cp === 0xd7 || cp === 0xf7) return 0;
  for (const [below, s] of LADDER) {
    if (cp < below) {
      if (s === -2) return 7 + Math.floor((cp - 0x900) / 0x80); // the indic blocks, thai, lao
      return s === -1 ? 1000 + Math.floor(cp / 0x100) : s;
    }
  }
  return 1000 + Math.floor(cp / 0x100);
}

export function localIdOf(text: string): string {
  const trimmed = trimName(text);
  const problem = nameProblem(trimmed);
  if (problem) throw new Error(problem);
  const bytes = toUtf8Bytes(trimmed);
  if (bytes.length <= 32) {
    const padded = new Uint8Array(32);
    padded.set(bytes, 0);
    return hexlify(padded);
  }
  const h = getBytes(keccak256(bytes));
  h[0] = 0;
  return hexlify(h);
}

/// ETH backing as a tag: two or three significant figures.
export function ethShort(wei: bigint): string {
  const n = Number(formatEther(wei));
  if (n === 0) return '0';
  return n >= 100 ? Math.round(n).toString() : Number(n.toPrecision(3)).toString();
}
