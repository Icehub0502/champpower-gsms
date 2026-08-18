import { describe, expect, it } from 'vitest';
import { deliveredAtOf, warrantyEndDate, warrantyStatus } from './warranty.js';
import type { StatusHistoryEntry } from '../types/job.js';

// Noon UTC so the local calendar date stays 2026-01-10 across any realistic test-runner
// timezone (UTC-12 .. UTC+14) — a midnight timestamp would be date-boundary-flaky.
const deliveredHistory: StatusHistoryEntry[] = [
  { status: 'received', changedAt: '2026-01-01T12:00:00Z' },
  { status: 'delivered', changedAt: '2026-01-10T12:00:00Z' },
];

describe('deliveredAtOf', () => {
  it('reads the last delivered entry in history', () => {
    expect(deliveredAtOf({ statusHistory: deliveredHistory, createdAt: '2026-01-01T12:00:00Z' })).toBe(
      '2026-01-10T12:00:00Z',
    );
  });

  it('falls back to createdAt if the car was never actually delivered', () => {
    expect(deliveredAtOf({ statusHistory: [], createdAt: '2026-01-01T12:00:00Z' })).toBe('2026-01-01T12:00:00Z');
  });
});

describe('warrantyEndDate / warrantyStatus', () => {
  it('is null when no warranty was ever set', () => {
    expect(warrantyStatus({ warrantyDays: 0, statusHistory: [], createdAt: '2026-01-01T12:00:00Z' })).toBeNull();
    expect(warrantyStatus(null)).toBeNull();
  });

  it('computes the end date as deliveredAt + warrantyDays', () => {
    const job = { warrantyDays: 30, statusHistory: deliveredHistory, createdAt: '2026-01-01T12:00:00Z' };
    expect(warrantyEndDate(job)).toBe('2026-02-09');
  });
});
