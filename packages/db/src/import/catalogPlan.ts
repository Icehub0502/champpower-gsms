/**
 * WO-004 phase 1: turn the prototype's service catalog into an import plan.
 *
 * Everything here is pure. It takes rows already read from the dump plus a
 * snapshot of what the target shop already holds, and returns what to insert,
 * what to update, and what a human has to look at. Nothing here touches a
 * database, which is what makes the conversions testable with a synthetic
 * fixture and keeps --dry-run and the real run on exactly one code path.
 *
 * Rule from WO-004 section 2.5: ambiguity goes into the report, never into a
 * guess. Every branch that would have to guess records an Ambiguity instead.
 */
import { priceKey } from '@champpower/domain'
import type { DumpRow } from './mysqlDump.js'

export const ITEM_SOURCE = 'service_item'
export const WARRANTY_SOURCE = 'warranty'

/**
 * Prototype warranties imported INACTIVE so new quotes cannot pick them
 * (DECISION-2026-10-15 section 3). #4 reads "6 months, heavy steering 3 months"
 * but its numbers only say 6 months. Applied on insert only: once a person
 * re-activates the term, a re-run must not switch it off again.
 */
export const INACTIVE_WARRANTY_LEGACY_IDS: readonly string[] = ['4']

// -----------------------------------------------------------------------------
// Converters
// -----------------------------------------------------------------------------

/** DECISION-2026-10-07: days = year x 365 + month x 30. 0 km means no km limit. */
export function warrantyDays(year: number, month: number): number {
  return year * 365 + month * 30
}

export interface ConvertedWarranty {
  days: number | null
  maxKm: number | null
}

/**
 * A prototype warranty row -> warranty_terms values. 0 means "no limit of that
 * kind" in the prototype; warranty_terms uses NULL for that. A row with no
 * limit of either kind cannot satisfy ck_term_has_limit and is not guessed at.
 */
export function convertWarranty(
  year: number | null,
  month: number | null,
  km: number | null,
): ConvertedWarranty | { problem: string } {
  // null / undefined is "unreadable", NOT zero: 0 means "no limit of that kind".
  if (year == null || month == null || km == null || ![year, month, km].every((v) => Number.isInteger(v) && v >= 0)) {
    return { problem: `year/month/km must be non-negative whole numbers (got ${year}/${month}/${km})` }
  }
  const [y, m, k] = [year, month, km]
  const days = warrantyDays(y, m)
  // warranty_terms.days / max_km are 32-bit integers.
  if (days > 2147483647 || k > 2147483647) return { problem: `value too large for the integer column (days=${days}, km=${k})` }
  const out = { days: days > 0 ? days : null, maxKm: k > 0 ? k : null }
  if (out.days === null && out.maxKm === null) {
    return { problem: 'no time limit and no km limit (all zero); warranty_terms requires at least one' }
  }
  return out
}

export type PriceNote = 'null_in_source' | 'zero_means_unpriced' | 'negative' | 'unparseable'

/**
 * set_price -> catalog_items.base_price (numeric(12,2) as text, or null).
 *
 * NULL stays NULL. A 0 cannot be told apart from "nobody priced it" in the
 * prototype -- the column is a plain decimal with no flag -- so by WO-004 it
 * becomes NULL and is listed for a person (a true free item keeps 0 only once a
 * human says so). Negative or non-numeric values are NULL and listed too.
 */
export function convertPrice(raw: string | null): { price: string | null; note: PriceNote | null } {
  if (raw === null) return { price: null, note: 'null_in_source' }
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(raw.trim())
  if (!m) return { price: null, note: 'unparseable' }
  const [, sign, whole, frac = ''] = m
  // More than 2 decimals with a non-zero tail would need rounding: not guessed.
  if (/[1-9]/.test(frac.slice(2))) return { price: null, note: 'unparseable' }
  // Integer-string arithmetic on purpose: money never goes through a float.
  const satang = BigInt(whole! + (frac + '00').slice(0, 2))
  if (satang === 0n) return { price: null, note: 'zero_means_unpriced' }
  if (sign === '-') return { price: null, note: 'negative' }
  const s = satang.toString().padStart(3, '0')
  return { price: s.slice(0, -2) + '.' + s.slice(-2), note: null }
}

// -----------------------------------------------------------------------------
// Plan types
// -----------------------------------------------------------------------------

export type Action = 'insert' | 'update' | 'unchanged'

export interface Ambiguity {
  code: string
  table: 'service_items' | 'service_item_components' | 'warranties'
  legacyId: string | null
  detail: string
}

export interface TermPlan {
  action: Action
  legacyId: string
  name: string
  days: number | null
  maxKm: number | null
  existingId: string | null
  /** Value for a NEW term only; an existing term's is_active is never touched. */
  isActive: boolean
  /** The prototype row, for the report's "what was converted" section. */
  from: { year: number | null; month: number | null; km: number | null }
}

export interface ItemPlan {
  action: Action
  legacyId: string
  category: string
  name: string
  isSet: boolean
  isActive: boolean
  basePrice: string | null
  /** Prototype warranty id, resolved to a warranty_terms id at apply time. */
  warrantyLegacyId: string | null
  existingId: string | null
}

export interface ComponentPlan {
  action: Action
  legacyId: string
  legacySetId: string
  name: string
  qty: string
  sortOrder: number
  existingId: string | null
}

export interface ExistingState {
  terms: { id: string; name: string; days: number | null; max_km: number | null }[]
  items: {
    id: string
    legacy_id: string | null
    category: string
    name: string
    category_key: string | null
    name_key: string | null
    is_set: boolean
    is_active: boolean
    base_price: string | null
    warranty_term_name: string | null
    merged: boolean
  }[]
  components: { id: string; set_item_id: string; sort_order: number; component_name: string; qty: string }[]
}

export interface Plan {
  terms: TermPlan[]
  items: ItemPlan[]
  components: ComponentPlan[]
  ambiguities: Ambiguity[]
  /** Prices that became NULL, with the reason (subset of ambiguities worth counting). */
  priceNulls: { zero: number; nullInSource: number; negative: number; unparseable: number }
}

export interface SourceTables {
  service_items: DumpRow[]
  service_item_components: DumpRow[]
  warranties: DumpRow[]
}

const int = (v: string | null | undefined): number | null =>
  v === null || v === undefined || !/^-?\d+$/.test(v) ? null : Number(v)

// -----------------------------------------------------------------------------
// Planner
// -----------------------------------------------------------------------------

/** One prototype row on a single line, so duplicates can be compared side by side. */
function describeRow(r: DumpRow, compCount: Map<string, number>): string {
  return `[#${r.id}: category=${JSON.stringify(r.category)} name=${JSON.stringify(r.product_name)} is_set=${r.is_set} set_price=${r.set_price ?? 'NULL'} warranty_id=${r.warranty_id ?? 'NULL'} is_active=${r.is_active} created_at=${r.created_at} components=${compCount.get(r.id!) ?? 0}]`
}

export function buildPlan(src: SourceTables, existing: ExistingState): Plan {
  const ambiguities: Ambiguity[] = []
  const flag = (a: Ambiguity) => ambiguities.push(a)
  const priceNulls = { zero: 0, nullInSource: 0, negative: 0, unparseable: 0 }

  // ---- items -----------------------------------------------------------------
  const existingByLegacy = new Map(existing.items.filter((e) => e.legacy_id !== null).map((e) => [e.legacy_id!, e]))
  const liveByKey = new Map<string, ExistingState['items'][number]>()
  for (const e of existing.items) {
    if (!e.merged) liveByKey.set(`${e.category_key}\u0000${e.name_key}`, e)
  }

  // Same (category, name) after normalising: the database allows one live item
  // per key. Which of two prototype rows is "the real one" is a person's call,
  // so neither is imported.
  const sourceKeyCount = new Map<string, string[]>()
  for (const r of src.service_items) {
    const key = `${priceKey((r.category ?? '').trim())}\u0000${priceKey((r.product_name ?? '').trim())}`
    sourceKeyCount.set(key, [...(sourceKeyCount.get(key) ?? []), r.id!])
  }

  // ---- warranty terms (only those the items need) ----------------------------
  const warrantyById = new Map(src.warranties.map((w) => [w.id!, w]))
  const needed = new Set(src.service_items.map((r) => r.warranty_id).filter((v): v is string => v !== null))
  const termByLegacy = new Map<string, TermPlan>()
  const termNameCount = new Map<string, number>()
  for (const id of needed) {
    const w = warrantyById.get(id)
    if (w) termNameCount.set((w.warranty_name ?? '').trim(), (termNameCount.get((w.warranty_name ?? '').trim()) ?? 0) + 1)
  }
  const terms: TermPlan[] = []
  for (const id of [...needed].sort((a, b) => Number(a) - Number(b))) {
    const w = warrantyById.get(id)
    if (!w) {
      flag({ code: 'warranty_not_in_dump', table: 'warranties', legacyId: id, detail: 'service_items references a warranty id that has no row; items import with no warranty' })
      continue
    }
    const name = (w.warranty_name ?? '').trim()
    if (!name) {
      flag({ code: 'warranty_blank_name', table: 'warranties', legacyId: id, detail: 'warranty has no name; skipped' })
      continue
    }
    if ((termNameCount.get(name) ?? 0) > 1) {
      flag({ code: 'warranty_duplicate_name', table: 'warranties', legacyId: id, detail: `two prototype warranties are both named "${name}"; terms are matched by name, so neither is imported` })
      continue
    }
    // A value that cannot be read is reported and skipped. It must never fall
    // through as 0 (= "no limit of that kind") or as unlimited.
    const y = int(w.warranty_year), m = int(w.warranty_month), k = int(w.warranty_km)
    if (y === null || m === null || k === null) {
      flag({ code: 'warranty_unreadable_value', table: 'warranties', legacyId: id, detail: `"${name}": year/month/km = ${JSON.stringify([w.warranty_year, w.warranty_month, w.warranty_km])} is not three whole numbers; term skipped, items using it import with no warranty` })
      continue
    }
    const from = { year: y, month: m, km: k }
    const conv = convertWarranty(from.year, from.month, from.km)
    if ('problem' in conv) {
      flag({ code: 'warranty_unconvertible', table: 'warranties', legacyId: id, detail: `"${name}": ${conv.problem}; items using it import with no warranty` })
      continue
    }
    const matches = existing.terms.filter((t) => t.name === name)
    if (matches.length > 1) {
      flag({ code: 'warranty_target_ambiguous', table: 'warranties', legacyId: id, detail: `${matches.length} warranty_terms in the shop are already named "${name}"; not touching any of them` })
      continue
    }
    const hit = matches[0]
    // warranty_terms has no legacy key, so an existing term of the same name
    // may have been made by staff. Insert-if-missing ONLY: an existing term is
    // linked to but never modified, and a difference is reported for a person.
    if (hit && (hit.days !== conv.days || hit.max_km !== conv.maxKm)) {
      flag({ code: 'warranty_exists_differs', table: 'warranties', legacyId: id, detail: `"${name}": the shop already has a term with this name (days=${hit.days ?? 'NULL'}, max_km=${hit.max_km ?? 'NULL'}); dump says days=${conv.days ?? 'NULL'}, max_km=${conv.maxKm ?? 'NULL'}. Existing term kept and linked, not changed` })
    }
    const action: Action = hit ? 'unchanged' : 'insert'
    const plan: TermPlan = { action, legacyId: id, name, days: conv.days, maxKm: conv.maxKm, existingId: hit?.id ?? null, from, isActive: !INACTIVE_WARRANTY_LEGACY_IDS.includes(id) }
    terms.push(plan)
    termByLegacy.set(id, plan)
  }

  const byId = new Map(src.service_items.map((r) => [r.id!, r]))
  const compCount = new Map<string, number>()
  for (const c of src.service_item_components) compCount.set(c.service_item_id!, (compCount.get(c.service_item_id!) ?? 0) + 1)
  const items: ItemPlan[] = []
  const importedItemIds = new Set<string>()
  const mergedSkipped = new Set<string>()
  for (const r of src.service_items) {
    const legacyId = r.id!
    const category = (r.category ?? '').trim()
    const name = (r.product_name ?? '').trim()
    if (!category || !name) {
      flag({ code: 'item_blank_category_or_name', table: 'service_items', legacyId, detail: 'category or name is empty; skipped' })
      continue
    }
    const key = `${priceKey(category)}\u0000${priceKey(name)}`
    const group = sourceKeyCount.get(key)!
    if (group.length > 1) {
      // Owner decision (option A): the catalog allows one live item per
      // normalised (category, name), so the lowest legacy id is imported and the
      // others are held for review (they are all listed in review-duplicates.csv).
      const winner = [...group].sort((a, b) => Number(a) - Number(b))[0]!
      if (legacyId !== winner) {
        flag({ code: 'item_duplicate_in_source', table: 'service_items', legacyId, detail: `"${category}" / "${name}" appears ${group.length} times in the prototype; #${winner} (lowest id) is imported, this one is NOT, listed in review-duplicates.csv for a person to merge. Side by side: ${group.map((g) => describeRow(byId.get(g)!, compCount)).join(' || ')}` })
        continue
      }
    }
    const prior = existingByLegacy.get(legacyId)
    if (prior?.merged) {
      // A person merged this item into another in the app. Writing to it again
      // would fight their decision (and trip ck_catalog_merged_inactive).
      mergedSkipped.add(legacyId)
      flag({ code: 'item_merged_locally_skipped', table: 'service_items', legacyId, detail: `"${name}": merged into another item in the app; left untouched` })
      continue
    }
    const clash = liveByKey.get(key)
    if (clash && clash.legacy_id !== legacyId) {
      flag({ code: 'item_name_taken', table: 'service_items', legacyId, detail: `"${category}" / "${name}" already exists in the shop as a different catalog row (${clash.legacy_id === null ? 'created by hand' : 'legacy ' + clash.legacy_id}); not overwritten` })
      continue
    }

    const price = convertPrice(r.set_price ?? null)
    if (price.note === 'null_in_source') priceNulls.nullInSource++
    else if (price.note === 'zero_means_unpriced') {
      priceNulls.zero++
      flag({ code: 'price_zero_to_null', table: 'service_items', legacyId, detail: `"${name}": set_price is 0 and the prototype cannot say "free" from "unpriced"; imported as NULL (no price). Set 0 by hand if it really is free` })
    } else if (price.note === 'negative') {
      priceNulls.negative++
      flag({ code: 'price_negative', table: 'service_items', legacyId, detail: `"${name}": set_price is ${r.set_price}; imported as NULL` })
    } else if (price.note === 'unparseable') {
      priceNulls.unparseable++
      flag({ code: 'price_unparseable', table: 'service_items', legacyId, detail: `"${name}": set_price ${JSON.stringify(r.set_price)} is not a 2-decimal amount; imported as NULL` })
    }

    let warrantyLegacyId: string | null = null
    const wid = r.warranty_id ?? null
    if (wid !== null) {
      if (termByLegacy.has(wid)) warrantyLegacyId = wid
      else flag({ code: 'item_warranty_dropped', table: 'service_items', legacyId, detail: `"${name}": warranty ${wid} could not be imported (see the warranty entries); item imported with no warranty` })
    }

    // Staff prices win (gsms-lead ruling): a non-NULL price already in the DB is
    // never replaced, neither by NULL nor by a different dump value.
    let basePrice = price.price
    if (prior && prior.base_price !== null) {
      if (price.price !== null && price.price !== prior.base_price) {
        flag({ code: 'price_differs', table: 'service_items', legacyId, detail: `"${name}": DB has ${prior.base_price}, dump has ${price.price}; DB price kept` })
      }
      basePrice = prior.base_price
    }

    const isSet = r.is_set === '1'
    const isActive = r.is_active === null ? true : r.is_active === '1'
    const targetWarrantyName = warrantyLegacyId ? termByLegacy.get(warrantyLegacyId)!.name : null
    const unchanged =
      prior &&
      prior.category === category && prior.name === name && prior.is_set === isSet &&
      prior.is_active === isActive && prior.base_price === basePrice &&
      prior.warranty_term_name === targetWarrantyName
    items.push({
      action: !prior ? 'insert' : unchanged ? 'unchanged' : 'update',
      legacyId, category, name, isSet, isActive, basePrice, warrantyLegacyId,
      existingId: prior?.id ?? null,
    })
    importedItemIds.add(legacyId)
  }

  // ---- components ------------------------------------------------------------
  const itemByLegacy = new Map(items.map((i) => [i.legacyId, i]))
  const existingComp = new Map(existing.components.map((c) => [`${c.set_item_id}\u0000${c.sort_order}`, c]))
  const seenSlot = new Map<string, string[]>()
  for (const c of src.service_item_components) {
    const k = `${c.service_item_id}\u0000${c.sort_order}`
    seenSlot.set(k, [...(seenSlot.get(k) ?? []), c.id!])
  }
  const components: ComponentPlan[] = []
  const setsWithComponents = new Set<string>()
  for (const c of src.service_item_components) {
    const legacyId = c.id!
    const setLegacy = c.service_item_id!
    const set = itemByLegacy.get(setLegacy)
    if (!set && mergedSkipped.has(setLegacy)) continue // already reported with its parent
    if (!set) {
      flag({ code: 'component_set_not_imported', table: 'service_item_components', legacyId, detail: `parent item ${setLegacy} was not imported (missing or skipped); component skipped` })
      continue
    }
    const name = (c.component_name ?? '').trim()
    const qtyN = int(c.default_qty)
    const sortOrder = int(c.sort_order)
    if (!name || qtyN === null || qtyN <= 0 || sortOrder === null) {
      flag({ code: 'component_invalid', table: 'service_item_components', legacyId, detail: `name=${JSON.stringify(name)} default_qty=${c.default_qty} sort_order=${c.sort_order}; qty must be > 0; skipped` })
      continue
    }
    const slot = seenSlot.get(`${setLegacy}\u0000${c.sort_order}`)!
    if (slot.length > 1) {
      flag({ code: 'component_duplicate_slot', table: 'service_item_components', legacyId, detail: `set ${setLegacy} has ${slot.length} components with sort_order ${sortOrder} (ids ${slot.join(', ')}); components are keyed on (set, sort_order), so none of these are imported` })
      continue
    }
    if (!set.isSet) {
      flag({ code: 'component_on_non_set', table: 'service_item_components', legacyId, detail: `parent item ${setLegacy} ("${set.name}") is not flagged is_set but has components; imported as-is, review` })
    }
    setsWithComponents.add(setLegacy)
    const prior = set.existingId ? existingComp.get(`${set.existingId}\u0000${sortOrder}`) : undefined
    const qty = `${qtyN}.00`
    components.push({
      action: !prior ? 'insert' : prior.component_name === name && prior.qty === qty ? 'unchanged' : 'update',
      legacyId, legacySetId: setLegacy, name, qty, sortOrder, existingId: prior?.id ?? null,
    })
  }
  for (const i of items) {
    if (i.isSet && !setsWithComponents.has(i.legacyId)) {
      flag({ code: 'set_without_components', table: 'service_items', legacyId: i.legacyId, detail: `"${i.name}" is flagged is_set but has no importable components` })
    }
  }
  // Components keep line_type 'part' (the table default). The names include
  // labour ("ประกอบติดตั้ง รวมตั้งศูนย์"), but CLAUDE.md 5.2 forbids guessing a
  // line type from a name, so it is one line in the report, not per row.
  // component_item_id stays NULL for the same reason: linking by name is a guess.

  return { terms, items, components, ambiguities, priceNulls }
}

export function countByAction<T extends { action: Action }>(rows: T[]): Record<Action, number> {
  const out: Record<Action, number> = { insert: 0, update: 0, unchanged: 0 }
  for (const r of rows) out[r.action]++
  return out
}
