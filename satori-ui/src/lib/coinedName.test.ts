import { trimName, nameProblem, localIdOf, ethShort } from './coinedName';
import { keccak256, toUtf8Bytes, getBytes, hexlify } from 'ethers';

/// A named stream's name is a Coined term, so the id Satori predicts must be
/// the one Coined computes.

describe('trimName', () => {
  it('trims the ends and folds to NFC', () => {
    expect(trimName('  honesty \n')).toBe('honesty');
    expect(trimName('bitcoin')).toBe('bitcoin');
    const composed = 'café';
    const decomposed = 'café';
    expect(decomposed).not.toBe(composed);
    expect(trimName(decomposed)).toBe(composed);
  });
});

describe('localIdOf', () => {
  it('is the text itself, right-padded, for 32 bytes or fewer', () => {
    const padded = new Uint8Array(32);
    padded.set(toUtf8Bytes('bitcoin'));
    expect(localIdOf('bitcoin')).toBe(hexlify(padded));
    const n32 = 'a'.repeat(32);
    expect(getBytes(localIdOf(n32))[0]).not.toBe(0);
  });

  it('is keccak with a zeroed first byte past 32 bytes', () => {
    const long = 'a value whose name is longer than thirty one bytes for certain';
    const h = getBytes(keccak256(toUtf8Bytes(long)));
    h[0] = 0;
    expect(localIdOf(long)).toBe(hexlify(h));
    expect(getBytes(localIdOf('a'.repeat(33)))[0]).toBe(0);
  });

  it('keeps case and punctuation, trims the ends, folds NFC', () => {
    expect(localIdOf('Honesty')).not.toBe(localIdOf('honesty'));
    expect(localIdOf('self improvement')).not.toBe(localIdOf('self-improvement'));
    expect(localIdOf('  honesty  ')).toBe(localIdOf('honesty'));
    expect(localIdOf('café')).toBe(localIdOf('café'));
  });

  it('refuses what the contract refuses', () => {
    expect(() => localIdOf('   ')).toThrow();
    expect(() => localIdOf('bit\u0001coin')).toThrow(/control/);
    expect(() => localIdOf('bit\tcoin')).toThrow(/control/);
    expect(() => localIdOf('bitcοin')).toThrow(/one alphabet/); // greek ο
    expect(() => localIdOf('united states')).not.toThrow();
  });
});

describe('nameProblem', () => {
  it('takes one alphabet with digits, punctuation and emoji', () => {
    for (const ok of ['bitcoin', 'Zürich café', 'биткоин #1', '東京 2026', '🚀 to the moon', 'ビットコイン', '{bitcoin,freedom}'])
      expect(nameProblem(ok)).toBeNull();
  });
  it('refuses two alphabets in one name', () => {
    expect(nameProblem('bitcоin')).toMatch(/one alphabet/); // cyrillic о
    expect(nameProblem('ビット coin')).toMatch(/one alphabet/);
  });
  it('refuses what cannot be seen', () => {
    expect(nameProblem('bit​coin')).toMatch(/invisible/);
    expect(nameProblem('bit­coin')).toMatch(/invisible/);
    expect(nameProblem('bit﻿coin')).toMatch(/invisible/);
    expect(nameProblem('bit\x01coin')).toMatch(/control/);
    expect(nameProblem('   ')).toMatch(/needs a name/);
  });
});

describe('Coined d2a101d: every space but the plain one', () => {
  it('folds space separators to a plain space before trimming', () => {
    expect(trimName('free\u00a0speech')).toBe('free speech');
    expect(trimName('\u00a0 bitcoin \u2009')).toBe('bitcoin');
    expect(localIdOf('free\u00a0speech')).toBe(localIdOf('free speech'));
  });
  it('refuses C1 controls, line breaks and blanks that are not spaces', () => {
    expect(nameProblem('bit\u0085coin')).toMatch(/control/);
    expect(nameProblem('bit\u2028coin')).toMatch(/invisible/);
    expect(nameProblem('bit\u3164coin')).toMatch(/invisible/); // hangul filler
    expect(nameProblem('bit\u2800coin')).toMatch(/invisible/); // braille blank
  });
});

describe('ethShort', () => {
  it('reads to two or three significant figures', () => {
    expect(ethShort(BigInt('420000000000000000'))).toBe('0.42');
    expect(ethShort(BigInt('322872999999999999999'))).toBe('323');
    expect(ethShort(BigInt('5999999999999999999'))).toBe('6');
    expect(ethShort(BigInt('1230000000000000'))).toBe('0.00123');
    expect(ethShort(BigInt(0))).toBe('0');
  });
});
