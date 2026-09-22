/**
 * Customers, as the intake path needs them.
 *
 * Every function here takes a `ScopedTx` — the branded transaction from
 * `withShop`. That is not decoration: the brand is what stops a future edit
 * quietly reaching for `unscoped()` and reading another branch's customers
 * (CLAUDE.md §8 rule 3). The shop id is passed alongside only because INSERTs
 * have to name it explicitly for the RLS WITH CHECK clause; reads are narrowed
 * by the policy itself.
 */
import type { ScopedTx } from '@gsms/db/client.js'
import { sql } from 'kysely'
import {
  isBlockedMatchKey, recordAutoBlock, sharingReason, PHONE_SHARING_LIMIT,
} from './matchBlocklist.js'

/**
 * Phone numbers as digits only.
 *
 * Staff key "081-234-5678", "081 234 5678" and "0812345678" for the same
 * person on three different days. Storing the digits means the check-in lookup
 * and the W4 held-deposit lookup can both match on equality instead of each
 * inventing its own fuzzy comparison.
 */
export function normalisePhone(phone: string): string {
  return phone.replace(/[^0-9]/g, '')
}

export interface CustomerRow {
  id: string
  name: string | null
  phone: string | null
}

export interface CustomerCandidate {
  id: string
  name: string | null
}

/**
 * What a phone number resolved to. Never "probably this one".
 *
 * `ambiguous` exists because the previous version of this function ended
 * `.orderBy('created_at','asc').limit(1)` and silently returned the oldest
 * customer on that number. Two people really do share a phone — a couple, a
 * parent and child — and picking one writes a stranger's car into somebody's
 * repair history with nothing to show it happened. The counter can see both
 * names and knows which one is standing in front of them; the server does not.
 */
export type PhoneMatch =
  /** Nobody has this number. A real, usable number that is simply new. */
  | { kind: 'none' }
  /**
   * The number carries no information at all — a placeholder, or one so
   * widely shared the system stopped trusting it. Distinct from `none` on
   * purpose: "this is a new customer's number" and "this number tells us
   * nothing" look identical to a caller that lumps them together, and the
   * owner-mismatch check in services/intake.ts has to tell them apart. A
   * placeholder must never be evidence that a car changed hands.
   */
  | { kind: 'blocked' }
  | { kind: 'one'; customer: CustomerRow }
  | { kind: 'ambiguous'; candidates: CustomerCandidate[] }

/**
 * Find the customer who owns this phone number — or refuse to.
 *
 * The blocklist is enforced HERE, in the repository, not at the call sites.
 * There are two call sites today — the intake resolver and
 * `GET /api/checkin/customer-lookup` — and guarding only the resolver would
 * have been useless in practice: the counter screen calls the lookup FIRST,
 * accepts the prefill it offers, and then posts an explicit `customerId`,
 * which the resolver honours because by then the caller has named a customer
 * on file. The protection has to sit under both doors, and under every door
 * added later.
 *
 * A blocked number is still STORED on whatever record is created next. It is
 * only barred from being the thing that finds an existing one.
 */
export async function findByPhone(
  trx: ScopedTx,
  shopId: string,
  phone: string,
): Promise<PhoneMatch> {
  const digits = normalisePhone(phone)
  if (digits.length === 0) return { kind: 'none' }
  // Blocklist FIRST, ambiguity second, and the order is load-bearing. A
  // blocked number means "always create new" — asking the counter to choose
  // between the eight people who share 0999999999 is not a question anyone
  // can answer, and offering it would turn a placeholder into a menu of
  // strangers.
  if (await isBlockedMatchKey(trx, 'phone', digits)) return { kind: 'blocked' }

  const rows = await trx
    .selectFrom('customers')
    .select(['id', 'name', 'phone'])
    .where('deleted_at', 'is', null)
    // Rows written before this repository existed (and rows a future import
    // brings in) may still carry separators, so the comparison strips them on
    // both sides rather than trusting the stored shape.
    .where(sql<boolean>`regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g') = ${digits}`)
    .orderBy('created_at', 'asc')
    // One more than the limit: enough to know the threshold is exceeded,
    // without counting a number shared by hundreds.
    .limit(PHONE_SHARING_LIMIT + 1)
    .execute()

  if (rows.length === 0) return { kind: 'none' }

  /*
   * Two thresholds sit next to each other here and they are NOT a bug:
   *
   *   more than 3 customers  -> the number is junk. Nobody chooses between
   *                             eight strangers, so the system stops trusting
   *                             it, records why, and always creates new.
   *   2 or 3 customers       -> a real shared number. A family, a workplace.
   *                             The counter knows which of the two people is
   *                             standing there; ask them.
   *   exactly 1              -> the ordinary case.
   *
   * The dividing line is whether a human could answer the question. Above the
   * limit the question is unanswerable, so it is never asked.
   *
   * The count is paid for only on the path where a match was found — the query
   * above is the same one either way, LIMIT 4 instead of LIMIT 1.
   */
  if (rows.length > PHONE_SHARING_LIMIT) {
    await recordAutoBlock(trx, shopId, 'phone', digits, sharingReason(rows.length))
    // 'blocked', not 'none': the number is now known to be junk, and the next
    // request will take the same branch from the blocklist above.
    return { kind: 'blocked' }
  }

  if (rows.length > 1) {
    // Id and name only. The caller is choosing between people, not browsing
    // them, and a candidate list is the wrong place to hand out phone numbers
    // and addresses.
    return { kind: 'ambiguous', candidates: rows.map((r) => ({ id: r.id, name: r.name })) }
  }

  return { kind: 'one', customer: rows[0]! }
}

export async function findById(
  trx: ScopedTx,
  id: string,
): Promise<CustomerRow | undefined> {
  return trx
    .selectFrom('customers')
    .select(['id', 'name', 'phone'])
    .where('id', '=', id)
    .where('deleted_at', 'is', null)
    .executeTakeFirst()
}

export interface CreateCustomer {
  shopId: string
  name: string
  phone?: string | undefined
  /**
   * Recorded once, at the first check-in, never on later visits — CLAUDE.md
   * §5.7 item 2. `findOrCreate` is what enforces "once": an existing customer
   * keeps whatever answer they gave the first time.
   */
  leadSource?: string | undefined
}

export async function create(trx: ScopedTx, input: CreateCustomer): Promise<CustomerRow> {
  return trx
    .insertInto('customers')
    .values({
      shop_id: input.shopId,
      name: input.name,
      phone: input.phone ? normalisePhone(input.phone) : null,
      lead_source: input.leadSource ?? null,
    })
    .returning(['id', 'name', 'phone'])
    .executeTakeFirstOrThrow()
}

/** Every vehicle this customer has on file, for the counter's prefill list. */
export async function vehiclesOf(
  trx: ScopedTx,
  customerId: string,
): Promise<{ vehicleId: string; plate: string; brand: string; model: string }[]> {
  const rows = await trx
    .selectFrom('vehicles')
    .select(['id', 'plate', 'brand', 'model'])
    .where('customer_id', '=', customerId)
    .orderBy('updated_at', 'desc')
    .limit(20)
    .execute()
  return rows.map((r) => ({
    vehicleId: r.id,
    plate: r.plate,
    brand: r.brand,
    model: r.model,
  }))
}
