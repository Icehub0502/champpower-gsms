/**
 * Deposits (P3.3, CLAUDE.md s5.4): money held for a customer.
 *
 *   POST /api/deposits                      take a deposit (idempotent on idempotencyKey)   owner, manager, assistant_manager, advisor
 *   GET  /api/deposits                      "มัดจำค้างอยู่" + the total held                  + accountant, viewer
 *   GET  /api/deposits/:id                                                                   + accountant, viewer
 *   POST /api/deposits/:id/attach           bind a held deposit to a job                     write roles
 *   POST /api/deposits/:id/detach           undo a wrong attach (reason)                     write roles
 *   POST /api/deposits/:id/refund           give the money back (reason)                     owner, manager, assistant_manager, advisor
 *   POST /api/deposits/:id/forfeit          keep it as shop income (reason)                  owner, manager (others: 403 forfeit_requires_manager)
 *   POST /api/deposits/:id/slip             number + print the ใบรับเงินมัดจำ                write roles
 *   GET  /api/deposits/:id/slip             print history of the slip                        + accountant, viewer
 *   GET  /api/jobs/:jobId/deposits          the warning + deposits applied to the job        money-read roles
 *   POST /api/files/deposit-slip            upload the transfer-slip image (files.ts)         write roles
 *
 * Offsetting a deposit into a bill is part of POST /api/jobs/:jobId/receipt/close (routes/billing.ts).
 * The shop and the role come from the JWT only. Routes validate, authorize, call a service inside
 * withShop and shape the answer; there is no SQL here. There is no DELETE for a deposit anywhere.
 * The technician sees no money, so no route here admits one.
 */
import type { Response } from 'express'
import { z } from 'zod'
import { withShop } from '@gsms/db/client.js'
import {
  AttachDepositInput, CreateDepositInput, CreateDepositResult, CreateDepositSlipInput, Deposit, DepositList,
  DepositListQuery, DepositSlipHistory, DepositSlipHistoryQuery, DepositSlipPrint, DetachDepositInput,
  ForfeitDepositInput, JobDeposits, RefundDepositInput,
  type CustomerAmbiguousError, type DepositBody, type InvalidRequestError,
} from '@gsms/contracts/index.js'
import { DEPOSIT_WRITE_ROLES } from '@champpower/domain'
import { db } from '../lib/db.js'
import { requireAuth, requireRole, type AuthedRequest } from '../middleware/requireAuth.js'
import { asyncRouter } from '../middleware/asyncHandler.js'
import { fieldErrorsOf } from '../lib/fieldErrors.js'
import { sendPgError } from '../lib/pgError.js'
import * as svc from '../services/deposits.js'

export const depositsRouter = asyncRouter()

const WRITE = DEPOSIT_WRITE_ROLES
// The technician sees no money (s12.1).
const READ = ['owner', 'manager', 'assistant_manager', 'advisor', 'accountant', 'viewer'] as const

const idParam = z.object({ id: z.string().uuid() })
const jobParam = z.object({ jobId: z.string().uuid() })

function badRequest(res: Response, error: z.ZodError, message: string): void {
  const body: InvalidRequestError = { error: 'invalid_request', message, fields: fieldErrorsOf(error) }
  res.status(400).json(body)
}

function refuse(res: Response, status: number, body: DepositBody): void {
  res.status(status).json(body)
}

function sendError(res: Response, e: svc.DepositError): void {
  switch (e.code) {
    case 'deposit_not_found': return refuse(res, 404, { error: 'deposit_not_found', message: 'ไม่พบเงินมัดจำนี้' })
    case 'job_not_found': return refuse(res, 404, { error: 'job_not_found', message: 'ไม่พบงานนี้' })
    case 'customer_not_found': return refuse(res, 404, { error: 'customer_not_found', message: 'ไม่พบลูกค้ารายนี้' })
    case 'deposit_not_held':
      return refuse(res, 409, { error: 'deposit_not_held', message: 'เงินมัดจำนี้ไม่ได้อยู่ในสถานะถืออยู่แล้ว (หักเข้าบิล คืน หรือริบไปแล้ว)', status: e.status })
    case 'deposit_customer_mismatch':
      return refuse(res, 422, { error: 'deposit_customer_mismatch', message: 'มัดจำนี้เป็นของลูกค้าคนละรายกับงานนี้' })
    case 'deposit_job_mismatch':
      return refuse(res, 409, { error: 'deposit_job_mismatch', message: 'มัดจำนี้ผูกกับงานอื่นอยู่ หรือเพิ่งมีการเปลี่ยนแปลง กรุณาตรวจสอบอีกครั้ง' })
    case 'job_already_billed':
      return refuse(res, 409, { error: 'job_already_billed', message: 'งานนี้ออกใบเสร็จแล้ว ผูกมัดจำเพิ่มไม่ได้' })
    case 'forfeit_requires_manager':
      return refuse(res, 403, { error: 'forfeit_requires_manager', message: 'การริบมัดจำต้องให้ผู้จัดการหรือเจ้าของเป็นผู้ตัดสิน' })
    case 'deposit_slip_unavailable':
      return refuse(res, 409, { error: 'deposit_slip_unavailable', message: 'มัดจำนี้คืนหรือริบไปแล้วโดยไม่เคยออกใบรับเงินมัดจำ' })
    case 'invalid_request':
      return refuse(res, 400, { error: 'invalid_request', message: 'ข้อมูลไม่ถูกต้อง', fields: e.fields })
    case 'customer_ambiguous': {
      // The same refusal the check-in door gives (packages/contracts errors.ts): id and name only.
      const body: CustomerAmbiguousError = {
        error: 'customer_ambiguous',
        message: 'เบอร์นี้มีลูกค้ามากกว่าหนึ่งราย กรุณาเลือกลูกค้า',
        candidates: e.candidates.map((c) => ({ id: c.id, name: c.name })) as CustomerAmbiguousError['candidates'],
      }
      res.status(409).json(body)
      return
    }
    case 'print_content_changed':
      return refuse(res, 409, { error: 'print_content_changed', message: 'ใบนี้เคยพิมพ์ไปแล้ว และสถานะมัดจำเปลี่ยนไปหลังจากนั้น', printCount: e.printCount, lastPrintedAt: e.lastPrintedAt })
  }
}

/** GS001 from allocate_document_number: this shop has no active DEP series. */
function seriesMissing(err: unknown, res: Response): boolean {
  if ((err as { code?: string }).code !== 'GS001') return false
  refuse(res, 409, { error: 'document_series_missing', message: 'ยังไม่ได้ตั้งค่าชุดเลขที่ใบรับเงินมัดจำ (DEP) กรุณาตั้งค่าในหน้าตั้งค่าก่อนออกใบ' })
  return true
}

// ---------------------------------------------------------------------------
// POST /api/deposits
// ---------------------------------------------------------------------------
depositsRouter.post('/deposits', requireAuth, requireRole(...WRITE), async (req: AuthedRequest, res) => {
  const body = CreateDepositInput.safeParse(req.body)
  if (!body.success) { badRequest(res, body.error, 'ข้อมูลมัดจำไม่ถูกต้อง'); return }
  const auth = req.auth!
  try {
    // Explicit field-by-field input: the validated body is never spread into the service.
    const i = body.data
    const r = await withShop(db, auth.shop, (trx) =>
      svc.createDeposit(trx, auth.shop, { id: auth.sub, role: auth.role }, {
        idempotencyKey: i.idempotencyKey, customerId: i.customerId, customerName: i.customerName, customerPhone: i.customerPhone,
        jobId: i.jobId, vehicleId: i.vehicleId, bookingId: i.bookingId, channel: i.channel, reason: i.reason, amount: i.amount,
        paymentChannelId: i.paymentChannelId, expectedDate: i.expectedDate, slipFileId: i.slipFileId,
      }))
    if (!r.ok) { sendError(res, r.error); return }
    res.status(r.value.replayed ? 200 : 201).json(CreateDepositResult.parse(r.value))
  } catch (err) {
    // Lost a race on the same slip image: the other deposit has it.
    if ((err as { constraint?: string }).constraint === 'uq_deposits_slip_file') {
      refuse(res, 400, { error: 'invalid_request', message: 'ข้อมูลมัดจำไม่ถูกต้อง', fields: { slipFileId: ['unknown_file'] } }); return
    }
    sendPgError(res, err)
  }
})

// ---------------------------------------------------------------------------
// GET /api/deposits
// ---------------------------------------------------------------------------
depositsRouter.get('/deposits', requireAuth, requireRole(...READ), async (req: AuthedRequest, res) => {
  const q = DepositListQuery.safeParse(req.query)
  if (!q.success) { badRequest(res, q.error, 'ตัวกรองไม่ถูกต้อง'); return }
  const auth = req.auth!
  try {
    const out = await withShop(db, auth.shop, (trx) => svc.listDeposits(trx, auth.role, q.data))
    res.json(DepositList.parse(out))
  } catch (err) { sendPgError(res, err) }
})

// ---------------------------------------------------------------------------
// GET /api/deposits/:id
// ---------------------------------------------------------------------------
depositsRouter.get('/deposits/:id', requireAuth, requireRole(...READ), async (req: AuthedRequest, res) => {
  const p = idParam.safeParse(req.params)
  if (!p.success) { refuse(res, 404, { error: 'deposit_not_found', message: 'ไม่พบเงินมัดจำนี้' }); return }
  const auth = req.auth!
  try {
    const r = await withShop(db, auth.shop, (trx) => svc.getDeposit(trx, p.data.id, auth.role))
    if (!r.ok) { sendError(res, r.error); return }
    res.json(Deposit.parse(r.value))
  } catch (err) { sendPgError(res, err) }
})

// ---------------------------------------------------------------------------
// POST /api/deposits/:id/attach  |  /detach
// ---------------------------------------------------------------------------
depositsRouter.post('/deposits/:id/attach', requireAuth, requireRole(...WRITE), async (req: AuthedRequest, res) => {
  const p = idParam.safeParse(req.params)
  const body = AttachDepositInput.safeParse(req.body)
  if (!p.success) { refuse(res, 404, { error: 'deposit_not_found', message: 'ไม่พบเงินมัดจำนี้' }); return }
  if (!body.success) { badRequest(res, body.error, 'ข้อมูลไม่ถูกต้อง'); return }
  const auth = req.auth!
  try {
    const r = await withShop(db, auth.shop, (trx) =>
      svc.attachDeposit(trx, auth.shop, { id: auth.sub, role: auth.role }, p.data.id, body.data.jobId))
    if (!r.ok) { sendError(res, r.error); return }
    res.json(Deposit.parse(r.value))
  } catch (err) { sendPgError(res, err) }
})

depositsRouter.post('/deposits/:id/detach', requireAuth, requireRole(...WRITE), async (req: AuthedRequest, res) => {
  const p = idParam.safeParse(req.params)
  const body = DetachDepositInput.safeParse(req.body)
  if (!p.success) { refuse(res, 404, { error: 'deposit_not_found', message: 'ไม่พบเงินมัดจำนี้' }); return }
  if (!body.success) { badRequest(res, body.error, 'กรุณาระบุเหตุผล'); return }
  const auth = req.auth!
  try {
    const r = await withShop(db, auth.shop, (trx) =>
      svc.detachDeposit(trx, auth.shop, { id: auth.sub, role: auth.role }, p.data.id, body.data.reason))
    if (!r.ok) { sendError(res, r.error); return }
    res.json(Deposit.parse(r.value))
  } catch (err) { sendPgError(res, err) }
})

// ---------------------------------------------------------------------------
// POST /api/deposits/:id/refund  (advisor and above)  |  /forfeit  (manager and above)
// ---------------------------------------------------------------------------
depositsRouter.post('/deposits/:id/refund', requireAuth, requireRole(...WRITE), async (req: AuthedRequest, res) => {
  const p = idParam.safeParse(req.params)
  const body = RefundDepositInput.safeParse(req.body)
  if (!p.success) { refuse(res, 404, { error: 'deposit_not_found', message: 'ไม่พบเงินมัดจำนี้' }); return }
  if (!body.success) { badRequest(res, body.error, 'กรุณาระบุเหตุผลที่คืนมัดจำ'); return }
  const auth = req.auth!
  try {
    const r = await withShop(db, auth.shop, (trx) =>
      svc.refundDeposit(trx, auth.shop, { id: auth.sub, role: auth.role }, p.data.id,
        { reason: body.data.reason, refundChannelId: body.data.refundChannelId }))
    if (!r.ok) { sendError(res, r.error); return }
    res.json(Deposit.parse(r.value))
  } catch (err) { sendPgError(res, err) }
})

depositsRouter.post('/deposits/:id/forfeit', requireAuth, requireRole(...WRITE), async (req: AuthedRequest, res) => {
  const p = idParam.safeParse(req.params)
  const body = ForfeitDepositInput.safeParse(req.body)
  if (!p.success) { refuse(res, 404, { error: 'deposit_not_found', message: 'ไม่พบเงินมัดจำนี้' }); return }
  if (!body.success) { badRequest(res, body.error, 'กรุณาระบุเหตุผลที่ริบมัดจำ'); return }
  const auth = req.auth!
  try {
    const r = await withShop(db, auth.shop, (trx) =>
      svc.forfeitDeposit(trx, auth.shop, { id: auth.sub, role: auth.role }, p.data.id, { reason: body.data.reason }))
    if (!r.ok) { sendError(res, r.error); return }
    res.json(Deposit.parse(r.value))
  } catch (err) { sendPgError(res, err) }
})

// ---------------------------------------------------------------------------
// POST /api/deposits/:id/slip  |  GET /api/deposits/:id/slip
// ---------------------------------------------------------------------------
depositsRouter.post('/deposits/:id/slip', requireAuth, requireRole(...WRITE), async (req: AuthedRequest, res) => {
  const p = idParam.safeParse(req.params)
  const body = CreateDepositSlipInput.safeParse(req.body ?? {})
  if (!p.success) { refuse(res, 404, { error: 'deposit_not_found', message: 'ไม่พบเงินมัดจำนี้' }); return }
  if (!body.success) { badRequest(res, body.error, 'ข้อมูลไม่ถูกต้อง'); return }
  const auth = req.auth!
  try {
    const r = await withShop(db, auth.shop, (trx) =>
      svc.printSlip(trx, auth.shop, { id: auth.sub, role: auth.role }, p.data.id, body.data))
    if (!r.ok) { sendError(res, r.error); return }
    res.status(r.value.isReprint ? 200 : 201).json(DepositSlipPrint.parse(r.value))
  } catch (err) {
    if (seriesMissing(err, res)) return
    if ((err as { constraint?: string }).constraint === 'uq_documents_number') {
      refuse(res, 409, { error: 'deposit_not_held', message: 'เลขใบรับเงินมัดจำซ้ำ กรุณาลองใหม่', status: 'held' }); return
    }
    sendPgError(res, err)
  }
})

depositsRouter.get('/deposits/:id/slip', requireAuth, requireRole(...READ), async (req: AuthedRequest, res) => {
  const p = idParam.safeParse(req.params)
  const q = DepositSlipHistoryQuery.safeParse(req.query)
  if (!p.success) { refuse(res, 404, { error: 'deposit_not_found', message: 'ไม่พบเงินมัดจำนี้' }); return }
  if (!q.success) { badRequest(res, q.error, 'ตัวกรองไม่ถูกต้อง'); return }
  const auth = req.auth!
  try {
    const r = await withShop(db, auth.shop, (trx) => svc.slipHistory(trx, p.data.id, q.data.limit, q.data.offset))
    if (!r.ok) { sendError(res, r.error); return }
    res.json(DepositSlipHistory.parse(r.value))
  } catch (err) { sendPgError(res, err) }
})

// ---------------------------------------------------------------------------
// GET /api/jobs/:jobId/deposits  (the warning on the job / receipt views)
// ---------------------------------------------------------------------------
depositsRouter.get('/jobs/:jobId/deposits', requireAuth, requireRole(...READ), async (req: AuthedRequest, res) => {
  const p = jobParam.safeParse(req.params)
  if (!p.success) { refuse(res, 404, { error: 'job_not_found', message: 'ไม่พบงานนี้' }); return }
  const auth = req.auth!
  try {
    const r = await withShop(db, auth.shop, (trx) => svc.jobDeposits(trx, p.data.jobId, auth.role))
    if (!r.ok) { sendError(res, r.error); return }
    res.json(JobDeposits.parse(r.value))
  } catch (err) { sendPgError(res, err) }
})
