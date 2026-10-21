/**
 * deposits (0005, 0026): money the shop holds for a customer. RLS scopes every query to the
 * caller's shop. Sums are done in SQL on numeric (exact decimal) and arrive as strings;
 * combining them is the domain's job. expected_date is read as text (to_char) so a JS Date
 * never shifts it across a timezone.
 *
 * Serving indexes (0005 / 0026): idx_deposits_held (shop_id, expected_date) WHERE held ->
 * the "มัดจำค้างอยู่" list and summary; idx_deposits_customer (shop_id, customer_id, status)
 * -> the check-in warning; idx_deposits_job -> a job's deposits; idx_deposits_received
 * (shop_id, received_at DESC) -> money in for a day; idx_deposits_closed (shop_id, closed_at
 * DESC) WHERE refunded|forfeited -> refunds and forfeits for a day; uq_deposits_idem.
 */
import { sql } from 'kysely'
import type { ScopedTx } from '@gsms/db/client.js'

export interface DepositRow {
  id: string
  customer_id: string
  customer_name: string | null
  customer_phone: string | null
  job_id: string | null
  job_number: string | null
  vehicle_id: string | null
  plate: string | null
  booking_id: string | null
  amount: string
  reason: string
  channel: string
  method: string
  payment_channel_id: string | null
  payment_channel_name: string | null
  slip_file_id: string | null
  slip_document_id: string | null
  slip_number: string | null
  expected_date: string
  status: string
  received_at: Date
  received_by_name: string | null
  applied_to_document_id: string | null
  applied_receipt_number: string | null
  closed_at: Date | null
  closed_by_name: string | null
  close_reason: string | null
  refund_channel_name: string | null
}

function base(trx: ScopedTx) {
  return trx.selectFrom('deposits as d')
    .innerJoin('customers as c', 'c.id', 'd.customer_id')
    .leftJoin('jobs as j', 'j.id', 'd.job_id')
    .leftJoin('vehicles as v', 'v.id', 'd.vehicle_id')
    .leftJoin('payment_channels as pc', 'pc.id', 'd.payment_channel_id')
    .leftJoin('payment_channels as cc', 'cc.id', 'd.closed_channel_id')
    .leftJoin('users as ru', 'ru.id', 'd.received_by')
    .leftJoin('users as cu', 'cu.id', 'd.closed_by')
    .leftJoin('documents as sd', 'sd.id', 'd.slip_document_id')
    .leftJoin('documents as ad', 'ad.id', 'd.applied_to_document_id')
    .select([
      'd.id', 'd.customer_id', 'c.name as customer_name', 'c.phone as customer_phone',
      'd.job_id', 'j.job_number', 'd.vehicle_id', 'v.plate', 'd.booking_id', 'd.amount', 'd.reason', 'd.channel', 'd.method',
      'd.payment_channel_id', 'pc.name as payment_channel_name', 'd.slip_file_id', 'd.slip_document_id', 'sd.number as slip_number',
      sql<string>`to_char(d.expected_date, 'YYYY-MM-DD')`.as('expected_date'),
      'd.status', 'd.received_at', 'ru.name as received_by_name', 'd.applied_to_document_id', 'ad.number as applied_receipt_number',
      'd.closed_at', 'cu.name as closed_by_name', 'd.close_reason', 'cc.name as refund_channel_name',
    ])
}

export async function getById(trx: ScopedTx, id: string): Promise<DepositRow | undefined> {
  return base(trx).where('d.id', '=', id).executeTakeFirst()
}

/**
 * Lock one deposit and read it back AFTER the lock - every decision about it is made from this row.
 * `FOR UPDATE OF d` only: the joins are read-only context (and a lock on the nullable side of an
 * outer join is not allowed).
 */
export async function lockById(trx: ScopedTx, id: string): Promise<DepositRow | undefined> {
  return base(trx).where('d.id', '=', id).forUpdate('d').executeTakeFirst()
}

/** Lock several deposits in id order (a stable order, so two closes never deadlock on each other). */
export async function lockMany(trx: ScopedTx, ids: readonly string[]): Promise<DepositRow[]> {
  if (ids.length === 0) return []
  return base(trx).where('d.id', 'in', [...ids]).orderBy('d.id', 'asc').forUpdate('d').execute()
}

export async function findByIdempotencyKey(trx: ScopedTx, key: string): Promise<DepositRow | undefined> {
  return base(trx).where('d.idempotency_key', '=', key).executeTakeFirst()
}

/** Serialise concurrent POSTs that carry the same key, so a retry never creates a second customer. */
export async function lockIdempotencyKey(trx: ScopedTx, key: string): Promise<void> {
  await sql`select pg_advisory_xact_lock(hashtextextended(${key}, 26))`.execute(trx)
}

export interface NewDeposit {
  shopId: string
  customerId: string
  jobId: string | null
  vehicleId: string | null
  bookingId: string | null
  amount: string
  reason: string
  method: string
  channel: string
  paymentChannelId: string
  slipFileId: string | null
  expectedDate: string
  receivedBy: string
  idempotencyKey: string
}

export async function insert(trx: ScopedTx, d: NewDeposit): Promise<string> {
  const r = await trx.insertInto('deposits').values({
    shop_id: d.shopId, customer_id: d.customerId, job_id: d.jobId, vehicle_id: d.vehicleId, booking_id: d.bookingId,
    amount: d.amount, reason: d.reason, method: d.method, channel: d.channel, payment_channel_id: d.paymentChannelId,
    slip_file_id: d.slipFileId, expected_date: d.expectedDate, received_by: d.receivedBy, idempotency_key: d.idempotencyKey,
  }).returning(['id']).executeTakeFirstOrThrow()
  return r.id
}

export async function attach(trx: ScopedTx, id: string, jobId: string, vehicleId: string | null): Promise<void> {
  await trx.updateTable('deposits').set({ job_id: jobId, vehicle_id: vehicleId }).where('id', '=', id).execute()
}

export async function detach(trx: ScopedTx, id: string): Promise<void> {
  await trx.updateTable('deposits').set({ job_id: null }).where('id', '=', id).execute()
}

export async function markRefunded(trx: ScopedTx, id: string, w: { by: string; reason: string; channelId: string | null; at: Date }): Promise<void> {
  await trx.updateTable('deposits').set({
    status: 'refunded', closed_at: w.at, closed_by: w.by, close_reason: w.reason, closed_channel_id: w.channelId,
  }).where('id', '=', id).execute()
}

export async function markForfeited(trx: ScopedTx, id: string, w: { by: string; reason: string; at: Date }): Promise<void> {
  await trx.updateTable('deposits').set({
    status: 'forfeited', closed_at: w.at, closed_by: w.by, close_reason: w.reason,
  }).where('id', '=', id).execute()
}

export async function markApplied(trx: ScopedTx, id: string, receiptId: string): Promise<void> {
  await trx.updateTable('deposits').set({ status: 'applied', applied_to_document_id: receiptId }).where('id', '=', id).execute()
}

/** A voided receipt gives its deposits back: applied -> held. Returns the ids released. */
export async function releaseAppliedTo(trx: ScopedTx, receiptId: string): Promise<string[]> {
  const rows = await trx.updateTable('deposits').set({ status: 'held', applied_to_document_id: null })
    .where('applied_to_document_id', '=', receiptId).where('status', '=', 'applied').returning(['id']).execute()
  return rows.map((r) => r.id)
}

export async function setSlipDocument(trx: ScopedTx, id: string, documentId: string): Promise<void> {
  await trx.updateTable('deposits').set({ slip_document_id: documentId }).where('id', '=', id).execute()
}

// -----------------------------------------------------------------------------
// Lists and totals ("มัดจำค้างอยู่")
// -----------------------------------------------------------------------------

export async function list(
  trx: ScopedTx,
  q: { status: string; overdueBefore: string | null; customerId: string | undefined; limit: number; offset: number },
): Promise<{ rows: DepositRow[]; total: number }> {
  let rows = base(trx).where('d.status', '=', q.status)
  let count = trx.selectFrom('deposits as d').select(sql<string>`count(*)`.as('n')).where('d.status', '=', q.status)
  if (q.overdueBefore) {
    rows = rows.where('d.expected_date', '<', sql<Date>`${q.overdueBefore}::date`)
    count = count.where('d.expected_date', '<', sql<Date>`${q.overdueBefore}::date`)
  }
  if (q.customerId) {
    rows = rows.where('d.customer_id', '=', q.customerId)
    count = count.where('d.customer_id', '=', q.customerId)
  }
  // Held: the ones the customer promised soonest (and overdue ones, oldest promise first) at the top.
  const ordered = q.status === 'held'
    ? rows.orderBy('d.expected_date', 'asc').orderBy('d.received_at', 'asc').orderBy('d.id', 'asc')
    : rows.orderBy('d.closed_at', 'desc').orderBy('d.received_at', 'desc').orderBy('d.id', 'asc')
  const [page, total] = await Promise.all([ordered.limit(q.limit).offset(q.offset).execute(), count.executeTakeFirstOrThrow()])
  return { rows: page, total: Number(total.n) }
}

export interface HeldSummary { held_count: number; held_total: string; overdue_count: number; overdue_total: string }

/** What the shop is holding for customers, over ALL held deposits (not the page). */
export async function heldSummary(trx: ScopedTx, today: string): Promise<HeldSummary> {
  const r = await trx.selectFrom('deposits')
    .select([
      sql<string>`count(*)`.as('held_count'),
      sql<string>`coalesce(sum(amount), 0)`.as('held_total'),
      sql<string>`count(*) filter (where expected_date < ${today}::date)`.as('overdue_count'),
      sql<string>`coalesce(sum(amount) filter (where expected_date < ${today}::date), 0)`.as('overdue_total'),
    ])
    .where('status', '=', 'held').executeTakeFirstOrThrow()
  return { held_count: Number(r.held_count), held_total: r.held_total, overdue_count: Number(r.overdue_count), overdue_total: r.overdue_total }
}

export async function slipPrintCounts(trx: ScopedTx, documentIds: readonly string[]): Promise<Map<string, number>> {
  if (documentIds.length === 0) return new Map()
  const rows = await trx.selectFrom('document_prints')
    .select(['subject_id', sql<string>`count(*)`.as('n')])
    .where('doc_type', '=', 'deposit_receipt').where('subject_id', 'in', [...documentIds]).groupBy('subject_id').execute()
  return new Map(rows.map((r) => [r.subject_id, Number(r.n)]))
}

// -----------------------------------------------------------------------------
// The warning (job open, job view, receipt view)
// -----------------------------------------------------------------------------

/**
 * Held deposits that belong to the person at the counter: the same customer, or a customer with
 * the same phone digits (an online deposit creates its own minimal customer, and the walk-in may
 * be matched to another row). A deposit already bound to a DIFFERENT job is not offered. The
 * caller passes phoneDigits = null when the phone is blank or on the match blocklist (a shared
 * placeholder number must never pull in strangers' money).
 */
export type MatchedBy = 'customer' | 'booking' | 'phone'

export async function warningsFor(
  trx: ScopedTx, q: { jobId: string; customerId: string; phoneDigits: string | null; bookingId?: string | null },
): Promise<Array<DepositRow & { matched_by: MatchedBy }>> {
  const bookingId = q.bookingId ?? null
  let qb = base(trx)
    .select(sql<string>`case
      when d.customer_id = ${q.customerId}::uuid then 'customer'
      when ${bookingId}::uuid is not null and d.booking_id = ${bookingId}::uuid then 'booking'
      else 'phone' end`.as('matched_by'))
    .where('d.status', '=', 'held')
    .where((eb) => eb.or([eb('d.job_id', 'is', null), eb('d.job_id', '=', q.jobId)]))
  qb = qb.where((eb) => {
    const arms = [eb('d.customer_id', '=', q.customerId)]
    if (bookingId) arms.push(eb('d.booking_id', '=', bookingId))
    if (q.phoneDigits) arms.push(eb(sql<string>`regexp_replace(coalesce(c.phone, ''), '[^0-9]', '', 'g')`, '=', q.phoneDigits))
    return eb.or(arms)
  })
  // Hard cap: a customer with more than 20 held deposits is a data problem, not a screen.
  const rows = await qb.orderBy('d.expected_date', 'asc').orderBy('d.received_at', 'asc').limit(20).execute()
  return rows as Array<DepositRow & { matched_by: MatchedBy }>
}

export async function heldOfJob(trx: ScopedTx, jobId: string): Promise<DepositRow[]> {
  return base(trx).where('d.job_id', '=', jobId).where('d.status', '=', 'held').orderBy('d.received_at', 'asc').limit(20).execute()
}

export async function appliedViaJob(trx: ScopedTx, jobId: string): Promise<DepositRow[]> {
  return base(trx).where('d.job_id', '=', jobId).where('d.status', '=', 'applied').orderBy('d.received_at', 'asc').limit(20).execute()
}

export async function vehicleOfJob(trx: ScopedTx, jobId: string): Promise<string | null> {
  const r = await trx.selectFrom('jobs').select(['vehicle_id']).where('id', '=', jobId).executeTakeFirst()
  return r?.vehicle_id ?? null
}

export async function bookingOfJob(trx: ScopedTx, jobId: string): Promise<string | null> {
  const r = await trx.selectFrom('jobs').select(['booking_id']).where('id', '=', jobId).executeTakeFirst()
  return r?.booking_id ?? null
}

// -----------------------------------------------------------------------------
// The offsets on a receipt
// -----------------------------------------------------------------------------

export interface OffsetRow {
  payment_id: string
  deposit_id: string
  amount: string
  channel: string
  payment_channel_name: string | null
  slip_number: string | null
  received_at: Date
  reversed: boolean
}

export async function offsetsOfReceipt(trx: ScopedTx, receiptId: string): Promise<OffsetRow[]> {
  const rows = await trx.selectFrom('payments as p')
    .innerJoin('deposits as d', 'd.id', 'p.deposit_id')
    .leftJoin('payment_channels as pc', 'pc.id', 'd.payment_channel_id')
    .leftJoin('documents as sd', 'sd.id', 'd.slip_document_id')
    .leftJoin('payment_reversals as r', 'r.payment_id', 'p.id')
    .select(['p.id as payment_id', 'p.deposit_id', 'p.amount', 'd.channel', 'pc.name as payment_channel_name', 'sd.number as slip_number', 'p.received_at', 'r.id as reversal_id'])
    .where('p.document_id', '=', receiptId).where('p.method', '=', 'deposit_offset')
    .orderBy('p.received_at', 'asc').orderBy('p.id', 'asc').execute()
  return rows.map((r) => ({
    payment_id: r.payment_id, deposit_id: r.deposit_id!, amount: r.amount, channel: r.channel,
    payment_channel_name: r.payment_channel_name, slip_number: r.slip_number, received_at: r.received_at, reversed: r.reversal_id !== null,
  }))
}

export async function insertOffsetPayment(
  trx: ScopedTx, p: { shopId: string; documentId: string; depositId: string; amount: string; receivedBy: string; receivedAt: Date },
): Promise<string> {
  // A payment row, not a discount: grand_total is untouched. No channel (the money was received, and counted,
  // through the deposit's own channel on the day it came in) and no surcharge.
  const r = await trx.insertInto('payments').values({
    shop_id: p.shopId, document_id: p.documentId, deposit_id: p.depositId, method: 'deposit_offset', amount: p.amount,
    payment_channel_id: null, surcharge_amount: '0', change_given: '0', received_by: p.receivedBy, received_at: p.receivedAt,
  }).returning(['id']).executeTakeFirstOrThrow()
  return r.id
}

// -----------------------------------------------------------------------------
// The slip document (type deposit_receipt, series DEP)
// -----------------------------------------------------------------------------

export async function allocateSlipNumber(trx: ScopedTx, shopId: string): Promise<string> {
  const result = await sql<{ n: string }>`select allocate_document_number(${shopId}::uuid, 'DEP') as n`.execute(trx)
  const n = result.rows[0]?.n
  if (!n) throw new Error('allocate_document_number returned nothing')
  return n
}

/**
 * Insert the slip as a draft (trg_documents_insert_draft refuses anything else) and number it in
 * the same statement sequence, inside the caller's transaction. job_id stays NULL for good: the
 * slip is about the money, and the job it later joins can change; the quotation number, if any,
 * is frozen into the snapshot.
 */
export async function insertIssuedSlip(trx: ScopedTx, w: {
  shopId: string; customerId: string; number: string; numberedOn: string; amount: string; issuedBy: string; issuedAt: Date; snapshot: unknown
}): Promise<string> {
  const draft = await trx.insertInto('documents').values({
    shop_id: w.shopId, customer_id: w.customerId, type: 'deposit_receipt', series: 'DEP', job_id: null,
  }).returning(['id']).executeTakeFirstOrThrow()
  await trx.updateTable('documents').set({
    number: w.number, numbered_on: sql`${w.numberedOn}::date`, status: 'issued', issued_at: w.issuedAt, issued_by: w.issuedBy,
    grand_total: w.amount, deposit_snapshot: JSON.stringify(w.snapshot),
  }).where('id', '=', draft.id).execute()
  return draft.id
}

export async function getSlipSnapshot(trx: ScopedTx, documentId: string): Promise<{ number: string; snapshot: unknown } | undefined> {
  const r = await trx.selectFrom('documents').select(['number', 'deposit_snapshot'])
    .where('id', '=', documentId).where('type', '=', 'deposit_receipt').executeTakeFirst()
  return r && r.number ? { number: r.number, snapshot: r.deposit_snapshot } : undefined
}

// -----------------------------------------------------------------------------
// Slip image
// -----------------------------------------------------------------------------

/** A file of THIS shop (RLS) of the deposit_slip kind that no deposit uses yet. */
export async function freeSlipFile(trx: ScopedTx, fileId: string): Promise<boolean> {
  const f = await trx.selectFrom('files').select(['id']).where('id', '=', fileId).where('kind', '=', 'deposit_slip').executeTakeFirst()
  if (!f) return false
  const used = await trx.selectFrom('deposits').select(['id']).where('slip_file_id', '=', fileId).executeTakeFirst()
  return !used
}

export async function bookingExists(trx: ScopedTx, bookingId: string): Promise<boolean> {
  const r = await trx.selectFrom('bookings').select(['id']).where('id', '=', bookingId).executeTakeFirst()
  return !!r
}

// -----------------------------------------------------------------------------
// The daily summary (by the day the money moved)
// -----------------------------------------------------------------------------

export interface DepositMoneyRow { channel_id: string | null; name: string | null; kind: string; amount: string; rows: number }

/** Deposits received in [start, end): the money came in that day, by the channel it came through. */
export async function receivedBetween(trx: ScopedTx, start: Date, end: Date): Promise<DepositMoneyRow[]> {
  const rows = await trx.selectFrom('deposits as d').leftJoin('payment_channels as pc', 'pc.id', 'd.payment_channel_id')
    .select([
      'd.payment_channel_id as channel_id', 'pc.name as name', 'd.method as kind',
      sql<string>`coalesce(sum(d.amount), 0)`.as('amount'), sql<string>`count(*)`.as('rows'),
    ])
    .where('d.received_at', '>=', start).where('d.received_at', '<', end)
    .groupBy(['d.payment_channel_id', 'pc.name', 'd.method']).execute()
  return rows.map((r) => ({ ...r, rows: Number(r.rows) }))
}

/**
 * Deposits refunded in [start, end): money that went back out that day, through the refund channel
 * (or the receiving channel when none was named). The kind is the channel's kind, so a transfer
 * deposit refunded in cash is cash out of the drawer.
 */
export async function refundedBetween(trx: ScopedTx, start: Date, end: Date): Promise<DepositMoneyRow[]> {
  const rows = await trx.selectFrom('deposits as d')
    .leftJoin('payment_channels as rc', (join) => join.on(sql<boolean>`rc.id = coalesce(d.closed_channel_id, d.payment_channel_id)`))
    .select([
      sql<string | null>`coalesce(d.closed_channel_id, d.payment_channel_id)`.as('channel_id'), 'rc.name as name',
      sql<string>`coalesce(rc.kind, d.method)`.as('kind'),
      sql<string>`coalesce(sum(d.amount), 0)`.as('amount'), sql<string>`count(*)`.as('rows'),
    ])
    .where('d.status', '=', 'refunded').where('d.closed_at', '>=', start).where('d.closed_at', '<', end)
    .groupBy([sql`coalesce(d.closed_channel_id, d.payment_channel_id)`, 'rc.name', sql`coalesce(rc.kind, d.method)`]).execute()
  return rows.map((r) => ({ channel_id: r.channel_id, name: r.name, kind: r.kind, amount: r.amount, rows: Number(r.rows) }))
}

export interface ForfeitRow { id: string; amount: string; slip_number: string | null; close_reason: string | null; decided_by_name: string | null }

/** Deposits forfeited in [start, end). Hard cap: one shop-day. */
export async function forfeitedBetween(trx: ScopedTx, start: Date, end: Date): Promise<ForfeitRow[]> {
  return trx.selectFrom('deposits as d')
    .leftJoin('documents as sd', 'sd.id', 'd.slip_document_id').leftJoin('users as u', 'u.id', 'd.closed_by')
    .select(['d.id', 'd.amount', 'sd.number as slip_number', 'd.close_reason', 'u.name as decided_by_name'])
    .where('d.status', '=', 'forfeited').where('d.closed_at', '>=', start).where('d.closed_at', '<', end)
    .orderBy('d.closed_at', 'asc').limit(500).execute()
}
