/**
 * Reads for the unauthenticated waiting-room screen.
 *
 * THE TABLES THIS FILE MAY READ ARE: shops (to resolve the token), jobs,
 * vehicles, bays, and the view job_board_state. That is the whole list.
 *
 *   - It does NOT read `customers`, and it does not JOIN customers even to
 *     filter. A name or phone cannot reach this screen through a later edit
 *     to a SELECT list if the table is not in the query at all.
 *   - It does NOT read `queue_board`. That view carries customer_name and
 *     phone for the authenticated kanban; reading it here and "just not
 *     selecting those two columns" is one careless edit from a leak.
 *   - job_board_state holds ids and timestamps only, which is why it is safe
 *     here, and why reading it keeps this screen and the kanban agreeing on
 *     which cars exist (one membership rule: `on_board`, migration 0016).
 *
 * Every column below is named. No SELECT *, and no price, complaint text or
 * photo — a car photo on an unauthenticated screen needs signed URLs and the
 * customer's consent, neither of which exists yet.
 */
import { sql } from 'kysely'
import type { ScopedTx, UnscopedTx } from '@gsms/db/client.js'

/** A waiting room shows a workshop's worth of cars. This bounds a runaway. */
export const PUBLIC_BOARD_CAP = 200

/**
 * The shop behind a public token, or undefined.
 *
 * Read through `unscoped` because nothing is known about the caller yet:
 * `shops` is an identity table with no shop_id and no RLS (0001), exactly like
 * users and sessions, and is the only table this function touches. Everything
 * after this call runs inside withShop() for the shop it returns.
 */
export async function shopByToken(
  trx: UnscopedTx,
  token: string,
): Promise<{ id: string; name: string } | undefined> {
  return trx
    .selectFrom('shops')
    .select(['id', 'name'])
    .where('public_board_token', '=', token)
    .executeTakeFirst()
}

export interface PublicCarRow {
  queue_no: number | null
  status: string
  est_value: string | null
  est_unit: string | null
  bay_id: string | null
  bay_name: string | null
  plate: string
  province: string | null
  brand: string
  model: string
  color: string | null
  status_changed_at: Date | null
  repair_started_at: Date | null
  repair_ended_at: Date | null
}

export async function publicCars(trx: ScopedTx): Promise<PublicCarRow[]> {
  return trx
    .selectFrom('jobs as j')
    .innerJoin('job_board_state as t', 't.job_id', 'j.id')
    .innerJoin('vehicles as v', 'v.id', 'j.vehicle_id')
    .leftJoin('bays as b', 'b.id', 'j.bay_id')
    // The allowlist. Add to it only what a stranger in the waiting room is
    // entitled to see about somebody else's car.
    .select([
      'j.queue_no',
      'j.status',
      sql<string | null>`j.est_value::text`.as('est_value'),
      'j.est_unit',
      'j.bay_id',
      'b.name as bay_name',
      'v.plate',
      'v.province',
      'v.brand',
      'v.model',
      'v.color',
      't.status_changed_at',
      't.repair_started_at',
      't.repair_ended_at',
    ])
    // The same membership rule the kanban uses — every car still in the
    // workshop whenever it arrived, plus today's deliveries (the screen fades
    // those). No other date predicate.
    .where('t.on_board', '=', true)
    .where('j.deleted_at', 'is', null)
    .orderBy(sql`b.sort_order asc nulls last`)
    .orderBy(sql`j.queue_no asc nulls last`)
    .orderBy('j.created_at', 'asc')
    .limit(PUBLIC_BOARD_CAP)
    .execute()
}

/**
 * The shop's own active bays, in its own order. Not the hard-coded WORK_BAYS
 * constant in packages/domain: that is Samut Prakan's floor plan, and every
 * other shop's bays are different.
 */
export async function publicBays(
  trx: ScopedTx,
): Promise<{ id: string; name: string }[]> {
  return trx
    .selectFrom('bays')
    .select(['id', 'name'])
    .where('is_active', '=', true)
    .orderBy('sort_order', 'asc')
    .orderBy('name', 'asc')
    .execute()
}
