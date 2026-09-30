/**
 * One job on its own, and today's delivered jobs.
 *
 *   GET /api/jobs/:id                           the job, its history (who, when,
 *                                               why), and where it may move next
 *   GET /api/jobs?status=delivered&date=today   paged list for finding a job
 *                                               to undo
 *
 * Why (DECISION-carout.md §3): "ส่งแล้ว" takes the card off /today and the TV
 * at once, so undoing a mistaken press needs somewhere that is NOT the board.
 * The undo itself is still PATCH /api/jobs/:id/status (routes/kanban.ts) — one
 * write path for every move; this file only reads.
 *
 * Mounted AFTER kanbanRouter: GET /api/jobs/today is kanban's, and `:id` here
 * only matches a uuid anyway. The legacy routes/jobs.ts (MySQL era) is not
 * mounted, so nothing collides with it.
 */
import { z } from 'zod'
import { withShop } from '@gsms/db/client.js'
import {
  DeliveredJobsPage,
  JobDetail,
  JobListQuery,
  type InvalidRequestError,
} from '@gsms/contracts/index.js'
import {
  allowedMovesFrom,
  isValidSubState,
  moveRequiresReason,
  statusLabelOf,
  type StatusKey,
  type SubState,
} from '@champpower/domain'
import { db } from '../lib/db.js'
import { requireAuth, requireRole, type AuthedRequest } from '../middleware/requireAuth.js'
import { asyncRouter } from '../middleware/asyncHandler.js'
import { fieldErrorsOf } from '../lib/fieldErrors.js'
import { bangkokToday, endOfDayExclusive, startOfDay } from '../lib/bangkokDate.js'
import * as detailRepo from '../repositories/jobDetail.js'
import { BOARD_READ_ROLES } from './queue.js'
import { roleMayMove } from '../lib/statusAuthz.js'

export const jobDetailRouter = asyncRouter()

const idParam = z.object({ id: z.string().uuid() })

const NOT_FOUND = { error: 'job_not_found', message: 'ไม่พบใบงานนี้' } as const

// ---------------------------------------------------------------------------
// GET /api/jobs?status=delivered&date=today
// ---------------------------------------------------------------------------

jobDetailRouter.get(
  '/jobs',
  requireAuth,
  requireRole(...BOARD_READ_ROLES),
  async (req: AuthedRequest, res) => {
    const parsed = JobListQuery.safeParse(req.query)
    if (!parsed.success) {
      const body: InvalidRequestError = {
        error: 'invalid_request',
        message: 'ตอนนี้ดูได้เฉพาะงานที่ส่งแล้ววันนี้ (status=delivered&date=today)',
        fields: fieldErrorsOf(parsed.error),
      }
      res.status(400).json(body)
      return
    }
    const { page, pageSize } = parsed.data
    const today = bangkokToday()

    const { rows, total } = await withShop(db, req.auth!.shop, (trx) =>
      detailRepo.deliveredBetween(trx, startOfDay(today), endOfDayExclusive(today), pageSize, (page - 1) * pageSize))

    res.json(DeliveredJobsPage.parse({
      items: rows.map((r) => ({
        jobId: r.job_id,
        jobNumber: r.job_number,
        queueNo: r.queue_no,
        plate: r.plate,
        province: r.province,
        brand: r.brand,
        model: r.model,
        customerName: r.customer_name,
        deliveredAt: r.delivered_at.toISOString(),
      })),
      page,
      pageSize,
      total,
    }))
  },
)

// ---------------------------------------------------------------------------
// GET /api/jobs/:id
// ---------------------------------------------------------------------------

/**
 * Another shop's job answers exactly like a job that does not exist — 404,
 * same body — because RLS never lets this shop's transaction see it. Nothing
 * here distinguishes "not yours" from "not there".
 */
jobDetailRouter.get(
  '/jobs/:id',
  requireAuth,
  requireRole(...BOARD_READ_ROLES),
  async (req: AuthedRequest, res) => {
    const params = idParam.safeParse(req.params)
    if (!params.success) {
      res.status(404).json(NOT_FOUND)
      return
    }
    const auth = req.auth!

    const data = await withShop(db, auth.shop, async (trx) => {
      const job = await detailRepo.jobById(trx, params.data.id)
      if (!job) return null
      const history = await detailRepo.historyWithActors(trx, job.job_id)
      return { job, history }
    })
    if (!data) {
      res.status(404).json(NOT_FOUND)
      return
    }
    const { job, history } = data

    // Same derivation as a /today card: the transition table fed the real
    // history, then the role rule PATCH enforces.
    const allowedMoves = allowedMovesFrom({
      status: job.status as StatusKey,
      statusHistory: history.map((h) => ({ status: h.status as StatusKey, changedAt: h.changed_at.toISOString() })),
    }).filter((to) => roleMayMove(auth.role, job.status, to))

    // parse() against the strict schema: a field that is not in the contract
    // is a 500 here, never a silent extra on the wire (CLAUDE.md §12.2).
    const body = JobDetail.parse({
      jobId: job.job_id,
      jobNumber: job.job_number,
      queueNo: job.queue_no,
      status: job.status,
      statusLabel: statusLabelOf(job.status),
      subState: isValidSubState(job.status, job.sub_state) ? (job.sub_state as SubState | null) : null,
      jobType: job.job_type === 'warranty_claim' ? 'warranty_claim' : 'normal',
      source: job.has_booking ? 'booked' : 'walk_in',
      plate: job.plate,
      province: job.province,
      brand: job.brand,
      model: job.model,
      color: job.color,
      customerName: job.customer_name,
      bayName: job.bay_name,
      createdAt: job.created_at.toISOString(),
      statusChangedAt: job.status_changed_at.toISOString(),
      onBoard: job.on_board,
      history: history.map((h) => ({
        status: h.status,
        // statusLabelOf, not statusOf: history is unconstrained (0017), and a
        // retired key such as 'scheduled' must show as itself, never as รับรถ.
        statusLabel: statusLabelOf(h.status),
        changedAt: h.changed_at.toISOString(),
        changedBy: h.changed_by === null ? null : { userId: h.changed_by, name: h.actor_name ?? '' },
        reason: h.reason,
      })),
      allowedMoves,
      movesNeedingReason: allowedMoves.filter((to) => moveRequiresReason(job.status, to)),
    })
    res.json(body)
  },
)
