import { describe, expect, it } from 'vitest';
import { genJobNumber } from './jobNumber.js';

describe('genJobNumber', () => {
  const now = new Date(2026, 7, 18, 10, 0); // 2026-08-18

  it('starts at 001 when there are no jobs yet today', () => {
    expect(genJobNumber([], now)).toBe('PG260818-001');
  });

  it('increments per job already checked in today', () => {
    const existing = [{ jobNumber: 'PG260818-001' }, { jobNumber: 'PG260818-002' }];
    expect(genJobNumber(existing, now)).toBe('PG260818-003');
  });

  it('ignores jobs from other days', () => {
    const existing = [{ jobNumber: 'PG260817-001' }, { jobNumber: 'PG260817-002' }];
    expect(genJobNumber(existing, now)).toBe('PG260818-001');
  });
});
