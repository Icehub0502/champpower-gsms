/**
 * Builds the wire `Quotation` shape (packages/contracts) from the DB rows.
 * Every total and every `next` flag is computed here, through domain — never
 * recomputed on the client, and never read back from a stale column once the
 * document is frozen (CLAUDE.md §4 rule 4): offered_total/grand_total are
 * frozen at issue and read as-is; approved_total is read as-is once signed.
 */
import {
  canUndoConfirm, confirmReadiness, decisionCarries, formatSatang, isClosedByJob, quoteTotals, quoteTotalsDecimal, toSatang,
  type DeclineReason, type QuotationStatus as DomainQuotationStatus,
} from '@champpower/domain'
import type { Quotation, QuotationLine } from '@gsms/contracts/index.js'
import type { DocumentRow, LineRow } from '../repositories/quotation.js'
import { sourceIdentityOf } from './quotation.js'

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
    decisionCarriedFrom: carriedFrom(r),
  }
}

/**
 * Owner Q2: "ตกลงไว้แล้ว" vs "ต้องถามใหม่". A line carries its decision when it was
 * copied from the superseded revision, is still decided, was NOT re-decided on
 * this revision (same decided_at as its source), and still matches the source
 * on item, qty, unit price and warranty.
 */
function carriedFrom(r: LineRow): string | null {
  const src = sourceIdentityOf(r)
  if (!src || r.approval_status === 'pending' || r.source_line_id === null) return null
  if (!r.decided_at || !r.src_decided_at || r.decided_at.getTime() !== r.src_decided_at.getTime()) return null
  const cur = { catalogItemId: r.catalog_item_id, name: r.name_snapshot, lineType: r.line_type, qty: r.qty, unitPrice: r.unit_price, warrantyTermId: r.warranty_term_id, warrantyDays: r.warranty_days, warrantyMaxKm: r.warranty_max_km }
  return decisionCarries(src, cur) ? r.source_line_id : null
}

export interface ViewJob {
  status: string | null
  vehicleId: string | null
  vehicleModelLinked: boolean
  /** The caller's role may write intake (decide/confirm). Read from the JWT by the route. */
  callerMayDecide: boolean
}

export function buildQuotationView(doc: DocumentRow, lineRows: LineRow[], job: ViewJob): Quotation {
  const jobStatus = job.status
  const lines = lineRows.map((r) => ({
    id: r.id, parentLineId: r.parent_line_id, qty: r.qty, unitPrice: r.unit_price,
    approvalStatus: r.approval_status as 'pending' | 'approved' | 'declined',
    approvedAmount: r.approved_amount,
  }))
  const totalsRaw = quoteTotals(lines, doc.discount)
  const computed = quoteTotalsDecimal(totalsRaw)
  // A NUMBERED document is read from what was frozen on it, never recomputed (CLAUDE.md §4.4): the
  // stored figures are the truth. Two discounts, both stored (0024, model A):
  //   offeredDiscount  the discount on the offer; offeredSubtotal - offeredDiscount = offeredTotal
  //   discount         the AGREED discount (= offeredDiscount until confirm changes it)
  // Subtotals come from the (immutable) lines; approvedDiscount is derived from the stored approved
  // total, so the figures can never disagree.
  const totals = doc.number === null ? computed : {
    ...computed,
    discount: doc.discount,
    offeredDiscount: doc.offered_discount,
    offeredTotal: doc.offered_total,
    approvedTotal: doc.approved_total,
    approvedDiscount: formatSatang(Math.max(0, totalsRaw.approvedSubtotal - toSatang(doc.approved_total))),
  }
  const readiness = confirmReadiness(lines.map((l) => ({
    id: l.id, parentLineId: l.parentLineId, approvalStatus: l.approvalStatus, declineReason: null, declineNote: null, approvedAmount: l.approvedAmount,
  })))

  const undo = doc.status === 'signed'
    ? canUndoConfirm({ quotationStatus: 'signed', confirmedAt: doc.signed_at ?? new Date(), now: new Date(), jobStatus: jobStatus ?? '' })
    : { ok: false as const, code: 'not_signed' as const }

  return {
    id: doc.id,
    jobId: doc.job_id!,
    vehicleId: job.vehicleId,
    vehicleModelLinked: job.vehicleModelLinked,
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
      // Enough to open the confirm dialog: nothing left undecided. Cut sets still lacking an agreed
      // amount do not block opening it — entering that amount is what the dialog is for.
      canOpenConfirm: doc.status === 'issued' && job.callerMayDecide && readiness.undecidedLineIds.length === 0,
      canUndoConfirm: doc.status === 'signed' && undo.ok,
      canRevise: doc.status === 'issued' || doc.status === 'signed',
      undecidedLineIds: readiness.undecidedLineIds,
      setsNeedingAmountLineIds: readiness.setsMissingAmount,
    },
  }
}
