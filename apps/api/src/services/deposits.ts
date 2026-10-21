/**
 * Deposits (P3.3, CLAUDE.md s5.4): take one for a CUSTOMER (with or without a car or a job),
 * bind it to a job, print its slip (ใบรับเงินมัดจำ, own DEP series), refund it or forfeit it.
 * Offsetting into a bill lives in services/receipt.ts closeBill (one transaction with the receipt).
 *
 * Rules that run through the file:
 *  - The shop and the actor come from the JWT; nothing here reads a shop from a request.
 *  - A deposit is never deleted and its money columns never change (trg_deposits_guard); every
 *    leave from 'held' records who, when and why, and is audited.
 *  - No VAT anywhere: a deposit is money received, not a sale (s7 item 3b).
 *  - The slip number is allocated when the slip is first PRINTED, in the same transaction as the
 *    document row (s5.4 item 10), from the DEP counter - never read-then-write.
 *  - LOCK ORDER (s4.x): jobs -> documents -> document_lines -> deposits/stock. Operations that
 *    touch a job take the JOB row first; refund / forfeit / slip take only the deposit row. Every
 *    decision is made from rows read AFTER the locks.
 *
 * Reminder (as in services/receipt.ts): a returned error is not a throw, so the request still
 * COMMITS. Every function validates first and writes after.
 */
import { createHash } from 'node:crypto'
import {
  bangkokDayKey, depositAmountIssue, depositDaysOverdue, depositExpectedDateIssue, isDepositOverdue,
  roleMayForfeitDeposit, roleMayRefundDeposit, roleMayWriteDeposit, toSatang, formatSatang, sumSatang,
  DEPOSIT_SLIP_TITLE,
} from '@champpower/domain'
import type {
  CreateDepositInput, CreateDepositSlipInput, Deposit, DepositChannel, DepositList, DepositListQuery, DepositMethod,
  DepositReason, DepositSlipContent, DepositSlipHistory, DepositSlipPrint, DepositStatus, DepositWarning, JobDeposits,
} from '@gsms/contracts/index.js'
import type { ScopedTx } from '@gsms/db/client.js'
import { bangkokToday } from '../lib/bangkokDate.js'
import * as customersRepo from '../repositories/customers.js'
import * as vehiclesRepo from '../repositories/vehicles.js'
import * as channelsRepo from '../repositories/channels.js'
import * as receiptRepo from '../repositories/receipt.js'
import * as quotationRepo from '../repositories/quotation.js'
import * as printsRepo from '../repositories/prints.js'
import * as repo from '../repositories/deposits.js'
import { isBlockedMatchKey } from '../repositories/matchBlocklist.js'
import { writeAudit } from './audit.js'

export interface Actor { id: string; role: string }

export type DepositError =
  | { code: 'deposit_not_found' }
  | { code: 'job_not_found' }
  | { code: 'customer_not_found' }
  | { code: 'deposit_not_held'; status: DepositStatus }
  | { code: 'deposit_customer_mismatch' }
  | { code: 'deposit_job_mismatch' }
  | { code: 'job_already_billed' }
  | { code: 'forfeit_requires_manager' }
  | { code: 'deposit_slip_unavailable' }
  | { code: 'invalid_request'; fields: Record<string, string[]> }
  | { code: 'customer_ambiguous'; candidates: Array<{ id: string; name: string | null }> }
  | { code: 'print_content_changed'; printCount: number; lastPrintedAt: string }

export type Result<T> = { ok: true; value: T } | { ok: false; error: DepositError }
const err = (error: DepositError): { ok: false; error: DepositError } => ({ ok: false, error })
const ok = <T>(value: T): { ok: true; value: T } => ({ ok: true, value })
const invalid = (fields: Record<string, string[]>) => err({ code: 'invalid_request', fields })

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null)
const sha = (v: unknown): string => createHash('sha256').update(JSON.stringify(v)).digest('hex')

// -----------------------------------------------------------------------------
// Row -> wire
// -----------------------------------------------------------------------------

export function toDeposit(r: repo.DepositRow, role: string, today: string, printCount = 0): Deposit {
  const held = r.status === 'held'
  const write = roleMayWriteDeposit(role)
  return {
    id: r.id, customerId: r.customer_id, customerName: r.customer_name, customerPhone: r.customer_phone,
    jobId: r.job_id, jobNumber: r.job_number, vehicleId: r.vehicle_id, plate: r.plate,
    amount: r.amount, reason: r.reason as DepositReason, channel: r.channel as DepositChannel,
    paymentChannelId: r.payment_channel_id, paymentChannelName: r.payment_channel_name, method: r.method as DepositMethod,
    slipFileId: r.slip_file_id,
    slip: r.slip_document_id && r.slip_number ? { documentId: r.slip_document_id, number: r.slip_number, printCount } : null,
    expectedDate: r.expected_date,
    overdue: isDepositOverdue(r.status, r.expected_date, today),
    daysOverdue: depositDaysOverdue(r.status, r.expected_date, today),
    status: r.status as DepositStatus,
    receivedAt: r.received_at.toISOString(), receivedByName: r.received_by_name,
    appliedToReceiptId: r.applied_to_document_id, appliedToReceiptNumber: r.applied_receipt_number,
    closedAt: iso(r.closed_at), closedByName: r.closed_by_name, closeReason: r.close_reason,
    refundChannelName: r.status === 'refunded' ? (r.refund_channel_name ?? r.payment_channel_name) : null,
    next: {
      canAttach: held && write && r.job_id === null,
      canDetach: held && write && r.job_id !== null,
      canRefund: held && roleMayRefundDeposit(role),
      canForfeit: held && roleMayForfeitDeposit(role),
      canPrintSlip: write && (r.slip_document_id !== null || r.status === 'held' || r.status === 'applied'),
    },
  }
}

export function toWarning(r: repo.DepositRow & { matched_by?: repo.MatchedBy }, jobId: string | null, today: string): DepositWarning {
  return {
    depositId: r.id, amount: r.amount, receivedAt: r.received_at.toISOString(), channel: r.channel as DepositChannel,
    paymentChannelName: r.payment_channel_name, expectedDate: r.expected_date,
    overdue: isDepositOverdue(r.status, r.expected_date, today), reason: r.reason as DepositReason,
    matchedBy: r.matched_by ?? 'customer', attachedToThisJob: jobId !== null && r.job_id === jobId, slipNumber: r.slip_number,
  }
}

async function viewOf(trx: ScopedTx, id: string, role: string): Promise<Deposit> {
  const r = (await repo.getById(trx, id))!
  const counts = await repo.slipPrintCounts(trx, r.slip_document_id ? [r.slip_document_id] : [])
  return toDeposit(r, role, bangkokToday(), r.slip_document_id ? (counts.get(r.slip_document_id) ?? 0) : 0)
}

// -----------------------------------------------------------------------------
// The warning (job open / job view / receipt view)
// -----------------------------------------------------------------------------

/** The phone digits that may pull in other customers' deposits: never blank, never a blocklisted placeholder. */
async function usablePhoneDigits(trx: ScopedTx, phone: string | null): Promise<string | null> {
  if (!phone) return null
  const digits = customersRepo.normalisePhone(phone)
  if (digits.length === 0) return null
  return (await isBlockedMatchKey(trx, 'phone', digits)) ? null : digits
}

/**
 * Held deposits belonging to the person this job is for: same customer, or same (usable) phone.
 * Read-only. Called by openJob inside its transaction, by the customer lookup, and by the views.
 */
export async function warningsOfJob(
  trx: ScopedTx, jobId: string, customerId: string, customerPhone: string | null, bookingId?: string | null,
): Promise<DepositWarning[]> {
  const today = bangkokToday()
  const rows = await repo.warningsFor(trx, { jobId, customerId, bookingId, phoneDigits: await usablePhoneDigits(trx, customerPhone) })
  return rows.map((r) => toWarning(r, jobId, today))
}

/** Held deposits of a customer / phone before any job exists (the lookup at the counter). */
export async function warningsOfCustomer(trx: ScopedTx, customerId: string, customerPhone: string | null): Promise<DepositWarning[]> {
  const today = bangkokToday()
  // A job id that no row can have: nothing is "attached to this job", only unattached or attached elsewhere is hidden.
  const rows = await repo.warningsFor(trx, {
    jobId: '00000000-0000-0000-0000-000000000000', customerId, phoneDigits: await usablePhoneDigits(trx, customerPhone),
  })
  return rows.map((r) => toWarning(r, null, today))
}

export async function jobDeposits(trx: ScopedTx, jobId: string, role: string): Promise<Result<JobDeposits>> {
  const facts = await receiptRepo.jobBillingFacts(trx, jobId)
  if (!facts) return err({ code: 'job_not_found' })
  const today = bangkokToday()
  const warnings = await warningsOfJob(trx, jobId, facts.customer_id, facts.customer_phone)
  const applied = await repo.appliedViaJob(trx, jobId)
  const counts = await repo.slipPrintCounts(trx, applied.flatMap((a) => (a.slip_document_id ? [a.slip_document_id] : [])))
  return ok({
    jobId,
    warnings,
    applied: applied.map((a) => toDeposit(a, role, today, a.slip_document_id ? (counts.get(a.slip_document_id) ?? 0) : 0)),
    heldTotal: formatSatang(sumSatang(warnings.map((w) => toSatang(w.amount)))),
  })
}

// -----------------------------------------------------------------------------
// Receive
// -----------------------------------------------------------------------------

export async function createDeposit(
  trx: ScopedTx, shopId: string, actor: Actor, input: CreateDepositInput,
): Promise<Result<{ deposit: Deposit; customerCreated: boolean; replayed: boolean }>> {
  const today = bangkokToday()
  const named = input.customerName !== undefined && input.customerPhone !== undefined
  const fields: Record<string, string[]> = {}
  const amountIssue = depositAmountIssue(input.amount)
  if (amountIssue) fields.amount = [amountIssue]
  const dateIssue = depositExpectedDateIssue(input.expectedDate, today)
  if (dateIssue) fields.expectedDate = [dateIssue]
  if (input.jobId && named) fields.customerName = ['not_with_job']
  if (named && input.vehicleId) fields.vehicleId = ['needs_existing_customer']
  if (Object.keys(fields).length > 0) return invalid(fields)

  // A retry (double click, flaky wifi) lands here: serialise on the key, then answer with what the first call made.
  await repo.lockIdempotencyKey(trx, input.idempotencyKey)
  const prior = await repo.findByIdempotencyKey(trx, input.idempotencyKey)
  if (prior) return ok({ deposit: await viewOf(trx, prior.id, actor.role), customerCreated: false, replayed: true })

  // ---- references: every one checked before anything is written ----
  const channel = (await channelsRepo.getMany(trx, [input.paymentChannelId]))[0]
  if (!channel) fields.paymentChannelId = ['unknown_channel']
  else if (!channel.is_active) fields.paymentChannelId = ['inactive_channel']
  if (input.slipFileId && !(await repo.freeSlipFile(trx, input.slipFileId))) fields.slipFileId = ['unknown_file']
  if (input.bookingId && !(await repo.bookingExists(trx, input.bookingId))) fields.bookingId = ['unknown_booking']

  // Lock order: the job (if any) first.
  let customerId: string | null = null
  let vehicleId: string | null = input.vehicleId ?? null
  let jobId: string | null = null
  let createName: string | null = null
  if (input.jobId) {
    const facts = await receiptRepo.jobBillingFacts(trx, input.jobId, { lock: true })
    if (!facts) return err({ code: 'job_not_found' })
    if (input.customerId && input.customerId !== facts.customer_id) return err({ code: 'deposit_customer_mismatch' })
    const existing = await receiptRepo.findReceiptOfJob(trx, input.jobId)
    if (existing && existing.status === 'issued') return err({ code: 'job_already_billed' })
    customerId = facts.customer_id
    jobId = input.jobId
    vehicleId = await repo.vehicleOfJob(trx, input.jobId)
  } else if (input.customerId) {
    const c = await customersRepo.findById(trx, input.customerId)
    if (!c) return err({ code: 'customer_not_found' })
    customerId = c.id
  } else if (named) {
    // DEFAULT pending Ice (P3.3 D8): no channel surcharge is added to a deposit (card fee rules apply to bills only).
    // DEFAULT pending Ice (P3.3 D9): a blocklisted placeholder phone always creates a new customer (existing intake rule);
    // lead_source is NOT set from the deposit channel.
    // The online deposit: a name and a phone, no car, no job. Existing rules of the check-in door apply:
    // a phone that matches ONE customer is that customer; two or three share it and the counter chooses;
    // a blocklisted placeholder always creates a new one.
    const match = await customersRepo.findByPhone(trx, shopId, input.customerPhone!)
    if (match.kind === 'ambiguous') return err({ code: 'customer_ambiguous', candidates: match.candidates })
    if (match.kind === 'one') customerId = match.customer.id
    else createName = input.customerName!
  }
  if (customerId && vehicleId && !jobId) {
    const v = await vehiclesRepo.findById(trx, shopId, vehicleId)
    if (!v) fields.vehicleId = ['unknown_vehicle']
    else if (v.customer_id !== customerId) fields.vehicleId = ['not_customers_vehicle']
  }
  if (Object.keys(fields).length > 0) return invalid(fields)

  // ---- write ----
  let customerCreated = false
  if (customerId === null) {
    const created = await customersRepo.create(trx, { shopId, name: createName!, phone: input.customerPhone })
    customerId = created.id
    customerCreated = true
    await writeAudit(trx, {
      shopId, actorId: actor.id, action: 'customer_created_from_deposit', entityType: 'customers', entityId: created.id,
      before: null, after: { source: 'deposit', channel: input.channel },
    })
  }
  const id = await repo.insert(trx, {
    shopId, customerId, jobId, vehicleId, bookingId: input.bookingId ?? null, amount: formatSatang(toSatang(input.amount)),
    reason: input.reason, method: channel!.kind, channel: input.channel, paymentChannelId: channel!.id,
    slipFileId: input.slipFileId ?? null, expectedDate: input.expectedDate, receivedBy: actor.id, idempotencyKey: input.idempotencyKey,
  })
  // Ids and operational values only - never the name or phone (CLAUDE.md s12).
  await writeAudit(trx, {
    shopId, actorId: actor.id, action: 'deposit_received', entityType: 'deposits', entityId: id,
    before: null,
    after: {
      customerId, jobId, vehicleId, amount: formatSatang(toSatang(input.amount)), reason: input.reason, channel: input.channel,
      paymentChannelId: channel!.id, method: channel!.kind, expectedDate: input.expectedDate, slipFileId: input.slipFileId ?? null,
      customerCreated,
    },
  })
  return ok({ deposit: await viewOf(trx, id, actor.role), customerCreated, replayed: false })
}

// -----------------------------------------------------------------------------
// Read
// -----------------------------------------------------------------------------

export async function getDeposit(trx: ScopedTx, id: string, role: string): Promise<Result<Deposit>> {
  const r = await repo.getById(trx, id)
  if (!r) return err({ code: 'deposit_not_found' })
  return ok(await viewOf(trx, id, role))
}

export async function listDeposits(trx: ScopedTx, role: string, q: DepositListQuery): Promise<DepositList> {
  const today = bangkokToday()
  const { rows, total } = await repo.list(trx, {
    status: q.status, overdueBefore: q.overdue === 'true' ? today : null, customerId: q.customerId, limit: q.limit, offset: q.offset,
  })
  const summary = await repo.heldSummary(trx, today)
  const counts = await repo.slipPrintCounts(trx, rows.flatMap((r) => (r.slip_document_id ? [r.slip_document_id] : [])))
  return {
    items: rows.map((r) => toDeposit(r, role, today, r.slip_document_id ? (counts.get(r.slip_document_id) ?? 0) : 0)),
    total,
    summary: {
      heldCount: summary.held_count, heldTotal: summary.held_total,
      overdueCount: summary.overdue_count, overdueTotal: summary.overdue_total, asOf: today,
    },
  }
}

// -----------------------------------------------------------------------------
// Attach / detach (bind a held deposit to a job)
// -----------------------------------------------------------------------------

export async function attachDeposit(
  trx: ScopedTx, shopId: string, actor: Actor, depositId: string, jobId: string,
): Promise<Result<Deposit>> {
  // 1. JOB.
  const facts = await receiptRepo.jobBillingFacts(trx, jobId, { lock: true })
  if (!facts) return err({ code: 'job_not_found' })
  // 2. DEPOSIT, judged after its lock.
  const d = await repo.lockById(trx, depositId)
  if (!d) return err({ code: 'deposit_not_found' })
  if (d.status !== 'held') return err({ code: 'deposit_not_held', status: d.status as DepositStatus })
  if (d.job_id === jobId) return ok(await viewOf(trx, depositId, actor.role)) // a retry
  if (d.job_id !== null) return err({ code: 'deposit_job_mismatch' })
  const receipt = await receiptRepo.findReceiptOfJob(trx, jobId)
  if (receipt && receipt.status === 'issued') return err({ code: 'job_already_billed' })

  // Whose money is it? The job's own customer, or a customer on the same usable phone (the online deposit
  // made its own minimal customer). Anything else is somebody else's deposit.
  if (d.customer_id !== facts.customer_id) {
    // A deposit taken to hold THIS booking's slot belongs to the job the booking became.
    const jobBooking = await repo.bookingOfJob(trx, jobId)
    const sameBooking = d.booking_id !== null && d.booking_id === jobBooking
    const digits = await usablePhoneDigits(trx, facts.customer_phone)
    const theirs = d.customer_phone ? customersRepo.normalisePhone(d.customer_phone) : ''
    if (!sameBooking && (!digits || digits !== theirs)) return err({ code: 'deposit_customer_mismatch' })
  }

  const vehicleId = await repo.vehicleOfJob(trx, jobId)
  await repo.attach(trx, depositId, jobId, vehicleId)
  await writeAudit(trx, {
    shopId, actorId: actor.id, action: 'deposit_attached', entityType: 'deposits', entityId: depositId,
    before: { jobId: null }, after: { jobId, vehicleId, amount: d.amount, sameCustomer: d.customer_id === facts.customer_id },
  })
  return ok(await viewOf(trx, depositId, actor.role))
}

export async function detachDeposit(
  trx: ScopedTx, shopId: string, actor: Actor, depositId: string, reason: string,
): Promise<Result<Deposit>> {
  // Read once, unlocked, only to learn which job row to lock first (s4.x); decided again after the locks.
  const peek = await repo.getById(trx, depositId)
  if (!peek) return err({ code: 'deposit_not_found' })
  if (peek.job_id) {
    const facts = await receiptRepo.jobBillingFacts(trx, peek.job_id, { lock: true })
    if (!facts) return err({ code: 'job_not_found' })
  }
  const d = await repo.lockById(trx, depositId)
  if (!d) return err({ code: 'deposit_not_found' })
  if (d.status !== 'held') return err({ code: 'deposit_not_held', status: d.status as DepositStatus })
  // Changed between the peek and the lock (someone detached or re-attached it): ask the user to look again.
  if (d.job_id === null || d.job_id !== peek.job_id) return err({ code: 'deposit_job_mismatch' })

  await repo.detach(trx, depositId)
  await writeAudit(trx, {
    shopId, actorId: actor.id, action: 'deposit_detached', entityType: 'deposits', entityId: depositId,
    before: { jobId: d.job_id }, after: { jobId: null, reason },
  })
  return ok(await viewOf(trx, depositId, actor.role))
}

// -----------------------------------------------------------------------------
// Refund / forfeit - never automatic, always a person, always a reason
// -----------------------------------------------------------------------------

export async function refundDeposit(
  trx: ScopedTx, shopId: string, actor: Actor, depositId: string, input: { reason: string; refundChannelId?: string | undefined },
): Promise<Result<Deposit>> {
  if (!roleMayRefundDeposit(actor.role)) throw new Error('refundDeposit called without a refund role')
  const fields: Record<string, string[]> = {}
  if (input.reason.trim().length === 0) fields.reason = ['required']
  let channelId: string | null = null
  if (input.refundChannelId) {
    const ch = (await channelsRepo.getMany(trx, [input.refundChannelId]))[0]
    if (!ch) fields.refundChannelId = ['unknown_channel']
    else if (!ch.is_active) fields.refundChannelId = ['inactive_channel']
    else channelId = ch.id
  }
  if (Object.keys(fields).length > 0) return invalid(fields)

  const d = await repo.lockById(trx, depositId)
  if (!d) return err({ code: 'deposit_not_found' })
  if (d.status !== 'held') return err({ code: 'deposit_not_held', status: d.status as DepositStatus })

  const at = new Date()
  const reason = input.reason.trim()
  // DEFAULT pending Ice (P3.3 D2): the refund goes out through the channel the money came in through unless one is named.
  await repo.markRefunded(trx, depositId, { by: actor.id, reason, channelId, at })
  // The money goes back out on THIS day: the daily summary reads closed_at (reversal-style, dated the refund day).
  await writeAudit(trx, {
    shopId, actorId: actor.id, action: 'deposit_refunded', entityType: 'deposits', entityId: depositId,
    before: { status: 'held', amount: d.amount, jobId: d.job_id },
    after: { status: 'refunded', reason, refundChannelId: channelId ?? d.payment_channel_id, at: at.toISOString() },
  })
  return ok(await viewOf(trx, depositId, actor.role))
}

export async function forfeitDeposit(
  trx: ScopedTx, shopId: string, actor: Actor, depositId: string, input: { reason: string },
): Promise<Result<Deposit>> {
  // Forfeiting turns a customer's money into the shop's. Checked at the route and again here.
  if (!roleMayForfeitDeposit(actor.role)) return err({ code: 'forfeit_requires_manager' })
  if (input.reason.trim().length === 0) return invalid({ reason: ['required'] })

  const d = await repo.lockById(trx, depositId)
  if (!d) return err({ code: 'deposit_not_found' })
  if (d.status !== 'held') return err({ code: 'deposit_not_held', status: d.status as DepositStatus })

  const at = new Date()
  const reason = input.reason.trim()
  // DEFAULT pending Ice (P3.3 D4): a forfeit of a deposit that is not yet overdue is allowed (the customer
  // may say "keep it"); the reason is what records why. It is never automatic.
  await repo.markForfeited(trx, depositId, { by: actor.id, reason, at })
  await writeAudit(trx, {
    shopId, actorId: actor.id, action: 'deposit_forfeited', entityType: 'deposits', entityId: depositId,
    before: { status: 'held', amount: d.amount, jobId: d.job_id },
    after: { status: 'forfeited', reason, at: at.toISOString(), overdue: isDepositOverdue('held', d.expected_date, bangkokToday()) },
  })
  return ok(await viewOf(trx, depositId, actor.role))
}

// -----------------------------------------------------------------------------
// The slip: ใบรับเงินมัดจำ
// -----------------------------------------------------------------------------

type SlipSnapshot = Omit<DepositSlipContent, 'title'>

function contentOf(snap: SlipSnapshot): DepositSlipContent {
  return { title: DEPOSIT_SLIP_TITLE, ...snap }
}

const slipHash = (number: string, status: string, snap: SlipSnapshot): string => sha({ n: number, st: status, c: snap })

/**
 * Print the slip. First print: the DEP number is allocated HERE (s5.4 item 10) and the document is
 * written already numbered, in this transaction. Later prints re-use the frozen snapshot and only
 * count. A deposit that has since been refunded / forfeited / applied prints with that status
 * beside the slip and the history says the content changed.
 */
export async function printSlip(
  trx: ScopedTx, shopId: string, actor: Actor, depositId: string, input: CreateDepositSlipInput,
): Promise<Result<DepositSlipPrint>> {
  const d = await repo.lockById(trx, depositId)
  if (!d) return err({ code: 'deposit_not_found' })

  let documentId = d.slip_document_id
  let number = d.slip_number
  let snap: SlipSnapshot
  if (!documentId) {
    if (d.status !== 'held' && d.status !== 'applied') return err({ code: 'deposit_slip_unavailable' })
    // The quotation it is for, if one is linked: the attached job's live quotation, when numbered.
    let quotationNumber: string | null = null
    if (d.job_id) quotationNumber = (await quotationRepo.findLiveQuotation(trx, d.job_id))?.number ?? null
    const now = new Date()
    // DEFAULT pending Ice (P3.3 D1): the "print slip" action allocates the DEP number (s5.4 item 10).
    // DEFAULT pending Ice (P3.3 D10): the quotation number is frozen into the slip at this moment.
    number = await repo.allocateSlipNumber(trx, shopId)
    snap = {
      number,
      issuedOn: bangkokDayKey(now),
      customerName: d.customer_name, customerPhone: d.customer_phone,
      amount: d.amount, reason: d.reason as DepositReason, channel: d.channel as DepositChannel,
      paymentChannelName: d.payment_channel_name, method: d.method as DepositMethod,
      receivedAt: d.received_at.toISOString(), receivedByName: d.received_by_name, expectedDate: d.expected_date,
      quotationNumber, jobNumber: d.job_number, plate: d.plate,
    }
    documentId = await repo.insertIssuedSlip(trx, {
      shopId, customerId: d.customer_id, number, numberedOn: snap.issuedOn, amount: d.amount, issuedBy: actor.id, issuedAt: now, snapshot: snap,
    })
    await repo.setSlipDocument(trx, depositId, documentId)
    await writeAudit(trx, {
      shopId, actorId: actor.id, action: 'deposit_slip_numbered', entityType: 'deposits', entityId: depositId,
      before: { slipNumber: null }, after: { slipNumber: number, documentId, amount: d.amount, quotationNumber },
    })
  } else {
    const stored = await repo.getSlipSnapshot(trx, documentId)
    if (!stored) throw new Error(`deposit ${depositId} points at slip ${documentId} that has no snapshot`)
    number = stored.number
    snap = stored.snapshot as SlipSnapshot
  }

  const hash = slipHash(number!, d.status, snap)
  const last = await printsRepo.latestPrint(trx, 'deposit_receipt', documentId)
  const changed = !!last && last.content_hash !== hash
  if (changed && !input.acknowledgeChange) {
    return err({ code: 'print_content_changed', printCount: last!.seq, lastPrintedAt: last!.printed_at.toISOString() })
  }
  const seq = (last?.seq ?? 0) + 1
  const row = await printsRepo.insertPrint(trx, {
    shopId, jobId: null, documentId, docType: 'deposit_receipt', subjectId: documentId, seq,
    statusAtPrint: d.status, revision: null, copySet: input.copySet, contentHash: hash,
    acknowledgedChange: changed && input.acknowledgeChange, printedBy: actor.id,
  })
  const names = await receiptRepo.userNames(trx, [actor.id])
  if (seq > 1) {
    await writeAudit(trx, {
      shopId, actorId: actor.id, action: 'deposit_slip_reprinted', entityType: 'deposits', entityId: depositId, after: { printNo: seq },
    })
  }
  return ok({
    content: contentOf(snap), printNo: seq, isReprint: seq > 1, printedAt: row.printedAt.toISOString(),
    printedByName: names.get(actor.id) ?? null, copySet: input.copySet, statusAtPrint: d.status as DepositStatus,
    previous: last ? { seq: last.seq, printedAt: last.printed_at.toISOString(), printedByName: last.printed_by_name } : null,
    contentChangedSincePrevious: changed,
  })
}

export async function slipHistory(trx: ScopedTx, depositId: string, limit: number, offset: number): Promise<Result<DepositSlipHistory>> {
  const d = await repo.getById(trx, depositId)
  if (!d) return err({ code: 'deposit_not_found' })
  if (!d.slip_document_id) {
    return ok({ number: null, printCount: 0, contentChangedSinceLastPrint: false, items: [], total: 0 })
  }
  const stored = await repo.getSlipSnapshot(trx, d.slip_document_id)
  const [{ rows, total }, last] = await Promise.all([
    printsRepo.listPrints(trx, 'deposit_receipt', d.slip_document_id, limit, offset),
    printsRepo.latestPrint(trx, 'deposit_receipt', d.slip_document_id),
  ])
  const hash = stored ? slipHash(stored.number, d.status, stored.snapshot as SlipSnapshot) : null
  return ok({
    number: d.slip_number, printCount: total, contentChangedSinceLastPrint: !!last && hash !== null && last.content_hash !== hash,
    items: rows.map((r) => ({
      seq: r.seq, printedAt: r.printed_at.toISOString(), printedByName: r.printed_by_name, statusAtPrint: r.status_at_print,
      copySet: r.copy_set as 'customer_shop' | 'customer_only' | 'shop_only', acknowledgedChange: r.acknowledged_change,
    })),
    total,
  })
}
