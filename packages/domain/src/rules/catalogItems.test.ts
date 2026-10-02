import { describe, expect, it } from 'vitest';
import {
  NO_WARRANTY,
  editDistance,
  findSimilarNames,
  isPriceUnset,
  isSimilarName,
  priceKey,
  resolveCatalogItem,
  resolvePrice,
  warrantySnapshotOf,
  wouldCreateMergeCycle,
} from './catalogItems.js';
import { PRICE_KEY_FIXTURES } from './priceKeyFixtures.js';

describe('priceKey — shared fixture (also run against SQL price_key() in apps/api tier-2)', () => {
  for (const f of PRICE_KEY_FIXTURES) {
    it(f.label, () => {
      expect(priceKey(f.input)).toBe(f.expected);
    });
  }
});

describe('priceKey', () => {
  it('ignores case, spaces and dashes', () => {
    expect(priceKey('Toyota')).toBe(priceKey(' toyota '));
    expect(priceKey('HI-LUX VIGO')).toBe(priceKey('hilux vigo'));
    expect(priceKey('Hi–Lux')).toBe('hilux'); // en dash
    expect(priceKey('ลูกหมาก ปีกนก')).toBe('ลูกหมากปีกนก');
  });
  it('folds full-width forms (NFKC)', () => {
    expect(priceKey('ＴＯＹＯＴＡ')).toBe('toyota');
  });
  it('keeps meaningful punctuation like + and /', () => {
    expect(priceKey('L+R')).toBe('l+r');
    expect(priceKey('L/R')).toBe('l/r');
  });
  it('strips zero-width characters', () => {
    expect(priceKey('a​b﻿c')).toBe('abc');
  });
});

describe('resolvePrice — model, then base, then nothing', () => {
  it('prefers the model price', () => {
    expect(resolvePrice({ modelPrice: '1200.00', basePrice: '1000.00' })).toEqual({ price: '1200.00', source: 'model' });
  });
  it('falls back to base', () => {
    expect(resolvePrice({ modelPrice: null, basePrice: '1000.00' })).toEqual({ price: '1000.00', source: 'base' });
    expect(resolvePrice({ basePrice: '1000.00' })).toEqual({ price: '1000.00', source: 'base' });
  });
  it('is empty when neither exists', () => {
    expect(resolvePrice({})).toEqual({ price: null, source: 'none' });
    expect(resolvePrice({ modelPrice: null, basePrice: null })).toEqual({ price: null, source: 'none' });
  });
  it('a deliberate zero price is a price, not "empty"', () => {
    expect(resolvePrice({ modelPrice: '0.00', basePrice: '500.00' })).toEqual({ price: '0.00', source: 'model' });
  });
  it('first-price rule: only missing / NULL is unset; zero is a deliberate price', () => {
    expect(isPriceUnset(null)).toBe(true);
    expect(isPriceUnset(undefined)).toBe(true);
    expect(isPriceUnset('0')).toBe(false);
    expect(isPriceUnset('0.00')).toBe(false);
    expect(isPriceUnset('0.01')).toBe(false);
    expect(isPriceUnset('1200.00')).toBe(false);
  });
});

describe('warrantySnapshotOf', () => {
  // Units match migration 0010's warranty_terms: days + max_km, not months/km.
  const term = { id: 't1', name: 'ลูกหมาก 1 ปี 100,000 กม.', days: 365, maxKm: 100000 };
  it('copies the term as it is today', () => {
    expect(warrantySnapshotOf(term)).toEqual({
      warrantyTermId: 't1',
      warrantyName: 'ลูกหมาก 1 ปี 100,000 กม.',
      warrantyDays: 365,
      warrantyMaxKm: 100000,
    });
  });
  it('is detached: editing the term afterwards does not change the snapshot', () => {
    const t = { ...term };
    const snap = warrantySnapshotOf(t);
    t.days = 730;
    t.name = 'changed';
    expect(snap.warrantyDays).toBe(365);
    expect(snap.warrantyName).toBe('ลูกหมาก 1 ปี 100,000 กม.');
  });
  it('max_km may be null (รับประกันโช๊ค 1 ปี — no distance limit)', () => {
    expect(warrantySnapshotOf({ id: 't2', name: 'รับประกันโช๊ค 1 ปี', days: 365, maxKm: null }).warrantyMaxKm).toBeNull();
  });
  it('no term -> all null, and a fresh object each time', () => {
    const a = warrantySnapshotOf(null);
    expect(a).toEqual(NO_WARRANTY);
    a.warrantyName = 'x';
    expect(warrantySnapshotOf(undefined).warrantyName).toBeNull();
  });
});

describe('similar names (D12)', () => {
  it('editDistance', () => {
    expect(editDistance('abc', 'abc')).toBe(0);
    expect(editDistance('abc', 'abd')).toBe(1);
    expect(editDistance('', 'ab')).toBe(2);
  });
  it('L+R vs L/R is similar (the spec example)', () => {
    expect(isSimilarName('ลูกหมากปีกนกล่าง L+R', 'ลูกหมากปีกนกล่าง L/R')).toBe(true);
  });
  it('same key regardless of spacing and case', () => {
    expect(isSimilarName('Lock Nut', 'locknut')).toBe(true);
  });
  it('one name inside the other', () => {
    expect(isSimilarName('ยางรัดกันโคลง', 'ยางรัดกันโคลง L+R ตรงรุ่น')).toBe(true);
  });
  it('a very short name is not "inside" everything', () => {
    expect(isSimilarName('ยา', 'ลูกหมากปีกนกล่างคันชัก')).toBe(false);
  });
  it('clearly different items are not similar', () => {
    expect(isSimilarName('ลูกหมากปีกนกล่าง', 'โช๊คอัพหน้า')).toBe(false);
    expect(isSimilarName('', 'x')).toBe(false);
  });
  it('findSimilarNames filters candidates', () => {
    const items = [{ name: 'ลูกหมากปีกนกล่าง L+R' }, { name: 'โช๊คอัพหน้า' }];
    expect(findSimilarNames('ลูกหมากปีกนกล่าง L/R', items)).toEqual([items[0]]);
  });
});

describe('merge resolution', () => {
  const mk = (rows: Array<[string, string | null]>) =>
    new Map(rows.map(([id, mergedIntoId]) => [id, { id, mergedIntoId }]));

  it('resolves to the surviving item through a chain', () => {
    const items = mk([['A', 'B'], ['B', 'C'], ['C', null]]);
    expect(resolveCatalogItem('A', items)?.id).toBe('C');
    expect(resolveCatalogItem('C', items)?.id).toBe('C');
  });
  it('unknown id -> null', () => {
    expect(resolveCatalogItem('Z', mk([['A', null]]))).toBeNull();
  });
  it('never spins on a corrupt loop', () => {
    const items = mk([['A', 'B'], ['B', 'A']]);
    expect(resolveCatalogItem('A', items)).not.toBeNull();
  });
  it('refuses A -> B -> A and A -> A', () => {
    const items = mk([['A', null], ['B', 'A']]);
    expect(wouldCreateMergeCycle('A', 'B', items)).toBe(true); // B already resolves to A
    expect(wouldCreateMergeCycle('A', 'A', items)).toBe(true);
    expect(wouldCreateMergeCycle('B', 'A', items)).toBe(false);
    expect(wouldCreateMergeCycle('A', 'C', mk([['A', null], ['C', null]]))).toBe(false);
  });
});
