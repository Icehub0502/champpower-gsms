/**
 * Catalog rules (P3.1): the one key normaliser, price lookup precedence, the
 * warranty snapshot, duplicate-name detection (D12) and merge resolution.
 *
 * priceKey() MUST give the same answer as the SQL function price_key() in
 * migration 0020 — priceKeyFixtures.ts is the shared fixture that both a
 * domain vitest and a tier-2 SQL test check against.
 */

// -----------------------------------------------------------------------------
// price_key
// -----------------------------------------------------------------------------

/**
 * ASCII-ONLY case fold, deliberately NOT String.prototype.toLowerCase().
 *
 * Full Unicode lower-casing is itself locale-sensitive for some code points
 * (Turkish İ/I, German ẞ) and, more to the point here, the matching SQL side
 * (migration 0020) cannot do full Unicode case folding without depending on
 * the cluster's locale/ICU — `lower('Ü')` is a no-op under the dev cluster's
 * Thai_Thailand.874 locale, but JS `'Ü'.toLowerCase()` gives 'ü'. Restrict
 * BOTH sides to the one case fold that is unambiguous on any cluster: plain
 * ASCII A-Z. A non-ASCII letter (Š, Ü, ß, İ, Thai — none of which has an
 * ASCII case pair) is kept exactly as typed, on both sides, so two names that
 * differ only in the case of an accented letter are deliberately NOT treated
 * as the same key. priceKeyFixtures.ts pins this with 'CITROËN' -> 'citroËn'.
 */
function asciiLower(s: string): string {
  return s.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

/**
 * Removed anywhere in the string (not just trimmed from the ends), as ONE
 * explicit code-point list — never \s, never a Unicode property class — so
 * the SQL side (which cannot use \s without the same locale/ctype dependency
 * that broke lower()) is a literal mirror of this, not an approximation.
 *
 *   - whitespace: exactly JavaScript's String.prototype.trim() set (ECMA-262
 *     WhiteSpace + LineTerminator), the same code points as migration 0019's
 *     ck_status_history_reason CHECK: U+0009-000D, 0020, 00A0, 1680,
 *     2000-200A, 2028, 2029, 202F, 205F, 3000, FEFF.
 *   - zero-width ZWSP/ZWNJ/ZWJ (U+200B-200D): NOT part of JS's trim() set,
 *     but deliberately stripped here too — a decision, not an oversight. Two
 *     staff pasting the same part name from different sources (one with an
 *     invisible ZWSP the other lacks) must key the same, or D12's duplicate
 *     warning silently misses it. FEFF already covers the BOM / zero-width
 *     no-break space case via the whitespace set above.
 *   - hyphen-minus, underscore, the Unicode dash block, minus sign: so
 *     "ลูกหมากปีกนกล่าง L+R" vs "ลูกหมากปีกนกล่าง L-R" and an en-dash variant
 *     of the same name key the same (the #186-adjacent dedup case, D12).
 */
// Built from decimal code points, not backslash-u escapes in a regex literal:
// a literal escape sequence sailing through an editor, a JSON-based tool
// call, or a copy-paste is exactly the kind of silent corruption this file
// exists to rule out, and decimal code points cannot be misread that way.
// Each decimal value is commented with its U+ form for the human reader.
const STRIP_CODE_POINTS: readonly number[] = [
  0x2d, // U+002D hyphen-minus (listed first: literal, not a range operator)
  0x5f, // U+005F underscore
  // JS String.prototype.trim() set (ECMA-262 WhiteSpace + LineTerminator) —
  // the same code points as migration 0019's ck_status_history_reason CHECK.
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, // U+0009 to U+000D
  0x20, // U+0020 space
  0xa0, // U+00A0 NBSP
  0x1680, // U+1680 Ogham space mark
  0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, // U+2000 to U+200A
  0x2028, 0x2029, // U+2028, U+2029 line/paragraph separator
  0x202f, // U+202F narrow no-break space
  0x205f, // U+205F medium mathematical space
  0x3000, // U+3000 ideographic space
  0xfeff, // U+FEFF BOM / zero-width no-break space
  // Deliberately stripped in addition to the trim() set (see the big comment
  // above): zero-width joiner/non-joiner, not whitespace by ECMA-262.
  0x200b, 0x200c, 0x200d, // U+200B to U+200D
  // The Unicode dash block, and the minus sign.
  0x2010, 0x2011, 0x2012, 0x2013, 0x2014, 0x2015, // U+2010 to U+2015
  0x2212, // U+2212 minus sign
];

const KEY_STRIP = new RegExp('[' + STRIP_CODE_POINTS.map((cp) => String.fromCodePoint(cp)).join('') + ']+', 'gu');

/** Normalise a brand / model / item name for comparison: NFKC, ASCII-only lower case, no spaces/dashes/zero-width. */
export function priceKey(text: string): string {
  return asciiLower(text.normalize('NFKC')).replace(KEY_STRIP, '');
}

// -----------------------------------------------------------------------------
// Price lookup (v3 §4.3)
// -----------------------------------------------------------------------------

export type PriceSource = 'model' | 'base' | 'none';

export interface ResolvedPrice {
  /** numeric(12,2) text, or null when nobody has priced this item yet. */
  price: string | null;
  source: PriceSource;
}

/**
 * This car model's price -> the item's base price -> empty. `null`/`undefined`
 * means "no price"; "0.00" is a deliberate price (free) and is returned as is.
 */
export function resolvePrice(input: {
  modelPrice?: string | null;
  basePrice?: string | null;
}): ResolvedPrice {
  if (input.modelPrice != null) return { price: input.modelPrice, source: 'model' };
  if (input.basePrice != null) return { price: input.basePrice, source: 'base' };
  return { price: null, source: 'none' };
}

/**
 * Whether a standard price is "not set" for the first-price rule (D8): missing
 * or NULL ONLY. A 0 is a deliberate price (free) and is never overwritten by a
 * first typed price. (The prototype's empty skeleton rows are imported as NULL
 * by WO-004, which is what the owner's "0 counts as unset" referred to.)
 */
export function isPriceUnset(price: string | null | undefined): boolean {
  return price == null;
}

// -----------------------------------------------------------------------------
// Warranty snapshot (v3 §5) — the ONE function every line-creating path uses
// -----------------------------------------------------------------------------

// Matches migration 0010's warranty_terms (days / max_km — NOT months). This
// is the SAME table 0010 created for the per-sold-item warranty; the catalog
// does not define its own units.
export interface WarrantyTermLike {
  id: string;
  name: string;
  days: number | null;
  maxKm: number | null;
}

export interface WarrantySnapshot {
  warrantyTermId: string | null;
  // 0010 has no name snapshot column on document_lines; 0021 adds warranty_name.
  warrantyName: string | null;
  warrantyDays: number | null;
  warrantyMaxKm: number | null;
}

export const NO_WARRANTY: WarrantySnapshot = {
  warrantyTermId: null,
  warrantyName: null,
  warrantyDays: null,
  warrantyMaxKm: null,
};

/** Copy the warranty terms onto a line as they are TODAY; later edits to the term never reach a sold line. */
export function warrantySnapshotOf(term: WarrantyTermLike | null | undefined): WarrantySnapshot {
  if (!term) return { ...NO_WARRANTY };
  return {
    warrantyTermId: term.id,
    warrantyName: term.name,
    warrantyDays: term.days,
    warrantyMaxKm: term.maxKm,
  };
}

// -----------------------------------------------------------------------------
// Similar names (D12)
// -----------------------------------------------------------------------------

/** Levenshtein distance over code points. */
export function editDistance(a: string, b: string): number {
  const x = Array.from(a);
  const y = Array.from(b);
  if (x.length === 0) return y.length;
  if (y.length === 0) return x.length;
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    for (let j = 1; j <= y.length; j++) {
      const cost = x[i - 1] === y[j - 1] ? 0 : 1;
      cur[j] = Math.min((prev[j] ?? 0) + 1, (cur[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
    prev = cur;
  }
  return prev[y.length] ?? 0;
}

/** Shorter keys than this are never matched by "one contains the other" — a 1-2 character key is inside everything. */
export const MIN_CONTAINMENT_KEY_LENGTH = 3;
export const SIMILAR_MAX_EDIT_DISTANCE = 2;

/**
 * "Similar" = same price_key, OR edit distance <= 2 after normalising, OR one
 * normalised name is part of the other. Used for the warning when adding an
 * item; it never decides anything by itself — a person picks.
 */
export function isSimilarName(a: string, b: string): boolean {
  const ka = priceKey(a);
  const kb = priceKey(b);
  if (ka === '' || kb === '') return false;
  if (ka === kb) return true;
  if (editDistance(ka, kb) <= SIMILAR_MAX_EDIT_DISTANCE) return true;
  const [short, long] = ka.length <= kb.length ? [ka, kb] : [kb, ka];
  return short.length >= MIN_CONTAINMENT_KEY_LENGTH && long.includes(short);
}

export function findSimilarNames<T extends { name: string }>(name: string, candidates: readonly T[]): T[] {
  return candidates.filter((c) => isSimilarName(name, c.name));
}

// -----------------------------------------------------------------------------
// Merge resolution (D12)
// -----------------------------------------------------------------------------

export interface MergeableItem {
  id: string;
  mergedIntoId: string | null;
}

const MAX_MERGE_HOPS = 32;

/**
 * Follow merged_into_id to the surviving item. Every read of a line's
 * catalog_item_id for reporting goes through this, because old document lines
 * are never rewritten. A loop (which the merge guard forbids) ends at the
 * start of the loop rather than spinning.
 */
export function resolveCatalogItem<T extends MergeableItem>(id: string, items: ReadonlyMap<string, T>): T | null {
  let cur = items.get(id) ?? null;
  const seen = new Set<string>();
  for (let hops = 0; cur && cur.mergedIntoId && hops < MAX_MERGE_HOPS; hops++) {
    if (seen.has(cur.id)) return cur;
    seen.add(cur.id);
    const next = items.get(cur.mergedIntoId);
    if (!next) return cur;
    cur = next;
  }
  return cur;
}

/** Merging `sourceId` into `targetId` is refused when it would make a loop (A -> B -> A) or merge an item into itself. */
export function wouldCreateMergeCycle<T extends MergeableItem>(
  sourceId: string,
  targetId: string,
  items: ReadonlyMap<string, T>,
): boolean {
  if (sourceId === targetId) return true;
  const end = resolveCatalogItem(targetId, items);
  return end !== null && end.id === sourceId;
}
