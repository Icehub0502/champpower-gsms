/**
 * The selling catalog: items, sets, per-model prices, and the controlled
 * vehicle-model list. Every function takes a ScopedTx, so RLS scopes every
 * row to the caller's shop.
 *
 * NEVER select `catalog_items.base_price` or `catalog_model_prices.price`
 * for a caller whose role is `advisor` — that filtering happens in the
 * service/route layer (CLAUDE.md §12.2), not here; this file always has
 * access to the real price so the gate is where the ROLE is known.
 */
import { sql } from 'kysely'
import type { ScopedTx } from '@gsms/db/client.js'

export interface CatalogItemRow {
  id: string
  category: string
  name: string
  line_type: string
  unit: string | null
  default_qty: string
  is_set: boolean
  base_price: string | null
  warranty_term_id: string | null
  warranty_name: string | null
  warranty_days: number | null
  warranty_max_km: number | null
  is_active: boolean
  merged_into_id: string | null
}

const ITEM_COLUMNS = [
  'ci.id', 'ci.category', 'ci.name', 'ci.line_type', 'ci.unit', 'ci.default_qty',
  'ci.is_set', 'ci.base_price', 'ci.warranty_term_id', 'ci.is_active', 'ci.merged_into_id',
  'wt.name as warranty_name', 'wt.days as warranty_days', 'wt.max_km as warranty_max_km',
] as const

function withWarranty(trx: ScopedTx) {
  return trx
    .selectFrom('catalog_items as ci')
    .leftJoin('warranty_terms as wt', 'wt.id', 'ci.warranty_term_id')
}

export async function getItemById(trx: ScopedTx, itemId: string): Promise<CatalogItemRow | undefined> {
  return withWarranty(trx).select(ITEM_COLUMNS).where('ci.id', '=', itemId).executeTakeFirst()
}

export async function getItemsByIds(trx: ScopedTx, itemIds: readonly string[]): Promise<CatalogItemRow[]> {
  if (itemIds.length === 0) return []
  return withWarranty(trx).select(ITEM_COLUMNS).where('ci.id', 'in', itemIds).execute()
}

/**
 * Search by name, active items only, merged items excluded automatically
 * (they are forced `is_active = false`, ck_catalog_merged_inactive). `q` is
 * matched on `name` with ILIKE — at ~300 items/shop a Seq Scan is the plan
 * the planner picks anyway (0020's measurements); add pg_trgm later if a shop
 * ever holds far more.
 */
export async function searchItemsByName(
  trx: ScopedTx,
  q: string,
  limit: number,
): Promise<CatalogItemRow[]> {
  return withWarranty(trx)
    .select(ITEM_COLUMNS)
    .where('ci.is_active', '=', true)
    .where('ci.name', 'ilike', `%${q}%`)
    .orderBy('ci.is_set', 'desc')
    .orderBy('ci.name', 'asc')
    .limit(limit)
    .execute()
}

export interface FrequentItemRow extends CatalogItemRow {
  use_count: number
}

/** The shop's most-used items, by how many document lines ever referenced them. */
export async function mostUsedItems(trx: ScopedTx, limit: number): Promise<FrequentItemRow[]> {
  const rows = await trx
    .selectFrom('document_lines as dl')
    .innerJoin('catalog_items as ci', 'ci.id', 'dl.catalog_item_id')
    .leftJoin('warranty_terms as wt', 'wt.id', 'ci.warranty_term_id')
    .select([
      ...ITEM_COLUMNS,
      (eb) => eb.fn.countAll().as('use_count'),
    ])
    .where('ci.is_active', '=', true)
    .groupBy(['ci.id', 'ci.category', 'ci.name', 'ci.line_type', 'ci.unit', 'ci.default_qty',
      'ci.is_set', 'ci.base_price', 'ci.warranty_term_id', 'ci.is_active', 'ci.merged_into_id',
      'wt.name', 'wt.days', 'wt.max_km'])
    .orderBy('use_count', 'desc')
    .limit(limit)
    .execute()
  return rows.map((r) => ({ ...r, use_count: Number(r.use_count) }))
}

export interface SetComponentRow {
  id: string
  component_item_id: string | null
  component_name: string
  line_type: string
  qty: string
  sort_order: number
  warranty_term_id: string | null
  warranty_name: string | null
  warranty_days: number | null
  warranty_max_km: number | null
}

/** A set's children, in display order, with the linked item's warranty (if any). */
export async function getSetComponents(trx: ScopedTx, setItemId: string): Promise<SetComponentRow[]> {
  return trx
    .selectFrom('catalog_set_components as sc')
    .leftJoin('catalog_items as ci', 'ci.id', 'sc.component_item_id')
    .leftJoin('warranty_terms as wt', 'wt.id', 'ci.warranty_term_id')
    .select([
      'sc.id', 'sc.component_item_id', 'sc.component_name', 'sc.line_type', 'sc.qty', 'sc.sort_order',
      'ci.warranty_term_id', 'wt.name as warranty_name', 'wt.days as warranty_days', 'wt.max_km as warranty_max_km',
    ])
    .where('sc.set_item_id', '=', setItemId)
    .orderBy('sc.sort_order', 'asc')
    .execute()
}

/** The price for this item on this car model, if the shop has set one. */
export async function getModelPrice(
  trx: ScopedTx,
  itemId: string,
  vehicleModelId: string,
): Promise<{ id: string; price: string } | undefined> {
  return trx
    .selectFrom('catalog_model_prices')
    .select(['id', 'price'])
    .where('item_id', '=', itemId)
    .where('vehicle_model_id', '=', vehicleModelId)
    .executeTakeFirst()
}

export interface InsertCatalogItem {
  shopId: string
  category: string
  name: string
  lineType: string
  unit: string | null
  defaultQty: string
  warrantyTermId: string | null
  isSet?: boolean
  createdBy: string
}

export async function insertItem(trx: ScopedTx, input: InsertCatalogItem): Promise<CatalogItemRow> {
  const row = await trx
    .insertInto('catalog_items')
    .values({
      shop_id: input.shopId,
      category: input.category,
      name: input.name,
      line_type: input.lineType,
      unit: input.unit,
      default_qty: input.defaultQty,
      warranty_term_id: input.warrantyTermId,
      is_set: input.isSet ?? false,
      created_by: input.createdBy,
    })
    .returning(['id'])
    .executeTakeFirstOrThrow()
  return (await getItemById(trx, row.id))!
}

/** Items in the same category, for the D12 similar-name check — small enough per shop to filter in JS. */
export async function itemsInCategory(trx: ScopedTx, category: string): Promise<{ id: string; category: string; name: string; isSet: boolean }[]> {
  const rows = await trx
    .selectFrom('catalog_items')
    .select(['id', 'category', 'name', 'is_set'])
    .where(sql<boolean>`category_key = price_key(${category})`)
    .where('is_active', '=', true)
    .execute()
  return rows.map((r) => ({ id: r.id, category: r.category, name: r.name, isSet: r.is_set }))
}

/**
 * First price for an item on a car model — written ONLY when none exists.
 * The condition is in the SQL itself (ON CONFLICT DO NOTHING), so two staff
 * typing the same first price race safely: the loser's INSERT affects 0 rows.
 */
export async function insertModelPriceIfAbsent(
  trx: ScopedTx,
  input: { shopId: string; itemId: string; vehicleModelId: string; price: string; setBy: string },
): Promise<{ id: string; price: string } | null> {
  const row = await trx
    .insertInto('catalog_model_prices')
    .values({
      shop_id: input.shopId,
      item_id: input.itemId,
      vehicle_model_id: input.vehicleModelId,
      price: input.price,
      set_by: input.setBy,
    })
    .onConflict((oc) => oc.columns(['shop_id', 'vehicle_model_id', 'item_id']).doNothing())
    .returning(['id', 'price'])
    .executeTakeFirst()
  return row ?? null
}

/** First price when the car has no controlled model — written to the item's base_price, same first-writer-wins shape. */
export async function setBasePriceIfAbsent(
  trx: ScopedTx,
  itemId: string,
  price: string,
): Promise<boolean> {
  const result = await trx
    .updateTable('catalog_items')
    .set({ base_price: price })
    .where('id', '=', itemId)
    .where('base_price', 'is', null)
    .executeTakeFirst()
  return Number(result.numUpdatedRows) > 0
}

export async function getModelPriceById(trx: ScopedTx, id: string): Promise<{ id: string; item_id: string; vehicle_model_id: string; price: string } | undefined> {
  return trx
    .selectFrom('catalog_model_prices')
    .select(['id', 'item_id', 'vehicle_model_id', 'price'])
    .where('id', '=', id)
    .executeTakeFirst()
}

export async function fixModelPrice(
  trx: ScopedTx,
  priceRowId: string,
  price: string,
  updatedBy: string,
): Promise<{ id: string; price: string } | undefined> {
  return trx
    .updateTable('catalog_model_prices')
    .set({ price, updated_by: updatedBy })
    .where('id', '=', priceRowId)
    .returning(['id', 'price'])
    .executeTakeFirst()
}

export async function fixBasePrice(
  trx: ScopedTx,
  itemId: string,
  price: string,
): Promise<{ id: string; price: string } | undefined> {
  const row = await trx
    .updateTable('catalog_items')
    .set({ base_price: price })
    .where('id', '=', itemId)
    .returning(['id', 'base_price as price'])
    .executeTakeFirst()
  // base_price is nullable in the column, but we just set it to a non-null
  // value above, so a returned row always has a non-null price here.
  return row ? { id: row.id, price: row.price! } : undefined
}

/** All of an item's per-model prices (merge conflict check / price-fix screen). */
export async function modelPricesOfItem(trx: ScopedTx, itemId: string): Promise<{ id: string; vehicle_model_id: string; price: string }[]> {
  return trx
    .selectFrom('catalog_model_prices')
    .select(['id', 'vehicle_model_id', 'price'])
    .where('item_id', '=', itemId)
    .execute()
}

export async function deleteModelPrices(trx: ScopedTx, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return
  await trx.deleteFrom('catalog_model_prices').where('id', 'in', ids).execute()
}

export async function moveModelPrice(trx: ScopedTx, id: string, toItemId: string): Promise<void> {
  await trx.updateTable('catalog_model_prices').set({ item_id: toItemId }).where('id', '=', id).execute()
}

export async function markMerged(trx: ScopedTx, sourceItemId: string, intoItemId: string): Promise<void> {
  await trx
    .updateTable('catalog_items')
    .set({ merged_into_id: intoItemId, is_active: false })
    .where('id', '=', sourceItemId)
    .execute()
}

// -----------------------------------------------------------------------------
// Warranty terms (read-only here — the terms themselves are 0010's table and
// are not managed by this module)
// -----------------------------------------------------------------------------

export interface WarrantyTermRow {
  id: string
  name: string
  days: number | null
  max_km: number | null
}

export async function listWarrantyTerms(trx: ScopedTx): Promise<WarrantyTermRow[]> {
  return trx
    .selectFrom('warranty_terms')
    .select(['id', 'name', 'days', 'max_km'])
    .where('is_active', '=', true)
    .orderBy('sort_order', 'asc')
    .execute()
}

export async function getWarrantyTerm(trx: ScopedTx, id: string): Promise<WarrantyTermRow | undefined> {
  return trx.selectFrom('warranty_terms').select(['id', 'name', 'days', 'max_km']).where('id', '=', id).executeTakeFirst()
}

// -----------------------------------------------------------------------------
// Controlled vehicle models
// -----------------------------------------------------------------------------

export interface VehicleModelRow {
  id: string
  brand: string
  name: string
  year_range: string | null
}

export async function searchVehicleModels(trx: ScopedTx, q: string | undefined, limit: number, offset: number): Promise<{ rows: VehicleModelRow[]; total: number }> {
  let base = trx.selectFrom('vehicle_models')
  if (q) {
    base = base.where((eb) => eb.or([eb('brand', 'ilike', `%${q}%`), eb('name', 'ilike', `%${q}%`)]))
  }
  const [rows, countRow] = await Promise.all([
    base.select(['id', 'brand', 'name', 'year_range']).orderBy('brand', 'asc').orderBy('name', 'asc').limit(limit).offset(offset).execute(),
    base.select((eb) => eb.fn.countAll().as('n')).executeTakeFirst(),
  ])
  return { rows, total: Number(countRow?.n ?? 0) }
}

/** Exactly one controlled model matching this brand+model text (price_key equal on both sides) — never a guess. */
export async function findExactVehicleModel(trx: ScopedTx, brand: string, model: string): Promise<VehicleModelRow | undefined> {
  const rows = await trx
    .selectFrom('vehicle_models')
    .select(['id', 'brand', 'name', 'year_range'])
    .where(sql<boolean>`price_key(brand) = price_key(${brand})`)
    .where(sql<boolean>`price_key(name) = price_key(${model})`)
    .limit(2)
    .execute()
  return rows.length === 1 ? rows[0] : undefined
}

export async function insertVehicleModel(
  trx: ScopedTx,
  input: { shopId: string; brand: string; name: string; yearRange: string | null },
): Promise<VehicleModelRow> {
  const row = await trx
    .insertInto('vehicle_models')
    .values({ shop_id: input.shopId, brand: input.brand, name: input.name, year_range: input.yearRange })
    .returning(['id', 'brand', 'name', 'year_range'])
    .executeTakeFirstOrThrow()
  return row
}

export async function existingVehicleModel(trx: ScopedTx, brand: string, name: string): Promise<VehicleModelRow | undefined> {
  return trx
    .selectFrom('vehicle_models')
    .select(['id', 'brand', 'name', 'year_range'])
    .where(sql<boolean>`price_key(brand) = price_key(${brand})`)
    .where(sql<boolean>`price_key(name) = price_key(${name})`)
    .executeTakeFirst()
}

export async function assignVehicleModel(trx: ScopedTx, vehicleId: string, vehicleModelId: string): Promise<void> {
  await trx.updateTable('vehicles').set({ vehicle_model_id: vehicleModelId }).where('id', '=', vehicleId).execute()
}

export interface UnmatchedGroupRow {
  brand_text: string
  model_text: string
  vehicle_count: number
}

/** Cars with no controlled model, grouped by what staff typed — paged, newest-typo-group first by count. */
export async function unmatchedVehicleGroups(trx: ScopedTx, limit: number, offset: number): Promise<{ rows: UnmatchedGroupRow[]; total: number }> {
  const base = trx.selectFrom('vehicles').where('vehicle_model_id', 'is', null)
  const grouped = base
    .select(['brand as brand_text', 'model as model_text', (eb) => eb.fn.countAll().as('vehicle_count')])
    .groupBy(['brand', 'model'])
  const rows = await grouped.orderBy('vehicle_count', 'desc').limit(limit).offset(offset).execute()
  const totalRow = await trx
    .selectFrom(grouped.as('g'))
    .select((eb) => eb.fn.countAll().as('n'))
    .executeTakeFirst()
  return {
    rows: rows.map((r) => ({ ...r, vehicle_count: Number(r.vehicle_count) })),
    total: Number(totalRow?.n ?? 0),
  }
}

export async function assignModelToGroup(
  trx: ScopedTx,
  brandText: string,
  modelText: string,
  vehicleModelId: string,
): Promise<number> {
  const result = await trx
    .updateTable('vehicles')
    .set({ vehicle_model_id: vehicleModelId })
    .where('brand', '=', brandText)
    .where('model', '=', modelText)
    .where('vehicle_model_id', 'is', null)
    .executeTakeFirst()
  return Number(result.numUpdatedRows)
}

/** The live item with exactly this normalised (category, name), if any — the unique-index twin, for a clean 409. */
export async function findItemByKeys(trx: ScopedTx, category: string, name: string): Promise<{ id: string } | undefined> {
  return trx
    .selectFrom('catalog_items')
    .select(['id'])
    .where(sql<boolean>`category_key = price_key(${category})`)
    .where(sql<boolean>`name_key = price_key(${name})`)
    .where('merged_into_id', 'is', null)
    .executeTakeFirst()
}

/** Locks one item row (merge serialises on it). */
export async function lockItem(trx: ScopedTx, itemId: string): Promise<{ id: string; merged_into_id: string | null } | undefined> {
  return trx.selectFrom('catalog_items').select(['id', 'merged_into_id']).where('id', '=', itemId).forUpdate().executeTakeFirst()
}

export async function vehicleExists(trx: ScopedTx, vehicleId: string): Promise<boolean> {
  return (await trx.selectFrom('vehicles').select('id').where('id', '=', vehicleId).executeTakeFirst()) !== undefined
}

export async function vehicleModelExists(trx: ScopedTx, id: string): Promise<boolean> {
  return (await trx.selectFrom('vehicle_models').select('id').where('id', '=', id).executeTakeFirst()) !== undefined
}
