import { parseRatioWad, formatRatio, RATIO_DEFAULT, RATIO_NEVER_CHANGE } from './emissionStatus';

const ONE = BigInt('1000000000000000000');

describe('parseRatioWad', () => {
  it('the quick buttons send exactly PHI_INV and 1e18', () => {
    expect(parseRatioWad(RATIO_DEFAULT)).toBe(BigInt('618033988749894848'));
    expect(parseRatioWad(RATIO_NEVER_CHANGE)).toBe(ONE);
  });

  it('accepts 0, above-1 multipliers and the uint64 ceiling', () => {
    expect(parseRatioWad('0')).toHaveProperty('err');
    expect(parseRatioWad('0.000')).toHaveProperty('err');
    expect(parseRatioWad('2')).toBe(ONE * BigInt(2));
    expect(parseRatioWad('.5')).toBe(ONE / BigInt(2));
    expect(parseRatioWad('18.446744073709551615')).toBe(BigInt('18446744073709551615'));
  });

  it('rejects past uint64, negatives, and junk', () => {
    expect(parseRatioWad('18.446744073709551616')).toHaveProperty('err');
    expect(parseRatioWad('-1')).toHaveProperty('err');
    expect(parseRatioWad('abc')).toHaveProperty('err');
    expect(parseRatioWad('')).toHaveProperty('err');
    expect(parseRatioWad('0.1234567890123456789')).toHaveProperty('err');
  });
});

describe('formatRatio', () => {
  it('drops trailing zeros without eating integer zeros', () => {
    expect(formatRatio(BigInt('618033988749894848'))).toBe('0.618');
    expect(formatRatio(ONE)).toBe('1');
    expect(formatRatio(ONE * BigInt(10))).toBe('10');
    expect(formatRatio(BigInt(0))).toBe('0');
  });
});
