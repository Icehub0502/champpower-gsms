/**
 * The receipt (P3.2): build a draft from the confirmed quotation, tick what was
 * done, set the discount, take the money and close the bill in ONE transaction,
 * void it (owner), and gate "ส่งแล้ว" on it.
 *
 * Money and rules come from packages/domain (rules/receipt.ts). This file reads
 * rows, calls the domain, and writes. It never adds a baht itself.
 *
 * LOCK ORDER (CLAUDE.md s4.x): jobs -> documents (quotation, then receipt) ->
 * document_lines -> stock. Every entry point takes the JOB row first. Anything
 * read before the locks is only used to learn which row to lock; every decision
 * is made from rows read AFTER them.
 *
 * Reminder (as in services/quotation.ts): a returned error is not a throw, so the
 * request still COMMITS. Every function validates first and writes after.
 */
import {
  MoneyError, bangkokDayKey, DISCOUNT_CEILING_PERCENT, discountCeilingRefusal,
  discountExceedsCeiling, discountExceedsSubtotal, discountPercentText, formatSatang, fulfilledQtyIssue,
  isValidSubState, quoteTotals, receiptDiscount, receiptDiscountReasonRequired, receiptLineCharge,
  receiptSubtotal, receiptTotals, roleMayExceedDiscountCeiling, settlePayments, toQtyCenti, toSatang,
  workOrderLineIds, type ReceiptLineMoney,
} from '@champpower/domain'
import type { Receipt, PaymentMethod } from '@gsms/contracts/index.js'
import type { ScopedTx } from '@gsms/db/client.js'
import * as quotationRepo from '../repositories/quotation.js'
import * as jobsRepo from '../repositories/jobs.js'
import * as repo from '../repositories/receipt.js'
import { writeAudit } from './audit.js'
import { releaseUnusedReservations } from './stockHooks.js'


/** Roles that may build, tick, discount and close a receipt (CLAUDE.md s12.1 "รับเงินลูกค้า / ปิดบิล"). */
export const RECEIPT_WRITE_ROLES = ['owner', 'manager', 'assistant_manager', 'advisor'] as const
const mayWrite = (role: string) => (RECEIPT_WRITE_ROLES as readonly string[]).includes(role)

/** The job statuses a receipt can be drafted in (after the customer said yes). */
const DRAFTABLE = ['approved', 'repairing', 'aligning', 'ready', 'delivered']
/** The bill closes when the car is ready to hand over (B1: money before the keys). 'delivered' covers a delivery that predates P3.2. */
const CLOSABLE = ['ready', 'delivered']

export interface Actor { id: string; role: string }

export type ReceiptError =
  | { code: 'job_not_found' }
  | { code: 'receipt_not_found' }
  | { code: 'receipt_exists' }
  | { code: 'receipt_not_draft' }
  | { code: 'receipt_not_issued' }
  | { code: 'claim_no_receipt' }
  | { code: 'job_not_billable'; status: string }
  | { code: 'quotation_missing' }
  | { code: 'quotation_not_confirmed' }
  | { code: 'revision_pending' }
  | { code: 'quotation_inconsistent' }
  | { code: 'quotation_changed' }
  | { code: 'nothing_to_bill' }
  | { code: 'receipt_line_not_found' }
  | { code: 'invalid_request'; fields: Record<string, string[]> }
  | { code: 'fulfillment_incomplete'; lineIds: string[] }
  | { code: 'discount_entry_required' }
  | { code: 'discount_exceeds_subtotal'; max: string }
  | { code: 'discount_requires_manager'; percent: string }
  | { code: 'discount_reason_required' }
  | { code: 'payment_short'; short: string; due: string }
  | { code: 'payment_over_noncash'; over: string }
  | { code: 'payment_cash_unneeded' }
  | { code: 'already_billed'; receiptId: string; number: string }
  | { code: 'deposit_held' }

export type Result<T> = { ok: true; value: T } | { ok: false; error: ReceiptError }
const err = (error: ReceiptError): { ok: false; error: ReceiptError } => ({ ok: false, error })
const ok = <T>(value: T): { ok: true; value: T } => ({ ok: true, value })

// -----------------------------------------------------------------------------
// Row <-> domain
// -----------------------------------------------------------------------------

function moneyLines(rows: repo.ReceiptLineRow[]): ReceiptLineMoney[] {
  const parents = new Set(rows.filter((r) => r.parent_line_id !== null).map((r) => r.parent_line_id))
  return rows
    .filter((r) => r.parent_line_id === null)
    .map((r) => ({
      id: r.id, qty: r.qty, unitPrice: r.unit_price, approvedAmount: r.approved_amount,
      isSet: parents.has(r.id), fulfilledQty: r.fulfilled_qty,
    }))
}

interface Computed {
  lines: ReceiptLineMoney[]
  subtotalSatang: number
  undecided: string[]
  discountState: ReturnType<typeof receiptDiscount>
  discountSatang: number
  billTotalSatang: number
  agreedSatang: number
}

function compute(doc: repo.ReceiptDocRow, rows: repo.ReceiptLineRow[]): Computed {
  const lines = moneyLines(rows)
  const sub = receiptSubtotal(lines)
  const state = receiptDiscount({
    lines, agreedDiscount: doc.offered_discount,
    entered: doc.discount_entered_at ? doc.discount : null,
  })
  const t = receiptTotals(sub.subtotal, state.discount)
  return {
    lines, subtotalSatang: sub.subtotal, undecided: sub.undecidedLineIds, discountState: state,
    discountSatang: state.discount, billTotalSatang: t.billTotal, agreedSatang: toSatang(doc.offered_discount),
  }
}

/** Keep the draft's stored figures equal to what compute() says (they feed the daily summary of an issued one). */
async function syncDraftTotals(trx: ScopedTx, doc: repo.ReceiptDocRow, rows: repo.ReceiptLineRow[]): Promise<void> {
  const c = compute(doc, rows)
  const t = receiptTotals(c.subtotalSatang, c.discountSatang)
  await repo.writeDraftTotals(trx, doc.id, {
    subtotal: formatSatang(t.subtotal), discount: formatSatang(t.discount), billTotal: formatSatang(t.billTotal),
  })
}

// -----------------------------------------------------------------------------
// The view
// -----------------------------------------------------------------------------

interface Snapshot {
  customerName: string | null; customerPhone: string | null; plate: string | null; province: string | null
  brand: string | null; model: string | null; mileageInKm: number | null; jobNumber: string
}

function partyOf(facts: repo.JobBillingFacts): Snapshot {
  return {
    customerName: facts.customer_name, customerPhone: facts.customer_phone, plate: facts.plate,
    province: facts.province, brand: facts.brand, model: facts.model, mileageInKm: facts.mileage_in_km,
    jobNumber: facts.job_number,
  }
}

function pickParty(s: Snapshot): Snapshot {
  return {
    customerName: s.customerName, customerPhone: s.customerPhone, plate: s.plate, province: s.province,
    brand: s.brand, model: s.model, mileageInKm: s.mileageInKm, jobNumber: s.jobNumber,
  }
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null)

export async function buildView(trx: ScopedTx, doc: repo.ReceiptDocRow, facts: repo.JobBillingFacts, role: string): Promise<Receipt> {
  const rows = await repo.getReceiptLines(trx, doc.id)
  const payments = await repo.getPayments(trx, doc.id)
  const names = await repo.userNames(trx, [doc.issued_by, doc.voided_by, doc.discount_approved_by])
  const draft = doc.status === 'draft'

  // Is the quotation this draft was built from still the live, confirmed one?
  let quotationChanged = false
  let quotationNumber: string | null = null
  if (doc.source_document_id) {
    const src = await quotationRepo.getDocument(trx, doc.source_document_id)
    quotationNumber = src?.number ?? null
    if (draft && doc.job_id) {
      const live = await quotationRepo.findLiveQuotation(trx, doc.job_id)
      quotationChanged = !live || live.id !== doc.source_document_id || live.status !== 'signed'
    }
  }

  const c = compute(doc, rows)
  let subtotal: string, discountAmt: string, billTotal: string
  let baseSatang: number, discountSatang: number
  if (draft) {
    const t = receiptTotals(c.subtotalSatang, c.discountSatang)
    subtotal = formatSatang(t.subtotal); discountAmt = formatSatang(t.discount); billTotal = formatSatang(t.billTotal)
    baseSatang = t.subtotal; discountSatang = c.discountSatang
  } else {
    subtotal = doc.bill_subtotal ?? '0.00'; discountAmt = doc.discount; billTotal = doc.grand_total
    baseSatang = toSatang(subtotal); discountSatang = toSatang(discountAmt)
  }
  const exceeds = discountExceedsCeiling(baseSatang, discountSatang)
  const agreedSatang = toSatang(doc.offered_discount)
  const state = draft
    ? c.discountState.state
    : (doc.discount_entered_at ? 'entered' : (discountSatang > 0 ? 'carried' : 'none')) as 'entered' | 'carried' | 'none'
  const reasonRequired = state !== 'needs_entry'
    && receiptDiscountReasonRequired({ discountSatang, agreedDiscountSatang: agreedSatang, baseSatang })

  // Blockers - what stops "close" for THIS caller right now (the money itself is checked at close).
  const blockers: Receipt['next']['blockers'] = []
  if (draft) {
    if (!CLOSABLE.includes(facts.status)) blockers.push('job_not_ready')
    if (quotationChanged) blockers.push('quotation_changed')
    if (await repo.heldDepositOfJob(trx, doc.job_id!)) blockers.push('deposit_held')
    if (c.undecided.length > 0) blockers.push('lines_unanswered')
    if (state === 'needs_entry') blockers.push('discount_entry_required')
    if (discountExceedsSubtotal(baseSatang, discountSatang)) blockers.push('discount_exceeds_subtotal')
    if (c.undecided.length === 0 && baseSatang - Math.min(discountSatang, baseSatang) <= 0) blockers.push('nothing_to_bill')
    if (exceeds && !roleMayExceedDiscountCeiling(role)) blockers.push('discount_requires_manager')
    if (reasonRequired && !(doc.discount_reason && doc.discount_reason.trim())) blockers.push('discount_reason_required')
  }

  const lines = rows.map((r): Receipt['lines'][number] => {
    const isChild = r.parent_line_id !== null
    const isSet = !isChild && rows.some((x) => x.parent_line_id === r.id)
    const parent = isChild ? rows.find((x) => x.id === r.parent_line_id) : undefined
    const tick = isChild ? (parent?.fulfilled_qty ?? null) : r.fulfilled_qty
    let st: Receipt['lines'][number]['state'] = 'unanswered'
    if (tick !== null) {
      const f = toQtyCenti(tick)
      st = f === 0 ? 'not_done' : f === toQtyCenti(isChild ? (parent?.qty ?? r.qty) : r.qty) ? 'done' : 'partial'
    }
    let charged: string | null = null
    if (!isChild) {
      if (draft) {
        const m = c.lines.find((l) => l.id === r.id)!
        const v = receiptLineCharge(m)
        charged = v === null ? null : formatSatang(v)
      } else charged = r.line_total
    }
    return {
      id: r.id, sourceLineId: r.source_line_id, parentLineId: r.parent_line_id, isSet, sortOrder: r.sort_order,
      lineType: r.line_type as 'part' | 'labor' | 'fee', name: r.name_snapshot, brand: r.brand_snapshot,
      qty: r.qty, unit: r.unit, unitPrice: r.unit_price, approvedAmount: r.approved_amount,
      warranty: r.warranty_name ? { termId: r.warranty_term_id, name: r.warranty_name, days: r.warranty_days, maxKm: r.warranty_max_km } : null,
      fulfilledQty: isChild ? null : r.fulfilled_qty, state: st, charged,
      fulfilledAt: iso(r.fulfilled_at), fulfilledByName: r.fulfilled_by_name,
    }
  })

  const paidNet = formatSatang(payments.reduce((a, p) => a + toSatang(p.amount) - toSatang(p.change_given), 0))
  const changeTotal = formatSatang(payments.reduce((a, p) => a + toSatang(p.change_given), 0))
  const snap = (doc.receipt_snapshot as Snapshot | null) ?? null
  // The snapshot also carries closedByName for the print footer; the view's party is the strict subset.
  const party = !draft && snap ? pickParty(snap) : partyOf(facts)
  const write = mayWrite(role)

  return {
    id: doc.id, jobId: doc.job_id!, status: doc.status as Receipt['status'], number: doc.number,
    quotationId: doc.source_document_id!, quotationNumber, quotationChanged,
    party, lines,
    totals: { subtotal, discount: discountAmt, billTotal, agreedTotal: doc.approved_total },
    discount: {
      state, amount: discountAmt, agreed: doc.offered_discount, base: subtotal,
      percent: discountPercentText(baseSatang, discountSatang), exceedsCeiling: exceeds,
      ceilingPercent: DISCOUNT_CEILING_PERCENT, reason: doc.discount_reason, reasonRequired,
      approvedByName: doc.discount_approved_by ? (names.get(doc.discount_approved_by) ?? null) : null,
    },
    payments: payments.map((p) => ({
      id: p.id, method: p.method as PaymentMethod, amount: p.amount, changeGiven: p.change_given,
      net: formatSatang(toSatang(p.amount) - toSatang(p.change_given)), receivedAt: p.received_at.toISOString(),
      receivedByName: p.received_by_name, reversed: p.reversed,
    })),
    paidNet, changeTotal,
    issuedAt: iso(doc.issued_at), issuedByName: doc.issued_by ? (names.get(doc.issued_by) ?? null) : null,
    voidedAt: iso(doc.voided_at), voidReason: doc.void_reason,
    voidedByName: doc.voided_by ? (names.get(doc.voided_by) ?? null) : null,
    taxInvoiceRequested: facts.tax_invoice_requested,
    next: {
      canTick: draft && write && !quotationChanged,
      canEditDiscount: draft && write && !quotationChanged,
      canClose: draft && write && blockers.length === 0,
      blockers,
      unansweredLineIds: draft ? c.undecided : [],
      canApproveOverCeiling: roleMayExceedDiscountCeiling(role),
      canVoid: doc.status === 'issued' && role === 'owner',
    },
  }
}

export async function getView(trx: ScopedTx, jobId: string, role: string): Promise<Result<Receipt>> {
  const facts = await repo.jobBillingFacts(trx, jobId)
  if (!facts) return err({ code: 'job_not_found' })
  const doc = await repo.findReceiptOfJob(trx, jobId)
  if (!doc) return err({ code: 'receipt_not_found' })
  return ok(await buildView(trx, doc, facts, role))
}

// -----------------------------------------------------------------------------
// Build the draft from the quotation
// -----------------------------------------------------------------------------

interface QuotationForReceipt {
  doc: quotationRepo.DocumentRow
  lines: quotationRepo.LineRow[]
}

/** The job's confirmed quotation, judged AFTER locking it. Job is already locked by the caller. */
async function lockConfirmedQuotation(trx: ScopedTx, jobId: string): Promise<Result<QuotationForReceipt>> {
  const live0 = await quotationRepo.findLiveQuotation(trx, jobId)
  if (!live0) return err({ code: 'quotation_missing' })
  const doc = await quotationRepo.lockDocument(trx, live0.id)
  if (!doc) return err({ code: 'quotation_missing' })
  if (doc.status !== 'signed') {
    // A newer revision that nobody has confirmed yet (AC-B9) is a different problem from "never confirmed".
    return err({ code: doc.supersedes_document_id ? 'revision_pending' : 'quotation_not_confirmed' })
  }
  const lines = await quotationRepo.getLines(trx, doc.id)
  // E-5: refuse a quotation whose stored approved_total does not foot, rather than bill a wrong sum.
  try {
    const t = quoteTotals(lines.map((r) => ({
      id: r.id, parentLineId: r.parent_line_id, qty: r.qty, unitPrice: r.unit_price,
      approvalStatus: r.approval_status as 'pending' | 'approved' | 'declined', approvedAmount: r.approved_amount,
    })), doc.discount)
    if (t.approvedTotal !== toSatang(doc.approved_total)) return err({ code: 'quotation_inconsistent' })
  } catch (e) {
    if (e instanceof MoneyError) return err({ code: 'quotation_inconsistent' })
    throw e
  }
  return ok({ doc, lines })
}

interface Carry { qty: string; by: string | null }

async function insertDraftFrom(
  trx: ScopedTx,
  shopId: string,
  facts: repo.JobBillingFacts,
  q: QuotationForReceipt,
  carry: Map<string, Carry>,
): Promise<Result<string>> {
  const decision = q.lines.map((l) => ({
    id: l.id, parentLineId: l.parent_line_id, approvalStatus: l.approval_status as 'approved' | 'pending' | 'declined',
    declineReason: null, declineNote: null,
  }))
  const keep = new Set(workOrderLineIds(decision))
  const src = (await repo.getSourceLines(trx, q.doc.id)).filter((l) => keep.has(l.id))
  const tops = src.filter((l) => l.parent_line_id === null)
  if (tops.length === 0) return err({ code: 'nothing_to_bill' })

  const id = await repo.insertDraftReceipt(trx, {
    shopId, jobId: facts.id, customerId: facts.customer_id, quotationId: q.doc.id,
    agreedDiscount: q.doc.discount, approvedTotal: q.doc.approved_total,
  })
  const newIds = new Map<string, string>()
  let order = 0
  for (const h of tops) {
    const c = carry.get(h.id)
    newIds.set(h.id, await repo.insertReceiptLine(trx, {
      shopId, documentId: id, parentLineId: null, src: h, sortOrder: order++,
      fulfilledQty: c?.qty ?? null, fulfilledBy: c?.by ?? null,
    }))
  }
  for (const ch of src.filter((l) => l.parent_line_id !== null)) {
    await repo.insertReceiptLine(trx, {
      shopId, documentId: id, parentLineId: newIds.get(ch.parent_line_id!)!, src: ch, sortOrder: order++,
    })
  }
  // Carried ticks must price the lines; recompute totals from what is now stored.
  const doc = (await repo.getReceipt(trx, id))!
  const rows = await repo.getReceiptLines(trx, id)
  for (const r of rows) {
    if (r.parent_line_id === null && r.fulfilled_qty !== null) {
      const m = moneyLines(rows).find((l) => l.id === r.id)!
      await repo.writeLineTotal(trx, r.id, formatSatang(receiptLineCharge(m) ?? 0))
    }
  }
  await syncDraftTotals(trx, doc, await repo.getReceiptLines(trx, id))
  return ok(id)
}

export async function createDraft(
  trx: ScopedTx, shopId: string, jobId: string, actor: Actor,
): Promise<Result<{ receiptId: string; created: boolean }>> {
  const facts = await repo.jobBillingFacts(trx, jobId, { lock: true })
  if (!facts) return err({ code: 'job_not_found' })
  if (facts.job_type === 'warranty_claim') return err({ code: 'claim_no_receipt' })

  const existing = await repo.findReceiptOfJob(trx, jobId)
  if (existing && existing.status === 'issued') {
    return err({ code: 'already_billed', receiptId: existing.id, number: existing.number! })
  }
  if (existing && existing.status === 'draft') return ok({ receiptId: existing.id, created: false })

  if (!DRAFTABLE.includes(facts.status)) return err({ code: 'job_not_billable', status: facts.status })
  const q = await lockConfirmedQuotation(trx, jobId)
  if (!q.ok) return q
  const made = await insertDraftFrom(trx, shopId, facts, q.value, new Map())
  if (!made.ok) return made
  await writeAudit(trx, {
    shopId, actorId: actor.id, action: 'receipt_draft_created', entityType: 'documents', entityId: made.value,
    after: { jobId, quotationId: q.value.doc.id },
  })
  return ok({ receiptId: made.value, created: true })
}

/** Throw away the draft and rebuild it from the (new) confirmed quotation, keeping ticks on lines that did not change. */
export async function rebuildDraft(trx: ScopedTx, shopId: string, jobId: string, actor: Actor): Promise<Result<string>> {
  const facts = await repo.jobBillingFacts(trx, jobId, { lock: true })
  if (!facts) return err({ code: 'job_not_found' })
  const q = await lockConfirmedQuotation(trx, jobId)
  if (!q.ok) return q
  const found = await repo.findReceiptOfJob(trx, jobId)
  if (!found) return err({ code: 'receipt_not_found' })
  const doc = await repo.lockReceipt(trx, found.id)
  if (!doc || doc.status !== 'draft') return err({ code: 'receipt_not_draft' })

  const oldRows = await repo.getReceiptLines(trx, doc.id, { lock: true })
  const newSrc = await repo.getSourceLines(trx, q.value.doc.id)
  const carry = new Map<string, Carry>()
  for (const n of newSrc) {
    if (n.parent_line_id !== null || !n.source_line_id) continue
    const o = oldRows.find((r) => r.parent_line_id === null && r.source_line_id === n.source_line_id && r.fulfilled_qty !== null)
    if (!o) continue
    const same = o.qty === n.qty && o.unit_price === n.unit_price && o.name_snapshot === n.name_snapshot
      && o.approved_amount === n.approved_amount
    if (same && toQtyCenti(o.fulfilled_qty!) <= toQtyCenti(n.qty)) carry.set(n.id, { qty: o.fulfilled_qty!, by: o.fulfilled_by })
  }
  await repo.deleteDraftReceipt(trx, doc.id)
  const made = await insertDraftFrom(trx, shopId, facts, q.value, carry)
  if (!made.ok) return made
  await writeAudit(trx, {
    shopId, actorId: actor.id, action: 'receipt_draft_rebuilt', entityType: 'documents', entityId: made.value,
    before: { replacedReceiptId: doc.id }, after: { quotationId: q.value.doc.id, carriedTicks: carry.size },
  })
  return ok(made.value)
}

// -----------------------------------------------------------------------------
// Draft edits: ticks and the discount
// -----------------------------------------------------------------------------

/** Job -> quotation(confirmed, unchanged) -> receipt(draft) -> lines, all locked, for a draft edit. */
async function lockDraftForEdit(trx: ScopedTx, jobId: string) {
  const facts = await repo.jobBillingFacts(trx, jobId, { lock: true })
  if (!facts) return err({ code: 'job_not_found' as const })
  const found = await repo.findReceiptOfJob(trx, jobId)
  if (!found) return err({ code: 'receipt_not_found' as const })
  // The quotation first (lock order), judged after its lock.
  const live = await quotationRepo.findLiveQuotation(trx, jobId)
  const liveLocked = live ? await quotationRepo.lockDocument(trx, live.id) : undefined
  const doc = await repo.lockReceipt(trx, found.id)
  if (!doc) return err({ code: 'receipt_not_found' as const })
  if (doc.status !== 'draft') return err({ code: 'receipt_not_draft' as const })
  if (!liveLocked || liveLocked.id !== doc.source_document_id || liveLocked.status !== 'signed') {
    return err({ code: 'quotation_changed' as const })
  }
  const rows = await repo.getReceiptLines(trx, doc.id, { lock: true })
  return ok({ facts, doc, rows })
}

export async function setFulfillment(
  trx: ScopedTx, shopId: string, jobId: string, actor: Actor,
  entries: ReadonlyArray<{ lineId: string; fulfilledQty: string }>,
): Promise<Result<void>> {
  const l = await lockDraftForEdit(trx, jobId)
  if (!l.ok) return l
  const { doc, rows } = l.value
  const money = moneyLines(rows)

  // Validate everything before writing anything.
  const fields: Record<string, string[]> = {}
  const seen = new Set<string>()
  entries.forEach((e, i) => {
    const m = money.find((x) => x.id === e.lineId)
    if (!m || seen.has(e.lineId)) { (fields[`lines.${i}.lineId`] ??= []).push('unknown_line'); return }
    seen.add(e.lineId)
    const issue = fulfilledQtyIssue(m, e.fulfilledQty)
    if (issue) (fields[`lines.${i}.fulfilledQty`] ??= []).push(issue)
  })
  if (Object.keys(fields).length > 0) return err({ code: 'invalid_request', fields })

  const before: Array<{ lineId: string; fulfilledQty: string | null }> = []
  const after: Array<{ lineId: string; fulfilledQty: string }> = []
  for (const e of entries) {
    const m = money.find((x) => x.id === e.lineId)!
    const qty = formatSatang(toQtyCenti(e.fulfilledQty)) // canonical "n.nn"
    const charge = receiptLineCharge({ ...m, fulfilledQty: qty })!
    await repo.writeTick(trx, e.lineId, { fulfilledQty: qty, lineTotal: formatSatang(charge), by: actor.id })
    before.push({ lineId: e.lineId, fulfilledQty: m.fulfilledQty })
    after.push({ lineId: e.lineId, fulfilledQty: qty })
  }
  await syncDraftTotals(trx, doc, await repo.getReceiptLines(trx, doc.id))
  await writeAudit(trx, {
    shopId, actorId: actor.id, action: 'receipt_lines_ticked', entityType: 'documents', entityId: doc.id,
    before: { lines: before }, after: { lines: after },
  })
  return ok(undefined)
}

export async function patchDraft(
  trx: ScopedTx, shopId: string, jobId: string, actor: Actor,
  p: { discount?: string; discountReason?: string },
): Promise<Result<void>> {
  const l = await lockDraftForEdit(trx, jobId)
  if (!l.ok) return l
  const { doc, rows } = l.value
  const c = compute(doc, rows)
  let discountText: string | undefined
  if (p.discount !== undefined) {
    let d: number
    try { d = toSatang(p.discount) } catch (e) {
      if (e instanceof MoneyError) return err({ code: 'invalid_request', fields: { discount: ['invalid_money'] } })
      throw e
    }
    if (discountExceedsSubtotal(c.subtotalSatang, d)) return err({ code: 'discount_exceeds_subtotal', max: formatSatang(c.subtotalSatang) })
    discountText = formatSatang(d)
  }
  await repo.writeDraftDiscount(trx, doc.id, { discount: discountText, reason: p.discountReason })
  await syncDraftTotals(trx, (await repo.getReceipt(trx, doc.id))!, rows)
  // The reason is staff free text kept in audit on purpose (documents has a column too; the audit
  // row is what the owner reads). Same decision as quotation confirm (services/quotation.ts).
  await writeAudit(trx, {
    shopId, actorId: actor.id, action: 'receipt_discount_set', entityType: 'documents', entityId: doc.id,
    before: { discount: doc.discount, state: c.discountState.state },
    after: { discount: discountText ?? null, reason: p.discountReason ?? null, base: formatSatang(c.subtotalSatang) },
  })
  return ok(undefined)
}

// -----------------------------------------------------------------------------
// Close the bill and issue the receipt - ONE transaction
// -----------------------------------------------------------------------------

export interface CloseOutcome { receiptId: string; change: string; unreservedLines: number; replayed: boolean }

export async function closeBill(
  trx: ScopedTx, shopId: string, jobId: string, actor: Actor,
  input: { payments: ReadonlyArray<{ method: PaymentMethod; amount: string }>; discountReason?: string },
): Promise<Result<CloseOutcome>> {
  // 1. JOB.
  const facts = await repo.jobBillingFacts(trx, jobId, { lock: true })
  if (!facts) return err({ code: 'job_not_found' })
  if (facts.job_type === 'warranty_claim') return err({ code: 'claim_no_receipt' })

  const found = await repo.findReceiptOfJob(trx, jobId)
  if (!found) return err({ code: 'receipt_not_found' })

  // Retry of a close that already went through (AC-E3): same payments -> the same answer.
  if (found.status === 'issued') {
    const paid = await repo.getPayments(trx, found.id)
    const norm = (xs: ReadonlyArray<{ method: string; amount: string }>) =>
      xs.map((x) => `${x.method}:${formatSatang(toSatang(x.amount))}`).sort().join('|')
    if (norm(paid) === norm(input.payments)) {
      return ok({
        receiptId: found.id, replayed: true, unreservedLines: 0,
        change: formatSatang(paid.reduce((a, p) => a + toSatang(p.change_given), 0)),
      })
    }
    return err({ code: 'already_billed', receiptId: found.id, number: found.number! })
  }
  if (found.status !== 'draft') return err({ code: 'receipt_not_draft' })

  // 2. DOCUMENTS: quotation, then receipt; both judged after their locks.
  const live = await quotationRepo.findLiveQuotation(trx, jobId)
  const liveLocked = live ? await quotationRepo.lockDocument(trx, live.id) : undefined
  const doc = await repo.lockReceipt(trx, found.id)
  if (!doc) return err({ code: 'receipt_not_found' })
  if (doc.status === 'issued') return err({ code: 'already_billed', receiptId: doc.id, number: doc.number! })
  if (doc.status !== 'draft') return err({ code: 'receipt_not_draft' })
  if (!liveLocked || liveLocked.id !== doc.source_document_id) {
    return err({ code: liveLocked && liveLocked.status !== 'signed' ? 'revision_pending' : 'quotation_changed' })
  }
  if (liveLocked.status !== 'signed') return err({ code: 'quotation_changed' })

  // 3. LINES.
  const rows = await repo.getReceiptLines(trx, doc.id, { lock: true })

  // ---- decide, from the locked rows only ----
  if (!CLOSABLE.includes(facts.status)) return err({ code: 'job_not_billable', status: facts.status })
  const c = compute(doc, rows)
  if (c.undecided.length > 0) return err({ code: 'fulfillment_incomplete', lineIds: c.undecided })
  if (c.discountState.state === 'needs_entry') return err({ code: 'discount_entry_required' })
  if (discountExceedsSubtotal(c.subtotalSatang, c.discountSatang)) {
    return err({ code: 'discount_exceeds_subtotal', max: formatSatang(c.subtotalSatang) })
  }
  const totals = receiptTotals(c.subtotalSatang, c.discountSatang)
  if (totals.billTotal <= 0) return err({ code: 'nothing_to_bill' })

  // B2 (DEFAULT pending Ice, P3.2 B2): no deposit offset in P3.2.
  if (await repo.heldDepositOfJob(trx, jobId)) return err({ code: 'deposit_held' })

  const reason = (input.discountReason ?? doc.discount_reason ?? '').trim() || null
  // B4 (DEFAULT pending Ice, P3.2 B4): the ceiling is judged on the final discount, by the closer.
  const refusal = discountCeilingRefusal({ baseSatang: totals.subtotal, discountSatang: totals.discount, role: actor.role, reason })
  if (refusal === 'discount_requires_manager') return err({ code: 'discount_requires_manager', percent: discountPercentText(totals.subtotal, totals.discount) })
  if (refusal === 'discount_reason_required') return err({ code: 'discount_reason_required' })
  // A-10: any departure from the agreed discount is explained.
  if (!reason && receiptDiscountReasonRequired({ discountSatang: totals.discount, agreedDiscountSatang: c.agreedSatang, baseSatang: totals.subtotal })) {
    return err({ code: 'discount_reason_required' })
  }
  const exceeds = discountExceedsCeiling(totals.subtotal, totals.discount)

  const settled = settlePayments(totals.billTotal, input.payments)
  if (!settled.ok) {
    switch (settled.code) {
      case 'payment_short': return err({ code: 'payment_short', short: settled.short, due: formatSatang(totals.billTotal) })
      case 'payment_over_noncash': return err({ code: 'payment_over_noncash', over: settled.over })
      case 'payment_cash_unneeded': return err({ code: 'payment_cash_unneeded' })
      case 'payment_invalid': return err({ code: 'invalid_request', fields: { [`payments.${settled.field}`]: ['invalid'] } })
    }
  }

  // ---- write ----
  // Final per-line charge, so the frozen line_total equals what the domain says.
  for (const r of rows) {
    if (r.parent_line_id !== null) continue
    const m = c.lines.find((l) => l.id === r.id)!
    await repo.writeLineTotal(trx, r.id, formatSatang(receiptLineCharge(m) ?? 0))
  }
  // Allocated as late as possible, inside this transaction: a failure above or below leaves no gap.
  const number = await repo.allocateReceiptNumber(trx, shopId)
  const now = new Date()
  const names = await repo.userNames(trx, [actor.id])
  await repo.markReceiptIssued(trx, doc.id, {
    number, numberedOn: bangkokDayKey(now), issuedBy: actor.id, issuedAt: now,
    subtotal: formatSatang(totals.subtotal), discount: formatSatang(totals.discount),
    billTotal: formatSatang(totals.billTotal), discountReason: reason,
    discountApprovedBy: exceeds ? actor.id : null,
    snapshot: { ...partyOf(facts), closedByName: names.get(actor.id) ?? null },
  })
  for (const p of settled.rows) {
    await repo.insertPayment(trx, {
      shopId, documentId: doc.id, method: p.method, amount: p.amount, changeGiven: p.changeGiven,
      receivedBy: actor.id, receivedAt: now,
    })
  }
  // 4. STOCK (last in the lock order). Lines approved but not done go back to available.
  const notDone = rows.filter((r) => r.parent_line_id === null && toQtyCenti(r.fulfilled_qty!) < toQtyCenti(r.qty))
  const unreserved = await releaseUnusedReservations(trx, {
    shopId, receiptId: doc.id, actorId: actor.id,
    lines: notDone.map((r) => ({ lineId: r.id, sourceLineId: r.source_line_id, skuId: r.sku_id, qty: r.qty, fulfilledQty: r.fulfilled_qty! })),
  })
  // The board card says "ชำระแล้ว" where that label is valid for the job's status.
  if (isValidSubState(facts.status, 'paid') && facts.sub_state !== 'paid') {
    await jobsRepo.setSubState(trx, jobId, 'paid')
  }
  await writeAudit(trx, {
    shopId, actorId: actor.id, action: 'receipt_issued', entityType: 'documents', entityId: doc.id,
    before: { status: 'draft' },
    after: {
      number, jobId, subtotal: formatSatang(totals.subtotal), discount: formatSatang(totals.discount),
      percent: discountPercentText(totals.subtotal, totals.discount), billTotal: formatSatang(totals.billTotal),
      agreedDiscount: doc.offered_discount, agreedTotal: doc.approved_total,
      discountReason: reason, overCeiling: exceeds,
      payments: settled.rows.map((p) => ({ method: p.method, amount: p.amount, change: p.changeGiven })),
      notDoneLineIds: notDone.map((r) => r.id), unreservedLines: unreserved,
    },
  })
  return ok({ receiptId: doc.id, change: settled.change, unreservedLines: unreserved, replayed: false })
}

// -----------------------------------------------------------------------------
// Void (owner only - checked at the route and again here)
// DEFAULT pending Ice (P3.2 B6): owner only, per CLAUDE.md s12.1; no same-day manager exception.
// -----------------------------------------------------------------------------

export async function voidReceipt(
  trx: ScopedTx, shopId: string, jobId: string, actor: Actor, reason: string,
): Promise<Result<void>> {
  if (actor.role !== 'owner') throw new Error('voidReceipt called without the owner role')
  const facts = await repo.jobBillingFacts(trx, jobId, { lock: true })
  if (!facts) return err({ code: 'job_not_found' })
  const found = await repo.findReceiptOfJob(trx, jobId)
  if (!found || found.status === 'draft') return err({ code: found ? 'receipt_not_issued' : 'receipt_not_found' })
  const doc = await repo.lockReceipt(trx, found.id)
  if (!doc || doc.status !== 'issued') return err({ code: 'receipt_not_issued' })

  const payments = await repo.getPayments(trx, doc.id)
  const reversals: Array<{ paymentId: string; method: string; amount: string }> = []
  for (const p of payments) {
    if (p.reversed) continue
    const net = formatSatang(toSatang(p.amount) - toSatang(p.change_given))
    await repo.insertReversal(trx, { shopId, paymentId: p.id, documentId: doc.id, method: p.method, amount: net, reason, by: actor.id })
    reversals.push({ paymentId: p.id, method: p.method, amount: net })
  }
  await repo.markReceiptVoid(trx, doc.id, { reason, voidedBy: actor.id })
  if (facts.sub_state === 'paid') await jobsRepo.setSubState(trx, jobId, null)
  await writeAudit(trx, {
    shopId, actorId: actor.id, action: 'receipt_voided', entityType: 'documents', entityId: doc.id,
    before: { status: 'issued', number: doc.number, billTotal: doc.grand_total },
    after: { status: 'void', reason, reversals },
  })
  return ok(undefined)
}

// -----------------------------------------------------------------------------
// Tax-invoice request flag (DEFAULT pending Ice, P3.2 B8) - a flag, no tax invoice
// -----------------------------------------------------------------------------

export async function setTaxInvoiceRequest(
  trx: ScopedTx, shopId: string, jobId: string, actor: Actor, requested: boolean,
): Promise<Result<{ requested: boolean; at: Date | null; byName: string | null }>> {
  const facts = await repo.jobBillingFacts(trx, jobId, { lock: true })
  if (!facts) return err({ code: 'job_not_found' })
  if (facts.tax_invoice_requested !== requested) {
    await repo.setTaxInvoiceRequested(trx, jobId, { requested, by: actor.id })
    await writeAudit(trx, {
      shopId, actorId: actor.id, action: 'tax_invoice_request_set', entityType: 'jobs', entityId: jobId,
      before: { requested: facts.tax_invoice_requested }, after: { requested },
    })
  }
  const names = await repo.userNames(trx, [actor.id])
  return ok({ requested, at: requested ? new Date() : null, byName: requested ? (names.get(actor.id) ?? null) : null })
}

// -----------------------------------------------------------------------------
// Gates used by the job status route (B1)
// -----------------------------------------------------------------------------

export type DeliveryGate =
  | { ok: true; waivedBy: 'receipt' | 'claim' | 'no_bill_reason' }
  | { ok: false; code: 'receipt_required'; nothingToBill: boolean }

/**
 * May this job move to 'delivered'? (DEFAULT pending Ice, P3.2 B1.) The caller holds the job lock.
 * A normal job needs an ISSUED receipt. Exempt: warranty claims. Escape hatch: a job with
 * nothing to bill (confirmed quotation approves 0, or the draft bills 0, or there is no
 * quotation at all) may be delivered with a written reason.
 */
export async function deliveryGate(trx: ScopedTx, jobId: string, noReceiptReason: string | undefined): Promise<DeliveryGate> {
  const facts = await repo.jobBillingFacts(trx, jobId)
  if (facts?.job_type === 'warranty_claim') return { ok: true, waivedBy: 'claim' }
  const receipt = await repo.findReceiptOfJob(trx, jobId)
  if (receipt?.status === 'issued') return { ok: true, waivedBy: 'receipt' }

  let nothingToBill = false
  if (receipt?.status === 'draft') {
    const c = compute(receipt, await repo.getReceiptLines(trx, receipt.id))
    nothingToBill = c.undecided.length === 0 && c.billTotalSatang <= 0
  } else {
    const live = await quotationRepo.findLiveQuotation(trx, jobId)
    nothingToBill = !live || (live.status === 'signed' && toSatang(live.approved_total) <= 0)
  }
  if (nothingToBill && noReceiptReason && noReceiptReason.trim()) return { ok: true, waivedBy: 'no_bill_reason' }
  return { ok: false, code: 'receipt_required', nothingToBill }
}

/** delivered -> ready is refused while a receipt stands (AC-E8). Job lock held by the caller. */
export async function issuedReceiptOfJob(trx: ScopedTx, jobId: string): Promise<boolean> {
  const r = await repo.findReceiptOfJob(trx, jobId)
  return r?.status === 'issued'
}
