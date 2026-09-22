/**
 * Service bays.
 *
 * Two jobs may share one bay. That is not an oversight: the database's
 * `ex_bookings_no_overlap` constraint guards BOOKINGS only, and cars really do
 * end up nose to tail in one bay while one waits for a part
 * (WO-003-ANSWERS.md §b). The API may tell the screen how many other cars are
 * standing there so it can warn — it must never refuse.
 */
import type { ScopedTx } from '@gsms/db/client.js'

export interface BayRow {
  id: string
  name: string
  sort_order: number
}

/**
 * Confirm a bay id belongs to THIS shop.
 *
 * Not a race pre-check — an authorisation check. PostgreSQL evaluates foreign
 * keys with RLS bypassed, so `bookings.bay_id` pointing at another branch's bay
 * would be accepted by the constraint. Under `withShop` this SELECT returns
 * nothing for a foreign bay, which is the answer we want.
 */
export async function findById(trx: ScopedTx, id: string): Promise<BayRow | undefined> {
  return trx
    .selectFrom('bays')
    .select(['id', 'name', 'sort_order'])
    .where('id', '=', id)
    .where('is_active', '=', true)
    .executeTakeFirst()
}
