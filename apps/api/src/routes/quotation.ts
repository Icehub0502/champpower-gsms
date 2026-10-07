/**
 * Quotation + per-line approval (P3.1).
 *
 *   POST   /api/jobs/:jobId/quotation
 *   GET    /api/jobs/:jobId/quotation
 *   PATCH  /api/jobs/:jobId/quotation
 *   POST   /api/jobs/:jobId/quotation/lines
 *   PATCH  /api/jobs/:jobId/quotation/lines/:lineId
 *   DELETE /api/jobs/:jobId/quotation/lines/:lineId
 *   POST   /api/jobs/:jobId/quotation/issue
 *   PATCH  /api/jobs/:jobId/quotation/lines/:lineId/decision
 *   POST   /api/jobs/:jobId/quotation/confirm
 *   POST   /api/jobs/:jobId/quotation/confirm/undo
 *   POST   /api/jobs/:jobId/quotation/revise
 *   POST   /api/jobs/:jobId/quotation/void
 *   GET    /api/vehicles/:vehicleId/offered-items
 *   GET    /api/jobs/:jobId/work-order
 *
 * Every route reads the live quotation via the job, not a bare document id in
 * the URL, EXCEPT the line/decision/issue/confirm/etc. sub-routes, which also
 * take the job id so the route can always re-resolve "the live quotation of
 * THIS job" — the RLS-scoped, uq_live_quotation_per_job-guaranteed anchor —
 * rather than trust a document id the client could have for another job.
 *
 * advisor never receives a cost field: there is none to receive (CLAUDE.md
 * §12.2) — the catalog carries no cost column at all.
 */
import { z } from 'zod'
import { withShop } from '@gsms/db/client.js'
import {
  AddLineInput, ConfirmInput, ConfirmResult, CreateQuotationInput, DecideLineInput, OfferedItemPage,
  OfferedItemQuery, PatchLineInput, PatchQuotationInput, Quotation, ReviseInput,
  UndoConfirmInput, VoidInput, WorkOrder, type DocumentSeriesMissingError, type InvalidRequestError,
} from '@gsms/contracts/index.js'
import { db } from '../lib/db.js'
import { requireAuth, requireRole, type AuthedRequest } from '../middleware/requireAuth.js'
import { asyncRouter } from '../middleware/asyncHandler.js'
import { fieldErrorsOf } from '../lib/fieldErrors.js'
import { isCatalogNameConflict, sendPgError } from '../lib/pgError.js'
import * as catalogRepo from '../repositories/catalog.js'
import { BOARD_READ_ROLES, INTAKE_WRITE_ROLES } from './queue.js'
import * as quotationSvc from '../services/quotation.js'
import * as quotationRepo from '../repositories/quotation.js'
import { buildQuotationView } from '../services/quotationView.js'

export const quotationRouter = asyncRouter()

const OWNER_ONLY = ['owner'] as const
// Quotations and offered items carry selling prices; the technician sees no money (CLAUDE.md §12.1) — he has the work order instead.
const PRICE_READ_ROLES = BOARD_READ_ROLES.filter((r) => r !== 'technician')

const jobIdParam = z.object({ jobId: z.string().uuid() })
const lineParams = z.object({ jobId: z.string().uuid(), lineId: z.string().uuid() })

function badRequest(res: import('express').Response, error: import('zod').ZodError, message: string): void {
  const body: InvalidRequestError = { error: 'invalid_request', message, fields: fieldErrorsOf(error) }
  res.status(400).json(body)
}

/** Every QuotationError the service can return, mapped to its exact status + contract body. */
function sendServiceError(res: import('express').Response, error: quotationSvc.QuotationError): void {
  switch (error.code) {
    case 'job_not_found': res.status(404).json({ error: 'job_not_found', message: 'ไม่พบงานนี้' }); return
    case 'quotation_not_found': res.status(404).json({ error: 'quotation_not_found', message: 'ไม่พบใบเสนอราคานี้' }); return
    case 'quotation_line_not_found': res.status(404).json({ error: 'quotation_line_not_found', message: 'ไม่พบบรรทัดนี้' }); return
    case 'catalog_item_not_found': res.status(404).json({ error: 'catalog_item_not_found', message: 'ไม่พบรายการนี้ในแคตตาล็อก' }); return
    case 'offered_item_not_found': res.status(404).json({ error: 'offered_item_not_found', message: 'ไม่พบรายการที่เคยเสนอไว้' }); return
    case 'quotation_exists': res.status(409).json({ error: 'quotation_exists', message: 'งานนี้มีใบเสนอราคาที่ยังไม่ปิดอยู่แล้ว' }); return
    case 'quotation_not_draft': res.status(409).json({ error: 'quotation_not_draft', message: 'ใบเสนอราคานี้ออกเลขแล้ว แก้เนื้อหาไม่ได้' }); return
    case 'quotation_not_issued': res.status(409).json({ error: 'quotation_not_issued', message: 'ใบเสนอราคานี้ไม่ได้อยู่ในสถานะที่ทำรายการนี้ได้' }); return
    case 'quotation_frozen': res.status(409).json({ error: 'quotation_frozen', message: 'ใบเสนอราคานี้ถูกปิดแล้ว' }); return
    case 'quotation_empty': res.status(409).json({ error: 'quotation_empty', message: 'ยังไม่มีรายการในใบเสนอราคา' }); return
    case 'decline_reason_required': res.status(400).json({ error: 'invalid_request', message: 'กรุณาเลือกเหตุผลที่ปฏิเสธ', fields: { reason: ['required'] } }); return
    case 'decline_note_required': res.status(400).json({ error: 'invalid_request', message: 'กรุณาพิมพ์เหตุผลเพิ่มเติม', fields: { note: ['required'] } }); return
    case 'decisions_incomplete': res.status(409).json({ error: 'decisions_incomplete', message: 'ยังมีบรรทัดที่ลูกค้ายังไม่ตัดสินใจ', lineIds: error.lineIds }); return
    case 'set_amount_required': res.status(409).json({ error: 'set_amount_required', message: 'ชุดที่ตัดบางรายการออกต้องกรอกยอดใหม่ก่อนยืนยัน', lineIds: error.lineIds }); return
    case 'approved_amount_not_allowed': res.status(400).json({ error: 'approved_amount_not_allowed', message: 'บรรทัดนี้ไม่ต้องกรอกยอดใหม่', lineId: error.lineId }); return
    case 'amount_over_2x': res.status(422).json({ error: 'amount_over_2x', message: 'ยอดนี้เกิน 2 เท่าของราคาที่เสนอ น่าจะพิมพ์ผิด ถ้าตั้งใจจริงให้ออกใบเสนอราคาฉบับใหม่', lineId: error.lineId, offered: error.offered, max: error.max }); return
    case 'amount_above_offer_free_set': res.status(422).json({ error: 'amount_above_offer_free_set', message: 'ชุดนี้เสนอไว้ที่ 0 บาท จะเพิ่มราคาต้องออกใบเสนอราคาฉบับใหม่', lineId: error.lineId }); return
    case 'undo_confirm_different_day': res.status(409).json({ error: 'undo_confirm_different_day', message: 'ถอยการยืนยันได้แค่วันเดียวกันเท่านั้น' }); return
    case 'undo_confirm_job_moved_on': res.status(409).json({ error: 'undo_confirm_job_moved_on', message: 'งานนี้ไปขั้นตอนต่อไปแล้ว ถอยการยืนยันไม่ได้' }); return
    case 'quotation_confirmed': res.status(409).json({ error: 'quotation_confirmed', message: 'ใบเสนอราคานี้ยืนยันผลแล้ว ต้องถอยการยืนยันหรือออกฉบับใหม่' }); return
    case 'warranty_term_not_found': res.status(404).json({ error: 'warranty_term_not_found', message: 'ไม่พบเงื่อนไขการรับประกันนี้' }); return
    case 'catalog_item_exists': res.status(409).json({ error: 'catalog_item_exists', message: 'มีรายการชื่อนี้ในหมวดนี้อยู่แล้ว', itemId: error.itemId }); return
    case 'similar_item_found': res.status(409).json({ error: 'similar_item_found', message: 'มีรายการที่ชื่อคล้ายกันอยู่แล้ว', similar: error.similar }); return
  }
}

async function loadView(jobId: string, auth: AuthedRequest['auth']) {
  return withShop(db, auth!.shop, async (trx) => {
    const doc = await quotationRepo.findLiveQuotation(trx, jobId)
    if (!doc) return null
    const lines = await quotationRepo.getLines(trx, doc.id)
    const job = doc.job_id ? await quotationRepo.jobWithVehicle(trx, doc.job_id) : undefined
    return buildQuotationView(doc, lines, job?.status ?? null)
  })
}

async function loadViewByDocument(documentId: string, auth: AuthedRequest['auth']) {
  return withShop(db, auth!.shop, async (trx) => {
    const doc = await quotationRepo.getDocument(trx, documentId)
    if (!doc) return null
    const lines = await quotationRepo.getLines(trx, doc.id)
    const job = doc.job_id ? await quotationRepo.jobWithVehicle(trx, doc.job_id) : undefined
    return buildQuotationView(doc, lines, job?.status ?? null)
  })
}

// ---------------------------------------------------------------------------
// POST /api/jobs/:jobId/quotation
// ---------------------------------------------------------------------------
quotationRouter.post(
  '/jobs/:jobId/quotation',
  requireAuth, requireRole(...INTAKE_WRITE_ROLES),
  async (req: AuthedRequest, res) => {
    const params = jobIdParam.safeParse(req.params)
    const body = CreateQuotationInput.safeParse(req.body)
    if (!params.success || !body.success) { res.status(400).json({ error: 'invalid_request' }); return }
    const auth = req.auth!
    const result = await withShop(db, auth.shop, (trx) => quotationSvc.createDraft(trx, auth.shop, params.data.jobId))
    if (!result.ok) { sendServiceError(res, result.error); return }
    const view = await loadView(params.data.jobId, auth)
    res.status(201).json(Quotation.parse(view))
  },
)

// ---------------------------------------------------------------------------
// GET /api/jobs/:jobId/quotation
// ---------------------------------------------------------------------------
quotationRouter.get(
  '/jobs/:jobId/quotation',
  requireAuth, requireRole(...PRICE_READ_ROLES),
  async (req: AuthedRequest, res) => {
    const params = jobIdParam.safeParse(req.params)
    if (!params.success) { res.status(404).json({ error: 'quotation_not_found' }); return }
    const view = await loadView(params.data.jobId, req.auth)
    if (!view) { res.status(404).json({ error: 'quotation_not_found', message: 'ไม่พบใบเสนอราคานี้' }); return }
    res.json(Quotation.parse(view))
  },
)

// ---------------------------------------------------------------------------
// PATCH /api/jobs/:jobId/quotation  (draft discount only)
// ---------------------------------------------------------------------------
quotationRouter.patch(
  '/jobs/:jobId/quotation',
  requireAuth, requireRole(...INTAKE_WRITE_ROLES),
  async (req: AuthedRequest, res) => {
    const params = jobIdParam.safeParse(req.params)
    const body = PatchQuotationInput.safeParse(req.body)
    if (!params.success) { res.status(404).json({ error: 'quotation_not_found' }); return }
    if (!body.success) { badRequest(res, body.error, 'ส่วนลดไม่ถูกต้อง'); return }
    const auth = req.auth!
    const result = await withShop(db, auth.shop, async (trx) => {
      const doc = await quotationRepo.findLiveQuotation(trx, params.data.jobId)
      if (!doc) return { ok: false as const, error: { code: 'quotation_not_found' as const } }
      return quotationSvc.patchDraft(trx, doc.id, body.data.discount)
    })
    if (!result.ok) { sendServiceError(res, result.error); return }
    const view = await loadView(params.data.jobId, auth)
    res.json(Quotation.parse(view))
  },
)

// ---------------------------------------------------------------------------
// POST /api/jobs/:jobId/quotation/lines
// ---------------------------------------------------------------------------
quotationRouter.post(
  '/jobs/:jobId/quotation/lines',
  requireAuth, requireRole(...INTAKE_WRITE_ROLES),
  async (req: AuthedRequest, res) => {
    const params = jobIdParam.safeParse(req.params)
    const body = AddLineInput.safeParse(req.body)
    if (!params.success) { res.status(404).json({ error: 'quotation_not_found' }); return }
    if (!body.success) { badRequest(res, body.error, 'ข้อมูลรายการไม่ถูกต้อง'); return }
    const auth = req.auth!
    try {
      const result = await withShop(db, auth.shop, async (trx) => {
        const doc = await quotationRepo.findLiveQuotation(trx, params.data.jobId)
        if (!doc) return { ok: false as const, error: { code: 'quotation_not_found' as const } }
        return quotationSvc.addLine(trx, auth.shop, doc.id, auth.sub, body.data)
      })
      if (!result.ok) { sendServiceError(res, result.error); return }
      const view = await loadView(params.data.jobId, auth)
      res.status(201).json(Quotation.parse(view))
    } catch (err) {
      // A free-text line that adds to the catalog can lose the name race too (same 409 as POST /catalog/items).
      if (isCatalogNameConflict(err) && body.data.kind === 'free' && body.data.category) {
        const { category, name } = body.data
        const winner = await withShop(db, auth.shop, (trx) => catalogRepo.findItemByKeys(trx, category, name))
        if (winner) { res.status(409).json({ error: 'catalog_item_exists', message: 'มีรายการชื่อนี้ในหมวดนี้อยู่แล้ว', itemId: winner.id }); return }
      }
      sendPgError(res, err)
    }
  },
)

// ---------------------------------------------------------------------------
// PATCH /api/jobs/:jobId/quotation/lines/:lineId
// ---------------------------------------------------------------------------
quotationRouter.patch(
  '/jobs/:jobId/quotation/lines/:lineId',
  requireAuth, requireRole(...INTAKE_WRITE_ROLES),
  async (req: AuthedRequest, res) => {
    const params = lineParams.safeParse(req.params)
    const body = PatchLineInput.safeParse(req.body)
    if (!params.success) { res.status(404).json({ error: 'quotation_line_not_found' }); return }
    if (!body.success) { badRequest(res, body.error, 'ข้อมูลที่แก้ไม่ถูกต้อง'); return }
    const auth = req.auth!
    const result = await withShop(db, auth.shop, async (trx) => {
      const doc = await quotationRepo.findLiveQuotation(trx, params.data.jobId)
      if (!doc) return { ok: false as const, error: { code: 'quotation_not_found' as const } }
      return quotationSvc.patchLine(trx, doc.id, params.data.lineId, {
        nameSnapshot: body.data.name, brandSnapshot: body.data.brand, lineType: body.data.lineType,
        qty: body.data.qty, unit: body.data.unit, unitPrice: body.data.unitPrice,
        isVatable: body.data.isVatable, sortOrder: body.data.sortOrder,
      })
    })
    if (!result.ok) { sendServiceError(res, result.error); return }
    const view = await loadView(params.data.jobId, auth)
    res.json(Quotation.parse(view))
  },
)

// ---------------------------------------------------------------------------
// DELETE /api/jobs/:jobId/quotation/lines/:lineId
// ---------------------------------------------------------------------------
quotationRouter.delete(
  '/jobs/:jobId/quotation/lines/:lineId',
  requireAuth, requireRole(...INTAKE_WRITE_ROLES),
  async (req: AuthedRequest, res) => {
    const params = lineParams.safeParse(req.params)
    if (!params.success) { res.status(404).json({ error: 'quotation_line_not_found' }); return }
    const auth = req.auth!
    const result = await withShop(db, auth.shop, async (trx) => {
      const doc = await quotationRepo.findLiveQuotation(trx, params.data.jobId)
      if (!doc) return { ok: false as const, error: { code: 'quotation_not_found' as const } }
      return quotationSvc.removeLine(trx, doc.id, params.data.lineId)
    })
    if (!result.ok) { sendServiceError(res, result.error); return }
    const view = await loadView(params.data.jobId, auth)
    res.json(Quotation.parse(view))
  },
)

// ---------------------------------------------------------------------------
// POST /api/jobs/:jobId/quotation/issue
// ---------------------------------------------------------------------------
quotationRouter.post(
  '/jobs/:jobId/quotation/issue',
  requireAuth, requireRole(...INTAKE_WRITE_ROLES),
  async (req: AuthedRequest, res) => {
    const params = jobIdParam.safeParse(req.params)
    if (!params.success) { res.status(404).json({ error: 'quotation_not_found' }); return }
    const auth = req.auth!
    try {
      const result = await withShop(db, auth.shop, async (trx) => {
        const doc = await quotationRepo.findLiveQuotation(trx, params.data.jobId)
        if (!doc) return { ok: false as const, error: { code: 'quotation_not_found' as const } }
        return quotationSvc.issue(trx, auth.shop, doc.id, auth.sub)
      })
      if (!result.ok) { sendServiceError(res, result.error); return }
      const view = await loadView(params.data.jobId, auth)
      res.json(Quotation.parse(view))
    } catch (err) {
      // GS001 from allocate_document_number: this shop has no active QUO series.
      // Mapped on err.code only, and only here, so job numbers keep their own mapping.
      if ((err as { code?: string }).code === 'GS001') {
        const body: DocumentSeriesMissingError = { error: 'document_series_missing', message: 'ยังไม่ได้ตั้งค่าชุดเลขที่ใบเสนอราคา (QUO) กรุณาตั้งค่าในหน้าตั้งค่าก่อนออกใบ' }
        res.status(409).json(body)
        return
      }
      sendPgError(res, err)
    }
  },
)

// ---------------------------------------------------------------------------
// PATCH /api/jobs/:jobId/quotation/lines/:lineId/decision
// ---------------------------------------------------------------------------
quotationRouter.patch(
  '/jobs/:jobId/quotation/lines/:lineId/decision',
  requireAuth, requireRole(...INTAKE_WRITE_ROLES),
  async (req: AuthedRequest, res) => {
    const params = lineParams.safeParse(req.params)
    const body = DecideLineInput.safeParse(req.body)
    if (!params.success) { res.status(404).json({ error: 'quotation_line_not_found' }); return }
    if (!body.success) { badRequest(res, body.error, 'ข้อมูลการตัดสินใจไม่ถูกต้อง'); return }
    const auth = req.auth!
    const result = await withShop(db, auth.shop, async (trx) => {
      const doc = await quotationRepo.findLiveQuotation(trx, params.data.jobId)
      if (!doc) return { ok: false as const, error: { code: 'quotation_not_found' as const } }
      return quotationSvc.decideLine(trx, doc.id, params.data.lineId, body.data, auth.sub)
    })
    if (!result.ok) { sendServiceError(res, result.error); return }
    const view = await loadView(params.data.jobId, auth)
    res.json(Quotation.parse(view))
  },
)

// ---------------------------------------------------------------------------
// POST /api/jobs/:jobId/quotation/confirm
// ---------------------------------------------------------------------------
quotationRouter.post(
  '/jobs/:jobId/quotation/confirm',
  requireAuth, requireRole(...INTAKE_WRITE_ROLES),
  async (req: AuthedRequest, res) => {
    const params = jobIdParam.safeParse(req.params)
    const body = ConfirmInput.safeParse(req.body)
    if (!params.success) { res.status(404).json({ error: 'quotation_not_found' }); return }
    if (!body.success) { badRequest(res, body.error, 'ข้อมูลการยืนยันไม่ถูกต้อง'); return }
    const auth = req.auth!
    const result = await withShop(db, auth.shop, async (trx) => {
      const doc = await quotationRepo.findLiveQuotation(trx, params.data.jobId)
      if (!doc) return { ok: false as const, error: { code: 'quotation_not_found' as const } }
      return quotationSvc.confirm(trx, auth.shop, doc.id, body.data.adjustments, auth.sub)
    })
    if (!result.ok) { sendServiceError(res, result.error); return }
    const view = await loadView(params.data.jobId, auth)
    res.json(ConfirmResult.parse({ ...view, jobStatusUnchanged: result.value.jobStatusUnchanged }))
  },
)

// ---------------------------------------------------------------------------
// POST /api/jobs/:jobId/quotation/confirm/undo
// ---------------------------------------------------------------------------
quotationRouter.post(
  '/jobs/:jobId/quotation/confirm/undo',
  requireAuth, requireRole(...INTAKE_WRITE_ROLES),
  async (req: AuthedRequest, res) => {
    const params = jobIdParam.safeParse(req.params)
    const body = UndoConfirmInput.safeParse(req.body)
    if (!params.success) { res.status(404).json({ error: 'quotation_not_found' }); return }
    if (!body.success) { badRequest(res, body.error, 'กรุณาระบุเหตุผล'); return }
    const auth = req.auth!
    const result = await withShop(db, auth.shop, async (trx) => {
      const doc = await quotationRepo.findLiveQuotation(trx, params.data.jobId)
      if (!doc) return { ok: false as const, error: { code: 'quotation_not_found' as const } }
      return quotationSvc.undoConfirm(trx, auth.shop, doc.id, body.data.reason, auth.sub)
    })
    if (!result.ok) { sendServiceError(res, result.error); return }
    const view = await loadView(params.data.jobId, auth)
    res.json(Quotation.parse(view))
  },
)

// ---------------------------------------------------------------------------
// POST /api/jobs/:jobId/quotation/revise
// ---------------------------------------------------------------------------
quotationRouter.post(
  '/jobs/:jobId/quotation/revise',
  requireAuth, requireRole(...INTAKE_WRITE_ROLES),
  async (req: AuthedRequest, res) => {
    const params = jobIdParam.safeParse(req.params)
    const body = ReviseInput.safeParse(req.body)
    if (!params.success) { res.status(404).json({ error: 'quotation_not_found' }); return }
    if (!body.success) { badRequest(res, body.error, 'ข้อมูลไม่ถูกต้อง'); return }
    const auth = req.auth!
    try {
      const result = await withShop(db, auth.shop, async (trx) => {
        const doc = await quotationRepo.findLiveQuotation(trx, params.data.jobId)
        if (!doc) return { ok: false as const, error: { code: 'quotation_not_found' as const } }
        return quotationSvc.revise(trx, auth.shop, doc.id, auth.sub, body.data.reason)
      })
      if (!result.ok) { sendServiceError(res, result.error); return }
      const view = await loadView(params.data.jobId, auth)
      res.status(201).json(Quotation.parse(view))
    } catch (err) {
      sendPgError(res, err)
    }
  },
)

// ---------------------------------------------------------------------------
// POST /api/jobs/:jobId/quotation/void  (owner only)
// ---------------------------------------------------------------------------
quotationRouter.post(
  '/jobs/:jobId/quotation/void',
  requireAuth, requireRole(...OWNER_ONLY),
  async (req: AuthedRequest, res) => {
    const params = jobIdParam.safeParse(req.params)
    const body = VoidInput.safeParse(req.body)
    if (!params.success) { res.status(404).json({ error: 'quotation_not_found' }); return }
    if (!body.success) { badRequest(res, body.error, 'กรุณาระบุเหตุผล'); return }
    const auth = req.auth!
    const result = await withShop(db, auth.shop, async (trx) => {
      const doc = await quotationRepo.findLiveQuotation(trx, params.data.jobId)
      if (!doc) return { ok: false as const, error: { code: 'quotation_not_found' as const } }
      return quotationSvc.voidQuotation(trx, auth.shop, doc.id, body.data.reason, auth.sub)
    })
    if (!result.ok) { sendServiceError(res, result.error); return }
    const view = await loadViewByDocument(result.value.id, auth)
    res.json(Quotation.parse(view))
  },
)

// ---------------------------------------------------------------------------
// GET /api/vehicles/:vehicleId/offered-items
// ---------------------------------------------------------------------------
quotationRouter.get(
  '/vehicles/:vehicleId/offered-items',
  requireAuth, requireRole(...PRICE_READ_ROLES),
  async (req: AuthedRequest, res) => {
    const params = z.object({ vehicleId: z.string().uuid() }).safeParse(req.params)
    const query = OfferedItemQuery.safeParse(req.query)
    if (!params.success || !query.success) { res.status(400).json({ error: 'invalid_request' }); return }
    const auth = req.auth!
    const { rows, total } = await withShop(db, auth.shop, (trx) =>
      quotationRepo.listOfferedItems(trx, params.data.vehicleId, query.data.limit, query.data.offset))
    res.json(OfferedItemPage.parse({
      items: rows.map((r) => ({
        id: r.id, name: r.name, offeredAt: r.offered_at.toISOString(), lineType: r.line_type,
        catalogItemId: r.catalog_item_id, unitPrice: r.unit_price, qty: r.qty,
      })),
      total,
    }))
  },
)

// ---------------------------------------------------------------------------
// GET /api/jobs/:jobId/work-order — technician-visible, no prices, no number.
// ---------------------------------------------------------------------------
quotationRouter.get(
  '/jobs/:jobId/work-order',
  requireAuth, requireRole(...BOARD_READ_ROLES),
  async (req: AuthedRequest, res) => {
    const params = jobIdParam.safeParse(req.params)
    if (!params.success) { res.status(404).json({ error: 'job_not_found' }); return }
    const auth = req.auth!
    const result = await withShop(db, auth.shop, (trx) => quotationSvc.workOrder(trx, params.data.jobId))
    if (!result.ok) { sendServiceError(res, result.error); return }
    const { job, lines } = result.value
    res.json(WorkOrder.parse({
      jobId: job.id,
      jobNumber: job.job_number,
      plate: job.plate,
      province: job.province,
      brand: job.brand,
      model: job.model,
      lines: lines.map((l) => ({
        id: l.id, parentLineId: l.parent_line_id, sortOrder: l.sort_order, lineType: l.line_type,
        name: l.name_snapshot, brand: l.brand_snapshot, qty: l.qty, unit: l.unit, warrantyName: l.warranty_name,
      })),
    }))
  },
)
