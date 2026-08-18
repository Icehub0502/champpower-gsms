import { describe, expect, it } from 'vitest';
import { estMinutes, repairCycle } from './eta.js';
import type { StatusHistoryEntry } from '../types/job.js';

describe('estMinutes', () => {
  it('converts hours/days into minutes using the unit multiplier', () => {
    expect(estMinutes({ estValue: 2, estUnit: 'hour' })).toBe(120);
    expect(estMinutes({ estValue: 1, estUnit: 'day' })).toBe(1440);
    expect(estMinutes({ estValue: 45, estUnit: 'minute' })).toBe(45);
  });

  it('defaults to 0 when no estimate was ever entered', () => {
    expect(estMinutes(null)).toBe(0);
    expect(estMinutes({ estValue: 0, estUnit: 'hour' })).toBe(0);
  });
});

describe('repairCycle — only the CURRENT pass counts', () => {
  it('finds the LAST repairing entry, not the first, when a car went round twice', () => {
    // Delivered once, brought back, put on the lift again.
    const statusHistory: StatusHistoryEntry[] = [
      { status: 'received', changedAt: '2026-01-01T08:00:00Z' },
      { status: 'repairing', changedAt: '2026-01-01T09:00:00Z' },
      { status: 'ready', changedAt: '2026-01-01T10:00:00Z' },
      { status: 'delivered', changedAt: '2026-01-01T11:00:00Z' },
      { status: 'repairing', changedAt: '2026-01-05T09:00:00Z' }, // second visit
    ];
    const cycle = repairCycle({ status: 'repairing', statusHistory });
    expect(cycle.start).toBe('2026-01-05T09:00:00Z');
    expect(cycle.end).toBe(''); // still in progress on the second pass
  });

  it('returns no clock at all for pre-repair statuses', () => {
    expect(repairCycle({ status: 'quoted', statusHistory: [] })).toEqual({ start: '', end: '' });
  });

  it('closes the cycle on the first WORK_DONE status after repairing started', () => {
    const statusHistory: StatusHistoryEntry[] = [
      { status: 'approved', changedAt: '2026-01-01T08:00:00Z' },
      { status: 'repairing', changedAt: '2026-01-01T09:00:00Z' },
      { status: 'ready', changedAt: '2026-01-01T12:30:00Z' },
    ];
    expect(repairCycle({ status: 'ready', statusHistory })).toEqual({
      start: '2026-01-01T09:00:00Z',
      end: '2026-01-01T12:30:00Z',
    });
  });
});
