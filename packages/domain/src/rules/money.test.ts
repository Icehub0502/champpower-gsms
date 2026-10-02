import { describe, expect, it } from 'vitest';
import {
  MoneyError,
  clampDiscount,
  formatQtyCenti,
  formatSatang,
  mulQty,
  sumSatang,
  toQtyCenti,
  toSatang,
} from './money.js';

describe('toSatang / formatSatang', () => {
  it('parses decimal strings exactly', () => {
    expect(toSatang('0')).toBe(0);
    expect(toSatang('1234.5')).toBe(123450);
    expect(toSatang('0.07')).toBe(7);
    expect(toSatang('10')).toBe(1000);
    expect(toSatang('-3.20')).toBe(-320);
  });

  it('refuses more than two decimals instead of rounding', () => {
    expect(() => toSatang('1.005')).toThrow(MoneyError);
    expect(() => toSatang('abc')).toThrow(MoneyError);
    expect(() => toSatang('')).toThrow(MoneyError);
    expect(() => toSatang(NaN)).toThrow(MoneyError);
  });

  it('accepts a number only when it is already an exact two-place value', () => {
    expect(toSatang(19.9)).toBe(1990);
    // float residue is a bug upstream, not something to round away
    expect(() => toSatang(0.1 + 0.2)).toThrow(MoneyError);
  });

  it('refuses values beyond numeric(12,2)', () => {
    expect(toSatang('9999999999.99')).toBe(999_999_999_999);
    expect(() => toSatang('10000000000.00')).toThrow(MoneyError);
  });

  it('round-trips through the numeric(12,2) text form', () => {
    for (const s of ['0.00', '0.05', '1.00', '1234.50', '99999.99', '-0.01']) {
      expect(formatSatang(toSatang(s))).toBe(s);
    }
  });
});

describe('mulQty', () => {
  it('multiplies qty by price and rounds once, per line', () => {
    expect(mulQty(toQtyCenti('2'), toSatang('1500'))).toBe(300000);
    expect(mulQty(toQtyCenti('1.5'), toSatang('333.33'))).toBe(50000); // 499.995 -> 500.00 (half away from zero)
  });

  it('rounds half away from zero', () => {
    // 0.5 x 0.01 baht = 0.5 satang -> 1 satang
    expect(mulQty(50, 1)).toBe(1);
    expect(mulQty(49, 1)).toBe(0);
    expect(mulQty(-50, 1)).toBe(-1);
  });

  it('does not lose precision near the top of the range', () => {
    // 9,999,999,999.99 x 1.00
    expect(mulQty(100, 999_999_999_999)).toBe(999_999_999_999);
  });

  it('refuses a computed line total beyond numeric(12,2), not just a parsed one', () => {
    // qty 100,000 (in range) x price 999,999.99 (in range) = 99,999,999,000.00
    // baht -> 9,999,999,900,000 satang, about 10x over MAX_SATANG
    // (999,999,999,999). Both inputs pass toQtyCenti/toSatang individually;
    // the overflow only shows up in the PRODUCT, so mulQty itself must catch it.
    expect(() => mulQty(toQtyCenti('100000'), toSatang('999999.99'))).toThrow(MoneyError);
  });

  it('refuses a computed sum beyond numeric(12,2)', () => {
    const near = toSatang('9999999999.99'); // MAX_SATANG
    expect(() => sumSatang([near, near])).toThrow(MoneyError);
  });

  it('is exact where float maths is not', () => {
    // 3 x 0.10 + ... classic: 0.1 * 3 !== 0.3 in float
    expect(mulQty(toQtyCenti('3'), toSatang('0.10'))).toBe(30);
    expect(formatSatang(sumSatang([toSatang('0.10'), toSatang('0.20')]))).toBe('0.30');
  });
});

describe('qty', () => {
  it('formats hundredths', () => {
    expect(formatQtyCenti(toQtyCenti('2'))).toBe('2.00');
    expect(formatQtyCenti(toQtyCenti('0.5'))).toBe('0.50');
  });
});

describe('clampDiscount', () => {
  it('never exceeds the subtotal', () => {
    expect(clampDiscount(500, 1000)).toBe(500);
    expect(clampDiscount(5000, 1000)).toBe(1000);
  });
  it('ignores negative discounts and empty subtotals', () => {
    expect(clampDiscount(-100, 1000)).toBe(0);
    expect(clampDiscount(100, 0)).toBe(0);
  });
});
