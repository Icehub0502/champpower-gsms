/**
 * The queue board, and the two things staff change from it.
 *
 * GET /api/queue reads ONE view. Not two queries merged here, not two fetches
 * merged in the browser — see repositories/queue.ts for why that matters.
 *
 * Bay and queue number are editable from the board itself, not only at
 * check-in: the person who knows a car moved is the one standing next to it,
 * and if the only way to record it were the check-in form, staff would stop
 * recording it within two days and the board would start lying
 * (WO-003-ANSWERS.md §b).
 */
import type { Response } from 'express'
import { z } from 'zod'
import { withShop } from '@gsms/db/client.js'
import {
  PageQuery,
  QueueBoardQuery,
  UpdateBayInput,
  UpdateQueueNoInput,
  type CustomerAmbiguousError,
  type IntakeDetailsRequiredError,
  type IntakeRequiredField,
  type UnknownBayError,
  type UnknownFileError,
  type QueueBoardRow,
  type VehicleOwnerMismatchError,
  type VehicleRequiredError,
} from '@gsms/contracts/index.js'
import { db } from '../lib/db.js'
import { requireAuth, requireRole, type AuthedRequest } from '../middleware/requireAuth.js'
import { asyncRouter } from '../middleware/asyncHandler.js'
import { sendPgError } from '../lib/pgError.js'
import { addDays, bangkokToday, endOfDayExclusive, startOfDay } from '../lib/bangkokDate.js'
import * as queueRepo from '../repositories/queue.js'
import * as jobsRepo from '../repositories/jobs.js'
import * as baysRepo from '../repositories/bays.js'
import { writeAudit } from '../services/audit.js'
import type { OpenJobOutcome } from '../services/intake.js'

export const queueRouter = asyncRouter()

/**
 * Who may do what — checked here, on the server. Hiding a button is a hint;
 * this is the rule (CLAUDE.md §12.1).
 *
 * Reading the board is for everyone who works a shift: the technician needs to
 * know which car is next, the accountant and the viewer look without touching.
 * Changing anything is the counter's job.
 */
export const BOARD_READ_ROLES = [
  'owner', 'manager', 'assistant_manager', 'advisor',
  'technician', 'accountant', 'viewer',
] as const
export const INTAKE_WRITE_ROLES = [
  'owner', 'manager', 'assistant_manager', 'advisor',
] as const

const idParam = z.object({ id: z.string().uuid() })

/**
 * The intake_details_required message, true to WHICH fields are missing.
 *
 * It used to say "รถคันนี้ยังไม่เคยเข้าร้าน" (this car has never been here) every
 * time — false when the car IS on file and only the customer's name is missing
 * (confirming an owner change to someone not yet a customer). The message is
 * part of the contract now, so it names exactly what to type, and only calls
 * the car new when brand or model is missing, which happens only for a car
 * nobody has on file.
 */
export function detailsRequiredMessage(missing: IntakeRequiredField[]): string {
  const label: Record<IntakeRequiredField, string> = {
    brand: 'ยี่ห้อ', model: 'รุ่น', customerName: 'ชื่อลูกค้า',
  }
  const words = missing.map((f) => label[f]).join(' ')
  const newCar = missing.includes('brand') || missing.includes('model')
  return newCar ? `รถคันนี้ยังไม่เคยเข้าร้าน กรุณากรอก${words}` : `กรุณากรอก${words}`
}

/**
 * The failure half of `openJob`, in HTTP terms.
 *
 * Shared by both intake doors for the same reason the service itself is: if
 * check-in and arrival each translated these, one of them would eventually
 * answer a different code for the same condition and the screen would need
 * two branches to handle one problem.
 *
 * Every message tells the counter what to TYPE, not what to go and do
 * somewhere else. A person is standing at the desk with a customer waiting.
 */
export function sendIntakeOutcome(
  res: Response,
  outcome: Exclude<OpenJobOutcome, { kind: 'ok' }>,
): void {
  switch (outcome.kind) {
    case 'unknown_bay': {
      const body: UnknownBayError = { error: 'unknown_bay', message: 'ไม่พบช่องยกนี้ในสาขานี้' }
      res.status(400).json(body)
      return
    }
    case 'unknown_file': {
      const body: UnknownFileError = { error: 'unknown_file', message: 'ไม่พบไฟล์รูปที่แนบมา' }
      res.status(400).json(body)
      return
    }
    // The four refusals below are built as the schema types in
    // packages/contracts/src/errors.ts, so a field the schema lacks — or lacks
    // here — is a COMPILE error, and the screen parses them with the same
    // schemas. Each is an EXPLICIT PROJECTION (id: ..., name: ...), never a
    // pass-through of an internal object: TypeScript only rejects extra fields
    // in a literal, so `candidates: outcome.candidates` would compile even if
    // a phone were ever added to the repository's rows. Spelling every field out
    // is what makes "id and name only" true by construction.
    case 'vehicle_required': {
      const body: VehicleRequiredError = {
        error: 'vehicle_required',
        message: 'กรุณากรอกทะเบียนรถก่อนเปิดงาน',
      }
      res.status(409).json(body)
      return
    }
    // The next three are 409 for the same reason: the request is well-formed,
    // the server is fine, and resending it with one more field succeeds. That
    // is what a conflict means.
    case 'customer_ambiguous': {
      const body: CustomerAmbiguousError = {
        error: 'customer_ambiguous',
        message: 'เบอร์นี้มีลูกค้ามากกว่าหนึ่งราย กรุณาเลือกว่าเป็นรายไหน',
        candidates: outcome.candidates.map((c) => ({ id: c.id, name: c.name })),
      }
      res.status(409).json(body)
      return
    }
    case 'vehicle_owner_mismatch': {
      const body: VehicleOwnerMismatchError = {
        error: 'vehicle_owner_mismatch',
        message: `ทะเบียนนี้อยู่ในชื่อ ${outcome.currentOwner.name ?? 'ลูกค้ารายอื่น'} `
          + `ถ้าต้องการย้ายรถมาเป็นของ ${outcome.newOwner.name ?? 'ลูกค้ารายนี้'} กรุณายืนยัน`,
        vehicleId: outcome.vehicleId,
        currentOwner: { id: outcome.currentOwner.id, name: outcome.currentOwner.name },
        newOwner: { id: outcome.newOwner.id, name: outcome.newOwner.name },
      }
      res.status(409).json(body)
      return
    }
    default: {
      const fields: IntakeDetailsRequiredError['fields'] = {}
      for (const f of outcome.fields) fields[f] = ['required']
      const body: IntakeDetailsRequiredError = {
        error: 'intake_details_required',
        message: detailsRequiredMessage(outcome.fields),
        fields,
      }
      res.status(409).json(body)
    }
  }
}

/** The view's columns are nullable in the generated types; the data is not. */
function must<T>(value: T | null, column: string): T {
  if (value === null) throw new Error(`queue_board.${column} was null`)
  return value
}

function toRow(r: queueRepo.QueueBoardDbRow): QueueBoardRow {
  const kind = must(r.kind, 'kind')
  return {
    kind: kind === 'booking' ? 'booking' : 'job',
    refId: must(r.ref_id, 'ref_id'),
    bayId: r.bay_id,
    bayName: r.bay_name,
    at: must(r.at, 'at').toISOString(),
    status: must(r.status, 'status'),
    source: must(r.source, 'source'),
    customerName: r.customer_name,
    phone: r.phone,
    plate: r.plate,
    brand: r.brand,
    model: r.model,
    color: r.color,
    queueNo: r.queue_no,
    jobId: r.job_id,
    jobType: r.job_type === 'warranty_claim' ? 'warranty_claim'
      : r.job_type === 'normal' ? 'normal' : null,
    thumbFileId: r.thumb_file_id,
    assignedTechnicianId: r.assigned_technician_id,
    assignedTeamId: r.assigned_team_id,
    note: r.note,
  }
}

queueRouter.get(
  '/queue',
  requireAuth,
  requireRole(...BOARD_READ_ROLES),
  async (req: AuthedRequest, res) => {
    const window = QueueBoardQuery.safeParse(req.query)
    const page = PageQuery.safeParse(req.query)
    if (!window.success || !page.success) {
      res.status(400).json({ error: 'invalid_request' })
      return
    }

    // Today .. +7 in Asia/Bangkok. The default is a week because the counter
    // wants to see what is coming without next month's bookings burying the
    // cars actually on the ramp.
    const today = bangkokToday()
    const from = window.data.from ?? today
    const to = window.data.to ?? addDays(today, 7)
    if (to < from) {
      res.status(400).json({ error: 'invalid_request', message: 'ช่วงวันที่ไม่ถูกต้อง' })
      return
    }

    const result = await withShop(db, req.auth!.shop, (trx) =>
      queueRepo.listBoard(trx, {
        from: startOfDay(from),
        to: endOfDayExclusive(to),
        limit: page.data.limit,
        offset: page.data.offset,
      }))

    res.json({ items: result.items.map(toRow), total: result.total })
  },
)

/**
 * Move a car to another bay.
 *
 * Two cars in one bay is allowed and always has been on the shop floor — the
 * database only forbids overlapping BOOKINGS. `sharingBay` is returned so the
 * screen can say "there is already a car here"; it is never a refusal.
 */
queueRouter.patch(
  '/jobs/:id/bay',
  requireAuth,
  requireRole(...INTAKE_WRITE_ROLES),
  async (req: AuthedRequest, res) => {
    const params = idParam.safeParse(req.params)
    const body = UpdateBayInput.safeParse(req.body)
    if (!params.success || !body.success) {
      res.status(400).json({ error: 'invalid_request' })
      return
    }
    const auth = req.auth!
    const jobId = params.data.id
    const bayId = body.data.bayId

    const outcome = await withShop(db, auth.shop, async (trx) => {
      const job = await jobsRepo.findById(trx, jobId)
      if (!job) return { kind: 'not_found' as const }

      // Not a race check: RLS makes a foreign bay invisible here, and foreign
      // key checks run with RLS bypassed, so without this a bay id from
      // another branch would be accepted by the constraint.
      let bayName: string | null = null
      if (bayId !== null) {
        const bay = await baysRepo.findById(trx, bayId)
        if (!bay) return { kind: 'unknown_bay' as const }
        bayName = bay.name
      }

      await jobsRepo.updateBay(trx, jobId, bayId)
      const sharingBay = bayId === null ? 0 : await jobsRepo.countOthersInBay(trx, bayId, jobId)

      await writeAudit(trx, {
        shopId: auth.shop,
        actorId: auth.sub,
        action: 'job_bay_changed',
        entityType: 'jobs',
        entityId: jobId,
        before: { bay_id: job.bay_id },
        after: { bay_id: bayId },
      })

      return { kind: 'ok' as const, bayName, sharingBay }
    })

    if (outcome.kind === 'not_found') {
      res.status(404).json({ error: 'job_not_found', message: 'ไม่พบใบงานนี้' })
      return
    }
    if (outcome.kind === 'unknown_bay') {
      res.status(400).json({ error: 'unknown_bay', message: 'ไม่พบช่องยกนี้ในสาขานี้' })
      return
    }
    res.json({ jobId, bayId, bayName: outcome.bayName, sharingBay: outcome.sharingBay })
  },
)

/**
 * Renumber a car in today's queue.
 *
 * No check for "is this number free". `uq_queue_no` (shop, job_date, queue_no)
 * decides, and a collision comes back naming the number so the counter reads
 * "คิว 5 มีรถคันอื่นแล้ว" instead of a generic failure. Swapping two cars means
 * moving one to a free number first — accepted deliberately, because two cars
 * answering to the same shout across the shop is worse than an extra tap
 * (WO-003-ANSWERS.md §c).
 */
queueRouter.patch(
  '/jobs/:id/queue-no',
  requireAuth,
  requireRole(...INTAKE_WRITE_ROLES),
  async (req: AuthedRequest, res) => {
    const params = idParam.safeParse(req.params)
    const body = UpdateQueueNoInput.safeParse(req.body)
    if (!params.success || !body.success) {
      res.status(400).json({ error: 'invalid_request' })
      return
    }
    const auth = req.auth!
    const jobId = params.data.id
    const queueNo = body.data.queueNo

    try {
      const outcome = await withShop(db, auth.shop, async (trx) => {
        const job = await jobsRepo.findById(trx, jobId)
        if (!job) return { kind: 'not_found' as const }

        await jobsRepo.updateQueueNo(trx, jobId, queueNo)
        await writeAudit(trx, {
          shopId: auth.shop,
          actorId: auth.sub,
          action: 'job_queue_no_changed',
          entityType: 'jobs',
          entityId: jobId,
          before: { queue_no: job.queue_no },
          after: { queue_no: queueNo },
        })
        return { kind: 'ok' as const }
      })

      if (outcome.kind === 'not_found') {
        res.status(404).json({ error: 'job_not_found', message: 'ไม่พบใบงานนี้' })
        return
      }
      res.json({ jobId, queueNo })
    } catch (err) {
      sendPgError(res, err, { queueNo })
    }
  },
)
