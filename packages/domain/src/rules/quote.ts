/**
 * Quotation rules (P3.1) — everything the API and the screen must agree on,
 * in one place: line money, totals, line validation, per-line decisions
 * including sets (D10), the 3-tier agreed-amount rule (Q2), the job outcome at
 * confirm (D4/D5), undo-confirm eligibility, and what a job ending does to its
 * quotation (Q1).
 *
 * Pure: no I/O, no clock (callers pass `now`). Money is integer satang and
 * quantity is integer hundredths — see money.ts. Wire values are decimal
 * strings, converted at the boundary with toSatang()/toQtyCenti().
 */

import {
  clampDiscount,
  formatSatang,
  mulQty,
  sumSatang,
  toQtyCenti,
  toSatang,
} from './money.js';

// -----------------------------------------------------------------------------
// Vocabulary
// -----------------------------------------------------------------------------

export type QuoteLineType = 'part' | 'labor' | 'fee';
export type ApprovalStatus = 'pending' | 'approved' | 'declined';

/** Mirrors the document_lines.decline_reason CHECK after migration 0021. */
export const DECLINE_REASONS = [
  'too_expensive',
  'next_time',
  'going_elsewhere',
  'not_needed_yet',
  'other',
  'chose_alternative',
] as const;
export type DeclineReason = (typeof DECLINE_REASONS)[number];

export type QuotationStatus = 'draft' | 'issued' | 'signed' | 'superseded' | 'void';

/** The only void_reason the system writes itself (Q1). */
export const VOID_REASON_JOB_CLOSED = 'job_closed';

/** The minimal line shape the money functions need. Strings are numeric(12,2) text. */
export interface QuoteLineMoney {
  id: string;
  parentLineId: string | null;
  qty: string;
  unitPrice: string;
  approvalStatus: ApprovalStatus;
  /** Agreed amount for a set that had pieces cut (D10); null = approved as offered. */
  approvedAmount: string | null;
}

export interface QuoteLineDecisionState {
  id: string;
  parentLineId: string | null;
  approvalStatus: ApprovalStatus;
  declineReason: DeclineReason | null;
  declineNote: string | null;
}

// -----------------------------------------------------------------------------
// Line money and totals
// -----------------------------------------------------------------------------

/** qty x unit price, rounded once to the satang (CLAUDE.md §4.3). */
export function lineTotalSatang(qty: string, unitPrice: string): number {
  return mulQty(toQtyCenti(qty), toSatang(unitPrice));
}

/** What an approved line is worth: the agreed amount when one was set, else its line total. */
export function approvedLineSatang(line: Pick<QuoteLineMoney, 'qty' | 'unitPrice' | 'approvedAmount'>): number {
  return line.approvedAmount !== null
    ? toSatang(line.approvedAmount)
    : lineTotalSatang(line.qty, line.unitPrice);
}

export interface QuoteTotals {
  /** Sum of every TOP-LEVEL line, before discount. Set children are never counted. */
  offeredSubtotal: number;
  /** Sum of approved TOP-LEVEL lines (agreed amount where set), before discount. */
  approvedSubtotal: number;
  /** The discount as entered (>= 0). */
  discount: number;
  /** Discount actually applied against the offered subtotal (clamped). */
  offeredDiscount: number;
  /** Discount actually applied against the approved subtotal (clamped). */
  approvedDiscount: number;
  /** offeredSubtotal - offeredDiscount, never negative. */
  offeredTotal: number;
  /** approvedSubtotal - approvedDiscount, never negative. This is what flows to the receipt. */
  approvedTotal: number;
}

/**
 * The one totals function. Set children carry unit_price 0 by design, but even
 * if one carried a price it is NOT counted: only lines with no parent add up,
 * so a set can never be double counted (the old #186-style bug).
 */
export function quoteTotals(lines: readonly QuoteLineMoney[], discount: string | number = '0'): QuoteTotals {
  const top = lines.filter((l) => l.parentLineId === null);
  const offeredSubtotal = sumSatang(top.map((l) => lineTotalSatang(l.qty, l.unitPrice)));
  const approvedSubtotal = sumSatang(top.filter((l) => l.approvalStatus === 'approved').map(approvedLineSatang));
  const requested = toSatang(discount);
  const d = requested < 0 ? 0 : requested;
  const offeredDiscount = clampDiscount(d, offeredSubtotal);
  const approvedDiscount = clampDiscount(d, approvedSubtotal);
  return {
    offeredSubtotal,
    approvedSubtotal,
    discount: d,
    offeredDiscount,
    approvedDiscount,
    offeredTotal: offeredSubtotal - offeredDiscount,
    approvedTotal: approvedSubtotal - approvedDiscount,
  };
}

/** The totals as numeric(12,2) strings, ready to write to documents.*. */
export function quoteTotalsDecimal(t: QuoteTotals): Record<keyof QuoteTotals, string> {
  return {
    offeredSubtotal: formatSatang(t.offeredSubtotal),
    approvedSubtotal: formatSatang(t.approvedSubtotal),
    discount: formatSatang(t.discount),
    offeredDiscount: formatSatang(t.offeredDiscount),
    approvedDiscount: formatSatang(t.approvedDiscount),
    offeredTotal: formatSatang(t.offeredTotal),
    approvedTotal: formatSatang(t.approvedTotal),
  };
}

// -----------------------------------------------------------------------------
// Line validation
// -----------------------------------------------------------------------------

export type LineIssueCode =
  | 'qty_invalid'
  | 'qty_not_positive'
  | 'unit_price_invalid'
  | 'unit_price_negative'
  | 'labor_not_vatable'
  | 'parent_missing'
  | 'parent_is_child'
  | 'parent_is_self';

export interface LineIssue {
  field: 'qty' | 'unitPrice' | 'isVatable' | 'parentLineId';
  code: LineIssueCode;
}

/** unit_price may be 0 (free / awaiting price), never negative (D2). Labour is never VAT (D1). */
export function validateQuoteLine(input: {
  lineType: QuoteLineType;
  qty: string;
  unitPrice: string;
  isVatable: boolean;
}): LineIssue[] {
  const issues: LineIssue[] = [];
  try {
    if (toQtyCenti(input.qty) <= 0) issues.push({ field: 'qty', code: 'qty_not_positive' });
  } catch {
    issues.push({ field: 'qty', code: 'qty_invalid' });
  }
  try {
    if (toSatang(input.unitPrice) < 0) issues.push({ field: 'unitPrice', code: 'unit_price_negative' });
  } catch {
    issues.push({ field: 'unitPrice', code: 'unit_price_invalid' });
  }
  if (input.lineType === 'labor' && input.isVatable) {
    issues.push({ field: 'isVatable', code: 'labor_not_vatable' });
  }
  return issues;
}

/** The is_vatable a new line gets when the caller did not say: parts yes, labour and fees no (§5.2). */
export function defaultIsVatable(lineType: QuoteLineType): boolean {
  return lineType === 'part';
}

/**
 * A set child must point at a TOP-LEVEL line of the same quotation: no dangling
 * parent, no self-parent, no grandchildren. (Same-document is enforced in the
 * database too; this is the pure check the API runs before it writes.)
 */
export function validateLineTree(lines: readonly { id: string; parentLineId: string | null }[]): Array<{
  lineId: string;
  issue: LineIssue;
}> {
  const byId = new Map(lines.map((l) => [l.id, l]));
  const out: Array<{ lineId: string; issue: LineIssue }> = [];
  for (const l of lines) {
    if (l.parentLineId === null) continue;
    if (l.parentLineId === l.id) {
      out.push({ lineId: l.id, issue: { field: 'parentLineId', code: 'parent_is_self' } });
      continue;
    }
    const parent = byId.get(l.parentLineId);
    if (!parent) out.push({ lineId: l.id, issue: { field: 'parentLineId', code: 'parent_missing' } });
    else if (parent.parentLineId !== null) {
      out.push({ lineId: l.id, issue: { field: 'parentLineId', code: 'parent_is_child' } });
    }
  }
  return out;
}

// -----------------------------------------------------------------------------
// Decisions (D10): per line, and per set
// -----------------------------------------------------------------------------

export interface DecisionAction {
  lineId: string;
  decision: 'approved' | 'declined';
  reason?: DeclineReason | null;
  note?: string | null;
}

export interface DecisionChange {
  lineId: string;
  approvalStatus: ApprovalStatus;
  declineReason: DeclineReason | null;
  declineNote: string | null;
}

export type DecisionErrorCode = 'line_not_found' | 'decline_reason_required' | 'decline_note_required';

export type DecisionResult =
  | { ok: true; changes: DecisionChange[] }
  | { ok: false; code: DecisionErrorCode };

/** The note a parent gets when its children were declined for different reasons. */
export const ALL_SET_DECLINED_NOTE = 'ปฏิเสธครบทุกรายการในชุด';

function asChange(
  id: string,
  approvalStatus: ApprovalStatus,
  declineReason: DeclineReason | null,
  declineNote: string | null,
): DecisionChange {
  return { lineId: id, approvalStatus, declineReason, declineNote };
}

/**
 * Every decision rule for a line and the set it belongs to, in one function
 * (v3 §3.1). Returns only the lines whose state actually changes; the caller
 * stamps decided_at/decided_by on those and applies them in ONE transaction.
 *
 *  - approve a parent: pending children -> approved; children already
 *    declined STAY declined — except when EVERY child is declined (an undo of
 *    a declined set), which restores them all to approved.
 *  - decline a parent: every child that is still pending or approved is
 *    declined with the parent's reason/note; a child already declined keeps
 *    its own reason (why the customer dropped that piece feeds the report).
 *  - decline a child: accepted; the parent is untouched, unless that was the
 *    last child standing — then the parent is declined by itself (reason =
 *    the children's common reason, else 'other' + ALL_SET_DECLINED_NOTE).
 *  - approve a child that was declined: accepted; a declined parent goes back
 *    to pending (it can no longer be "everything declined").
 *
 * A reason is mandatory on every decline; 'other' also needs a note.
 */
export function applySetDecision(
  lines: readonly QuoteLineDecisionState[],
  action: DecisionAction,
): DecisionResult {
  const target = lines.find((l) => l.id === action.lineId);
  if (!target) return { ok: false, code: 'line_not_found' };

  const reason = action.reason ?? null;
  const note = action.note?.trim() ? action.note.trim() : null;
  if (action.decision === 'declined') {
    if (!reason) return { ok: false, code: 'decline_reason_required' };
    if (reason === 'other' && !note) return { ok: false, code: 'decline_note_required' };
  }

  const next = new Map<string, DecisionChange>();
  const set = (c: DecisionChange) => next.set(c.lineId, c);
  const state = (id: string): DecisionChange => {
    const staged = next.get(id);
    if (staged) return staged;
    const l = lines.find((x) => x.id === id)!;
    return asChange(l.id, l.approvalStatus, l.declineReason, l.declineNote);
  };

  const isChild = target.parentLineId !== null;
  const childrenOf = (parentId: string) => lines.filter((l) => l.parentLineId === parentId);

  if (action.decision === 'approved') {
    set(asChange(target.id, 'approved', null, null));
    if (!isChild) {
      const kids = childrenOf(target.id);
      const allDeclined = kids.length > 0 && kids.every((c) => c.approvalStatus === 'declined');
      for (const c of kids) {
        if (allDeclined || c.approvalStatus === 'pending') set(asChange(c.id, 'approved', null, null));
      }
    } else {
      const parent = lines.find((l) => l.id === target.parentLineId);
      if (parent && parent.approvalStatus === 'declined') set(asChange(parent.id, 'pending', null, null));
    }
  } else {
    set(asChange(target.id, 'declined', reason, note));
    if (!isChild) {
      for (const c of childrenOf(target.id)) {
        if (c.approvalStatus !== 'declined') set(asChange(c.id, 'declined', reason, note));
      }
    } else {
      const siblings = childrenOf(target.parentLineId!);
      const parent = lines.find((l) => l.id === target.parentLineId);
      const allDeclined = siblings.every((s) => state(s.id).approvalStatus === 'declined');
      // A parent that is already declined keeps its own reason.
      if (allDeclined && parent && parent.approvalStatus !== 'declined') {
        const reasons = siblings.map((s) => state(s.id).declineReason);
        const same = reasons.every((r) => r === reasons[0]);
        if (same && reasons[0]) {
          const notes = siblings.map((s) => state(s.id).declineNote);
          const sameNote = notes.every((n) => n === notes[0]);
          set(asChange(target.parentLineId!, 'declined', reasons[0], sameNote ? (notes[0] ?? null) : null));
        } else {
          set(asChange(target.parentLineId!, 'declined', 'other', ALL_SET_DECLINED_NOTE));
        }
      }
    }
  }

  const changes: DecisionChange[] = [];
  for (const c of next.values()) {
    const old = lines.find((l) => l.id === c.lineId)!;
    if (
      old.approvalStatus !== c.approvalStatus ||
      old.declineReason !== c.declineReason ||
      old.declineNote !== c.declineNote
    ) {
      changes.push(c);
    }
  }
  return { ok: true, changes };
}

/** Apply a successful DecisionResult to a line list (for tests and for the screen's optimistic view). */
export function withDecisionChanges<T extends QuoteLineDecisionState>(
  lines: readonly T[],
  changes: readonly DecisionChange[],
): T[] {
  const by = new Map(changes.map((c) => [c.lineId, c]));
  return lines.map((l) => {
    const c = by.get(l.id);
    return c
      ? { ...l, approvalStatus: c.approvalStatus, declineReason: c.declineReason, declineNote: c.declineNote }
      : l;
  });
}

// -----------------------------------------------------------------------------
// Confirm ("ยืนยันผลลูกค้า")
// -----------------------------------------------------------------------------

/**
 * Approved top-level lines that have at least one declined child: the sets
 * whose price is no longer the price (D10 #4). Each needs an agreed amount
 * before the quotation can be confirmed. The system never proposes a number.
 */
export function setsNeedingAmount(lines: readonly QuoteLineDecisionState[]): string[] {
  return lines
    .filter((l) => l.parentLineId === null && l.approvalStatus === 'approved')
    .filter((p) => lines.some((c) => c.parentLineId === p.id && c.approvalStatus === 'declined'))
    .map((p) => p.id);
}

/** approved_amount is only accepted on a set parent that qualifies under setsNeedingAmount (v3 §3.3 #5). */
export function canSetApprovedAmount(lines: readonly QuoteLineDecisionState[], lineId: string): boolean {
  return setsNeedingAmount(lines).includes(lineId);
}

export interface ConfirmReadiness {
  ready: boolean;
  /** Top-level lines still pending. */
  undecidedLineIds: string[];
  /** Cut sets with no agreed amount (neither on the line nor in this request). */
  setsMissingAmount: string[];
}

/**
 * Whether "ยืนยันผลลูกค้า" may proceed. `amountLineIds` are the sets for which
 * the confirm request supplies an agreed amount; a set that already carries one
 * (`approvedAmount`) also counts.
 */
export function confirmReadiness(
  lines: ReadonlyArray<QuoteLineDecisionState & { approvedAmount: string | null }>,
  amountLineIds: readonly string[] = [],
): ConfirmReadiness {
  const undecidedLineIds = lines
    .filter((l) => l.parentLineId === null && l.approvalStatus === 'pending')
    .map((l) => l.id);
  const supplied = new Set(amountLineIds);
  const setsMissingAmount = setsNeedingAmount(lines).filter((id) => {
    const l = lines.find((x) => x.id === id)!;
    return l.approvedAmount === null && !supplied.has(id);
  });
  return {
    ready: undecidedLineIds.length === 0 && setsMissingAmount.length === 0,
    undecidedLineIds,
    setsMissingAmount,
  };
}

export type ApprovedAmountKind = 'zero' | 'lower' | 'higher' | 'same';

export type ApprovedAmountCheck =
  | {
      ok: true;
      kind: ApprovedAmountKind;
      /** agreed - offered, in satang (positive = more than offered). */
      delta: number;
      /** false only when the amount equals the offer — then leave approved_amount NULL. */
      requiresReason: boolean;
    }
  | { ok: false; code: 'negative' | 'over_double' | 'free_set'; delta: number };

/**
 * The 3-tier rule (Q2). Negative: blocked. Above 2x the offered line total:
 * blocked (almost certainly a typo — revise instead); a FREE offer (0) can
 * never be repriced upward and is refused with its own code ('free_set') so the
 * screen does not say "typo". 0, lower, or up to and
 * including 2x: allowed, with a reason; the screen shows `delta` as a number.
 * Equal to the offer needs no agreed amount at all.
 */
export function checkApprovedAmount(offeredSatang: number, agreedSatang: number): ApprovedAmountCheck {
  const delta = agreedSatang - offeredSatang;
  if (agreedSatang < 0) return { ok: false, code: 'negative', delta };
  if (offeredSatang === 0 && agreedSatang > 0) return { ok: false, code: 'free_set', delta };
  if (agreedSatang > offeredSatang * 2) return { ok: false, code: 'over_double', delta };
  if (agreedSatang === offeredSatang) return { ok: true, kind: 'same', delta: 0, requiresReason: false };
  const kind: ApprovedAmountKind = agreedSatang === 0 ? 'zero' : agreedSatang < offeredSatang ? 'lower' : 'higher';
  return { ok: true, kind, delta, requiresReason: true };
}

export type JobOutcomeAtConfirm = 'approve_job' | 'keep_quoted' | 'not_ready';

/**
 * D4/D5: the job becomes approved when at least one top-level line is approved
 * and none is still pending. If everything was declined the quotation freezes
 * but the job stays 'quoted' — staff press "ไม่อนุมัติ" themselves.
 */
export function jobOutcomeAtConfirm(lines: readonly QuoteLineDecisionState[]): JobOutcomeAtConfirm {
  const top = lines.filter((l) => l.parentLineId === null);
  if (top.some((l) => l.approvalStatus === 'pending')) return 'not_ready';
  return top.some((l) => l.approvalStatus === 'approved') ? 'approve_job' : 'keep_quoted';
}

// -----------------------------------------------------------------------------
// Undo confirm, and moving the job back
// -----------------------------------------------------------------------------

const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000;

/** "2026-10-01" — the calendar day in Bangkok (UTC+7, no DST) for an instant. */
export function bangkokDayKey(at: Date | string): string {
  const t = (at instanceof Date ? at : new Date(at)).getTime();
  if (Number.isNaN(t)) throw new Error('invalid date');
  return new Date(t + BANGKOK_OFFSET_MS).toISOString().slice(0, 10);
}

export type UndoConfirmCheck =
  | { ok: true }
  | { ok: false; code: 'not_signed' | 'different_day' | 'job_moved_on' };

/** Undo is allowed the same Bangkok day, while the job is still 'approved' (owner decision 6). */
export function canUndoConfirm(input: {
  quotationStatus: QuotationStatus;
  confirmedAt: Date | string;
  now: Date | string;
  jobStatus: string;
}): UndoConfirmCheck {
  if (input.quotationStatus !== 'signed') return { ok: false, code: 'not_signed' };
  if (bangkokDayKey(input.confirmedAt) !== bangkokDayKey(input.now)) return { ok: false, code: 'different_day' };
  if (input.jobStatus !== 'approved') return { ok: false, code: 'job_moved_on' };
  return { ok: true };
}

/**
 * approved -> quoted must be refused while the quotation is confirmed
 * (CLAUDE.md §5 #5, owner decision 8): undo the confirmation or revise.
 */
export function blocksJobBackToQuoted(quotationStatus: QuotationStatus | null): boolean {
  return quotationStatus === 'signed';
}

// -----------------------------------------------------------------------------
// A job ending without a repair (Q1)
// -----------------------------------------------------------------------------

export interface QuotationCloseInput {
  targetStatus: 'rejected' | 'carout';
  quotation: {
    status: QuotationStatus;
    lines: readonly QuoteLineDecisionState[];
  } | null;
  declineReason?: DeclineReason | null;
  declineNote?: string | null;
}

export type QuotationClosePlan =
  | { action: 'none' }
  | {
      action: 'close';
      /** Every line still pending that gets declined with the reason (rejected on an issued quotation only). */
      declineLineIds: string[];
      reason: DeclineReason | null;
      note: string | null;
    }
  | {
      action: 'refuse';
      code: 'decline_reason_required' | 'decline_note_required' | 'decline_reason_not_allowed';
    };

/**
 * What the job-status change to rejected/carout does to the quotation, in the
 * same transaction (v3 §6.4): signed and draft are left alone; issued is
 * closed by the system; closing as 'rejected' with pending lines on an issued
 * quotation REQUIRES a decline reason, which is written to those lines.
 */
export function planQuotationClose(input: QuotationCloseInput): QuotationClosePlan {
  const q = input.quotation;
  // A draft is left untouched (owner decision, 6 Oct 2026): it has no number, no accounting
  // effect, and never shows in "waiting for the customer". A void would also violate
  // ck_number_when_issued. Only an ISSUED quotation is closed by the system.
  if (!q || q.status !== 'issued') return { action: 'none' };

  const pending = q.lines.filter((l) => l.approvalStatus === 'pending');
  const needsReason = input.targetStatus === 'rejected' && q.status === 'issued' && pending.some((l) => l.parentLineId === null);
  const note = input.declineNote?.trim() ? input.declineNote.trim() : null;

  if (!needsReason) return { action: 'close', declineLineIds: [], reason: null, note: null };

  const reason = input.declineReason ?? null;
  if (!reason) return { action: 'refuse', code: 'decline_reason_required' };
  if (reason === 'chose_alternative') return { action: 'refuse', code: 'decline_reason_not_allowed' };
  if (reason === 'other' && !note) return { action: 'refuse', code: 'decline_note_required' };
  return { action: 'close', declineLineIds: pending.map((l) => l.id), reason, note };
}

/** A void written by the system when the job ended, as opposed to a person pressing void. */
export function isClosedByJob(doc: { status: string; voidReason: string | null; voidedBy: string | null }): boolean {
  return doc.status === 'void' && doc.voidReason === VOID_REASON_JOB_CLOSED && doc.voidedBy === null;
}

// -----------------------------------------------------------------------------
// Reporting vocabulary, work order, offered items
// -----------------------------------------------------------------------------

/**
 * D13: "chose another option" is a sale, not a refusal. Every report or rate
 * about why customers say no must pass its reasons through this.
 */
export function isTrueDecline(reason: DeclineReason | null | undefined): boolean {
  return !!reason && reason !== 'chose_alternative';
}

/**
 * The lines a technician sees: approved top-level lines plus the approved
 * children of an approved parent. Declined lines never appear; the caller
 * strips every price (CLAUDE.md §12.1).
 */
export function workOrderLineIds(lines: readonly QuoteLineDecisionState[]): string[] {
  const approvedTop = new Set(
    lines.filter((l) => l.parentLineId === null && l.approvalStatus === 'approved').map((l) => l.id),
  );
  return lines
    .filter((l) =>
      l.parentLineId === null
        ? approvedTop.has(l.id)
        : l.approvalStatus === 'approved' && approvedTop.has(l.parentLineId),
    )
    .map((l) => l.id);
}

/**
 * Lines to remember in vehicle_offered_items at confirm: declined with
 * 'next_time' only (D3, D13). A child that followed its declined parent is not
 * written separately — the parent line already says it.
 */
export function offeredItemLineIds(lines: readonly QuoteLineDecisionState[]): string[] {
  const byId = new Map(lines.map((l) => [l.id, l]));
  return lines
    .filter((l) => l.approvalStatus === 'declined' && l.declineReason === 'next_time')
    .filter((l) => {
      if (l.parentLineId === null) return true;
      const p = byId.get(l.parentLineId);
      return !(p && p.approvalStatus === 'declined');
    })
    .map((l) => l.id);
}

// -----------------------------------------------------------------------------
// Issuing moves the job (owner decision, 3 Oct 2026)
// -----------------------------------------------------------------------------

/**
 * Where issuing a quotation puts the job: 'quoted' from received or
 * inspecting, otherwise null (no move). A job is never moved backwards or
 * sideways by an issue — a revision issued while the job is approved,
 * repairing, ready... changes nothing about the job.
 *
 * This deliberately bypasses the manual-move table (allowedMovesFrom): from
 * 'received' it is ONE received -> quoted step, with no invented 'inspecting'
 * in between. It exists only for the issue action; manual moves still go
 * through canMoveTo.
 */
export function jobStatusOnIssue(current: string): 'quoted' | null {
  return current === 'received' || current === 'inspecting' ? 'quoted' : null;
}
