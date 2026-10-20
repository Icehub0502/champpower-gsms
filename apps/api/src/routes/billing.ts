/**
 * Billing (P3.2): the receipt, the print history, the tax-invoice flag, the daily
 * summary and the cash count.
 *
 *   POST  /api/jobs/:jobId/receipt                 build the draft from the confirmed quotation
 *   GET   /api/jobs/:jobId/receipt
 *   POST  /api/jobs/:jobId/receipt/rebuild
 *   PUT   /api/jobs/:jobId/receipt/fulfillment
 *   PATCH /api/jobs/:jobId/receipt                 the discount
 *   POST  /api/jobs/:jobId/receipt/close           payments + number + freeze, one transaction
 *   POST  /api/jobs/:jobId/receipt/void            owner only
 *   PUT   /api/jobs/:jobId/tax-invoice-request
 *   POST  /api/jobs/:jobId/prints                  record a print BEFORE window.print()
 *   GET   /api/jobs/:jobId/prints
 *   GET   /api/daily-summary
 *   POST  /api/daily-closings                      manager and up
 *
 * The shop and the role come from the JWT only. Routes validate, authorize, call a
 * service inside withShop and shape the answer; there is no SQL here. There is no
 * PUT / DELETE for payments anywhere (append-only).
 */
import type { Response } from 'express'
import { z } from 'zod'
import { withShop } from '@gsms/db/client.js'
import {
  CashCountInput, CloseReceiptInput, CreatePrintInput, CreateReceiptInput, DailySummary, DailySummaryQuery,
  FulfillmentInput, PatchReceiptInput, PrintHistory, PrintHistoryQuery, PrintResult, Receipt,
  RebuildReceiptInput, TaxInvoiceRequest, TaxInvoiceRequestInput, VoidReceiptInput, CloseReceiptResult, CashClosing,
  type BillingBody, type InvalidRequestError,
} from '@gsms/contracts/index.js'
import { CASH_COUNT_ROLES, formatSatang, toSatang } from '@champpower/domain'
import { db } from '../lib/db.js'
import { requireAuth, requireRole, type AuthedRequest } from '../middleware/requireAuth.js'
import { asyncRouter } from '../middleware/asyncHandler.js'
import { fieldErrorsOf, nestedFieldErrorsOf } from '../lib/fieldErrors.js'
import { sendPgError } from '../lib/pgError.js'
import { BOARD_READ_ROLES } from './queue.js'
import * as svc from '../services/receipt.js'
import * as printSvc from '../services/prints.js'
import * as dailySvc from '../services/daily.js'

export const billingRouter = asyncRouter()

const WRITE = svc.RECEIPT_WRITE_ROLES
const OWNER_ONLY = ['owner'] as const
// Receipts and the summary carry money: the technician sees none (CLAUDE.md s12.1).
const MONEY_READ = BOARD_READ_ROLES.filter((r) => r !== 'technician')
const HISTORY_READ = ['owner', 'manager', 'assistant_manager', 'advisor', 'technician'] as const
const SUMMARY_READ = ['owner', 'manager', 'assistant_manager', 'advisor', 'accountant', 'viewer'] as const

const jobParam = z.object({ jobId: z.string().uuid() })

function badRequest(res: Response, error: z.ZodError, message: string, raw?: unknown): void {
  const body: InvalidRequestError = {
    error: 'invalid_request', message,
    fields: raw === undefined ? fieldErrorsOf(error) : nestedFieldErrorsOf(error, raw),
  }
  res.status(400).json(body)
}

function refuse(res: Response, status: number, body: BillingBody): void {
  res.status(status).json(body)
}

function sendError(res: Response, e: svc.ReceiptError): void {
  switch (e.code) {
    case 'job_not_found': return refuse(res, 404, { error: 'job_not_found', message: 'ไม่พบงานนี้' })
    case 'receipt_not_found': return refuse(res, 404, { error: 'receipt_not_found', message: 'งานนี้ยังไม่มีใบเสร็จ' })
    case 'receipt_exists': return refuse(res, 409, { error: 'receipt_exists', message: 'งานนี้มีใบเสร็จอยู่แล้ว' })
    case 'receipt_not_draft': return refuse(res, 409, { error: 'receipt_not_draft', message: 'ใบเสร็จนี้ออกเลขแล้ว แก้ไม่ได้' })
    case 'receipt_not_issued': return refuse(res, 409, { error: 'receipt_not_issued', message: 'ใบเสร็จนี้ยังไม่ได้ออกเลข' })
    case 'claim_no_receipt': return refuse(res, 409, { error: 'claim_no_receipt', message: 'งานเคลมประกันไม่ออกใบเสร็จ' })
    case 'job_not_billable': return refuse(res, 409, { error: 'job_not_billable', message: 'งานนี้ยังอยู่ในขั้นที่ออกใบเสร็จไม่ได้ (ต้องเป็นสถานะ "พร้อมส่ง" ตอนปิดบิล)', status: e.status })
    case 'quotation_missing': return refuse(res, 409, { error: 'quotation_missing', message: 'งานนี้ยังไม่มีใบเสนอราคา' })
    case 'quotation_not_confirmed': return refuse(res, 409, { error: 'quotation_not_confirmed', message: 'ใบเสนอราคายังไม่ได้ยืนยันผลลูกค้า' })
    case 'revision_pending': return refuse(res, 409, { error: 'revision_pending', message: 'มีใบเสนอราคาฉบับใหม่ที่ยังไม่ยืนยันผลลูกค้า ปิดบิลไม่ได้' })
    case 'quotation_inconsistent': return refuse(res, 409, { error: 'quotation_inconsistent', message: 'ยอดในใบเสนอราคาไม่ตรงกับรายการ ออกใบเสร็จไม่ได้ กรุณาแจ้งผู้ดูแลระบบ' })
    case 'quotation_changed': return refuse(res, 409, { error: 'quotation_changed', message: 'ใบเสนอราคาเปลี่ยนไปแล้ว กรุณาสร้างใบเสร็จใหม่จากฉบับล่าสุด (rebuild)' })
    case 'nothing_to_bill': return refuse(res, 409, { error: 'nothing_to_bill', message: 'ยอดบิลเป็น 0 บาท ไม่ออกใบเสร็จ' })
    case 'receipt_line_not_found': return refuse(res, 404, { error: 'receipt_line_not_found', message: 'ไม่พบบรรทัดนี้' })
    case 'invalid_request': return refuse(res, 400, { error: 'invalid_request', message: 'ข้อมูลไม่ถูกต้อง', fields: e.fields })
    case 'fulfillment_incomplete': return refuse(res, 409, { error: 'fulfillment_incomplete', message: 'ยังมีบรรทัดที่ยังไม่ระบุว่าทำจริงหรือไม่', lineIds: e.lineIds })
    case 'discount_entry_required': return refuse(res, 409, { error: 'discount_entry_required', message: 'มีรายการที่ไม่ได้ทำ กรุณากรอกส่วนลดใหม่ก่อนปิดบิล (ใส่ 0 ได้)' })
    case 'discount_exceeds_subtotal': return refuse(res, 400, { error: 'discount_exceeds_subtotal', message: 'ส่วนลดมากกว่ายอดรายการที่ทำจริง', max: e.max, fields: { discount: ['exceeds_subtotal'] } })
    case 'discount_requires_manager': return refuse(res, 403, { error: 'discount_requires_manager', message: 'ส่วนลดเกิน 40% ต้องให้ผู้จัดการหรือรองผู้จัดการเป็นคนปิดบิล', percent: e.percent, ceilingPercent: 40 })
    case 'discount_reason_required': return refuse(res, 400, { error: 'discount_reason_required', message: 'กรุณาระบุเหตุผลของส่วนลด', fields: { discountReason: ['required'] } })
    case 'payment_short': return refuse(res, 409, { error: 'payment_short', message: `ขาดอีก ฿${e.short}`, short: e.short, due: e.due })
    case 'payment_over_noncash': return refuse(res, 409, { error: 'payment_over_noncash', message: 'โอน/บัตรรับเกินยอดบิลไม่ได้ (ทอนได้เฉพาะเงินสด)', over: e.over })
    case 'payment_cash_unneeded': return refuse(res, 422, { error: 'payment_cash_unneeded', message: 'ยอดโอน/บัตรครบแล้ว ไม่ต้องรับเงินสดเพิ่ม' })
    case 'already_billed': return refuse(res, 409, { error: 'already_billed', message: `งานนี้ออกใบเสร็จแล้ว เลขที่ ${e.number}`, receiptId: e.receiptId, number: e.number })
    case 'deposit_held': return refuse(res, 409, { error: 'deposit_held', message: 'งานนี้มีเงินมัดจำที่ยังถืออยู่ ระบบยังหักมัดจำไม่ได้ ให้ปิดบิลนอกระบบไปก่อน' })
  }
}

/** GS001 from allocate_document_number: this shop has no active REC series. */
function seriesMissing(err: unknown, res: Response): boolean {
  if ((err as { code?: string }).code !== 'GS001') return false
  refuse(res, 409, { error: 'document_series_missing', message: 'ยังไม่ได้ตั้งค่าชุดเลขที่ใบเสร็จ (REC) กรุณาตั้งค่าในหน้าตั้งค่าก่อนออกใบ' })
  return true
}

async function view(jobId: string, auth: NonNullable<AuthedRequest['auth']>) {
  return withShop(db, auth.shop, (trx) => svc.getView(trx, jobId, auth.role))
}

async function sendView(res: Response, status: number, jobId: string, auth: NonNullable<AuthedRequest['auth']>): Promise<void> {
  const v = await view(jobId, auth)
  if (!v.ok) { sendError(res, v.error); return }
  res.status(status).json(Receipt.parse(v.value))
}

// ---------------------------------------------------------------------------
// POST /api/jobs/:jobId/receipt
// ---------------------------------------------------------------------------
billingRouter.post('/jobs/:jobId/receipt', requireAuth, requireRole(...WRITE), async (req: AuthedRequest, res) => {
  const params = jobParam.safeParse(req.params)
  const body = CreateReceiptInput.safeParse(req.body ?? {})
  if (!params.success) { refuse(res, 404, { error: 'job_not_found', message: 'ไม่พบงานนี้' }); return }
  if (!body.success) { badRequest(res, body.error, 'ข้อมูลไม่ถูกต้อง'); return }
  const auth = req.auth!
  try {
    const r = await withShop(db, auth.shop, (trx) => svc.createDraft(trx, auth.shop, params.data.jobId, { id: auth.sub, role: auth.role }))
    if (!r.ok) { sendError(res, r.error); return }
    await sendView(res, r.value.created ? 201 : 200, params.data.jobId, auth)
  } catch (err) {
    // Lost the race on uq_live_receipt_per_job: the winner's draft is the answer.
    if ((err as { code?: string; constraint?: string }).constraint === 'uq_live_receipt_per_job') {
      await sendView(res, 200, params.data.jobId, auth); return
    }
    sendPgError(res, err)
  }
})

// ---------------------------------------------------------------------------
// GET /api/jobs/:jobId/receipt
// ---------------------------------------------------------------------------
billingRouter.get('/jobs/:jobId/receipt', requireAuth, requireRole(...MONEY_READ), async (req: AuthedRequest, res) => {
  const params = jobParam.safeParse(req.params)
  if (!params.success) { refuse(res, 404, { error: 'job_not_found', message: 'ไม่พบงานนี้' }); return }
  await sendView(res, 200, params.data.jobId, req.auth!)
})

// ---------------------------------------------------------------------------
// POST /api/jobs/:jobId/receipt/rebuild
// ---------------------------------------------------------------------------
billingRouter.post('/jobs/:jobId/receipt/rebuild', requireAuth, requireRole(...WRITE), async (req: AuthedRequest, res) => {
  const params = jobParam.safeParse(req.params)
  const body = RebuildReceiptInput.safeParse(req.body ?? {})
  if (!params.success) { refuse(res, 404, { error: 'job_not_found', message: 'ไม่พบงานนี้' }); return }
  if (!body.success) { badRequest(res, body.error, 'ข้อมูลไม่ถูกต้อง'); return }
  const auth = req.auth!
  try {
    const r = await withShop(db, auth.shop, (trx) => svc.rebuildDraft(trx, auth.shop, params.data.jobId, { id: auth.sub, role: auth.role }))
    if (!r.ok) { sendError(res, r.error); return }
    await sendView(res, 200, params.data.jobId, auth)
  } catch (err) { sendPgError(res, err) }
})

// ---------------------------------------------------------------------------
// PUT /api/jobs/:jobId/receipt/fulfillment
// ---------------------------------------------------------------------------
billingRouter.put('/jobs/:jobId/receipt/fulfillment', requireAuth, requireRole(...WRITE), async (req: AuthedRequest, res) => {
  const params = jobParam.safeParse(req.params)
  const body = FulfillmentInput.safeParse(req.body)
  if (!params.success) { refuse(res, 404, { error: 'job_not_found', message: 'ไม่พบงานนี้' }); return }
  if (!body.success) { badRequest(res, body.error, 'ข้อมูลการติ๊กไม่ถูกต้อง', req.body); return }
  const auth = req.auth!
  try {
    const r = await withShop(db, auth.shop, (trx) =>
      svc.setFulfillment(trx, auth.shop, params.data.jobId, { id: auth.sub, role: auth.role }, body.data.lines))
    if (!r.ok) { sendError(res, r.error); return }
    await sendView(res, 200, params.data.jobId, auth)
  } catch (err) { sendPgError(res, err) }
})

// ---------------------------------------------------------------------------
// PATCH /api/jobs/:jobId/receipt  (the discount)
// ---------------------------------------------------------------------------
billingRouter.patch('/jobs/:jobId/receipt', requireAuth, requireRole(...WRITE), async (req: AuthedRequest, res) => {
  const params = jobParam.safeParse(req.params)
  const body = PatchReceiptInput.safeParse(req.body)
  if (!params.success) { refuse(res, 404, { error: 'job_not_found', message: 'ไม่พบงานนี้' }); return }
  if (!body.success) { badRequest(res, body.error, 'ส่วนลดไม่ถูกต้อง'); return }
  const auth = req.auth!
  try {
    // Explicit patch object - the validated body is never spread into the service.
    const r = await withShop(db, auth.shop, (trx) =>
      svc.patchDraft(trx, auth.shop, params.data.jobId, { id: auth.sub, role: auth.role },
        { discount: body.data.discount, discountReason: body.data.discountReason }))
    if (!r.ok) { sendError(res, r.error); return }
    await sendView(res, 200, params.data.jobId, auth)
  } catch (err) { sendPgError(res, err) }
})

// ---------------------------------------------------------------------------
// POST /api/jobs/:jobId/receipt/close
// ---------------------------------------------------------------------------
billingRouter.post('/jobs/:jobId/receipt/close', requireAuth, requireRole(...WRITE), async (req: AuthedRequest, res) => {
  const params = jobParam.safeParse(req.params)
  const body = CloseReceiptInput.safeParse(req.body)
  if (!params.success) { refuse(res, 404, { error: 'job_not_found', message: 'ไม่พบงานนี้' }); return }
  if (!body.success) { badRequest(res, body.error, 'ข้อมูลการรับเงินไม่ถูกต้อง', req.body); return }
  const auth = req.auth!
  try {
    const r = await withShop(db, auth.shop, (trx) =>
      svc.closeBill(trx, auth.shop, params.data.jobId, { id: auth.sub, role: auth.role },
        { payments: body.data.payments, discountReason: body.data.discountReason }))
    if (!r.ok) { sendError(res, r.error); return }
    const v = await view(params.data.jobId, auth)
    if (!v.ok) { sendError(res, v.error); return }
    res.status(r.value.replayed ? 200 : 201).json(CloseReceiptResult.parse({
      receipt: v.value, change: r.value.change, unreservedLines: r.value.unreservedLines, replayed: r.value.replayed,
    }))
  } catch (err) {
    if (seriesMissing(err, res)) return
    // Two closes of one job at once: the job lock queues them, so this is only the backstop.
    if ((err as { constraint?: string }).constraint === 'uq_documents_number') {
      refuse(res, 409, { error: 'receipt_exists', message: 'เลขใบเสร็จซ้ำ กรุณาลองใหม่' }); return
    }
    sendPgError(res, err)
  }
})

// ---------------------------------------------------------------------------
// POST /api/jobs/:jobId/receipt/void  (owner only; DEFAULT pending Ice, P3.2 B6)
// ---------------------------------------------------------------------------
billingRouter.post('/jobs/:jobId/receipt/void', requireAuth, requireRole(...OWNER_ONLY), async (req: AuthedRequest, res) => {
  const params = jobParam.safeParse(req.params)
  const body = VoidReceiptInput.safeParse(req.body)
  if (!params.success) { refuse(res, 404, { error: 'job_not_found', message: 'ไม่พบงานนี้' }); return }
  if (!body.success) { badRequest(res, body.error, 'กรุณาระบุเหตุผล'); return }
  const auth = req.auth!
  try {
    const r = await withShop(db, auth.shop, (trx) =>
      svc.voidReceipt(trx, auth.shop, params.data.jobId, { id: auth.sub, role: auth.role }, body.data.reason))
    if (!r.ok) { sendError(res, r.error); return }
    await sendView(res, 200, params.data.jobId, auth)
  } catch (err) { sendPgError(res, err) }
})

// ---------------------------------------------------------------------------
// PUT /api/jobs/:jobId/tax-invoice-request  (a flag only; DEFAULT pending Ice, P3.2 B8)
// ---------------------------------------------------------------------------
billingRouter.put('/jobs/:jobId/tax-invoice-request', requireAuth, requireRole(...WRITE), async (req: AuthedRequest, res) => {
  const params = jobParam.safeParse(req.params)
  const body = TaxInvoiceRequestInput.safeParse(req.body)
  if (!params.success) { refuse(res, 404, { error: 'job_not_found', message: 'ไม่พบงานนี้' }); return }
  if (!body.success) { badRequest(res, body.error, 'ข้อมูลไม่ถูกต้อง'); return }
  const auth = req.auth!
  const r = await withShop(db, auth.shop, (trx) =>
    svc.setTaxInvoiceRequest(trx, auth.shop, params.data.jobId, { id: auth.sub, role: auth.role }, body.data.requested))
  if (!r.ok) { sendError(res, r.error); return }
  res.json(TaxInvoiceRequest.parse({
    jobId: params.data.jobId, requested: r.value.requested,
    requestedAt: r.value.at ? r.value.at.toISOString() : null, requestedByName: r.value.byName,
  }))
})

// ---------------------------------------------------------------------------
// Prints
// ---------------------------------------------------------------------------
function sendPrintError(res: Response, e: printSvc.PrintError): void {
  switch (e.code) {
    case 'job_not_found': return refuse(res, 404, { error: 'job_not_found', message: 'ไม่พบงานนี้' })
    case 'quotation_missing': return refuse(res, 409, { error: 'quotation_missing', message: 'งานนี้ยังไม่มีใบเสนอราคา' })
    case 'quotation_not_confirmed': return refuse(res, 409, { error: 'quotation_not_confirmed', message: 'ใบเสนอราคายังไม่ได้ยืนยันผลลูกค้า' })
    case 'receipt_not_found': return refuse(res, 404, { error: 'receipt_not_found', message: 'งานนี้ยังไม่มีใบเสร็จ' })
    case 'receipt_not_issued': return refuse(res, 409, { error: 'receipt_not_issued', message: 'ใบเสร็จยังไม่ได้ออกเลข พิมพ์ไม่ได้' })
    case 'print_content_changed':
      return refuse(res, 409, {
        error: 'print_content_changed',
        message: `ใบนี้เคยพิมพ์ไปแล้ว ${e.printCount} ครั้ง เนื้อหาเปลี่ยนหลังจากนั้น — เก็บใบเก่าคืนจากลูกค้า`,
        printCount: e.printCount, lastPrintedAt: e.lastPrintedAt,
      })
  }
}

billingRouter.post('/jobs/:jobId/prints', requireAuth, requireRole(...HISTORY_READ), async (req: AuthedRequest, res) => {
  const params = jobParam.safeParse(req.params)
  const body = CreatePrintInput.safeParse(req.body)
  if (!params.success) { refuse(res, 404, { error: 'job_not_found', message: 'ไม่พบงานนี้' }); return }
  if (!body.success) { badRequest(res, body.error, 'ข้อมูลไม่ถูกต้อง'); return }
  const auth = req.auth!
  // The technician prints the work order and nothing that carries a price (AC-G9).
  if (auth.role === 'technician' && body.data.docType !== 'work_order') {
    refuse(res, 403, { error: 'print_not_allowed', message: 'ไม่มีสิทธิ์พิมพ์เอกสารนี้' }); return
  }
  try {
    const r = await withShop(db, auth.shop, (trx) => printSvc.recordPrint(trx, auth.shop, params.data.jobId, { id: auth.sub }, body.data))
    if (!r.ok) { sendPrintError(res, r.error); return }
    res.status(201).json(PrintResult.parse(r.value))
  } catch (err) { sendPgError(res, err) }
})

billingRouter.get('/jobs/:jobId/prints', requireAuth, requireRole(...HISTORY_READ), async (req: AuthedRequest, res) => {
  const params = jobParam.safeParse(req.params)
  const q = PrintHistoryQuery.safeParse(req.query)
  if (!params.success) { refuse(res, 404, { error: 'job_not_found', message: 'ไม่พบงานนี้' }); return }
  if (!q.success) { badRequest(res, q.error, 'ข้อมูลไม่ถูกต้อง'); return }
  const auth = req.auth!
  if (auth.role === 'technician' && q.data.docType !== 'work_order') {
    refuse(res, 403, { error: 'print_not_allowed', message: 'ไม่มีสิทธิ์ดูเอกสารนี้' }); return
  }
  const r = await withShop(db, auth.shop, (trx) => printSvc.history(trx, params.data.jobId, q.data.docType, q.data.limit, q.data.offset))
  if (!r.ok) { sendPrintError(res, r.error); return }
  res.json(PrintHistory.parse(r.value))
})

// ---------------------------------------------------------------------------
// Daily summary and cash count
// ---------------------------------------------------------------------------
billingRouter.get('/daily-summary', requireAuth, requireRole(...SUMMARY_READ), async (req: AuthedRequest, res) => {
  const q = DailySummaryQuery.safeParse(req.query)
  if (!q.success) { badRequest(res, q.error, 'วันที่ไม่ถูกต้อง'); return }
  const auth = req.auth!
  let out: DailySummary
  try {
    out = await withShop(db, auth.shop, (trx) => dailySvc.dailySummary(trx, q.data.date, auth.role))
  } catch (err) {
    // 2026-02-31 passes the date regex and fails to parse as a day.
    if (err instanceof Error && /not a date/.test(err.message)) {
      res.status(400).json({ error: 'invalid_request', message: 'วันที่ไม่ถูกต้อง', fields: { date: ['invalid_date'] } }); return
    }
    throw err
  }
  res.json(DailySummary.parse(out))
})

billingRouter.post('/daily-closings', requireAuth, requireRole(...CASH_COUNT_ROLES), async (req: AuthedRequest, res) => {
  const body = CashCountInput.safeParse(req.body)
  if (!body.success) { badRequest(res, body.error, 'ข้อมูลการนับเงินไม่ถูกต้อง'); return }
  const auth = req.auth!
  try {
    const r = await withShop(db, auth.shop, (trx) => dailySvc.recordCount(trx, auth.shop, { id: auth.sub, role: auth.role }, {
      date: body.data.date, countedCash: formatSatang(toSatang(body.data.countedCash)),
      note: body.data.note, recountReason: body.data.recountReason,
    }))
    if (!r.ok) {
      switch (r.error.code) {
        case 'count_future_date': refuse(res, 400, { error: 'count_future_date', message: 'นับเงินล่วงหน้าไม่ได้' }); return
        case 'recount_reason_required': refuse(res, 409, { error: 'recount_reason_required', message: 'วันนี้นับเงินไปแล้ว การนับใหม่ต้องระบุเหตุผล' }); return
        case 'invalid_request': refuse(res, 400, { error: 'invalid_request', message: 'ข้อมูลไม่ถูกต้อง', fields: r.error.fields }); return
      }
    }
    res.status(201).json(CashClosing.parse(r.value))
  } catch (err) {
    // Two counts of one day at once: the advisory lock queues them; the unique index is the backstop.
    if ((err as { constraint?: string }).constraint === 'uq_closing_day_rev') {
      refuse(res, 409, { error: 'recount_reason_required', message: 'มีคนนับเงินวันนี้ไปพร้อมกัน กรุณาโหลดใหม่แล้วนับซ้ำพร้อมเหตุผล' }); return
    }
    sendPgError(res, err)
  }
})
