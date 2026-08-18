import { describe, expect, it } from 'vitest';
import { VEHICLE_MODELS, seedKeyOf } from './vehicleModels.js';

describe('VEHICLE_MODELS', () => {
  it('matches the shop catalogue count exactly (103 entries)', () => {
    expect(VEHICLE_MODELS).toHaveLength(103);
  });

  it('has no duplicate brand+name pairs', () => {
    const keys = VEHICLE_MODELS.map((m) => seedKeyOf(m.brand, m.name));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('every entry has both brand and name non-empty', () => {
    expect(VEHICLE_MODELS.every((m) => m.brand.trim() && m.name.trim())).toBe(true);
  });
});
