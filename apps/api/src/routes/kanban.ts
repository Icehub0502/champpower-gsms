/**
 * The /today kanban — "ศูนย์ควบคุมงานวันนี้" — and the two edits made from it.
 *
 *   GET   /api/jobs/today
 *   PATCH /api/jobs/:id/status
 *   PATCH /api/jobs/:id/sub-state
 *
 * Every decision about a card — its column, its label, its tone, the headline
 * counts, whether a drag is legal — is made by packages/domain
 * (rules/kanban.ts) and sent resolved. The screen renders; this file and the
 * domain decide.
 */
import { z } from 'zod'
import { withShop } from '@gsms/db/client.js'
import {
  UpdateJobStatusInput,
  UpdateSubStateInput,
  type AwaitingTakeDownJob,
  type TodayBooking,
  type TodayJob,
  type TodayResponse,
  type UpdateJobStatusResult,
  type UpdateSubStateResult,
} from '@gsms/contracts/index.js'
import {
  canMoveTo,
  cardLabelOf,
  DECISION_KEYS,
  estMinutes,
  isValidSubState,
  kanbanColumnOf,
  kpisOf,
  pulseOf,
  requiresAppointmentDate,
  statusOf,
  SUB_STATE_LABEL,
  subStateAfterMove,
  type BoardJob,
  type StatusKey,
  type SubState,
} from '@champpower/domain'
import { db } from '../lib/db.js'
import { requireAuth, requireRole, type AuthedRequest } from '../middleware/requireAuth.js'
import { asyncRouter } from '../middleware/asyncHandler.js'
import { bangkokToday, endOfDayExclusive, startOfDay } from '../lib/bangkokDate.js'
import * as todayRepo from '../repositories/today.js'
import * as jobsRepo from '../repositories/jobs.js'
import { writeAudit } from '../services/audit.js'
import { BOARD_READ_ROLES } from './queue.js'

export const kanbanRouter = asyncRouter()

/**
 * CLAUDE.md §12.1: "อัปเดตสถานะงาน / ถ่ายรูป" is open to the technician as well
 * as the counter — the person at the lift is the one who knows the car moved on.
 * Two things inside that are NOT the technician's to do; see the checks below.
 */
const STATUS_WRITE_ROLES = [
  'owner', 'manager', 'assistant_manager', 'advisor', 'technician',
] as const

const idParam = z.object({ id: z.string().uuid() })

const EST_UNITS = new Set(['minute', 'hour', 'day'])
function estUnitOf(v: string | null): 'minute' | 'hour' | 'day' | null {
  return v !== null && EST_UNITS.has(v) ? (v as 'minute' | 'hour' | 'day') : null
}

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString())

/**
 * Is this move the CUSTOMER'S decision on the quote — made, or taken back?
 *
 * §12.1 gives "ทำใบเสนอราคา / รับอนุมัติลูกค้า" (quoting and taking the
 * customer's approval) to the counter and NOT to the technician. A drag from
 * เสนอราคา to อนุมัติ is exactly that act wearing a different gesture, so the
 * technician's right to move a car along does not extend to it. The role gate
 * is on the ACT, not on the endpoint that happens to carry it.
 */
function isCustomerDecision(from: string, to: string): boolean {
  const decisions = DECISION_KEYS as readonly string[]
  return (from === 'quoted' && decisions.includes(to)) || (decisions.includes(from) && to === 'quoted')
}

// ---------------------------------------------------------------------------
// GET /api/jobs/today
// ---------------------------------------------------------------------------

/**
 * The kanban.
 *
 * "TODAY" IN THIS PATH DOES NOT MEAN "JOBS OPENED TODAY", and the job rows must
 * never be date-filtered. The user ruled on this in WO-003-ANSWERS.md §a:
 * today's queue means the cars in the workshop NOW. A car that arrived
 * yesterday and is still on a lift is on this board; filter by date and it
 * vanishes at midnight while it is still sitting there. The path name will
 * tempt the next person — do not.
 *
 * What IS dated: bookings (an appointment belongs to a day — this screen shows
 * today's), and cars already handed back (kept for the day they left so the
 * column can show today's deliveries, then gone). Both are decided upstream —
 * bookings below, deliveries in the view job_board_state — not by a predicate
 * on the job rows here.
 */
kanbanRouter.get(
  '/jobs/today',
  requireAuth,
  requireRole(...BOARD_READ_ROLES),
  async (req: AuthedRequest, res) => {
    const today = bangkokToday()
    const now = Date.now()

    const data = await withShop(db, req.auth!.shop, async (trx) => {
      const [jobs, bookings, bays] = await Promise.all([
        todayRepo.boardJobs(trx),
        todayRepo.boardBookings(trx, startOfDay(today), endOfDayExclusive(today)),
        todayRepo.shopBays(trx),
      ])
      return { jobs, bookings, bays }
    })

    const cards: TodayJob[] = []
    const awaitingTakeDown: AwaitingTakeDownJob[] = []
    const forCounting: BoardJob[] = []

    for (const r of data.jobs.rows) {
      const createdAt = r.created_at.toISOString()
      const board: BoardJob = {
        status: r.status,
        subState: r.sub_state,
        bayId: r.bay_id,
        createdAt,
        leftReceivedAt: iso(r.left_received_at),
        repairStartedAt: iso(r.repair_started_at),
        repairEndedAt: iso(r.repair_ended_at),
        estValue: r.est_value,
        estUnit: estUnitOf(r.est_unit),
      }
      forCounting.push(board)

      const mins = estMinutes({ estValue: r.est_value ?? undefined, estUnit: board.estUnit ?? undefined })
      const common = {
        jobId: r.job_id,
        jobNumber: r.job_number ?? '',
        queueNo: r.queue_no,
        status: r.status as TodayJob['status'],
        statusLabel: statusOf(r.status).label,
        subState: isValidSubState(r.status, r.sub_state) ? (r.sub_state as SubState | null) : null,
        label: cardLabelOf({
          // A sub-state that no longer fits its status is not shown. The move
          // endpoint clears these, but a row edited some other way must not
          // put a stale label on a card.
          subState: isValidSubState(r.status, r.sub_state) ? r.sub_state : null,
          bayName: r.bay_name,
          bookingSlotStart: iso(r.booking_slot_start),
        }),
        jobType: (r.job_type === 'warranty_claim' ? 'warranty_claim' : 'normal') as TodayJob['jobType'],
        source: (r.source === 'booked' ? 'booked' : 'walk_in') as TodayJob['source'],
        plate: r.plate,
        brand: r.brand,
        model: r.model,
        color: r.color,
        customerName: r.customer_name,
        phone: r.phone,
        bayId: r.bay_id,
        bayName: r.bay_name,
        symptom: r.symptom,
        bookingSlotStart: iso(r.booking_slot_start),
        thumbFileId: r.thumb_file_id,
        createdAt,
        statusChangedAt: (r.status_changed_at ?? r.created_at).toISOString(),
        sla: mins > 0
          ? { estMinutes: mins, repairStartedAt: board.repairStartedAt, repairEndedAt: board.repairEndedAt }
          : null,
      }

      const column = kanbanColumnOf(r.status)
      if (column === null) awaitingTakeDown.push({ ...common, column: null })
      else cards.push({ ...common, column })
    }

    const bookings: TodayBooking[] = data.bookings.map((b) => ({
      bookingId: b.booking_id,
      at: b.at.toISOString(),
      status: b.status,
      source: b.source,
      bayId: b.bay_id,
      bayName: b.bay_name,
      customerName: b.customer_name,
      phone: b.phone,
      plate: b.plate,
      brand: b.brand,
      model: b.model,
      note: b.note,
    }))

    const body: TodayResponse = {
      jobs: cards,
      awaitingTakeDown,
      bookings,
      kpis: kpisOf(forCounting),
      pulse: pulseOf(forCounting, data.bays.map((b) => ({ id: b.id, isActive: b.is_active })), now),
      generatedAt: new Date(now).toISOString(),
      truncated: data.jobs.truncated,
    }
    res.json(body)
  },
)

// ---------------------------------------------------------------------------
// PATCH /api/jobs/:id/status
// ---------------------------------------------------------------------------

/**
 * Move a job. The drag on the screen is a REQUEST; this endpoint is the rule.
 *
 * The move is checked with canMoveTo() from packages/domain — built on
 * transitions.ts, so the kanban can do nothing the job screen's own buttons
 * could not. Checked against the status read under FOR UPDATE, in the same
 * transaction that writes it, so a concurrent move is judged against what it
 * actually follows. The history row and the audit row are written in that
 * same transaction: a move is never recorded without happening, or the reverse.
 */
kanbanRouter.patch(
  '/jobs/:id/status',
  requireAuth,
  requireRole(...STATUS_WRITE_ROLES),
  async (req: AuthedRequest, res) => {
    const params = idParam.safeParse(req.params)
    const parsed = UpdateJobStatusInput.safeParse(req.body)
    if (!params.success || !parsed.success) {
      res.status(400).json({ error: 'invalid_request' })
      return
    }
    const auth = req.auth!
    const jobId = params.data.id
    const { to, fromStatus, appointmentDate } = parsed.data

    if (auth.role === 'technician' && isCustomerDecision(fromStatus, to)) {
      res.status(403).json({
        error: 'forbidden',
        message: 'การรับหรือยกเลิกการตัดสินใจของลูกค้าต้องทำโดยหน้าร้าน',
      })
      return
    }
    if (requiresAppointmentDate(to) && !appointmentDate) {
      res.status(400).json({
        error: 'appointment_date_required',
        message: 'กรุณาระบุวันที่ลูกค้าจะนำรถกลับมา',
        fields: { appointmentDate: ['required'] },
      })
      return
    }

    type Outcome =
      | { kind: 'ok'; result: UpdateJobStatusResult }
      | { kind: 'not_found' }
      | { kind: 'status_changed'; current: string }
      | { kind: 'illegal'; from: string }

    const outcome = await withShop(db, auth.shop, async (trx): Promise<Outcome> => {
      const job = await jobsRepo.lockForStatusChange(trx, jobId)
      if (!job) return { kind: 'not_found' }

      // The screen judged this drag against the board it was looking at. If
      // the card has moved since, that judgement is about a job that no longer
      // exists — refuse, rather than apply a move chosen for a different state.
      if (job.status !== fromStatus) return { kind: 'status_changed', current: job.status }

      const history = await jobsRepo.statusHistoryOf(trx, jobId)
      const legal = canMoveTo(
        {
          status: job.status as StatusKey,
          appointmentDate: iso(job.appointment_date),
          statusHistory: history.map((h) => ({
            status: h.status as StatusKey,
            changedAt: h.changed_at.toISOString(),
          })),
        },
        to,
      )
      if (!legal) return { kind: 'illegal', from: job.status }

      // A label that described the old status does not survive the move.
      const subState = subStateAfterMove(to, job.sub_state)

      // appointment_date: set when the customer picks a later date; cleared
      // when that decision is taken back or when the car comes back in for
      // it. Left alone for every other move.
      let appointment: string | null | undefined
      if (to === 'scheduled') appointment = appointmentDate
      else if (job.status === 'scheduled' && to === 'quoted') appointment = null
      else if (job.status === 'carout' && to === 'repairing') appointment = null

      await jobsRepo.applyStatus(trx, { jobId, status: to, subState, appointmentDate: appointment })
      const changedAt = await jobsRepo.recordStatusHistory(trx, auth.shop, jobId, to, auth.sub)

      await writeAudit(trx, {
        shopId: auth.shop,
        actorId: auth.sub,
        action: 'job_status_changed',
        entityType: 'jobs',
        entityId: jobId,
        before: { status: job.status, sub_state: job.sub_state },
        after: {
          status: to,
          sub_state: subState,
          ...(appointment !== undefined ? { appointment_date: appointment } : {}),
        },
      })

      return {
        kind: 'ok',
        result: {
          jobId,
          status: to,
          subState,
          column: kanbanColumnOf(to),
          statusChangedAt: changedAt.toISOString(),
        },
      }
    })

    switch (outcome.kind) {
      case 'not_found':
        res.status(404).json({ error: 'job_not_found', message: 'ไม่พบใบงานนี้' })
        return
      case 'status_changed':
        res.status(409).json({
          error: 'status_changed',
          message: `มีคนเปลี่ยนสถานะงานนี้เป็น "${statusOf(outcome.current).label}" ไปแล้ว กรุณารีเฟรชกระดาน`,
          currentStatus: outcome.current,
        })
        return
      case 'illegal':
        res.status(409).json({
          error: 'illegal_status_move',
          message: `ย้ายงานจาก "${statusOf(outcome.from).label}" ไป "${statusOf(to).label}" ไม่ได้`,
        })
        return
      default:
        res.json(outcome.result)
    }
  },
)

// ---------------------------------------------------------------------------
// PATCH /api/jobs/:id/sub-state
// ---------------------------------------------------------------------------

/**
 * Set or clear the card's sub-state.
 *
 * Checked with isValidSubState() against the job's CURRENT status, read under
 * the row lock — a label chosen for a card that someone has just moved on is
 * refused, not applied to a status it was never meant for.
 */
kanbanRouter.patch(
  '/jobs/:id/sub-state',
  requireAuth,
  requireRole(...STATUS_WRITE_ROLES),
  async (req: AuthedRequest, res) => {
    const params = idParam.safeParse(req.params)
    const parsed = UpdateSubStateInput.safeParse(req.body)
    if (!params.success || !parsed.success) {
      res.status(400).json({ error: 'invalid_request' })
      return
    }
    const auth = req.auth!
    const jobId = params.data.id
    const subState = parsed.data.subState

    // "ชำระแล้ว" is a statement that money was received. Taking money is the
    // counter's (§12.1 "รับเงินลูกค้า / ปิดบิล" has no technician tick), so
    // the technician may not assert it either — not even as a label.
    if (auth.role === 'technician' && subState === 'paid') {
      res.status(403).json({ error: 'forbidden', message: 'การบันทึกว่าชำระแล้วต้องทำโดยหน้าร้าน' })
      return
    }

    type Outcome =
      | { kind: 'ok'; result: UpdateSubStateResult }
      | { kind: 'not_found' }
      | { kind: 'invalid'; status: string }

    const outcome = await withShop(db, auth.shop, async (trx): Promise<Outcome> => {
      const job = await jobsRepo.lockForStatusChange(trx, jobId)
      if (!job) return { kind: 'not_found' }
      if (!isValidSubState(job.status, subState)) return { kind: 'invalid', status: job.status }

      await jobsRepo.setSubState(trx, jobId, subState)
      await writeAudit(trx, {
        shopId: auth.shop,
        actorId: auth.sub,
        action: 'job_sub_state_changed',
        entityType: 'jobs',
        entityId: jobId,
        before: { sub_state: job.sub_state },
        after: { sub_state: subState },
      })

      const facts = await jobsRepo.labelFactsOf(trx, jobId)
      return {
        kind: 'ok',
        result: {
          jobId,
          subState,
          label: cardLabelOf({
            subState,
            bayName: facts?.bay_name ?? null,
            bookingSlotStart: iso(facts?.booking_slot_start ?? null),
          }),
        },
      }
    })

    switch (outcome.kind) {
      case 'not_found':
        res.status(404).json({ error: 'job_not_found', message: 'ไม่พบใบงานนี้' })
        return
      case 'invalid':
        res.status(409).json({
          error: 'invalid_sub_state',
          message: `ป้าย "${subState === null ? '' : SUB_STATE_LABEL[subState]}" `
            + `ใช้กับงานสถานะ "${statusOf(outcome.status).label}" ไม่ได้`,
        })
        return
      default:
        res.json(outcome.result)
    }
  },
)
