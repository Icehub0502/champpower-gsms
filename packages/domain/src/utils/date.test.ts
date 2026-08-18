import { describe, expect, it } from 'vitest';
import { dayKey, dayLabel, shiftDay, todayKey } from './date.js';

describe('dayKey — LOCAL time bucketing', () => {
  it('buckets by local calendar date, not the UTC date', () => {
    // 2026-08-18 23:30 local time must stay on 2026-08-18, even though in UTC+ zones
    // ahead of GMT that instant can already read as the next UTC day.
    const local = new Date(2026, 7, 18, 23, 30); // month is 0-indexed: 7 = August
    expect(dayKey(local)).toBe('2026-08-18');
  });

  it('pads month and day to 2 digits', () => {
    expect(dayKey(new Date(2026, 0, 5))).toBe('2026-01-05');
  });

  it('returns empty string for an invalid date', () => {
    expect(dayKey('not-a-date')).toBe('');
  });
});

describe('shiftDay', () => {
  it('moves forward across a month boundary', () => {
    expect(shiftDay('2026-01-31', 1)).toBe('2026-02-01');
  });
  it('moves backward across a year boundary', () => {
    expect(shiftDay('2026-01-01', -1)).toBe('2025-12-31');
  });
});

describe('dayLabel', () => {
  it('labels today / yesterday / tomorrow specially', () => {
    const today = todayKey();
    expect(dayLabel(today)).toBe('วันนี้');
    expect(dayLabel(shiftDay(today, -1))).toBe('เมื่อวาน');
    expect(dayLabel(shiftDay(today, 1))).toBe('พรุ่งนี้');
  });

  it('formats other dates as Thai day/month/short-Buddhist-year', () => {
    // Fixed historical date (2026-01-15, a Thursday) so this assertion never collides
    // with "today" — Buddhist year 2026 + 543 = 2569, so the 2-digit year is "69".
    expect(dayLabel('2026-01-15')).toBe('พฤ. 15 ม.ค. 69');
  });
});
