/**
 * Catalog pricing (P3.1): search results with resolved prices, the first-price
 * rule (D8), fixing a wrong standard price (manager+), duplicate-name
 * detection and merge (D12).
 *
 * NEVER return a cost field from here — there is none to return; the catalog
 * has no cost column at all (CLAUDE.md §12.2). Every price this module
 * produces is a SELLING price.
 */
import {
  findSimilarNames, isPriceUnset, resolvePrice, warrantySnapshotOf,
  wouldCreateMergeCycle, type MergeableItem,
} from '@champpower/domain'
import type { ScopedTx } from '@gsms/db/client.js'
import * as catalogRepo from '../repositories/catalog.js'
import * as quotationRepo from '../repositories/quotation.js'
import { writeAudit } from './audit.js'

export interface SearchHit {
  section: 'set' | 'frequent' | 'offered' | 'other'
  itemId: string | null
  offeredItemId: string | null
  category: string | null
  name: string
  lineType: string
  unit: string | null
  defaultQty: string
  isSet: boolean
  componentCount: number
  price: string | null
  priceSource: 'model' | 'base' | 'none'
  priceRefId: string | null
  warranty: { termId: string; name: string; days: number | null; maxKm: number | null } | null
}

function warrantyOf(row: { warranty_term_id: string | null; warranty_name: string | null; warranty_days: number | null; warranty_max_km: number | null }) {
  return row.warranty_term_id
    ? { termId: row.warranty_term_id, name: row.warranty_name!, days: row.warranty_days, maxKm: row.warranty_max_km }
    : null
}

async function priceFor(trx: ScopedTx, itemId: string, basePrice: string | null, vehicleModelId: string | null) {
  const modelPrice = vehicleModelId ? await catalogRepo.getModelPrice(trx, itemId, vehicleModelId) : undefined
  const resolved = resolvePrice({ modelPrice: modelPrice?.price ?? null, basePrice })
  return { price: resolved.price, priceSource: resolved.source, priceRefId: resolved.source === 'model' ? (modelPrice?.id ?? null) : null }
}

/** Sets first, then the shop's most-used items, then this vehicle's offered items, then the rest — owner decision 16. */
export async function searchCatalog(
  trx: ScopedTx,
  input: { q: string; jobId: string; limit: number },
): Promise<{ items: SearchHit[]; vehicleModelLinked: boolean }> {
  const job = await quotationRepo.jobWithVehicle(trx, input.jobId)
  const vehicleModelId = job?.vehicle_model_id ?? null

  const byName = await catalogRepo.searchItemsByName(trx, input.q, input.limit)
  const seen = new Set(byName.map((r) => r.id))

  const out: SearchHit[] = []
  for (const row of byName) {
    const componentCount = row.is_set ? (await catalogRepo.getSetComponents(trx, row.id)).length : 0
    const p = await priceFor(trx, row.id, row.base_price, vehicleModelId)
    out.push({
      section: row.is_set ? 'set' : 'other',
      itemId: row.id, offeredItemId: null,
      category: row.category, name: row.name, lineType: row.line_type, unit: row.unit,
      defaultQty: row.default_qty, isSet: row.is_set, componentCount,
      price: p.price, priceSource: p.priceSource, priceRefId: p.priceRefId,
      warranty: warrantyOf(row),
    })
  }

  if (job) {
    const offered = await quotationRepo.listOfferedItems(trx, job.vehicle_id, 10, 0)
    for (const o of offered.rows) {
      if (o.catalog_item_id && seen.has(o.catalog_item_id)) continue
      out.push({
        section: 'offered', itemId: o.catalog_item_id, offeredItemId: o.id,
        category: null, name: o.name, lineType: o.line_type, unit: null, defaultQty: o.qty,
        isSet: false, componentCount: 0, price: o.unit_price, priceSource: 'none', priceRefId: null,
        warranty: null,
      })
    }
  }

  out.sort((a, b) => (a.section === 'set' && b.section !== 'set' ? -1 : b.section === 'set' && a.section !== 'set' ? 1 : 0))
  return { items: out.slice(0, input.limit), vehicleModelLinked: vehicleModelId !== null }
}

export type FirstPriceResult =
  | { ok: true; priceId: string; itemId: string; scope: 'model' | 'base'; price: string }
  | { ok: false; existingPrice: string; scope: 'model' | 'base' }

/**
 * D8: the first price typed for an item on a car model becomes that model's
 * standard price — written only when none exists. First writer wins: the
 * condition lives in the SQL (ON CONFLICT / WHERE base_price IS NULL), so two
 * staff typing the same first price at once never both "win".
 */
export async function writeFirstPrice(
  trx: ScopedTx,
  input: { shopId: string; jobId: string; itemId: string; price: string; actorId: string },
): Promise<FirstPriceResult> {
  const job = await quotationRepo.jobWithVehicle(trx, input.jobId)
  const item = await catalogRepo.getItemById(trx, input.itemId)

  if (job?.vehicle_model_id) {
    const written = await catalogRepo.insertModelPriceIfAbsent(trx, {
      shopId: input.shopId, itemId: input.itemId, vehicleModelId: job.vehicle_model_id,
      price: input.price, setBy: input.actorId,
    })
    if (written) {
      await writeAudit(trx, {
        shopId: input.shopId, actorId: input.actorId, action: 'catalog_price_set',
        entityType: 'catalog_model_prices', entityId: written.id,
        after: { itemId: input.itemId, vehicleModelId: job.vehicle_model_id, price: written.price },
      })
      return { ok: true, priceId: written.id, itemId: input.itemId, scope: 'model', price: written.price }
    }
    const existing = await catalogRepo.getModelPrice(trx, input.itemId, job.vehicle_model_id)
    return { ok: false, existingPrice: existing!.price, scope: 'model' }
  }

  // No controlled model for this car — fall back to the item's base price,
  // same first-writer-wins shape (D8/v3 §4.2).
  if (item && isPriceUnset(item.base_price)) {
    const wrote = await catalogRepo.setBasePriceIfAbsent(trx, input.itemId, input.price)
    if (wrote) {
      await writeAudit(trx, {
        shopId: input.shopId, actorId: input.actorId, action: 'catalog_price_set',
        entityType: 'catalog_items', entityId: input.itemId,
        after: { basePrice: input.price },
      })
      return { ok: true, priceId: input.itemId, itemId: input.itemId, scope: 'base', price: input.price }
    }
  }
  const fresh = await catalogRepo.getItemById(trx, input.itemId)
  return { ok: false, existingPrice: fresh!.base_price!, scope: 'base' }
}

/** manager+ — checked by the route. Mandatory reason; audit keeps old -> new. */
export async function fixPrice(
  trx: ScopedTx,
  input: { shopId: string; scope: 'model' | 'base'; id: string; price: string; reason: string; actorId: string },
): Promise<{ id: string; price: string } | undefined> {
  if (input.scope === 'model') {
    const before = await catalogRepo.getModelPriceById(trx, input.id)
    const row = await catalogRepo.fixModelPrice(trx, input.id, input.price, input.actorId)
    if (!row) return undefined
    await writeAudit(trx, {
      shopId: input.shopId, actorId: input.actorId, action: 'catalog_price_corrected',
      entityType: 'catalog_model_prices', entityId: input.id,
      before: { price: before?.price ?? null, reason: input.reason }, after: { price: row.price },
    })
    return row
  }
  const before = await catalogRepo.getItemById(trx, input.id)
  const row = await catalogRepo.fixBasePrice(trx, input.id, input.price)
  if (!row) return undefined
  await writeAudit(trx, {
    shopId: input.shopId, actorId: input.actorId, action: 'catalog_price_corrected',
    entityType: 'catalog_items', entityId: input.id,
    before: { price: before?.base_price ?? null, reason: input.reason }, after: { price: row.price },
  })
  return row
}

export interface SimilarHit { id: string; category: string; name: string }

export async function findSimilar(trx: ScopedTx, category: string, name: string): Promise<SimilarHit[]> {
  const candidates = await catalogRepo.itemsInCategory(trx, category)
  return findSimilarNames(name, candidates).slice(0, 10)
}

/** D12: add to the catalog, by default — called by the quotation service when a free-text line opts in. */
export async function createItem(
  trx: ScopedTx,
  input: { shopId: string; category: string; name: string; lineType: string; unit: string | null; defaultQty: string; warrantyTermId: string | null; actorId: string },
) {
  const item = await catalogRepo.insertItem(trx, {
    shopId: input.shopId, category: input.category, name: input.name, lineType: input.lineType,
    unit: input.unit, defaultQty: input.defaultQty, warrantyTermId: input.warrantyTermId, createdBy: input.actorId,
  })
  await writeAudit(trx, {
    shopId: input.shopId, actorId: input.actorId, action: 'catalog_item_created',
    entityType: 'catalog_items', entityId: item.id, after: { category: input.category, name: input.name },
  })
  return item
}

export type MergeResult =
  | { ok: true; movedPrices: number; droppedPrices: number }
  | { ok: false; code: 'not_allowed' }
  | { ok: false; code: 'conflict'; vehicleModelIds: string[] }

/** manager+. Merges `sourceItemId` into `intoItemId` (D12). `resolveCatalogItem` in domain is how every later read follows this link. */
export async function mergeItems(
  trx: ScopedTx,
  input: {
    shopId: string
    sourceItemId: string
    intoItemId: string
    priceConflicts: ReadonlyArray<{ vehicleModelId: string; keep: 'source' | 'target' }>
    reason: string | undefined
    actorId: string
  },
): Promise<MergeResult> {
  const [source, target] = await Promise.all([
    catalogRepo.getItemById(trx, input.sourceItemId),
    catalogRepo.getItemById(trx, input.intoItemId),
  ])
  if (!source || !target) return { ok: false, code: 'not_allowed' }

  const items = new Map<string, MergeableItem>([
    [source.id, { id: source.id, mergedIntoId: source.merged_into_id }],
    [target.id, { id: target.id, mergedIntoId: target.merged_into_id }],
  ])
  if (wouldCreateMergeCycle(input.sourceItemId, input.intoItemId, items)) return { ok: false, code: 'not_allowed' }

  const [sourcePrices, targetPrices] = await Promise.all([
    catalogRepo.modelPricesOfItem(trx, input.sourceItemId),
    catalogRepo.modelPricesOfItem(trx, input.intoItemId),
  ])
  const targetByModel = new Map(targetPrices.map((p) => [p.vehicle_model_id, p]))
  const resolvedConflicts = new Map(input.priceConflicts.map((c) => [c.vehicleModelId, c.keep]))

  const conflicts = sourcePrices.filter((p) => targetByModel.has(p.vehicle_model_id) && !resolvedConflicts.has(p.vehicle_model_id))
  if (conflicts.length > 0) {
    return { ok: false, code: 'conflict', vehicleModelIds: conflicts.map((c) => c.vehicle_model_id) }
  }

  let moved = 0
  let dropped = 0
  for (const p of sourcePrices) {
    const clash = targetByModel.get(p.vehicle_model_id)
    if (!clash) {
      await catalogRepo.moveModelPrice(trx, p.id, input.intoItemId)
      moved++
    } else if (resolvedConflicts.get(p.vehicle_model_id) === 'source') {
      await catalogRepo.deleteModelPrices(trx, [clash.id])
      await catalogRepo.moveModelPrice(trx, p.id, input.intoItemId)
      moved++
    } else {
      await catalogRepo.deleteModelPrices(trx, [p.id])
      dropped++
    }
  }

  await catalogRepo.markMerged(trx, input.sourceItemId, input.intoItemId)
  await writeAudit(trx, {
    shopId: input.shopId, actorId: input.actorId, action: 'catalog_item_merged',
    entityType: 'catalog_items', entityId: input.sourceItemId,
    before: { reason: input.reason ?? null },
    after: { mergedIntoId: input.intoItemId, movedPrices: moved, droppedPrices: dropped },
  })
  return { ok: true, movedPrices: moved, droppedPrices: dropped }
}

/** The warranty snapshot for a catalog item, via the ONE domain function. */
export async function warrantySnapshotOfItem(trx: ScopedTx, item: catalogRepo.CatalogItemRow | undefined) {
  if (!item?.warranty_term_id) return warrantySnapshotOf(null)
  return warrantySnapshotOf({ id: item.warranty_term_id, name: item.warranty_name!, days: item.warranty_days, maxKm: item.warranty_max_km })
}
