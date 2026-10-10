import { describe, expect, it } from 'vitest';
import { decisionCarries, type LineIdentity } from './quote.js';

const base: LineIdentity = {
  catalogItemId: 'item-1', name: 'ลูกหมาก', lineType: 'part', qty: '1', unitPrice: '1000',
  warrantyTermId: 'w1', warrantyDays: 365, warrantyMaxKm: 100000,
};

describe('decisionCarries (owner Q2: a decision belongs to the offer, not to the item name)', () => {
  it('an identical line carries', () => {
    expect(decisionCarries(base, { ...base })).toBe(true);
  });
  it('numerically equal qty / price written differently still carries', () => {
    expect(decisionCarries(base, { ...base, qty: '1.00', unitPrice: '1000.00' })).toBe(true);
  });
  it('a changed unit price resets — up or down', () => {
    expect(decisionCarries(base, { ...base, unitPrice: '1100' })).toBe(false);
    expect(decisionCarries(base, { ...base, unitPrice: '900' })).toBe(false);
  });
  it('a changed qty, item, name or line type resets', () => {
    expect(decisionCarries(base, { ...base, qty: '2' })).toBe(false);
    expect(decisionCarries(base, { ...base, catalogItemId: 'item-2' })).toBe(false);
    expect(decisionCarries(base, { ...base, name: 'ลูกหมากอื่น' })).toBe(false);
    expect(decisionCarries(base, { ...base, lineType: 'labor' })).toBe(false);
  });
  it('any warranty change resets (term, days, km, added, removed)', () => {
    expect(decisionCarries(base, { ...base, warrantyTermId: 'w2' })).toBe(false);
    expect(decisionCarries(base, { ...base, warrantyDays: 90 })).toBe(false);
    expect(decisionCarries(base, { ...base, warrantyMaxKm: null })).toBe(false);
    expect(decisionCarries({ ...base, warrantyTermId: null, warrantyDays: null, warrantyMaxKm: null }, base)).toBe(false);
  });
  it('a free-text line (no catalog item) is compared by name', () => {
    const free = { ...base, catalogItemId: null };
    expect(decisionCarries(free, { ...free })).toBe(true);
    expect(decisionCarries(free, { ...free, name: 'อย่างอื่น' })).toBe(false);
  });
  it('an unparsable amount never carries (fails safe to "ask again")', () => {
    expect(decisionCarries(base, { ...base, unitPrice: 'abc' })).toBe(false);
  });
});
