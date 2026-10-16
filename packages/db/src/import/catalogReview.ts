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
  key: string
  legacyIds: string[]
  names: string[]
  categories: string[]
  createdAt: string[]
}

/** Prototype rows sharing one normalised (category, name) key, whatever the final import choice. */
export function duplicateGroups(items: DumpRow[]): DuplicateGroup[] {
  const groups = new Map<string, DumpRow[]>()
  for (const r of items) {
    const key = `${priceKey((r.category ?? '').trim())}|${priceKey((r.product_name ?? '').trim())}`
    groups.set(key, [...(groups.get(key) ?? []), r])
  }
  return [...groups].filter(([, rows]) => rows.length > 1).map(([key, rows]) => ({
    key,
    legacyIds: rows.map((r) => r.id!),
    names: rows.map((r) => r.product_name ?? ''),
    categories: rows.map((r) => r.category ?? ''),
    createdAt: rows.map((r) => r.created_at ?? ''),
  }))
}

const csvCell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)

/** WO-004 section 3 columns, adapted for the catalog. */
export function duplicatesCsv(groups: DuplicateGroup[]): string {
  const head = ['kind', 'normalised_key', 'legacy_ids', 'names', 'categories', 'created_at']
  const rows = groups.map((g) => [
    'catalog_item', g.key, g.legacyIds.join(' | '), g.names.join(' | '), g.categories.join(' | '), g.createdAt.join(' | '),
  ])
  // BOM so Excel reads the Thai text as UTF-8.
  return '﻿' + [head, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n'
}
