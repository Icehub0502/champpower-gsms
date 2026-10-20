/**
 * Queries behind the daily summary and the cash count. Every range is a Bangkok
 * day expressed as [start, end) instants (lib/bangkokDate.ts), so 23:59 and
 * 00:01 fall on different days and UTC never decides. Sums are done in SQL on
 * numeric (exact decimal) and arrive as strings; combining them is the domain's
 * job. Served by idx_payments_day (shop_id, received_at DESC),
 * idx_payment_reversals_day and idx_documents_type_issued (0004/0025).
 */
import { sql } from 'kysely'
import type { ScopedTx } from '@gsms/db/client.js'

export interface MethodSums { method: string; received: string; change: string; rows: number; change_rows: number }

export async function paymentSumsByMethod(trx: ScopedTx, start: Date, end: Date): Promise<MethodSums[]> {
  const rows = await trx.selectFrom('payments')
    .select([
      'method',
      sql<string>`coalesce(sum(amount), 0)`.as('received'),
      sql<string>`coalesce(sum(change_given), 0)`.as('change'),
      sql<string>`count(*)`.as('rows'),
      sql<string>`count(*) filter (where change_given > 0)`.as('change_rows'),
    ])
    .where('received_at', '>=', start).where('received_at', '<', end)
    // Money taken as a deposit was counted the day it came in; offsetting it is not new money.
    .where('method', '<>', 'deposit_offset')
    .groupBy('method').execute()
  return rows.map((r) => ({ method: r.method, received: r.received, change: r.change, rows: Number(r.rows), change_rows: Number(r.change_rows) }))
}

export async function reversalSumsByMethod(trx: ScopedTx, start: Date, end: Date): Promise<Array<{ method: string; amount: string; rows: number }>> {
  const rows = await trx.selectFrom('payment_reversals')
    .select(['method', sql<string>`coalesce(sum(amount), 0)`.as('amount'), sql<string>`count(*)`.as('rows')])
    .where('reversed_at', '>=', start).where('reversed_at', '<', end)
    .where('method', '<>', 'deposit_offset')
    .groupBy('method').execute()
  return rows.map((r) => ({ method: r.method, amount: r.amount, rows: Number(r.rows) }))
}

export interface DayReceipt {
  id: string
  number: string
  customer_id: string
  status: string
  bill_subtotal: string | null
  discount: string
  grand_total: string
  approved_total: string
  discount_reason: string | null
  discount_approved_by: string | null
  approved_by_name: string | null
}

/** Receipts numbered on this day (issued, or issued and since voided). Hard cap: one shop-day. */
export async function receiptsIssuedBetween(trx: ScopedTx, start: Date, end: Date): Promise<DayReceipt[]> {
  return trx.selectFrom('documents as d').leftJoin('users as u', 'u.id', 'd.discount_approved_by')
    .select([
      'd.id', 'd.number', 'd.customer_id', 'd.status', 'd.bill_subtotal', 'd.discount', 'd.grand_total',
      'd.approved_total', 'd.discount_reason', 'd.discount_approved_by', 'u.name as approved_by_name',
    ])
    .where('d.type', '=', 'receipt').where('d.status', 'in', ['issued', 'void'])
    .where('d.issued_at', '>=', start).where('d.issued_at', '<', end)
    .orderBy('d.issued_at', 'asc').limit(1000).execute() as Promise<DayReceipt[]>
}

export async function receiptsVoidedBetween(trx: ScopedTx, start: Date, end: Date): Promise<Array<{ grand_total: string }>> {
  return trx.selectFrom('documents').select(['grand_total'])
    .where('type', '=', 'receipt').where('status', '=', 'void')
    .where('voided_at', '>=', start).where('voided_at', '<', end).limit(1000).execute()
}

export async function warrantyClaimsDeliveredBetween(trx: ScopedTx, start: Date, end: Date): Promise<number> {
  const r = await trx.selectFrom('job_status_history as h').innerJoin('jobs as j', 'j.id', 'h.job_id')
    .select(sql<string>`count(distinct h.job_id)`.as('n'))
    .where('h.status', '=', 'delivered').where('j.job_type', '=', 'warranty_claim')
    .where('h.changed_at', '>=', start).where('h.changed_at', '<', end).executeTakeFirstOrThrow()
  return Number(r.n)
}

export async function cashReceivedAfter(trx: ScopedTx, start: Date, end: Date, after: Date): Promise<string> {
  const r = await trx.selectFrom('payments')
    .select(sql<string>`coalesce(sum(amount - change_given), 0)`.as('n'))
    .where('method', '=', 'cash')
    .where('received_at', '>=', start).where('received_at', '<', end).where('received_at', '>', after)
    .executeTakeFirstOrThrow()
  return r.n
}

export interface ClosingRow {
  id: string
  business_date: string
  revision: number
  expected_cash: string
  counted_cash: string
  variance: string | null
  note: string | null
  recount_reason: string | null
  closed_by_name: string | null
  closed_at: Date
}

export async function closingsOfDate(trx: ScopedTx, date: string): Promise<ClosingRow[]> {
  return trx.selectFrom('daily_closings as c').leftJoin('users as u', 'u.id', 'c.closed_by')
    .select([
      'c.id', sql<string>`to_char(c.business_date, 'YYYY-MM-DD')`.as('business_date'), 'c.revision', 'c.expected_cash', 'c.counted_cash', 'c.variance', 'c.note',
      'c.recount_reason', 'u.name as closed_by_name', 'c.closed_at',
    ])
    .where('c.business_date', '=', sql<Date>`${date}::date`)
    .orderBy('c.revision', 'asc').execute() as Promise<ClosingRow[]>
}

/** One count per (shop, day) at a time: counts for the same day queue here; the unique index is the backstop. */
export async function lockCountDay(trx: ScopedTx, shopId: string, date: string): Promise<void> {
  await sql`select pg_advisory_xact_lock(hashtextextended(${'cash_count:' + shopId + ':' + date}, 0))`.execute(trx)
}

export async function insertClosing(trx: ScopedTx, c: {
  shopId: string; date: string; revision: number; expected: string; counted: string; note: string | null
  recountReason: string | null; supersedes: string | null; by: string
}): Promise<string> {
  const r = await trx.insertInto('daily_closings').values({
    shop_id: c.shopId, business_date: sql<Date>`${c.date}::date`, revision: c.revision,
    expected_cash: c.expected, counted_cash: c.counted, note: c.note, recount_reason: c.recountReason,
    supersedes_closing_id: c.supersedes, closed_by: c.by,
  }).returning(['id']).executeTakeFirstOrThrow()
  return r.id
}
