/**
 * Values that must never be used to decide two records are the same thing.
 *
 * In the production dump the phone number 0999999999 is shared by EIGHT
 * unrelated customers — it is what staff type when the customer will not give
 * a number (docs/WORK-ORDERS/IMPORT-FINDINGS.md §4). Matching a customer by
 * phone is correct and necessary; matching on that phone would fuse eight
 * people's repair histories into one record, which is the same disaster as
 * `vehicle_owner_mismatch` arriving through a different door. Plates have the
 * equivalent: 1กอ2222 appears four times, 1กก1111 three times.
 *
 * There are two layers, and this file is the FLOOR — the shapes that are
 * placeholders by construction, so a brand-new shop is protected on its first
 * day with an empty database. The second layer is the per-shop
 * `match_blocklist` table (migration 0015), which holds values a particular
 * shop discovers later — 0993333333 is one of those: it is a placeholder by
 * convention at this shop, not by shape, and no pattern could know it.
 * The table ADDS TO this floor, it never replaces it.
 *
 * Pure and in `packages/domain` on purpose: the API resolver and the
 * production import script must apply the same rule (findings §4 item 4), and
 * a rule written twice is a rule that disagrees with itself.
 *
 * FAILING SAFE: a false positive here costs one duplicate record, which a
 * human can merge. A false negative fuses two customers' histories, which no
 * one can safely unpick. When in doubt, block.
 */

export type MatchKeyKind = 'phone' | 'plate'

/**
 * `key` must ALREADY BE NORMALISED — digits only for a phone, plate_key form
 * (upper-cased, punctuation stripped) for a plate. Passing "099-999-9999"
 * here returns false, because that is not what a normalised key looks like
 * and this function does not guess. Normalise first, always.
 */
export function isPlaceholderKey(kind: MatchKeyKind, key: string): boolean {
  return kind === 'phone' ? isPlaceholderPhone(key) : isPlaceholderPlate(key)
}

function isPlaceholderPhone(digits: string): boolean {
  if (digits.length < 4) return false

  // 0000000000, 9999999999 — one digit, repeated. Nobody's real number.
  if (isRepeated(digits)) return true

  // 0999999999 — the shape staff actually produce: a leading zero because a
  // Thai number starts with one, then whatever key their finger is resting on.
  if (digits.startsWith('0') && isRepeated(digits.slice(1))) return true

  return false
}

/**
 * A plate whose trailing digits are all the same: 1กก1111, 1กอ2222.
 *
 * The TRAILING run, not every digit in the string — 1กอ2222 contains a 1 in
 * the leading position, so "all digits identical" would miss precisely one of
 * the two plates the findings named.
 *
 * Three is the shortest run that counts. Two-digit plates ending 11 or 22 are
 * common enough to be real, and blocking them would make honest customers
 * duplicate for no benefit.
 */
function isPlaceholderPlate(plateKey: string): boolean {
  const trailing = /([0-9]+)$/.exec(plateKey)?.[1]
  if (!trailing || trailing.length < 3) return false
  return isRepeated(trailing)
}

/** Every character the same. */
function isRepeated(s: string): boolean {
  return s.length > 0 && [...s].every((c) => c === s[0])
}
