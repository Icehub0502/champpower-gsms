/**
 * Values that must never be used to decide two records are the same thing.
 *
 * In the production dump the phone number 0999999999 is shared by EIGHT
 * unrelated customers — it is what staff type when the customer will not give
 * a number (docs/WORK-ORDERS/IMPORT-FINDINGS.md §4). Matching a customer by
 * phone is correct and necessary; matching on that phone would fuse eight
 * people's repair histories into one record, which is the same disaster as
 * `vehicle_owner_mismatch` arriving through a different door.
 *
 * PHONES AND PLATES ARE DELIBERATELY DIFFERENT. A placeholder phone is typed by
 * staff to get past a form that demands a number, so it has a recognisable
 * shape and the pattern rules below catch it. The placeholder plates in the old
 * data (1กอ2222, 1กก1111) were test rows; the WO-004 import must drop them or
 * add them to that shop's match_blocklist (docs/WORK-ORDERS/IMPORT-FINDINGS.md
 * §4) — they were never a staff habit. Meanwhile repeated-digit plates are real and
 * valued: Thai customers pay for them on purpose, and a pattern rule blocked
 * about 1% of genuine plates, giving those cars a new vehicle record on every
 * visit. So plates have NO pattern rule here; a plate is refused as a match key
 * only by an exact row in the shop's `match_blocklist` table.
 *
 * There are two layers, and this file is the FLOOR (phones only) — the shapes
 * that are placeholders by construction, so a brand-new shop is protected on its first
 * day with an empty database. The second layer is the per-shop
 * `match_blocklist` table (migration 0015), which holds values a particular
 * shop discovers later. The table ADDS TO this floor, it never replaces it.
 *
 * THE FLOOR MUST COVER EVERY PLACEHOLDER WE ALREADY KNOW ABOUT. The table
 * cannot be trusted to: 0015's seed INSERT reached only the shops that existed
 * when it ran, and production runs the migrations against an EMPTY database
 * and creates its shops afterwards (the WO-004 import). So on the real shop
 * the table is empty on day one, and any known placeholder that lives only in
 * the seed has no protection at all. An earlier version of this comment said
 * 0993333333 was "a placeholder by convention, not by shape, and no pattern
 * could know it" — that was wrong, a pattern can (the trailing-run rule below),
 * and leaving it to the table left it unprotected exactly where it came from.
 *
 * The threshold auto-block does NOT rescue a gap in the floor. It fires at
 * four customers sharing a number; but the first person keyed in as a
 * placeholder becomes a customer, and every later stranger with that number is
 * MATCHED to them — so a second customer is never created, the count stays at
 * one, and the merge is silent and permanent. Only the floor stops that.
 *
 * This is the third defect of one shape in this codebase (seed_document_series,
 * then this seed): a protection that exists only where it was seeded. Put it
 * in the rule, not in the rows.
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
  // Plates: no pattern rule, see the header. The blocklist table is their only
  // guard, checked by the caller (isBlockedMatchKey).
  return kind === 'phone' ? isPlaceholderPhone(key) : false
}

function isPlaceholderPhone(digits: string): boolean {
  if (digits.length < 4) return false

  // 0000000000, 9999999999 — one digit, repeated. Nobody's real number.
  if (isRepeated(digits)) return true

  // 0999999999 — the shape staff actually produce: a leading zero because a
  // Thai number starts with one, then whatever key their finger is resting on.
  if (digits.startsWith('0') && isRepeated(digits.slice(1))) return true

  // 0993333333, 0995555555 — a few real-looking digits, then the finger rests
  // on one key. Seven or more identical digits at the end is the shape of
  // every placeholder in the production dump and of the variants other shops'
  // staff will invent. The cost is deliberate: a genuine vanity number such as
  // 081-222-2222 is never used to FIND a customer, so that person may get a
  // second record — a duplicate a human can merge, which is the trade the
  // FAILING SAFE note above says to make. It is still STORED on the record.
  if (trailingRun(digits) >= PLACEHOLDER_PHONE_TAIL) return true

  return false
}

/**
 * The shortest run of one repeated digit, at the end of a phone number, that
 * marks it as a placeholder. Seven, because it is the smallest length that
 * covers 0993333333 (a placeholder in the production dump) while leaving
 * ordinary numbers that happen to end in a few repeats (…5666, …0000) alone.
 */
export const PLACEHOLDER_PHONE_TAIL = 7

/** How many identical characters the string ends with. */
function trailingRun(s: string): number {
  if (s.length === 0) return 0
  const last = s[s.length - 1]
  let n = 0
  for (let i = s.length - 1; i >= 0 && s[i] === last; i--) n++
  return n
}

/** Every character the same. */
function isRepeated(s: string): boolean {
  return s.length > 0 && [...s].every((c) => c === s[0])
}
