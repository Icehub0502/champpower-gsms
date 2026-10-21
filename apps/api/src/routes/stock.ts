/**
 * Stock (WO-006). The endpoint list, request and response schemas are the header of
 * packages/contracts/src/stock.ts - this file is the thin shell: parse, check the ROLE (on the
 * server, every route), call the service inside withShop / withShopStock, shape the answer.
 *
 * WHO MAY DO WHAT (CLAUDE.md s12.1)
 *   read quantities ............ every role
 *   issue (เบิก) ............... owner, manager, assistant_manager, advisor, technician
 *   count / adjust / SKU master  owner, manager, assistant_manager, advisor   (DEFAULT pending Ice: SKU master
 *                                follows the adjustment roles; the matrix has no row for it)
 *   daily adjustments, integrity owner, manager, assistant_manager
 *   cost fields ................ stripped for everyone but owner, manager, assistant_manager, accountant
 *                                (services/stockView.ts) - never sent, not hidden.
 */
import type { Response } from 'express'
import { z } from 'zod'
import { withShop } from '@gsms/db/client.js'
import {
  AdjustInput, AdjustmentsQuery, CardQuery, CatalogBindInput, CatalogCreateSkuInput, CatalogLinkPage,
  CatalogLinkRow, CatalogLinksQuery, CountInput, CountSheetPage, CountSheetQuery, DailyAdjustments,
  IntegrityReport, JobStock, LowStockQuery, SkuCreateInput, SkuDetail, SkuListQuery, SkuPage, SkuPatchInput,
  SkuRow, StockCard, StockChangeResult, StockIssueInput, StockIssueResult, UnboundLinePage, UnboundLinesQuery,
  type InvalidRequestError, type StockBody,
} from '@gsms/contracts/index.js'
import { formatQty, toQtyCenti } from '@champpower/domain'
import { db } from '../lib/db.js'
import { requireAuth, requireRole, type AuthedRequest } from '../middleware/requireAuth.js'
import { asyncRouter } from '../middleware/asyncHandler.js'
import { fieldErrorsOf } from '../lib/fieldErrors.js'
import { addDays, bangkokToday, startOfDay } from '../lib/bangkokDate.js'
import { withShopStock } from '../lib/stockEvents.js'
import { sendPgError } from '../lib/pgError.js'
import * as stockRepo from '../repositories/stock.js'
import * as svc from '../services/stock.js'
import * as reservation from '../services/stockReservation.js'
import { countSheetRowView, moveView, skuView } from '../services/stockView.js'

export const stockRouter = asyncRouter()

const READ_ROLES = ['owner', 'manager', 'assistant_manager', 'advisor', 'technician', 'accountant', 'viewer'] as const
const ISSUE_ROLES = ['owner', 'manager', 'assistant_manager', 'advisor', 'technician'] as const
const WRITE_ROLES = ['owner', 'manager', 'assistant_manager', 'advisor'] as const
const REPORT_ROLES = ['owner', 'manager', 'assistant_manager'] as const

const idParam = z.object({ id: z.string().uuid() })
const itemParam = z.object({ itemId: z.string().uuid() })
const jobParam = z.object({ jobId: z.string().uuid() })

function refuse(res: Response, status: number, body: StockBody): void {
  res.status(status).json(body)
}

function badRequest(res: Response, error: z.ZodError, message: string): void {
  const body: InvalidRequestError = { error: 'invalid_request', message, fields: fieldErrorsOf(error) }
  res.status(400).json(body)
}

function sendStockError(res: Response, e: svc.StockError): void {
  switch (e.code) {
    case 'sku_not_found': return refuse(res, 404, { error: 'sku_not_found', message: 'ไม่พบอะไหล่นี้' })
    case 'sku_inactive': return refuse(res, 409, { error: 'sku_inactive', message: 'อะไหล่นี้ถูกปิดใช้งานแล้ว' })
    case 'sku_not_counted': return refuse(res, 409, { error: 'sku_not_counted', message: 'อะไหล่นี้ยังไม่ตั้งยอด ให้ตั้งยอดก่อน' })
    case 'no_change': return refuse(res, 409, { error: 'no_change', message: 'ยอดใหม่เท่ากับยอดเดิม ไม่มีอะไรต้องปรับ' })
    case 'adjustment_negative': return refuse(res, 409, { error: 'adjustment_negative', message: 'ปรับให้ยอดติดลบไม่ได้' })
    case 'adjustment_needs_approval': return refuse(res, 409, { error: 'adjustment_needs_approval', message: 'รายการนี้เกินวงเงินที่ปรับเองได้ ส่งให้ผู้จัดการอนุมัติ' })
    case 'invalid_request': return refuse(res, 400, { error: 'invalid_request', message: 'ข้อมูลไม่ถูกต้อง', fields: e.fields })
    case 'sku_code_exists': return refuse(res, 409, { error: 'sku_code_exists', message: 'มีรหัสอะไหล่นี้อยู่แล้ว', skuId: e.skuId })
    case 'sku_has_reservations': return refuse(res, 409, { error: 'sku_has_reservations', message: 'อะไหล่นี้ยังมีของที่จองไว้ ปิดใช้งานไม่ได้' })
    case 'catalog_item_not_found': return refuse(res, 404, { error: 'catalog_item_not_found', message: 'ไม่พบรายการนี้ในแคตตาล็อก' })
    case 'catalog_item_not_part': return refuse(res, 409, { error: 'catalog_item_not_part', message: 'ผูกสต๊อกได้เฉพาะรายการที่เป็นอะไหล่' })
    case 'catalog_item_merged': return refuse(res, 409, { error: 'catalog_item_merged', message: 'รายการนี้ถูกรวมเข้ากับรายการอื่นแล้ว' })
    case 'catalog_item_bound': return refuse(res, 409, { error: 'catalog_item_bound', message: 'รายการนี้ผูกกับอะไหล่อยู่แล้ว', skuId: e.skuId })
  }
}

function sendIssueError(res: Response, e: reservation.IssueError): void {
  switch (e.code) {
    case 'job_not_found': return refuse(res, 404, { error: 'job_not_found', message: 'ไม่พบงานนี้' })
    case 'quotation_missing': return refuse(res, 409, { error: 'quotation_missing', message: 'งานนี้ยังไม่มีใบเสนอราคา' })
    case 'quotation_not_confirmed': return refuse(res, 409, { error: 'quotation_not_confirmed', message: 'ใบเสนอราคายังไม่ได้ยืนยันผลลูกค้า เบิกของไม่ได้' })
    case 'line_not_issuable': return refuse(res, 409, { error: 'line_not_issuable', message: 'บรรทัดนี้เบิกไม่ได้', lineId: e.lineId, reason: e.reason })
    case 'sku_not_counted': return refuse(res, 409, { error: 'sku_not_counted', message: 'อะไหล่นี้ยังไม่ตั้งยอด ตั้งยอดก่อนจึงเบิกได้' })
    case 'insufficient_on_hand': return refuse(res, 409, { error: 'insufficient_on_hand', message: 'ของในสต๊อกไม่พอ', lineId: e.lineId, skuId: e.skuId, onHand: e.onHand, requested: e.requested })
    case 'over_reserved_needs_confirm': return refuse(res, 409, { error: 'over_reserved_needs_confirm', message: 'เบิกเกินที่จองไว้ ต้องกดยืนยัน', lineId: e.lineId, reserved: e.reserved, requested: e.requested })
  }
}

async function skuRowOf(trx: Parameters<typeof stockRepo.getSku>[0], skuId: string, role: string): Promise<SkuRow> {
  return skuView((await stockRepo.getSku(trx, skuId))!, role)
}

// ---------------------------------------------------------------------------
// SKUs
// ---------------------------------------------------------------------------

stockRouter.get('/stock/skus', requireAuth, requireRole(...READ_ROLES), async (req: AuthedRequest, res) => {
  const q = SkuListQuery.safeParse(req.query)
  if (!q.success) { badRequest(res, q.error, 'ตัวกรองไม่ถูกต้อง'); return }
  const auth = req.auth!
  const { rows, total } = await withShop(db, auth.shop, (trx) =>
    stockRepo.listSkus(trx, { q: q.data.q, category: q.data.category, status: q.data.status, active: q.data.active }, q.data.limit, q.data.offset))
  res.json(SkuPage.parse({ items: rows.map((r) => skuView(r, auth.role)), total }))
})

// Before /stock/skus/:id so "by-code" is never read as an id. A QR label carries skus.code.
stockRouter.get('/stock/skus/by-code/:code', requireAuth, requireRole(...READ_ROLES), async (req: AuthedRequest, res) => {
  const code = z.string().trim().min(1).max(100).safeParse(req.params.code)
  if (!code.success) { refuse(res, 404, { error: 'sku_not_found', message: 'ไม่พบอะไหล่นี้' }); return }
  const auth = req.auth!
  const row = await withShop(db, auth.shop, (trx) => stockRepo.getSkuByCode(trx, code.data))
  if (!row) { refuse(res, 404, { error: 'sku_not_found', message: 'ไม่พบอะไหล่นี้' }); return }
  res.json(SkuRow.parse(skuView(row, auth.role)))
})

stockRouter.get('/stock/skus/:id', requireAuth, requireRole(...READ_ROLES), async (req: AuthedRequest, res) => {
  const p = idParam.safeParse(req.params)
  if (!p.success) { refuse(res, 404, { error: 'sku_not_found', message: 'ไม่พบอะไหล่นี้' }); return }
  const auth = req.auth!
  const out = await withShop(db, auth.shop, async (trx) => {
    const row = await stockRepo.getSku(trx, p.data.id)
    if (!row) return null
    return { row, items: await stockRepo.catalogItemsOfSku(trx, p.data.id) }
  })
  if (!out) { refuse(res, 404, { error: 'sku_not_found', message: 'ไม่พบอะไหล่นี้' }); return }
  res.json(SkuDetail.parse({ ...skuView(out.row, auth.role), catalogItems: out.items }))
})

stockRouter.post('/stock/skus', requireAuth, requireRole(...WRITE_ROLES), async (req: AuthedRequest, res) => {
  const body = SkuCreateInput.safeParse(req.body)
  if (!body.success) { badRequest(res, body.error, 'ข้อมูลอะไหล่ไม่ถูกต้อง'); return }
  const auth = req.auth!
  try {
    const r = await withShopStock(db, auth.shop, async (trx) => {
      const created = await svc.createSku(trx, auth.shop, { id: auth.sub, role: auth.role }, body.data)
      return created.ok ? { ok: true as const, row: await skuRowOf(trx, created.value, auth.role) } : created
    })
    if (!r.ok) { sendStockError(res, r.error); return }
    res.status(201).json(SkuRow.parse(r.row))
  } catch (err) {
    // Lost the race on uq_skus_code: the same answer the pre-check gives.
    if ((err as { constraint?: string }).constraint === 'uq_skus_code') {
      const existing = await withShop(db, auth.shop, (trx) => stockRepo.getSkuByCode(trx, body.data.code))
      if (existing) { sendStockError(res, { code: 'sku_code_exists', skuId: existing.id }); return }
    }
    sendPgError(res, err)
  }
})

stockRouter.patch('/stock/skus/:id', requireAuth, requireRole(...WRITE_ROLES), async (req: AuthedRequest, res) => {
  const p = idParam.safeParse(req.params)
  const body = SkuPatchInput.safeParse(req.body)
  if (!p.success) { refuse(res, 404, { error: 'sku_not_found', message: 'ไม่พบอะไหล่นี้' }); return }
  if (!body.success) { badRequest(res, body.error, 'ข้อมูลที่แก้ไม่ถูกต้อง'); return }
  const auth = req.auth!
  try {
    const r = await withShopStock(db, auth.shop, async (trx) => {
      const done = await svc.patchSku(trx, auth.shop, { id: auth.sub, role: auth.role }, p.data.id, body.data)
      return done.ok ? { ok: true as const, row: await skuRowOf(trx, p.data.id, auth.role) } : done
    })
    if (!r.ok) { sendStockError(res, r.error); return }
    res.json(SkuRow.parse(r.row))
  } catch (err) { sendPgError(res, err) }
})

// ---------------------------------------------------------------------------
// Count sheet, count, adjust, low stock, stock card
// ---------------------------------------------------------------------------

stockRouter.get('/stock/count-sheet', requireAuth, requireRole(...READ_ROLES), async (req: AuthedRequest, res) => {
  const q = CountSheetQuery.safeParse(req.query)
  if (!q.success) { badRequest(res, q.error, 'ตัวกรองไม่ถูกต้อง'); return }
  const auth = req.auth!
  const out = await withShop(db, auth.shop, async (trx) => {
    const { rows, total } = await stockRepo.listCountSheet(trx, { q: q.data.q, category: q.data.category, onlyUncounted: q.data.onlyUncounted }, q.data.limit, q.data.offset)
    return { rows, total, last: await stockRepo.lastCountedAt(trx, rows.map((r) => r.id)) }
  })
  res.json(CountSheetPage.parse({ items: out.rows.map((r) => countSheetRowView(r, auth.role, out.last.get(r.id))), total: out.total }))
})

stockRouter.post('/stock/skus/:id/count', requireAuth, requireRole(...WRITE_ROLES), async (req: AuthedRequest, res) => {
  const p = idParam.safeParse(req.params)
  const body = CountInput.safeParse(req.body)
  if (!p.success) { refuse(res, 404, { error: 'sku_not_found', message: 'ไม่พบอะไหล่นี้' }); return }
  if (!body.success) { badRequest(res, body.error, 'ข้อมูลการตั้งยอดไม่ถูกต้อง'); return }
  const auth = req.auth!
  try {
    const r = await withShopStock(db, auth.shop, async (trx) => {
      const done = await svc.countSku(trx, auth.shop, { id: auth.sub, role: auth.role }, p.data.id, body.data)
      return done.ok ? { ok: true as const, change: done.value, sku: await skuRowOf(trx, p.data.id, auth.role) } : done
    })
    if (!r.ok) { sendStockError(res, r.error); return }
    res.status(r.change.replayed ? 200 : 201).json(StockChangeResult.parse({ ...r.change, sku: r.sku }))
  } catch (err) { sendPgError(res, err) }
})

stockRouter.post('/stock/skus/:id/adjust', requireAuth, requireRole(...WRITE_ROLES), async (req: AuthedRequest, res) => {
  const p = idParam.safeParse(req.params)
  const body = AdjustInput.safeParse(req.body)
  if (!p.success) { refuse(res, 404, { error: 'sku_not_found', message: 'ไม่พบอะไหล่นี้' }); return }
  if (!body.success) { badRequest(res, body.error, 'ข้อมูลการปรับยอดไม่ถูกต้อง'); return }
  const auth = req.auth!
  try {
    const r = await withShopStock(db, auth.shop, async (trx) => {
      const done = await svc.adjustSku(trx, auth.shop, { id: auth.sub, role: auth.role }, p.data.id, body.data)
      return done.ok ? { ok: true as const, change: done.value, sku: await skuRowOf(trx, p.data.id, auth.role) } : done
    })
    if (!r.ok) { sendStockError(res, r.error); return }
    res.status(r.change.replayed ? 200 : 201).json(StockChangeResult.parse({ ...r.change, sku: r.sku }))
  } catch (err) { sendPgError(res, err) }
})

stockRouter.get('/stock/low', requireAuth, requireRole(...READ_ROLES), async (req: AuthedRequest, res) => {
  const q = LowStockQuery.safeParse(req.query)
  if (!q.success) { badRequest(res, q.error, 'ตัวกรองไม่ถูกต้อง'); return }
  const auth = req.auth!
  const { rows, total } = await withShop(db, auth.shop, (trx) => stockRepo.listLowStock(trx, { q: q.data.q, category: q.data.category }, q.data.limit, q.data.offset))
  res.json(SkuPage.parse({ items: rows.map((r) => skuView(r, auth.role)), total }))
})

stockRouter.get('/stock/skus/:id/card', requireAuth, requireRole(...READ_ROLES), async (req: AuthedRequest, res) => {
  const p = idParam.safeParse(req.params)
  const q = CardQuery.safeParse(req.query)
  if (!p.success) { refuse(res, 404, { error: 'sku_not_found', message: 'ไม่พบอะไหล่นี้' }); return }
  if (!q.success) { badRequest(res, q.error, 'ตัวกรองไม่ถูกต้อง'); return }
  const auth = req.auth!
  const out = await withShop(db, auth.shop, async (trx) => {
    const sku = await stockRepo.getSku(trx, p.data.id)
    if (!sku) return null
    return { sku, moves: await stockRepo.listMoves(trx, p.data.id, q.data.type, q.data.limit, q.data.offset) }
  })
  if (!out) { refuse(res, 404, { error: 'sku_not_found', message: 'ไม่พบอะไหล่นี้' }); return }
  res.json(StockCard.parse({
    sku: skuView(out.sku, auth.role),
    moves: { items: out.moves.rows.map((m) => moveView(m, auth.role)), total: out.moves.total },
  }))
})

// ---------------------------------------------------------------------------
// Per job: what to pull, and the pull
// ---------------------------------------------------------------------------

stockRouter.get('/jobs/:jobId/stock', requireAuth, requireRole(...READ_ROLES), async (req: AuthedRequest, res) => {
  const p = jobParam.safeParse(req.params)
  if (!p.success) { refuse(res, 404, { error: 'job_not_found', message: 'ไม่พบงานนี้' }); return }
  const auth = req.auth!
  const out = await withShop(db, auth.shop, async (trx) => {
    const job = await trx.selectFrom('jobs').select('id').where('id', '=', p.data.jobId).where('deleted_at', 'is', null).executeTakeFirst()
    return job ? reservation.buildJobStock(trx, p.data.jobId) : null
  })
  if (!out) { refuse(res, 404, { error: 'job_not_found', message: 'ไม่พบงานนี้' }); return }
  res.json(JobStock.parse(out))
})

stockRouter.post('/jobs/:jobId/stock/issue', requireAuth, requireRole(...ISSUE_ROLES), async (req: AuthedRequest, res) => {
  const p = jobParam.safeParse(req.params)
  const body = StockIssueInput.safeParse(req.body)
  if (!p.success) { refuse(res, 404, { error: 'job_not_found', message: 'ไม่พบงานนี้' }); return }
  if (!body.success) { badRequest(res, body.error, 'ข้อมูลการเบิกไม่ถูกต้อง'); return }
  if (new Set(body.data.lines.map((l) => l.lineId)).size !== body.data.lines.length) {
    refuse(res, 400, { error: 'duplicate_lines', message: 'มีบรรทัดซ้ำในคำขอ' }); return
  }
  const auth = req.auth!
  try {
    const r = await withShopStock(db, auth.shop, async (trx) => {
      const done = await reservation.issueForJob(trx, { shopId: auth.shop, jobId: p.data.jobId, actorId: auth.sub }, body.data)
      return done.ok ? { ok: true as const, outcome: done.value, jobStock: await reservation.buildJobStock(trx, p.data.jobId) } : done
    })
    if (!r.ok) { sendIssueError(res, r.error); return }
    res.status(r.outcome.replayed ? 200 : 201).json(StockIssueResult.parse({ replayed: r.outcome.replayed, issued: r.outcome.issued, jobStock: r.jobStock }))
  } catch (err) { sendPgError(res, err) }
})

// ---------------------------------------------------------------------------
// Reports and the catalog link
// ---------------------------------------------------------------------------

stockRouter.get('/stock/unbound-lines', requireAuth, requireRole(...WRITE_ROLES), async (req: AuthedRequest, res) => {
  const q = UnboundLinesQuery.safeParse(req.query)
  if (!q.success) { badRequest(res, q.error, 'ตัวกรองไม่ถูกต้อง'); return }
  const auth = req.auth!
  const { rows, total } = await withShop(db, auth.shop, (trx) => stockRepo.unboundPartLines(trx, q.data.limit, q.data.offset))
  res.json(UnboundLinePage.parse({
    items: rows.map((r) => ({
      lineId: r.line_id, documentId: r.document_id, documentNumber: r.document_number, documentStatus: r.document_status,
      jobId: r.job_id, jobNumber: r.job_number, name: r.name, qty: r.qty,
      approvalStatus: r.approval_status, catalogItemId: r.catalog_item_id,
    })),
    total,
  }))
})

function linkView(r: stockRepo.CatalogLinkRecord) {
  return { id: r.id, category: r.category, name: r.name, isSet: r.is_set, skuId: r.sku_id, skuCode: r.sku_code, skuName: r.sku_name }
}

stockRouter.get('/stock/catalog-links', requireAuth, requireRole(...WRITE_ROLES), async (req: AuthedRequest, res) => {
  const q = CatalogLinksQuery.safeParse(req.query)
  if (!q.success) { badRequest(res, q.error, 'ตัวกรองไม่ถูกต้อง'); return }
  const auth = req.auth!
  const { rows, total } = await withShop(db, auth.shop, (trx) => stockRepo.listCatalogLinks(trx, { q: q.data.q, bound: q.data.bound }, q.data.limit, q.data.offset))
  res.json(CatalogLinkPage.parse({ items: rows.map(linkView), total }))
})

async function sendLink(res: Response, shop: string, itemId: string, status: number): Promise<void> {
  const row = await withShop(db, shop, (trx) => stockRepo.getCatalogLink(trx, itemId))
  if (!row) { refuse(res, 404, { error: 'catalog_item_not_found', message: 'ไม่พบรายการนี้ในแคตตาล็อก' }); return }
  res.status(status).json(CatalogLinkRow.parse(linkView(row)))
}

stockRouter.put('/stock/catalog-items/:itemId/sku', requireAuth, requireRole(...WRITE_ROLES), async (req: AuthedRequest, res) => {
  const p = itemParam.safeParse(req.params)
  const body = CatalogBindInput.safeParse(req.body)
  if (!p.success) { refuse(res, 404, { error: 'catalog_item_not_found', message: 'ไม่พบรายการนี้ในแคตตาล็อก' }); return }
  if (!body.success) { badRequest(res, body.error, 'ข้อมูลไม่ถูกต้อง'); return }
  const auth = req.auth!
  try {
    const r = await withShopStock(db, auth.shop, (trx) => svc.bindCatalogItem(trx, auth.shop, { id: auth.sub, role: auth.role }, p.data.itemId, body.data.skuId))
    if (!r.ok) { sendStockError(res, r.error); return }
    await sendLink(res, auth.shop, p.data.itemId, 200)
  } catch (err) { sendPgError(res, err) }
})

stockRouter.delete('/stock/catalog-items/:itemId/sku', requireAuth, requireRole(...WRITE_ROLES), async (req: AuthedRequest, res) => {
  const p = itemParam.safeParse(req.params)
  if (!p.success) { refuse(res, 404, { error: 'catalog_item_not_found', message: 'ไม่พบรายการนี้ในแคตตาล็อก' }); return }
  const auth = req.auth!
  try {
    const r = await withShopStock(db, auth.shop, (trx) => svc.unbindCatalogItem(trx, auth.shop, { id: auth.sub, role: auth.role }, p.data.itemId))
    if (!r.ok) { sendStockError(res, r.error); return }
    await sendLink(res, auth.shop, p.data.itemId, 200)
  } catch (err) { sendPgError(res, err) }
})

stockRouter.post('/stock/catalog-items/:itemId/sku/create', requireAuth, requireRole(...WRITE_ROLES), async (req: AuthedRequest, res) => {
  const p = itemParam.safeParse(req.params)
  const body = CatalogCreateSkuInput.safeParse(req.body)
  if (!p.success) { refuse(res, 404, { error: 'catalog_item_not_found', message: 'ไม่พบรายการนี้ในแคตตาล็อก' }); return }
  if (!body.success) { badRequest(res, body.error, 'ข้อมูลอะไหล่ไม่ถูกต้อง'); return }
  const auth = req.auth!
  try {
    const r = await withShopStock(db, auth.shop, (trx) => svc.createSkuFromCatalogItem(trx, auth.shop, { id: auth.sub, role: auth.role }, p.data.itemId, body.data))
    if (!r.ok) { sendStockError(res, r.error); return }
    await sendLink(res, auth.shop, p.data.itemId, 201)
  } catch (err) {
    if ((err as { constraint?: string }).constraint === 'uq_skus_code') {
      const existing = await withShop(db, auth.shop, (trx) => stockRepo.getSkuByCode(trx, body.data.code))
      if (existing) { sendStockError(res, { code: 'sku_code_exists', skuId: existing.id }); return }
    }
    sendPgError(res, err)
  }
})

// The owner's daily "manual stock adjustments" list. Answers on a day with nothing too: no entries IS the report.
stockRouter.get('/stock/adjustments', requireAuth, requireRole(...REPORT_ROLES), async (req: AuthedRequest, res) => {
  const q = AdjustmentsQuery.safeParse(req.query)
  if (!q.success) { badRequest(res, q.error, 'วันที่ไม่ถูกต้อง'); return }
  const date = q.data.date ?? bangkokToday()
  if (Number.isNaN(Date.parse(`${date}T00:00:00+07:00`))) { badRequest(res, new z.ZodError([{ code: 'custom', path: ['date'], message: 'invalid_date' }]), 'วันที่ไม่ถูกต้อง'); return }
  const auth = req.auth!
  const rows = await withShop(db, auth.shop, (trx) => stockRepo.manualMovesBetween(trx, startOfDay(date), startOfDay(addDays(date, 1))))
  const items = rows.map((r) => {
    const delta = toQtyCenti(r.qty)
    return {
      moveId: r.id, at: r.created_at.toISOString(), kind: r.type as 'adjustment' | 'count',
      sku: { id: r.sku_id, code: r.sku_code, name: r.sku_name },
      before: r.on_hand_after === null ? null : formatQty(toQtyCenti(r.on_hand_after) - delta),
      after: r.on_hand_after ?? '0.00', delta: r.qty, reason: r.reason,
      user: r.user_id ? { id: r.user_id, name: r.user_name } : null,
    }
  })
  res.json(DailyAdjustments.parse({
    date, items, adjustments: items.filter((i) => i.kind === 'adjustment').length, counts: items.filter((i) => i.kind === 'count').length,
  }))
})

// Replays the ledger per SKU and reports every disagreement with the balance cache. Read-only.
stockRouter.get('/stock/integrity', requireAuth, requireRole(...REPORT_ROLES), async (req: AuthedRequest, res) => {
  const auth = req.auth!
  const r = await withShop(db, auth.shop, (trx) => stockRepo.integrityDrift(trx))
  res.json(IntegrityReport.parse({
    checkedSkus: r.checked,
    ok: r.drift.length === 0,
    drift: r.drift.map((d) => ({
      skuId: d.sku_id, code: d.code, name: d.name, ledgerOnHand: d.ledger_on_hand, balanceOnHand: d.balance_on_hand,
      ledgerReserved: d.ledger_reserved, balanceReserved: d.balance_reserved,
    })),
  }))
})
