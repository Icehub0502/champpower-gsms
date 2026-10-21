/**
 * Stock: SKUs, the balance cache, the append-only ledger, shortfall suggestions.
 * Every function takes a ScopedTx, so RLS scopes every row to the caller's shop.
 *
 * NOTHING HERE DECIDES ANYTHING. Whether a move is allowed is packages/domain
 * (rules/stock.ts) and the service; this file reads rows, locks balance rows and
 * appends ledger rows. The one hard rule it enforces for its callers: the only
 * way to change stock_balances is applyBalance() after lockBalances() in the SAME
 * transaction, and the only way to add a ledger row is insertMove().
 *
 * No SELECT * anywhere (CLAUDE.md s9).
 */
import { sql, type SelectQueryBuilder } from 'kysely'
import type { ScopedTx } from '@gsms/db/client.js'
import { formatQty, toQtyCenti, type BalanceCenti, type StockMoveType } from '@champpower/domain'

/** Escape LIKE/ILIKE wildcards so what staff type is matched literally. */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (ch) => '\\' + ch)
}

// -----------------------------------------------------------------------------
// SKUs (+ their balance, when there is one)
// -----------------------------------------------------------------------------

export interface SkuRecord {
  id: string
  code: string
  name: string
  category: string | null
  unit: string
  stocking_policy: string
  reorder_point: string | null
  shelf_location: string | null
  is_active: boolean
  legacy_had_stock: boolean | null
  /** null on all three = never counted (no balance row). */
  on_hand: string | null
  reserved: string | null
  avg_cost: string | null
}

const SKU_COLUMNS = [
  's.id', 's.code', 's.name', 's.category', 's.unit', 's.stocking_policy', 's.reorder_point',
  's.shelf_location', 's.is_active', 's.legacy_had_stock', 'sb.on_hand', 'sb.reserved', 'sb.avg_cost',
] as const

function skuBase(trx: ScopedTx) {
  return trx
    .selectFrom('skus as s')
    .leftJoin('stock_balances as sb', (j) => j.onRef('sb.sku_id', '=', 's.id').onRef('sb.shop_id', '=', 's.shop_id'))
}

export interface SkuFilter {
  q?: string
  category?: string
  status?: 'all' | 'not_counted' | 'counted' | 'out' | 'low'
  active?: 'active' | 'inactive' | 'all'
  onlyUncounted?: boolean
  /** The low-stock screen: counted + stocked + active + available <= coalesce(reorder_point, 0). */
  lowOnly?: boolean
}

// A filter is the same predicate on the row query and on its count query, whose result types differ; the
// builder is therefore typed loosely HERE (and only here) and the callers keep their precise types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyQb = SelectQueryBuilder<any, any, any>

function applyFilter<Q extends AnyQb>(qb: Q, f: SkuFilter): Q {
  let q: AnyQb = qb
  const active = f.active ?? 'active'
  if (active === 'active') q = q.where('s.is_active', '=', true)
  if (active === 'inactive') q = q.where('s.is_active', '=', false)
  if (f.category) q = q.where('s.category', '=', f.category)
  if (f.q) {
    const like = `%${escapeLike(f.q)}%`
    q = q.where((eb) => eb.or([eb('s.name', 'ilike', like), eb('s.code', 'ilike', like), eb('s.shelf_location', 'ilike', like)]))
  }
  if (f.onlyUncounted || f.status === 'not_counted') q = q.where('sb.sku_id', 'is', null)
  if (f.status === 'counted') q = q.where('sb.sku_id', 'is not', null)
  if (f.status === 'out') q = q.where('sb.on_hand', '<=', '0')
  if (f.status === 'low' || f.lowOnly) {
    q = q
      .where('sb.sku_id', 'is not', null)
      .where('s.is_active', '=', true)
      .where('s.stocking_policy', '=', 'stocked')
      .where(sql<boolean>`sb.on_hand - sb.reserved <= coalesce(s.reorder_point, 0)`)
  }
  return q as Q
}

/** Search/filter page of SKUs. Plain order: category, then code (stable, so paging does not shuffle). */
export async function listSkus(trx: ScopedTx, f: SkuFilter, limit: number, offset: number): Promise<{ rows: SkuRecord[]; total: number }> {
  const rows = await applyFilter(skuBase(trx).select(SKU_COLUMNS), f)
    .orderBy('s.category', 'asc').orderBy('s.code', 'asc').orderBy('s.id', 'asc')
    .limit(limit).offset(offset).execute()
  const total = await applyFilter(skuBase(trx).select(sql<number>`count(*)`.as('n')), f).executeTakeFirstOrThrow()
  return { rows, total: Number(total.n) }
}

/** The low-stock screen: the most urgent (smallest available - reorder point) first. */
export async function listLowStock(trx: ScopedTx, f: { q?: string; category?: string }, limit: number, offset: number): Promise<{ rows: SkuRecord[]; total: number }> {
  const filter: SkuFilter = { ...f, lowOnly: true, active: 'active' }
  const rows = await applyFilter(skuBase(trx).select(SKU_COLUMNS), filter)
    .orderBy(sql`sb.on_hand - sb.reserved - coalesce(s.reorder_point, 0)`, 'asc')
    .orderBy('s.code', 'asc').orderBy('s.id', 'asc')
    .limit(limit).offset(offset).execute()
  const total = await applyFilter(skuBase(trx).select(sql<number>`count(*)`.as('n')), filter).executeTakeFirstOrThrow()
  return { rows, total: Number(total.n) }
}

/**
 * The count sheet: parts the prototype showed stock for come first (those are the ones that exist
 * on the shelf), then everything else; inside each group by category and code. NULL legacy_had_stock
 * (a SKU made in this system) sorts with "had stock", because a part someone added by hand is a
 * part someone expects to be there.
 */
export async function listCountSheet(trx: ScopedTx, f: { q?: string; category?: string; onlyUncounted: boolean }, limit: number, offset: number): Promise<{ rows: SkuRecord[]; total: number }> {
  const filter: SkuFilter = { q: f.q, category: f.category, onlyUncounted: f.onlyUncounted, active: 'active' }
  const rows = await applyFilter(skuBase(trx).select(SKU_COLUMNS), filter)
    .orderBy(sql`(s.legacy_had_stock is not distinct from false)`, 'asc')
    .orderBy('s.category', 'asc').orderBy('s.code', 'asc').orderBy('s.id', 'asc')
    .limit(limit).offset(offset).execute()
  const total = await applyFilter(skuBase(trx).select(sql<number>`count(*)`.as('n')), filter).executeTakeFirstOrThrow()
  return { rows, total: Number(total.n) }
}

export async function getSku(trx: ScopedTx, skuId: string): Promise<SkuRecord | undefined> {
  return skuBase(trx).select(SKU_COLUMNS).where('s.id', '=', skuId).executeTakeFirst()
}

export async function getSkuByCode(trx: ScopedTx, code: string): Promise<SkuRecord | undefined> {
  return skuBase(trx).select(SKU_COLUMNS).where('s.code', '=', code).executeTakeFirst()
}

export async function getSkusByIds(trx: ScopedTx, ids: readonly string[]): Promise<Map<string, SkuRecord>> {
  if (ids.length === 0) return new Map()
  const rows = await skuBase(trx).select(SKU_COLUMNS).where('s.id', 'in', ids).execute()
  return new Map(rows.map((r) => [r.id, r]))
}

/** Last count per SKU, for the count sheet ("นับล่าสุด"). */
export async function lastCountedAt(trx: ScopedTx, skuIds: readonly string[]): Promise<Map<string, Date>> {
  if (skuIds.length === 0) return new Map()
  const rows = await trx
    .selectFrom('stock_moves')
    .select(['sku_id', sql<Date>`max(created_at)`.as('at')])
    .where('type', '=', 'count')
    .where('sku_id', 'in', skuIds)
    .groupBy('sku_id')
    .execute()
  return new Map(rows.map((r) => [r.sku_id, r.at]))
}

export interface NewSku {
  shopId: string
  code: string
  name: string
  category: string | null
  unit: string | null
  stockingPolicy: string
  reorderPoint: string | null
  shelfLocation: string | null
}

/** Never creates a balance row: a new SKU is "not counted" until somebody counts it. */
export async function insertSku(trx: ScopedTx, n: NewSku): Promise<string> {
  const row = await trx
    .insertInto('skus')
    .values({
      shop_id: n.shopId, code: n.code, name: n.name, category: n.category,
      ...(n.unit ? { unit: n.unit } : {}),
      stocking_policy: n.stockingPolicy, reorder_point: n.reorderPoint, shelf_location: n.shelfLocation,
    })
    .returning('id')
    .executeTakeFirstOrThrow()
  return row.id
}

export interface SkuPatch {
  name?: string
  category?: string | null
  unit?: string
  stockingPolicy?: string
  reorderPoint?: string | null
  shelfLocation?: string | null
  isActive?: boolean
}

export async function updateSku(trx: ScopedTx, skuId: string, p: SkuPatch): Promise<void> {
  const set: Record<string, unknown> = {}
  if (p.name !== undefined) set.name = p.name
  if (p.category !== undefined) set.category = p.category
  if (p.unit !== undefined) set.unit = p.unit
  if (p.stockingPolicy !== undefined) set.stocking_policy = p.stockingPolicy
  if (p.reorderPoint !== undefined) set.reorder_point = p.reorderPoint
  if (p.shelfLocation !== undefined) set.shelf_location = p.shelfLocation
  if (p.isActive !== undefined) set.is_active = p.isActive
  if (Object.keys(set).length === 0) return
  await trx.updateTable('skus').set(set).where('id', '=', skuId).execute()
}

export async function catalogItemsOfSku(trx: ScopedTx, skuId: string): Promise<Array<{ id: string; category: string; name: string }>> {
  return trx.selectFrom('catalog_items').select(['id', 'category', 'name']).where('sku_id', '=', skuId).orderBy('category').orderBy('name').execute()
}

// -----------------------------------------------------------------------------
// Balances — lock, then write
// -----------------------------------------------------------------------------

export interface LockedBalance extends BalanceCenti {
  avgCost: string
}

/**
 * SELECT ... FOR UPDATE on the balance rows of these SKUs, always in ascending sku_id order, so two
 * transactions that need {A,B} and {B,A} queue instead of deadlocking (CLAUDE.md s4.x: the stock
 * lock is the LAST in the order jobs -> documents -> document_lines -> stock).
 * A SKU with no row is simply absent from the map = not counted.
 */
export async function lockBalances(trx: ScopedTx, skuIds: readonly string[]): Promise<Map<string, LockedBalance>> {
  const ids = [...new Set(skuIds)].sort()
  if (ids.length === 0) return new Map()
  const rows = await trx
    .selectFrom('stock_balances')
    .select(['sku_id', 'on_hand', 'reserved', 'avg_cost'])
    .where('sku_id', 'in', ids)
    .orderBy('sku_id', 'asc')
    .forUpdate()
    .execute()
  return new Map(rows.map((r) => [r.sku_id, { onHand: toQtyCenti(r.on_hand), reserved: toQtyCenti(r.reserved), avgCost: r.avg_cost }]))
}

/**
 * Create the balance row of a SKU being counted for the first time (the ONLY door to counted-ness).
 * ON CONFLICT DO NOTHING so two first counts racing do not collide on the primary key; the caller
 * locks and re-reads afterwards. Returns true when this call created the row.
 */
export async function ensureBalanceRow(trx: ScopedTx, shopId: string, skuId: string): Promise<boolean> {
  const r = await trx
    .insertInto('stock_balances')
    .values({ shop_id: shopId, sku_id: skuId })
    .onConflict((oc) => oc.columns(['shop_id', 'sku_id']).doNothing())
    .returning('sku_id')
    .executeTakeFirst()
  return r !== undefined
}

export async function writeBalance(trx: ScopedTx, shopId: string, skuId: string, b: BalanceCenti): Promise<void> {
  await trx
    .updateTable('stock_balances')
    .set({ on_hand: formatQty(b.onHand), reserved: formatQty(b.reserved), updated_at: sql`now()` })
    .where('shop_id', '=', shopId)
    .where('sku_id', '=', skuId)
    .execute()
}

// -----------------------------------------------------------------------------
// The ledger
// -----------------------------------------------------------------------------

export interface NewMove {
  shopId: string
  skuId: string
  type: StockMoveType
  qtyCenti: number
  unitCost: string | null
  refType: 'document_line' | null
  refId: string | null
  refLineId: string | null
  idempotencyKey: string
  reason: string | null
  userId: string | null
  onHandAfter: number
  reservedAfter: number
}

/**
 * Append one ledger row. UNIQUE (shop_id, idempotency_key) is the guard: a replay inserts nothing and
 * this returns null, and the caller must then NOT touch the balance. Returns the new move id.
 */
export async function insertMove(trx: ScopedTx, m: NewMove): Promise<string | null> {
  const r = await trx
    .insertInto('stock_moves')
    .values({
      shop_id: m.shopId, sku_id: m.skuId, type: m.type, qty: formatQty(m.qtyCenti), unit_cost: m.unitCost,
      ref_type: m.refType, ref_id: m.refId, ref_line_id: m.refLineId,
      idempotency_key: m.idempotencyKey, reason: m.reason, user_id: m.userId,
      on_hand_after: formatQty(m.onHandAfter), reserved_after: formatQty(m.reservedAfter),
    })
    .onConflict((oc) => oc.columns(['shop_id', 'idempotency_key']).doNothing())
    .returning('id')
    .executeTakeFirst()
  return r?.id ?? null
}

export interface MoveHit { id: string; sku_id: string; qty: string; on_hand_after: string | null; type: string }

export async function findMoveByKey(trx: ScopedTx, key: string): Promise<MoveHit | undefined> {
  return trx.selectFrom('stock_moves').select(['id', 'sku_id', 'qty', 'on_hand_after', 'type']).where('idempotency_key', '=', key).executeTakeFirst()
}

/** Per document line: what the ledger says about it. One row per (line, sku). */
export interface LineLedger {
  lineId: string
  skuId: string
  reservedCenti: number
  issuedCenti: number
  reserveCount: number
}

export async function ledgerOfDocument(trx: ScopedTx, documentId: string): Promise<LineLedger[]> {
  const r = await sql<{ line_id: string; sku_id: string; reserved: string; issued: string; reserve_count: number }>`
    select ref_line_id as line_id, sku_id,
           coalesce(sum(qty) filter (where type in ('reserve', 'unreserve')), 0) as reserved,
           coalesce(-sum(qty) filter (where type = 'issue'), 0) as issued,
           count(*) filter (where type = 'reserve') as reserve_count
      from stock_moves
     where ref_type = 'document_line' and ref_id = ${documentId}
     group by ref_line_id, sku_id`.execute(trx)
  return r.rows.map((x) => ({
    lineId: x.line_id, skuId: x.sku_id, reservedCenti: toQtyCenti(x.reserved), issuedCenti: toQtyCenti(x.issued),
    reserveCount: Number(x.reserve_count),
  }))
}

/**
 * What has already been PULLED for each line of a document, counting the pulls made against the
 * revision the line was copied from (source_line_id chain): a part issued under rev 1 is not
 * pulled again under rev 2.
 */
export async function issuedThroughChain(trx: ScopedTx, documentId: string): Promise<Map<string, number>> {
  const r = await sql<{ line_id: string; issued: string }>`
    with recursive chain(line_id, anc_id) as (
      select id, id from document_lines where document_id = ${documentId}
      union all
      select c.line_id, dl.source_line_id
        from chain c join document_lines dl on dl.id = c.anc_id
       where dl.source_line_id is not null
    )
    select c.line_id, coalesce(-sum(m.qty), 0) as issued
      from chain c
      join stock_moves m on m.ref_line_id = c.anc_id and m.type = 'issue' and m.ref_type = 'document_line'
     group by c.line_id`.execute(trx)
  return new Map(r.rows.map((x) => [x.line_id, toQtyCenti(x.issued)]))
}

// -----------------------------------------------------------------------------
// Document lines, as the stock side needs them
// -----------------------------------------------------------------------------

export interface StockLineRow {
  id: string
  document_id: string
  parent_line_id: string | null
  sort_order: number
  line_type: string
  approval_status: string
  qty: string
  unit: string | null
  name_snapshot: string
  sku_id: string | null
  catalog_item_id: string | null
  source_line_id: string | null
}

const LINE_COLUMNS = [
  'id', 'document_id', 'parent_line_id', 'sort_order', 'line_type', 'approval_status', 'qty', 'unit',
  'name_snapshot', 'sku_id', 'catalog_item_id', 'source_line_id',
] as const

/** Plain read. Use lockLines when the rows are about to be relied on by a stock write. */
export async function linesOfDocument(trx: ScopedTx, documentId: string): Promise<StockLineRow[]> {
  return trx.selectFrom('document_lines').select(LINE_COLUMNS).where('document_id', '=', documentId).orderBy('sort_order', 'asc').orderBy('id', 'asc').execute()
}

/** Third in the lock order (jobs -> documents -> document_lines -> stock): lock rows by id, ascending. */
export async function lockLines(trx: ScopedTx, documentId: string): Promise<StockLineRow[]> {
  const ids = await trx.selectFrom('document_lines').select('id').where('document_id', '=', documentId).orderBy('id', 'asc').forUpdate().execute()
  if (ids.length === 0) return []
  return linesOfDocument(trx, documentId)
}

/**
 * The SKU each catalog item stands for, following merges to the surviving item (chains are short).
 * Items with no SKU are absent from the map.
 */
export async function skuOfCatalogItems(trx: ScopedTx, itemIds: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  let pending = new Map<string, string>() // current id -> original id
  for (const id of new Set(itemIds)) pending.set(id, id)
  for (let hop = 0; hop < 32 && pending.size > 0; hop++) {
    const rows = await trx.selectFrom('catalog_items').select(['id', 'sku_id', 'merged_into_id']).where('id', 'in', [...pending.keys()]).execute()
    const next = new Map<string, string>()
    for (const r of rows) {
      const origin = pending.get(r.id)!
      if (r.merged_into_id) next.set(r.merged_into_id, origin)
      else if (r.sku_id) out.set(origin, r.sku_id)
    }
    pending = next
  }
  return out
}

/**
 * Freeze the catalog's SKU link onto the lines of a DRAFT document that have none yet. Called at the
 * moment a quotation is issued, the last moment the lines are writable (0022): after that the line's
 * sku_id is part of what the customer saw and signed.
 */
export async function snapshotSkuOnDraftLines(trx: ScopedTx, documentId: string): Promise<void> {
  const lines = await trx
    .selectFrom('document_lines').select(['id', 'catalog_item_id'])
    .where('document_id', '=', documentId).where('line_type', '=', 'part')
    .where('sku_id', 'is', null).where('catalog_item_id', 'is not', null).execute()
  if (lines.length === 0) return
  const map = await skuOfCatalogItems(trx, lines.map((l) => l.catalog_item_id!))
  for (const l of lines) {
    const sku = map.get(l.catalog_item_id!)
    if (sku) await trx.updateTable('document_lines').set({ sku_id: sku }).where('id', '=', l.id).execute()
  }
}

/** A revision copies its lines; the SKU a line was frozen with travels with it. */
export async function copySkuFromSourceLines(trx: ScopedTx, newDocumentId: string): Promise<void> {
  await sql`
    update document_lines n set sku_id = o.sku_id
      from document_lines o
     where n.document_id = ${newDocumentId} and n.source_line_id = o.id and o.sku_id is not null and n.sku_id is null`.execute(trx)
}

// -----------------------------------------------------------------------------
// Purchase suggestions (shortfall)
// -----------------------------------------------------------------------------

/** One open shortfall suggestion per line (uq_suggestion_open_per_line); a replay updates it in place. */
export async function upsertShortfallSuggestion(trx: ScopedTx, shopId: string, skuId: string, lineId: string, qtyCenti: number): Promise<void> {
  await sql`
    insert into purchase_suggestions (shop_id, sku_id, document_line_id, qty_needed, origin, status)
    values (${shopId}, ${skuId}, ${lineId}, ${formatQty(qtyCenti)}, 'shortfall', 'open')
    on conflict (shop_id, document_line_id) where origin = 'shortfall' and status = 'open' and document_line_id is not null
    do update set qty_needed = excluded.qty_needed`.execute(trx)
}

/** The line no longer waits on stock (released, issued, or covered): close its open suggestion. */
export async function closeShortfallSuggestion(trx: ScopedTx, lineId: string, status: 'cancelled' | 'done'): Promise<void> {
  await trx
    .updateTable('purchase_suggestions')
    .set({ status, resolved_at: sql`now()` })
    .where('document_line_id', '=', lineId).where('origin', '=', 'shortfall').where('status', '=', 'open')
    .execute()
}

/** Every open shortfall suggestion of a document's lines (including lines that reserved nothing at all). */
export async function closeShortfallSuggestionsOfDocument(trx: ScopedTx, documentId: string, status: 'cancelled' | 'done'): Promise<void> {
  await sql`
    update purchase_suggestions ps set status = ${status}, resolved_at = now()
      from document_lines dl
     where dl.id = ps.document_line_id and dl.document_id = ${documentId}
       and ps.origin = 'shortfall' and ps.status = 'open'`.execute(trx)
}

export async function openShortfallsOfDocument(trx: ScopedTx, documentId: string): Promise<Map<string, number>> {
  const r = await sql<{ line_id: string; qty: string }>`
    select ps.document_line_id as line_id, ps.qty_needed as qty
      from purchase_suggestions ps join document_lines dl on dl.id = ps.document_line_id
     where dl.document_id = ${documentId} and ps.origin = 'shortfall' and ps.status = 'open'`.execute(trx)
  return new Map(r.rows.map((x) => [x.line_id, toQtyCenti(x.qty)]))
}

// -----------------------------------------------------------------------------
// Stock card
// -----------------------------------------------------------------------------

export interface MoveListRow {
  id: string
  type: string
  qty: string
  on_hand_after: string | null
  reserved_after: string | null
  reason: string | null
  created_at: Date
  unit_cost: string | null
  user_id: string | null
  user_name: string | null
  ref_line_id: string | null
  line_name: string | null
  document_id: string | null
  document_type: string | null
  document_number: string | null
  job_id: string | null
  job_number: string | null
}

export async function listMoves(trx: ScopedTx, skuId: string, type: string | undefined, limit: number, offset: number): Promise<{ rows: MoveListRow[]; total: number }> {
  let q = trx
    .selectFrom('stock_moves as m')
    .leftJoin('users as u', 'u.id', 'm.user_id')
    .leftJoin('document_lines as dl', 'dl.id', 'm.ref_line_id')
    .leftJoin('documents as d', 'd.id', 'dl.document_id')
    .leftJoin('jobs as j', 'j.id', 'd.job_id')
    .select([
      'm.id', 'm.type', 'm.qty', 'm.on_hand_after', 'm.reserved_after', 'm.reason', 'm.created_at', 'm.unit_cost',
      'm.user_id', 'u.name as user_name', 'm.ref_line_id', 'dl.name_snapshot as line_name',
      'd.id as document_id', 'd.type as document_type', 'd.number as document_number', 'j.id as job_id', 'j.job_number',
    ])
    .where('m.sku_id', '=', skuId)
  let cq = trx.selectFrom('stock_moves as m').select(sql<number>`count(*)`.as('n')).where('m.sku_id', '=', skuId)
  if (type) { q = q.where('m.type', '=', type); cq = cq.where('m.type', '=', type) }
  const rows = await q.orderBy('m.created_at', 'desc').orderBy('m.id', 'desc').limit(limit).offset(offset).execute()
  const total = await cq.executeTakeFirstOrThrow()
  return { rows, total: Number(total.n) }
}

// -----------------------------------------------------------------------------
// Reports
// -----------------------------------------------------------------------------

export interface ManualMoveRow {
  id: string
  type: string
  qty: string
  on_hand_after: string | null
  reason: string | null
  created_at: Date
  sku_id: string
  sku_code: string
  sku_name: string
  user_id: string | null
  user_name: string | null
}

/** Adjustments and counts made between two instants (a Bangkok day), oldest first. */
export async function manualMovesBetween(trx: ScopedTx, from: Date, to: Date): Promise<ManualMoveRow[]> {
  return trx
    .selectFrom('stock_moves as m')
    .innerJoin('skus as s', 's.id', 'm.sku_id')
    .leftJoin('users as u', 'u.id', 'm.user_id')
    .select(['m.id', 'm.type', 'm.qty', 'm.on_hand_after', 'm.reason', 'm.created_at', 'm.sku_id', 's.code as sku_code', 's.name as sku_name', 'm.user_id', 'u.name as user_name'])
    .where('m.type', 'in', ['adjustment', 'count'])
    .where('m.created_at', '>=', from)
    .where('m.created_at', '<', to)
    .orderBy('m.created_at', 'asc').orderBy('m.id', 'asc')
    .execute()
}

export interface DriftRow {
  sku_id: string
  code: string
  name: string
  ledger_on_hand: string
  balance_on_hand: string
  ledger_reserved: string
  balance_reserved: string
}

/** Replays the whole ledger per SKU and compares it with the balance cache. Returns only the rows that disagree. */
export async function integrityDrift(trx: ScopedTx): Promise<{ checked: number; drift: DriftRow[] }> {
  const r = await sql<DriftRow>`
    with l as (
      select sku_id,
             coalesce(sum(qty) filter (where type not in ('reserve', 'unreserve')), 0) as on_hand,
             coalesce(sum(qty) filter (where type in ('reserve', 'unreserve')), 0) as reserved
        from stock_moves group by sku_id
    )
    select s.id as sku_id, s.code, s.name,
           coalesce(l.on_hand, 0)::text as ledger_on_hand, coalesce(sb.on_hand, 0)::text as balance_on_hand,
           coalesce(l.reserved, 0)::text as ledger_reserved, coalesce(sb.reserved, 0)::text as balance_reserved
      from skus s
      left join l on l.sku_id = s.id
      left join stock_balances sb on sb.sku_id = s.id and sb.shop_id = s.shop_id
     where (sb.sku_id is not null or l.sku_id is not null)
       and (coalesce(l.on_hand, 0) <> coalesce(sb.on_hand, 0) or coalesce(l.reserved, 0) <> coalesce(sb.reserved, 0))
     order by s.code`.execute(trx)
  const n = await sql<{ n: number }>`
    select count(*) as n from skus s
     where exists (select 1 from stock_balances sb where sb.sku_id = s.id and sb.shop_id = s.shop_id)
        or exists (select 1 from stock_moves m where m.sku_id = s.id)`.execute(trx)
  return { checked: Number(n.rows[0]?.n ?? 0), drift: r.rows }
}

export interface UnboundRow {
  line_id: string
  document_id: string
  document_number: string | null
  document_status: string
  job_id: string | null
  job_number: string | null
  name: string
  qty: string
  approval_status: string
  catalog_item_id: string | null
}

/**
 * Part lines of LIVE quotations (draft / issued / signed) that point at no SKU - neither frozen on the
 * line nor through the catalog item's current binding. Set parents are not listed (they carry a price,
 * not a part), declined lines are not listed (nothing will be pulled), and a job that already ended is not listed.
 */
export async function unboundPartLines(trx: ScopedTx, limit: number, offset: number): Promise<{ rows: UnboundRow[]; total: number }> {
  const where = sql`
    d.type = 'quotation' and d.status in ('draft', 'issued', 'signed')
    and dl.line_type = 'part' and dl.sku_id is null and dl.approval_status <> 'declined'
    and (ci.id is null or ci.sku_id is null)
    and not exists (select 1 from document_lines kid where kid.parent_line_id = dl.id)
    and (j.id is null or j.status not in ('rejected', 'carout', 'delivered'))`
  const rows = await sql<UnboundRow>`
    select dl.id as line_id, d.id as document_id, d.number as document_number, d.status as document_status,
           j.id as job_id, j.job_number, dl.name_snapshot as name, dl.qty, dl.approval_status, dl.catalog_item_id
      from document_lines dl
      join documents d on d.id = dl.document_id
      left join jobs j on j.id = d.job_id
      left join catalog_items ci on ci.id = dl.catalog_item_id
     where ${where}
     order by d.created_at desc, dl.sort_order asc, dl.id asc
     limit ${limit} offset ${offset}`.execute(trx)
  const total = await sql<{ n: number }>`
    select count(*) as n
      from document_lines dl
      join documents d on d.id = dl.document_id
      left join jobs j on j.id = d.job_id
      left join catalog_items ci on ci.id = dl.catalog_item_id
     where ${where}`.execute(trx)
  return { rows: rows.rows, total: Number(total.rows[0]?.n ?? 0) }
}

// -----------------------------------------------------------------------------
// Catalog <-> SKU link
// -----------------------------------------------------------------------------

export interface CatalogLinkRecord {
  id: string
  category: string
  name: string
  line_type: string
  is_set: boolean
  merged_into_id: string | null
  sku_id: string | null
  sku_code: string | null
  sku_name: string | null
}

const LINK_COLUMNS = [
  'ci.id', 'ci.category', 'ci.name', 'ci.line_type', 'ci.is_set', 'ci.merged_into_id', 'ci.sku_id', 's.code as sku_code', 's.name as sku_name',
] as const

function linkBase(trx: ScopedTx) {
  return trx.selectFrom('catalog_items as ci').leftJoin('skus as s', (j) => j.onRef('s.id', '=', 'ci.sku_id').onRef('s.shop_id', '=', 'ci.shop_id'))
}

export async function listCatalogLinks(trx: ScopedTx, f: { q?: string; bound: 'all' | 'bound' | 'unbound' }, limit: number, offset: number): Promise<{ rows: CatalogLinkRecord[]; total: number }> {
  const apply = <Q extends AnyQb>(qb: Q): Q => {
    let q: AnyQb = qb.where('ci.line_type', '=', 'part').where('ci.merged_into_id', 'is', null).where('ci.is_active', '=', true)
    if (f.bound === 'bound') q = q.where('ci.sku_id', 'is not', null)
    if (f.bound === 'unbound') q = q.where('ci.sku_id', 'is', null)
    if (f.q) {
      const like = `%${escapeLike(f.q)}%`
      q = q.where((eb) => eb.or([eb('ci.name', 'ilike', like), eb('ci.category', 'ilike', like)]))
    }
    return q as Q
  }
  const rows = await apply(linkBase(trx).select(LINK_COLUMNS)).orderBy('ci.category', 'asc').orderBy('ci.name', 'asc').orderBy('ci.id', 'asc').limit(limit).offset(offset).execute()
  const total = await apply(linkBase(trx).select(sql<number>`count(*)`.as('n'))).executeTakeFirstOrThrow()
  return { rows, total: Number(total.n) }
}

export async function getCatalogLink(trx: ScopedTx, itemId: string): Promise<CatalogLinkRecord | undefined> {
  return linkBase(trx).select(LINK_COLUMNS).where('ci.id', '=', itemId).executeTakeFirst()
}

/** Row lock on the catalog item so two people binding/unbinding it queue. */
export async function lockCatalogItem(trx: ScopedTx, itemId: string): Promise<{ id: string; line_type: string; merged_into_id: string | null; sku_id: string | null } | undefined> {
  return trx.selectFrom('catalog_items').select(['id', 'line_type', 'merged_into_id', 'sku_id']).where('id', '=', itemId).forUpdate().executeTakeFirst()
}

export async function setCatalogSku(trx: ScopedTx, itemId: string, skuId: string | null): Promise<void> {
  await trx.updateTable('catalog_items').set({ sku_id: skuId }).where('id', '=', itemId).execute()
}

export async function catalogItemBasics(trx: ScopedTx, itemId: string): Promise<{ category: string; name: string; unit: string | null } | undefined> {
  return trx.selectFrom('catalog_items').select(['category', 'name', 'unit']).where('id', '=', itemId).executeTakeFirst()
}

// -----------------------------------------------------------------------------
// Jobs / documents, as the stock side needs them
// -----------------------------------------------------------------------------

export async function userNames(trx: ScopedTx, ids: readonly string[]): Promise<Map<string, string | null>> {
  if (ids.length === 0) return new Map()
  const rows = await trx.selectFrom('users').select(['id', 'name']).where('id', 'in', [...new Set(ids)]).execute()
  return new Map(rows.map((r) => [r.id, r.name]))
}
