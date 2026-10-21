/**
 * Queries behind the daily summary. Every range is a Bangkok day expressed as
 * [start, end) instants (lib/bangkokDate.ts), so 23:59 and 00:01 fall on
 * different days and UTC never decides. Sums are done in SQL on numeric (exact
 * decimal) and arrive as strings; combining them is the domain's job. Served by
 * idx_payments_day (shop_id, received_at DESC), idx_payment_reversals_day and
 * idx_documents_type_issued (0004/0025). RLS scopes every query to the caller's shop.
 */
import { sql } from 'kysely'
import type { ScopedTx } from '@gsms/db/client.js'

export interface MethodSums { method: string; received: string; change: string; surcharge: string; rows: number; change_rows: number }

export async function paymentSumsByMethod(trx: ScopedTx, start: Date, end: Date): Promise<MethodSums[]> {
  const rows = await trx.selectFrom('payments')
    .select([
      'method',
      sql<string>`coalesce(sum(amount), 0)`.as('received'),
      sql<string>`coalesce(sum(change_given), 0)`.as('change'),
      sql<string>`coalesce(sum(surcharge_amount), 0)`.as('surcharge'),
      sql<string>`count(*)`.as('rows'),
      sql<string>`count(*) filter (where change_given > 0)`.as('change_rows'),
    ])
    .where('received_at', '>=', start).where('received_at', '<', end)
    // Money taken as a deposit was counted the day it came in; offsetting it is not new money.
    .where('method', '<>', 'deposit_offset')
    .groupBy('method').execute()
  return rows.map((r) => ({ method: r.method, received: r.received, change: r.change, surcharge: r.surcharge, rows: Number(r.rows), change_rows: Number(r.change_rows) }))
}

export interface ChannelSums { channel_id: string | null; name: string | null; kind: string; received: string; change: string; surcharge: string }

export async function paymentSumsByChannel(trx: ScopedTx, start: Date, end: Date): Promise<ChannelSums[]> {
  const rows = await trx.selectFrom('payments as p')
    .leftJoin('payment_channels as c', 'c.id', 'p.payment_channel_id')
    .select([
      'p.payment_channel_id as channel_id', 'c.name as name', 'p.method as kind',
      sql<string>`coalesce(sum(p.amount), 0)`.as('received'),
      sql<string>`coalesce(sum(p.change_given), 0)`.as('change'),
      sql<string>`coalesce(sum(p.surcharge_amount), 0)`.as('surcharge'),
    ])
    .where('p.received_at', '>=', start).where('p.received_at', '<', end).where('p.method', '<>', 'deposit_offset')
    .groupBy(['p.payment_channel_id', 'c.name', 'p.method']).execute()
  return rows
}

export async function reversalSumsByChannel(trx: ScopedTx, start: Date, end: Date): Promise<Array<{ channel_id: string | null; name: string | null; kind: string; amount: string; rows: number }>> {
  const rows = await trx.selectFrom('payment_reversals as r')
    .leftJoin('payment_channels as c', 'c.id', 'r.payment_channel_id')
    .select([
      'r.payment_channel_id as channel_id', 'c.name as name', 'r.method as kind',
      sql<string>`coalesce(sum(r.amount), 0)`.as('amount'), sql<string>`count(*)`.as('rows'),
    ])
    .where('r.reversed_at', '>=', start).where('r.reversed_at', '<', end).where('r.method', '<>', 'deposit_offset')
    .groupBy(['r.payment_channel_id', 'c.name', 'r.method']).execute()
  return rows.map((r) => ({ ...r, rows: Number(r.rows) }))
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
  /** Sum of line_discount over the receipt's lines. */
  line_discounts: string
  /** Sum of the channel surcharges taken on this receipt. */
  surcharge: string
}

/** Receipts numbered on this day (issued, or issued and since voided). Hard cap: one shop-day. */
export async function receiptsIssuedBetween(trx: ScopedTx, start: Date, end: Date): Promise<DayReceipt[]> {
  const rows = await trx.selectFrom('documents as d').leftJoin('users as u', 'u.id', 'd.discount_approved_by')
    .select([
      'd.id', 'd.number', 'd.customer_id', 'd.status', 'd.bill_subtotal', 'd.discount', 'd.grand_total',
      'd.approved_total', 'd.discount_reason', 'd.discount_approved_by', 'u.name as approved_by_name',
      sql<string>`coalesce((select sum(l.line_discount) from document_lines l where l.document_id = d.id), 0)`.as('line_discounts'),
      sql<string>`coalesce((select sum(p.surcharge_amount) from payments p where p.document_id = d.id), 0)`.as('surcharge'),
    ])
    .where('d.type', '=', 'receipt').where('d.status', 'in', ['issued', 'void'])
    .where('d.issued_at', '>=', start).where('d.issued_at', '<', end)
    .orderBy('d.issued_at', 'asc').limit(1000).execute()
  return rows as DayReceipt[]
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
