import { describe, expect, it } from 'vitest';
import { jobBestPrice, jobDiscountAmount, jobGrandTotal, jobPartsTotal } from './pricing.js';

describe('jobPartsTotal', () => {
  it('sums price * qty, defaulting qty to 1', () => {
    const job = {
      partsNeeded: [
        { id: '1', name: 'a', price: 100, qty: '2' },
        { id: '2', name: 'b', price: 50 }, // no qty -> 1
        { id: '3', name: 'c', price: 0 }, // no price -> ignored
      ],
    };
    expect(jobPartsTotal(job)).toBe(250);
  });
});

describe('jobDiscountAmount — clamped so it never exceeds the subtotal', () => {
  it('percent mode', () => {
    const job = { partsNeeded: [{ id: '1', name: 'a', price: 1000, qty: '1' }], discountValue: 20, discountType: 'percent' as const };
    expect(jobDiscountAmount(job)).toBe(200);
  });

  it('amount mode, clamped to the subtotal when the discount is larger', () => {
    const job = { partsNeeded: [{ id: '1', name: 'a', price: 1000, qty: '1' }], discountValue: 5000, discountType: 'amount' as const };
    expect(jobDiscountAmount(job)).toBe(1000); // never negative total
  });

  it('is 0 with no parts priced yet', () => {
    expect(jobDiscountAmount({ partsNeeded: [], discountValue: 20, discountType: 'percent' })).toBe(0);
  });
});

describe('jobBestPrice — falls back to the hand-typed estimate', () => {
  it('uses the grand total once parts are priced', () => {
    const job = { partsNeeded: [{ id: '1', name: 'a', price: 500, qty: '1' }], priceEstimate: 9999 };
    expect(jobBestPrice(job)).toBe(jobGrandTotal(job));
    expect(jobBestPrice(job)).toBe(500);
  });

  it('falls back to priceEstimate when no parts are priced', () => {
    expect(jobBestPrice({ partsNeeded: [], priceEstimate: 1200 })).toBe(1200);
  });
});
