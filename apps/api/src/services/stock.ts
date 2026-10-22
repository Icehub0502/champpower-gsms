/**
 * Stock service (WO-006): SKU master, the two manual doors (count = ตั้งยอด, adjust = ปรับยอด),
 * the catalog <-> SKU link, and the owner's reports. The two-phase flow that hangs off a quotation
 * (reserve / release / issue) is services/stockReservation.ts.
 *
 * INVARIANTS THIS FILE DEFENDS
 *   - on_hand never goes negative and a quantity is never read, changed in memory and written back
 *     outside a lock: every change goes through BalanceBook (balance row locked FOR UPDATE).
 *   - Only a COUNT creates a balance row. Creating or editing a SKU never does (not counted != zero).
 *   - A manual change always carries a free-text reason, the actor, and the before/after quantities
 *     (ledger row + audit row), and shows up in the owner's daily list.
 *   - Cost never comes from a client, and never goes to a role that may not see it (stockView).
 *
 * WHAT A CONCURRENT SECOND CALLER SEES: a second count/adjust of the same SKU waits on the balance
 * row and then works from the first one's result (an adjust that is no longer a change answers
 * 409 no_change). WHAT A RETRY AFTER A TIMEOUT DOES: the client resends the same requestId; the
 * ledger's UNIQUE key finds the first attempt and returns it with replayed=true, writing nothing.
 *
 * Every function validates BEFORE it writes (a returned error still commits the request).
 */
import {
  adjustmentNeedsApproval, formatQty, gateAdjustment, gateCount, stockKeys, toQtyCenti,
} from '@champpower/domain'
import type { ScopedTx } from '@gsms/db/client.js'
import type { SkuCreateInput, SkuPatchInput, CatalogCreateSkuInput } from '@gsms/contracts/index.js'
import * as stockRepo from '../repositories/stock.js'
import { noteStockChange } from '../lib/stockEvents.js'
import { writeAudit } from './audit.js'
import { BalanceBook } from './stockLedger.js'

export type StockError =
  | { code: 'sku_not_found' }
  | { code: 'sku_inactive' }
  | { code: 'sku_not_counted' }
  | { code: 'no_change' }
  | { code: 'adjustment_negative' }
  | { code: 'adjustment_needs_approval' }
  | { code: 'invalid_request'; fields: Record<string, string[]> }
  | { code: 'sku_code_exists'; skuId: string }
  | { code: 'sku_has_reservations' }
  | { code: 'catalog_item_not_found' }
  | { code: 'catalog_item_not_part' }
  | { code: 'catalog_item_merged' }
  | { code: 'catalog_item_bound'; skuId: string }

export type Result<T> = { ok: true; value: T } | { ok: false; error: StockError }
const err = (error: StockError): { ok: false; error: StockError } => ({ ok: false, error })
const ok = <T>(value: T): { ok: true; value: T } => ({ ok: true, value })

export interface Actor { id: string; role: string }

// -----------------------------------------------------------------------------
// SKU master
// -----------------------------------------------------------------------------

/** ck_reorder_point: only a stocked SKU has a reorder point. Answered as a field error before the CHECK can fire (s4.y). */
function policyFields(policy: string, reorderPoint: string | null | undefined): Record<string, string[]> | null {
  return policy === 'buy_to_order' && reorderPoint != null ? { reorderPoint: ['not_allowed_for_buy_to_order'] } : null
}

export async function createSku(trx: ScopedTx, shopId: string, actor: Actor, input: SkuCreateInput): Promise<Result<string>> {
  const policy = input.stockingPolicy ?? 'stocked'
  const fields = policyFields(policy, input.reorderPoint)
  if (fields) return err({ code: 'invalid_request', fields })
  const existing = await stockRepo.getSkuByCode(trx, input.code)
  if (existing) return err({ code: 'sku_code_exists', skuId: existing.id })
  const id = await stockRepo.insertSku(trx, {
    shopId, code: input.code, name: input.name, category: input.category ?? null, unit: input.unit ?? null,
    stockingPolicy: policy, reorderPoint: input.reorderPoint ?? null, shelfLocation: input.shelfLocation ?? null,
  })
  await writeAudit(trx, {
    shopId, actorId: actor.id, action: 'sku_created', entityType: 'skus', entityId: id,
    after: { code: input.code, name: input.name, stockingPolicy: policy },
  })
  noteStockChange(trx, { skuIds: [id], jobId: null, cause: 'sku' })
  return ok(id)
}

export async function patchSku(trx: ScopedTx, shopId: string, actor: Actor, skuId: string, patch: SkuPatchInput): Promise<Result<void>> {
  const cur = await stockRepo.getSku(trx, skuId)
  if (!cur) return err({ code: 'sku_not_found' })

  const policy = patch.stockingPolicy ?? cur.stocking_policy
  // Switching to buy_to_order retires the reorder point (it has no meaning there); naming one at the same time is a contradiction.
  const fields = policyFields(policy, patch.reorderPoint)
  if (fields) return err({ code: 'invalid_request', fields })

  if (patch.isActive === false && cur.is_active) {
    // Lock the balance row so a reservation cannot slip in between the check and the switch-off.
    const locked = await stockRepo.lockBalances(trx, [skuId])
    const bal = locked.get(skuId)
    if (bal && bal.reserved > 0) return err({ code: 'sku_has_reservations' })
  }

  await stockRepo.updateSku(trx, skuId, {
    name: patch.name, category: patch.category, unit: patch.unit, stockingPolicy: patch.stockingPolicy,
    reorderPoint: policy === 'buy_to_order' ? null : patch.reorderPoint,
    shelfLocation: patch.shelfLocation, isActive: patch.isActive,
  })
  await writeAudit(trx, {
    shopId, actorId: actor.id, action: 'sku_updated', entityType: 'skus', entityId: skuId,
    before: { name: cur.name, category: cur.category, unit: cur.unit, stockingPolicy: cur.stocking_policy, reorderPoint: cur.reorder_point, shelfLocation: cur.shelf_location, isActive: cur.is_active },
    after: { ...patch },
  })
  noteStockChange(trx, { skuIds: [skuId], jobId: null, cause: 'sku' })
  return ok(undefined)
}

// -----------------------------------------------------------------------------
// The manual doors: count (ตั้งยอด) and adjust (ปรับยอด)
// -----------------------------------------------------------------------------

export interface ChangeOutcome {
  moveId: string
  replayed: boolean
  beforeOnHand: string | null
  afterOnHand: string
  deltaQty: string
  belowReserved: boolean
}

async function replayOutcome(trx: ScopedTx, key: string): Promise<ChangeOutcome | null> {
  const prior = await stockRepo.findMoveByKey(trx, key)
  if (!prior) return null
  const after = prior.on_hand_after !== null ? toQtyCenti(prior.on_hand_after) : null
  const delta = toQtyCenti(prior.qty)
  const sku = await stockRepo.getSku(trx, prior.sku_id)
  return {
    moveId: prior.id,
    replayed: true,
    beforeOnHand: after !== null ? formatQty(after - delta) : null,
    afterOnHand: formatQty(after ?? (sku?.on_hand ? toQtyCenti(sku.on_hand) : 0)),
    deltaQty: formatQty(delta),
    belowReserved: sku?.on_hand != null && sku.reserved != null && toQtyCenti(sku.on_hand) < toQtyCenti(sku.reserved),
  }
}

/**
 * ตั้งยอด: the absolute quantity somebody counted on the shelf. Allowed on a never-counted SKU (that is
 * how it becomes counted) and on a counted one, any number of times, zero included. Writes a `count`
 * move even when the number did not change (a count that confirms the system is information).
 */
export async function countSku(
  trx: ScopedTx, shopId: string, actor: Actor, skuId: string,
  input: { requestId: string; qty: string; reason: string },
): Promise<Result<ChangeOutcome>> {
  const sku = await stockRepo.getSku(trx, skuId)
  if (!sku) return err({ code: 'sku_not_found' })
  const gate = gateCount({ currentOnHandCenti: sku.on_hand === null ? null : toQtyCenti(sku.on_hand), qty: input.qty, reason: input.reason })
  if (!gate.ok) return err(gate.status === 400 ? { code: 'invalid_request', fields: gate.fields } : { code: gate.code })

  const key = stockKeys.count(skuId, input.requestId)
  const replay = await replayOutcome(trx, key)
  if (replay) return ok(replay)
  if (!sku.is_active) return err({ code: 'sku_inactive' })

  // Everything that can refuse is above this line; below it the request writes.
  const created = await stockRepo.ensureBalanceRow(trx, shopId, skuId)
  const book = new BalanceBook(trx, shopId, await stockRepo.lockBalances(trx, [skuId]))
  const before = created ? null : book.get(skuId).onHand
  const newCenti = gate.newCenti
  const delta = newCenti - (before ?? 0)
  const reason = input.reason.trim()
  const posted = await book.post({ skuId, type: 'count', qtyCenti: delta, key, reason, userId: actor.id })
  if (posted === 'replayed') return ok((await replayOutcome(trx, key))!)
  await book.flush()
  const snap = book.snapshot(skuId)
  await writeAudit(trx, {
    shopId, actorId: actor.id, action: 'stock_counted', entityType: 'skus', entityId: skuId,
    // The reason is staff free text kept here on purpose: a manual stock change must show WHY to the owner (CLAUDE.md s6 rule 5).
    before: { onHand: before === null ? null : formatQty(before) },
    after: { onHand: formatQty(snap.onHand), delta: formatQty(delta), reason, requestId: input.requestId },
  })
  noteStockChange(trx, { skuIds: [skuId], jobId: null, cause: 'count' })
  return ok({
    moveId: book.lastMoveId!, replayed: false, beforeOnHand: before === null ? null : formatQty(before),
    afterOnHand: formatQty(snap.onHand), deltaQty: formatQty(delta), belowReserved: snap.onHand < snap.reserved,
  })
}

/**
 * ปรับยอด: change a quantity the system already believed in. The SKU must be counted already, the new
 * quantity may not be negative, must differ, and the reason is mandatory free text. Role-gated by the route.
 */
export async function adjustSku(
  trx: ScopedTx, shopId: string, actor: Actor, skuId: string,
  input: { requestId: string; newQty: string; reason: string },
): Promise<Result<ChangeOutcome>> {
  const sku = await stockRepo.getSku(trx, skuId)
  if (!sku) return err({ code: 'sku_not_found' })
  const key = stockKeys.adjust(skuId, input.requestId)
  const replay = await replayOutcome(trx, key)
  if (replay) return ok(replay)

  const early = gateAdjustment({ currentOnHandCenti: sku.on_hand === null ? null : toQtyCenti(sku.on_hand), newQty: input.newQty, reason: input.reason })
  if (!early.ok) return err(early.status === 400 ? { code: 'invalid_request', fields: early.fields } : { code: early.code })
  if (!sku.is_active) return err({ code: 'sku_inactive' })

  // Re-judge under the lock: another adjust may have moved the number since the unlocked read above.
  const book = new BalanceBook(trx, shopId, await stockRepo.lockBalances(trx, [skuId]))
  if (!book.has(skuId)) return err({ code: 'sku_not_counted' })
  const before = book.get(skuId).onHand
  const gate = gateAdjustment({ currentOnHandCenti: before, newQty: input.newQty, reason: input.reason })
  if (!gate.ok) return err(gate.status === 400 ? { code: 'invalid_request', fields: gate.fields } : { code: gate.code })

  // DEFAULT pending Ice (CLAUDE.md s12.1 point 3): the per-shop value limit needs avg_cost, which purchasing (a later
  // release) creates. The seam is called so the day the limit exists it is enforced HERE, on the server; today it never refuses.
  if (adjustmentNeedsApproval({ deltaCenti: gate.deltaCenti, avgCostSatang: null, limitSatang: null })) return err({ code: 'adjustment_needs_approval' })

  const reason = input.reason.trim()
  const posted = await book.post({ skuId, type: 'adjustment', qtyCenti: gate.deltaCenti, key, reason, userId: actor.id })
  if (posted === 'replayed') return ok((await replayOutcome(trx, key))!)
  await book.flush()
  const snap = book.snapshot(skuId)
  await writeAudit(trx, {
    shopId, actorId: actor.id, action: 'stock_adjusted', entityType: 'skus', entityId: skuId,
    before: { onHand: formatQty(before) },
    after: { onHand: formatQty(snap.onHand), delta: formatQty(gate.deltaCenti), reason, requestId: input.requestId },
  })
  noteStockChange(trx, { skuIds: [skuId], jobId: null, cause: 'adjust' })
  return ok({
    moveId: book.lastMoveId!, replayed: false, beforeOnHand: formatQty(before), afterOnHand: formatQty(snap.onHand),
    deltaQty: formatQty(gate.deltaCenti), belowReserved: snap.onHand < snap.reserved,
  })
}

// -----------------------------------------------------------------------------
// Catalog <-> SKU link
// -----------------------------------------------------------------------------

async function loadBindableItem(trx: ScopedTx, itemId: string): Promise<Result<{ id: string; sku_id: string | null }>> {
  const item = await stockRepo.lockCatalogItem(trx, itemId)
  if (!item) return err({ code: 'catalog_item_not_found' })
  if (item.merged_into_id) return err({ code: 'catalog_item_merged' })
  if (item.line_type !== 'part') return err({ code: 'catalog_item_not_part' })
  return ok(item)
}

export async function bindCatalogItem(trx: ScopedTx, shopId: string, actor: Actor, itemId: string, skuId: string): Promise<Result<void>> {
  const item = await loadBindableItem(trx, itemId)
  if (!item.ok) return item
  const sku = await stockRepo.getSku(trx, skuId)
  if (!sku) return err({ code: 'sku_not_found' })
  if (!sku.is_active) return err({ code: 'sku_inactive' })
  await stockRepo.setCatalogSku(trx, itemId, skuId)
  await writeAudit(trx, {
    shopId, actorId: actor.id, action: 'catalog_sku_bound', entityType: 'catalog_items', entityId: itemId,
    before: { skuId: item.value.sku_id }, after: { skuId },
  })
  noteStockChange(trx, { skuIds: [skuId], jobId: null, cause: 'link' })
  return ok(undefined)
}

export async function unbindCatalogItem(trx: ScopedTx, shopId: string, actor: Actor, itemId: string): Promise<Result<void>> {
  const item = await loadBindableItem(trx, itemId)
  if (!item.ok) return item
  if (item.value.sku_id === null) return ok(undefined)
  await stockRepo.setCatalogSku(trx, itemId, null)
  await writeAudit(trx, {
    shopId, actorId: actor.id, action: 'catalog_sku_unbound', entityType: 'catalog_items', entityId: itemId,
    before: { skuId: item.value.sku_id }, after: { skuId: null },
  })
  noteStockChange(trx, { skuIds: [item.value.sku_id], jobId: null, cause: 'link' })
  return ok(undefined)
}

/** Make a SKU out of a catalog item and bind it, in one transaction (name / category / unit come from the item). */
export async function createSkuFromCatalogItem(trx: ScopedTx, shopId: string, actor: Actor, itemId: string, input: CatalogCreateSkuInput): Promise<Result<string>> {
  const item = await loadBindableItem(trx, itemId)
  if (!item.ok) return item
  if (item.value.sku_id !== null) return err({ code: 'catalog_item_bound', skuId: item.value.sku_id })
  const basics = (await stockRepo.catalogItemBasics(trx, itemId))!
  const created = await createSku(trx, shopId, actor, {
    code: input.code, name: input.name ?? basics.name, category: input.category ?? basics.category,
    unit: input.unit ?? basics.unit ?? undefined, stockingPolicy: input.stockingPolicy,
    reorderPoint: input.reorderPoint, shelfLocation: input.shelfLocation,
  })
  if (!created.ok) return created
  await stockRepo.setCatalogSku(trx, itemId, created.value)
  await writeAudit(trx, {
    shopId, actorId: actor.id, action: 'catalog_sku_bound', entityType: 'catalog_items', entityId: itemId,
    before: { skuId: null }, after: { skuId: created.value, createdFromItem: true },
  })
  return created
}
