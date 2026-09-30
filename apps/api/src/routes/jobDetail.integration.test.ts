/**
 * GET /api/jobs/:id and GET /api/jobs?status=delivered&date=today — where a job
 * that has left the boards can still be found and its delivery undone.
 *
 * TIER 2. Skipped when GSMS_TEST_DB is unset; see src/test/env.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { withShop } from '@gsms/db/client.js'
import { DeliveredJobsPage, JobDetail } from '@gsms/contracts/index.js'
import { db } from '../lib/db.js'
import { bangkokToday, endOfDayExclusive, startOfDay } from '../lib/bangkokDate.js'
import { deliveredBetween } from '../repositories/jobDetail.js'
import { hasDatabase, tier2 } from '../test/env.js'
import {
  createTwoShopFixture, get, issueTokensFor, patch, post, startApi,
  type RunningApi, type TwoShopFixture,
} from '../test/fixtures.js'

type Role = Parameters<typeof issueTokensFor>[2]

describe.skipIf(!hasDatabase)(tier2('job detail and today\'s delivered list'), () => {
  let api: RunningApi
  let fx: TwoShopFixture

  beforeAll(async () => {
    api = await startApi()
    fx = await createTwoShopFixture('jobdetail')
  })
  afterAll(async () => {
    await fx?.cleanup()
    await api?.close()
  })

  const tokenAs = async (role: Role, shop = fx.shopA) =>
    (await issueTokensFor(fx.userId, shop, role)).accessToken

  let seq = 0
  async function openJob(extra: Record<string, unknown> = {}): Promise<string> {
    seq++
    const res = await post<{ jobId: string }>(api, '/api/checkin', {
      plate: `จจ ${String(3000 + seq)}`, customerName: 'ทดสอบ', brand: 'Toyota', model: 'Vios',
      province: 'กรุงเทพมหานคร', ...extra,
    }, await tokenAs('owner'))
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    return res.body.jobId
  }

  async function seedPath(jobId: string, statuses: string[], endAt = Date.now() - 1000) {
    const last = statuses[statuses.length - 1]!
    const start = endAt - statuses.length * 1000
    await withShop(db, fx.shopA, async (trx) => {
      await trx.updateTable('jobs').set({ status: last }).where('id', '=', jobId).execute()
      await trx.insertInto('job_status_history').values(statuses.map((status, i) => ({
        shop_id: fx.shopA, job_id: jobId, status, changed_at: new Date(start + (i + 1) * 1000),
      }))).execute()
    })
  }

  /** A job delivered THROUGH THE API, so its last history row names the user. */
  async function deliveredViaApi(): Promise<string> {
    const jobId = await openJob()
    await seedPath(jobId, ['inspecting', 'quoted', 'approved', 'repairing', 'ready'])
    const res = await patch(api, `/api/jobs/${jobId}/status`, { to: 'delivered', fromStatus: 'ready' }, await tokenAs('advisor'))
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    return jobId
  }

  describe('GET /api/jobs/:id', () => {
    it('returns a delivered job — off the board — with who delivered it, and the undo that needs a reason', async () => {
      const jobId = await deliveredViaApi()
      const res = await get(api, `/api/jobs/${jobId}`, await tokenAs('advisor'))
      expect(res.status, JSON.stringify(res.body)).toBe(200)
      const body = JobDetail.parse(res.body) // strict: no field outside the contract
      expect(body.status).toBe('delivered')
      expect(body.onBoard).toBe(false)
      expect(body.allowedMoves).toEqual(['ready'])
      expect(body.movesNeedingReason).toEqual(['ready'])

      const last = body.history[body.history.length - 1]!
      expect(last.status).toBe('delivered')
      expect(last.changedBy?.userId).toBe(fx.userId)
      expect(typeof last.changedBy?.name).toBe('string')
      expect(last.reason).toBeNull()
      // Seeded rows carry no actor; they must say so, not invent one.
      expect(body.history[0]!.changedBy).toBeNull()
    })

    it('offers the undo to the technician too (same roles as delivered), and to no read-only role', async () => {
      const jobId = await deliveredViaApi()
      const tech = await get<{ allowedMoves: string[] }>(api, `/api/jobs/${jobId}`, await tokenAs('technician'))
      expect(tech.body.allowedMoves).toEqual(['ready'])
      const viewer = await get<{ allowedMoves: string[]; movesNeedingReason: string[] }>(
        api, `/api/jobs/${jobId}`, await tokenAs('viewer'))
      expect(viewer.status).toBe(200)
      expect(viewer.body.allowedMoves).toEqual([])
      expect(viewer.body.movesNeedingReason).toEqual([])
    })

    it('never carries the user\'s login id or the customer\'s phone — asserted on raw text', async () => {
      const PHONE = '0877776655'
      const jobId = await openJob({ customerPhone: PHONE })
      await patch(api, `/api/jobs/${jobId}/status`, { to: 'inspecting', fromStatus: 'received' }, await tokenAs('advisor'))
      const raw = await fetch(`${api.url}/api/jobs/${jobId}`, {
        headers: { authorization: `Bearer ${await tokenAs('advisor')}` },
      })
      const text = await raw.text()
      expect(raw.status).toBe(200)
      expect(text).toContain(fx.userId) // the actor is there...
      expect(text).not.toContain(fx.loginId) // ...by name, never by login
      expect(text).not.toContain(PHONE)
    })

    it('shop B gets 404 for shop A\'s job — the same answer as a job that does not exist', async () => {
      const jobId = await openJob()
      const other = await get(api, `/api/jobs/${jobId}`, await tokenAs('owner', fx.shopB))
      const missing = await get(api, '/api/jobs/00000000-0000-4000-8000-000000000000', await tokenAs('owner', fx.shopB))
      expect(other.status).toBe(404)
      expect(missing.status).toBe(404)
      expect(other.body).toEqual(missing.body)
    })

    it('labels a retired status in history as itself, never as รับรถ (MEDIUM, code review)', async () => {
      const jobId = await openJob()
      // An imported prototype row: 'scheduled' is no job status any more, but
      // history is deliberately unconstrained (0017) and keeps what happened.
      await seedPath(jobId, ['scheduled', 'inspecting'])
      const res = await get(api, `/api/jobs/${jobId}`, await tokenAs('advisor'))
      expect(res.status, JSON.stringify(res.body)).toBe(200)
      const body = JobDetail.parse(res.body)
      const scheduled = body.history.find((h) => h.status === 'scheduled')
      expect(scheduled?.statusLabel).toBe('scheduled')
      expect(body.history.find((h) => h.status === 'inspecting')?.statusLabel).toBe('ตรวจเช็ก')
    })

    it('a malformed id is 404, not 400 — nothing to learn from the difference', async () => {
      const res = await get(api, '/api/jobs/not-a-uuid', await tokenAs('owner'))
      expect(res.status).toBe(404)
    })

    it('does not take over GET /api/jobs/today', async () => {
      const res = await get<{ jobs: unknown[] }>(api, '/api/jobs/today', await tokenAs('owner'))
      expect(res.status).toBe(200)
      expect(Array.isArray(res.body.jobs)).toBe(true)
    })
  })

  describe('GET /api/jobs?status=delivered&date=today', () => {
    it('lists jobs delivered today, newest first, and nothing else', async () => {
      const a = await deliveredViaApi()
      const b = await deliveredViaApi()
      const stillReady = await openJob()
      await seedPath(stillReady, ['inspecting', 'quoted', 'approved', 'repairing', 'ready'])
      const yesterday = await openJob()
      await seedPath(yesterday, ['inspecting', 'quoted', 'approved', 'repairing', 'ready', 'delivered'],
        Date.now() - 30 * 3_600_000)

      const res = await get(api, '/api/jobs?status=delivered&date=today&pageSize=50', await tokenAs('advisor'))
      expect(res.status, JSON.stringify(res.body)).toBe(200)
      const page = DeliveredJobsPage.parse(res.body)
      const ids = page.items.map((i) => i.jobId)
      expect(ids).toContain(a)
      expect(ids).toContain(b)
      expect(ids.indexOf(b)).toBeLessThan(ids.indexOf(a))
      expect(ids).not.toContain(stillReady)
      expect(ids).not.toContain(yesterday)
      expect(page.total).toBe(page.items.length)
    })

    it('pages: pageSize 1 returns one item and the full total', async () => {
      await deliveredViaApi()
      await deliveredViaApi()
      const res = await get(api, '/api/jobs?status=delivered&date=today&page=1&pageSize=1', await tokenAs('advisor'))
      const page = DeliveredJobsPage.parse(res.body)
      expect(page.items).toHaveLength(1)
      expect(page.total).toBeGreaterThanOrEqual(2)
      const second = DeliveredJobsPage.parse(
        (await get(api, '/api/jobs?status=delivered&date=today&page=2&pageSize=1', await tokenAs('advisor'))).body)
      expect(second.items[0]!.jobId).not.toBe(page.items[0]!.jobId)
    })

    it('cuts the day at Bangkok midnight: 23:59 +07 is yesterday, 00:01 +07 is today', async () => {
      const today = bangkokToday()
      const midnight = startOfDay(today).getTime() // 00:00 +07 today
      const before = await openJob()
      await seedPath(before, ['inspecting', 'quoted', 'approved', 'repairing', 'ready', 'delivered'], midnight - 60_000)
      const after = await openJob()
      await seedPath(after, ['inspecting', 'quoted', 'approved', 'repairing', 'ready', 'delivered'], midnight + 60_000)

      const page = DeliveredJobsPage.parse(
        (await get(api, '/api/jobs?status=delivered&date=today&pageSize=50', await tokenAs('advisor'))).body)
      const ids = page.items.map((i) => i.jobId)
      expect(ids, '00:01 +07 today is missing').toContain(after)
      expect(ids, '23:59 +07 yesterday leaked into today').not.toContain(before)
    })

    it('the day\'s range is exactly [00:00 +07, next 00:00 +07) — both edges, on a fixed date', async () => {
      // A fixed date so the upper edge can be tested too (today's upper edge is
      // in the future). 2026-01-15 +07 = [2026-01-14T17:00Z, 2026-01-15T17:00Z).
      const day = '2026-01-15'
      expect(startOfDay(day).toISOString()).toBe('2026-01-14T17:00:00.000Z')
      expect(endOfDayExclusive(day).toISOString()).toBe('2026-01-15T17:00:00.000Z')
      const at = (iso: string) => Date.parse(iso)
      const path = ['inspecting', 'quoted', 'approved', 'repairing', 'ready', 'delivered']
      const cases = {
        prevDay2359: at('2026-01-14T16:59:00Z'),
        day0001: at('2026-01-14T17:01:00Z'),
        day2359: at('2026-01-15T16:59:00Z'),
        nextDay0001: at('2026-01-15T17:01:00Z'),
      }
      const ids: Record<string, string> = {}
      for (const [name, when] of Object.entries(cases)) {
        ids[name] = await openJob()
        await seedPath(ids[name]!, path, when)
      }
      const { rows } = await withShop(db, fx.shopA, (trx) =>
        deliveredBetween(trx, startOfDay(day), endOfDayExclusive(day), 50, 0))
      const got = rows.map((r) => r.job_id)
      expect(got).toContain(ids.day0001)
      expect(got).toContain(ids.day2359)
      expect(got).not.toContain(ids.prevDay2359)
      expect(got).not.toContain(ids.nextDay0001)
    })

    it('refuses an absurd page number: 400 too_big', async () => {
      const res = await get(api, '/api/jobs?status=delivered&date=today&page=10001', await tokenAs('advisor'))
      expect(res.status).toBe(400)
      expect(res.body.fields).toMatchObject({ page: ['too_big'] })
    })

    it('shop B never sees shop A\'s deliveries', async () => {
      const a = await deliveredViaApi()
      const res = await get(api, '/api/jobs?status=delivered&date=today&pageSize=50', await tokenAs('owner', fx.shopB))
      expect(res.status).toBe(200)
      expect(DeliveredJobsPage.parse(res.body).items.map((i) => i.jobId)).not.toContain(a)
    })

    it('refuses anything but the one list it serves: 400 with field codes', async () => {
      const bad = await get(api, '/api/jobs?status=ready&date=today', await tokenAs('advisor'))
      expect(bad.status).toBe(400)
      expect(bad.body.fields).toMatchObject({ status: ['invalid_value'] })
      const bare = await get(api, '/api/jobs', await tokenAs('advisor'))
      expect(bare.status).toBe(400)
      const tooBig = await get(api, '/api/jobs?status=delivered&date=today&pageSize=51', await tokenAs('advisor'))
      expect(tooBig.status).toBe(400)
      expect(tooBig.body.fields).toMatchObject({ pageSize: ['too_big'] })
    })
  })
})
