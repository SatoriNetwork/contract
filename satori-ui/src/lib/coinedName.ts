import { formatEther, getBytes, hexlify, keccak256, toUtf8Bytes } from 'ethers';

/// trimName / nameProblem / localIdOf are COPIED from
/// /code/coined/ui/src/lib/values.ts — Coined's client mirror of its contract's
/// text rules (CoinedState._checkText, Coined.idOf). A named stream's name is a
/// Coined term, so the id predicted here must be the one Coined computes: keep
/// these three byte-for-byte with that file whenever it changes.

export function trimName(text: string): string {
  return text.normalize('NFC').replace(/^[\s]+|[\s]+$/g, '');
}

export function nameProblem(text: string): string | null {
  const t = trimName(text);
  if (!t) return 'a value needs a name';
  let script = 0;
  for (const ch of t) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x20 || cp === 0x7f) return 'a name cannot hold a control character';
    if (INVISIBLE(cp)) return 'a name cannot hold an invisible character';
    const s = scriptOf(cp);
    if (s === 0) continue;
    if (script === 0) script = s;
    else if (s !== script) return 'a name keeps to one alphabet — a letter here is from another';
  }
  return null;
}

const INVISIBLE = (cp: number) =>
  cp === 0xad || cp === 0x34f || cp === 0x61c || cp === 0x180e || (cp >= 0x200b && cp <= 0x200f) ||
  (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2060 && cp <= 0x206f) || (cp >= 0xe000 && cp <= 0xf8ff) ||
  (cp >= 0xfe00 && cp <= 0xfe0f) || cp === 0xfeff || (cp >= 0xfff0 && cp <= 0xffff) ||
  (cp >= 0xe0000 && cp <= 0xe01ef) || cp >= 0xf0000;

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
