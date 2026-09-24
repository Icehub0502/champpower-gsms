/**
 * Reads for the /today kanban.
 *
 * `queue_board` and nothing else for the cars — plus bays for the name and
 * job_complaints for the card's one-line symptom. The single-view rule is
 * CLAUDE.md §5.8 rule 4: the prototype asked two sources and concatenated
 * them, and that is how a car that had already arrived showed up twice.
 *
 * No date predicate on the job rows. Whether a job belongs on a board at all
 * is decided ONCE, in the view job_board_state (migration 0016), and
 * queue_board already applies it. Adding a date here would be the bug the
 * user ruled out in WO-003-ANSWERS.md §a — a car still on the lift vanishing
 * at midnight.
 */
import { sql } from 'kysely'
import type { ScopedTx } from '@gsms/db/client.js'

/**
 * A safety cap, not pagination. The kanban's KPIs and pulse are totals over
 * the whole board, so paging it would make the headline numbers describe one
 * page. The board is bounded by the physical workshop — tens of cars — and
 * this cap only exists so that a bug upstream (a filter that stops working)
 * degrades into a truncated board with `truncated: true` rather than an
 * unbounded response. CLAUDE.md §9's "no list returns a whole table" is the
 * rule this honours.
 */
export const BOARD_ROW_CAP = 500

export interface BoardJobRow {
  job_id: string
  job_number: string | null
  queue_no: number | null
  status: string
  sub_state: string | null
  job_type: string | null
  source: string | null
  plate: string | null
  brand: string | null
  model: string | null
  color: string | null
  customer_name: string | null
  phone: string | null
  bay_id: string | null
  bay_name: string | null
  bay_sort: number | null
  symptom: string | null
  booking_slot_start: Date | null
  thumb_file_id: string | null
  created_at: Date
  status_changed_at: Date | null
  left_received_at: Date | null
  repair_started_at: Date | null
  repair_ended_at: Date | null
  est_value: string | null
  est_unit: string | null
}

export async function boardJobs(
  trx: ScopedTx,
): Promise<{ rows: BoardJobRow[]; truncated: boolean }> {
  const rows = await trx
    .selectFrom('queue_board as q')
    .leftJoin('bays as bay', 'bay.id', 'q.bay_id')
    .select([
      sql<string>`q.ref_id`.as('job_id'),
      'q.job_number',
      'q.queue_no',
      sql<string>`q.status`.as('status'),
      'q.sub_state',
      'q.job_type',
      'q.source',
      'q.plate',
      'q.brand',
      'q.model',
      'q.color',
      'q.customer_name',
      'q.phone',
      'q.bay_id',
      'bay.name as bay_name',
      'bay.sort_order as bay_sort',
      // The card's detail line: the first complaint, by the order staff
      // entered them. A correlated subquery rather than a join so a job with
      // several complaints still yields exactly one row.
      sql<string | null>`(
        select c.text from job_complaints c
         where c.job_id = q.ref_id
         order by c.sort_order, c.id
         limit 1)`.as('symptom'),
      'q.booking_slot_start',
      'q.thumb_file_id',
      sql<Date>`q.at`.as('created_at'),
      'q.status_changed_at',
      'q.left_received_at',
      'q.repair_started_at',
      'q.repair_ended_at',
      sql<string | null>`q.est_value::text`.as('est_value'),
      'q.est_unit',
    ])
    .where('q.kind', '=', 'job')
    // Queue number is the order the floor calls cars in; arrival breaks ties
    // and ref_id makes the order deterministic.
    .orderBy(sql`q.queue_no asc nulls last`)
    .orderBy(sql`q.at asc`)
    .orderBy(sql`q.ref_id asc`)
    .limit(BOARD_ROW_CAP + 1)
    .execute()

  return { rows: rows.slice(0, BOARD_ROW_CAP), truncated: rows.length > BOARD_ROW_CAP }
}

export interface BoardBookingRow {
  booking_id: string
  at: Date
  status: string
  source: string
  bay_id: string | null
  bay_name: string | null
  customer_name: string | null
  phone: string | null
  plate: string | null
  brand: string | null
  model: string | null
  note: string | null
}

/**
 * Cars expected in [from, to) that have not arrived. The window applies to
 * BOOKINGS only — which is exactly where a date belongs: a booking is an
 * appointment for a day, a job is a car that is here.
 */
export async function boardBookings(
  trx: ScopedTx,
  from: Date,
  to: Date,
): Promise<BoardBookingRow[]> {
  return trx
    .selectFrom('queue_board as q')
    .leftJoin('bays as bay', 'bay.id', 'q.bay_id')
    .select([
      sql<string>`q.ref_id`.as('booking_id'),
      sql<Date>`q.at`.as('at'),
      sql<string>`q.status`.as('status'),
      sql<string>`q.source`.as('source'),
      'q.bay_id',
      'bay.name as bay_name',
      'q.customer_name',
      'q.phone',
      'q.plate',
      'q.brand',
      'q.model',
      'q.note',
    ])
    .where('q.kind', '=', 'booking')
    .where('q.at', '>=', from)
    .where('q.at', '<', to)
    .orderBy('q.at', 'asc')
    .orderBy('q.ref_id', 'asc')
    .limit(BOARD_ROW_CAP)
    .execute()
}

/** Every bay the shop has, active or not — the pulse needs the active count. */
export async function shopBays(
  trx: ScopedTx,
): Promise<{ id: string; is_active: boolean }[]> {
  return trx.selectFrom('bays').select(['id', 'is_active']).execute()
}
