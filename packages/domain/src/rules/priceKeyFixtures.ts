/**
 * The shared fixture for priceKey() / the SQL function price_key() (migration
 * 0020). One table, two consumers:
 *   - packages/domain/src/rules/catalogItems.test.ts (a plain vitest)
 *   - apps/api's tier-2 test that runs `SELECT price_key($1)` against a real
 *     database and asserts the same answer.
 *
 * Any case that would distinguish the two implementations belongs here, not
 * duplicated by hand in either test file — see catalogItems.ts for why the
 * case fold is ASCII-only and exactly which code points are stripped.
 */
export interface PriceKeyFixture {
  /** A short label for the test name; not part of the comparison. */
  label: string;
  input: string;
  expected: string;
}

export const PRICE_KEY_FIXTURES: readonly PriceKeyFixture[] = [
  { label: 'Thai with a space between words', input: 'ลูกหมาก ปีกนก', expected: 'ลูกหมากปีกนก' },
  { label: 'NBSP between words', input: 'Toyota Hilux', expected: 'toyotahilux' },
  { label: 'fullwidth Latin folds via NFKC, then ASCII-lowers', input: 'ＴＯＹＯＴＡ', expected: 'toyota' },
  { label: 'zero-width space and BOM removed anywhere', input: 'a​b﻿c', expected: 'abc' },
  {
    label: 'Ü (non-ASCII) is NOT case-folded on either side',
    input: 'CITROËN',
    expected: 'citroËn',
  },
  { label: 'ß has no ASCII case pair and is left exactly as typed', input: 'Straße', expected: 'straße' },
  {
    label: 'İ (Turkish dotted capital I) is left exactly as typed — no locale-dependent fold',
    input: 'İ',
    expected: 'İ',
  },
  { label: 'mixed case, ASCII only', input: 'ToYoTa', expected: 'toyota' },
  { label: 'repeated spaces collapse to nothing', input: 'Toyota   Hilux', expected: 'toyotahilux' },
  { label: 'en dash variant of a name keys the same as a plus sign', input: 'ลูกหมากปีกนกล่าง L–R', expected: 'ลูกหมากปีกนกล่างlr' },
  { label: 'hyphen and underscore are both stripped', input: 'Hi-Lux_Vigo', expected: 'hiluxvigo' },
  { label: 'empty string stays empty', input: '', expected: '' },
] as const;
