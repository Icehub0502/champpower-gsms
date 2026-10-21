/**
 * The receipt (P3.2): build a draft from the confirmed quotation, tick what was
 * done, discount lines and the bill, SHOW THE BILL TO THE CUSTOMER, take the money
 * and close the bill in ONE transaction, void it (owner), and gate "ส่งแล้ว" on it.
 *
 * Money and rules come from packages/domain (rules/receipt.ts, receiptBill.ts).
 * This file reads rows, calls the domain, and writes. It never adds a baht itself.
 *
 * LOCK ORDER (CLAUDE.md s4.x): jobs -> documents (quotation, then receipt) ->
 * document_lines -> stock. Every entry point takes the JOB row first. Anything
 * read before the locks is only used to learn which row to lock; every decision
 * is made from rows read AFTER them.
 *
 * Reminder (as in services/quotation.ts): a returned error is not a throw, so the
 * request still COMMITS. Every function validates first and writes after.
 */
import { createHash } from 'node:crypto'
import {
  MoneyError, bangkokDayKey, DISCOUNT_CEILING_PERCENT, discountCeilingRefusal, discountExceedsCeiling,
  discountExceedsSubtotal, discountPercentText, formatSatang, fulfilledQtyIssue, isValidSubState,
  depositOffsetPlan, quoteTotals, receiptDiscount, receiptDiscountReasonRequired, receiptLineCharge, receiptLineDiscountIssue,
  receiptLineNet, receiptSubtotal, receiptTotals, roleMayExceedDiscountCeiling, settlePayments,
  toQtyCenti, toSatang, workOrderLineIds, type ReceiptLineMoney,
} from '@champpower/domain'
import type { Receipt, PaymentMethod } from '@gsms/contracts/index.js'
import type { ScopedTx } from '@gsms/db/client.js'
import * as quotationRepo from '../repositories/quotation.js'
import * as jobsRepo from '../repositories/jobs.js'
import * as repo from '../repositories/receipt.js'
import * as channelsRepo from '../repositories/channels.js'
import * as depositsRepo from '../repositories/deposits.js'
import { writeAudit } from './audit.js'
import { warningsOfJob } from './deposits.js'
import { releaseUnusedReservations } from './stockHooks.js'

/** Roles that may build, tick, discount, present and close a receipt (CLAUDE.md s12.1 "รับเงินลูกค้า / ปิดบิล"). */
export const RECEIPT_WRITE_ROLES = ['owner', 'manager', 'assistant_manager', 'advisor'] as const
const mayWrite = (role: string) => (RECEIPT_WRITE_ROLES as readonly string[]).includes(role)

/** The job statuses a receipt can be drafted in (after the customer said yes). */
const DRAFTABLE = ['approved', 'repairing', 'aligning', 'ready', 'delivered']
/** The bill closes when the car is ready to hand over (Ice 20 Oct B1: money before the keys). 'delivered' covers a delivery that predates P3.2. */
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
  | { code: 'bill_not_presented' }
  | { code: 'presentation_stale' }
  | { code: 'channel_not_found' }
  | { code: 'channel_inactive' }
  | { code: 'payment_short'; short: string; due: string }
  | { code: 'payment_over_noncash'; over: string }
  | { code: 'payment_cash_unneeded' }
  | { code: 'already_billed'; receiptId: string; number: string }
  // P3.3: offsetting deposits at close.
  | { code: 'deposit_not_found' }
  | { code: 'deposit_not_held'; status: string }
  | { code: 'deposit_not_attached' }
  | { code: 'deposit_exceeds_bill'; over: string; max: string }
  | { code: 'payment_not_needed' }

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
      isSet: parents.has(r.id), fulfilledQty: r.fulfilled_qty, lineDiscount: r.line_discount,
    }))
}

interface Computed {
  lines: ReceiptLineMoney[]
  subtotalSatang: number
  lineDiscountSatang: number
  undecided: string[]
  discountState: ReturnType<typeof receiptDiscount>
  /** The document-level discount applied. */
  discountSatang: number
  /** Line discounts + document discount: what the 40% ceiling is measured on. */
  totalDiscountSatang: number
  billTotalSatang: number
  agreedSatang: number
  /** Typed document discount larger than what is left after the line discounts. */
  discountTooBig: boolean
}

function compute(doc: repo.ReceiptDocRow, rows: repo.ReceiptLineRow[]): Computed {
  const lines = moneyLines(rows)
  const sub = receiptSubtotal(lines)
  const state = receiptDiscount({
    lines, agreedDiscount: doc.offered_discount,
    entered: doc.discount_entered_at ? doc.discount : null,
  })
  const t = receiptTotals(sub.subtotal, sub.lineDiscountTotal, state.discount)
  return {
    lines, subtotalSatang: sub.subtotal, lineDiscountSatang: sub.lineDiscountTotal, undecided: sub.undecidedLineIds,
    discountState: state, discountSatang: t.discount, totalDiscountSatang: t.totalDiscount,
    billTotalSatang: t.billTotal, agreedSatang: toSatang(doc.offered_discount),
    discountTooBig: discountExceedsSubtotal(sub.subtotal - sub.lineDiscountTotal, state.discount),
  }
}

/** Keep the draft's stored figures equal to what compute() says (they feed the daily summary once issued). */
async function syncDraftTotals(trx: ScopedTx, doc: repo.ReceiptDocRow, rows: repo.ReceiptLineRow[]): Promise<void> {
  const c = compute(doc, rows)
  await repo.writeDraftTotals(trx, doc.id, {
    subtotal: formatSatang(c.subtotalSatang), discount: formatSatang(c.discountSatang), billTotal: formatSatang(c.billTotalSatang),
  })
}

/**
 * What the customer was shown depends on exactly this: every tick, every line
 * discount, the document discount and the resulting totals. Any change makes the
 * stored hash differ, so the presentation goes stale by itself (Ice 20 Oct, B1).
 */
function presentationHash(c: Computed, rows: repo.ReceiptLineRow[]): string {
  const tops = rows.filter((r) => r.parent_line_id === null)
    .map((r) => [r.id, r.fulfilled_qty, formatSatang(toSatang(r.line_discount))])
  return createHash('sha256').update(JSON.stringify({
    l: tops, d: c.discountSatang, s: c.subtotalSatang, ld: c.lineDiscountSatang, t: c.billTotalSatang,
  })).digest('hex')
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
  // Deposit offsets are payments rows too (method deposit_offset) but they are not money taken on this
  // receipt: they are shown apart, in `deposits.applied`.
  const payments = (await repo.getPayments(trx, doc.id)).filter((p) => p.method !== 'deposit_offset')
  const offsets = await depositsRepo.offsetsOfReceipt(trx, doc.id)
  const names = await repo.userNames(trx, [doc.issued_by, doc.voided_by, doc.discount_approved_by, doc.presented_by])
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
  let baseSatang: number, discountSatang: number, lineDiscountSatang: number
  if (draft) {
    subtotal = formatSatang(c.subtotalSatang); discountAmt = formatSatang(c.discountSatang); billTotal = formatSatang(c.billTotalSatang)
    baseSatang = c.subtotalSatang; discountSatang = c.discountSatang; lineDiscountSatang = c.lineDiscountSatang
  } else {
    subtotal = doc.bill_subtotal ?? '0.00'; discountAmt = doc.discount; billTotal = doc.grand_total
    baseSatang = toSatang(subtotal); discountSatang = toSatang(discountAmt)
    lineDiscountSatang = rows.filter((r) => r.parent_line_id === null).reduce((a, r) => a + toSatang(r.line_discount), 0)
  }
  const totalDiscountSatang = discountSatang + lineDiscountSatang
  const exceeds = discountExceedsCeiling(baseSatang, totalDiscountSatang)
  const agreedSatang = toSatang(doc.offered_discount)
  const state = draft
    ? c.discountState.state
    : (doc.discount_entered_at ? 'entered' : (discountSatang > 0 ? 'carried' : 'none')) as 'entered' | 'carried' | 'none'
  const reasonRequired = state !== 'needs_entry'
    && receiptDiscountReasonRequired({ discountSatang, agreedDiscountSatang: agreedSatang, baseSatang, totalDiscountSatang })

  // Presentation (Ice 20 Oct, B1).
  const currentHash = draft ? presentationHash(c, rows) : doc.presented_hash
  const presentationValid = !!doc.presented_at && doc.presented_hash === currentHash

  // Blockers - what stops "close" for THIS caller right now (the money itself is checked at close).
  const blockers: Receipt['next']['blockers'] = []
  let presentable = true
  if (draft) {
    const hard = (b: Receipt['next']['blockers'][number]) => { blockers.push(b); presentable = false }
    if (!CLOSABLE.includes(facts.status)) blockers.push('job_not_ready')
    if (quotationChanged) hard('quotation_changed')
    if (c.undecided.length > 0) hard('lines_unanswered')
    if (state === 'needs_entry') hard('discount_entry_required')
    if (c.discountTooBig) hard('discount_exceeds_subtotal')
    if (c.undecided.length === 0 && c.billTotalSatang <= 0) hard('nothing_to_bill')
    if (exceeds && !roleMayExceedDiscountCeiling(role)) blockers.push('discount_requires_manager')
    if (reasonRequired && !(doc.discount_reason && doc.discount_reason.trim())) blockers.push('discount_reason_required')
    if (!doc.presented_at) blockers.push('bill_not_presented')
    else if (!presentationValid) blockers.push('presentation_stale')
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
    let net: string | null = null
    if (!isChild) {
      if (draft) {
        const m = c.lines.find((l) => l.id === r.id)!
        const g = receiptLineCharge(m)
        const n = receiptLineNet(m)
        charged = g === null ? null : formatSatang(g)
        net = n === null ? null : formatSatang(n)
      } else {
        charged = r.line_total
        net = formatSatang(toSatang(r.line_total) - toSatang(r.line_discount))
      }
    }
    return {
      id: r.id, sourceLineId: r.source_line_id, parentLineId: r.parent_line_id, isSet, sortOrder: r.sort_order,
      lineType: r.line_type as 'part' | 'labor' | 'fee', name: r.name_snapshot, brand: r.brand_snapshot,
      qty: r.qty, unit: r.unit, unitPrice: r.unit_price, approvedAmount: r.approved_amount,
      warranty: r.warranty_name ? { termId: r.warranty_term_id, name: r.warranty_name, days: r.warranty_days, maxKm: r.warranty_max_km } : null,
      fulfilledQty: isChild ? null : r.fulfilled_qty, state: st, charged,
      discount: isChild ? '0.00' : r.line_discount, discountReason: isChild ? null : r.line_discount_reason, net,
      fulfilledAt: iso(r.fulfilled_at), fulfilledByName: r.fulfilled_by_name,
    }
  })

  // ---- Deposits (P3.3). Never part of grand_total; never carry VAT. ----
  const appliedOffsets = offsets.filter((o) => !o.reversed)
  const appliedSatang = appliedOffsets.reduce((a, o) => a + toSatang(o.amount), 0)
  let available: Receipt['deposits']['available'] = []
  let unattached: Receipt['deposits']['unattached'] = []
  if (draft && doc.job_id) {
    const all = await warningsOfJob(trx, doc.job_id, facts.customer_id, facts.customer_phone)
    available = all.filter((w) => w.attachedToThisJob)
    unattached = all.filter((w) => !w.attachedToThisJob)
  }
  const deposits: Receipt['deposits'] = {
    applied: offsets.map((o) => ({
      paymentId: o.payment_id, depositId: o.deposit_id, depositNumber: o.slip_number, amount: o.amount,
      channel: o.channel as Receipt['deposits']['applied'][number]['channel'],
      paymentChannelName: o.payment_channel_name, receivedAt: o.received_at.toISOString(), reversed: o.reversed,
    })),
    appliedTotal: formatSatang(appliedSatang),
    available,
    availableTotal: formatSatang(available.reduce((a, w) => a + toSatang(w.amount), 0)),
    unattached,
  }

  const paidNet = formatSatang(payments.reduce((a, p) => a + toSatang(p.amount) - toSatang(p.change_given), 0))
  const changeTotal = formatSatang(payments.reduce((a, p) => a + toSatang(p.change_given), 0))
  const surchargeTotal = formatSatang(payments.reduce((a, p) => a + toSatang(p.surcharge_amount), 0))
  const snap = (doc.receipt_snapshot as Snapshot | null) ?? null
  // The snapshot also carries closedByName for the print footer; the view's party is the strict subset.
  const party = !draft && snap ? pickParty(snap) : partyOf(facts)
  const write = mayWrite(role)
  const presentedTotals = (doc.presented_totals as { subtotal: string; totalDiscount: string; billTotal: string } | null) ?? null

  return {
    id: doc.id, jobId: doc.job_id!, status: doc.status as Receipt['status'], number: doc.number,
    quotationId: doc.source_document_id!, quotationNumber, quotationChanged,
    party, lines,
    totals: {
      subtotal, lineDiscountTotal: formatSatang(lineDiscountSatang), discount: discountAmt,
      totalDiscount: formatSatang(totalDiscountSatang), billTotal, agreedTotal: doc.approved_total,
      // Deposits are a payment against the bill, never a reduction of it: billTotal above is untouched.
      depositOffsetTotal: formatSatang(appliedSatang),
      balanceDue: formatSatang(toSatang(billTotal) - appliedSatang),
      surchargeTotal, totalPaid: formatSatang(toSatang(billTotal) + toSatang(surchargeTotal)),
    },
    discount: {
      state, amount: discountAmt, total: formatSatang(totalDiscountSatang), agreed: doc.offered_discount, base: subtotal,
      percent: discountPercentText(baseSatang, totalDiscountSatang), exceedsCeiling: exceeds,
      ceilingPercent: DISCOUNT_CEILING_PERCENT, reason: doc.discount_reason, reasonRequired,
      approvedByName: doc.discount_approved_by ? (names.get(doc.discount_approved_by) ?? null) : null,
    },
    payments: payments.map((p) => ({
      id: p.id, method: p.method as PaymentMethod, channelId: p.channel_id, channelName: p.channel_name,
      amount: p.amount, surcharge: p.surcharge_amount, changeGiven: p.change_given,
      net: formatSatang(toSatang(p.amount) - toSatang(p.change_given)), receivedAt: p.received_at.toISOString(),
      receivedByName: p.received_by_name, reversed: p.reversed,
    })),
    deposits,
    paidNet, changeTotal,
    issuedAt: iso(doc.issued_at), issuedByName: doc.issued_by ? (names.get(doc.issued_by) ?? null) : null,
    voidedAt: iso(doc.voided_at), voidReason: doc.void_reason,
    voidedByName: doc.voided_by ? (names.get(doc.voided_by) ?? null) : null,
    presentation: doc.presented_at && presentedTotals
      ? {
          presentedAt: doc.presented_at.toISOString(), presentedByName: doc.presented_by ? (names.get(doc.presented_by) ?? null) : null,
          subtotal: presentedTotals.subtotal, totalDiscount: presentedTotals.totalDiscount, billTotal: presentedTotals.billTotal,
          current: draft ? presentationValid : true,
        }
      : null,
    next: {
      canTick: draft && write && !quotationChanged,
      canEditDiscount: draft && write && !quotationChanged,
      canEditLineDiscount: draft && write && !quotationChanged,
      canPresent: draft && write && presentable,
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

/**
 * Throw away the draft and rebuild it from the (new) confirmed quotation, keeping
 * ticks on lines that did not change. A typed discount, line discounts and the
 * presentation are dropped: the figures they were about are gone.
 */
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
// Draft edits: ticks, line discounts, the document discount, presenting the bill
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
    // A discount that no longer fits the (smaller) charge is cleared, never silently shrunk.
    const clearDiscount = toSatang(m.lineDiscount) > charge
    await repo.writeTick(trx, e.lineId, { fulfilledQty: qty, lineTotal: formatSatang(charge), by: actor.id, clearDiscount })
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

/**
 * Ice 20 Oct (P3.2 B4): a discount on one receipt line, with a mandatory reason.
 * Rounded per line (each line's discount is its own satang figure), then summed.
 */
export async function setLineDiscount(
  trx: ScopedTx, shopId: string, jobId: string, actor: Actor,
  lineId: string, discount: string, reason: string | undefined,
): Promise<Result<void>> {
  const l = await lockDraftForEdit(trx, jobId)
  if (!l.ok) return l
  const { doc, rows } = l.value
  const money = moneyLines(rows).find((m) => m.id === lineId)
  if (!money) return err({ code: 'receipt_line_not_found' })
  const issue = receiptLineDiscountIssue(money, discount, reason)
  if (issue === 'reason_required') return err({ code: 'invalid_request', fields: { reason: ['required'] } })
  if (issue) return err({ code: 'invalid_request', fields: { discount: [issue] } })

  const canonical = formatSatang(toSatang(discount))
  const prior = rows.find((r) => r.id === lineId)!
  await repo.writeLineDiscount(trx, lineId, canonical, reason?.trim() ?? null)
  await syncDraftTotals(trx, doc, await repo.getReceiptLines(trx, doc.id))
  await writeAudit(trx, {
    shopId, actorId: actor.id, action: 'receipt_line_discount_set', entityType: 'documents', entityId: doc.id,
    before: { lineId, lineDiscount: prior.line_discount },
    after: { lineId, lineDiscount: canonical, reason: reason?.trim() ?? null },
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
    const left = c.subtotalSatang - c.lineDiscountSatang
    if (discountExceedsSubtotal(left, d)) return err({ code: 'discount_exceeds_subtotal', max: formatSatang(left) })
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

/**
 * Ice 20 Oct (P3.2 B1): "present the bill". Everything is answered and priced; the
 * customer is shown the amount BEFORE any money is taken. Stores who and when plus
 * the totals shown, and a hash of everything they depend on. Presenting again
 * replaces the earlier presentation.
 */
export async function presentBill(trx: ScopedTx, shopId: string, jobId: string, actor: Actor): Promise<Result<void>> {
  const l = await lockDraftForEdit(trx, jobId)
  if (!l.ok) return l
  const { doc, rows } = l.value
  const c = compute(doc, rows)
  if (c.undecided.length > 0) return err({ code: 'fulfillment_incomplete', lineIds: c.undecided })
  if (c.discountState.state === 'needs_entry') return err({ code: 'discount_entry_required' })
  if (c.discountTooBig) return err({ code: 'discount_exceeds_subtotal', max: formatSatang(c.subtotalSatang - c.lineDiscountSatang) })
  if (c.billTotalSatang <= 0) return err({ code: 'nothing_to_bill' })

  const totals = {
    subtotal: formatSatang(c.subtotalSatang), totalDiscount: formatSatang(c.totalDiscountSatang),
    billTotal: formatSatang(c.billTotalSatang),
  }
  await repo.writePresentation(trx, doc.id, { by: actor.id, hash: presentationHash(c, rows), totals })
  await writeAudit(trx, {
    shopId, actorId: actor.id, action: 'receipt_bill_presented', entityType: 'documents', entityId: doc.id,
    before: { previouslyPresentedAt: doc.presented_at ? doc.presented_at.toISOString() : null }, after: totals,
  })
  return ok(undefined)
}

// -----------------------------------------------------------------------------
// Close the bill and issue the receipt - ONE transaction
// -----------------------------------------------------------------------------

export interface CloseOutcome {
  receiptId: string; change: string; surchargeTotal: string; depositOffsetTotal: string; unreservedLines: number; replayed: boolean
}

export async function closeBill(
  trx: ScopedTx, shopId: string, jobId: string, actor: Actor,
  input: { payments: ReadonlyArray<{ channelId: string; amount: string }>; depositIds: ReadonlyArray<string>; discountReason?: string },
): Promise<Result<CloseOutcome>> {
  // 1. JOB.
  const facts = await repo.jobBillingFacts(trx, jobId, { lock: true })
  if (!facts) return err({ code: 'job_not_found' })
  if (facts.job_type === 'warranty_claim') return err({ code: 'claim_no_receipt' })

  const found = await repo.findReceiptOfJob(trx, jobId)
  if (!found) return err({ code: 'receipt_not_found' })

  // Retry of a close that already went through (AC-E3): same channels and amounts -> the same answer.
  if (found.status === 'issued') {
    const paid = await repo.getPayments(trx, found.id)
    // Deposit offsets are part of the same key, as `dep:<id>` (they have no channel and no amount to compare).
    const stored = paid.map((p) => p.method === 'deposit_offset'
      ? `dep:${p.deposit_id}`
      : `${p.channel_id}:${formatSatang(toSatang(p.amount) - toSatang(p.surcharge_amount))}`).sort().join('|')
    const asked = [
      ...input.payments.map((p) => `${p.channelId}:${formatSatang(toSatang(p.amount))}`),
      ...input.depositIds.map((id) => `dep:${id}`),
    ].sort().join('|')
    if (stored === asked) {
      return ok({
        receiptId: found.id, replayed: true, unreservedLines: 0,
        change: formatSatang(paid.reduce((a, p) => a + toSatang(p.change_given), 0)),
        surchargeTotal: formatSatang(paid.reduce((a, p) => a + toSatang(p.surcharge_amount), 0)),
        depositOffsetTotal: formatSatang(paid.filter((p) => p.method === 'deposit_offset').reduce((a, p) => a + toSatang(p.amount), 0)),
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
  if (c.discountTooBig) {
    return err({ code: 'discount_exceeds_subtotal', max: formatSatang(c.subtotalSatang - c.lineDiscountSatang) })
  }
  if (c.billTotalSatang <= 0) return err({ code: 'nothing_to_bill' })

  // P3.3: the deposits to offset, locked in id order AFTER the lines (lock order jobs -> documents ->
  // document_lines -> deposits) and judged from the locked rows: a refund or forfeit that won the race
  // shows up here as not-held. The P3.2 `deposit_held` blocker is gone: a held deposit that is not
  // chosen simply stays held (it is the customer's money, still ours to hold).
  const depositRows = await depositsRepo.lockMany(trx, input.depositIds)
  const uniqueIds = new Set(input.depositIds)
  if (depositRows.length !== uniqueIds.size) return err({ code: 'deposit_not_found' })
  for (const d of depositRows) {
    if (d.status !== 'held') return err({ code: 'deposit_not_held', status: d.status })
    if (d.job_id !== jobId) return err({ code: 'deposit_not_attached' })
  }
  const plan = depositOffsetPlan(c.billTotalSatang, input.depositIds.map((id) => {
    const d = depositRows.find((x) => x.id === id)!
    return { id, amount: d.amount }
  }))
  if (!plan.ok) {
    if (plan.code === 'deposit_duplicate') return err({ code: 'invalid_request', fields: { depositIds: ['duplicate'] } })
    return err({ code: 'deposit_exceeds_bill', over: formatSatang(plan.over), max: formatSatang(plan.max) })
  }

  // Ice 20 Oct (P3.2 B4): the ceiling is judged on the FINAL receipt (line discounts + document
  // discount over the pre-discount total of the done lines), by the closer.
  const reason = (input.discountReason ?? doc.discount_reason ?? '').trim() || null
  const refusal = discountCeilingRefusal({ baseSatang: c.subtotalSatang, discountSatang: c.totalDiscountSatang, role: actor.role, reason })
  if (refusal === 'discount_requires_manager') return err({ code: 'discount_requires_manager', percent: discountPercentText(c.subtotalSatang, c.totalDiscountSatang) })
  if (refusal === 'discount_reason_required') return err({ code: 'discount_reason_required' })
  // A-10: any departure from the agreed document discount is explained.
  if (!reason && receiptDiscountReasonRequired({
    discountSatang: c.discountSatang, agreedDiscountSatang: c.agreedSatang, baseSatang: c.subtotalSatang,
    totalDiscountSatang: c.totalDiscountSatang,
  })) {
    return err({ code: 'discount_reason_required' })
  }
  const exceeds = discountExceedsCeiling(c.subtotalSatang, c.totalDiscountSatang)

  // Ice 20 Oct (P3.2 B1): the customer was shown THIS bill before money is taken. Anything that
  // changed since (a tick, a line discount, the discount) makes the presentation stale.
  if (!doc.presented_at) return err({ code: 'bill_not_presented' })
  if (doc.presented_hash !== presentationHash(c, rows)) return err({ code: 'presentation_stale' })

  // Channels of THIS shop (RLS hides any other), active, each used once.
  const channels = await channelsRepo.getMany(trx, input.payments.map((p) => p.channelId))
  const byId = new Map(channels.map((ch) => [ch.id, ch]))
  for (const p of input.payments) {
    const ch = byId.get(p.channelId)
    if (!ch) return err({ code: 'channel_not_found' })
    if (!ch.is_active) return err({ code: 'channel_inactive' })
  }
  // What is still owed after the deposits. grand_total (the bill) is NOT reduced, and no VAT is computed
  // on the remainder (VAT room deferred; CLAUDE.md s7 item 3b).
  if (plan.due === 0 && input.payments.length > 0) return err({ code: 'payment_not_needed' })
  const settled = plan.due === 0
    ? { ok: true as const, rows: [] as Array<{ key: string; method: PaymentMethod; applied: string; surcharge: string; amount: string; changeGiven: string }>, netPaid: '0.00', change: '0.00', surchargeTotal: '0.00' }
    : settlePayments(plan.due, input.payments.map((p) => {
        const ch = byId.get(p.channelId)!
        return { key: ch.id, method: ch.kind as PaymentMethod, surchargePercent: ch.surcharge_percent, amount: p.amount }
      }))
  if (!settled.ok) {
    switch (settled.code) {
      case 'payment_short': return err({ code: 'payment_short', short: settled.short, due: formatSatang(plan.due) })
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
    subtotal: formatSatang(c.subtotalSatang), discount: formatSatang(c.discountSatang),
    billTotal: formatSatang(c.billTotalSatang), discountReason: reason,
    discountApprovedBy: exceeds ? actor.id : null,
    snapshot: { ...partyOf(facts), closedByName: names.get(actor.id) ?? null },
  })
  for (const p of settled.rows) {
    await repo.insertPayment(trx, {
      shopId, documentId: doc.id, channelId: p.key, method: p.method, amount: p.amount, surchargeAmount: p.surcharge,
      changeGiven: p.changeGiven, receivedBy: actor.id, receivedAt: now,
    })
  }
  // One deposit_offset payment row per deposit, referencing deposit_id; the deposit moves to 'applied'
  // in this same transaction (s5.4 item 6). Not money in on today's summary: it was counted the day it came.
  for (const d of depositRows) {
    await depositsRepo.insertOffsetPayment(trx, { shopId, documentId: doc.id, depositId: d.id, amount: d.amount, receivedBy: actor.id, receivedAt: now })
    await depositsRepo.markApplied(trx, d.id, doc.id)
    await writeAudit(trx, {
      shopId, actorId: actor.id, action: 'deposit_applied', entityType: 'deposits', entityId: d.id,
      before: { status: 'held', jobId: d.job_id }, after: { status: 'applied', receiptId: doc.id, amount: d.amount },
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
      number, jobId, subtotal: formatSatang(c.subtotalSatang), lineDiscountTotal: formatSatang(c.lineDiscountSatang),
      discount: formatSatang(c.discountSatang), percent: discountPercentText(c.subtotalSatang, c.totalDiscountSatang),
      billTotal: formatSatang(c.billTotalSatang), agreedDiscount: doc.offered_discount, agreedTotal: doc.approved_total,
      discountReason: reason, overCeiling: exceeds,
      presentedAt: doc.presented_at.toISOString(),
      surchargeTotal: settled.surchargeTotal,
      depositOffsets: depositRows.map((d) => ({ depositId: d.id, amount: d.amount })),
      depositOffsetTotal: formatSatang(plan.offsetTotal), balanceDue: formatSatang(plan.due),
      payments: settled.rows.map((p) => ({ channelId: p.key, method: p.method, applied: p.applied, surcharge: p.surcharge, amount: p.amount, change: p.changeGiven })),
      notDoneLineIds: notDone.map((r) => r.id), unreservedLines: unreserved,
    },
  })
  return ok({
    receiptId: doc.id, change: settled.change, surchargeTotal: settled.surchargeTotal,
    depositOffsetTotal: formatSatang(plan.offsetTotal), unreservedLines: unreserved, replayed: false,
  })
}

// -----------------------------------------------------------------------------
// Void (owner only - checked at the route and again here)
// Ice 20 Oct (P3.2 B6): owner only, per CLAUDE.md s12.1; no same-day manager exception.
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
    // What actually went back: everything handed over (surcharge included) minus the change.
    const net = formatSatang(toSatang(p.amount) - toSatang(p.change_given))
    await repo.insertReversal(trx, { shopId, paymentId: p.id, documentId: doc.id, method: p.method, channelId: p.channel_id, amount: net, reason, by: actor.id })
    reversals.push({ paymentId: p.id, method: p.method, amount: net })
  }
  await repo.markReceiptVoid(trx, doc.id, { reason, voidedBy: actor.id })
  // P3.3: the deposits this receipt consumed go back to 'held' - the customer's money is still ours to hold.
  // (DEFAULT pending Ice (P3.3 D7).) The deposit_offset payment keeps its reversal row; the deposit can be
  // offset again into the next receipt of the job, or refunded.
  const offsetIds = payments.filter((p) => p.method === 'deposit_offset').map((p) => p.deposit_id!)
  if (offsetIds.length > 0) {
    await depositsRepo.lockMany(trx, offsetIds)
    for (const id of await depositsRepo.releaseAppliedTo(trx, doc.id)) {
      await writeAudit(trx, {
        shopId, actorId: actor.id, action: 'deposit_released', entityType: 'deposits', entityId: id,
        before: { status: 'applied', receiptId: doc.id }, after: { status: 'held', reason },
      })
    }
  }
  if (facts.sub_state === 'paid') await jobsRepo.setSubState(trx, jobId, null)
  await writeAudit(trx, {
    shopId, actorId: actor.id, action: 'receipt_voided', entityType: 'documents', entityId: doc.id,
    before: { status: 'issued', number: doc.number, billTotal: doc.grand_total },
    after: { status: 'void', reason, reversals },
  })
  return ok(undefined)
}

// -----------------------------------------------------------------------------
// Gates used by the job status route (Ice 20 Oct, P3.2 B1)
// -----------------------------------------------------------------------------

export type DeliveryGate =
  | { ok: true; waivedBy: 'receipt' | 'claim' | 'no_bill_reason' }
  | { ok: false; code: 'receipt_required'; nothingToBill: boolean }

/**
 * May this job move to 'delivered'? (Ice 20 Oct, P3.2 B1.) The caller holds the job lock.
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

// -----------------------------------------------------------------------------
// The bill statement (ใบแจ้งยอด) - the presented bill, printed from the DRAFT
// receipt. NOT a receipt: no number, no tax meaning (Ice 20 Oct, P3.2 B1).
// -----------------------------------------------------------------------------

/**
 * The draft receipt a statement can be printed from, and a fingerprint of what it
 * shows. Requires a valid presentation: a statement that does not match the
 * current figures must not be handed to the customer. The caller holds the job lock.
 */
export async function statementOf(
  trx: ScopedTx, jobId: string, opts: { lock?: boolean } = {},
): Promise<Result<{ doc: repo.ReceiptDocRow; hash: string }>> {
  const found = await repo.findReceiptOfJob(trx, jobId)
  if (!found) return err({ code: 'receipt_not_found' })
  const doc = opts.lock ? await repo.lockReceipt(trx, found.id) : found
  if (!doc) return err({ code: 'receipt_not_found' })
  if (doc.status !== 'draft') return err({ code: 'receipt_not_draft' })
  if (!doc.presented_at || !doc.presented_hash) return err({ code: 'bill_not_presented' })
  const rows = await repo.getReceiptLines(trx, doc.id)
  if (presentationHash(compute(doc, rows), rows) !== doc.presented_hash) return err({ code: 'presentation_stale' })
  return ok({ doc, hash: doc.presented_hash })
}
