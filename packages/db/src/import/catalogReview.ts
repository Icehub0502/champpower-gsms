/**
 * Review artefacts for the catalog import: warranty usage in old documents
 * (counts only) and the duplicate-name CSV. Pure functions, no I/O.
 */
import { priceKey } from '@champpower/domain'
import type { DumpRow } from './mysqlDump.js'

// -----------------------------------------------------------------------------
// Warranty usage in old documents
// -----------------------------------------------------------------------------

export interface WarrantyUsage {
  quotationLines: number
  quotationDocs: number
  receiptLines: number
  receiptDocs: number
}

/** The only columns of quotation_items / receipt_items the importer ever keeps. */
export const USAGE_COLUMNS = {
  quotation_items: ['quotation_id', 'warranty_name'],
  receipt_items: ['receipt_id', 'warranty_name'],
} as const

/**
 * How many old document lines carry this warranty. Old documents keep only a
 * text copy (warranty_name), not a warranty id, so the match is exact on the
 * trimmed name. Rows arrive already projected to the parent id and the warranty
 * name; only counts leave this function.
 */
export function countWarrantyUse(
  quotationItems: DumpRow[],
  receiptItems: DumpRow[],
  warrantyName: string,
): WarrantyUsage {
  const count = (rows: DumpRow[], parentCol: string) => {
    const hits = rows.filter((r) => (r.warranty_name ?? '').trim() === warrantyName)
    return { lines: hits.length, docs: new Set(hits.map((r) => r[parentCol])).size }
  }
  const q = count(quotationItems, 'quotation_id')
  const r = count(receiptItems, 'receipt_id')
  return { quotationLines: q.lines, quotationDocs: q.docs, receiptLines: r.lines, receiptDocs: r.docs }
}

// -----------------------------------------------------------------------------
// Duplicate catalog names (for the human-review CSV)
// -----------------------------------------------------------------------------

export interface DuplicateGroup {
  categoryKey: string
  nameKey: string
  /** The member the importer imports (lowest numeric id); the rest are held for review. */
  importedLegacyId: string
  legacyIds: string[]
  names: string[]
  categories: string[]
  createdAt: string[]
  setPrices: string[]
  warrantyIds: string[]
  componentCounts: number[]
}

/** Prototype rows sharing one normalised (category, name) key, whatever the final import choice. */
export function duplicateGroups(items: DumpRow[], components: DumpRow[] = []): DuplicateGroup[] {
  const groups = new Map<string, DumpRow[]>()
  for (const r of items) {
    // Keyed on the pair, kept apart (never glued with a separator that a name could contain).
    const key = JSON.stringify([priceKey((r.category ?? '').trim()), priceKey((r.product_name ?? '').trim())])
    groups.set(key, [...(groups.get(key) ?? []), r])
  }
  const compCount = new Map<string, number>()
  for (const c of components) compCount.set(c.service_item_id!, (compCount.get(c.service_item_id!) ?? 0) + 1)
  return [...groups].filter(([, rows]) => rows.length > 1).map(([key, rows]) => {
    const [categoryKey, nameKey] = JSON.parse(key) as [string, string]
    return {
      categoryKey, nameKey,
      importedLegacyId: rows.map((r) => r.id!).sort((a, b) => Number(a) - Number(b))[0]!,
      legacyIds: rows.map((r) => r.id!),
      names: rows.map((r) => r.product_name ?? ''),
      categories: rows.map((r) => r.category ?? ''),
      createdAt: rows.map((r) => r.created_at ?? ''),
      setPrices: rows.map((r) => r.set_price ?? ''),
      warrantyIds: rows.map((r) => r.warranty_id ?? ''),
      componentCounts: rows.map((r) => compCount.get(r.id!) ?? 0),
    }
  })
}

/**
 * One CSV cell. Quotes anything with a comma, quote, CR or LF, and neutralises a
 * leading = + - @ (spreadsheet formula injection) by prefixing an apostrophe.
 */
export function csvCell(v: string): string {
  const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}

/** WO-004 section 3 columns, adapted for the catalog. */
export function duplicatesCsv(groups: DuplicateGroup[]): string {
  const head = [
    'kind', 'normalised_category_key', 'normalised_name_key', 'imported_legacy_id', 'legacy_ids', 'names',
    'categories', 'created_at', 'set_price', 'warranty_ids', 'component_counts',
  ]
  const rows = groups.map((g) => [
    'catalog_item', g.categoryKey, g.nameKey, g.importedLegacyId, g.legacyIds.join(' | '), g.names.join(' | '),
    g.categories.join(' | '), g.createdAt.join(' | '), g.setPrices.join(' | '), g.warrantyIds.join(' | '),
    g.componentCounts.join(' | '),
  ])
  // BOM so Excel reads the Thai text as UTF-8.
  return '﻿' + [head, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n'
}

