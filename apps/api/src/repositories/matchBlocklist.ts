/**
 * Is this value allowed to decide that two records are the same thing?
 *
 * The answer is "no" in two cases, and both have to be consulted every time:
 *
 *   1. The value is a placeholder BY SHAPE — `isPlaceholderKey` in
 *      packages/domain. One repeated digit, a plate ending 1111. This is the
 *      floor, it needs no rows, and it protects a shop that opened this
 *      morning.
 *   2. The value is in this shop's `match_blocklist` table — a value this
 *      particular shop discovered was junk, added by hand or by the
 *      auto-block threshold.
 *
 * Do not rely on the table for any placeholder already KNOWN. 0015's seed rows
 * exist only in shops that were present when it ran, and production creates
 * its shops afterwards, so a real shop starts with an empty table. Every known
 * placeholder has to be caught by the floor alone (packages/domain
 * matchKeys.test.ts, "the floor covers everything the 0015 seed covers").
 *
 * `isBlockedMatchKey` is exported rather than inlined into the resolver
 * because the production import script must apply THE SAME LIST
 * (docs/WORK-ORDERS/IMPORT-FINDINGS.md §4 item 4). A second copy of this rule
 * written for the importer is a second copy that will disagree, and the
 * disagreement would show up as merged customer histories that nobody can
 * unpick afterwards. Import from here; do not reimplement.
 *
 * Every key passed in must ALREADY BE NORMALISED — `customersRepo
 * .normalisePhone` for a phone, `vehiclesRepo.plateKeyOf` for a plate. The
 * table stores the normalised form for exactly this reason; see the comment on
 * `value_key` in migration 0015.
 */
import { isPlaceholderKey, type MatchKeyKind } from '@champpower/domain'
import type { ScopedTx } from '@gsms/db/client.js'

/**
 * More than this many customers on one phone and it stops being an identity.
 *
 * findings §4 item 3. Three real people sharing a number is a family; the
 * eight sharing 0999999999 are not.
 */
export const PHONE_SHARING_LIMIT = 3

export async function isBlockedMatchKey(
  trx: ScopedTx,
  kind: MatchKeyKind,
  key: string,
): Promise<boolean> {
  if (key.length === 0) return true
  // The pure rule first: no query at all for the values that are obviously
  // junk, which is most of them.
  if (isPlaceholderKey(kind, key)) return true

  const row = await trx
    .selectFrom('match_blocklist')
    .select(['id'])
    .where('kind', '=', kind)
    .where('value_key', '=', key)
    .executeTakeFirst()
  return row !== undefined
}

/**
 * Record that the system stopped trusting a key, and why.
 *
 * A row, not a computed answer. The threshold rule would otherwise be
 * invisible: the owner would see a customer get a second record and have no
 * way to find out why, and no way to overrule it. A row can be read, explained
 * and deleted — and `attention_items` surfaces it (migration 0015) so somebody
 * actually sees it happen.
 *
 * ON CONFLICT DO NOTHING because two check-ins can reach the threshold at the
 * same moment, and the second one losing a unique constraint is not an error
 * worth failing a check-in over.
 */
export async function recordAutoBlock(
  trx: ScopedTx,
  shopId: string,
  kind: MatchKeyKind,
  key: string,
  reason: string,
): Promise<void> {
  await trx
    .insertInto('match_blocklist')
    .values({ shop_id: shopId, kind, value_key: key, reason, source: 'auto' })
    .onConflict((oc) => oc.columns(['shop_id', 'kind', 'value_key']).doNothing())
    .execute()
}

/** The wording on an auto row, so the owner can see what triggered it. */
export function sharingReason(count: number): string {
  return `ระบบบล็อกอัตโนมัติ: เบอร์นี้ถูกใช้โดยลูกค้า ${count} รายขึ้นไป (เกิน ${PHONE_SHARING_LIMIT})`
}
