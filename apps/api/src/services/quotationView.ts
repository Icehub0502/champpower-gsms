/**
 * Builds the wire `Quotation` shape (packages/contracts) from the DB rows.
 * Every total and every `next` flag is computed here, through domain — never
 * recomputed on the client, and never read back from a stale column once the
 * document is frozen (CLAUDE.md §4 rule 4): offered_total/grand_total are
 * frozen at issue and read as-is; approved_total is read as-is once signed.
 */
import {
  canUndoConfirm, confirmReadiness, isClosedByJob, quoteTotals, quoteTotalsDecimal,
  type DeclineReason, type QuotationStatus as DomainQuotationStatus,
} from '@champpower/domain'
import type { Quotation, QuotationLine } from '@gsms/contracts/index.js'
import type { DocumentRow, LineRow } from '../repositories/quotation.js'

function toLine(r: LineRow): QuotationLine {
  return {
    id: r.id,
    parentLineId: r.parent_line_id,
    sortOrder: r.sort_order,
    lineType: r.line_type as QuotationLine['lineType'],
    catalogItemId: r.catalog_item_id,
    name: r.name_snapshot,
    brand: r.brand_snapshot,
    qty: r.qty,
    unit: r.unit,
    unitPrice: r.unit_price,
    listPrice: r.list_price,
    priceSource: r.price_source as QuotationLine['priceSource'],
    isVatable: r.is_vatable,
    lineTotal: r.line_total,
    approvalStatus: r.approval_status as QuotationLine['approvalStatus'],
    declineReason: r.decline_reason as DeclineReason | null,
    declineNote: r.decline_note,
    decidedAt: r.decided_at ? r.decided_at.toISOString() : null,
    decidedByName: r.decided_by_name,
    approvedAmount: r.approved_amount,
    warranty: r.warranty_term_id
      ? { termId: r.warranty_term_id, name: r.warranty_name!, days: r.warranty_days, maxKm: r.warranty_max_km }
      : null,
  }
}

export function buildQuotationView(doc: DocumentRow, lineRows: LineRow[], jobStatus: string | null): Quotation {
  const lines = lineRows.map((r) => ({
    id: r.id, parentLineId: r.parent_line_id, qty: r.qty, unitPrice: r.unit_price,
    approvalStatus: r.approval_status as 'pending' | 'approved' | 'declined',
    approvedAmount: r.approved_amount,
  }))
  const totalsRaw = quoteTotals(lines, doc.discount)
  const totals = quoteTotalsDecimal(totalsRaw)
  const readiness = confirmReadiness(lines.map((l) => ({
    id: l.id, parentLineId: l.parentLineId, approvalStatus: l.approvalStatus, declineReason: null, declineNote: null, approvedAmount: l.approvedAmount,
  })))

  const undo = doc.status === 'signed'
    ? canUndoConfirm({ quotationStatus: 'signed', confirmedAt: doc.signed_at ?? new Date(), now: new Date(), jobStatus: jobStatus ?? '' })
    : { ok: false as const, code: 'not_signed' as const }

  return {
    id: doc.id,
    jobId: doc.job_id!,
    revision: doc.revision,
    status: doc.status as DomainQuotationStatus,
    number: doc.number,
    supersedesDocumentId: doc.supersedes_document_id,
    issuedAt: doc.issued_at ? doc.issued_at.toISOString() : null,
    confirmedAt: doc.signed_at ? doc.signed_at.toISOString() : null,
    closedByJob: isClosedByJob({ status: doc.status, voidReason: doc.void_reason, voidedBy: doc.voided_by }),
    voidReason: doc.void_reason,
    totals,
    lines: lineRows.map(toLine),
    next: {
      canEditContent: doc.status === 'draft',
      canIssue: doc.status === 'draft' && lineRows.length > 0,
      canDecide: doc.status === 'issued',
      canConfirm: doc.status === 'issued' && readiness.ready,
      canUndoConfirm: doc.status === 'signed' && undo.ok,
      canRevise: doc.status === 'issued' || doc.status === 'signed',
      undecidedLineIds: readiness.undecidedLineIds,
      setsNeedingAmountLineIds: readiness.setsMissingAmount,
    },
  }
}
