/**
 * Deposit rules (P3.3, CLAUDE.md s5.4): who may do what with a customer's deposit, when it
 * is overdue, and how deposits offset a bill. Pure - api and web call the same functions
 * (CLAUDE.md s2, s4). Money is integer satang inside, numeric(12,2) text on the wire.
 *
 * A deposit is NOT part of the bill: it never reduces grand_total (s5.4 item 6) and carries
 * no VAT, neither when received nor when offset (s7 item 3b) - VAT, when the room opens, is
 * computed from the full bill, and this module never touches it.
 */
import { MoneyError, sumSatang, toSatang } from './money.js';

export const DEPOSIT_CHANNELS = ['walk_in', 'page', 'line', 'phone'] as const;
export type DepositChannel = (typeof DEPOSIT_CHANNELS)[number];

export const DEPOSIT_REASONS = ['booking', 'special_part', 'large_job'] as const;
export type DepositReason = (typeof DEPOSIT_REASONS)[number];

export const DEPOSIT_STATUSES = ['held', 'applied', 'refunded', 'forfeited'] as const;
export type DepositStatus = (typeof DEPOSIT_STATUSES)[number];

export const DEPOSIT_CHANNEL_LABEL: Record<DepositChannel, string> = {
  walk_in: 'หน้าร้าน',
  page: 'เพจ',
  line: 'LINE',
  phone: 'โทรศัพท์',
};

export const DEPOSIT_REASON_LABEL: Record<DepositReason, string> = {
  booking: 'จองคิว',
  special_part: 'สั่งอะไหล่พิเศษ',
  large_job: 'งานใหญ่',
};

export const DEPOSIT_STATUS_LABEL: Record<DepositStatus, string> = {
  held: 'ถืออยู่',
  applied: 'หักเข้าบิลแล้ว',
  refunded: 'คืนแล้ว',
  forfeited: 'ริบแล้ว',
};

/**
 * The only title the customer's slip may carry (s5.4 item 4b): never "ใบเสร็จรับเงิน",
 * never "ใบกำกับภาษี". The API sends it with the slip; the screen prints what it is given.
 */
export const DEPOSIT_SLIP_TITLE = 'ใบรับเงินมัดจำ';

// -----------------------------------------------------------------------------
// Roles (s12.1, s5.4 item 8)
// -----------------------------------------------------------------------------

/** Take a deposit, attach it to a job, print its slip, offset it into a bill: whoever takes money. */
export const DEPOSIT_WRITE_ROLES = ['owner', 'manager', 'assistant_manager', 'advisor'] as const;
/** Refund: advisor and above, reason required. */
export const DEPOSIT_REFUND_ROLES = DEPOSIT_WRITE_ROLES;
/**
 * Forfeit turns the customer's money into the shop's: manager and above (s5.4 item 8).
 * DEFAULT pending Ice (P3.3 D3): "manager ขึ้นไป" is read as owner + manager; assistant_manager is
 * NOT included (an assistant manager is below manager in the matrix).
 */
export const DEPOSIT_FORFEIT_ROLES = ['owner', 'manager'] as const;

export function roleMayWriteDeposit(role: string): boolean {
  return (DEPOSIT_WRITE_ROLES as readonly string[]).includes(role);
}
export function roleMayRefundDeposit(role: string): boolean {
  return (DEPOSIT_REFUND_ROLES as readonly string[]).includes(role);
}
export function roleMayForfeitDeposit(role: string): boolean {
  return (DEPOSIT_FORFEIT_ROLES as readonly string[]).includes(role);
}

// -----------------------------------------------------------------------------
// Input gates (CLAUDE.md s4.y: the front gate in front of any CHECK)
// -----------------------------------------------------------------------------

export type DepositAmountIssue = 'invalid_money' | 'must_be_positive';

/** The deposit amount: numeric(12,2) text, strictly above zero. null = fine. */
export function depositAmountIssue(amount: string): DepositAmountIssue | null {
  let s: number;
  try {
    s = toSatang(amount);
  } catch (e) {
    if (e instanceof MoneyError) return 'invalid_money';
    throw e;
  }
  return s > 0 ? null : 'must_be_positive';
}

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

function dayNumber(key: string): number {
  const t = Date.parse(`${key}T00:00:00Z`);
  return Number.isNaN(t) ? NaN : Math.round(t / 86_400_000);
}

export type ExpectedDateIssue = 'invalid_date' | 'in_the_past';

/**
 * The day the customer said they would bring the car (mandatory, s5.4 item 8). A date before
 * today would be overdue the moment it is saved, which is a typo, not a plan.
 * DEFAULT pending Ice (P3.3 D5): today itself is allowed.
 */
export function depositExpectedDateIssue(expected: string, today: string): ExpectedDateIssue | null {
  if (!DAY_KEY.test(expected) || Number.isNaN(dayNumber(expected))) return 'invalid_date';
  return dayNumber(expected) < dayNumber(today) ? 'in_the_past' : null;
}

/**
 * Overdue the moment the expected day has passed - no waiting period (s5.4 item 8).
 * Both arguments are Bangkok day keys; the expected day itself is not yet overdue.
 */
export function isDepositOverdue(status: string, expectedDate: string, today: string): boolean {
  return status === 'held' && dayNumber(expectedDate) < dayNumber(today);
}

/** Whole days past the expected day, 0 when not overdue. */
export function depositDaysOverdue(status: string, expectedDate: string, today: string): number {
  if (!isDepositOverdue(status, expectedDate, today)) return 0;
  return dayNumber(today) - dayNumber(expectedDate);
}

// -----------------------------------------------------------------------------
// Offsetting deposits into a bill (s5.4 item 6)
// -----------------------------------------------------------------------------

export interface OffsetDeposit {
  id: string;
  /** numeric(12,2) text */
  amount: string;
}

export type DepositOffsetPlan =
  | {
      ok: true;
      /** Sum of the deposits applied, satang. */
      offsetTotal: number;
      /** What the customer still owes after the offsets: billTotal - offsetTotal. grand_total is NOT reduced. */
      due: number;
    }
  | { ok: false; code: 'deposit_duplicate'; id: string }
  | {
      ok: false;
      code: 'deposit_exceeds_bill';
      /** Satang over the bill. */
      over: number;
      /** The most that may be offset: the bill total. */
      max: number;
    };

/**
 * Apply whole deposits to a bill. A deposit is applied in full or not at all (the ledger has
 * one `deposit_offset` row per deposit and the deposit moves to `applied`); offsets above the
 * bill total are refused, never clamped - the customer is owed the difference back and the
 * shop must decide how (refund the deposit, or pick fewer).
 * DEFAULT pending Ice (P3.3 D6): no partial application of a deposit.
 */
export function depositOffsetPlan(billTotalSatang: number, deposits: readonly OffsetDeposit[]): DepositOffsetPlan {
  const seen = new Set<string>();
  for (const d of deposits) {
    if (seen.has(d.id)) return { ok: false, code: 'deposit_duplicate', id: d.id };
    seen.add(d.id);
  }
  const offsetTotal = sumSatang(deposits.map((d) => toSatang(d.amount)));
  if (offsetTotal > billTotalSatang) {
    return { ok: false, code: 'deposit_exceeds_bill', over: offsetTotal - billTotalSatang, max: billTotalSatang };
  }
  return { ok: true, offsetTotal, due: billTotalSatang - offsetTotal };
}
