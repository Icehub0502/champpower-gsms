/**
 * The queue board.
 *
 * This reads the `queue_board` view and NOTHING else — plus one LEFT JOIN to
 * `bays` for the label, because the view exposes `bay_id` but no name and
 * 0013 is not to be modified for a cosmetic column.
 *
 * The single-source rule is the entire point (CLAUDE.md §5.8 rule 4). In the
 * prototype the screen asked bookings and jobs separately and concatenated the
 * two lists in the browser, so a booking that had already become a job
 * appeared twice — the "old one bounced back" symptom. Here the view's own
 * `NOT EXISTS (SELECT 1 FROM jobs WHERE booking_id = b.id)` removes the
 * booking the instant the job exists, with nobody deleting anything. If a
 * second query ever appears in this file, that bug is back.
 *
 * `queue_board` is declared WITH (security_invoker = true), so the base tables'
 * RLS applies to the caller: inside `withShop` the board is this shop's board,
 * without any `where shop_id` of its own.
 */
import { sql } from 'kysely'
import type { ScopedTx } from '@gsms/db/client.js'

export interface QueueBoardDbRow {
  kind: string | null
  ref_id: string | null
  bay_id: string | null
  bay_name: string | null
  at: Date | null
  status: string | null
  source: string | null
  customer_name: string | null
  phone: string | null
  plate: string | null
  brand: string | null
  model: string | null
  color: string | null
  queue_no: number | null
  job_id: string | null
  job_type: string | null
  thumb_file_id: string | null
  assigned_technician_id: string | null
  assigned_team_id: string | null
  note: string | null
}

export interface BoardWindow {
  /** Inclusive lower bound, applied to BOOKING rows only. */
  from: Date
  /** Exclusive upper bound, applied to BOOKING rows only. */
  to: Date
  limit: number
  offset: number
}

/**
 * The date window covers bookings and leaves jobs alone.
 *
 * A car that came in yesterday and is still on the ramp must stay on the
 * board; filtering the job half by date is exactly the bug that made
 * `queue_today` the wrong name (WO-003-ANSWERS.md §a) — cars vanishing at
 * midnight. Next month's bookings, on the other hand, would bury today's work,
 * so those are windowed.
 */
function windowed(w: BoardWindow) {
  // Written once and used by both the count and the page, so the total can
  // never describe a different set of rows than the one returned. The bounds
  // are bound parameters, not interpolated text.
  return sql<boolean>`(q.kind = 'job' or (q.at >= ${w.from} and q.at < ${w.to}))`
}

export async function listBoard(
  trx: ScopedTx,
  w: BoardWindow,
): Promise<{ items: QueueBoardDbRow[]; total: number }> {
  const totalRow = await trx
    .selectFrom('queue_board as q')
    .select(sql<number>`count(*)`.as('n'))
    .where(windowed(w))
    .executeTakeFirst()

  const items = await trx
    .selectFrom('queue_board as q')
    .leftJoin('bays as bay', 'bay.id', 'q.bay_id')
    .select([
      'q.kind as kind',
      'q.ref_id as ref_id',
      'q.bay_id as bay_id',
      'bay.name as bay_name',
      'q.at as at',
      'q.status as status',
      'q.source as source',
      'q.customer_name as customer_name',
      'q.phone as phone',
      'q.plate as plate',
      'q.brand as brand',
      'q.model as model',
      'q.color as color',
      'q.queue_no as queue_no',
      'q.job_id as job_id',
      'q.job_type as job_type',
      'q.thumb_file_id as thumb_file_id',
      'q.assigned_technician_id as assigned_technician_id',
      'q.assigned_team_id as assigned_team_id',
      'q.note as note',
    ])
    .where(windowed(w))
    // A workshop board is read bay by bay, and within a bay by the number
    // called across the floor. Cars with no bay and no number yet (a walk-in
    // being written up, a booking for Thursday) sort last, by time.
    .orderBy(sql`bay.sort_order asc nulls last`)
    .orderBy(sql`q.queue_no asc nulls last`)
    .orderBy(sql`q.at asc`)
    // Deterministic paging: without a unique tiebreaker two rows sharing a
    // bay, number and time can trade places between pages.
    .orderBy(sql`q.ref_id asc`)
    .limit(w.limit)
    .offset(w.offset)
    .execute()

  return { items, total: Number(totalRow?.n ?? 0) }
}
