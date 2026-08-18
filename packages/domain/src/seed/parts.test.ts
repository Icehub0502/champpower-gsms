import { describe, expect, it } from 'vitest';
import { FALLBACK_CATEGORY, groupByCategory } from './parts.js';

describe('groupByCategory', () => {
  it('orders known categories by PART_CATEGORIES and buckets unknowns at the end', () => {
    const items = [
      { name: 'a', category: 'ของเหลว' },
      { name: 'b', category: 'ทั่วไป' },
      { name: 'c', category: 'มั่ว' }, // unrecognized
    ];
    const grouped = groupByCategory(items);
    expect(grouped.map((g) => g.category)).toEqual(['ทั่วไป', 'ของเหลว', FALLBACK_CATEGORY]);
    expect(grouped.find((g) => g.category === FALLBACK_CATEGORY)?.items).toEqual([{ name: 'c', category: 'มั่ว' }]);
  });

  it('omits categories with no items rather than showing empty groups', () => {
    const grouped = groupByCategory([{ name: 'a', category: 'ทั่วไป' }]);
    expect(grouped).toHaveLength(1);
  });
});
