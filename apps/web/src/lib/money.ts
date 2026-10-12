// Money on screen. Every figure the quotation screen shows is a decimal string
// the server computed (packages/domain quoteTotals) or an integer satang value
// a domain helper returned — this file only turns those into text. It never
// adds, subtracts or multiplies baht (CLAUDE.md §4): the conversion goes
// through the domain's integer-satang parser, so "1234.50" is shown exactly,
// not via a float that could print 1234.4999.

import { toSatang } from '@champpower/domain';
import { MoneyString } from '@gsms/contracts/index.js';

function groupThousands(whole: number): string {
  return String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** 123450 -> "1,234.50"; -50000 -> "-500.00". */
export function formatSatangText(satang: number): string {
  const neg = satang < 0;
  const abs = Math.abs(satang);
  const whole = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, '0');
  return `${neg ? '-' : ''}${groupThousands(whole)}.${frac}`;
}

/** "1234.5" -> "฿1,234.50". A value that is not a decimal string shows as "฿—", never as a guess. */
export function baht(value: string): string {
  try {
    return `฿${formatSatangText(toSatang(value))}`;
  } catch {
    return '฿—';
  }
}

/** A signed difference in satang: +120000 -> "+฿1,200.00", -50000 -> "−฿500.00". */
export function bahtDelta(satang: number): string {
  if (satang === 0) return '฿0.00';
  const sign = satang > 0 ? '+' : '−';
  return `${sign}฿${formatSatangText(Math.abs(satang))}`;
}

/**
 * Parse a typed amount, or null if it is not what the API accepts as money
 * (the contract's MoneyString: non-negative, at most 2 decimals). Same schema
 * as the request, so the screen and the server cannot disagree on "valid".
 */
export function typedSatang(text: string): number | null {
  const parsed = MoneyString.safeParse(text);
  if (!parsed.success) return null;
  try {
    return toSatang(parsed.data);
  } catch {
    return null;
  }
}
