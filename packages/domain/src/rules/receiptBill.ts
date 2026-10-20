/**
 * The bill itself (P3.2): what a ticked line is worth, line and document
 * discounts, the channel surcharge, and how the money handed over settles.
 * Pure - api and web call the same functions (CLAUDE.md s2, s4). The 40% ceiling
 * and the payment methods live in ./receipt.ts.
 *
 * Money is integer satang inside, numeric(12,2) text on the wire. Nothing here
 * adds, multiplies or compares baht as floats; rounding is once per line, then
 * summed (CLAUDE.md s4.3).
 */
import {
  MoneyError, clampDiscount, formatSatang, mulQty, sumSatang, toQtyCenti, toSatang,
} from './money.js';
import { approvedLineSatang } from './quote.js';
import { PAYMENT_METHODS, discountExceedsCeiling, type PaymentMethod } from './receipt.js';

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
  /** Ice 20 Oct (P3.2 B4): a discount on this one line, "0.00" when none. */
  lineDiscount: string;
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
  // Ice 20 Oct (P3.2 B5): a set is done or not done as a whole.
  if (line.isSet && f !== 0 && f !== q) return 'set_must_be_whole';
  return null;
}

/**
 * What a ticked line costs the customer BEFORE any discount, in satang; null
 * while it is unticked. A set is all or nothing (its agreed amount, else its
 * total). Any other line is the fulfilled quantity x unit price, rounded ONCE per
 * line (CLAUDE.md s4.3).
 */
export function receiptLineCharge(line: ReceiptLineMoney): number | null {
  if (line.fulfilledQty === null) return null;
  const f = toQtyCenti(line.fulfilledQty);
  if (f === 0) return 0;
  if (line.isSet) return approvedLineSatang(line);
  // A cut agreed amount only exists on a set; for a plain line it is always null.
  return mulQty(f, toSatang(line.unitPrice));
}

export type LineDiscountIssue = 'invalid' | 'line_not_answered' | 'exceeds_line' | 'reason_required';

/**
 * Ice 20 Oct (P3.2 B4): is this discount on this line acceptable? null = yes.
 * Zero is always fine (it clears the discount). A discount needs a ticked line,
 * may not exceed that line's charge, and needs a reason typed by staff.
 */
export function receiptLineDiscountIssue(
  line: ReceiptLineMoney,
  discount: string,
  reason: string | null | undefined,
): LineDiscountIssue | null {
  let d: number;
  try {
    d = toSatang(discount);
  } catch (e) {
    if (e instanceof MoneyError) return 'invalid';
    throw e;
  }
  if (d < 0) return 'invalid';
  if (d === 0) return null;
  const gross = receiptLineCharge(line);
  if (gross === null) return 'line_not_answered';
  if (d > gross) return 'exceeds_line';
  if (!reason || reason.trim().length === 0) return 'reason_required';
  return null;
}

/** The line's discount as actually applied: never above its charge (net safety). Satang. */
export function appliedLineDiscount(line: ReceiptLineMoney): number {
  const gross = receiptLineCharge(line);
  if (gross === null) return 0;
  return clampDiscount(toSatang(line.lineDiscount), gross);
}

/** Charge less its own discount; null while unticked. */
export function receiptLineNet(line: ReceiptLineMoney): number | null {
  const gross = receiptLineCharge(line);
  return gross === null ? null : gross - appliedLineDiscount(line);
}

export interface ReceiptSubtotal {
  /** Sum of the charged lines, before ANY discount (the base of the 40% ceiling). Unticked lines count 0. */
  subtotal: number;
  /** Sum of the per-line discounts, each clamped on its own line first, then added (CLAUDE.md s4.3). */
  lineDiscountTotal: number;
  /** Lines staff has not answered yet. The bill cannot close while any remain. */
  undecidedLineIds: string[];
  /** True when every line is ticked done in full (fulfilled = approved qty). */
  fullyDone: boolean;
}

export function receiptSubtotal(lines: readonly ReceiptLineMoney[]): ReceiptSubtotal {
  const undecided = lines.filter((l) => l.fulfilledQty === null).map((l) => l.id);
  const subtotal = sumSatang(lines.map((l) => receiptLineCharge(l) ?? 0));
  const lineDiscountTotal = sumSatang(lines.map(appliedLineDiscount));
  const fullyDone = lines.length > 0 && lines.every(
    (l) => l.fulfilledQty !== null && toQtyCenti(l.fulfilledQty) === toQtyCenti(l.qty),
  );
  return { subtotal, lineDiscountTotal, undecidedLineIds: undecided, fullyDone };
}

// -----------------------------------------------------------------------------
// The document-level discount that stands on the receipt
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
  /** The document discount in force, satang (0 while 'needs_entry'). */
  discount: number;
}

/**
 * DECISION-2026-10-15 s1, extended to the receipt (AC-C2): a discount agreed on
 * 5,000 means nothing on the 3,000 left after a line was not done, so it is NOT
 * carried - the system forces the decision, it does not take it.
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

/**
 * A typed document discount larger than what is left after the line discounts
 * is refused, not clamped (A-11 / AC-C2). `afterLineDiscountsSatang` =
 * subtotal - lineDiscountTotal.
 */
export function discountExceedsSubtotal(afterLineDiscountsSatang: number, discountSatang: number): boolean {
  return discountSatang > afterLineDiscountsSatang;
}

/**
 * Is a written reason required for the DOCUMENT discount / the ceiling? (A-10:
 * whenever the document discount differs from the agreed one; and whenever the
 * TOTAL discount, line discounts included, is above the ceiling.) Each line
 * discount carries its own reason separately.
 */
export function receiptDiscountReasonRequired(input: {
  discountSatang: number;
  agreedDiscountSatang: number;
  baseSatang: number;
  /** Line discounts + document discount. Defaults to the document discount alone. */
  totalDiscountSatang?: number;
}): boolean {
  return input.discountSatang !== input.agreedDiscountSatang
    || discountExceedsCeiling(input.baseSatang, input.totalDiscountSatang ?? input.discountSatang);
}

export interface ReceiptTotals {
  /** Charged lines before any discount. */
  subtotal: number;
  /** Sum of the line discounts. */
  lineDiscountTotal: number;
  /** The document-level discount applied (clamped so the bill never goes negative). */
  discount: number;
  /** lineDiscountTotal + discount: the figure the 40% ceiling is measured on. */
  totalDiscount: number;
  /** ยอดบิล - the bill total, before any surcharge and any deposit (no deposit in P3.2). */
  billTotal: number;
}

export function receiptTotals(subtotalSatang: number, lineDiscountTotalSatang: number, discountSatang: number): ReceiptTotals {
  const afterLines = subtotalSatang - lineDiscountTotalSatang;
  const discount = clampDiscount(discountSatang, afterLines);
  const totalDiscount = lineDiscountTotalSatang + discount;
  return {
    subtotal: subtotalSatang, lineDiscountTotal: lineDiscountTotalSatang, discount, totalDiscount,
    billTotal: subtotalSatang - totalDiscount,
  };
}

// -----------------------------------------------------------------------------
// Payment channel surcharge (Ice 20 Oct, P3.2 B3; the DISPLAY is a
// DEFAULT pending Ice (B3 surcharge display): its own line on the receipt, not a
// discount, not part of the 40% base, counted in "money in" and in sales as a
// separate category)
// -----------------------------------------------------------------------------

/**
 * The one surcharge function. `percent` is the channel's numeric(5,2) text
 * ("3.00"); the fee is on the amount APPLIED to the bill through that channel,
 * rounded once, half away from zero, to the satang (CLAUDE.md s4.3).
 */
export function surchargeSatang(appliedSatang: number, percent: string): number {
  const p = toSatang(percent); // hundredths of a percent: "3.00" -> 300
  if (p <= 0 || appliedSatang <= 0) return 0;
  const n = BigInt(appliedSatang) * BigInt(p);
  return Number((n + 5000n) / 10000n);
}

// -----------------------------------------------------------------------------
// Settling the money handed over
// -----------------------------------------------------------------------------

export interface PaymentEntry {
  /** Which payment channel (the caller's own key; carried through to the result). */
  key: string;
  /** The channel's kind. */
  method: PaymentMethod;
  /** The channel's surcharge percent, numeric text. */
  surchargePercent: string;
  /** The amount applied to the bill through this channel (before its surcharge). */
  amount: string;
}

export interface SettledPayment {
  key: string;
  method: PaymentMethod;
  /** Applied to the bill. */
  applied: string;
  /** The channel's fee on `applied`. */
  surcharge: string;
  /** Handed over = applied + surcharge. This is payments.amount. */
  amount: string;
  /** Given back - cash only. */
  changeGiven: string;
}

export type PaymentSettlement =
  | {
      ok: true;
      rows: SettledPayment[];
      /** SUM(amount - change_given): the bill total plus the surcharges. */
      netPaid: string;
      /** Total change, cash only. */
      change: string;
      surchargeTotal: string;
    }
  | { ok: false; code: 'payment_short'; short: string }
  | { ok: false; code: 'payment_over_noncash'; over: string }
  | { ok: false; code: 'payment_cash_unneeded' }
  | { ok: false; code: 'payment_invalid'; field: 'amount' | 'method' | 'channel' };

/**
 * Match what was handed over against the bill (AC-D1..D8).
 *
 *  - applied = what counts toward the bill; SUM(applied) - change = bill total.
 *    Short blocks, naming the shortfall.
 *  - Only cash may give change (A-12). Transfer / card above the bill is refused.
 *  - Each channel adds its own surcharge on what is applied through it; that is
 *    on top of the bill, never part of it.
 *  - The change is stored on the first cash row and is strictly less than what
 *    that row applied (a cash row that is entirely change is a mistake).
 *  - One row per channel.
 */
export function settlePayments(dueSatang: number, entries: readonly PaymentEntry[]): PaymentSettlement {
  if (entries.length === 0) return { ok: false, code: 'payment_short', short: formatSatang(Math.max(dueSatang, 0)) };
  const seen = new Set<string>();
  const parsed: Array<{ key: string; method: PaymentMethod; applied: number; surcharge: number }> = [];
  for (const e of entries) {
    if (!(PAYMENT_METHODS as readonly string[]).includes(e.method)) return { ok: false, code: 'payment_invalid', field: 'method' };
    if (seen.has(e.key)) return { ok: false, code: 'payment_invalid', field: 'channel' };
    seen.add(e.key);
    let a: number;
    let fee: number;
    try {
      a = toSatang(e.amount);
      fee = surchargeSatang(a, e.surchargePercent);
    } catch (err) {
      if (err instanceof MoneyError) return { ok: false, code: 'payment_invalid', field: 'amount' };
      throw err;
    }
    if (a <= 0) return { ok: false, code: 'payment_invalid', field: 'amount' };
    parsed.push({ key: e.key, method: e.method, applied: a, surcharge: fee });
  }
  let applied: number;
  let noncash: number;
  let fees: number;
  try {
    applied = sumSatang(parsed.map((p) => p.applied));
    noncash = sumSatang(parsed.filter((p) => p.method !== 'cash').map((p) => p.applied));
    fees = sumSatang(parsed.map((p) => p.surcharge));
  } catch (err) {
    if (err instanceof MoneyError) return { ok: false, code: 'payment_invalid', field: 'amount' };
    throw err;
  }
  if (applied < dueSatang) return { ok: false, code: 'payment_short', short: formatSatang(dueSatang - applied) };
  if (noncash > dueSatang) return { ok: false, code: 'payment_over_noncash', over: formatSatang(noncash - dueSatang) };
  const change = applied - dueSatang;
  const cash = parsed.find((p) => p.method === 'cash');
  if (change > 0 && (!cash || change >= cash.applied)) return { ok: false, code: 'payment_cash_unneeded' };
  return {
    ok: true,
    rows: parsed.map((p) => ({
      key: p.key,
      method: p.method,
      applied: formatSatang(p.applied),
      surcharge: formatSatang(p.surcharge),
      amount: formatSatang(p.applied + p.surcharge),
      changeGiven: formatSatang(p === cash ? change : 0),
    })),
    netPaid: formatSatang(applied + fees - change),
    change: formatSatang(change),
    surchargeTotal: formatSatang(fees),
  };
}
