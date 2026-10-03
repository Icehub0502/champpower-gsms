/**
 * The quotation lifecycle (P3.1): draft editing, issue, per-line decisions
 * (sets included, D10), confirm ("ยืนยันผลลูกค้า", D10/D11), undo confirm,
 * revise, void, and the job-status-close integration (Q1).
 *
 * Every write here goes through packages/domain for money and decision logic
 * — this file never computes a total or a decision cascade itself, it only
 * reads rows, calls domain, and writes exactly the columns migration 0022
 * allows for the document's current status. CLAUDE.md §4/§5/§5.1.
 */
import {
  applySetDecision, approvedLineSatang, bangkokDayKey, blocksJobBackToQuoted,
  canUndoConfirm, checkApprovedAmount, confirmReadiness, formatSatang, isTrueDecline,
  jobOutcomeAtConfirm, lineTotalSatang, offeredItemLineIds, planQuotationClose, quoteTotals,
  quoteTotalsDecimal, setsNeedingAmount, toSatang, warrantySnapshotOf, workOrderLineIds,
  type DeclineReason, type QuoteLineDecisionState, type QuoteLineMoney,
} from '@champpower/domain'
import type { ScopedTx } from '@gsms/db/client.js'
import * as catalogRepo from '../repositories/catalog.js'
import * as quotationRepo from '../repositories/quotation.js'
import * as jobsRepo from '../repositories/jobs.js'
import { writeAudit } from './audit.js'
import { createItem, findSimilar } from './catalogPricing.js'

// -----------------------------------------------------------------------------
// Line <-> domain shape
// -----------------------------------------------------------------------------

type FullLine = QuoteLineMoney & QuoteLineDecisionState

function toDomainLine(r: quotationRepo.LineRow): FullLine {
  return {
    id: r.id,
    parentLineId: r.parent_line_id,
    qty: r.qty,
    unitPrice: r.unit_price,
    approvalStatus: r.approval_status as FullLine['approvalStatus'],
    approvedAmount: r.approved_amount,
    declineReason: r.decline_reason as DeclineReason | null,
    declineNote: r.decline_note,
  }
}

// -----------------------------------------------------------------------------
// Errors — a small discriminated result instead of throwing, so the route can
// map each case to its exact HTTP status without a catch-all.
// -----------------------------------------------------------------------------

export type QuotationError =
  | { code: 'job_not_found' }
  | { code: 'quotation_not_found' }
  | { code: 'quotation_exists' }
  | { code: 'quotation_not_draft' }
  | { code: 'quotation_not_issued' }
  | { code: 'quotation_frozen' }
  | { code: 'quotation_empty' }
  | { code: 'quotation_line_not_found' }
  | { code: 'catalog_item_not_found' }
  | { code: 'offered_item_not_found' }
  | { code: 'decisions_incomplete'; lineIds: string[] }
  | { code: 'set_amount_required'; lineIds: string[] }
  | { code: 'approved_amount_not_allowed'; lineId: string }
  | { code: 'amount_over_2x'; lineId: string; offered: string; max: string }
  | { code: 'amount_above_offer_free_set'; lineId: string }
  | { code: 'decline_reason_required' }
  | { code: 'decline_note_required' }
  | { code: 'undo_confirm_different_day' }
  | { code: 'undo_confirm_job_moved_on' }
  | { code: 'quotation_confirmed' }
  | { code: 'similar_item_found'; similar: Array<{ id: string; category: string; name: string }> }

export type Result<T> = { ok: true; value: T } | { ok: false; error: QuotationError }
const err = (error: QuotationError): { ok: false; error: QuotationError } => ({ ok: false, error })
const ok = <T>(value: T): { ok: true; value: T } => ({ ok: true, value })

// -----------------------------------------------------------------------------
// Draft
// -----------------------------------------------------------------------------

export async function createDraft(trx: ScopedTx, shopId: string, jobId: string): Promise<Result<quotationRepo.DocumentRow>> {
  const job = await quotationRepo.jobWithVehicle(trx, jobId)
  if (!job) return err({ code: 'job_not_found' })
  const existing = await quotationRepo.findLiveQuotation(trx, jobId)
  if (existing) return err({ code: 'quotation_exists' })
  const doc = await quotationRepo.insertDraftQuotation(trx, { shopId, jobId, customerId: job.customer_id })
  return ok(doc)
}

export async function patchDraft(trx: ScopedTx, documentId: string, discount: string): Promise<Result<quotationRepo.DocumentRow>> {
  const doc = await quotationRepo.lockDocument(trx, documentId)
  if (!doc) return err({ code: 'quotation_not_found' })
  if (doc.status !== 'draft') return err({ code: 'quotation_not_draft' })
  await quotationRepo.setDraftDiscount(trx, documentId, discount)
  return ok((await quotationRepo.getDocument(trx, documentId))!)
}

export interface AddLineItemInput { kind: 'item'; itemId: string; qty?: string; unitPrice?: string }
export interface AddLineSetInput { kind: 'set'; itemId: string; qty?: string; unitPrice?: string }
export interface AddLineFreeInput {
  kind: 'free'; name: string; lineType: string; qty: string; unit?: string; brand?: string
  unitPrice: string; isVatable?: boolean; warrantyTermId?: string
  addToCatalog: boolean; category?: string; useExistingItemId?: string; confirmNotSimilar: boolean
}
export interface AddLineOfferedInput { kind: 'offered'; offeredItemId: string; qty?: string }
export type AddLineInput = AddLineItemInput | AddLineSetInput | AddLineFreeInput | AddLineOfferedInput

async function nextSortOrder(trx: ScopedTx, documentId: string): Promise<number> {
  const lines = await quotationRepo.getLines(trx, documentId)
  return lines.reduce((max, l) => Math.max(max, l.sort_order), -1) + 1
}

/**
 * Add a line to a draft: item, set (server expands the children), free text
 * (optionally added to the catalog, D12), or a re-add from "เคยเสนอไว้".
 * Every path goes through warrantySnapshotOf() exactly once — the ONE
 * function every line-creating path uses (v3 §5).
 */
export async function addLine(
  trx: ScopedTx,
  shopId: string,
  documentId: string,
  actorId: string,
  input: AddLineInput,
): Promise<Result<quotationRepo.LineRow[]>> {
  const doc = await quotationRepo.lockDocument(trx, documentId)
  if (!doc) return err({ code: 'quotation_not_found' })
  if (doc.status !== 'draft') return err({ code: 'quotation_not_draft' })
  const job = doc.job_id ? await quotationRepo.jobWithVehicle(trx, doc.job_id) : undefined
  let sortOrder = await nextSortOrder(trx, documentId)

  if (input.kind === 'item' || input.kind === 'set') {
    const item = await catalogRepo.getItemById(trx, input.itemId)
    if (!item) return err({ code: 'catalog_item_not_found' })
    const modelPrice = job?.vehicle_model_id ? await catalogRepo.getModelPrice(trx, item.id, job.vehicle_model_id) : undefined
    const listPrice = modelPrice?.price ?? item.base_price
    const priceSource: 'model' | 'base' | null = modelPrice ? 'model' : item.base_price !== null ? 'base' : null
    const unitPrice = input.unitPrice ?? listPrice ?? '0'
    const qty = input.qty ?? item.default_qty
    const warranty = warrantySnapshotOf(
      item.warranty_term_id ? { id: item.warranty_term_id, name: item.warranty_name!, days: item.warranty_days, maxKm: item.warranty_max_km } : null,
    )
    const headerLine: quotationRepo.NewLine = {
      shopId, documentId, parentLineId: null, sortOrder: sortOrder++,
      lineType: item.line_type, catalogItemId: item.id, nameSnapshot: item.name, brandSnapshot: null,
      qty, unit: item.unit, unitPrice, listPrice, priceSource, priceRefId: modelPrice?.id ?? null,
      isVatable: item.line_type === 'part', lineTotal: formatSatang(lineTotalSatang(qty, unitPrice)),
      warrantyTermId: warranty.warrantyTermId, warrantyName: warranty.warrantyName,
      warrantyDays: warranty.warrantyDays, warrantyMaxKm: warranty.warrantyMaxKm,
    }
    const toInsert = [headerLine]
    if (input.kind === 'set' || item.is_set) {
      const components = await catalogRepo.getSetComponents(trx, item.id)
      const childItems = await catalogRepo.getItemsByIds(trx, components.map((c) => c.component_item_id).filter((x): x is string => x !== null))
      const childById = new Map(childItems.map((c) => [c.id, c]))
      for (const c of components) {
        const childItem = c.component_item_id ? childById.get(c.component_item_id) : undefined
        const childWarranty = warrantySnapshotOf(
          c.warranty_term_id ? { id: c.warranty_term_id, name: c.warranty_name!, days: c.warranty_days, maxKm: c.warranty_max_km } : null,
        )
        toInsert.push({
          shopId, documentId, parentLineId: '__header__', sortOrder: sortOrder++,
          lineType: c.line_type, catalogItemId: c.component_item_id, nameSnapshot: c.component_name, brandSnapshot: null,
          qty: c.qty, unit: childItem?.unit ?? null, unitPrice: '0', listPrice: null, priceSource: null, priceRefId: null,
          isVatable: c.line_type === 'part', lineTotal: '0.00',
          warrantyTermId: childWarranty.warrantyTermId, warrantyName: childWarranty.warrantyName,
          warrantyDays: childWarranty.warrantyDays, warrantyMaxKm: childWarranty.warrantyMaxKm,
        })
      }
    }
    // Insert the header first so the children's parentLineId can be the real id.
    const [headerId] = await quotationRepo.insertLines(trx, [toInsert[0]!])
    const children = toInsert.slice(1).map((c) => ({ ...c, parentLineId: headerId! }))
    await quotationRepo.insertLines(trx, children)
    const allLines = await quotationRepo.getLines(trx, documentId)
    return ok(allLines.filter((l) => l.id === headerId || l.parent_line_id === headerId))
  }

  if (input.kind === 'offered') {
    const row = await quotationRepo.getOfferedItem(trx, input.offeredItemId)
    if (!row) return err({ code: 'offered_item_not_found' })
    const item = row.catalog_item_id ? await catalogRepo.getItemById(trx, row.catalog_item_id) : undefined
    const warranty = warrantySnapshotOf(
      item?.warranty_term_id ? { id: item.warranty_term_id, name: item.warranty_name!, days: item.warranty_days, maxKm: item.warranty_max_km } : null,
    )
    const qty = input.qty ?? row.qty
    const [id] = await quotationRepo.insertLines(trx, [{
      shopId, documentId, parentLineId: null, sortOrder: sortOrder++,
      lineType: row.line_type, catalogItemId: row.catalog_item_id, nameSnapshot: row.name, brandSnapshot: null,
      qty, unit: null, unitPrice: row.unit_price, listPrice: row.unit_price, priceSource: null, priceRefId: null,
      isVatable: row.line_type === 'part', lineTotal: formatSatang(lineTotalSatang(qty, row.unit_price)),
      warrantyTermId: warranty.warrantyTermId, warrantyName: warranty.warrantyName,
      warrantyDays: warranty.warrantyDays, warrantyMaxKm: warranty.warrantyMaxKm,
    }])
    const lines = await quotationRepo.getLines(trx, documentId)
    return ok(lines.filter((l) => l.id === id))
  }

  // free text
  let catalogItemId: string | null = null
  if (input.addToCatalog) {
    if (input.useExistingItemId) {
      catalogItemId = input.useExistingItemId
    } else if (!input.confirmNotSimilar && input.category) {
      const similar = await findSimilar(trx, input.category, input.name)
      if (similar.length > 0) return err({ code: 'similar_item_found', similar })
    }
    if (!catalogItemId && input.category) {
      const created = await createItem(trx, {
        shopId, category: input.category, name: input.name, lineType: input.lineType,
        unit: input.unit ?? null, defaultQty: input.qty, warrantyTermId: input.warrantyTermId ?? null, actorId,
      })
      catalogItemId = created.id
    }
  }
  const term = input.warrantyTermId ? await catalogRepo.getWarrantyTerm(trx, input.warrantyTermId) : undefined
  const warranty = warrantySnapshotOf(term ? { id: term.id, name: term.name, days: term.days, maxKm: term.max_km } : null)
  const [id] = await quotationRepo.insertLines(trx, [{
    shopId, documentId, parentLineId: null, sortOrder: sortOrder++,
    lineType: input.lineType, catalogItemId, nameSnapshot: input.name, brandSnapshot: input.brand ?? null,
    qty: input.qty, unit: input.unit ?? null, unitPrice: input.unitPrice, listPrice: null, priceSource: 'manual', priceRefId: null,
    isVatable: input.isVatable ?? (input.lineType === 'part'), lineTotal: formatSatang(lineTotalSatang(input.qty, input.unitPrice)),
    warrantyTermId: warranty.warrantyTermId, warrantyName: warranty.warrantyName,
    warrantyDays: warranty.warrantyDays, warrantyMaxKm: warranty.warrantyMaxKm,
  }])
  const lines = await quotationRepo.getLines(trx, documentId)
  return ok(lines.filter((l) => l.id === id))
}

export async function patchLine(trx: ScopedTx, documentId: string, lineId: string, patch: quotationRepo.PatchLine & { qty?: string; unitPrice?: string }): Promise<Result<void>> {
  const doc = await quotationRepo.lockDocument(trx, documentId)
  if (!doc) return err({ code: 'quotation_not_found' })
  if (doc.status !== 'draft') return err({ code: 'quotation_not_draft' })
  const lines = await quotationRepo.getLines(trx, documentId)
  const line = lines.find((l) => l.id === lineId)
  if (!line) return err({ code: 'quotation_line_not_found' })
  const qty = patch.qty ?? line.qty
  const unitPrice = patch.unitPrice ?? line.unit_price
  const lineTotal = line.parent_line_id === null ? formatSatang(lineTotalSatang(qty, unitPrice)) : '0.00'
  await quotationRepo.updateLineContent(trx, lineId, { ...patch, lineTotal })
  return ok(undefined)
}

export async function removeLine(trx: ScopedTx, documentId: string, lineId: string): Promise<Result<void>> {
  const doc = await quotationRepo.lockDocument(trx, documentId)
  if (!doc) return err({ code: 'quotation_not_found' })
  if (doc.status !== 'draft') return err({ code: 'quotation_not_draft' })
  await quotationRepo.deleteLine(trx, lineId)
  return ok(undefined)
}

// -----------------------------------------------------------------------------
// Issue
// -----------------------------------------------------------------------------

export async function issue(trx: ScopedTx, shopId: string, documentId: string, actorId: string): Promise<Result<quotationRepo.DocumentRow>> {
  const doc = await quotationRepo.lockDocument(trx, documentId)
  if (!doc) return err({ code: 'quotation_not_found' })
  if (doc.status !== 'draft') return err({ code: 'quotation_not_draft' })
  const lineRows = await quotationRepo.getLines(trx, documentId)
  if (lineRows.length === 0) return err({ code: 'quotation_empty' })

  const lines = lineRows.map(toDomainLine)
  const totals = quoteTotalsDecimal(quoteTotals(lines, doc.discount))
  const number = await quotationRepo.allocateQuotationNumber(trx, shopId)
  await quotationRepo.markIssued(trx, documentId, {
    number, offeredTotal: totals.offeredTotal, approvedTotal: '0.00', discount: totals.discount, grandTotal: totals.offeredTotal, issuedBy: actorId,
  })
  await writeAudit(trx, {
    shopId, actorId, action: 'quotation_issued', entityType: 'documents', entityId: documentId,
    after: { number, offeredTotal: totals.offeredTotal },
  })
  return ok((await quotationRepo.getDocument(trx, documentId))!)
}

// -----------------------------------------------------------------------------
// Decide
// -----------------------------------------------------------------------------

export async function decideLine(
  trx: ScopedTx,
  documentId: string,
  lineId: string,
  decision: { decision: 'approved' | 'declined'; reason?: DeclineReason; note?: string },
  actorId: string,
): Promise<Result<quotationRepo.LineRow[]>> {
  const doc = await quotationRepo.lockDocument(trx, documentId)
  if (!doc) return err({ code: 'quotation_not_found' })
  if (doc.status !== 'issued') return err({ code: 'quotation_not_issued' })
  const lineRows = await quotationRepo.getLines(trx, documentId)
  const domainLines: QuoteLineDecisionState[] = lineRows.map((r) => ({
    id: r.id, parentLineId: r.parent_line_id, approvalStatus: r.approval_status as FullLine['approvalStatus'],
    declineReason: r.decline_reason as DeclineReason | null, declineNote: r.decline_note,
  }))
  const result = applySetDecision(domainLines, { lineId, decision: decision.decision, reason: decision.reason, note: decision.note })
  if (!result.ok) {
    if (result.code === 'line_not_found') return err({ code: 'quotation_line_not_found' })
    return err({ code: result.code })
  }
  await quotationRepo.applyDecisions(trx, result.changes.map((c) => ({
    lineId: c.lineId, approvalStatus: c.approvalStatus, declineReason: c.declineReason, declineNote: c.declineNote, decidedBy: actorId,
  })))

  const moneyLines = lineRows.map(toDomainLine)
  const changedById = new Map(result.changes.map((c) => [c.lineId, c]))
  const updatedMoney = moneyLines.map((l) => {
    const c = changedById.get(l.id)
    return c ? { ...l, approvalStatus: c.approvalStatus } : l
  })
  const totals = quoteTotalsDecimal(quoteTotals(updatedMoney, doc.discount))
  await quotationRepo.updateApprovedTotal(trx, documentId, totals.approvedTotal)

  return ok(await quotationRepo.getLines(trx, documentId))
}

// -----------------------------------------------------------------------------
// Confirm ("ยืนยันผลลูกค้า")
// -----------------------------------------------------------------------------

export interface ConfirmAdjustments {
  setLines?: Array<{ lineId: string; approvedAmount: string; reason: string }>
  discount?: { amount: string; reason: string }
}

export interface ConfirmOutcome {
  document: quotationRepo.DocumentRow
  jobOutcome: 'approve_job' | 'keep_quoted'
}

export async function confirm(
  trx: ScopedTx,
  shopId: string,
  documentId: string,
  adjustments: ConfirmAdjustments | undefined,
  actorId: string,
): Promise<Result<ConfirmOutcome>> {
  const doc = await quotationRepo.lockDocument(trx, documentId)
  if (!doc) return err({ code: 'quotation_not_found' })
  if (doc.status !== 'issued') return err({ code: 'quotation_not_issued' })

  const lineRows = await quotationRepo.getLines(trx, documentId)
  const setLineIds = (adjustments?.setLines ?? []).map((a) => a.lineId)
  const linesForReadiness = lineRows.map((r) => ({ ...toDomainLine(r), approvedAmount: r.approved_amount }))
  const readiness = confirmReadiness(linesForReadiness, setLineIds)
  if (readiness.undecidedLineIds.length > 0) return err({ code: 'decisions_incomplete', lineIds: readiness.undecidedLineIds })
  if (readiness.setsMissingAmount.length > 0) return err({ code: 'set_amount_required', lineIds: readiness.setsMissingAmount })

  const byId = new Map(lineRows.map((r) => [r.id, r]))
  for (const a of adjustments?.setLines ?? []) {
    const line = byId.get(a.lineId)
    if (!line) return err({ code: 'quotation_line_not_found' })
    if (!setsNeedingAmount(linesForReadiness).includes(a.lineId) && line.approved_amount === null) {
      return err({ code: 'approved_amount_not_allowed', lineId: a.lineId })
    }
    const offeredSatang = lineTotalSatang(line.qty, line.unit_price)
    const agreedSatang = toSatang(a.approvedAmount)
    const check = checkApprovedAmount(offeredSatang, agreedSatang)
    if (!check.ok) {
      if (check.code === 'over_double') return err({ code: 'amount_over_2x', lineId: a.lineId, offered: formatSatang(offeredSatang), max: formatSatang(offeredSatang * 2) })
      if (check.code === 'free_set') return err({ code: 'amount_above_offer_free_set', lineId: a.lineId })
      return err({ code: 'approved_amount_not_allowed', lineId: a.lineId })
    }
    await quotationRepo.setApprovedAmount(trx, a.lineId, a.approvedAmount)
  }

  const discount = adjustments?.discount?.amount ?? doc.discount
  const refreshedRows = await quotationRepo.getLines(trx, documentId)
  const refreshedLines = refreshedRows.map(toDomainLine)
  const totals = quoteTotalsDecimal(quoteTotals(refreshedLines, discount))

  await quotationRepo.markSigned(trx, documentId, totals.approvedTotal, totals.discount)

  const auditAfter: Record<string, unknown> = { approvedTotal: totals.approvedTotal, discount: totals.discount }
  if (adjustments?.discount) auditAfter.discountReason = adjustments.discount.reason
  if (adjustments?.setLines?.length) auditAfter.setLines = adjustments.setLines.map((a) => ({ lineId: a.lineId, approvedAmount: a.approvedAmount, reason: a.reason }))
  await writeAudit(trx, {
    shopId, actorId, action: 'quotation_confirmed', entityType: 'documents', entityId: documentId,
    before: { discount: doc.discount }, after: auditAfter,
  })

  // Offered items (D3/D13): next_time declines only, parent not children.
  const declineStates: QuoteLineDecisionState[] = refreshedRows.map((r) => ({
    id: r.id, parentLineId: r.parent_line_id, approvalStatus: r.approval_status as FullLine['approvalStatus'],
    declineReason: r.decline_reason as DeclineReason | null, declineNote: r.decline_note,
  }))
  const offeredIds = new Set(offeredItemLineIds(declineStates))
  if (offeredIds.size > 0 && doc.job_id) {
    const job = await quotationRepo.jobWithVehicle(trx, doc.job_id)
    if (job) {
      for (const r of refreshedRows) {
        if (!offeredIds.has(r.id)) continue
        await quotationRepo.insertOfferedItem(trx, { shopId, vehicleId: job.vehicle_id, documentLineId: r.id, name: r.name_snapshot })
      }
    }
  }

  const outcome = jobOutcomeAtConfirm(declineStates)
  if (doc.job_id && outcome === 'approve_job') {
    const job = await quotationRepo.lockJob(trx, doc.job_id)
    if (job && job.status === 'quoted') {
      await jobsRepo.applyStatus(trx, { jobId: doc.job_id!, status: 'approved', subState: null })
      const history = await jobsRepo.recordStatusHistory(trx, shopId, doc.job_id!, 'approved', actorId)
      await writeAudit(trx, {
        shopId, actorId, action: 'job_status_changed', entityType: 'jobs', entityId: doc.job_id,
        before: { status: 'quoted' }, after: { status: 'approved', statusHistoryId: history.id },
      })
    }
  }

  return ok({ document: (await quotationRepo.getDocument(trx, documentId))!, jobOutcome: outcome === 'approve_job' ? 'approve_job' : 'keep_quoted' })
}

// -----------------------------------------------------------------------------
// Undo confirm
// -----------------------------------------------------------------------------

export async function undoConfirm(trx: ScopedTx, shopId: string, documentId: string, reason: string, actorId: string): Promise<Result<quotationRepo.DocumentRow>> {
  const doc = await quotationRepo.lockDocument(trx, documentId)
  if (!doc) return err({ code: 'quotation_not_found' })
  if (doc.status !== 'signed') return err({ code: 'quotation_not_issued' })
  const job = doc.job_id ? await quotationRepo.lockJob(trx, doc.job_id) : undefined
  const check = canUndoConfirm({
    quotationStatus: 'signed', confirmedAt: doc.signed_at ?? new Date(), now: new Date(), jobStatus: job?.status ?? 'approved',
  })
  if (!check.ok) {
    if (check.code === 'different_day') return err({ code: 'undo_confirm_different_day' })
    return err({ code: 'undo_confirm_job_moved_on' })
  }
  await quotationRepo.markUnsigned(trx, documentId)
  await quotationRepo.deleteOfferedItemsOfDocument(trx, documentId)
  if (doc.job_id && job) {
    await jobsRepo.applyStatus(trx, { jobId: doc.job_id!, status: 'quoted', subState: null })
    await jobsRepo.recordStatusHistory(trx, shopId, doc.job_id!, 'quoted', actorId)
  }
  await writeAudit(trx, {
    shopId, actorId, action: 'quotation_confirm_undone', entityType: 'documents', entityId: documentId,
    before: { status: 'signed' }, after: { status: 'issued', reason },
  })
  return ok((await quotationRepo.getDocument(trx, documentId))!)
}

// -----------------------------------------------------------------------------
// Revise
// -----------------------------------------------------------------------------

export async function revise(trx: ScopedTx, shopId: string, documentId: string, actorId: string, reason?: string): Promise<Result<quotationRepo.DocumentRow>> {
  const doc = await quotationRepo.lockDocument(trx, documentId)
  if (!doc) return err({ code: 'quotation_not_found' })
  if (doc.status !== 'issued' && doc.status !== 'signed') return err({ code: 'quotation_frozen' })
  if (!doc.job_id) return err({ code: 'job_not_found' })

  const newDoc = await quotationRepo.insertRevision(trx, {
    shopId, jobId: doc.job_id, customerId: doc.customer_id, revision: doc.revision + 1, supersedesDocumentId: doc.id,
  })
  const oldLines = await quotationRepo.getLines(trx, doc.id)
  const idMap = new Map<string, string>()
  const topLevel = oldLines.filter((l) => l.parent_line_id === null)
  const children = oldLines.filter((l) => l.parent_line_id !== null)

  for (const l of topLevel) {
    const [newId] = await quotationRepo.insertLines(trx, [lineToNewLine(shopId, newDoc.id, l, null)])
    idMap.set(l.id, newId!)
  }
  for (const l of children) {
    const newParent = idMap.get(l.parent_line_id!)
    if (!newParent) continue
    const [newId] = await quotationRepo.insertLines(trx, [lineToNewLine(shopId, newDoc.id, l, newParent)])
    idMap.set(l.id, newId!)
  }
  // D7: copy decisions onto the new lines (insertLines does not carry them).
  for (const l of oldLines) {
    const newId = idMap.get(l.id)
    if (!newId || l.approval_status === 'pending') continue
    await quotationRepo.applyDecisions(trx, [{
      lineId: newId, approvalStatus: l.approval_status, declineReason: l.decline_reason, declineNote: l.decline_note, decidedBy: l.decided_by ?? actorId,
    }])
    if (l.approved_amount !== null) await quotationRepo.setApprovedAmount(trx, newId, l.approved_amount)
  }

  await quotationRepo.markSuperseded(trx, doc.id)
  await writeAudit(trx, {
    shopId, actorId, action: 'quotation_revised', entityType: 'documents', entityId: newDoc.id,
    before: { supersedes: doc.id, reason: reason ?? null }, after: { revision: newDoc.revision },
  })
  return ok(newDoc)
}

function lineToNewLine(shopId: string, documentId: string, l: quotationRepo.LineRow, parentLineId: string | null): quotationRepo.NewLine {
  return {
    shopId, documentId, parentLineId, sortOrder: l.sort_order, lineType: l.line_type, catalogItemId: l.catalog_item_id,
    nameSnapshot: l.name_snapshot, brandSnapshot: l.brand_snapshot, qty: l.qty, unit: l.unit, unitPrice: l.unit_price,
    listPrice: l.list_price, priceSource: l.price_source, priceRefId: l.price_ref_id, isVatable: l.is_vatable, lineTotal: l.line_total,
    warrantyTermId: l.warranty_term_id, warrantyName: l.warranty_name, warrantyDays: l.warranty_days, warrantyMaxKm: l.warranty_max_km,
  }
}

// -----------------------------------------------------------------------------
// Void (owner only — checked by the route)
// -----------------------------------------------------------------------------

export async function voidQuotation(trx: ScopedTx, shopId: string, documentId: string, reason: string, actorId: string): Promise<Result<quotationRepo.DocumentRow>> {
  const doc = await quotationRepo.lockDocument(trx, documentId)
  if (!doc) return err({ code: 'quotation_not_found' })
  if (doc.status === 'superseded' || doc.status === 'void') return err({ code: 'quotation_frozen' })
  await quotationRepo.markVoid(trx, documentId, { reason, voidedBy: actorId })
  await writeAudit(trx, {
    shopId, actorId, action: 'document_voided', entityType: 'documents', entityId: documentId,
    before: { status: doc.status }, after: { status: 'void', reason },
  })
  return ok((await quotationRepo.getDocument(trx, documentId))!)
}

// -----------------------------------------------------------------------------
// Job ending without a repair (Q1) — called from the job-status-change route,
// inside the SAME transaction, BEFORE the job row is updated.
// -----------------------------------------------------------------------------

export type CloseCheck =
  | { action: 'none' }
  | { action: 'close' }
  | { action: 'refuse'; code: 'decline_reason_required' | 'decline_note_required' | 'decline_reason_not_allowed' }

export async function closeQuotationForJobEnd(
  trx: ScopedTx,
  shopId: string,
  jobId: string,
  targetStatus: 'rejected' | 'carout',
  declineReason: DeclineReason | undefined,
  declineNote: string | undefined,
  actorId: string,
): Promise<CloseCheck> {
  const doc = await quotationRepo.findLiveQuotation(trx, jobId)
  if (!doc) return { action: 'none' }
  const lineRows = await quotationRepo.getLines(trx, doc.id)
  const lines: QuoteLineDecisionState[] = lineRows.map((r) => ({
    id: r.id, parentLineId: r.parent_line_id, approvalStatus: r.approval_status as FullLine['approvalStatus'],
    declineReason: r.decline_reason as DeclineReason | null, declineNote: r.decline_note,
  }))
  const plan = planQuotationClose({ targetStatus, quotation: { status: doc.status as 'draft' | 'issued' | 'signed', lines }, declineReason, declineNote })
  if (plan.action === 'refuse') return { action: 'refuse', code: plan.code }
  if (plan.action === 'none') return { action: 'none' }

  if (plan.declineLineIds.length > 0) {
    await quotationRepo.applyDecisions(trx, plan.declineLineIds.map((lineId) => ({
      lineId, approvalStatus: 'declined', declineReason: plan.reason!, declineNote: plan.note, decidedBy: actorId,
    })))
  }
  // System close: void_reason = 'job_closed', voided_by = NULL (not a person pressing void).
  await quotationRepo.markVoid(trx, doc.id, { reason: 'job_closed', voidedBy: null })
  await writeAudit(trx, {
    shopId, actorId: null, action: 'document_closed_by_job', entityType: 'documents', entityId: doc.id,
    before: { status: doc.status }, after: { status: 'void', voidReason: 'job_closed', jobId, targetStatus },
  })
  return { action: 'close' }
}

/** approved -> quoted is refused while the quotation is confirmed (owner decision 8) — checked by the job-status route. */
export async function jobBackToQuotedBlocked(trx: ScopedTx, jobId: string): Promise<boolean> {
  const doc = await quotationRepo.findLiveQuotation(trx, jobId)
  return blocksJobBackToQuoted((doc?.status as 'signed' | undefined) ?? null)
}

// -----------------------------------------------------------------------------
// Work order — approved lines only, no prices, served from a SIGNED quotation.
// -----------------------------------------------------------------------------

export async function workOrder(trx: ScopedTx, jobId: string): Promise<Result<{ job: quotationRepo.JobWithVehicleRow; lines: quotationRepo.WorkOrderLineRow[] }>> {
  const job = await quotationRepo.jobWithVehicle(trx, jobId)
  if (!job) return err({ code: 'job_not_found' })
  const doc = await quotationRepo.findLiveQuotation(trx, jobId)
  if (!doc || doc.status !== 'signed') return ok({ job, lines: [] })
  const approved = await quotationRepo.getApprovedLines(trx, doc.id)
  const ids = new Set(workOrderLineIds(approved.map((l) => ({
    id: l.id, parentLineId: l.parent_line_id, approvalStatus: 'approved', declineReason: null, declineNote: null,
  }))))
  return ok({ job, lines: approved.filter((l) => ids.has(l.id)) })
}

// re-exports used by the route layer for totals/next-state display
export { approvedLineSatang, bangkokDayKey, isTrueDecline, quoteTotals, quoteTotalsDecimal, setsNeedingAmount, confirmReadiness }
