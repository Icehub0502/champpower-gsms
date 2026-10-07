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
import { sql } from 'kysely'
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
 * The cars with this plate that could be the one at the counter.
 *
 * Returns ALL of them, newest first, not a guess. The decision between them
 * is `choosePlateMatch` below, which is pure so it can be tested case by case.
 *
 * Enforced in the repository for the same reason as `customers.findByPhone`:
 * the counter screen calls `GET /api/checkin/vehicle-lookup` before it posts
 * anything, and a lookup that cheerfully returns a car for a blocklisted plate
 * would put that car's owner on the form no matter how careful the resolver is
 * afterwards. Both doors, and every future one, go through here.
 *
 * A blocked plate is still stored on the vehicle created next; it just cannot
 * be used to find an existing one. Plates are blocked only by an exact row in
 * the shop's match_blocklist — there is no pattern rule, because repeated-digit
 * plates such as 1กก1111 are real and valued (the dump's copies were test rows;
 * the WO-004 import must drop them or add them to that shop's match_blocklist —
 * docs/WORK-ORDERS/IMPORT-FINDINGS.md §4).
 *
 * Read through idx_vehicles_plate_key (shop_id, plate_key) — which is why
 * `shop_id` is ALSO in the WHERE here, although RLS already restricts the rows.
 * The RLS predicate is an OR (current_shop_id, or one of current_shop_ids), so
 * the planner cannot use it as an index condition: EXPLAIN showed the index
 * probed on plate_key alone, i.e. across every branch's plates. With the
 * explicit column both keys are the index condition. Province is filtered
 * in `choosePlateMatch`, not in SQL: a plate matches a handful of rows at most,
 * and the decision needs the rows in OTHER provinces too, to know whether an
 * empty province is ambiguous.
 */
export async function candidatesByPlate(
  trx: ScopedTx,
  shopId: string,
  plate: string,
  province?: string | undefined,
): Promise<VehicleRow[]> {
  const key = plateKeyOf(plate)
  if (key.length === 0) return []
  if (await isBlockedMatchKey(trx, 'plate', key)) return []
  return trx
    .selectFrom('vehicles')
    .select(['id', 'customer_id', 'plate', 'brand', 'model', 'color', 'year', 'province'])
    .where('shop_id', '=', shopId)
    .where('plate_key', '=', key)
    // Rows in the province asked for come FIRST, so the bound below can never
    // cut off an exact match (code review, 30 Sep 2026). IS NOT DISTINCT FROM,
    // not =, so the sort key is never NULL — a NULL would sort first under DESC.
    .orderBy(sql`(province IS NOT DISTINCT FROM ${province ?? null})`, 'desc')
    .orderBy('updated_at', 'desc')
    // A bound, not pagination: a real plate has one to three rows. Twenty is
    // far past anything legitimate and keeps a pathological plate cheap.
    .limit(20)
    .execute()
}

export type PlateMatch =
  | { kind: 'none' }
  /** `fillProvince` set = this car has no province and the caller's belongs on it. */
  | { kind: 'one'; vehicle: VehicleRow; fillProvince: string | null }
  | { kind: 'ambiguous'; candidates: VehicleRow[] }

/**
 * Which car a (plate, province) names — owner decision, 29 Sep 2026: the same
 * plate in two provinces is two different cars.
 *
 * `rows` are the plate's cars newest first (candidatesByPlate).
 *
 * WITH a province P:
 *   1. A car on file in P is the car. Several in P are the same car recorded
 *      twice (an owner change keyed as a new car) — the newest is on the
 *      forecourt, as before province mattered.
 *   2. Otherwise only cars with NO province can be this car; a car recorded in
 *      another province is, by the owner's rule, a different car.
 *        - none of those       -> a new car.
 *        - exactly one, and the plate is on file in no other province
 *                              -> it is this car; P fills its empty province.
 *        - anything else       -> ambiguous. Two unknown-province rows, or one
 *          beside a car in another province, means this plate demonstrably
 *          exists as more than one car, and filling P into the wrong one would
 *          give a stranger's history to this customer.
 *   `confirmNewVehicle` ("none of those") skips step 2 and never step 1: a car
 *   already on file with the same plate AND province is not a new car.
 *
 * WITHOUT a province:
 *   - every row agrees on one province (all empty counts) -> the newest. A
 *     returning car is found by plate alone, as it always was.
 *   - rows in more than one province -> ambiguous: the counter has to say
 *     which. One candidate per province, the newest of each.
 */
export function choosePlateMatch(
  rows: VehicleRow[],
  province: string | undefined,
  opts: { confirmNewVehicle?: boolean | undefined } = {},
): PlateMatch {
  if (rows.length === 0) return { kind: 'none' }

  if (province !== undefined) {
    const exact = rows.find((r) => r.province === province)
    if (exact) return { kind: 'one', vehicle: exact, fillProvince: null }
    if (opts.confirmNewVehicle) return { kind: 'none' }

    const unknown = rows.filter((r) => r.province === null)
    const elsewhere = rows.some((r) => r.province !== null)
    if (unknown.length === 0) return { kind: 'none' }
    if (unknown.length === 1 && !elsewhere) {
      return { kind: 'one', vehicle: unknown[0]!, fillProvince: province }
    }
    return { kind: 'ambiguous', candidates: unknown }
  }

  const newestPerProvince = new Map<string | null, VehicleRow>()
  for (const r of rows) if (!newestPerProvince.has(r.province)) newestPerProvince.set(r.province, r)
  if (newestPerProvince.size === 1) return { kind: 'one', vehicle: rows[0]!, fillProvince: null }
  return { kind: 'ambiguous', candidates: [...newestPerProvince.values()] }
}

/**
 * Write a province onto a car that has none — and only onto one that has none.
 *
 * The `province IS NULL` guard is in the UPDATE itself, so a car that gained a
 * province between the read and this write is left alone rather than
 * overwritten. Returns whether it wrote, so the caller audits only a real change.
 */
export async function fillProvince(
  trx: ScopedTx,
  shopId: string,
  vehicleId: string,
  province: string,
): Promise<boolean> {
  const r = await trx
    .updateTable('vehicles')
    .set({ province, updated_at: new Date() })
    // shop_id explicit as well as by RLS: defence in depth on a write.
    .where('shop_id', '=', shopId)
    .where('id', '=', vehicleId)
    .where('province', 'is', null)
    .executeTakeFirst()
  return Number(r.numUpdatedRows) > 0
}

export async function findById(
  trx: ScopedTx,
  shopId: string,
  id: string,
): Promise<VehicleRow | undefined> {
  return trx
    .selectFrom('vehicles')
    .select(['id', 'customer_id', 'plate', 'brand', 'model', 'color', 'year', 'province'])
    // Explicit as well as by RLS, so a foreign id is invisible even if the
    // policy were ever loosened.
    .where('shop_id', '=', shopId)
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
  shopId: string,
  vehicleId: string,
  customerId: string,
): Promise<void> {
  await trx
    .updateTable('vehicles')
    .set({ customer_id: customerId, updated_at: new Date() })
    .where('shop_id', '=', shopId)
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
  vehicleModelId?: string | null | undefined
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
      vehicle_model_id: input.vehicleModelId ?? null,
    })
    .returning(['id', 'customer_id', 'plate', 'brand', 'model', 'color', 'year', 'province'])
    .executeTakeFirstOrThrow()
}
