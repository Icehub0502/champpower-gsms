/**
 * Vehicles, found the way the counter actually finds them: by plate.
 *
 * Never `LIKE` on the raw plate. `vehicles.plate_key` is a GENERATED STORED
 * column — `upper(regexp_replace(plate, '[^0-9A-Za-zก-๙]', '', 'g'))` from
 * 0002_core.sql — with its own index, and it exists precisely because staff
 * type "กก 1234", "กก-1234" and "กก1234" for the same car on three different
 * days. `plateKeyOf` below mirrors that expression exactly; if one of the two
 * ever changes, the lookup starts missing cars silently, so they are kept
 * side by side in the comment rather than in two files.
 */
import type { ScopedTx } from '@gsms/db/client.js'
import { isBlockedMatchKey } from './matchBlocklist.js'

/** The TypeScript twin of the generated `plate_key` expression. */
export function plateKeyOf(plate: string): string {
  return plate.replace(/[^0-9A-Za-zก-๙]/gu, '').toUpperCase()
}

export interface VehicleRow {
  id: string
  customer_id: string
  plate: string
  brand: string
  model: string
  color: string | null
  year: string | null
  province: string | null
}

/**
 * Find the car with this plate — or refuse to.
 *
 * Enforced in the repository for the same reason as `customers.findByPhone`:
 * the counter screen calls `GET /api/checkin/vehicle-lookup` before it posts
 * anything, and a lookup that cheerfully returns a car for a blocklisted plate would
 * put that car's owner on the form no matter how careful the resolver is
 * afterwards. Both doors, and every future one, go through here.
 *
 * A blocked plate is still stored on the vehicle created next; it just cannot
 * be used to find an existing one. Plates are blocked only by an exact row in
 * the shop's match_blocklist — there is no pattern rule, because repeated-digit
 * plates such as 1กก1111 are real and valued (the dump's copies were test rows; the WO-004 import must drop them or add them
 * to that shop's match_blocklist — docs/WORK-ORDERS/IMPORT-FINDINGS.md §4).
 *
 * OPEN QUESTION, FOR THE OWNER — the matching key is plate_key ALONE; province
 * is not part of it. Thai plate numbers repeat across provinces, so
 * "กก 1234 กรุงเทพ" and "กก 1234 ชลบุรี" may be two different cars, and
 * matching on plate alone would treat them as one. Adding province to the key
 * would change how every returning customer is found — a car keyed in once
 * without a province, or with it spelled differently, would stop matching — so
 * it is the owner's call, not this function's (raised with them 25 Sep 2026).
 * Until it is decided, the worst outcome of a false match is bounded: the
 * resolver's vehicle_owner_mismatch refusal stops the car silently moving to a
 * different customer (services/intake.ts).
 */
export async function findByPlate(
  trx: ScopedTx,
  plate: string,
): Promise<VehicleRow | undefined> {
  const key = plateKeyOf(plate)
  if (key.length === 0) return undefined
  if (await isBlockedMatchKey(trx, 'plate', key)) return undefined
  return trx
    .selectFrom('vehicles')
    .select(['id', 'customer_id', 'plate', 'brand', 'model', 'color', 'year', 'province'])
    .where('plate_key', '=', key)
    // A plate can legitimately appear twice if a car changed owner and staff
    // created a second record. The newest is the one on the forecourt.
    .orderBy('updated_at', 'desc')
    .limit(1)
    .executeTakeFirst()
}

export async function findById(
  trx: ScopedTx,
  id: string,
): Promise<VehicleRow | undefined> {
  return trx
    .selectFrom('vehicles')
    .select(['id', 'customer_id', 'plate', 'brand', 'model', 'color', 'year', 'province'])
    .where('id', '=', id)
    .executeTakeFirst()
}

/**
 * Move a car to a different owner.
 *
 * Only ever called after the caller has confirmed the change explicitly — see
 * `vehicle_owner_mismatch` in services/intake.ts. Cars get sold and relatives
 * bring them in, so this is routine at a garage; doing it without saying so is
 * what merges two customers' repair histories beyond recovery.
 */
export async function changeOwner(
  trx: ScopedTx,
  vehicleId: string,
  customerId: string,
): Promise<void> {
  await trx
    .updateTable('vehicles')
    .set({ customer_id: customerId, updated_at: new Date() })
    .where('id', '=', vehicleId)
    .execute()
}

export interface CreateVehicle {
  shopId: string
  customerId: string
  plate: string
  brand: string
  model: string
  color?: string | undefined
  year?: string | undefined
  province?: string | undefined
}

export async function create(trx: ScopedTx, input: CreateVehicle): Promise<VehicleRow> {
  return trx
    .insertInto('vehicles')
    .values({
      shop_id: input.shopId,
      customer_id: input.customerId,
      plate: input.plate,
      brand: input.brand,
      model: input.model,
      color: input.color ?? null,
      year: input.year ?? null,
      province: input.province ?? null,
    })
    .returning(['id', 'customer_id', 'plate', 'brand', 'model', 'color', 'year', 'province'])
    .executeTakeFirstOrThrow()
}
