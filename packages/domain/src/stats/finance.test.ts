import { describe, expect, it } from 'vitest';
import { financeLast14Days, financeStats } from './finance.js';
import type { Vehicle } from '../types/vehicle.js';

describe('financeStats', () => {
  const vehicleById = new Map<string, Vehicle>([
    ['v1', { id: 'v1', plate: '1กก1', brand: 'TOYOTA', model: 'VIOS' }],
    ['v2', { id: 'v2', plate: '2กก2', brand: 'HONDA', model: 'CIVIC' }],
  ]);

  const jobs = [
    {
      statusHistory: [{ status: 'delivered' as const, changedAt: '2026-01-10T12:00:00Z' }],
      createdAt: '2026-01-09T12:00:00Z',
      partsNeeded: [{ id: '1', name: 'p', price: 1000, qty: '1' }],
      technician: 'ช่างเอ',
      vehicleId: 'v1',
    },
    {
      statusHistory: [{ status: 'delivered' as const, changedAt: '2026-01-10T12:00:00Z' }],
      createdAt: '2026-01-09T12:00:00Z',
      partsNeeded: [{ id: '2', name: 'p', price: 2000, qty: '1' }],
      technician: 'ช่างบี',
      vehicleId: 'v2',
    },
  ];

  it('aggregates revenue by tech and brand', () => {
    const stats = financeStats(jobs, vehicleById);
    expect(stats.allRev).toBe(3000);
    expect(stats.totalCount).toBe(2);
    expect(stats.byTech['ช่างเอ']).toEqual({ revenue: 1000, count: 1 });
    expect(stats.byTech['ช่างบี']).toEqual({ revenue: 2000, count: 1 });
    expect(stats.byBrand['TOYOTA']).toEqual({ revenue: 1000, count: 1 });
    expect(stats.byBrand['HONDA']).toEqual({ revenue: 2000, count: 1 });
    expect(stats.avgJobValue).toBe(1500);
  });

  it('falls back to "ไม่ระบุยี่ห้อ" for an unknown vehicle', () => {
    const stats = financeStats(
      [{ ...jobs[0]!, vehicleId: 'missing' }],
      vehicleById,
    );
    expect(stats.byBrand['ไม่ระบุยี่ห้อ']).toEqual({ revenue: 1000, count: 1 });
  });
});

describe('financeLast14Days', () => {
  it('is always exactly 14 entries, zero-filled for days with no revenue', () => {
    const series = financeLast14Days({});
    expect(series).toHaveLength(14);
    expect(series.every((d) => d.revenue === 0 && d.count === 0)).toBe(true);
  });

  it('ends on today', () => {
    const series = financeLast14Days({});
    const last = series[series.length - 1]!;
    expect(last.label).toBe('วันนี้');
  });
});
