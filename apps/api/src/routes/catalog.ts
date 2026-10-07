/**
 * The selling catalog, standard prices, and the controlled vehicle-model list
 * (P3.1).
 *
 *   GET  /api/catalog/search
 *   POST /api/catalog/prices
 *   PUT  /api/catalog/prices/:id
 *   POST /api/catalog/items
 *   GET  /api/catalog/similar
 *   POST /api/catalog/items/:id/merge
 *   GET  /api/warranty-terms
 *   GET  /api/vehicle-models
 *   POST /api/vehicle-models
 *   PUT  /api/vehicles/:id/model
 *   GET  /api/vehicle-models/unmatched
 *   POST /api/vehicle-models/unmatched/assign
 *
 * NO cost field anywhere in this file's responses — the catalog has none to
 * leak (CLAUDE.md §12.2); every price here is a selling price.
 */
import { z } from 'zod'
import { withShop } from '@gsms/db/client.js'
import {
  CatalogItem, CatalogItemCreateInput, CatalogMergeInput, CatalogMergeResult, CatalogPriceCreateInput,
  CatalogPriceFixInput, CatalogPriceWritten, CatalogSearchQuery, CatalogSearchResult, CatalogSimilarQuery,
  CatalogSimilarResult, UnmatchedAssignInput, UnmatchedAssignResult, UnmatchedModelPage,
  VehicleModel, VehicleModelCreateInput, VehicleModelAssignInput, VehicleModelAssigned, VehicleModelPage,
  VehicleModelQuery, WarrantyTermList, type InvalidRequestError,
} from '@gsms/contracts/index.js'
import { db } from '../lib/db.js'
import { requireAuth, requireRole, type AuthedRequest } from '../middleware/requireAuth.js'
import { asyncRouter } from '../middleware/asyncHandler.js'
import { fieldErrorsOf } from '../lib/fieldErrors.js'
import { isCatalogNameConflict } from '../lib/pgError.js'
import { INTAKE_WRITE_ROLES } from './queue.js'
import * as catalogRepo from '../repositories/catalog.js'
import * as pricing from '../services/catalogPricing.js'
import { writeAudit } from '../services/audit.js'

export const catalogRouter = asyncRouter()

const MANAGER_ROLES = ['owner', 'manager', 'assistant_manager'] as const

function badRequest(res: import('express').Response, error: import('zod').ZodError, message: string): void {
  const body: InvalidRequestError = { error: 'invalid_request', message, fields: fieldErrorsOf(error) }
  res.status(400).json(body)
}

function itemView(row: catalogRepo.CatalogItemRow): CatalogItem {
  return {
    id: row.id, category: row.category, name: row.name, lineType: row.line_type as CatalogItem['lineType'],
    unit: row.unit, defaultQty: row.default_qty, isSet: row.is_set, basePrice: row.base_price,
    warranty: row.warranty_term_id ? { id: row.warranty_term_id, name: row.warranty_name!, days: row.warranty_days, maxKm: row.warranty_max_km } : null,
    isActive: row.is_active,
  }
}

// ---------------------------------------------------------------------------
// GET /api/catalog/search
// ---------------------------------------------------------------------------
catalogRouter.get(
  '/catalog/search',
  requireAuth, requireRole(...INTAKE_WRITE_ROLES),
  async (req: AuthedRequest, res) => {
    const parsed = CatalogSearchQuery.safeParse(req.query)
    if (!parsed.success) { badRequest(res, parsed.error, 'คำค้นไม่ถูกต้อง'); return }
    const auth = req.auth!
    const result = await withShop(db, auth.shop, (trx) => pricing.searchCatalog(trx, parsed.data))
    res.json(CatalogSearchResult.parse(result))
  },
)

// ---------------------------------------------------------------------------
// POST /api/catalog/prices — first price (D8), advisor+
// ---------------------------------------------------------------------------
catalogRouter.post(
  '/catalog/prices',
  requireAuth, requireRole(...INTAKE_WRITE_ROLES),
  async (req: AuthedRequest, res) => {
    const parsed = CatalogPriceCreateInput.safeParse(req.body)
    if (!parsed.success) { badRequest(res, parsed.error, 'ข้อมูลราคาไม่ถูกต้อง'); return }
    const auth = req.auth!
    const result = await withShop(db, auth.shop, (trx) => pricing.writeFirstPrice(trx, { shopId: auth.shop, actorId: auth.sub, ...parsed.data }))
    if (!result.ok && result.notFound) {
      res.status(404).json({ error: 'catalog_item_not_found', message: 'ไม่พบรายการหรืองานนี้' })
      return
    }
    if (!result.ok) {
      res.status(409).json({ error: 'price_already_set', message: `ราคานี้ถูกตั้งไปแล้วเป็น ฿${result.existingPrice}`, existingPrice: result.existingPrice, scope: result.scope })
      return
    }
    res.status(201).json(CatalogPriceWritten.parse({ priceId: result.priceId, itemId: result.itemId, scope: result.scope, price: result.price }))
  },
)

// ---------------------------------------------------------------------------
// PUT /api/catalog/prices/:id — fix a wrong price, manager+
// ---------------------------------------------------------------------------
catalogRouter.put(
  '/catalog/prices/:id',
  requireAuth, requireRole(...MANAGER_ROLES),
  async (req: AuthedRequest, res) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params)
    const body = CatalogPriceFixInput.safeParse(req.body)
    if (!params.success) { res.status(404).json({ error: 'catalog_item_not_found' }); return }
    if (!body.success) { badRequest(res, body.error, 'ข้อมูลไม่ถูกต้อง'); return }
    const auth = req.auth!
    const row = await withShop(db, auth.shop, (trx) =>
      pricing.fixPrice(trx, { shopId: auth.shop, actorId: auth.sub, id: params.data.id, ...body.data }))
    if (!row) { res.status(404).json({ error: 'catalog_item_not_found', message: 'ไม่พบราคานี้' }); return }
    res.json(CatalogPriceWritten.parse({ priceId: row.id, itemId: row.itemId, scope: body.data.scope, price: row.price }))
  },
)

// ---------------------------------------------------------------------------
// POST /api/catalog/items — add a new item from the quotation screen (D12)
// ---------------------------------------------------------------------------
catalogRouter.post(
  '/catalog/items',
  requireAuth, requireRole(...INTAKE_WRITE_ROLES),
  async (req: AuthedRequest, res) => {
    const parsed = CatalogItemCreateInput.safeParse(req.body)
    if (!parsed.success) { badRequest(res, parsed.error, 'ข้อมูลรายการไม่ถูกต้อง'); return }
    const auth = req.auth!
    const d = parsed.data
    if (!d.confirmNotSimilar) {
      const similar = await withShop(db, auth.shop, (trx) => pricing.findSimilar(trx, d.category, d.name))
      if (similar.length > 0) {
        res.status(409).json({ error: 'similar_item_found', message: `คล้ายกับ "${similar[0]!.name}" ที่มีอยู่แล้ว`, similar: similar.map(({ id, category, name }) => ({ id, category, name })) })
        return
      }
    }
    let created: Awaited<ReturnType<typeof pricing.createItem>>
    try {
      created = await withShop(db, auth.shop, (trx) => pricing.createItem(trx, {
        shopId: auth.shop, category: d.category, name: d.name, lineType: d.lineType,
        unit: d.unit ?? null, defaultQty: d.defaultQty, warrantyTermId: d.warrantyTermId ?? null, actorId: auth.sub,
      }))
    } catch (err) {
      if (!isCatalogNameConflict(err)) throw err
      // Lost the race on uq_catalog_items_name: the winner is committed now.
      const winner = await withShop(db, auth.shop, (trx) => catalogRepo.findItemByKeys(trx, d.category, d.name))
      if (!winner) throw err
      created = { kind: 'exists', itemId: winner.id }
    }
    if (created.kind === 'warranty_not_found') {
      res.status(404).json({ error: 'warranty_term_not_found', message: 'ไม่พบเงื่อนไขการรับประกันนี้' })
      return
    }
    if (created.kind === 'exists') {
      res.status(409).json({ error: 'catalog_item_exists', message: 'มีรายการชื่อนี้ในหมวดนี้อยู่แล้ว', itemId: created.itemId })
      return
    }
    res.status(201).json(CatalogItem.parse(itemView(created.item)))
  },
)

// ---------------------------------------------------------------------------
// GET /api/catalog/similar
// ---------------------------------------------------------------------------
catalogRouter.get(
  '/catalog/similar',
  requireAuth, requireRole(...INTAKE_WRITE_ROLES),
  async (req: AuthedRequest, res) => {
    const parsed = CatalogSimilarQuery.safeParse(req.query)
    if (!parsed.success) { badRequest(res, parsed.error, 'ข้อมูลไม่ถูกต้อง'); return }
    const auth = req.auth!
    const items = await withShop(db, auth.shop, (trx) => pricing.findSimilar(trx, parsed.data.category, parsed.data.name))
    res.json(CatalogSimilarResult.parse({ items }))
  },
)

// ---------------------------------------------------------------------------
// POST /api/catalog/items/:id/merge — manager+
// ---------------------------------------------------------------------------
catalogRouter.post(
  '/catalog/items/:id/merge',
  requireAuth, requireRole(...MANAGER_ROLES),
  async (req: AuthedRequest, res) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params)
    const body = CatalogMergeInput.safeParse(req.body)
    if (!params.success) { res.status(404).json({ error: 'catalog_item_not_found' }); return }
    if (!body.success) { badRequest(res, body.error, 'ข้อมูลไม่ถูกต้อง'); return }
    const auth = req.auth!
    const result = await withShop(db, auth.shop, (trx) => pricing.mergeItems(trx, {
      shopId: auth.shop, sourceItemId: params.data.id, intoItemId: body.data.intoItemId,
      priceConflicts: body.data.priceConflicts, reason: body.data.reason, actorId: auth.sub,
    }))
    if (!result.ok) {
      if (result.code === 'not_allowed') { res.status(409).json({ error: 'merge_not_allowed', message: 'รวมรายการนี้ไม่ได้' }); return }
      res.status(409).json({ error: 'merge_price_conflict', message: 'มีราคาของทั้งสองรายการชนกันในบางรุ่นรถ ต้องเลือกก่อน', vehicleModelIds: result.vehicleModelIds })
      return
    }
    res.json(CatalogMergeResult.parse({ sourceItemId: params.data.id, intoItemId: body.data.intoItemId, movedPrices: result.movedPrices, droppedPrices: result.droppedPrices }))
  },
)

// ---------------------------------------------------------------------------
// GET /api/warranty-terms
// ---------------------------------------------------------------------------
catalogRouter.get(
  '/warranty-terms',
  requireAuth, requireRole(...INTAKE_WRITE_ROLES),
  async (req: AuthedRequest, res) => {
    const auth = req.auth!
    const rows = await withShop(db, auth.shop, (trx) => catalogRepo.listWarrantyTerms(trx))
    res.json(WarrantyTermList.parse({ items: rows.map((r) => ({ id: r.id, name: r.name, days: r.days, maxKm: r.max_km })) }))
  },
)

// ---------------------------------------------------------------------------
// GET /api/vehicle-models
// ---------------------------------------------------------------------------
catalogRouter.get(
  '/vehicle-models',
  requireAuth, requireRole(...INTAKE_WRITE_ROLES),
  async (req: AuthedRequest, res) => {
    const parsed = VehicleModelQuery.safeParse(req.query)
    if (!parsed.success) { badRequest(res, parsed.error, 'ข้อมูลไม่ถูกต้อง'); return }
    const auth = req.auth!
    const { rows, total } = await withShop(db, auth.shop, (trx) =>
      catalogRepo.searchVehicleModels(trx, parsed.data.q, parsed.data.limit, parsed.data.offset))
    res.json(VehicleModelPage.parse({
      items: rows.map((r) => ({ id: r.id, brand: r.brand, name: r.name, yearRange: r.year_range })),
      total,
    }))
  },
)

// ---------------------------------------------------------------------------
// POST /api/vehicle-models — advisor+, audited
// ---------------------------------------------------------------------------
catalogRouter.post(
  '/vehicle-models',
  requireAuth, requireRole(...INTAKE_WRITE_ROLES),
  async (req: AuthedRequest, res) => {
    const parsed = VehicleModelCreateInput.safeParse(req.body)
    if (!parsed.success) { badRequest(res, parsed.error, 'ข้อมูลรุ่นรถไม่ถูกต้อง'); return }
    const auth = req.auth!
    const d = parsed.data
    const result = await withShop(db, auth.shop, async (trx) => {
      const existing = await catalogRepo.existingVehicleModel(trx, d.brand, d.name)
      if (existing) return { exists: true as const, row: existing }
      const row = await catalogRepo.insertVehicleModel(trx, { shopId: auth.shop, brand: d.brand, name: d.name, yearRange: d.yearRange ?? null })
      await writeAudit(trx, { shopId: auth.shop, actorId: auth.sub, action: 'vehicle_model_created', entityType: 'vehicle_models', entityId: row.id, after: { brand: d.brand, name: d.name } })
      return { exists: false as const, row }
    })
    if (result.exists) {
      res.status(409).json({ error: 'vehicle_model_exists', message: 'รุ่นรถนี้มีอยู่ในรายการแล้ว', vehicleModelId: result.row.id })
      return
    }
    res.status(201).json(VehicleModel.parse({ id: result.row.id, brand: result.row.brand, name: result.row.name, yearRange: result.row.year_range }))
  },
)

// ---------------------------------------------------------------------------
// PUT /api/vehicles/:id/model — match this car to a controlled model, advisor+, audited
// ---------------------------------------------------------------------------
catalogRouter.put(
  '/vehicles/:id/model',
  requireAuth, requireRole(...INTAKE_WRITE_ROLES),
  async (req: AuthedRequest, res) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params)
    const body = VehicleModelAssignInput.safeParse(req.body)
    if (!params.success || !body.success) { res.status(400).json({ error: 'invalid_request' }); return }
    const auth = req.auth!
    const outcome = await withShop(db, auth.shop, async (trx) => {
      // A missing id and another shop's id look the same (RLS): 404, and nothing is written.
      if (!(await catalogRepo.vehicleExists(trx, params.data.id))) return 'vehicle_not_found' as const
      if (!(await catalogRepo.vehicleModelExists(trx, body.data.vehicleModelId))) return 'vehicle_model_not_found' as const
      await catalogRepo.assignVehicleModel(trx, params.data.id, body.data.vehicleModelId)
      await writeAudit(trx, { shopId: auth.shop, actorId: auth.sub, action: 'vehicle_model_assigned', entityType: 'vehicles', entityId: params.data.id, after: { vehicleModelId: body.data.vehicleModelId } })
      return 'ok' as const
    })
    if (outcome === 'vehicle_not_found') { res.status(404).json({ error: 'vehicle_not_found', message: 'ไม่พบรถคันนี้' }); return }
    if (outcome === 'vehicle_model_not_found') { res.status(404).json({ error: 'vehicle_model_not_found', message: 'ไม่พบรุ่นรถนี้' }); return }
    res.json(VehicleModelAssigned.parse({ vehicleId: params.data.id, vehicleModelId: body.data.vehicleModelId }))
  },
)

// ---------------------------------------------------------------------------
// GET /api/vehicle-models/unmatched — manager+
// ---------------------------------------------------------------------------
catalogRouter.get(
  '/vehicle-models/unmatched',
  requireAuth, requireRole(...MANAGER_ROLES),
  async (req: AuthedRequest, res) => {
    const parsed = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50), offset: z.coerce.number().int().min(0).default(0) }).safeParse(req.query)
    if (!parsed.success) { badRequest(res, parsed.error, 'ข้อมูลไม่ถูกต้อง'); return }
    const auth = req.auth!
    const { rows, total } = await withShop(db, auth.shop, (trx) => catalogRepo.unmatchedVehicleGroups(trx, parsed.data.limit, parsed.data.offset))
    res.json(UnmatchedModelPage.parse({
      items: rows.map((r) => ({ brandText: r.brand_text, modelText: r.model_text, vehicleCount: r.vehicle_count })),
      total,
    }))
  },
)

// ---------------------------------------------------------------------------
// POST /api/vehicle-models/unmatched/assign — manager+, audited
// ---------------------------------------------------------------------------
catalogRouter.post(
  '/vehicle-models/unmatched/assign',
  requireAuth, requireRole(...MANAGER_ROLES),
  async (req: AuthedRequest, res) => {
    const parsed = UnmatchedAssignInput.safeParse(req.body)
    if (!parsed.success) { badRequest(res, parsed.error, 'ข้อมูลไม่ถูกต้อง'); return }
    const auth = req.auth!
    const updated = await withShop(db, auth.shop, async (trx) => {
      if (!(await catalogRepo.vehicleModelExists(trx, parsed.data.vehicleModelId))) return null
      const n = await catalogRepo.assignModelToGroup(trx, parsed.data.brandText, parsed.data.modelText, parsed.data.vehicleModelId)
      await writeAudit(trx, {
        shopId: auth.shop, actorId: auth.sub, action: 'vehicle_model_group_assigned', entityType: 'vehicle_models', entityId: parsed.data.vehicleModelId,
        after: { brandText: parsed.data.brandText, modelText: parsed.data.modelText, updated: n },
      })
      return n
    })
    if (updated === null) { res.status(404).json({ error: 'vehicle_model_not_found', message: 'ไม่พบรุ่นรถนี้' }); return }
    res.json(UnmatchedAssignResult.parse({ updated }))
  },
)
