/**
 * WO — /today kanban, against a real PostgreSQL.
 *
 * TIER 2. Skipped when GSMS_TEST_DB is unset; see src/test/env.ts.
 *
 * Sources of truth for the assertions below: docs/WORK-ORDERS/DECISION-job-status.md
 * §2 (columns) and §4 (sub-states), docs/UI-SPEC-FIGMA.md §2 (KPI/pulse split
 * from the public board), and packages/domain/src/rules/kanban.ts (already unit
 * tested — this file proves the HTTP route and the database wire it up
 * correctly, not the pure functions again).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { withShop } from '@gsms/db/client.js'
import { canMoveTo, type MovableJob, type StatusHistoryEntry, type StatusKey } from '@champpower/domain'
import { db } from '../lib/db.js'
import { hasDatabase, tier2 } from '../test/env.js'
import {
  auditFor, createTwoShopFixture, get, issueTokensFor, patch, post, startApi,
  type RunningApi, type TwoShopFixture,
} from '../test/fixtures.js'

interface TodayJobRow {
  jobId: string; status: string; column: number | null; subState: string | null
  bookingSlotStart: string | null
}
interface TodayKpis { openJobs: number; awaitingDecision: number; inRepair: number; readyForHandover: number }
interface TodayBody {
  jobs: TodayJobRow[]
  kpis: TodayKpis
  truncated: boolean
}
interface CheckInBody { jobId: string; queueNo: number }
interface StatusMoveBody {
  jobId: string; status: string; subState: string | null; column: number | null
}

describe.skipIf(!hasDatabase)(tier2('/today kanban (GET /api/jobs/today, PATCH status/sub-state)'), () => {
  let api: RunningApi
  let fx: TwoShopFixture

  beforeAll(async () => {
    // A raised ceiling for THIS instance only — see CreateAppOptions in
    // ../app.ts. Every OTHER test file in this suite still starts a
    // production-shaped app via the plain `startApi()`, unmodified, and one
    // test below ("the real write limiter") starts a THIRD, separate instance
    // with no override at all to prove the real 120/min number still bites.
    api = await startApi({ intakeWriteLimit: 100_000 })
    fx = await createTwoShopFixture('wo006today')
  })
  afterAll(async () => {
    await fx?.cleanup()
    await api?.close()
  })

  const owner = (shopId: string) => issueTokensFor(fx.userId, shopId, 'owner')
  const asRole = (shopId: string, role: Parameters<typeof issueTokensFor>[2]) =>
    issueTokensFor(fx.userId, shopId, role)

  async function checkinOn(
    token: string, plate: string, extra: Record<string, unknown> = {},
  ): Promise<string> {
    const res = await post<CheckInBody>(api, '/api/checkin', {
      plate, customerName: `Today Test ${plate}`, brand: 'Toyota', model: 'Vios', province: 'กรุงเทพมหานคร', ...extra,
    }, token)
    expect(res.status, `setup: check-in for plate ${plate} failed: ${JSON.stringify(res.body)}`).toBe(201)
    return res.body.jobId
  }

  /** Bypasses the transition endpoint entirely — for seeding a KNOWN status, not for testing a move. */
  async function setStatusDirect(shopId: string, jobId: string, status: string): Promise<void> {
    await withShop(db, shopId, (trx) => trx.updateTable('jobs').set({ status }).where('id', '=', jobId).execute())
  }

  async function setCreatedAt(shopId: string, jobId: string, when: Date): Promise<void> {
    await withShop(db, shopId, (trx) => trx.updateTable('jobs').set({ created_at: when }).where('id', '=', jobId).execute())
  }

  async function jobRow(shopId: string, jobId: string) {
    return withShop(db, shopId, (trx) => trx.selectFrom('jobs')
      .select(['status', 'sub_state', 'booking_id', 'shop_id', 'job_number'])
      .where('id', '=', jobId).executeTakeFirstOrThrow())
  }

  /**
   * Put a job into a state for a test WITHOUT spending the write limiter.
   *
   * Every request in this file shares one in-process app instance (the one
   * `beforeAll` starts with a raised intake write limit — see the note there),
   * so this no longer burns rate-limiter budget. It burns something else that
   * matters more if left unchecked: walking straight to `writes: status, then
   * a pile of job_status_history rows` can invent a history the real API could
   * never have produced — a car that was never legally moved from `quoted` to
   * `repairing`, say. So before anything is written, EVERY step is replayed
   * through `canMoveTo()`, the exact function `PATCH /api/jobs/:id/status`
   * checks — the same one this file's "illegal moves" tests are busy proving
   * refuses bad moves. A `seedPath` that skipped this check could pass a test
   * against a fixture the production code would have rejected; this makes that
   * impossible: seedPath can only ever write a path the endpoint would also
   * have allowed, one legal step at a time.
   *
   * History timestamps are spaced one second apart, ending a minute ago, so
   * any move the test then makes through the API is recorded after them.
   */
  async function seedPath(shopId: string, jobId: string, statuses: string[]) {
    const last = statuses[statuses.length - 1]
    if (!last) throw new Error('seedPath needs at least one status')

    const start = Date.now() - 60_000 - statuses.length * 1000
    const history: StatusHistoryEntry[] = []
    let current: StatusKey = 'received'
    const rows: { status: string; changed_at: Date }[] = []
    for (let i = 0; i < statuses.length; i++) {
      const to = statuses[i]!
      const job: MovableJob = { status: current, statusHistory: history }
      if (!canMoveTo(job, to as StatusKey)) {
        throw new Error(
          `seedPath: ${current} -> ${to} is not a move canMoveTo() allows; refusing to invent history `
          + `(full path: received -> ${statuses.join(' -> ')})`,
        )
      }
      const changedAt = new Date(start + i * 1000)
      history.push({ status: to as StatusKey, changedAt: changedAt.toISOString() })
      rows.push({ status: to, changed_at: changedAt })
      current = to as StatusKey
    }

    await withShop(db, shopId, async (trx) => {
      await trx.updateTable('jobs').set({ status: last }).where('id', '=', jobId).execute()
      await trx.insertInto('job_status_history').values(rows.map((r) => ({
        shop_id: shopId, job_id: jobId, status: r.status, changed_at: r.changed_at,
      }))).execute()
    })
  }

  async function historyCount(shopId: string, jobId: string, status?: string): Promise<number> {
    return withShop(db, shopId, async (trx) => {
      let q = trx.selectFrom('job_status_history').select(({ fn }) => fn.count<number>('id').as('n'))
        .where('job_id', '=', jobId)
      if (status) q = q.where('status', '=', status)
      const row = await q.executeTakeFirstOrThrow()
      return Number(row.n)
    })
  }

  // ===========================================================================
  // Case 5 — job rows are never date-filtered
  // ===========================================================================
  describe('overnight cars stay on the board', () => {
    it('a job created yesterday and still open appears in /today', async () => {
      const s = await owner(fx.shopA)
      const jobId = await checkinOn(s.accessToken, 'TODAY-YEST-1')
      await setCreatedAt(fx.shopA, jobId, new Date(Date.now() - 25 * 3_600_000))

      const board = await get<TodayBody>(api, '/api/jobs/today', s.accessToken)
      expect(board.status).toBe(200)
      expect(board.body.jobs.some((j) => j.jobId === jobId)).toBe(true)
    })
  })

  // ===========================================================================
  // Case 6 — KPI and column placement from real statuses
  // ===========================================================================
  describe('KPI and column placement', () => {
    it('computes exact numbers from a known mix, and puts approved in column 3', async () => {
      // A fresh, isolated fixture: the KPI assertions below must be exact
      // counts, and the shared fixture above accumulates jobs across other
      // tests in this file.
      const iso = await createTwoShopFixture('wo006kpi')
      try {
        const s = await issueTokensFor(iso.userId, iso.shopA, 'owner')
        const plan: [string, string][] = [
          ['KPI-INSPECTING', 'inspecting'],
          ['KPI-QUOTED', 'quoted'],
          ['KPI-APPROVED', 'approved'],
          ['KPI-REPAIRING', 'repairing'],
          ['KPI-READY', 'ready'],
          ['KPI-DELIVERED', 'delivered'],
        ]
        const ids: Record<string, string> = {}
        for (const [plate, status] of plan) {
          const jobId = await checkinOn(s.accessToken, plate)
          await setStatusDirect(iso.shopA, jobId, status)
          ids[status] = jobId
        }

        const board = await get<TodayBody>(api, '/api/jobs/today', s.accessToken)
        expect(board.status, JSON.stringify(board.body)).toBe(200)
        expect(board.body.kpis).toEqual<TodayKpis>({
          openJobs: 5,          // every status but delivered
          awaitingDecision: 2,  // inspecting + quoted (column 2)
          inRepair: 2,          // approved + repairing (column 3)
          readyForHandover: 1,  // ready only
        })

        const approvedCard = board.body.jobs.find((j) => j.jobId === ids.approved)
        expect(approvedCard?.column, 'approved must sit in column 3, not 2').toBe(3)
        const quotedCard = board.body.jobs.find((j) => j.jobId === ids.quoted)
        expect(quotedCard?.column).toBe(2)
        const repairingCard = board.body.jobs.find((j) => j.jobId === ids.repairing)
        expect(repairingCard?.column).toBe(3)
      } finally {
        await iso.cleanup()
      }
    })
  })

  // ===========================================================================
  // Case 7 — not-yet-arrived bookings are NOT on the job board at all
  //
  // Rewritten 25 Sep 2026 for DECISION-7-today.md §1. This case used to assert
  // that such bookings came back in a separate `bookings` array; the owner then
  // took them off the board entirely — a booking that has not arrived is not a
  // job, and the "รถมาถึงแล้ว" button lives on the today's-appointments screen
  // (Figma 66) alone. The property the original case protected is kept: a
  // booking must never leak into the job rows or move a KPI.
  // ===========================================================================
  describe('bookings that have not arrived', () => {
    it('are not on the board in any form, and never move a KPI', async () => {
      const s = await owner(fx.shopA)
      const before = await get<TodayBody>(api, '/api/jobs/today', s.accessToken)
      const openBefore = before.body.kpis.openJobs

      const booking = await post<{ id: string }>(api, '/api/bookings', {
        source: 'phone',
        slotStart: new Date(Date.now() + 3_600_000).toISOString(),
        slotEnd: new Date(Date.now() + 7_200_000).toISOString(),
        bayId: null,
        contactName: 'Not Arrived Yet',
        contactPhone: '0899990001',
      }, s.accessToken)
      expect(booking.status, JSON.stringify(booking.body)).toBe(201)

      const after = await get<TodayBody>(api, '/api/jobs/today', s.accessToken)
      // Decision 1: the response has no bookings array to put it in. Checked on
      // the raw body, so re-adding the field anywhere turns this red.
      expect(after.body, 'a bookings array came back on the job board').not.toHaveProperty('bookings')
      expect(after.body).not.toHaveProperty('awaitingTakeDown')
      expect(
        after.body.jobs.some((j) => j.jobId === booking.body.id),
        'a not-yet-arrived booking leaked into the jobs array',
      ).toBe(false)
      expect(
        after.body.kpis.openJobs,
        'a not-yet-arrived booking was counted in a KPI',
      ).toBe(openBefore)
    })
  })

  // ===========================================================================
  // Case 8 — concurrent drag
  // ===========================================================================
  describe('concurrent status moves on one card', () => {
    it('exactly one 200, one 409 status_changed, and exactly one new history row', async () => {
      const s = await owner(fx.shopA)
      const jobId = await checkinOn(s.accessToken, 'RACE-STATUS-1')

      const moveOnce = () => patch<StatusMoveBody>(
        api, `/api/jobs/${jobId}/status`, { to: 'inspecting', fromStatus: 'received' }, s.accessToken,
      )
      const [a, b] = await Promise.all([moveOnce(), moveOnce()])
      const statuses = [a.status, b.status].sort()
      expect(statuses, JSON.stringify({ a, b })).toEqual([200, 409])

      const loser = a.status === 409 ? a : b
      expect(loser.body).toMatchObject({ error: 'status_changed', currentStatus: 'inspecting' })

      const n = await historyCount(fx.shopA, jobId, 'inspecting')
      expect(n, 'more than one history row was written for the same move').toBe(1)
    })
  })

  // ===========================================================================
  // Case 9 — illegal moves refused server-side, nothing written
  // ===========================================================================
  describe('illegal moves', () => {
    it('refuses inspecting -> approved (skipping the quote) with 409, and writes nothing', async () => {
      const s = await owner(fx.shopA)
      const jobId = await checkinOn(s.accessToken, 'ILLEGAL-1')
      const setup = await patch(api, `/api/jobs/${jobId}/status`, { to: 'inspecting', fromStatus: 'received' }, s.accessToken)
      expect(setup.status, `setup move to inspecting failed: ${JSON.stringify(setup.body)}`).toBe(200)
      const before = await jobRow(fx.shopA, jobId)
      const historyBefore = await historyCount(fx.shopA, jobId)

      const res = await patch(api, `/api/jobs/${jobId}/status`, { to: 'approved', fromStatus: 'inspecting' }, s.accessToken)
      expect(res.status).toBe(409)
      expect(res.body).toMatchObject({ error: 'illegal_status_move' })

      const after = await jobRow(fx.shopA, jobId)
      expect(after.status).toBe(before.status)
      expect(await historyCount(fx.shopA, jobId)).toBe(historyBefore)
    })

    it('refuses repairing -> quoted (column 3 to column 2) with 409, and writes nothing', async () => {
      const s = await owner(fx.shopA)
      const jobId = await checkinOn(s.accessToken, 'ILLEGAL-2')
      for (const to of ['inspecting', 'quoted', 'approved', 'repairing']) {
        const move = await patch(api, `/api/jobs/${jobId}/status`, { to, fromStatus: (await jobRow(fx.shopA, jobId)).status }, s.accessToken)
        expect(move.status, `setup move to ${to} failed: ${JSON.stringify(move.body)}`).toBe(200)
      }
      const historyBefore = await historyCount(fx.shopA, jobId)

      const res = await patch(api, `/api/jobs/${jobId}/status`, { to: 'quoted', fromStatus: 'repairing' }, s.accessToken)
      expect(res.status).toBe(409)
      expect(res.body).toMatchObject({ error: 'illegal_status_move' })

      const after = await jobRow(fx.shopA, jobId)
      expect(after.status).toBe('repairing')
      expect(await historyCount(fx.shopA, jobId)).toBe(historyBefore)
    })

    it('refuses every move out of rejected — it is terminal (decision 6)', async () => {
      const s = await owner(fx.shopA)
      const jobId = await checkinOn(s.accessToken, 'TERMINAL-1')
      await seedPath(fx.shopA, jobId, ['inspecting', 'quoted', 'rejected'])
      const historyBefore = await historyCount(fx.shopA, jobId)

      // Neither the old rejected -> carout step nor a step back to quoted.
      for (const to of ['carout', 'quoted']) {
        const res = await patch(api, `/api/jobs/${jobId}/status`, { to, fromStatus: 'rejected' }, s.accessToken)
        expect(res.status, `rejected -> ${to} was allowed`).toBe(409)
        expect(res.body).toMatchObject({ error: 'illegal_status_move' })
      }
      expect((await jobRow(fx.shopA, jobId)).status).toBe('rejected')
      expect(await historyCount(fx.shopA, jobId)).toBe(historyBefore)
    })

    it('refuses a status that no longer exists', async () => {
      const s = await owner(fx.shopA)
      const jobId = await checkinOn(s.accessToken, 'NOSCHED-1')
      // 'scheduled' is not a job status any more (decision 6): refused at the
      // schema edge as an invalid request, before any rule is consulted.
      const res = await patch(api, `/api/jobs/${jobId}/status`, { to: 'scheduled', fromStatus: 'received' }, s.accessToken)
      expect(res.status).toBe(400)
      expect((await jobRow(fx.shopA, jobId)).status).toBe('received')
    })
  })

  // ===========================================================================
  // Decision 7 — alignment is optional
  // ===========================================================================
  describe('skipping alignment', () => {
    it('allows repairing -> ready directly, and the step back returns to repairing', async () => {
      const s = await owner(fx.shopA)
      const jobId = await checkinOn(s.accessToken, 'SKIPALIGN-1')
      await seedPath(fx.shopA, jobId, ['inspecting', 'quoted', 'approved', 'repairing'])

      const skip = await patch(api, `/api/jobs/${jobId}/status`, { to: 'ready', fromStatus: 'repairing' }, s.accessToken)
      expect(skip.status, JSON.stringify(skip.body)).toBe(200)
      expect(skip.body).toMatchObject({ status: 'ready', column: 4 })

      // Back from ready must go where the car actually came from — history says
      // repairing, so aligning (a step it never visited) is refused.
      const toAligning = await patch(api, `/api/jobs/${jobId}/status`, { to: 'aligning', fromStatus: 'ready' }, s.accessToken)
      expect(toAligning.status).toBe(409)
      const back = await patch(api, `/api/jobs/${jobId}/status`, { to: 'repairing', fromStatus: 'ready' }, s.accessToken)
      expect(back.status, JSON.stringify(back.body)).toBe(200)
    })
  })

  // ===========================================================================
  // Code review of decisions 6/7 — the fixes, pinned at the endpoint
  // ===========================================================================
  describe('code review fixes', () => {
    it('HIGH: an un-delivered car that skipped alignment steps back to repairing, never to aligning', async () => {
      // The bug: after delivered -> ready, the step back answered "aligning" — a
      // step this car never had — and refused "repairing", the one it did.
      const s = await owner(fx.shopA)
      const jobId = await checkinOn(s.accessToken, 'CR-UNDELIVER-1')
      await seedPath(fx.shopA, jobId, ['inspecting', 'quoted', 'approved', 'repairing', 'ready', 'delivered', 'ready'])

      const toAligning = await patch(api, `/api/jobs/${jobId}/status`, { to: 'aligning', fromStatus: 'ready' }, s.accessToken)
      expect(toAligning.status, 'offered an alignment the car never had').toBe(409)
      const toRepairing = await patch(api, `/api/jobs/${jobId}/status`, { to: 'repairing', fromStatus: 'ready' }, s.accessToken)
      expect(toRepairing.status, JSON.stringify(toRepairing.body)).toBe(200)
    })

    it('ready -> carout is refused: a finished car leaving is a delivery', async () => {
      const s = await owner(fx.shopA)
      const jobId = await checkinOn(s.accessToken, 'CR-READYOUT-1')
      await seedPath(fx.shopA, jobId, ['inspecting', 'quoted', 'approved', 'repairing', 'ready'])
      const res = await patch(api, `/api/jobs/${jobId}/status`, { to: 'carout', fromStatus: 'ready' }, s.accessToken)
      expect(res.status).toBe(409)
      expect(res.body).toMatchObject({ error: 'illegal_status_move' })
    })

    // The carout / rejected / delivered rules of DECISION-carout.md are proven
    // in exits.integration.test.ts; the two cases that lived here (carout mid-
    // repair allowed, and allowed to a technician) are now the opposite rule.
  })

  // ===========================================================================
  // Case 10 — a legal move writes history + audit, and clears a stale sub-state
  // ===========================================================================
  describe('a legal move', () => {
    it('writes job_status_history and an audit row, and clears a sub-state that no longer fits', async () => {
      const s = await owner(fx.shopA)
      const jobId = await checkinOn(s.accessToken, 'LEGALMOVE-1')
      const setup1 = await patch(api, `/api/jobs/${jobId}/status`, { to: 'inspecting', fromStatus: 'received' }, s.accessToken)
      expect(setup1.status, `setup move to inspecting failed: ${JSON.stringify(setup1.body)}`).toBe(200)
      const setup2 = await patch(api, `/api/jobs/${jobId}/status`, { to: 'quoted', fromStatus: 'inspecting' }, s.accessToken)
      expect(setup2.status, `setup move to quoted failed: ${JSON.stringify(setup2.body)}`).toBe(200)

      const labelled = await patch<{ subState: string | null }>(
        api, `/api/jobs/${jobId}/sub-state`, { subState: 'quote_sent' }, s.accessToken,
      )
      expect(labelled.status, JSON.stringify(labelled.body)).toBe(200)

      const moved = await patch<StatusMoveBody>(
        api, `/api/jobs/${jobId}/status`, { to: 'approved', fromStatus: 'quoted' }, s.accessToken,
      )
      expect(moved.status, JSON.stringify(moved.body)).toBe(200)
      // 'quote_sent' is not a valid sub-state for 'approved' — it must not survive the move.
      expect(moved.body.subState, 'a stale sub-state survived the move').toBeNull()

      expect(await historyCount(fx.shopA, jobId, 'approved')).toBe(1)
      const statusAudit = await auditFor(fx.shopA, 'job_status_changed', jobId)
      expect(statusAudit.length).toBeGreaterThan(0)
      const subStateAudit = await auditFor(fx.shopA, 'job_sub_state_changed', jobId)
      expect(subStateAudit.length).toBeGreaterThan(0)

      const row = await jobRow(fx.shopA, jobId)
      expect(row.sub_state).toBeNull()
    })
  })

  // ===========================================================================
  // Case 11 — role gates
  // ===========================================================================
  describe('role gates', () => {
    it('a technician may advance repairing -> aligning', async () => {
      const s = await owner(fx.shopA)
      const jobId = await checkinOn(s.accessToken, 'ROLE-TECH-ADVANCE-1')
      for (const to of ['inspecting', 'quoted', 'approved', 'repairing']) {
        const move = await patch(api, `/api/jobs/${jobId}/status`, { to, fromStatus: (await jobRow(fx.shopA, jobId)).status }, s.accessToken)
        expect(move.status, `setup move to ${to} failed: ${JSON.stringify(move.body)}`).toBe(200)
      }
      const tech = await asRole(fx.shopA, 'technician')
      const res = await patch(api, `/api/jobs/${jobId}/status`, { to: 'aligning', fromStatus: 'repairing' }, tech.accessToken)
      expect(res.status, JSON.stringify(res.body)).toBe(200)
    })

    it('a technician may not move quoted -> approved: that is the customer\'s decision', async () => {
      const s = await owner(fx.shopA)
      const jobId = await checkinOn(s.accessToken, 'ROLE-TECH-DECISION-1')
      const setup1 = await patch(api, `/api/jobs/${jobId}/status`, { to: 'inspecting', fromStatus: 'received' }, s.accessToken)
      expect(setup1.status, `setup move to inspecting failed: ${JSON.stringify(setup1.body)}`).toBe(200)
      const setup2 = await patch(api, `/api/jobs/${jobId}/status`, { to: 'quoted', fromStatus: 'inspecting' }, s.accessToken)
      expect(setup2.status, `setup move to quoted failed: ${JSON.stringify(setup2.body)}`).toBe(200)

      const tech = await asRole(fx.shopA, 'technician')
      const res = await patch(api, `/api/jobs/${jobId}/status`, { to: 'approved', fromStatus: 'quoted' }, tech.accessToken)
      expect(res.status).toBe(403)
      expect(res.body).toMatchObject({ error: 'forbidden' })

      const row = await jobRow(fx.shopA, jobId)
      expect(row.status).toBe('quoted')
    })

    it('a technician may not set sub-state "paid"', async () => {
      const s = await owner(fx.shopA)
      const jobId = await checkinOn(s.accessToken, 'ROLE-TECH-PAID-1')
      for (const to of ['inspecting', 'quoted', 'approved', 'repairing', 'aligning', 'ready']) {
        const move = await patch(api, `/api/jobs/${jobId}/status`, { to, fromStatus: (await jobRow(fx.shopA, jobId)).status }, s.accessToken)
        expect(move.status, `setup move to ${to} failed: ${JSON.stringify(move.body)}`).toBe(200)
      }
      const tech = await asRole(fx.shopA, 'technician')
      const res = await patch(api, `/api/jobs/${jobId}/sub-state`, { subState: 'paid' }, tech.accessToken)
      expect(res.status).toBe(403)
      expect(res.body).toMatchObject({ error: 'forbidden' })
    })

    it('a viewer gets 403 on both PATCH routes', async () => {
      const s = await owner(fx.shopA)
      const jobId = await checkinOn(s.accessToken, 'ROLE-VIEWER-1')
      const viewer = await asRole(fx.shopA, 'viewer')
      const statusRes = await patch(api, `/api/jobs/${jobId}/status`, { to: 'inspecting', fromStatus: 'received' }, viewer.accessToken)
      expect(statusRes.status).toBe(403)
      const subRes = await patch(api, `/api/jobs/${jobId}/sub-state`, { subState: 'call_customer' }, viewer.accessToken)
      expect(subRes.status).toBe(403)
    })

    it('an accountant gets 403 on both PATCH routes', async () => {
      const s = await owner(fx.shopA)
      const jobId = await checkinOn(s.accessToken, 'ROLE-ACCOUNTANT-1')
      const accountant = await asRole(fx.shopA, 'accountant')
      const statusRes = await patch(api, `/api/jobs/${jobId}/status`, { to: 'inspecting', fromStatus: 'received' }, accountant.accessToken)
      expect(statusRes.status).toBe(403)
      const subRes = await patch(api, `/api/jobs/${jobId}/sub-state`, { subState: 'call_customer' }, accountant.accessToken)
      expect(subRes.status).toBe(403)
    })
  })

  // ===========================================================================
  // Case 12 — cross-shop
  // ===========================================================================
  describe('cross-shop', () => {
    it('shop B\'s board never lists shop A\'s job, while shop A\'s own board does', async () => {
      const s = await owner(fx.shopA)
      const jobId = await checkinOn(s.accessToken, 'XSHOP-KANBAN-GET-1')

      const boardA = await get<TodayBody>(api, '/api/jobs/today', s.accessToken)
      expect(boardA.body.jobs.some((j) => j.jobId === jobId)).toBe(true)

      const asB = await owner(fx.shopB)
      const boardB = await get<TodayBody>(api, '/api/jobs/today', asB.accessToken)
      expect(
        boardB.body.jobs.some((j) => j.jobId === jobId),
        'shop B\'s kanban contained a job that belongs to shop A',
      ).toBe(false)
    })

    it('shop B acting on shop A\'s job id gets 404 on PATCH status, and nothing is written', async () => {
      const s = await owner(fx.shopA)
      const jobId = await checkinOn(s.accessToken, 'XSHOP-KB-STAT-1')
      const before = await jobRow(fx.shopA, jobId)
      const historyBefore = await historyCount(fx.shopA, jobId)

      const asB = await owner(fx.shopB)
      const res = await patch(api, `/api/jobs/${jobId}/status`, { to: 'inspecting', fromStatus: 'received' }, asB.accessToken)
      expect(res.status).toBe(404)
      expect(res.body).toMatchObject({ error: 'job_not_found' })

      const after = await jobRow(fx.shopA, jobId)
      expect(after.status).toBe(before.status)
      expect(await historyCount(fx.shopA, jobId)).toBe(historyBefore)
    })

    it('shop B acting on shop A\'s job id gets 404 on PATCH sub-state, and nothing is written', async () => {
      const s = await owner(fx.shopA)
      const jobId = await checkinOn(s.accessToken, 'XSHOP-KB-SUB-1')
      const before = await jobRow(fx.shopA, jobId)

      const asB = await owner(fx.shopB)
      const res = await patch(api, `/api/jobs/${jobId}/sub-state`, { subState: 'call_customer' }, asB.accessToken)
      expect(res.status).toBe(404)
      expect(res.body).toMatchObject({ error: 'job_not_found' })

      const after = await jobRow(fx.shopA, jobId)
      expect(after.sub_state).toBe(before.sub_state)
    })
  })

  // ===========================================================================
  // Case 13 — mass assignment
  // ===========================================================================
  describe('mass assignment', () => {
    it('cannot set booking_id, shop_id or job_number through the status PATCH body', async () => {
      const s = await owner(fx.shopA)
      const jobId = await checkinOn(s.accessToken, 'MASSASSIGN-1')
      const before = await jobRow(fx.shopA, jobId)

      const foreignId = fx.shopB
      const res = await patch(api, `/api/jobs/${jobId}/status`, {
        to: 'inspecting', fromStatus: 'received',
        bookingId: '00000000-0000-0000-0000-000000000000',
        shopId: foreignId,
        jobNumber: 'HACKED-0001',
      }, s.accessToken)
      expect(res.status, JSON.stringify(res.body)).toBe(200)

      const after = await jobRow(fx.shopA, jobId)
      expect(after.booking_id).toBe(before.booking_id)
      expect(after.shop_id).toBe(before.shop_id)
      expect(after.job_number).toBe(before.job_number)
    })

    it('cannot set booking_id, shop_id, job_number or status through the sub-state PATCH body', async () => {
      const s = await owner(fx.shopA)
      const jobId = await checkinOn(s.accessToken, 'MASSASSIGN-2')
      // A valid sub-state needs a status that allows it; 'received' allows
      // none (see SUB_STATES_BY_STATUS), so move to 'inspecting' first, where
      // 'call_customer' is valid.
      const setup = await patch(api, `/api/jobs/${jobId}/status`, { to: 'inspecting', fromStatus: 'received' }, s.accessToken)
      expect(setup.status, `setup move to inspecting failed: ${JSON.stringify(setup.body)}`).toBe(200)
      const before = await jobRow(fx.shopA, jobId)

      const foreignId = fx.shopB
      const res = await patch(api, `/api/jobs/${jobId}/sub-state`, {
        subState: 'call_customer',
        bookingId: '00000000-0000-0000-0000-000000000000',
        shopId: foreignId,
        jobNumber: 'HACKED-0002',
        status: 'delivered',
      }, s.accessToken)
      expect(res.status, JSON.stringify(res.body)).toBe(200)

      const after = await jobRow(fx.shopA, jobId)
      expect(after.sub_state).toBe('call_customer') // the one field the body is allowed to change
      expect(after.booking_id).toBe(before.booking_id)
      expect(after.shop_id).toBe(before.shop_id)
      expect(after.job_number).toBe(before.job_number)
      expect(after.status, 'a "status" field in the sub-state body changed the job\'s status').toBe(before.status)
    })
  })

  // ===========================================================================
  // The real write limiter — proved on an UNMODIFIED app instance
  // ===========================================================================
  describe('the real write limiter', () => {
    /**
     * Every other test in this file runs against `api`, started with a raised
     * `intakeWriteLimit` so setup does not spend the real budget (see
     * `beforeAll` and `seedPath` above). That raised ceiling is the whole
     * reason this test has to start its OWN app, with NO override: proving
     * "the limiter still works" against an instance that has been told to
     * ignore it would prove nothing.
     */
    it('answers 429 on the 121st intake write within a minute, on a plain instance', async () => {
      const plain = await startApi()
      try {
        const s = await owner(fx.shopA)
        let last: Awaited<ReturnType<typeof post>> | undefined
        for (let i = 0; i < 121; i++) {
          last = await post(plain, '/api/checkin', {
            plate: `LIMIT-${i}`, customerName: 'Limiter Test', brand: 'Toyota', model: 'Vios', province: 'กรุงเทพมหานคร',
          }, s.accessToken)
          if (last.status === 429) break
        }
        expect(last?.status, 'the 120/min intake write limiter never engaged within 121 writes').toBe(429)
        expect(last?.body).toMatchObject({ error: 'too_many_requests' })
      } finally {
        await plain.close()
      }
    })
  })
})
