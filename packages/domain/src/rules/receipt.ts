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
// Payment methods (DEFAULT pending Ice, P3.2 B3): cash, transfer, card. Transfer and QR are one
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
// The discount ceiling (DECISION-2026-10-07 s2.2; DEFAULT pending Ice, P3.2 B4)
//
// DEFAULT pending Ice (P3.2 B4): measured on the FINAL receipt discount divided by
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

// -----------------------------------------------------------------------------
// Lines
// -----------------------------------------------------------------------------

/** The minimal receipt line the money functions need. Strings are numeric(12,2) text. */
export interface ReceiptLineMoney {
  id: string;
  /** Quantity approved on the quotation. */
  qty: string;
  unitPrice: string;
  /** Agreed amount of a cut set (D10); null = as offered. */
  approvedAmount: string | null;
  /** A set header (it has children on the receipt). B5: ticked as a whole. */
  isSet: boolean;
  /** null = staff has not answered for this line yet. */
  fulfilledQty: string | null;
}

export type FulfilledQtyIssue = 'invalid' | 'exceeds_qty' | 'set_must_be_whole';

/** Is this tick acceptable? null = yes. The front gate in front of any CHECK (CLAUDE.md s4.y). */
export function fulfilledQtyIssue(
  line: Pick<ReceiptLineMoney, 'qty' | 'isSet'>,
  fulfilled: string,
): FulfilledQtyIssue | null {
  let f: number;
  let q: number;
  try {
    f = toQtyCenti(fulfilled);
    q = toQtyCenti(line.qty);
  } catch (e) {
    if (e instanceof MoneyError) return 'invalid';
    throw e;
  }
  if (f < 0) return 'invalid';
  if (f > q) return 'exceeds_qty';
  // DEFAULT pending Ice (P3.2 B5): a set is done or not done as a whole.
  if (line.isSet && f !== 0 && f !== q) return 'set_must_be_whole';
  return null;
}

/**
 * What a ticked line costs the customer, in satang; null while it is unticked.
 * A set is all or nothing (its agreed amount, else its total). Any other line
 * is the fulfilled quantity x unit price, rounded ONCE per line (CLAUDE.md s4.3).
 */
export function receiptLineCharge(line: ReceiptLineMoney): number | null {
  if (line.fulfilledQty === null) return null;
  const f = toQtyCenti(line.fulfilledQty);
  if (f === 0) return 0;
  if (line.isSet) return approvedLineSatang(line);
  // A cut agreed amount only exists on a set; for a plain line it is always null.
  return mulQty(f, toSatang(line.unitPrice));
}

export interface ReceiptSubtotal {
  /** Sum of the charged lines, before any discount. Unticked lines count 0. */
  subtotal: number;
  /** Lines staff has not answered yet. The bill cannot close while any remain. */
  undecidedLineIds: string[];
  /** True when every line is ticked done in full (fulfilled = approved qty). */
  fullyDone: boolean;
}

export function receiptSubtotal(lines: readonly ReceiptLineMoney[]): ReceiptSubtotal {
  const undecided = lines.filter((l) => l.fulfilledQty === null).map((l) => l.id);
  const subtotal = sumSatang(lines.map((l) => receiptLineCharge(l) ?? 0));
  const fullyDone = lines.length > 0 && lines.every(
    (l) => l.fulfilledQty !== null && toQtyCenti(l.fulfilledQty) === toQtyCenti(l.qty),
  );
  return { subtotal, undecidedLineIds: undecided, fullyDone };
}

// -----------------------------------------------------------------------------
// The discount that stands on the receipt
// -----------------------------------------------------------------------------

export type ReceiptDiscountState =
  /** Nothing was agreed and nothing was typed: 0. */
  | 'none'
  /** Every line done in full: the AGREED discount carries over unchanged. */
  | 'carried'
  /** Something was not done: staff must type the discount (0 is allowed). The bill cannot close until they do. */
  | 'needs_entry'
  /** Staff typed it. */
  | 'entered';

export interface ReceiptDiscount {
  state: ReceiptDiscountState;
  /** The discount in force, satang (0 while 'needs_entry'). */
  discount: number;
}

/**
 * DECISION-2026-10-15 s1, extended to the receipt (AC-C2): a discount agreed on
 * 5,000 means nothing on the 3,000 left after a line was not done, so it is NOT
 * carried — the system forces the decision, it does not take it.
 */
export function receiptDiscount(input: {
  lines: readonly ReceiptLineMoney[];
  /** documents.discount of the quotation at confirm (the AGREED discount). */
  agreedDiscount: string;
  /** What staff typed on this draft; null = never typed. */
  entered: string | null;
}): ReceiptDiscount {
  if (input.entered !== null) return { state: 'entered', discount: toSatang(input.entered) };
  const agreed = toSatang(input.agreedDiscount);
  if (agreed <= 0) return { state: 'none', discount: 0 };
  if (receiptSubtotal(input.lines).fullyDone) return { state: 'carried', discount: agreed };
  return { state: 'needs_entry', discount: 0 };
}

/** A typed discount larger than what is being billed is refused, not clamped (A-11 / AC-C2). */
export function discountExceedsSubtotal(subtotalSatang: number, discountSatang: number): boolean {
  return discountSatang > subtotalSatang;
}

/** Is a written reason required? (A-10: whenever it differs from the agreed one; and above the ceiling.) */
export function receiptDiscountReasonRequired(input: {
  discountSatang: number;
  agreedDiscountSatang: number;
  baseSatang: number;
}): boolean {
  return input.discountSatang !== input.agreedDiscountSatang
    || discountExceedsCeiling(input.baseSatang, input.discountSatang);
}

export interface ReceiptTotals {
  subtotal: number;
  discount: number;
  /** ยอดบิล — the bill total, before any deposit (there is no deposit in P3.2). */
  billTotal: number;
}

export function receiptTotals(subtotalSatang: number, discountSatang: number): ReceiptTotals {
  const discount = clampDiscount(discountSatang, subtotalSatang);
  return { subtotal: subtotalSatang, discount, billTotal: subtotalSatang - discount };
}

export function receiptTotalsDecimal(t: ReceiptTotals): Record<keyof ReceiptTotals, string> {
  return {
    subtotal: formatSatang(t.subtotal),
    discount: formatSatang(t.discount),
    billTotal: formatSatang(t.billTotal),
  };
}

// -----------------------------------------------------------------------------
// Settling the money handed over
// -----------------------------------------------------------------------------

export interface PaymentEntry {
  method: PaymentMethod;
  /** What the customer handed over by this method (numeric text). */
  amount: string;
}

export interface SettledPayment {
  method: PaymentMethod;
  /** Handed over. */
  amount: string;
  /** Given back — cash only. */
  changeGiven: string;
}

export type PaymentSettlement =
  | {
      ok: true;
      rows: SettledPayment[];
      /** SUM(amount - change_given): exactly the bill total. */
      netPaid: string;
      /** Total change, cash only. */
      change: string;
    }
  | { ok: false; code: 'payment_short'; short: string }
  | { ok: false; code: 'payment_over_noncash'; over: string }
  | { ok: false; code: 'payment_cash_unneeded' }
  | { ok: false; code: 'payment_invalid'; field: 'amount' | 'method' };

/**
 * Match what was handed over against the bill (AC-D1..D8).
 *
 *  - paid = SUM(amount - change). Short blocks, naming the shortfall.
 *  - Only cash may give change (A-12). Transfer / card above the bill is refused.
 *  - The change is stored on the cash row and is strictly less than that row's
 *    amount (a cash row that is entirely change is a mistake).
 *  - One row per method.
 */
export function settlePayments(dueSatang: number, entries: readonly PaymentEntry[]): PaymentSettlement {
  if (entries.length === 0) return { ok: false, code: 'payment_short', short: formatSatang(Math.max(dueSatang, 0)) };
  const seen = new Set<string>();
  const parsed: Array<{ method: PaymentMethod; amount: number; text: string }> = [];
  for (const e of entries) {
    if (!(PAYMENT_METHODS as readonly string[]).includes(e.method) || seen.has(e.method)) {
      return { ok: false, code: 'payment_invalid', field: 'method' };
    }
    seen.add(e.method);
    let a: number;
    try {
      a = toSatang(e.amount);
    } catch (err) {
      if (err instanceof MoneyError) return { ok: false, code: 'payment_invalid', field: 'amount' };
      throw err;
    }
    if (a <= 0) return { ok: false, code: 'payment_invalid', field: 'amount' };
    parsed.push({ method: e.method, amount: a, text: formatSatang(a) });
  }
  let handed: number;
  let noncash: number;
  try {
    handed = sumSatang(parsed.map((p) => p.amount));
    noncash = sumSatang(parsed.filter((p) => p.method !== 'cash').map((p) => p.amount));
  } catch (err) {
    if (err instanceof MoneyError) return { ok: false, code: 'payment_invalid', field: 'amount' };
    throw err;
  }
  if (handed < dueSatang) return { ok: false, code: 'payment_short', short: formatSatang(dueSatang - handed) };
  if (noncash > dueSatang) return { ok: false, code: 'payment_over_noncash', over: formatSatang(noncash - dueSatang) };
  const change = handed - dueSatang;
  const cash = parsed.find((p) => p.method === 'cash');
  if (change > 0 && (!cash || change >= cash.amount)) return { ok: false, code: 'payment_cash_unneeded' };
  return {
    ok: true,
    rows: parsed.map((p) => ({
      method: p.method,
      amount: p.text,
      changeGiven: formatSatang(p.method === 'cash' ? change : 0),
    })),
    netPaid: formatSatang(handed - change),
    change: formatSatang(change),
  };
}

// -----------------------------------------------------------------------------
// Daily cash count (DEFAULT pending Ice, P3.2 B7)
// -----------------------------------------------------------------------------

/** counted - expected, satang. Negative = the drawer is short. */
export function cashVariance(expectedSatang: number, countedSatang: number): number {
  return countedSatang - expectedSatang;
}

/** A-13: a count that does not match needs a note saying why. */
export function countNeedsNote(varianceSatang: number): boolean {
  return varianceSatang !== 0;
}

/** Roles that may count the drawer (B7: manager and up). */
export const CASH_COUNT_ROLES = ['owner', 'manager', 'assistant_manager'] as const;
