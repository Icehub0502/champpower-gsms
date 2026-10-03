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
  type InvalidRequestError,
  StatusMoveReason,
  UpdateJobStatusInput,
  UpdateSubStateInput,
  type TodayJob,
  type TodayResponse,
  type UpdateJobStatusResult,
  type UpdateSubStateResult,
} from '@gsms/contracts/index.js'
import {
  allowedMovesFrom,
  canMoveTo,
  cardLabelOf,
  estMinutes,
  isValidSubState,
  kanbanColumnOf,
  kpisOf,
  moveRequiresReason,
  pulseOf,
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
import * as todayRepo from '../repositories/today.js'
import * as jobsRepo from '../repositories/jobs.js'
import { writeAudit } from '../services/audit.js'
import { fieldErrorsOf } from '../lib/fieldErrors.js'
import { roleMayMove, STATUS_WRITE_ROLES } from '../lib/statusAuthz.js'
import { BOARD_READ_ROLES } from './queue.js'
import { closeQuotationForJobEnd, jobBackToQuotedBlocked } from '../services/quotation.js'

export const kanbanRouter = asyncRouter()

// Who may move what (roles) is lib/statusAuthz.ts, shared with the job screen.
// Inside the status-writing roles, the sub-state endpoint below has one more
// check of its own (the technician may not assert "paid").

const idParam = z.object({ id: z.string().uuid() })

// Used only to produce the standard `fields` entry for a missing reason, so a
// missing reason reads exactly like any other missing field ('required').
const ReasonRequired = z.object({ reason: StatusMoveReason })

const EST_UNITS = new Set(['minute', 'hour', 'day'])
function estUnitOf(v: string | null): 'minute' | 'hour' | 'day' | null {
  return v !== null && EST_UNITS.has(v) ? (v as 'minute' | 'hour' | 'day') : null
}

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString())

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
 * A job that has EXITED — delivered, rejected or carout — is off this board the
 * moment it exits, not at the end of the day (DECISION-carout.md). That is
 * decided in the view job_board_state (migration 0018), not by a predicate here.
 *
 * NO BOOKINGS ON THIS BOARD (DECISION-7-today.md §1). A booking that has not
 * arrived is not a job, so it is not on the job board. The "รถมาถึงแล้ว"
 * button lives in exactly one place — the today's-appointments screen, Figma
 * 66 — because two ways into the same action are two code paths to test, and
 * several ways of creating a job is precisely what made the prototype's
 * duplicate-queue bug. Do not put a bookings array back here.
 */
kanbanRouter.get(
  '/jobs/today',
  requireAuth,
  requireRole(...BOARD_READ_ROLES),
  async (req: AuthedRequest, res) => {
    const now = Date.now()

    const role = req.auth!.role
    const data = await withShop(db, req.auth!.shop, async (trx) => {
      const [jobs, bays] = await Promise.all([
        todayRepo.boardJobs(trx),
        todayRepo.shopBays(trx),
      ])
      // ONE history query for every card on the board, not one per card.
      const history = await todayRepo.historyForJobs(trx, jobs.rows.map((r) => r.job_id))
      return { jobs, bays, history }
    })

    const cards: TodayJob[] = []
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
      // Where this card may go, for THIS caller: the transition table fed the
      // job's real history (stepping back from ready depends on whether
      // alignment happened), then the same role rule PATCH enforces. The
      // screen builds its menu and drop targets from this and nothing else —
      // one place decides, the same place that enforces.
      const allowedMoves = allowedMovesFrom({
        status: r.status as StatusKey,
        statusHistory: (data.history.get(r.job_id) ?? []).map((h) => ({
          status: h.status as StatusKey,
          changedAt: h.changedAt,
        })),
      }).filter((to) => roleMayMove(role, r.status, to))
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
        allowedMoves,
        movesNeedingReason: allowedMoves.filter((to) => moveRequiresReason(r.status, to)),
      }

      const column = kanbanColumnOf(r.status)
      // Every status queue_board admits has a column now: the only statuses
      // without one (delivered, rejected, carout — the exits) are exactly the
      // ones job_board_state keeps off the board. A null here would mean those two rules have
      // drifted apart — skip the row rather than send a card with no column.
      // But never SILENTLY: a status added later without a column would
      // otherwise make cars vanish from the board with nothing to show why.
      // The job id and status only — no name, phone or plate (CLAUDE.md §12).
      if (column === null) {
        console.warn(`[/api/jobs/today] skipped job ${r.job_id}: status "${r.status}" has no kanban column`)
        continue
      }
      cards.push({ ...common, column })
    }

    const body: TodayResponse = {
      jobs: cards,
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
    if (!params.success) {
      res.status(400).json({ error: 'invalid_request' })
      return
    }
    if (!parsed.success) {
      // Field codes only — never the submitted values (lib/fieldErrors.ts).
      const body: InvalidRequestError = {
        error: 'invalid_request',
        message: 'ข้อมูลที่ส่งมาไม่ถูกต้อง',
        fields: fieldErrorsOf(parsed.error),
      }
      res.status(400).json(body)
      return
    }
    const auth = req.auth!
    const jobId = params.data.id
    const { to, fromStatus } = parsed.data

    if (!roleMayMove(auth.role, fromStatus, to)) {
      res.status(403).json({
        error: 'forbidden',
        message: 'การรับหรือยกเลิกการตัดสินใจของลูกค้าต้องทำโดยหน้าร้าน',
      })
      return
    }

    // A reason is REQUIRED where packages/domain says so (undoing a delivery,
    // DECISION-carout.md §3) and REFUSED everywhere else, so text typed on
    // the screen is never accepted and then silently dropped. Judged against
    // fromStatus here; the transaction below refuses with 409 if the job is
    // not really in fromStatus, so the two can never disagree about the move.
    const needsReason = moveRequiresReason(fromStatus, to)
    if (needsReason !== (parsed.data.reason !== undefined)) {
      const fields = needsReason
        ? fieldErrorsOf(ReasonRequired.safeParse({}).error!)
        : { reason: ['not_allowed'] }
      const body: InvalidRequestError = {
        error: 'invalid_request',
        message: needsReason ? 'กรุณาระบุเหตุผล' : 'การย้ายสถานะนี้ไม่ต้องระบุเหตุผล',
        fields,
      }
      res.status(400).json(body)
      return
    }
    const reason = needsReason ? parsed.data.reason! : null

    type Outcome =
      | { kind: 'ok'; result: UpdateJobStatusResult }
      | { kind: 'not_found' }
      | { kind: 'status_changed'; current: string }
      | { kind: 'illegal'; from: string }
      | { kind: 'quotation_confirmed' }
      | { kind: 'decline_reason_required' }
      | { kind: 'decline_note_required' }

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
          statusHistory: history.map((h) => ({
            status: h.status as StatusKey,
            changedAt: h.changed_at.toISOString(),
          })),
        },
        to,
      )
      if (!legal) return { kind: 'illegal', from: job.status }

      // P3.1 owner decision 8: approved -> quoted (the "undo yes") is refused
      // while the job's quotation is confirmed ("signed") — a new revision or
      // an explicit undo-confirm is the way back, never a silent recompute.
      // packages/domain's canMoveTo above knows nothing about quotations, so
      // this is checked here, one level up, same as every other P3.1 rule
      // layered onto the existing job-status transition table.
      if (fromStatus === 'approved' && to === 'quoted' && await jobBackToQuotedBlocked(trx, jobId)) {
        return { kind: 'quotation_confirmed' }
      }

      // P3.1 Q1: a job ending without a repair closes its own live quotation,
      // in this SAME transaction. `rejected` with an issued quotation that
      // still has undecided lines additionally REQUIRES a reason — checked
      // here, before any write, so a refusal here leaves nothing half-done.
      if (to === 'rejected' || to === 'carout') {
        const close = await closeQuotationForJobEnd(
          trx, auth.shop, jobId, to, parsed.data.declineReason, parsed.data.declineNote, auth.sub,
        )
        if (close.action === 'refuse') {
          if (close.code === 'decline_reason_required') return { kind: 'decline_reason_required' }
          if (close.code === 'decline_note_required') return { kind: 'decline_note_required' }
          // 'decline_reason_not_allowed' cannot be reached here: the contract
          // (UpdateJobStatusInput.declineReason) never accepts chose_alternative.
        }
      }

      // A label that described the old status does not survive the move.
      const subState = subStateAfterMove(to, job.sub_state)

      await jobsRepo.applyStatus(trx, { jobId, status: to, subState })
      const historyRow = await jobsRepo.recordStatusHistory(trx, auth.shop, jobId, to, auth.sub, reason)

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
        },
      })

      // Undoing a delivery gets its own audit action so the owner can list
      // every undo without reading every status change. It records WHICH
      // history row holds the reason, never the reason itself: that is free
      // text staff may fill with a customer's name, and audit_logs carries no
      // personal data (services/audit.ts). The text lives on the history row
      // only (migration 0019).
      if (job.status === 'delivered' && to === 'ready') {
        await writeAudit(trx, {
          shopId: auth.shop,
          actorId: auth.sub,
          action: 'job_delivery_undone',
          entityType: 'jobs',
          entityId: jobId,
          before: { status: job.status },
          // The job is entity_id and the user is actor_id on the row itself;
          // `after` carries only what those columns cannot.
          after: { status: to, status_history_id: historyRow.id },
        })
      }

      return {
        kind: 'ok',
        result: {
          jobId,
          status: to,
          subState,
          column: kanbanColumnOf(to),
          statusChangedAt: historyRow.changedAt.toISOString(),
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
      case 'quotation_confirmed':
        res.status(409).json({
          error: 'quotation_confirmed',
          message: 'ใบเสนอราคายืนยันผลแล้ว ถอยกลับ "เสนอราคา" ไม่ได้ ต้องถอยการยืนยันหรือออกใบฉบับใหม่',
        })
        return
      case 'decline_reason_required':
        res.status(400).json({
          error: 'invalid_request',
          message: 'กรุณาเลือกเหตุผลที่ลูกค้าไม่เอา ก่อนปิดงาน',
          fields: { declineReason: ['required'] },
        })
        return
      case 'decline_note_required':
        res.status(400).json({
          error: 'invalid_request',
          message: 'กรุณาพิมพ์เหตุผลเพิ่มเติม',
          fields: { declineNote: ['required'] },
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
