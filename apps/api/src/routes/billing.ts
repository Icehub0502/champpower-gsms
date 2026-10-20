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
 *   PUT   /api/jobs/:jobId/receipt/lines/:lineId/discount   a discount on one line (Ice 20 Oct B4)
 *   POST  /api/jobs/:jobId/receipt/present     show the customer the bill BEFORE money (Ice 20 Oct B1)
 *   POST  /api/jobs/:jobId/prints                  record a print BEFORE window.print()
 *   GET   /api/jobs/:jobId/prints
 *   GET   /api/daily-summary
 *   GET   /api/payment-channels                    the shop's own channels (Ice 20 Oct B3)
 *   POST  /api/payment-channels                    owner, manager
 *   PATCH /api/payment-channels/:id                owner, manager (rename / surcharge / deactivate)
 *   PUT   /api/payment-channels-order              owner, manager
 *
 * The shop and the role come from the JWT only. Routes validate, authorize, call a
 * service inside withShop and shape the answer; there is no SQL here. There is no
 * PUT / DELETE for payments anywhere (append-only).
 */
import type { Response } from 'express'
import { z } from 'zod'
import { withShop } from '@gsms/db/client.js'
import {
  CloseReceiptInput, CreatePrintInput, CreateReceiptInput, DailySummary, DailySummaryQuery,
  FulfillmentInput, PatchReceiptInput, PrintHistory, PrintHistoryQuery, PrintResult, Receipt,
  RebuildReceiptInput, VoidReceiptInput, CloseReceiptResult, LineDiscountInput, PresentBillInput,
  CreatePaymentChannelInput, PatchPaymentChannelInput, ReorderPaymentChannelsInput, PaymentChannelQuery,
  PaymentChannel, PaymentChannelList,
  type BillingBody, type InvalidRequestError,
} from '@gsms/contracts/index.js'
import { db } from '../lib/db.js'
import { requireAuth, requireRole, type AuthedRequest } from '../middleware/requireAuth.js'
import { asyncRouter } from '../middleware/asyncHandler.js'
import { fieldErrorsOf, nestedFieldErrorsOf } from '../lib/fieldErrors.js'
import { sendPgError } from '../lib/pgError.js'
import { BOARD_READ_ROLES } from './queue.js'
import * as svc from '../services/receipt.js'
import * as printSvc from '../services/prints.js'
import * as dailySvc from '../services/daily.js'
import * as channelSvc from '../services/channels.js'

export const billingRouter = asyncRouter()

const WRITE = svc.RECEIPT_WRITE_ROLES
const OWNER_ONLY = ['owner'] as const
// Receipts and the summary carry money: the technician sees none (CLAUDE.md s12.1).
const MONEY_READ = BOARD_READ_ROLES.filter((r) => r !== 'technician')
const HISTORY_READ = ['owner', 'manager', 'assistant_manager', 'advisor', 'technician'] as const
const SUMMARY_READ = ['owner', 'manager', 'assistant_manager', 'advisor', 'accountant', 'viewer'] as const
// Ice 20 Oct (P3.2 B3): the channel list is read by whoever takes money; settings are the owner's and the manager's.
const CHANNEL_READ = ['owner', 'manager', 'assistant_manager', 'advisor', 'accountant'] as const
const CHANNEL_WRITE = ['owner', 'manager'] as const

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
    case 'bill_not_presented': return refuse(res, 409, { error: 'bill_not_presented', message: 'ต้องแสดงยอดบิลให้ลูกค้าดูก่อนรับเงิน' })
    case 'presentation_stale': return refuse(res, 409, { error: 'presentation_stale', message: 'ยอดบิลเปลี่ยนไปหลังแสดงให้ลูกค้าดู กรุณาแสดงยอดบิลใหม่ก่อนรับเงิน' })
    case 'channel_not_found': return refuse(res, 404, { error: 'channel_not_found', message: 'ไม่พบช่องทางชำระนี้' })
    case 'channel_inactive': return refuse(res, 409, { error: 'channel_inactive', message: 'ช่องทางชำระนี้ปิดใช้งานแล้ว' })
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
        { payments: body.data.payments.map((p) => ({ channelId: p.channelId, amount: p.amount })), discountReason: body.data.discountReason }))
    if (!r.ok) { sendError(res, r.error); return }
    const v = await view(params.data.jobId, auth)
    if (!v.ok) { sendError(res, v.error); return }
    res.status(r.value.replayed ? 200 : 201).json(CloseReceiptResult.parse({
      receipt: v.value, change: r.value.change, surchargeTotal: r.value.surchargeTotal, unreservedLines: r.value.unreservedLines, replayed: r.value.replayed,
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
// PUT /api/jobs/:jobId/receipt/lines/:lineId/discount  (Ice 20 Oct, P3.2 B4)
// ---------------------------------------------------------------------------
billingRouter.put('/jobs/:jobId/receipt/lines/:lineId/discount', requireAuth, requireRole(...WRITE), async (req: AuthedRequest, res) => {
  const params = z.object({ jobId: z.string().uuid(), lineId: z.string().uuid() }).safeParse(req.params)
  const body = LineDiscountInput.safeParse(req.body)
  if (!params.success) { refuse(res, 404, { error: 'receipt_line_not_found', message: 'ไม่พบบรรทัดนี้' }); return }
  if (!body.success) { badRequest(res, body.error, 'ส่วนลดรายบรรทัดไม่ถูกต้อง'); return }
  const auth = req.auth!
  try {
    const r = await withShop(db, auth.shop, (trx) =>
      svc.setLineDiscount(trx, auth.shop, params.data.jobId, { id: auth.sub, role: auth.role }, params.data.lineId, body.data.discount, body.data.reason))
    if (!r.ok) { sendError(res, r.error); return }
    await sendView(res, 200, params.data.jobId, auth)
  } catch (err) { sendPgError(res, err) }
})

// ---------------------------------------------------------------------------
// POST /api/jobs/:jobId/receipt/present  (Ice 20 Oct, P3.2 B1)
// ---------------------------------------------------------------------------
billingRouter.post('/jobs/:jobId/receipt/present', requireAuth, requireRole(...WRITE), async (req: AuthedRequest, res) => {
  const params = jobParam.safeParse(req.params)
  const body = PresentBillInput.safeParse(req.body ?? {})
  if (!params.success) { refuse(res, 404, { error: 'job_not_found', message: 'ไม่พบงานนี้' }); return }
  if (!body.success) { badRequest(res, body.error, 'ข้อมูลไม่ถูกต้อง'); return }
  const auth = req.auth!
  try {
    const r = await withShop(db, auth.shop, (trx) => svc.presentBill(trx, auth.shop, params.data.jobId, { id: auth.sub, role: auth.role }))
    if (!r.ok) { sendError(res, r.error); return }
    await sendView(res, 200, params.data.jobId, auth)
  } catch (err) { sendPgError(res, err) }
})

// ---------------------------------------------------------------------------
// Payment channels (Ice 20 Oct, P3.2 B3)
// ---------------------------------------------------------------------------
function sendChannelError(res: Response, e: channelSvc.ChannelError): void {
  switch (e.code) {
    case 'channel_not_found': return refuse(res, 404, { error: 'channel_not_found', message: 'ไม่พบช่องทางชำระนี้' })
    case 'channel_name_taken': return refuse(res, 409, { error: 'channel_name_taken', message: 'มีช่องทางชำระชื่อนี้อยู่แล้ว' })
    case 'last_active_channel': return refuse(res, 409, { error: 'last_active_channel', message: 'ต้องมีช่องทางชำระที่ใช้งานอย่างน้อย 1 ช่องทาง' })
  }
}

const isNameClash = (err: unknown) => (err as { code?: string; constraint?: string }).constraint === 'uq_payment_channels_name'

billingRouter.get('/payment-channels', requireAuth, requireRole(...CHANNEL_READ), async (req: AuthedRequest, res) => {
  const q = PaymentChannelQuery.safeParse(req.query)
  if (!q.success) { badRequest(res, q.error, 'ข้อมูลไม่ถูกต้อง'); return }
  const auth = req.auth!
  // Deactivated channels are for the settings screen; the till never offers them.
  const includeInactive = q.data.includeInactive === 'true' && (CHANNEL_WRITE as readonly string[]).includes(auth.role)
  const items = await withShop(db, auth.shop, (trx) => channelSvc.list(trx, auth.shop, includeInactive))
  res.json(PaymentChannelList.parse({ items }))
})

billingRouter.post('/payment-channels', requireAuth, requireRole(...CHANNEL_WRITE), async (req: AuthedRequest, res) => {
  const body = CreatePaymentChannelInput.safeParse(req.body)
  if (!body.success) { badRequest(res, body.error, 'ข้อมูลช่องทางชำระไม่ถูกต้อง'); return }
  const auth = req.auth!
  try {
    const r = await withShop(db, auth.shop, (trx) => channelSvc.create(trx, auth.shop, auth.sub,
      { name: body.data.name, kind: body.data.kind, surchargePercent: body.data.surchargePercent }))
    if (!r.ok) { sendChannelError(res, r.error); return }
    res.status(201).json(PaymentChannel.parse(r.value))
  } catch (err) {
    if (isNameClash(err)) { sendChannelError(res, { code: 'channel_name_taken' }); return }
    sendPgError(res, err)
  }
})

billingRouter.patch('/payment-channels/:id', requireAuth, requireRole(...CHANNEL_WRITE), async (req: AuthedRequest, res) => {
  const params = z.object({ id: z.string().uuid() }).safeParse(req.params)
  const body = PatchPaymentChannelInput.safeParse(req.body)
  if (!params.success) { sendChannelError(res, { code: 'channel_not_found' }); return }
  if (!body.success) { badRequest(res, body.error, 'ข้อมูลช่องทางชำระไม่ถูกต้อง'); return }
  const auth = req.auth!
  try {
    const r = await withShop(db, auth.shop, (trx) => channelSvc.patch(trx, auth.shop, auth.sub, params.data.id,
      { name: body.data.name, surchargePercent: body.data.surchargePercent, isActive: body.data.isActive }))
    if (!r.ok) { sendChannelError(res, r.error); return }
    res.json(PaymentChannel.parse(r.value))
  } catch (err) {
    if (isNameClash(err)) { sendChannelError(res, { code: 'channel_name_taken' }); return }
    sendPgError(res, err)
  }
})

billingRouter.put('/payment-channels-order', requireAuth, requireRole(...CHANNEL_WRITE), async (req: AuthedRequest, res) => {
  const body = ReorderPaymentChannelsInput.safeParse(req.body)
  if (!body.success) { badRequest(res, body.error, 'ข้อมูลไม่ถูกต้อง'); return }
  const auth = req.auth!
  const r = await withShop(db, auth.shop, (trx) => channelSvc.reorder(trx, auth.shop, auth.sub, body.data.ids))
  if (!r.ok) { sendChannelError(res, r.error); return }
  res.json(PaymentChannelList.parse({ items: r.value }))
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
    out = await withShop(db, auth.shop, (trx) => dailySvc.dailySummary(trx, q.data.date))
  } catch (err) {
    // 2026-02-31 passes the date regex and fails to parse as a day.
    if (err instanceof Error && /not a date/.test(err.message)) {
      res.status(400).json({ error: 'invalid_request', message: 'วันที่ไม่ถูกต้อง', fields: { date: ['invalid_date'] } }); return
    }
    throw err
  }
  res.json(DailySummary.parse(out))
})
