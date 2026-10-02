/**
 * Money helpers (CLAUDE.md §4). Money is an integer number of SATANG inside
 * TypeScript and a decimal string ("1234.50") on the wire; numeric(12,2) in
 * SQL. Never add, subtract or multiply baht as floats.
 *
 * Quantity is numeric(12,2) too, so it is carried as an integer count of
 * hundredths ("qty centi"). A line total is qty x unit price rounded ONCE, to
 * the satang, per line (§4.3) — BigInt in the middle because
 * 10^12 centi x 10^14 satang overflows 2^53.
 *
 * Rounding is half away from zero, the same as Postgres numeric round().
 */

// numeric(12,2) holds 9,999,999,999.99 — twelve digits including the satang.
export const MAX_SATANG = 999_999_999_999;
const DECIMAL_RE = /^-?\d+(\.\d{1,2})?$/;

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

/**
 * The one gate every computed money value passes through before it leaves
 * this file: a result a numeric(12,2) column could not hold is a MoneyError
 * here, not a Postgres "numeric field overflow" three layers downstream.
 * Call this on every value mulQty / sumSatang / any future money-producing
 * function returns — not only on parsed input (toSatang / toQtyCenti already
 * guard that at the boundary).
 */
export function assertInRange(satang: number): number {
  if (!Number.isSafeInteger(satang) || satang > MAX_SATANG || satang < -MAX_SATANG) {
    throw new MoneyError('out of range for numeric(12,2)');
  }
  return satang;
}

function parseDecimalToHundredths(v: string | number, what: string): number {
  const s = typeof v === 'number' ? numberToPlain(v) : v.trim();
  if (!DECIMAL_RE.test(s)) throw new MoneyError(`${what}: not a decimal with at most 2 places`);
  const neg = s.startsWith('-');
  const body = neg ? s.slice(1) : s;
  const [whole = '0', frac = ''] = body.split('.');
  const hundredths = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  if (!Number.isSafeInteger(hundredths) || hundredths > MAX_SATANG) {
    throw new MoneyError(`${what}: out of range`);
  }
  return neg ? -hundredths : hundredths;
}

// A JS number is accepted only when it is already an exact 2-place value; the
// check is string-based so 0.1 + 0.2 style float residue is refused, not rounded.
function numberToPlain(n: number): string {
  if (!Number.isFinite(n)) throw new MoneyError('not a finite number');
  const s = String(n);
  if (/e/i.test(s)) throw new MoneyError('exponent notation is not accepted');
  return s;
}

/** "1234.5" / 1234.5 -> 123450. Throws MoneyError on anything with more than 2 decimals. */
export function toSatang(v: string | number): number {
  return parseDecimalToHundredths(v, 'money');
}

/** Quantity "2" / "1.5" -> 200 / 150 (hundredths). */
export function toQtyCenti(v: string | number): number {
  return parseDecimalToHundredths(v, 'qty');
}

function formatHundredths(h: number): string {
  assertInRange(h);
  const neg = h < 0;
  const abs = Math.abs(h);
  const whole = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, '0');
  return `${neg ? '-' : ''}${whole}.${frac}`;
}

/** 123450 -> "1234.50" — the form numeric(12,2) round-trips as. */
export function formatSatang(satang: number): string {
  return formatHundredths(satang);
}

export function formatQtyCenti(centi: number): string {
  return formatHundredths(centi);
}

/**
 * qty (hundredths) x unit price (satang) -> satang, rounded once, half away
 * from zero. A result beyond numeric(12,2) (e.g. qty 100,000 x price
 * 999,999.99) is a MoneyError here, not a silent pass-through that only fails
 * later at INSERT (assertInRange).
 */
export function mulQty(qtyCenti: number, unitPriceSatang: number): number {
  const p = BigInt(qtyCenti) * BigInt(unitPriceSatang);
  const d = 100n;
  const neg = p < 0n;
  const abs = neg ? -p : p;
  const rounded = (abs + d / 2n) / d;
  const magnitude = Number(rounded);
  if (!Number.isSafeInteger(magnitude)) throw new MoneyError('line total overflow');
  // Negate the NUMBER, not the BigInt: BigInt has no -0, so negating a zero
  // BigInt stays 0, and Number(0n) is +0. Unary minus on the number +0 is the
  // only way to get the signed -0 that keeps mulQty(-q, p) === -mulQty(q, p).
  const out = neg ? -magnitude : magnitude;
  return assertInRange(out);
}

/** Same bound as mulQty: a sum beyond numeric(12,2) is a MoneyError, not a silent pass-through. */
export function sumSatang(values: readonly number[]): number {
  let t = 0;
  for (const v of values) t += v;
  if (!Number.isSafeInteger(t)) throw new MoneyError('sum overflow');
  return assertInRange(t);
}

/**
 * A discount can never take a total below zero (§4.5). Negative input is
 * treated as no discount rather than silently increasing the total.
 */
export function clampDiscount(discountSatang: number, subtotalSatang: number): number {
  if (discountSatang <= 0 || subtotalSatang <= 0) return 0;
  return Math.min(discountSatang, subtotalSatang);
}
