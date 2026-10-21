/**
 * WO-006 / WO-004: turn the prototype's two part tables into a SKU import plan.
 *
 *   racks      (model_code unique)   -> skus   legacy_source 'rack'      category 'แร็ค'
 *   wing_arms  (sku unique)          -> skus   legacy_source 'wing_arm'  category 'ปีกนก'
 *
 * QUANTITIES ARE NEVER IMPORTED (Ice, WO-004 s1: staff count the shelves in the new system). The
 * prototype's stock_qty is read for exactly ONE bit: "was it above zero?", stored as
 * skus.legacy_had_stock so the count screen can list the parts that actually sit on the shelf first
 * (319 of 512 in the 16 Sep dump). A stock_balances row is never created here: every imported SKU is
 * "not counted" until somebody counts it.
 *
 * Pure: rows already read from the dump + a snapshot of the target shop in, a plan out. Nothing here
 * touches a database, so --dry-run and the real run share one code path. WO-004 s2.5: ambiguity goes
 * into the report, never into a guess - each branch that would have to guess records an Ambiguity.
 */
import { priceKey } from '@champpower/domain'
import type { DumpRow } from './mysqlDump.js'

export const RACK_SOURCE = 'rack'
export const WING_ARM_SOURCE = 'wing_arm'
// DEFAULT pending Ice (category names): free text in skus.category; chosen to match how the shop says them.
export const RACK_CATEGORY = 'แร็ค'
export const WING_ARM_CATEGORY = 'ปีกนก'

export interface SourceSkuTables {
  racks: DumpRow[]
  wing_arms: DumpRow[]
}

export interface ExistingSku {
  id: string
  code: string
  name: string
  category: string | null
  reorder_point: string | null
  legacy_source: string | null
  legacy_id: string | null
  legacy_had_stock: boolean | null
}

export interface Ambiguity {
  code:
    | 'empty_code' | 'empty_name' | 'bad_id' | 'bad_stock_qty' | 'bad_min_stock'
    | 'code_collision' | 'code_case_variant' | 'code_taken_by_other_sku' | 'code_changed_in_dump'
  source: string
  legacyId: string | null
  detail: string
}

export interface PlannedSku {
  action: 'insert' | 'update' | 'unchanged'
  source: typeof RACK_SOURCE | typeof WING_ARM_SOURCE
  legacyId: string
  code: string
  name: string
  category: string
  /** numeric(12,2) text from the prototype's min_stock, or null if unreadable. */
  reorderPoint: string | null
  hadStock: boolean
  existingId: string | null
  /** For an update: which columns change (readable, for the report). */
  changes: string[]
}

export interface SkuPlan {
  items: PlannedSku[]
  ambiguities: Ambiguity[]
  /** Parts whose prototype stock_qty was above zero (the count-screen ordering). */
  hadStock: number
  /** min_stock value -> how many parts, so the owner can see how meaningful the reorder points are. */
  minStockHistogram: Array<[string, number]>
}

interface Candidate {
  source: PlannedSku['source']
  legacyId: string
  code: string
  name: string
  category: string
  reorderPoint: string | null
  hadStock: boolean
}

function nonNegInt(v: string | null | undefined): number | null {
  if (v == null) return null
  const t = v.trim()
  return /^\d{1,9}$/.test(t) ? Number(t) : null
}

/** Reads one row of either table into a candidate, or records why it cannot be imported. */
function toCandidate(
  source: Candidate['source'], row: DumpRow, codeColumn: string, category: string, amb: Ambiguity[],
): Candidate | null {
  const legacyId = row.id?.trim() ?? ''
  if (!/^\d+$/.test(legacyId)) {
    amb.push({ code: 'bad_id', source, legacyId: null, detail: 'row has no numeric id' })
    return null
  }
  const code = (row[codeColumn] ?? '').trim()
  if (!code) {
    amb.push({ code: 'empty_code', source, legacyId, detail: `${codeColumn} is empty` })
    return null
  }
  const name = (row.name ?? '').trim()
  if (!name) {
    amb.push({ code: 'empty_name', source, legacyId, detail: `code ${code} has no name` })
    return null
  }
  const qty = nonNegInt(row.stock_qty)
  const hadStock = qty !== null && qty > 0
  if (qty === null) amb.push({ code: 'bad_stock_qty', source, legacyId, detail: `code ${code}: stock_qty is not a whole number; treated as "no stock" for the ordering only` })
  const min = nonNegInt(row.min_stock)
  if (min === null) amb.push({ code: 'bad_min_stock', source, legacyId, detail: `code ${code}: min_stock is not a whole number; reorder point left empty` })
  return { source, legacyId, code, name, category, reorderPoint: min === null ? null : `${min}.00`, hadStock }
}

export function buildSkuPlan(src: SourceSkuTables, existing: readonly ExistingSku[]): SkuPlan {
  const ambiguities: Ambiguity[] = []
  const candidates: Candidate[] = []
  for (const r of src.racks) {
    const c = toCandidate(RACK_SOURCE, r, 'model_code', RACK_CATEGORY, ambiguities)
    if (c) candidates.push(c)
  }
  for (const r of src.wing_arms) {
    const c = toCandidate(WING_ARM_SOURCE, r, 'sku', WING_ARM_CATEGORY, ambiguities)
    if (c) candidates.push(c)
  }

  // The same code in both tables (or twice in one) cannot be told apart by QR: neither side is
  // imported, a person decides. Case-only variants are different strings in the database, so both
  // are imported, but they are listed because a hand-typed scan code can confuse them.
  const byCode = new Map<string, Candidate[]>()
  for (const c of candidates) byCode.set(c.code, [...(byCode.get(c.code) ?? []), c])
  const blocked = new Set<Candidate>()
  for (const [code, group] of byCode) {
    if (group.length < 2) continue
    for (const c of group) {
      blocked.add(c)
      ambiguities.push({ code: 'code_collision', source: c.source, legacyId: c.legacyId, detail: `code ${code} appears ${group.length} times in the dump (${group.map((g) => `${g.source}#${g.legacyId}`).join(', ')}); none imported` })
    }
  }
  const byLower = new Map<string, Set<string>>()
  for (const c of candidates) byLower.set(c.code.toLowerCase(), (byLower.get(c.code.toLowerCase()) ?? new Set()).add(c.code))
  for (const [lower, codes] of byLower) {
    if (codes.size < 2) continue
    ambiguities.push({ code: 'code_case_variant', source: 'both', legacyId: null, detail: `codes differing only by case: ${[...codes].join(' / ')} (imported as distinct codes; check the shelf labels)` })
    void lower
  }

  const byLegacy = new Map(existing.filter((e) => e.legacy_source && e.legacy_id).map((e) => [`${e.legacy_source}:${e.legacy_id}`, e]))
  const byExistingCode = new Map(existing.map((e) => [e.code, e]))

  const items: PlannedSku[] = []
  for (const c of candidates) {
    if (blocked.has(c)) continue
    const hit = byLegacy.get(`${c.source}:${c.legacyId}`)
    if (hit) {
      // Re-run: the dump wins for name / category / the had-stock hint. A reorder point a person set is kept;
      // one nobody set is filled from min_stock. The code is never changed (labels are printed from it).
      if (hit.code !== c.code) {
        ambiguities.push({ code: 'code_changed_in_dump', source: c.source, legacyId: c.legacyId, detail: `database keeps ${hit.code}; dump now says ${c.code}. Code left as it is.` })
      }
      const changes: string[] = []
      if (hit.name !== c.name) changes.push('name')
      if (hit.category !== c.category) changes.push('category')
      if (hit.legacy_had_stock !== c.hadStock) changes.push('legacy_had_stock')
      if (hit.reorder_point === null && c.reorderPoint !== null) changes.push('reorder_point')
      items.push({ action: changes.length > 0 ? 'update' : 'unchanged', source: c.source, legacyId: c.legacyId, code: hit.code, name: c.name, category: c.category, reorderPoint: c.reorderPoint, hadStock: c.hadStock, existingId: hit.id, changes })
      continue
    }
    const taken = byExistingCode.get(c.code)
    if (taken) {
      ambiguities.push({ code: 'code_taken_by_other_sku', source: c.source, legacyId: c.legacyId, detail: `code ${c.code} already belongs to an existing SKU "${taken.name}" that is not from this import; not claimed, not changed` })
      continue
    }
    items.push({ action: 'insert', source: c.source, legacyId: c.legacyId, code: c.code, name: c.name, category: c.category, reorderPoint: c.reorderPoint, hadStock: c.hadStock, existingId: null, changes: [] })
  }

  const hist = new Map<string, number>()
  for (const c of candidates) hist.set(c.reorderPoint ?? '(unreadable)', (hist.get(c.reorderPoint ?? '(unreadable)') ?? 0) + 1)
  return {
    items,
    ambiguities,
    hadStock: candidates.filter((c) => c.hadStock).length,
    minStockHistogram: [...hist.entries()].sort((a, b) => b[1] - a[1]),
  }
}

export function countSkuActions(items: readonly { action: 'insert' | 'update' | 'unchanged' }[]): Record<'insert' | 'update' | 'unchanged', number> {
  const n = { insert: 0, update: 0, unchanged: 0 }
  for (const i of items) n[i.action]++
  return n
}

// -----------------------------------------------------------------------------
// Catalog <-> SKU suggestions: for a PERSON to read. Nothing here binds anything.
// -----------------------------------------------------------------------------

export interface CatalogPart { id: string; category: string; name: string }
export interface SkuName { code: string; name: string }
export interface Suggestion { itemId: string; category: string; itemName: string; match: 'exact' | 'contains'; skuCode: string; skuName: string }

const MIN_CONTAINS_KEY = 6
const MAX_PER_ITEM = 5

/**
 * Exact (same name after normalising) or contained (one name inside the other, at least 6 characters
 * so "ลูกหมาก" alone does not match half the shelf). At most 5 per catalog item. Linking by name is a
 * guess - which is exactly why this only writes a file.
 */
export function suggestLinks(items: readonly CatalogPart[], skus: readonly SkuName[]): Suggestion[] {
  const keyed = skus.map((s) => ({ ...s, key: priceKey(s.name) }))
  const out: Suggestion[] = []
  for (const it of items) {
    const k = priceKey(it.name)
    if (!k) continue
    const exact = keyed.filter((s) => s.key === k)
    const found = exact.length > 0
      ? exact.map((s) => ({ s, match: 'exact' as const }))
      : keyed.filter((s) => s.key.length >= MIN_CONTAINS_KEY && k.length >= MIN_CONTAINS_KEY && (s.key.includes(k) || k.includes(s.key))).map((s) => ({ s, match: 'contains' as const }))
    for (const f of found.slice(0, MAX_PER_ITEM)) out.push({ itemId: it.id, category: it.category, itemName: it.name, match: f.match, skuCode: f.s.code, skuName: f.s.name })
  }
  return out
}

function csvCell(v: string): string {
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
}

export function suggestionsCsv(rows: readonly Suggestion[]): string {
  const head = 'catalog_item_id,category,item_name,match,sku_code,sku_name'
  return [head, ...rows.map((r) => [r.itemId, r.category, r.itemName, r.match, r.skuCode, r.skuName].map(csvCell).join(','))].join('\n') + '\n'
}

export function hadStockCsv(items: readonly PlannedSku[]): string {
  const rows = items.filter((i) => i.hadStock).sort((a, b) => a.category.localeCompare(b.category) || a.code.localeCompare(b.code))
  return ['code,name,category,source', ...rows.map((i) => [i.code, i.name, i.category, i.source].map(csvCell).join(','))].join('\n') + '\n'
}
