// Test fixtures for the quotation screen — shapes typed by @gsms/contracts so
// a contract change breaks the tests at compile time, not silently.
import type { Quotation, QuotationLine, QuotationNext, QuotationTotals } from '@gsms/contracts/index.js';

export const JOB_ID = '00000000-0000-4000-8000-0000000000a1';
export const DOC_ID = '00000000-0000-4000-8000-0000000000d1';

let n = 0;
export function uid(): string {
  n += 1;
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

export function line(over: Partial<QuotationLine> & Pick<QuotationLine, 'name'>): QuotationLine {
  return {
    id: uid(),
    parentLineId: null,
    sortOrder: 0,
    lineType: 'part',
    catalogItemId: null,
    brand: null,
    qty: '1.00',
    unit: null,
    unitPrice: '0.00',
    listPrice: null,
    priceSource: 'base',
    isVatable: true,
    lineTotal: '0.00',
    approvalStatus: 'pending',
    declineReason: null,
    declineNote: null,
    decidedAt: null,
    decidedByName: null,
    approvedAmount: null,
    warranty: null,
    decisionCarriedFrom: null,
    ...over,
  };
}

export function totals(over: Partial<QuotationTotals> = {}): QuotationTotals {
  return {
    offeredSubtotal: '0.00', approvedSubtotal: '0.00', discount: '0.00', offeredDiscount: '0.00',
    approvedDiscount: '0.00', offeredTotal: '0.00', approvedTotal: '0.00', ...over,
  };
}

export function next(over: Partial<QuotationNext> = {}): QuotationNext {
  return {
    canEditContent: false, canIssue: false, canDecide: false, canConfirm: false, canUndoConfirm: false,
    canRevise: false, undecidedLineIds: [], setsNeedingAmountLineIds: [], ...over,
  };
}

export function quotation(over: Partial<Quotation> = {}): Quotation {
  return {
    id: DOC_ID,
    jobId: JOB_ID,
    revision: 1,
    status: 'issued',
    number: 'QUO-2610-0001',
    supersedesDocumentId: null,
    issuedAt: '2026-10-12T03:00:00.000Z',
    confirmedAt: null,
    closedByJob: false,
    voidReason: null,
    totals: totals(),
    lines: [],
    next: next({ canDecide: true, canRevise: true }),
    ...over,
  };
}

/**
 * A suspension set of 20,000 with three pieces, one of them (wheel alignment)
 * declined by the customer while the set itself is approved — the D10 case
 * that needs a new set amount before confirm.
 */
export function cutSetQuotation(): { q: Quotation; head: QuotationLine; cut: QuotationLine } {
  const head = line({ name: 'ชุดโปรช่วงล่าง', unitPrice: '20000.00', lineTotal: '20000.00', approvalStatus: 'approved', sortOrder: 1 });
  const a = line({ name: 'ลูกหมากปีกนกล่าง L/R', parentLineId: head.id, approvalStatus: 'approved', sortOrder: 2 });
  const b = line({ name: 'โช้คหน้า', parentLineId: head.id, approvalStatus: 'approved', sortOrder: 3 });
  const cut = line({ name: 'ตั้งศูนย์', parentLineId: head.id, lineType: 'labor', approvalStatus: 'declined', declineReason: 'not_needed_yet', sortOrder: 4 });
  const q = quotation({
    lines: [head, a, b, cut],
    totals: totals({ offeredSubtotal: '20000.00', approvedSubtotal: '20000.00', offeredTotal: '20000.00', approvedTotal: '20000.00' }),
    next: next({ canDecide: true, canRevise: true, setsNeedingAmountLineIds: [head.id] }),
  });
  return { q, head, cut };
}
