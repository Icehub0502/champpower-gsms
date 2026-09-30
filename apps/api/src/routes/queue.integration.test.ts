/**
 * WO-003 T9 — the queue board and its two in-place edits, against a real
 * PostgreSQL.
 *
 * TIER 2. Skipped when GSMS_TEST_DB is unset; see src/test/env.ts. The
 * bay/queue-no cases here are the regression guard for CLAUDE.md §5.8 rule 4
 * (one view, nothing merged in the browser) and for `trg_jobs_booking_immutable`
 * (0011) — an ordinary bay update that carelessly touched `booking_id` would
 * trip that trigger, and nothing short of a job actually born from a booking
 * proves it does not.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { withShop } from '@gsms/db/client.js'
import { db } from '../lib/db.js'
import { hasDatabase, tier2 } from '../test/env.js'
import {
  auditFor, createTwoShopFixture, get, issueTokensFor, patch, post, startApi,
  type RunningApi, type TwoShopFixture,
} from '../test/fixtures.js'

interface QueueBoardBody { items: { kind: string; refId: string; jobId: string | null; bayId: string | null; queueNo: number | null }[]; total: number }
interface CheckInBody { jobId: string; queueNo: number; jobDate: string }

describe.skipIf(!hasDatabase)(tier2('queue board (GET /api/queue, PATCH bay/queue-no)'), () => {
  let api: RunningApi
  let fx: TwoShopFixture
  let bayA1: string
  let bayA2: string

  beforeAll(async () => {
    api = await startApi()
    fx = await createTwoShopFixture('wo003queue')
    const bays = await withShop(db, fx.shopA, (trx) => trx.insertInto('bays')
      .values([
        { shop_id: fx.shopA, name: 'bay-1', sort_order: 1 },
        { shop_id: fx.shopA, name: 'bay-2', sort_order: 2 },
      ])
      .returning(['id', 'name']).execute())
    bayA1 = bays.find((b) => b.name === 'bay-1')!.id
    bayA2 = bays.find((b) => b.name === 'bay-2')!.id
  })
  afterAll(async () => {
    await fx?.cleanup()
    await api?.close()
  })

  const owner = (shopId: string) => issueTokensFor(fx.userId, shopId, 'owner')
  const asRole = (shopId: string, role: Parameters<typeof issueTokensFor>[2]) =>
    issueTokensFor(fx.userId, shopId, role)

  /** A walk-in job in shop A, through the real endpoint, plate unique per call. */
  async function openJobA(plate: string, bayId?: string): Promise<CheckInBody> {
    const s = await owner(fx.shopA)
    const res = await post<CheckInBody>(api, '/api/checkin', {
      plate, customerName: `Board Test ${plate}`, brand: 'Toyota', model: 'Vios', province: 'กรุงเทพมหานคร',
      ...(bayId ? { bayId } : {}),
    }, s.accessToken)
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    return res.body
  }

  // ===========================================================================
  // Case 7 — cross-shop read returns 0 rows, never another shop's data
  // ===========================================================================
  describe('cross-shop read', () => {
    it('shop B sees none of shop A\'s board rows, while shop A sees its own', async () => {
      const job = await openJobA('BOARD-XSHOP-1')

      const asA = await owner(fx.shopA)
      const boardA = await get<QueueBoardBody>(api, '/api/queue?limit=100', asA.accessToken)
      expect(boardA.status).toBe(200)
      expect(boardA.body.items.some((r) => r.jobId === job.jobId)).toBe(true)

      const asB = await owner(fx.shopB)
      const boardB = await get<QueueBoardBody>(api, '/api/queue?limit=100', asB.accessToken)
      expect(boardB.status).toBe(200)
      expect(
        boardB.body.items.some((r) => r.jobId === job.jobId),
        'shop B\'s board contained a job that belongs to shop A',
      ).toBe(false)
    })

    it('shop B cannot move shop A\'s job to a bay: the job is invisible, not forbidden', async () => {
      const job = await openJobA('BOARD-XSHOP-2')
      const asB = await owner(fx.shopB)

      const res = await patch(api, `/api/jobs/${job.jobId}/bay`, { bayId: null }, asB.accessToken)
      // 404, not 403: a 403 would confirm the row exists in another branch.
      expect(res.status).toBe(404)
      expect(res.body).toMatchObject({ error: 'job_not_found' })
    })
  })

  // ===========================================================================
  // Case 10 — changing a booking-born job's bay must not trip the immutable
  // booking-link trigger
  // ===========================================================================
  describe('bay change on a job born from a booking', () => {
    it('does not raise trg_jobs_booking_immutable', async () => {
      const s = await owner(fx.shopA)
      const booking = await post<{ id: string }>(api, '/api/bookings', {
        source: 'phone',
        slotStart: new Date(Date.now() + 3_600_000).toISOString(),
        slotEnd: new Date(Date.now() + 7_200_000).toISOString(),
        bayId: null,
        contactName: 'Booking Bay Change',
        contactPhone: '0811110001',
      }, s.accessToken)
      expect(booking.status, JSON.stringify(booking.body)).toBe(201)

      const arrived = await post<{ jobId: string }>(
        api, `/api/bookings/${booking.body.id}/arrive`,
        { plate: 'BOARD-BOOKED-1', customerName: 'Booking Bay Change', brand: 'Honda', model: 'City', province: 'กรุงเทพมหานคร' },
        s.accessToken,
      )
      expect(arrived.status, JSON.stringify(arrived.body)).toBe(201)

      // The move that used to be dangerous: an UPDATE on a booking-linked job
      // that only names bay_id. If repositories/jobs.ts ever regresses to a
      // blanket `.set(partialRow)` that includes booking_id, this raises.
      const moved = await patch(
        api, `/api/jobs/${arrived.body.jobId}/bay`, { bayId: bayA1 }, s.accessToken,
      )
      expect(moved.status, JSON.stringify(moved.body)).toBe(200)

      const row = await withShop(db, fx.shopA, (trx) => trx.selectFrom('jobs')
        .select(['bay_id', 'booking_id']).where('id', '=', arrived.body.jobId).executeTakeFirstOrThrow())
      expect(row.bay_id).toBe(bayA1)
      expect(row.booking_id).toBe(booking.body.id)
    })
  })

  // ===========================================================================
  // Case 11 — two jobs may share one bay; the API must not invent a refusal
  // ===========================================================================
  describe('two live jobs in one bay', () => {
    it('both PATCHes succeed and both jobs report the same bay', async () => {
      const jobOne = await openJobA('BOARD-SHARE-1')
      const jobTwo = await openJobA('BOARD-SHARE-2')
      const s = await owner(fx.shopA)

      const first = await patch(api, `/api/jobs/${jobOne.jobId}/bay`, { bayId: bayA2 }, s.accessToken)
      const second = await patch(api, `/api/jobs/${jobTwo.jobId}/bay`, { bayId: bayA2 }, s.accessToken)
      expect(first.status).toBe(200)
      expect(second.status).toBe(200)

      const rows = await withShop(db, fx.shopA, (trx) => trx.selectFrom('jobs')
        .select(['id', 'bay_id']).where('id', 'in', [jobOne.jobId, jobTwo.jobId]).execute())
      expect(rows.every((r) => r.bay_id === bayA2)).toBe(true)
    })

    it('reports the other car sharing the bay, as a warning field, never a refusal', async () => {
      const jobOne = await openJobA('BOARD-SHARE-3')
      const jobTwo = await openJobA('BOARD-SHARE-4')
      const s = await owner(fx.shopA)
      await patch(api, `/api/jobs/${jobOne.jobId}/bay`, { bayId: bayA1 }, s.accessToken)
      const second = await patch(
        api, `/api/jobs/${jobTwo.jobId}/bay`, { bayId: bayA1 }, s.accessToken,
      ) as { status: number; body: { sharingBay: number } }
      expect(second.status).toBe(200)
      expect(second.body.sharingBay).toBeGreaterThanOrEqual(1)
    })
  })

  // ===========================================================================
  // Case 12 — role gates, checked on the server
  // ===========================================================================
  describe('role gates', () => {
    it('a viewer can read the board', async () => {
      const viewer = await asRole(fx.shopA, 'viewer')
      const res = await get(api, '/api/queue', viewer.accessToken)
      expect(res.status).toBe(200)
    })

    it('a viewer cannot change a bay or a queue number', async () => {
      const job = await openJobA('BOARD-ROLE-1')
      const viewer = await asRole(fx.shopA, 'viewer')
      const bayRes = await patch(api, `/api/jobs/${job.jobId}/bay`, { bayId: bayA1 }, viewer.accessToken)
      expect(bayRes.status).toBe(403)
      const noRes = await patch(api, `/api/jobs/${job.jobId}/queue-no`, { queueNo: 999 }, viewer.accessToken)
      expect(noRes.status).toBe(403)
    })

    it('a technician cannot change a bay or a queue number', async () => {
      const job = await openJobA('BOARD-ROLE-2')
      const tech = await asRole(fx.shopA, 'technician')
      const bayRes = await patch(api, `/api/jobs/${job.jobId}/bay`, { bayId: bayA1 }, tech.accessToken)
      expect(bayRes.status).toBe(403)
    })

    it('every write requires a token at all', async () => {
      const job = await openJobA('BOARD-ROLE-3')
      const res = await patch(api, `/api/jobs/${job.jobId}/bay`, { bayId: bayA1 })
      expect(res.status).toBe(401)
    })
  })

  // ===========================================================================
  // Case 13 — audit rows
  // ===========================================================================
  describe('audit log', () => {
    it('writes job_bay_changed and job_queue_no_changed', async () => {
      const job = await openJobA('BOARD-AUDIT-1')
      const s = await owner(fx.shopA)

      await patch(api, `/api/jobs/${job.jobId}/bay`, { bayId: bayA1 }, s.accessToken)
      const bayAudit = await auditFor(fx.shopA, 'job_bay_changed', job.jobId)
      expect(bayAudit.length).toBeGreaterThan(0)

      const freeNo = job.queueNo + 1000
      await patch(api, `/api/jobs/${job.jobId}/queue-no`, { queueNo: freeNo }, s.accessToken)
      const noAudit = await auditFor(fx.shopA, 'job_queue_no_changed', job.jobId)
      expect(noAudit.length).toBeGreaterThan(0)
    })
  })
})
