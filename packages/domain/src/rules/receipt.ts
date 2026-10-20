/**
 * Receipt rules (P3.2): what a line is worth once ticked, the discount that
 * stands, the 40% ceiling, and how the money handed over settles against the
 * bill. Pure — api and web call the same functions (CLAUDE.md s2, s4).
 *
 * Money is integer satang inside, numeric(12,2) text on the wire. Nothing here
 * adds, multiplies or compares baht as floats.
 */
import {
  MoneyError, clampDiscount, formatSatang, mulQty, sumSatang, toQtyCenti, toSatang,
} from './money.js';
import { approvedLineSatang } from './quote.js';

// -----------------------------------------------------------------------------
// Payment methods (Ice 20 Oct, P3.2 B3): cash, transfer, card. Transfer and QR are one
// method. `credit` is gone (no customer owes this shop), `deposit_offset`
// belongs to P3.3 and is not accepted from a client.
// -----------------------------------------------------------------------------
export const PAYMENT_METHODS = ['cash', 'transfer', 'card'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const PAYMENT_METHOD_LABEL: Record<PaymentMethod, string> = {
  cash: 'เงินสด',
  transfer: 'โอน / QR',
  card: 'บัตร',
};

// -----------------------------------------------------------------------------
// The discount ceiling (DECISION-2026-10-07 s2.2; Ice 20 Oct, P3.2 B4)
//
// Ice 20 Oct (P3.2 B4): measured on the FINAL receipt discount (line discounts + document discount) divided by
// the pre-discount total of the lines that were done, wherever the discount came
// from (offer, confirm, or typed at the till). Above 40% takes a manager,
// assistant manager or owner who closes the bill personally, with a reason. The
// same function guards quotation confirm.
// -----------------------------------------------------------------------------
export const DISCOUNT_CEILING_PERCENT = 40;

/** Roles that may close a bill (or confirm a quotation) whose discount is above the ceiling. */
export const CEILING_APPROVER_ROLES = ['owner', 'manager', 'assistant_manager'] as const;

export function roleMayExceedDiscountCeiling(role: string): boolean {
  return (CEILING_APPROVER_ROLES as readonly string[]).includes(role);
}

/**
 * Is the discount above 40% of the base? Integer arithmetic, so exactly 40.00%
 * passes and 40.01% does not (discount x 100 <= 40 x base). With nothing to take
 * a percentage of (base <= 0), any discount above zero exceeds it.
 */
export function discountExceedsCeiling(baseSatang: number, discountSatang: number): boolean {
  if (discountSatang <= 0) return false;
  if (baseSatang <= 0) return true;
  return discountSatang * 100 > DISCOUNT_CEILING_PERCENT * baseSatang;
}

/** "40.01" — the percentage for display, two places, half up. "0.00" when there is no base. */
export function discountPercentText(baseSatang: number, discountSatang: number): string {
  if (baseSatang <= 0 || discountSatang <= 0) return '0.00';
  // hundredths of a percent = discount x 10000 / base, rounded half up
  // BigInt: discount x 20000 can pass 2^53 at the top of numeric(12,2).
  const hundredths = Number((BigInt(discountSatang) * 20000n + BigInt(baseSatang)) / (2n * BigInt(baseSatang)));
  const whole = Math.floor(hundredths / 100);
  return `${whole}.${String(hundredths % 100).padStart(2, '0')}`;
}

export type CeilingRefusal = 'discount_requires_manager' | 'discount_reason_required';

/**
 * The one ceiling check, used at quotation confirm and at closing the bill.
 * Returns null when fine. Order matters for the message: the role is the harder
 * stop (the user cannot fix it by typing), so it is reported first.
 */
export function discountCeilingRefusal(input: {
  baseSatang: number;
  discountSatang: number;
  role: string;
  reason: string | null | undefined;
}): CeilingRefusal | null {
  if (!discountExceedsCeiling(input.baseSatang, input.discountSatang)) return null;
  if (!roleMayExceedDiscountCeiling(input.role)) return 'discount_requires_manager';
  if (!input.reason || input.reason.trim().length === 0) return 'discount_reason_required';
  return null;
}

