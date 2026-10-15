/**
 * The quotation lifecycle (P3.1): draft editing, issue, per-line decisions
 * (sets included, D10), confirm ("ยืนยันผลลูกค้า", D10/D11), undo confirm,
 * revise, void, and the job-status-close integration (Q1).
 *
 * Every write here goes through packages/domain for money and decision logic
 * — this file never computes a total or a decision cascade itself, it only
 * reads rows, calls domain, and writes exactly the columns migration 0022
 * allows for the document's current status. CLAUDE.md §4/§5/§5.1.
 *
 * LOCK ORDER (CLAUDE.md §4.x): jobs -> documents -> document_lines, always.
 * A path that needs both takes the job FIRST (lockJobThenDocument); a path
 * that only needs the document never touches the job afterwards.
 *
 * DATABASE CHECKs HAVE A DOMAIN CHECK IN FRONT (CLAUDE.md §4.y): a line is run
 * through validateQuoteLine (and a money overflow guard) before any write, so
 * a bad value is a 400 with a field error, never a CHECK violation as a 500.
 *
 * Reminder for every function below that returns err() AFTER writing: the
 * request still COMMITS the transaction (a returned error is not a throw), so
 * any write that precedes an err() must be harmless on its own. Validate first,
 * write after.
 */
import {
  MoneyError, agreedAmountsAfterUndo, discountAtIssue, totalsAfterUndoConfirm, applySetDecision, blocksJobBackToQuoted, canUndoConfirm, checkApprovedAmount,
  confirmReadiness, decisionCarries, formatSatang, jobOutcomeAtConfirm, jobStatusOnIssue,
  lineTotalSatang, offeredItemLineIds, planQuotationClose, quoteTotals, quoteTotalsDecimal,
  setsNeedingAmount, subStateAfterMove, toSatang, validateQuoteLine, warrantySnapshotOf,
  workOrderLineIds, type DeclineReason, type LineIdentity, type QuoteLineDecisionState,
  type QuoteLineMoney,
} from '@champpower/domain'
import type { ScopedTx } from '@gsms/db/client.js'
import * as catalogRepo from '../repositories/catalog.js'
import * as quotationRepo from '../repositories/quotation.js'
import * as jobsRepo from '../repositories/jobs.js'
import { writeAudit } from './audit.js'
import { createItem, findSimilar } from './catalogPricing.js'

/** A job in one of these can no longer take a new quotation, revision or issue. */
const ENDED_JOB_STATUSES = ['rejected', 'carout', 'delivered']

// -----------------------------------------------------------------------------
// Line <-> domain shapes (one mapping each, used everywhere)
// -----------------------------------------------------------------------------

type FullLine = QuoteLineMoney & QuoteLineDecisionState

function decisionState(r: quotationRepo.LineRow): QuoteLineDecisionState {
  return {
    id: r.id,
    parentLineId: r.parent_line_id,
    approvalStatus: r.approval_status as FullLine['approvalStatus'],
    declineReason: r.decline_reason as DeclineReason | null,
    declineNote: r.decline_note,
  }
}

function toDomainLine(r: quotationRepo.LineRow): FullLine {
  return { ...decisionState(r), qty: r.qty, unitPrice: r.unit_price, approvedAmount: r.approved_amount }
}

function identityOf(r: quotationRepo.LineRow): LineIdentity {
  return {
    catalogItemId: r.catalog_item_id, name: r.name_snapshot, lineType: r.line_type, qty: r.qty,
    unitPrice: r.unit_price, warrantyTermId: r.warranty_term_id, warrantyDays: r.warranty_days,
    warrantyMaxKm: r.warranty_max_km,
  }
}

/** The superseded revision's line this one came from, as it was. null for a new line or a rev 1 line. */
export function sourceIdentityOf(r: quotationRepo.LineRow): LineIdentity | null {
  if (r.source_line_id === null || r.src_name === null || r.src_line_type === null || r.src_qty === null || r.src_unit_price === null) return null
  return {
    catalogItemId: r.src_catalog_item_id, name: r.src_name, lineType: r.src_line_type, qty: r.src_qty,
    unitPrice: r.src_unit_price, warrantyTermId: r.src_warranty_term_id, warrantyDays: r.src_warranty_days,
    warrantyMaxKm: r.src_warranty_max_km,
  }
}

// -----------------------------------------------------------------------------
// Errors — a small discriminated result instead of throwing, so the route can
// map each case to its exact HTTP status without a catch-all.
// -----------------------------------------------------------------------------

export type QuotationError =
  | { code: 'job_not_found' }
  | { code: 'job_not_open' }
  | { code: 'quotation_not_found' }
  | { code: 'quotation_missing' }
  | { code: 'quotation_not_confirmed' }
  | { code: 'quotation_exists' }
  | { code: 'quotation_not_draft' }
  | { code: 'quotation_not_issued' }
  | { code: 'quotation_frozen' }
  | { code: 'quotation_empty' }
  | { code: 'quotation_line_not_found' }
  | { code: 'catalog_item_not_found' }
  | { code: 'offered_item_not_found' }
  | { code: 'invalid_line'; fields: Record<string, string[]> }
  | { code: 'amount_out_of_range' }
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
  | { code: 'warranty_term_not_found' }
  | { code: 'catalog_item_exists'; itemId: string }
  | { code: 'similar_item_found'; similar: Array<{ id: string; category: string; name: string }> }

export type Result<T> = { ok: true; value: T } | { ok: false; error: QuotationError }
const err = (error: QuotationError): { ok: false; error: QuotationError } => ({ ok: false, error })
const ok = <T>(value: T): { ok: true; value: T } => ({ ok: true, value })

/** The document's decision columns say nothing yet, and the DB says the same: field errors for a line, or null when it is fine. */
function lineFieldErrors(input: { lineType: string; qty: string; unitPrice: string; isVatable: boolean }): Record<string, string[]> | null {
  const fields: Record<string, string[]> = {}
  const issues = validateQuoteLine({ ...input, lineType: input.lineType as 'part' | 'labor' | 'fee' })
  for (const i of issues) (fields[i.field] ??= []).push(i.code)
  if (issues.length === 0) {
    try {
      lineTotalSatang(input.qty, input.unitPrice)
    } catch (e) {
      if (!(e instanceof MoneyError)) throw e
      fields.unitPrice = ['out_of_range']
    }
  }
  return Object.keys(fields).length > 0 ? fields : null
}

/**
 * Would the document's totals still fit numeric(12,2) with this line added (or
 * this line's qty/price changed)? A draft whose total cannot be stored must
 * never exist: it could not be shown, issued or priced. Checked BEFORE the write.
 */
function totalFits(rows: quotationRepo.LineRow[], line: { id: string; qty: string; unitPrice: string; isChild?: boolean }): boolean {
  try {
    const others = rows.filter((r) => r.id !== line.id).map(toDomainLine)
    quoteTotals(
      [...others, { id: line.id, parentLineId: line.isChild ? 'x' : null, qty: line.qty, unitPrice: line.unitPrice, approvalStatus: 'pending', approvedAmount: null }],
      '0',
    )
    return true
  } catch (e) {
    if (e instanceof MoneyError) return false
    throw e
  }
}

/** Job first, then the document (CLAUDE.md §4.x). The unlocked read only learns which job to lock. */
async function lockJobThenDocument(trx: ScopedTx, documentId: string) {
  const pre = await quotationRepo.getDocument(trx, documentId)
  if (!pre) return null
  const job = pre.job_id ? await quotationRepo.lockJob(trx, pre.job_id) : undefined
  const doc = await quotationRepo.lockDocument(trx, documentId)
  if (!doc) return null
  return { doc, job }
}

/**
 * A set that is not cut any more must not keep an agreed amount (v3 §3.3).
 * Only valid while the lines may be written (draft / issued). Returns the rows
 * as they are after the clear.
 */
async function clearStaleAgreedAmounts(trx: ScopedTx, rows: quotationRepo.LineRow[]): Promise<quotationRepo.LineRow[]> {
  const needing = new Set(setsNeedingAmount(rows.map(decisionState)))
  const out: quotationRepo.LineRow[] = []
  for (const r of rows) {
    if (r.approved_amount !== null && !needing.has(r.id)) {
      await quotationRepo.setApprovedAmount(trx, r.id, null)
      out.push({ ...r, approved_amount: null })
    } else out.push(r)
  }
  return out
}

/**
 * Revision draft only: forget the customer's decision on a set (the head and every
 * remaining child) because a member of it changed. Without this a cut set whose
 * declined piece was removed looks whole, loses its agreed amount and is charged in
 * full without being asked again. Re-reads the rows so it sees the state after the
 * caller's write; audits only when something was actually reset. Runs under the
 * document lock the caller already holds (lock order jobs -> documents -> lines).
 */
async function resetSetDecisions(trx: ScopedTx, shopId: string, documentId: string, headId: string, actorId: string): Promise<void> {
  const members = (await quotationRepo.getLines(trx, documentId)).filter((l) => l.id === headId || l.parent_line_id === headId)
  const decided = members.filter((l) => l.approval_status !== 'pending' || l.approved_amount !== null || l.decided_at !== null)
  if (decided.length === 0) return
  for (const m of decided) await quotationRepo.resetDecision(trx, documentId, m.id)
  await writeAudit(trx, {
    shopId, actorId, action: 'set_decision_reset', entityType: 'documents', entityId: documentId,
    after: { reasonCode: 'set_changed_decision_reset', headLineId: headId, lineIds: decided.map((l) => l.id) },
  })
}

/** checkApprovedAmount on every line that carries an agreed amount; the first refusal, or null. */
function agreedAmountRefusal(rows: quotationRepo.LineRow[]): QuotationError | null {
  for (const r of rows) {
    if (r.approved_amount === null) continue
    const offered = lineTotalSatang(r.qty, r.unit_price)
    const check = checkApprovedAmount(offered, toSatang(r.approved_amount))
    if (check.ok) continue
    if (check.code === 'over_double') return { code: 'amount_over_2x', lineId: r.id, offered: formatSatang(offered), max: formatSatang(offered * 2) }
    if (check.code === 'free_set') return { code: 'amount_above_offer_free_set', lineId: r.id }
    return { code: 'approved_amount_not_allowed', lineId: r.id }
  }
  return null
}

// -----------------------------------------------------------------------------
// Draft
// -----------------------------------------------------------------------------

export async function createDraft(trx: ScopedTx, shopId: string, jobId: string): Promise<Result<quotationRepo.DocumentRow>> {
  // Job lock first: concurrent creates for one job queue here, so the second
  // one sees the first one's draft and answers quotation_exists.
  const job = await quotationRepo.lockJob(trx, jobId)
  if (!job) return err({ code: 'job_not_found' })
  if (ENDED_JOB_STATUSES.includes(job.status)) return err({ code: 'job_not_open' })
  const withVehicle = await quotationRepo.jobWithVehicle(trx, jobId)
  if (!withVehicle) return err({ code: 'job_not_found' })
  const existing = await quotationRepo.findLiveQuotation(trx, jobId)
  if (existing) return err({ code: 'quotation_exists' })
  const doc = await quotationRepo.insertDraftQuotation(trx, { shopId, jobId, customerId: withVehicle.customer_id })
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
 * function every line-creating path uses (v3 §5). A merged item is resolved
 * to its survivor first (D12), so a line never points at a retired item.
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
    const item = await catalogRepo.getSurvivingItem(trx, input.itemId)
    if (!item) return err({ code: 'catalog_item_not_found' })
    const modelPrice = job?.vehicle_model_id ? await catalogRepo.getModelPrice(trx, item.id, job.vehicle_model_id) : undefined
    const listPrice = modelPrice?.price ?? item.base_price
    const priceSource: 'model' | 'base' | null = modelPrice ? 'model' : item.base_price !== null ? 'base' : null
    const unitPrice = input.unitPrice ?? listPrice ?? '0'
    const qty = input.qty ?? item.default_qty
    const isVatable = item.line_type === 'part'
    const fields = lineFieldErrors({ lineType: item.line_type, qty, unitPrice, isVatable })
    if (fields) return err({ code: 'invalid_line', fields })
    if (!totalFits(await quotationRepo.getLines(trx, documentId), { id: 'new', qty, unitPrice })) return err({ code: 'invalid_line', fields: { unitPrice: ['out_of_range'] } })
    const warranty = warrantySnapshotOf(
      item.warranty_term_id ? { id: item.warranty_term_id, name: item.warranty_name!, days: item.warranty_days, maxKm: item.warranty_max_km } : null,
    )
    const headerLine: quotationRepo.NewLine = {
      shopId, documentId, parentLineId: null, sortOrder: sortOrder++,
      lineType: item.line_type, catalogItemId: item.id, nameSnapshot: item.name, brandSnapshot: null,
      qty, unit: item.unit, unitPrice, listPrice, priceSource, priceRefId: modelPrice?.id ?? null,
      isVatable, lineTotal: formatSatang(lineTotalSatang(qty, unitPrice)),
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
    // Only a still-declined item of THIS job's own vehicle can be re-added (security L4).
    if (!row || !job || row.vehicle_id !== job.vehicle_id || row.status !== 'declined') return err({ code: 'offered_item_not_found' })
    const item = row.catalog_item_id ? await catalogRepo.getSurvivingItem(trx, row.catalog_item_id) : undefined
    const warranty = warrantySnapshotOf(
      item?.warranty_term_id ? { id: item.warranty_term_id, name: item.warranty_name!, days: item.warranty_days, maxKm: item.warranty_max_km } : null,
    )
    const qty = input.qty ?? row.qty
    const fields = lineFieldErrors({ lineType: row.line_type, qty, unitPrice: row.unit_price, isVatable: row.line_type === 'part' })
    if (fields) return err({ code: 'invalid_line', fields })
    if (!totalFits(await quotationRepo.getLines(trx, documentId), { id: 'new', qty, unitPrice: row.unit_price })) return err({ code: 'invalid_line', fields: { unitPrice: ['out_of_range'] } })
    const [id] = await quotationRepo.insertLines(trx, [{
      shopId, documentId, parentLineId: null, sortOrder: sortOrder++,
      lineType: row.line_type, catalogItemId: item?.id ?? null, nameSnapshot: row.name, brandSnapshot: null,
      qty, unit: null, unitPrice: row.unit_price, listPrice: row.unit_price, priceSource: null, priceRefId: null,
      isVatable: row.line_type === 'part', lineTotal: formatSatang(lineTotalSatang(qty, row.unit_price)),
      warrantyTermId: warranty.warrantyTermId, warrantyName: warranty.warrantyName,
      warrantyDays: warranty.warrantyDays, warrantyMaxKm: warranty.warrantyMaxKm,
    }])
    const lines = await quotationRepo.getLines(trx, documentId)
    return ok(lines.filter((l) => l.id === id))
  }

  // free text. Validate EVERYTHING (line, ids) before any write; a missing and another shop's id look the same.
  const isVatable = input.isVatable ?? (input.lineType === 'part')
  const fields = lineFieldErrors({ lineType: input.lineType, qty: input.qty, unitPrice: input.unitPrice, isVatable })
  if (fields) return err({ code: 'invalid_line', fields })
  if (!totalFits(await quotationRepo.getLines(trx, documentId), { id: 'new', qty: input.qty, unitPrice: input.unitPrice })) return err({ code: 'invalid_line', fields: { unitPrice: ['out_of_range'] } })
  let catalogItemId: string | null = null
  const term = input.warrantyTermId ? await catalogRepo.getWarrantyTerm(trx, input.warrantyTermId) : undefined
  if (input.warrantyTermId && !term) return err({ code: 'warranty_term_not_found' })
  const existing = input.addToCatalog && input.useExistingItemId ? await catalogRepo.getSurvivingItem(trx, input.useExistingItemId) : undefined
  if (input.addToCatalog && input.useExistingItemId && !existing) return err({ code: 'catalog_item_not_found' })
  if (input.addToCatalog) {
    if (existing) {
      catalogItemId = existing.id
    } else if (!input.confirmNotSimilar && input.category) {
      const similar = await findSimilar(trx, input.category, input.name)
      if (similar.length > 0) return err({ code: 'similar_item_found', similar: similar.map(({ id, category, name }) => ({ id, category, name })) })
    }
    if (!catalogItemId && input.category) {
      const created = await createItem(trx, {
        shopId, category: input.category, name: input.name, lineType: input.lineType,
        unit: input.unit ?? null, defaultQty: input.qty, warrantyTermId: input.warrantyTermId ?? null, actorId,
      })
      if (created.kind === 'warranty_not_found') return err({ code: 'warranty_term_not_found' })
      if (created.kind === 'exists') return err({ code: 'catalog_item_exists', itemId: created.itemId })
      catalogItemId = created.item.id
    }
  }
  const warranty = warrantySnapshotOf(term ? { id: term.id, name: term.name, days: term.days, maxKm: term.max_km } : null)
  const [id] = await quotationRepo.insertLines(trx, [{
    shopId, documentId, parentLineId: null, sortOrder: sortOrder++,
    lineType: input.lineType, catalogItemId, nameSnapshot: input.name, brandSnapshot: input.brand ?? null,
    qty: input.qty, unit: input.unit ?? null, unitPrice: input.unitPrice, listPrice: null, priceSource: 'manual', priceRefId: null,
    isVatable, lineTotal: formatSatang(lineTotalSatang(input.qty, input.unitPrice)),
    warrantyTermId: warranty.warrantyTermId, warrantyName: warranty.warrantyName,
    warrantyDays: warranty.warrantyDays, warrantyMaxKm: warranty.warrantyMaxKm,
  }])
  const lines = await quotationRepo.getLines(trx, documentId)
  return ok(lines.filter((l) => l.id === id))
}

export interface PatchLineInput {
  name?: string
  brand?: string | null
  lineType?: string
  qty?: string
  unit?: string | null
  unitPrice?: string
  isVatable?: boolean
  /** A term id re-snapshots the warranty; null clears it; omitted leaves it alone. */
  warrantyTermId?: string | null
  sortOrder?: number
}

export async function patchLine(trx: ScopedTx, shopId: string, documentId: string, lineId: string, patch: PatchLineInput, actorId: string): Promise<Result<void>> {
  const doc = await quotationRepo.lockDocument(trx, documentId)
  if (!doc) return err({ code: 'quotation_not_found' })
  if (doc.status !== 'draft') return err({ code: 'quotation_not_draft' })
  const line = await quotationRepo.getLine(trx, documentId, lineId)
  if (!line) return err({ code: 'quotation_line_not_found' })

  const lineType = patch.lineType ?? line.line_type
  const qty = patch.qty ?? line.qty
  const unitPrice = patch.unitPrice ?? line.unit_price
  const isVatable = patch.isVatable ?? line.is_vatable
  const fields = lineFieldErrors({ lineType, qty, unitPrice, isVatable })
  if (fields) return err({ code: 'invalid_line', fields })
  if (line.parent_line_id === null && !totalFits(await quotationRepo.getLines(trx, documentId), { id: lineId, qty, unitPrice })) {
    return err({ code: 'invalid_line', fields: { unitPrice: ['out_of_range'] } })
  }

  let warranty: ReturnType<typeof warrantySnapshotOf> | undefined
  if (patch.warrantyTermId !== undefined) {
    if (patch.warrantyTermId === null) warranty = warrantySnapshotOf(null)
    else {
      const term = await catalogRepo.getWarrantyTerm(trx, patch.warrantyTermId)
      if (!term) return err({ code: 'warranty_term_not_found' })
      warranty = warrantySnapshotOf({ id: term.id, name: term.name, days: term.days, maxKm: term.max_km })
    }
  }

  const lineTotal = line.parent_line_id === null ? formatSatang(lineTotalSatang(qty, unitPrice)) : '0.00'
  await quotationRepo.updateLineContent(trx, documentId, lineId, {
    nameSnapshot: patch.name, brandSnapshot: patch.brand, lineType: patch.lineType, qty: patch.qty, unit: patch.unit,
    unitPrice: patch.unitPrice, isVatable: patch.isVatable, sortOrder: patch.sortOrder, lineTotal,
    ...(warranty ? {
      warrantyTermId: warranty.warrantyTermId, warrantyName: warranty.warrantyName,
      warrantyDays: warranty.warrantyDays, warrantyMaxKm: warranty.warrantyMaxKm,
    } : {}),
  })

  // Owner Q2: on a revision draft, a line that no longer matches what the
  // customer decided on forgets that decision. Compared with the line it was
  // copied from; a new line (no source) has nothing carried.
  if (line.parent_line_id !== null) {
    // A set decides as one: any edit to a member, on a revision, sends the whole set back to the customer.
    // DECISION-2026-10-06 §2: display order, brand, unit, price_source, list_price are not a change; only the
    // identity decisionCarries compares (item, name, type, qty, unit price, warranty) is.
    const after = await quotationRepo.getLine(trx, documentId, lineId)
    if (doc.supersedes_document_id !== null && after && !decisionCarries(identityOf(line), identityOf(after))) {
      await resetSetDecisions(trx, shopId, documentId, line.parent_line_id, actorId)
    }
  } else if (doc.supersedes_document_id !== null) {
    // A head's identity change sends its whole set back to the customer whatever the head's own
    // approval_status is: applySetDecision lets children carry decisions while the head is still
    // pending, so gating on the head's status left those children decided. Compared with the source
    // line when there is one, otherwise before/after. resetSetDecisions resets the head itself
    // (and is a no-op when nothing in the set was decided).
    const after = await quotationRepo.getLine(trx, documentId, lineId)
    if (after) {
      const src = line.source_line_id !== null ? sourceIdentityOf(after) : identityOf(line)
      if (!src || !decisionCarries(src, identityOf(after))) {
        const hasChildren = (await quotationRepo.getLines(trx, documentId)).some((l) => l.parent_line_id === lineId)
        // A plain line is not a set: it resets quietly as before; only a set is audited as set_decision_reset.
        if (hasChildren) await resetSetDecisions(trx, shopId, documentId, lineId, actorId)
        else await quotationRepo.resetDecision(trx, documentId, lineId)
      }
    }
  }
  return ok(undefined)
}

export async function removeLine(trx: ScopedTx, shopId: string, documentId: string, lineId: string, actorId: string): Promise<Result<void>> {
  const doc = await quotationRepo.lockDocument(trx, documentId)
  if (!doc) return err({ code: 'quotation_not_found' })
  if (doc.status !== 'draft') return err({ code: 'quotation_not_draft' })
  // The line must be on THIS document (of this shop, via RLS); a foreign or missing line is the same 404.
  const lines = await quotationRepo.getLines(trx, documentId)
  const target = lines.find((l) => l.id === lineId)
  if (!target) return err({ code: 'quotation_line_not_found' })
  await quotationRepo.deleteLine(trx, documentId, lineId)
  // Removing a member (e.g. the declined piece) must not leave the rest of the set looking decided.
  if (target.parent_line_id !== null && doc.supersedes_document_id !== null) {
    await resetSetDecisions(trx, shopId, documentId, target.parent_line_id, actorId)
  }
  return ok(undefined)
}

// -----------------------------------------------------------------------------
// Issue
// -----------------------------------------------------------------------------

export async function issue(trx: ScopedTx, shopId: string, documentId: string, actorId: string): Promise<Result<quotationRepo.DocumentRow>> {
  const locked = await lockJobThenDocument(trx, documentId)
  if (!locked) return err({ code: 'quotation_not_found' })
  const { doc, job } = locked
  if (doc.status !== 'draft') return err({ code: 'quotation_not_draft' })
  if (job && ENDED_JOB_STATUSES.includes(job.status)) return err({ code: 'job_not_open' })

  const lineRows = await quotationRepo.getLines(trx, documentId)
  if (lineRows.length === 0) return err({ code: 'quotation_empty' })

  // Validate before numbering. On a REVISION the lines carry decisions and agreed
  // amounts from the superseded document: drop an amount whose set is whole
  // again, and re-run the 3-tier rule on the rest (a draft is writable).
  const rows = await clearStaleAgreedAmounts(trx, lineRows)
  let totals: ReturnType<typeof quoteTotalsDecimal>
  let offeredDiscount: string
  try {
    const refusal = agreedAmountRefusal(rows)
    if (refusal) return err(refusal)
    // The discount stored on the offer is what the entered one really takes off the
    // offered subtotal (clamped), written to BOTH offered_discount and discount; the
    // totals are computed from that stored figure so the paper foots (0024).
    const domainRows = rows.map(toDomainLine)
    offeredDiscount = discountAtIssue(domainRows, doc.discount)
    totals = quoteTotalsDecimal(quoteTotals(domainRows, offeredDiscount))
  } catch (e) {
    if (e instanceof MoneyError) return err({ code: 'amount_out_of_range' })
    throw e
  }

  const number = await quotationRepo.allocateQuotationNumber(trx, shopId)
  // approved_total is what the carried decisions approve (0 for a fresh rev 1).
  await quotationRepo.markIssued(trx, documentId, {
    number, offeredTotal: totals.offeredTotal, approvedTotal: totals.approvedTotal, offeredDiscount,
    grandTotal: totals.offeredTotal, issuedBy: actorId,
  })
  await writeAudit(trx, {
    shopId, actorId, action: 'quotation_issued', entityType: 'documents', entityId: documentId,
    after: { number, offeredTotal: totals.offeredTotal, approvedTotal: totals.approvedTotal, offeredDiscount },
  })

  // Owner decision (3 Oct 2026): issuing moves the job to 'quoted', in this SAME
  // transaction — a failure anywhere above or below rolls back the number and
  // the status together. jobStatusOnIssue deliberately bypasses the manual-move
  // table (received -> quoted is ONE step, no invented 'inspecting'); it is used
  // here and nowhere else. The write goes through the same repository functions
  // the kanban status route uses, so there is no second status path. The job row
  // is already locked (lockJobThenDocument).
  const to = job ? jobStatusOnIssue(job.status) : null
  if (job && doc.job_id && to) {
    const subState = subStateAfterMove(to, job.sub_state)
    await jobsRepo.applyStatus(trx, { jobId: doc.job_id, status: to, subState })
    const history = await jobsRepo.recordStatusHistory(trx, shopId, doc.job_id, to, actorId, 'ออกใบเสนอราคา')
    await writeAudit(trx, {
      shopId, actorId, action: 'job_status_changed', entityType: 'jobs', entityId: doc.job_id,
      before: { status: job.status, sub_state: job.sub_state },
      after: { status: to, sub_state: subState, status_history_id: history.id },
    })
  }
  return ok((await quotationRepo.getDocument(trx, documentId))!)
}

// -----------------------------------------------------------------------------
// Decide
// -----------------------------------------------------------------------------

export async function decideLine(
  trx: ScopedTx,
  shopId: string,
  documentId: string,
  lineId: string,
  decision: { decision: 'approved' | 'declined'; reason?: DeclineReason; note?: string },
  actorId: string,
): Promise<Result<quotationRepo.LineRow[]>> {
  const doc = await quotationRepo.lockDocument(trx, documentId)
  if (!doc) return err({ code: 'quotation_not_found' })
  if (doc.status !== 'issued') return err({ code: 'quotation_not_issued' })
  const lineRows = await quotationRepo.getLines(trx, documentId)
  const result = applySetDecision(lineRows.map(decisionState), { lineId, decision: decision.decision, reason: decision.reason, note: decision.note })
  if (!result.ok) {
    if (result.code === 'line_not_found') return err({ code: 'quotation_line_not_found' })
    return err({ code: result.code })
  }
  await quotationRepo.applyDecisions(trx, result.changes.map((c) => ({
    lineId: c.lineId, approvalStatus: c.approvalStatus, declineReason: c.declineReason, declineNote: c.declineNote, decidedBy: actorId,
  })))

  // The decision may have made a cut set whole again: drop its stale agreed amount.
  const changedById = new Map(result.changes.map((c) => [c.lineId, c]))
  const afterRows = await clearStaleAgreedAmounts(trx, lineRows.map((r) => {
    const c = changedById.get(r.id)
    return c ? { ...r, approval_status: c.approvalStatus, decline_reason: c.declineReason, decline_note: c.declineNote } : r
  }))
  const totals = quoteTotalsDecimal(quoteTotals(afterRows.map(toDomainLine), doc.discount))
  await quotationRepo.updateApprovedTotal(trx, documentId, totals.approvedTotal)

  // Audit WITHOUT the free-text note (security M2): line ids and statuses only.
  const target = lineRows.find((r) => r.id === lineId)!
  await writeAudit(trx, {
    shopId, actorId, action: 'quotation_line_decided', entityType: 'document_lines', entityId: lineId,
    before: { approvalStatus: target.approval_status, declineReason: target.decline_reason },
    after: {
      documentId, approvalStatus: decision.decision, declineReason: decision.reason ?? null,
      // set members moved by the same decision (D10 cascade)
      cascade: result.changes.filter((c) => c.lineId !== lineId).map((c) => ({
        lineId: c.lineId, from: lineRows.find((r) => r.id === c.lineId)?.approval_status, to: c.approvalStatus,
      })),
    },
  })
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
  /** Set when the quotation was confirmed but the job is still before 'quoted' (received/inspecting), so the screen can say the job was not moved. */
  jobStatusUnchanged: { currentStatus: string } | null
}

export async function confirm(
  trx: ScopedTx,
  shopId: string,
  documentId: string,
  adjustments: ConfirmAdjustments | undefined,
  actorId: string,
): Promise<Result<ConfirmOutcome>> {
  const locked = await lockJobThenDocument(trx, documentId)
  if (!locked) return err({ code: 'quotation_not_found' })
  const { doc, job } = locked
  if (doc.status !== 'issued') return err({ code: 'quotation_not_issued' })

  const lineRows = await clearStaleAgreedAmounts(trx, await quotationRepo.getLines(trx, documentId))
  const setLineIds = (adjustments?.setLines ?? []).map((a) => a.lineId)
  const linesForReadiness = lineRows.map((r) => ({ ...decisionState(r), approvedAmount: r.approved_amount }))
  const readiness = confirmReadiness(linesForReadiness, setLineIds)
  if (readiness.undecidedLineIds.length > 0) return err({ code: 'decisions_incomplete', lineIds: readiness.undecidedLineIds })
  if (readiness.setsMissingAmount.length > 0) return err({ code: 'set_amount_required', lineIds: readiness.setsMissingAmount })

  // Validate EVERY adjustment before writing any (all-or-nothing).
  const byId = new Map(lineRows.map((r) => [r.id, r]))
  const needing = new Set(setsNeedingAmount(lineRows.map(decisionState)))
  for (const a of adjustments?.setLines ?? []) {
    const line = byId.get(a.lineId)
    if (!line) return err({ code: 'quotation_line_not_found' })
    // Only a set that is really cut may carry an agreed amount (v3 §3.3 item 5).
    if (!needing.has(a.lineId)) return err({ code: 'approved_amount_not_allowed', lineId: a.lineId })
    const offeredSatang = lineTotalSatang(line.qty, line.unit_price)
    const check = checkApprovedAmount(offeredSatang, toSatang(a.approvedAmount))
    if (!check.ok) {
      if (check.code === 'over_double') return err({ code: 'amount_over_2x', lineId: a.lineId, offered: formatSatang(offeredSatang), max: formatSatang(offeredSatang * 2) })
      if (check.code === 'free_set') return err({ code: 'amount_above_offer_free_set', lineId: a.lineId })
      return err({ code: 'approved_amount_not_allowed', lineId: a.lineId })
    }
  }
  // What each cut set held before confirm, kept in the audit so undo can put it back exactly.
  const priorSetAmounts = (adjustments?.setLines ?? []).map((a) => ({ lineId: a.lineId, approvedAmount: byId.get(a.lineId)!.approved_amount }))
  for (const a of adjustments?.setLines ?? []) {
    await quotationRepo.setApprovedAmount(trx, a.lineId, a.approvedAmount)
  }

  const discount = adjustments?.discount?.amount ?? doc.discount
  const refreshedRows = await quotationRepo.getLines(trx, documentId)
  const totals = quoteTotalsDecimal(quoteTotals(refreshedRows.map(toDomainLine), discount))

  await quotationRepo.markSigned(trx, documentId, totals.approvedTotal, totals.discount)

  const auditAfter: Record<string, unknown> = { approvedTotal: totals.approvedTotal, discount: totals.discount }
  if (adjustments?.discount) auditAfter.discountReason = adjustments.discount.reason
  if (adjustments?.setLines?.length) auditAfter.setLines = adjustments.setLines.map((a) => ({ lineId: a.lineId, approvedAmount: a.approvedAmount, reason: a.reason }))
  // The free-text reasons below (discount / agreed set amount) go into audit_logs.after on purpose:
  // CLAUDE.md §9 requires the reason of a money adjustment to be audited and documents has no column
  // for it. Unlike undo-delivered, whose reason lives on the job_status_history row, so audit keeps
  // only the row id there. Reviewed by security (6 Oct 2026): accepted.
  // Offered items (D3/D13): next_time declines only, parent not children.
  const declineStates = refreshedRows.map(decisionState)
  const offeredIds = new Set(offeredItemLineIds(declineStates))
  if (offeredIds.size > 0 && doc.job_id) {
    const withVehicle = await quotationRepo.jobWithVehicle(trx, doc.job_id)
    if (withVehicle) {
      for (const r of refreshedRows) {
        if (!offeredIds.has(r.id)) continue
        await quotationRepo.insertOfferedItem(trx, { shopId, vehicleId: withVehicle.vehicle_id, documentLineId: r.id, name: r.name_snapshot, catalogItemId: r.catalog_item_id })
      }
    }
  }

  const outcome = jobOutcomeAtConfirm(declineStates)
  let jobStatusUnchanged: { currentStatus: string } | null = null
  let jobAdvancedFrom: string | null = null
  if (doc.job_id && job && outcome === 'approve_job') {
    if (job.status === 'quoted') {
      jobAdvancedFrom = 'quoted'
      await jobsRepo.applyStatus(trx, { jobId: doc.job_id, status: 'approved', subState: null })
      const history = await jobsRepo.recordStatusHistory(trx, shopId, doc.job_id, 'approved', actorId)
      await writeAudit(trx, {
        shopId, actorId, action: 'job_status_changed', entityType: 'jobs', entityId: doc.job_id,
        before: { status: 'quoted' }, after: { status: 'approved', statusHistoryId: history.id },
      })
    } else if (job.status === 'received' || job.status === 'inspecting') {
      // Before 'quoted': do not skip silently. Past 'quoted' skipping is correct.
      jobStatusUnchanged = { currentStatus: job.status }
    }
  }

  // Written after the job move so the row records, as a structured field, whether THIS confirm
  // advanced the job: undo reads it back instead of guessing from the job's current status.
  auditAfter.jobAdvancedFrom = jobAdvancedFrom
  await writeAudit(trx, {
    shopId, actorId, action: 'quotation_confirmed', entityType: 'documents', entityId: documentId,
    before: {
      discount: doc.discount, offeredDiscount: doc.offered_discount,
      ...(priorSetAmounts.length > 0 ? { setLines: priorSetAmounts } : {}),
    },
    after: auditAfter,
  })

  return ok({ document: (await quotationRepo.getDocument(trx, documentId))!, jobOutcome: outcome === 'approve_job' ? 'approve_job' : 'keep_quoted', jobStatusUnchanged })
}

// -----------------------------------------------------------------------------
// Undo confirm
// -----------------------------------------------------------------------------

export async function undoConfirm(trx: ScopedTx, shopId: string, documentId: string, reason: string, actorId: string): Promise<Result<quotationRepo.DocumentRow>> {
  const locked = await lockJobThenDocument(trx, documentId)
  if (!locked) return err({ code: 'quotation_not_found' })
  const { doc, job } = locked
  if (doc.status !== 'signed') return err({ code: 'quotation_not_confirmed' })
  const lineRows = await quotationRepo.getLines(trx, documentId)
  const outcome = jobOutcomeAtConfirm(lineRows.map(decisionState))
  const check = canUndoConfirm({
    quotationStatus: 'signed', confirmedAt: doc.signed_at ?? new Date(), now: new Date(),
    jobStatus: job?.status ?? 'approved', outcome: outcome === 'keep_quoted' ? 'keep_quoted' : 'approve_job',
  })
  if (!check.ok) {
    if (check.code === 'not_signed') return err({ code: 'quotation_not_confirmed' })
    if (check.code === 'different_day') return err({ code: 'undo_confirm_different_day' })
    return err({ code: 'undo_confirm_job_moved_on' })
  }
  // The confirm's own audit row says what it did: whether it moved the job (jobAdvancedFrom) and
  // which cut sets it wrote an agreed amount to (and what they held before).
  const confirmRecord = await quotationRepo.latestConfirmAfter(trx, documentId)

  // Model A (owner ruling 14 Oct 2026): undo puts the AGREED figures back as they were before confirm.
  // Decided from the post-lock rows (doc, lineRows). The document goes first (signed -> issued carries
  // discount + approved_total, migration 0024); only then are the lines writable again.
  const restoredAmounts = agreedAmountsAfterUndo(
    lineRows.map((l) => ({ id: l.id, approvedAmount: l.approved_amount })),
    confirmRecord?.writtenLineIds ?? [], confirmRecord?.priorAmounts ?? {},
  )
  let restored: ReturnType<typeof totalsAfterUndoConfirm>
  try {
    restored = totalsAfterUndoConfirm(
      lineRows.map((l) => ({ ...toDomainLine(l), approvedAmount: restoredAmounts.get(l.id) ?? null })),
      doc.offered_discount,
    )
  } catch (e) {
    if (e instanceof MoneyError) return err({ code: 'amount_out_of_range' })
    throw e
  }
  await quotationRepo.markUnsigned(trx, documentId, restored)
  for (const l of lineRows) {
    const back = restoredAmounts.get(l.id) ?? null
    if (back !== l.approved_amount) await quotationRepo.setApprovedAmount(trx, l.id, back)
  }
  await quotationRepo.deleteOfferedItemsOfDocument(trx, documentId)
  // Only a job that confirm moved to 'approved' goes back; a job confirm left alone (D5, or before quoted) stays.
  // A confirm that found the job already approved (or not yet quoted) must not pull it back.
  if (doc.job_id && job && job.status === 'approved' && confirmRecord?.jobAdvancedFrom === 'quoted') {
    await jobsRepo.applyStatus(trx, { jobId: doc.job_id, status: 'quoted', subState: null })
    const history = await jobsRepo.recordStatusHistory(trx, shopId, doc.job_id, 'quoted', actorId)
    await writeAudit(trx, {
      shopId, actorId, action: 'job_status_changed', entityType: 'jobs', entityId: doc.job_id,
      before: { status: 'approved' }, after: { status: 'quoted', statusHistoryId: history.id },
    })
  }
  // Reason kept in audit_logs.after on purpose (see quotation_confirmed above): there is no history
  // row for a document to hold it, unlike undo-delivered.
  await writeAudit(trx, {
    shopId, actorId, action: 'quotation_confirm_undone', entityType: 'documents', entityId: documentId,
    before: { status: 'signed', discount: doc.discount, approvedTotal: doc.approved_total },
    after: { status: 'issued', reason, discount: restored.discount, approvedTotal: restored.approvedTotal },
  })
  return ok((await quotationRepo.getDocument(trx, documentId))!)
}

// -----------------------------------------------------------------------------
// Revise
// -----------------------------------------------------------------------------

export async function revise(trx: ScopedTx, shopId: string, documentId: string, actorId: string, reason?: string): Promise<Result<quotationRepo.DocumentRow>> {
  const locked = await lockJobThenDocument(trx, documentId)
  if (!locked) return err({ code: 'quotation_not_found' })
  const { doc, job } = locked
  if (doc.status !== 'issued' && doc.status !== 'signed') return err({ code: 'quotation_frozen' })
  if (!doc.job_id) return err({ code: 'job_not_found' })
  if (job && ENDED_JOB_STATUSES.includes(job.status)) return err({ code: 'job_not_open' })

  // Supersede FIRST: uq_live_quotation_per_job allows one draft/issued/signed quotation per job, so the new draft cannot exist while the old one is still live.
  await quotationRepo.markSuperseded(trx, doc.id)
  const newDoc = await quotationRepo.insertRevision(trx, {
    shopId, jobId: doc.job_id, customerId: doc.customer_id, revision: doc.revision + 1, supersedesDocumentId: doc.id,
    // Owner ruling (14 Oct 2026): rev 2's offer starts from the discount AGREED on the source.
    // On an issued source that equals its offered discount; on a signed one it is the confirmed figure.
    carriedDiscount: doc.discount,
  })
  // The superseded document's "เคยเสนอไว้" rows stay: rev 2 may never be confirmed, and a declined item may be re-added during the revision. Confirm de-duplicates instead (security M1).

  const oldLines = await quotationRepo.getLines(trx, doc.id)
  const idMap = new Map<string, string>()
  const copy = async (l: quotationRepo.LineRow, parentLineId: string | null) => {
    const [newId] = await quotationRepo.insertLines(trx, [{
      shopId, documentId: newDoc.id, parentLineId, sortOrder: l.sort_order, lineType: l.line_type, catalogItemId: l.catalog_item_id,
      nameSnapshot: l.name_snapshot, brandSnapshot: l.brand_snapshot, qty: l.qty, unit: l.unit, unitPrice: l.unit_price,
      listPrice: l.list_price, priceSource: l.price_source, priceRefId: l.price_ref_id, isVatable: l.is_vatable, lineTotal: l.line_total,
      warrantyTermId: l.warranty_term_id, warrantyName: l.warranty_name, warrantyDays: l.warranty_days, warrantyMaxKm: l.warranty_max_km,
      sourceLineId: l.id,
      // D7 / Q2: an unchanged line keeps its decision AS IT WAS (same decided_at / decided_by); changes reset it later, on edit.
      decision: l.approval_status === 'pending' ? null : {
        approvalStatus: l.approval_status, decidedAt: l.decided_at, decidedBy: l.decided_by,
        declineReason: l.decline_reason, declineNote: l.decline_note, approvedAmount: l.approved_amount,
      },
    }])
    idMap.set(l.id, newId!)
  }
  for (const l of oldLines.filter((x) => x.parent_line_id === null)) await copy(l, null)
  for (const l of oldLines.filter((x) => x.parent_line_id !== null)) {
    const newParent = idMap.get(l.parent_line_id!)
    if (newParent) await copy(l, newParent)
  }

  await writeAudit(trx, {
    shopId, actorId, action: 'quotation_revised', entityType: 'documents', entityId: newDoc.id,
    // `reason` is staff free text kept here on purpose, like the confirm adjustments: documents has no column for it.
    before: { supersedes: doc.id, reason: reason ?? null },
    // offeredDiscount = the source's own offer; carriedDiscount = what rev 2 starts from (the source's agreed one).
    after: { revision: newDoc.revision, offeredDiscount: doc.offered_discount, carriedDiscount: doc.discount },
  })
  return ok(newDoc)
}

// -----------------------------------------------------------------------------
// Void (owner only — checked by the route)
// -----------------------------------------------------------------------------

export async function voidQuotation(trx: ScopedTx, shopId: string, documentId: string, reason: string, actorId: string): Promise<Result<quotationRepo.DocumentRow>> {
  const doc = await quotationRepo.lockDocument(trx, documentId)
  if (!doc) return err({ code: 'quotation_not_found' })
  if (doc.status === 'superseded' || doc.status === 'void') return err({ code: 'quotation_frozen' })
  // A draft has no number: ck_number_when_issued forbids voiding it, and there is nothing to void.
  if (doc.status === 'draft') return err({ code: 'quotation_not_issued' })
  await quotationRepo.markVoid(trx, documentId, { reason, voidedBy: actorId })
  // The reason is staff free text kept in audit on purpose (documents has no column for it).
  await writeAudit(trx, {
    shopId, actorId, action: 'document_voided', entityType: 'documents', entityId: documentId,
    before: { status: doc.status }, after: { status: 'void', reason },
  })
  return ok((await quotationRepo.getDocument(trx, documentId))!)
}

// -----------------------------------------------------------------------------
// Job ending without a repair (Q1) — called from the job-status-change route,
// inside the SAME transaction, AFTER it locked the job row (so: jobs ->
// documents -> document_lines, CLAUDE.md §4.x) and BEFORE the job row is updated.
// -----------------------------------------------------------------------------

export type CloseCheck =
  | { action: 'none' }
  | { action: 'close'; documentId: string; documentStatusBefore: string }
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
  const live = await quotationRepo.findLiveQuotation(trx, jobId)
  if (!live) return { action: 'none' }
  // Lock the document (job is already ours), then judge the locked row, not the unlocked read.
  const doc = await quotationRepo.lockDocument(trx, live.id)
  if (!doc) return { action: 'none' }
  const lineRows = await quotationRepo.getLines(trx, doc.id)
  const plan = planQuotationClose({
    targetStatus, quotation: { status: doc.status as 'draft' | 'issued' | 'signed' | 'superseded' | 'void', lines: lineRows.map(decisionState) },
    declineReason, declineNote,
  })
  if (plan.action === 'refuse') return { action: 'refuse', code: plan.code }
  if (plan.action === 'none') return { action: 'none' }

  await quotationRepo.declinePending(trx, plan.declineLineIds, { declineReason: plan.reason!, declineNote: plan.note, decidedBy: actorId })
  // System close: void_reason = 'job_closed', voided_by = NULL (not a person pressing void).
  await quotationRepo.markVoid(trx, doc.id, { reason: 'job_closed', voidedBy: null })
  return { action: 'close', documentId: doc.id, documentStatusBefore: doc.status }
}

/**
 * The audit row for a system close. Called by the job-status route AFTER the
 * job_status_history row exists, so the cause can be named: actor_id stays NULL
 * (the system closed it, like voided_by) but after{} carries the history row id
 * and the user of the rejected/carout move — who closed the job is one join away.
 */
export async function auditClosedByJob(
  trx: ScopedTx,
  input: { shopId: string; documentId: string; documentStatusBefore: string; jobId: string; targetStatus: 'rejected' | 'carout'; statusHistoryId: string; movedBy: string },
): Promise<void> {
  await writeAudit(trx, {
    shopId: input.shopId, actorId: null, action: 'document_closed_by_job', entityType: 'documents', entityId: input.documentId,
    before: { status: input.documentStatusBefore },
    after: { status: 'void', voidReason: 'job_closed', jobId: input.jobId, targetStatus: input.targetStatus, statusHistoryId: input.statusHistoryId, movedByUserId: input.movedBy },
  })
}

/** approved -> quoted is refused while the quotation is confirmed (owner decision 8) — checked by the job-status route. */
export async function jobBackToQuotedBlocked(trx: ScopedTx, jobId: string): Promise<boolean> {
  // The unlocked read only finds WHICH document (CLAUDE.md §4.x). The job is already
  // ours, so locking the document here keeps the order jobs -> documents; the verdict
  // is then read from the locked row. Void takes the document lock without the job
  // lock, so a status read taken before this lock can be a signed quotation that was
  // voided a moment ago.
  const live = await quotationRepo.findLiveQuotation(trx, jobId)
  if (!live) return false
  const doc = await quotationRepo.lockDocument(trx, live.id)
  return blocksJobBackToQuoted((doc?.status as 'signed' | undefined) ?? null)
}

// -----------------------------------------------------------------------------
// Work order — approved lines only, no prices, served from a SIGNED quotation
// (owner Q1, 6 Oct 2026): no quotation -> quotation_missing (409); draft or
// issued -> quotation_not_confirmed (409); signed with every line declined ->
// 200 and an empty list, which is the real answer.
// -----------------------------------------------------------------------------

export async function workOrder(trx: ScopedTx, jobId: string): Promise<Result<{ job: quotationRepo.JobWithVehicleRow; lines: quotationRepo.WorkOrderLineRow[] }>> {
  const job = await quotationRepo.jobWithVehicle(trx, jobId)
  if (!job) return err({ code: 'job_not_found' })
  const doc = await quotationRepo.findLiveQuotation(trx, jobId)
  if (!doc) return err({ code: 'quotation_missing' })
  if (doc.status !== 'signed') return err({ code: 'quotation_not_confirmed' })
  const approved = await quotationRepo.getApprovedLines(trx, doc.id)
  const ids = new Set(workOrderLineIds(approved.map((l) => ({
    id: l.id, parentLineId: l.parent_line_id, approvalStatus: 'approved', declineReason: null, declineNote: null,
  }))))
  return ok({ job, lines: approved.filter((l) => ids.has(l.id)) })
}
