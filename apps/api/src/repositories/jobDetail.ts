/**
 * Reads for one job on its own, and for today's delivered jobs.
 *
 * These read `jobs` directly rather than queue_board, on purpose: queue_board
 * is the BOARD, and a delivered, rejected or carout job is by definition not
 * on it (job_board_state.on_board, migration 0018). CLAUDE.md §5.8 rule 4 —
 * "the queue screen reads one view" — is about the board, and is untouched:
 * nothing here feeds /today or the public screen.
 *
 * Every function takes a ScopedTx, so RLS scopes every row to the caller's
 * shop; another shop's job is simply not found.
 */
import { sql } from 'kysely'
import type { ScopedTx } from '@gsms/db/client.js'

export interface JobDetailRow {
  job_id: string
  job_number: string
  queue_no: number | null
  status: string
  sub_state: string | null
  job_type: string
  has_booking: boolean
  plate: string | null
  province: string | null
  brand: string | null
  model: string | null
  color: string | null
  customer_name: string | null
  bay_name: string | null
  created_at: Date
  status_changed_at: Date
  on_board: boolean
}

export async function jobById(trx: ScopedTx, jobId: string): Promise<JobDetailRow | undefined> {
  return trx
    .selectFrom('jobs as j')
    .innerJoin('job_board_state as t', 't.job_id', 'j.id')
    .leftJoin('customers as c', 'c.id', 'j.customer_id')
    .leftJoin('vehicles as v', 'v.id', 'j.vehicle_id')
    .leftJoin('bays as b', 'b.id', 'j.bay_id')
    .select([
      'j.id as job_id',
      'j.job_number',
      'j.queue_no',
      'j.status',
      'j.sub_state',
      'j.job_type',
      sql<boolean>`j.booking_id IS NOT NULL`.as('has_booking'),
      'v.plate',
      'v.province',
      'v.brand',
      'v.model',
      'v.color',
      'c.name as customer_name',
      'b.name as bay_name',
      'j.created_at',
      sql<Date>`t.status_changed_at`.as('status_changed_at'),
      sql<boolean>`t.on_board`.as('on_board'),
    ])
    .where('j.id', '=', jobId)
    .where('j.deleted_at', 'is', null)
    .executeTakeFirst()
}

export interface HistoryRow {
  status: string
  changed_at: Date
  changed_by: string | null
  actor_name: string | null
  reason: string | null
}

/**
 * The job's history, oldest first, with the display name of whoever made each
 * move, and the reason where one was required (migration 0019). The name
 * only — the users row also holds a login id, which is never selected here.
 */
export async function historyWithActors(
  trx: ScopedTx,
  jobId: string,
): Promise<HistoryRow[]> {
  return trx
    .selectFrom('job_status_history as h')
    .leftJoin('users as u', 'u.id', 'h.changed_by')
    .select([
      'h.status',
      'h.changed_at',
      'h.changed_by',
      'u.name as actor_name',
      'h.reason',
    ])
    .where('h.job_id', '=', jobId)
    .orderBy('h.changed_at', 'asc')
    .orderBy('h.id', 'asc')
    .execute()
}

export interface DeliveredRow {
  job_id: string
  job_number: string
  queue_no: number | null
  plate: string | null
  province: string | null
  brand: string | null
  model: string | null
  customer_name: string | null
  delivered_at: Date
}

/**
 * Jobs whose CURRENT status is delivered and whose delivery happened in
 * [from, to) — the counter's list for finding a mistaken "ส่งแล้ว". Newest
 * delivery first. Paged, with the total, per CLAUDE.md §9.
 *
 * delivered_at is job_board_state.status_changed_at: the latest 'delivered'
 * history row for a job that is delivered now.
 */
export async function deliveredBetween(
  trx: ScopedTx,
  from: Date,
  to: Date,
  limit: number,
  offset: number,
): Promise<{ rows: DeliveredRow[]; total: number }> {
  const base = trx
    .selectFrom('jobs as j')
    .innerJoin('job_board_state as t', 't.job_id', 'j.id')
    .where('j.status', '=', 'delivered')
    .where('j.deleted_at', 'is', null)
    .where(sql<boolean>`t.status_changed_at >= ${from}`)
    .where(sql<boolean>`t.status_changed_at < ${to}`)

  const [rows, count] = await Promise.all([
    base
      .leftJoin('customers as c', 'c.id', 'j.customer_id')
      .leftJoin('vehicles as v', 'v.id', 'j.vehicle_id')
      .select([
        'j.id as job_id',
        'j.job_number',
        'j.queue_no',
        'v.plate',
        'v.province',
        'v.brand',
        'v.model',
        'c.name as customer_name',
        sql<Date>`t.status_changed_at`.as('delivered_at'),
      ])
      .orderBy(sql`t.status_changed_at desc`)
      .orderBy('j.id', 'asc')
      .limit(limit)
      .offset(offset)
      .execute(),
    base.select(sql<string>`count(*)`.as('n')).executeTakeFirstOrThrow(),
  ])
  return { rows, total: Number(count.n) }
}
