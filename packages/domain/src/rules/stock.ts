/**
 * Stock rules (WO-006, CLAUDE.md s6). Pure: no I/O, no clock, no database.
 *
 * QUANTITIES ARE INTEGERS HERE. numeric(12,2) travels as a decimal string on the
 * wire and as a count of hundredths ("centi") inside this file, the same as
 * money.ts does for satang. Nothing in this module adds, subtracts or compares a
 * quantity as a float.
 *
 * THE MODEL these functions defend (inventory-ledger rules):
 *   - stock_moves is an append-only ledger; stock_balances is a cache of it.
 *   - on_hand  = SUM(qty) over receipt, issue, return, adjustment, count, transfer_*
 *     reserved = SUM(qty) over reserve (+) and unreserve (-)
 *   - available = on_hand - reserved. Any "do we have it?" answer reads this.
 *   - A SKU with NO balance row is NOT COUNTED: nobody has ever told the system how many
 *     there are. That is different from a balance row at zero ("counted, none left").
 *     Not-counted never blocks a sale, never warns "out of stock", never appears in the
 *     low-stock list. Only the first ledger move creates a balance row (a count).
 *   - A shortfall is never modelled as a negative reservation or a negative on_hand.
 *
 * Every function that returns { ok: false } is a FRONT GATE (CLAUDE.md s4.y): the
 * database has a CHECK behind it, but the caller must answer 400/409 with the code
 * from here, never let the CHECK produce a 500.
 */
import { MoneyError, formatQtyCenti, toQtyCenti } from './money.js';

// -----------------------------------------------------------------------------
// Move vocabulary and signs
// -----------------------------------------------------------------------------

export const STOCK_MOVE_TYPES = [
  'receipt', 'reserve', 'unreserve', 'issue', 'return', 'adjustment', 'count', 'transfer_out', 'transfer_in',
] as const;
export type StockMoveType = (typeof STOCK_MOVE_TYPES)[number];

/** Which of the two balance columns a move type changes. */
export function moveTargetOf(type: StockMoveType): 'on_hand' | 'reserved' {
  return type === 'reserve' || type === 'unreserve' ? 'reserved' : 'on_hand';
}

/**
 * The sign each type must carry (mirrors the database's ck_move_sign, migration 0028).
 * adjustment and count are signed deltas; a count may also be exactly zero.
 */
export function moveSignOk(type: StockMoveType, qtyCenti: number): boolean {
  switch (type) {
    case 'receipt': case 'reserve': case 'return': case 'transfer_in': return qtyCenti > 0;
    case 'unreserve': case 'issue': case 'transfer_out': return qtyCenti < 0;
    case 'adjustment': return qtyCenti !== 0;
    case 'count': return true;
  }
}

export interface BalanceCenti {
  onHand: number;
  reserved: number;
}

export type ApplyMoveResult =
  | { ok: true; balance: BalanceCenti }
  | { ok: false; code: 'negative_on_hand' | 'negative_reserved' | 'bad_sign' };

/** The balance after one move, or why it cannot be applied. Never produces a negative column. */
export function applyMove(balance: BalanceCenti, type: StockMoveType, qtyCenti: number): ApplyMoveResult {
  if (!moveSignOk(type, qtyCenti)) return { ok: false, code: 'bad_sign' };
  if (moveTargetOf(type) === 'reserved') {
    const reserved = balance.reserved + qtyCenti;
    return reserved < 0 ? { ok: false, code: 'negative_reserved' } : { ok: true, balance: { ...balance, reserved } };
  }
  const onHand = balance.onHand + qtyCenti;
  return onHand < 0 ? { ok: false, code: 'negative_on_hand' } : { ok: true, balance: { ...balance, onHand } };
}

/** What a replay of the whole ledger says the balance should be. The integrity check compares this to the cache. */
export function ledgerBalanceOf(moves: ReadonlyArray<{ type: StockMoveType; qtyCenti: number }>): BalanceCenti {
  let onHand = 0;
  let reserved = 0;
  for (const m of moves) {
    if (moveTargetOf(m.type) === 'reserved') reserved += m.qtyCenti;
    else onHand += m.qtyCenti;
  }
  return { onHand, reserved };
}

// -----------------------------------------------------------------------------
// Quantity helpers
// -----------------------------------------------------------------------------

/** available = on_hand - reserved. May be negative when a count finds less than is reserved. */
export function availableCenti(b: BalanceCenti): number {
  return b.onHand - b.reserved;
}

/** "3" / "3.5" -> 300 / 350; null when it is not a non-negative quantity with at most 2 decimals. */
export function parseQtyNonNegative(v: string): number | null {
  try {
    const c = toQtyCenti(v);
    return c >= 0 ? c : null;
  } catch (e) {
    if (e instanceof MoneyError) return null;
    throw e;
  }
}

export function formatQty(centi: number): string {
  return formatQtyCenti(centi);
}

/** a x b where both are quantities (hundredths): rounded half up to hundredths, BigInt in the middle. */
export function mulQtyCenti(aCenti: number, bCenti: number): number {
  const p = BigInt(aCenti) * BigInt(bCenti);
  const r = (p + 50n) / 100n;
  const n = Number(r);
  if (!Number.isSafeInteger(n)) throw new MoneyError('qty overflow');
  return n;
}

// -----------------------------------------------------------------------------
// Status and low stock
// -----------------------------------------------------------------------------

export type StockingPolicy = 'stocked' | 'buy_to_order';
export type StockStatus = 'not_counted' | 'out' | 'low' | 'ok';

export interface StockFacts {
  /** null = no balance row = not counted. */
  balance: BalanceCenti | null;
  stockingPolicy: StockingPolicy;
  reorderPointCenti: number | null;
  isActive: boolean;
}

/**
 * DEFAULT pending Ice (reorder point NULL): a stocked, counted SKU with no reorder point is
 * treated as "reorder at 0", so counting a part to zero lists it (WO-006 criterion 8) even
 * when nobody set a reorder point. (migration 0010's board alert needs a non-NULL point and
 * therefore differs; flagged for the lead.)
 * DEFAULT pending Ice (<=): available AT the reorder point is already low.
 */
export function isLowStock(f: StockFacts): boolean {
  if (!f.isActive || f.stockingPolicy !== 'stocked' || f.balance === null) return false;
  return availableCenti(f.balance) <= (f.reorderPointCenti ?? 0);
}

export function stockStatusOf(f: StockFacts): StockStatus {
  if (f.balance === null) return 'not_counted';
  if (isLowStock(f)) return f.balance.onHand <= 0 ? 'out' : 'low';
  return f.balance.onHand <= 0 ? 'out' : 'ok';
}

// -----------------------------------------------------------------------------
// Reserve plan for a confirmed quotation (WO-006 s3)
// -----------------------------------------------------------------------------

export interface StockLine {
  id: string;
  parentLineId: string | null;
  lineType: 'part' | 'labor' | 'fee';
  approvalStatus: 'pending' | 'approved' | 'declined';
  /** The effective SKU of the line (snapshot, else the catalog's current binding), or null. */
  skuId: string | null;
  qty: string;
}

export type SkipReason =
  | 'not_part' | 'not_approved' | 'parent_not_approved' | 'is_set_parent' | 'no_sku' | 'nothing_left';

export interface StockNeed {
  lineId: string;
  skuId: string;
  /** What must physically leave the shelf for this line, minus what was already issued, in hundredths. */
  needCenti: number;
}

export interface StockPlan {
  needs: StockNeed[];
  skipped: Array<{ lineId: string; reason: SkipReason }>;
}

/**
 * Which lines reserve stock, and how much.
 *
 *   - only line_type 'part' with approval_status 'approved' and a SKU;
 *   - a set's PARENT never reserves (it is a price, not a part); its CHILDREN do, and a child
 *     reserves only while its parent is approved (a declined child is simply declined);
 *   - a child's quantity is per set, so it is multiplied by the parent's quantity
 *     (DEFAULT pending Ice: 2 sets need 2 x each component; today's quotation editor never
 *     rescales children when the parent's quantity changes, so this is what the shelf needs);
 *   - `issuedCentiByLine` is what was already issued against the line (and, through
 *     source_line_id, against the revision it was copied from): that part is out of the
 *     building and must not be reserved again.
 * Order follows the input order, which the caller keeps stable (sort_order).
 */
export function planStockNeeds(
  lines: readonly StockLine[],
  issuedCentiByLine: ReadonlyMap<string, number> = new Map(),
): StockPlan {
  const byId = new Map(lines.map((l) => [l.id, l]));
  const parentIds = new Set(lines.filter((l) => l.parentLineId !== null).map((l) => l.parentLineId!));
  const needs: StockNeed[] = [];
  const skipped: StockPlan['skipped'] = [];

  for (const l of lines) {
    if (l.lineType !== 'part') { skipped.push({ lineId: l.id, reason: 'not_part' }); continue; }
    if (parentIds.has(l.id)) { skipped.push({ lineId: l.id, reason: 'is_set_parent' }); continue; }
    if (l.approvalStatus !== 'approved') { skipped.push({ lineId: l.id, reason: 'not_approved' }); continue; }
    const parent = l.parentLineId === null ? undefined : byId.get(l.parentLineId);
    if (l.parentLineId !== null && (!parent || parent.approvalStatus !== 'approved')) {
      skipped.push({ lineId: l.id, reason: 'parent_not_approved' });
      continue;
    }
    if (l.skuId === null) { skipped.push({ lineId: l.id, reason: 'no_sku' }); continue; }

    const own = toQtyCenti(l.qty);
    const gross = parent ? mulQtyCenti(own, toQtyCenti(parent.qty)) : own;
    const need = Math.max(0, gross - (issuedCentiByLine.get(l.id) ?? 0));
    if (need === 0) { skipped.push({ lineId: l.id, reason: 'nothing_left' }); continue; }
    needs.push({ lineId: l.id, skuId: l.skuId, needCenti: need });
  }
  return { needs, skipped };
}

/** How much of a need the shelf can cover right now, and the rest as a shortfall. Never negative. */
export function splitShortfall(needCenti: number, availableNowCenti: number): { reserveCenti: number; shortCenti: number } {
  const reserve = Math.min(needCenti, Math.max(availableNowCenti, 0));
  return { reserveCenti: reserve, shortCenti: needCenti - reserve };
}

/**
 * Does a shortfall deserve a warning and a purchase suggestion? A buy_to_order part is bought
 * for one job on purpose, so "we do not have it" is the normal state and not news (WO-006 s3).
 */
export function shortfallNeedsAction(policy: StockingPolicy): boolean {
  return policy === 'stocked';
}

// -----------------------------------------------------------------------------
// Releasing a reservation when the receipt closes (P3.2 seam)
// -----------------------------------------------------------------------------

/**
 * How much of a line's net reservation goes back when the receipt says `fulfilled` of `qty`
 * was done. A plain line: min(reserved, qty - fulfilled). A child of a set: the reservation
 * is scaled by the unfinished share of the set, rounded UP so that "nothing was done" always
 * releases everything. Never more than what is reserved.
 */
export function releaseShareCenti(reservedNetCenti: number, qtyCenti: number, fulfilledCenti: number): number {
  if (reservedNetCenti <= 0 || qtyCenti <= 0) return 0;
  const undone = Math.max(0, qtyCenti - Math.max(0, fulfilledCenti));
  if (undone === 0) return 0;
  const num = BigInt(reservedNetCenti) * BigInt(undone);
  const den = BigInt(qtyCenti);
  const ceil = Number((num + den - 1n) / den);
  return Math.min(reservedNetCenti, ceil);
}

// -----------------------------------------------------------------------------
// Issue (เบิก)
// -----------------------------------------------------------------------------

export type IssuePlan =
  | { ok: true; issueCenti: number; unreserveCenti: number; extraCenti: number }
  | { ok: false; code: 'insufficient_on_hand' | 'over_reserved_needs_confirm' };

/**
 * Pulling `qty` for one line. The reserved part of it is converted (issue + unreserve in one
 * transaction); anything beyond what this line had reserved is "extra" (a part spoiled in the
 * fitting, or stock that arrived after the shortfall) and needs the explicit confirm flag.
 * Pulling more than is physically on the shelf is refused outright: on_hand never goes negative.
 */
export function planIssue(i: {
  qtyCenti: number;
  lineReservedCenti: number;
  onHandCenti: number;
  reservedTotalCenti: number;
  allowOverReserved: boolean;
}): IssuePlan {
  if (i.qtyCenti <= 0) return { ok: false, code: 'insufficient_on_hand' };
  if (i.qtyCenti > i.onHandCenti) return { ok: false, code: 'insufficient_on_hand' };
  const unreserve = Math.min(i.qtyCenti, Math.max(0, i.lineReservedCenti));
  const extra = i.qtyCenti - unreserve;
  // Even a fully reserved pull is fine; but eating into parts another job has reserved is not.
  const eatsOthers = i.onHandCenti - i.qtyCenti < i.reservedTotalCenti - unreserve;
  if ((extra > 0 || eatsOthers) && !i.allowOverReserved) return { ok: false, code: 'over_reserved_needs_confirm' };
  return { ok: true, issueCenti: i.qtyCenti, unreserveCenti: unreserve, extraCenti: extra };
}

// -----------------------------------------------------------------------------
// Count (ตั้งยอด) and adjustment (ปรับยอด) — the manual doors
// -----------------------------------------------------------------------------

/** Free text, not a dropdown alone: a reason shorter than this is not a reason. DEFAULT pending Ice. */
export const MIN_REASON_LENGTH = 3;
export const MAX_REASON_LENGTH = 500;

export type ManualGate =
  | { ok: true; newCenti: number; deltaCenti: number }
  | { ok: false; status: 400; code: 'invalid_request'; fields: Record<string, string[]> }
  | { ok: false; status: 409; code: 'sku_not_counted' | 'no_change' | 'adjustment_negative' };

function reasonErrors(reason: string): string[] | null {
  const t = reason.trim();
  if (t.length === 0) return ['required'];
  if (t.length < MIN_REASON_LENGTH) return ['too_short'];
  if (t.length > MAX_REASON_LENGTH) return ['too_long'];
  return null;
}

/**
 * A count sets the absolute quantity ("I counted 12"). It is allowed on a never-counted SKU
 * (that is how a SKU becomes counted) and on a counted one, any number of times, and writing
 * zero is legitimate. The delta is current -> counted; current is 0 for a never-counted SKU.
 */
export function gateCount(input: { currentOnHandCenti: number | null; qty: string; reason: string }): ManualGate {
  const fields: Record<string, string[]> = {};
  const newC = parseQtyNonNegative(input.qty);
  if (newC === null) fields.qty = ['invalid_qty'];
  const r = reasonErrors(input.reason);
  if (r) fields.reason = r;
  if (newC === null || r) return { ok: false, status: 400, code: 'invalid_request', fields };
  return { ok: true, newCenti: newC, deltaCenti: newC - (input.currentOnHandCenti ?? 0) };
}

/**
 * An adjustment changes a number the system already believed in, so the SKU must be counted
 * already (an adjustment of "nothing" has no before), the new quantity may not be negative,
 * and it must actually differ. Reason is mandatory free text.
 */
export function gateAdjustment(input: { currentOnHandCenti: number | null; newQty: string; reason: string }): ManualGate {
  const fields: Record<string, string[]> = {};
  const raw = input.newQty.trim();
  let newC: number | null;
  try {
    newC = toQtyCenti(raw);
  } catch (e) {
    if (e instanceof MoneyError) newC = null;
    else throw e;
  }
  if (newC === null) fields.newQty = ['invalid_qty'];
  const r = reasonErrors(input.reason);
  if (r) fields.reason = r;
  if (newC === null || r) return { ok: false, status: 400, code: 'invalid_request', fields };
  if (newC < 0) return { ok: false, status: 409, code: 'adjustment_negative' };
  if (input.currentOnHandCenti === null) return { ok: false, status: 409, code: 'sku_not_counted' };
  if (newC === input.currentOnHandCenti) return { ok: false, status: 409, code: 'no_change' };
  return { ok: true, newCenti: newC, deltaCenti: newC - input.currentOnHandCenti };
}

/**
 * SEAM (CLAUDE.md s12.1 point 3): an adjustment above a per-shop value limit needs a manager's
 * approval. The value is qty x avg_cost, and avg_cost does not exist until purchasing (a later
 * release) writes receipts. DEFAULT pending Ice: NOT enforced in Release 1 - this always says
 * "no approval needed". When avg_cost lands, the body of this function (and nothing else) is
 * where the limit is judged, on the server, without ever showing the figure to an advisor.
 */
export function adjustmentNeedsApproval(_input: { deltaCenti: number; avgCostSatang: number | null; limitSatang: number | null }): boolean {
  return false;
}

// -----------------------------------------------------------------------------
// Cost visibility (CLAUDE.md s12.2)
// -----------------------------------------------------------------------------

/** Roles that may receive avg_cost / unit_cost / stock value. Everyone else never gets the field at all. */
export const COST_VISIBLE_ROLES = ['owner', 'manager', 'assistant_manager', 'accountant'] as const;
export function mayEverSeeCost(role: string): boolean {
  return (COST_VISIBLE_ROLES as readonly string[]).includes(role);
}

/** avg_cost is NOT NULL DEFAULT 0 in the schema, so 0 cannot be told from "no cost known yet". It is treated as unknown. */
export function knownCost(avgCost: string | null): string | null {
  if (avgCost === null) return null;
  return Number(avgCost) > 0 ? avgCost : null;
}

// -----------------------------------------------------------------------------
// Idempotency keys (UNIQUE (shop_id, idempotency_key) enforces them in the database)
// -----------------------------------------------------------------------------
//
// The WO writes `reserve:{line}` and `count` keyed by (sku, user, date). Both are unsafe as
// written: reserve is released by "undo confirm" and must be reservable again when the quote is
// re-confirmed, and a second legitimate count by the same person on the same day would be
// silently dropped. So:
//   reserve / unreserve   carry a GENERATION n (the n-th reservation of this line), so a
//                         re-confirm after an undo is a new fact, while a replay of the same
//                         confirm stays the same fact.
//   issue / count / adjust carry the client's requestId (one per button press / dialog), so a
//                         retry after a timeout or a double-click is one row, and a second
//                         deliberate action is another.

export const stockKeys = {
  reserve: (lineId: string, generation: number) => `reserve:${lineId}:${generation}`,
  /** Releases generation n of a line (undo confirm / revise / void / job end / quotation close). */
  unreserve: (lineId: string, generation: number) => `unreserve:${lineId}:${generation}`,
  issue: (lineId: string, requestId: string) => `issue:${lineId}:${requestId}`,
  /** The unreserve that travels with an issue. */
  issueUnreserve: (lineId: string, requestId: string) => `unreserve:${lineId}:issue:${requestId}`,
  count: (skuId: string, requestId: string) => `count:${skuId}:${requestId}`,
  adjust: (skuId: string, requestId: string) => `adjust:${skuId}:${requestId}`,
  /** P3.2 seam: stockHooks.releaseUnusedReservations. `lineId` is the receipt line. */
  receiptRelease: (receiptId: string, lineId: string, childSourceLineId?: string) =>
    childSourceLineId
      ? `unreserve:receipt:${receiptId}:${lineId}:${childSourceLineId}`
      : `unreserve:receipt:${receiptId}:${lineId}`,
} as const;
