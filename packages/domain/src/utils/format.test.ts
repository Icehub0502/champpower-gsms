import { describe, expect, it } from 'vitest';
import { fmtDT, fmtMins, fmtMoney, fmtSecs } from './format.js';

describe('fmtMoney', () => {
  it('formats with thousand separators and 2 decimals', () => {
    expect(fmtMoney(1234.5)).toBe('1,234.50');
  });

  it('defaults null/undefined/NaN to 0.00', () => {
    expect(fmtMoney(null)).toBe('0.00');
    expect(fmtMoney(undefined)).toBe('0.00');
    expect(fmtMoney('not-a-number')).toBe('0.00');
  });
});

describe('fmtMins', () => {
  it('renders days + hours + minutes, dropping zero parts', () => {
    expect(fmtMins(60)).toBe('1 ชม.');
    expect(fmtMins(90)).toBe('1 ชม. 30 น.');
    expect(fmtMins(1500)).toBe('1 วัน 1 ชม.'); // 1440 + 60
  });

  it('renders minutes-only under an hour', () => {
    expect(fmtMins(45)).toBe('45 น.');
  });
});

describe('fmtSecs', () => {
  it('renders seconds-only under a minute', () => {
    expect(fmtSecs(42)).toBe('42 ว.');
  });

  it('renders hours + padded minutes + padded seconds', () => {
    expect(fmtSecs(3725)).toBe('1 ชม. 02 น. 05 ว.');
  });
});

describe('fmtDT', () => {
  it('formats an ISO timestamp as DD/MM/YYYY HH:mm in local time', () => {
    // Noon UTC stays the same calendar day across any realistic timezone.
    const result = fmtDT('2026-08-18T12:00:00Z');
    expect(result).toMatch(/^18\/08\/2026 \d{2}:\d{2}$/);
  });

  it('returns "-" for missing input', () => {
    expect(fmtDT(null)).toBe('-');
    expect(fmtDT(undefined)).toBe('-');
    expect(fmtDT('')).toBe('-');
  });
});
