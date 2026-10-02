/**
 * Catalog rules (P3.1): the one key normaliser, price lookup precedence, the
 * warranty snapshot, duplicate-name detection (D12) and merge resolution.
 *
 * priceKey() MUST give the same answer as the SQL function price_key() in
 * migration 0020 — a tier-2 test compares them on a fixed sample set.
 */

// -----------------------------------------------------------------------------
// price_key
// -----------------------------------------------------------------------------

// whitespace, hyphen-minus, underscore, the Unicode dash block, minus sign,
// zero-width characters and BOM. Kept as ONE character class so the SQL
// version is a literal copy.
const KEY_STRIP = /[\s\-_‐-―−​-‍﻿]+/g;

/** Normalise a brand / model / item name for comparison: NFKC, lower case, no spaces or dashes. */
export function priceKey(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(KEY_STRIP, '');
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
