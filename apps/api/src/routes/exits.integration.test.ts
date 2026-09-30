/**
 * The three ways a job ends — delivered, rejected, carout — through
 * PATCH /api/jobs/:id/status, and what each does to the two boards.
 *
 * TIER 2. Skipped when GSMS_TEST_DB is unset; see src/test/env.ts.
 *
 * The rule under test is docs/WORK-ORDERS/DECISION-carout.md (owner, 30 Sep
 * 2026): three INDEPENDENT exits, one source each —
 *   delivered  from ready
 *   rejected   from quoted
 *   carout     from received or inspecting (before any quotation) only
 * — each one taking the card off /today and the public board in the same
 * request cycle. The technician is barred only from `rejected` (the
 * customer's quote decision, CLAUDE.md §12.1); carout and delivered stay open
 * to him as before, and so does the undo (same roles as delivered).
 *
 * Setup writes status and history directly (seedPath) and only the request
 * under test goes through the API.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { unscoped, withShop } from '@gsms/db/client.js'
import { db } from '../lib/db.js'
import { hasDatabase, tier2 } from '../test/env.js'
import {
  createTwoShopFixture, get, issueTokensFor, patch, post, startApi,
  type RunningApi, type TwoShopFixture,
} from '../test/fixtures.js'

interface Card { jobId: string; status: string }
interface TodayBody { jobs: Card[] }
interface PublicBoardBody { cars: { plate: string }[] }
type Role = Parameters<typeof issueTokensFor>[2]

describe.skipIf(!hasDatabase)(tier2('job exits — delivered, rejected, carout (DECISION-carout.md)'), () => {
  let api: RunningApi
  let fx: TwoShopFixture

  beforeAll(async () => {
    api = await startApi()
    fx = await createTwoShopFixture('exits')
  })
  afterAll(async () => {
    await fx?.cleanup()
    await api?.close()
  })

  const tokenAs = async (role: Role, shop = fx.shopA) =>
    (await issueTokensFor(fx.userId, shop, role)).accessToken

  let plateSeq = 0
  async function openJob(): Promise<{ jobId: string; plate: string }> {
    plateSeq++
    const plate = `ขข ${String(1000 + plateSeq)}`
    const res = await post<{ jobId: string }>(api, '/api/checkin', {
      plate, customerName: 'ทดสอบ', brand: 'Toyota', model: 'Vios', province: 'กรุงเทพมหานคร',
    }, await tokenAs('owner'))
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    return { jobId: res.body.jobId, plate }
  }

  /** Put the job at the last status, with history rows for every step. */
  async function seedPath(jobId: string, statuses: string[]) {
    const last = statuses[statuses.length - 1]!
    const start = Date.now() - 60_000 - statuses.length * 1000
    await withShop(db, fx.shopA, async (trx) => {
      await trx.updateTable('jobs').set({ status: last }).where('id', '=', jobId).execute()
      await trx.insertInto('job_status_history').values(statuses.map((status, i) => ({
        shop_id: fx.shopA, job_id: jobId, status, changed_at: new Date(start + i * 1000),
      }))).execute()
    })
  }

  const move = async (jobId: string, fromStatus: string, to: string, role: Role = 'advisor', shop = fx.shopA) =>
    patch(api, `/api/jobs/${jobId}/status`, { to, fromStatus }, await tokenAs(role, shop))

  async function statusOf(jobId: string): Promise<string> {
    const row = await withShop(db, fx.shopA, (trx) => trx.selectFrom('jobs')
      .select('status').where('id', '=', jobId).executeTakeFirstOrThrow())
    return row.status
  }

  async function onToday(jobId: string, shop = fx.shopA): Promise<boolean> {
    const res = await get<TodayBody>(api, '/api/jobs/today', await tokenAs('owner', shop))
    expect(res.status).toBe(200)
    return res.body.jobs.some((j) => j.jobId === jobId)
  }

  async function onPublicBoard(plate: string, shop = fx.shopA): Promise<boolean> {
    const row = await unscoped(db, (trx) => trx.selectFrom('shops')
      .select('public_board_token').where('id', '=', shop).executeTakeFirstOrThrow())
    const res = await fetch(`${api.url}/api/public/board/${encodeURIComponent(row.public_board_token)}`)
    expect(res.status).toBe(200)
    return ((await res.json()) as PublicBoardBody).cars.some((c) => c.plate === plate)
  }

  // ===========================================================================
  // carout — before a quotation exists, and only then
  // ===========================================================================
  describe('carout', () => {
    it('received -> carout 200, and the car is off both boards at once', async () => {
      const { jobId, plate } = await openJob()
      expect(await onToday(jobId)).toBe(true)
      const res = await move(jobId, 'received', 'carout')
      expect(res.status, JSON.stringify(res.body)).toBe(200)
      expect(await statusOf(jobId)).toBe('carout')
      expect(await onToday(jobId)).toBe(false)
      expect(await onPublicBoard(plate)).toBe(false)
    })

    it('inspecting -> carout 200', async () => {
      const { jobId } = await openJob()
      await seedPath(jobId, ['inspecting'])
      const res = await move(jobId, 'inspecting', 'carout')
      expect(res.status, JSON.stringify(res.body)).toBe(200)
      expect(await statusOf(jobId)).toBe('carout')
    })

    it.each([
      ['quoted', ['inspecting', 'quoted']],
      ['approved', ['inspecting', 'quoted', 'approved']],
      ['repairing', ['inspecting', 'quoted', 'approved', 'repairing']],
      ['aligning', ['inspecting', 'quoted', 'approved', 'repairing', 'aligning']],
      ['ready', ['inspecting', 'quoted', 'approved', 'repairing', 'ready']],
    ])('%s -> carout 409 — no carout once a quote exists, none mid-repair', async (from, path) => {
      const { jobId } = await openJob()
      await seedPath(jobId, path)
      const res = await move(jobId, from, 'carout', 'owner')
      expect(res.status, JSON.stringify(res.body)).toBe(409)
      expect(res.body.error).toBe('illegal_status_move')
      expect(await statusOf(jobId)).toBe(from)
    })

    it('a technician may record a carout before a quote, as before — 200', async () => {
      const { jobId } = await openJob()
      const res = await move(jobId, 'received', 'carout', 'technician')
      expect(res.status, JSON.stringify(res.body)).toBe(200)
      expect(await statusOf(jobId)).toBe('carout')
    })
  })

  // ===========================================================================
  // rejected — the customer's "no" at the quote
  // ===========================================================================
  describe('rejected', () => {
    it('quoted -> rejected 200, and off /today and the TV immediately', async () => {
      const { jobId, plate } = await openJob()
      await seedPath(jobId, ['inspecting', 'quoted'])
      expect(await onToday(jobId)).toBe(true)
      expect(await onPublicBoard(plate)).toBe(true)

      const res = await move(jobId, 'quoted', 'rejected')
      expect(res.status, JSON.stringify(res.body)).toBe(200)
      expect(res.body.column).toBeNull()
      expect(await onToday(jobId)).toBe(false)
      expect(await onPublicBoard(plate)).toBe(false)
    })

    it('a technician may not record rejected — 403', async () => {
      const { jobId } = await openJob()
      await seedPath(jobId, ['inspecting', 'quoted'])
      const res = await move(jobId, 'quoted', 'rejected', 'technician')
      expect(res.status).toBe(403)
      expect(await statusOf(jobId)).toBe('quoted')
    })

    it('nobody — technician included — may carout from quoted: 409, the move does not exist', async () => {
      const { jobId } = await openJob()
      await seedPath(jobId, ['inspecting', 'quoted'])
      const res = await move(jobId, 'quoted', 'carout', 'technician')
      expect(res.status).toBe(409)
      expect(await statusOf(jobId)).toBe('quoted')
    })
  })

  // ===========================================================================
  // delivered — gone the moment it is pressed, not at the end of the day
  // ===========================================================================
  describe('delivered', () => {
    it('ready -> delivered 200, then gone from /today and /board in the same cycle', async () => {
      const { jobId, plate } = await openJob()
      await seedPath(jobId, ['inspecting', 'quoted', 'approved', 'repairing', 'ready'])
      expect(await onToday(jobId)).toBe(true)
      expect(await onPublicBoard(plate)).toBe(true)

      const res = await move(jobId, 'ready', 'delivered')
      expect(res.status, JSON.stringify(res.body)).toBe(200)
      expect(res.body.column).toBeNull()
      // No end-of-day wait: the very next read of either board is without it.
      expect(await onToday(jobId)).toBe(false)
      expect(await onPublicBoard(plate)).toBe(false)
    })

    it('records who delivered it in the history row', async () => {
      const { jobId } = await openJob()
      await seedPath(jobId, ['inspecting', 'quoted', 'approved', 'repairing', 'ready'])
      expect((await move(jobId, 'ready', 'delivered')).status).toBe(200)
      const rows = await withShop(db, fx.shopA, (trx) => trx.selectFrom('job_status_history')
        .select(['status', 'changed_by']).where('job_id', '=', jobId).where('status', '=', 'delivered').execute())
      expect(rows).toEqual([{ status: 'delivered', changed_by: fx.userId }])
    })

    it('a technician may deliver, as before — 200', async () => {
      const { jobId } = await openJob()
      await seedPath(jobId, ['inspecting', 'quoted', 'approved', 'repairing', 'ready'])
      const res = await move(jobId, 'ready', 'delivered', 'technician')
      expect(res.status, JSON.stringify(res.body)).toBe(200)
      expect(await statusOf(jobId)).toBe('delivered')
    })
  })

  // ===========================================================================
  // undoing a delivery — the refusals (DECISION-carout.md §3). The success
  // path, the stored reason and the audit row: undoDelivered.integration.test.ts.
  // ===========================================================================
  describe('undo delivered -> ready', () => {
    const delivered = async () => {
      const j = await openJob()
      await seedPath(j.jobId, ['inspecting', 'quoted', 'approved', 'repairing', 'ready', 'delivered'])
      return j
    }

    it('without a reason: 400, fields.reason = required, nothing changes', async () => {
      const { jobId } = await delivered()
      const res = await move(jobId, 'delivered', 'ready')
      expect(res.status).toBe(400)
      expect(res.body.error).toBe('invalid_request')
      expect(res.body.fields).toEqual({ reason: ['required'] })
      expect(await statusOf(jobId)).toBe('delivered')
    })

    it('a technician is held to the same rule — the undo is open to whoever may deliver (400, not 403)', async () => {
      const { jobId } = await delivered()
      const res = await move(jobId, 'delivered', 'ready', 'technician')
      expect(res.status).toBe(400)
      expect(res.body.fields).toEqual({ reason: ['required'] })
    })

    it('a blank reason is no reason: 400 too_small', async () => {
      const { jobId } = await delivered()
      const res = await patch(api, `/api/jobs/${jobId}/status`,
        { to: 'ready', fromStatus: 'delivered', reason: '    ' }, await tokenAs('advisor'))
      expect(res.status).toBe(400)
      expect(res.body.fields).toEqual({ reason: ['too_small'] })
      expect(await statusOf(jobId)).toBe('delivered')
    })

    it('an over-long reason: 400 too_big, and the text is never echoed back', async () => {
      const { jobId } = await delivered()
      const CANARY = 'CANARY-REASON-ECHO-'
      const raw = await fetch(`${api.url}/api/jobs/${jobId}/status`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${await tokenAs('advisor')}` },
        body: JSON.stringify({ to: 'ready', fromStatus: 'delivered', reason: CANARY + 'x'.repeat(500) }),
      })
      const text = await raw.text()
      expect(raw.status).toBe(400)
      expect(JSON.parse(text).fields).toEqual({ reason: ['too_big'] })
      expect(text).not.toContain(CANARY)
    })

    it('a reason on a move that takes none: 400 not_allowed — never accepted and dropped', async () => {
      const { jobId } = await openJob()
      const res = await patch(api, `/api/jobs/${jobId}/status`,
        { to: 'inspecting', fromStatus: 'received', reason: 'ไม่ต้องใช้' }, await tokenAs('advisor'))
      expect(res.status).toBe(400)
      expect(res.body.fields).toEqual({ reason: ['not_allowed'] })
      expect(await statusOf(jobId)).toBe('received')
    })

    it('a role that cannot move jobs: 403', async () => {
      const { jobId } = await delivered()
      const res = await patch(api, `/api/jobs/${jobId}/status`,
        { to: 'ready', fromStatus: 'delivered', reason: 'กดผิด' }, await tokenAs('viewer'))
      expect(res.status).toBe(403)
    })
  })

  // ===========================================================================
  // two shops — shop B can neither move nor see shop A's job
  // ===========================================================================
  describe('tenant isolation', () => {
    it('shop B cannot move shop A\'s job (404, unchanged) and never sees it on either board', async () => {
      const { jobId, plate } = await openJob()
      await seedPath(jobId, ['inspecting', 'quoted', 'approved', 'repairing', 'ready'])

      const res = await move(jobId, 'ready', 'delivered', 'owner', fx.shopB)
      expect(res.status).toBe(404)
      expect(await statusOf(jobId)).toBe('ready')

      expect(await onToday(jobId, fx.shopB)).toBe(false)
      expect(await onPublicBoard(plate, fx.shopB)).toBe(false)
      // ...while shop A still has it — the absence above is isolation, not an empty board.
      expect(await onToday(jobId)).toBe(true)
    })
  })
})
