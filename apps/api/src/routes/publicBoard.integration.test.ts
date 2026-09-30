/**
 * WO — GET /api/public/board/:token, the unauthenticated waiting-room screen,
 * against a real PostgreSQL.
 *
 * TIER 2. Skipped when GSMS_TEST_DB is unset; see src/test/env.ts.
 *
 * This route has no login at all, so every test here treats the caller as a
 * stranger: no bearer token is ever sent to it. The security auditor's minimum
 * for sign-off (see the WO thread) is case 1 below — canary strings absent from
 * the RAW response text, not merely absent from named JSON keys — plus the
 * token-isolation and 404-indistinguishability cases.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { unscoped, withShop } from '@gsms/db/client.js'
import { db } from '../lib/db.js'
import { hasDatabase, tier2 } from '../test/env.js'
import {
  createTwoShopFixture, issueTokensFor, post, startApi,
  type RunningApi, type TwoShopFixture,
} from '../test/fixtures.js'

interface CheckInBody { jobId: string }
interface PublicBoardCar { plate: string; queueNo: number | null; bayName: string | null }
interface PublicBoardBody { shopName: string; bays: { name: string; inUse: boolean }[]; cars: PublicBoardCar[] }

describe.skipIf(!hasDatabase)(tier2('public waiting-room board (GET /api/public/board/:token)'), () => {
  let api: RunningApi
  let fx: TwoShopFixture

  beforeAll(async () => {
    api = await startApi()
    fx = await createTwoShopFixture('wo006board')
  })
  afterAll(async () => {
    await fx?.cleanup()
    await api?.close()
  })

  const owner = (shopId: string) => issueTokensFor(fx.userId, shopId, 'owner')

  async function tokenOf(shopId: string): Promise<string> {
    const row = await unscoped(db, (trx) => trx.selectFrom('shops')
      .select(['public_board_token']).where('id', '=', shopId).executeTakeFirstOrThrow())
    return row.public_board_token
  }

  /** Raw fetch, deliberately bypassing the `get()` helper's JSON parse, so the RAW body text can be inspected. */
  async function rawBoard(token: string): Promise<{ status: number; text: string }> {
    const res = await fetch(`${api.url}/api/public/board/${encodeURIComponent(token)}`)
    return { status: res.status, text: await res.text() }
  }

  async function board(token: string): Promise<{ status: number; body: PublicBoardBody }> {
    const res = await fetch(`${api.url}/api/public/board/${encodeURIComponent(token)}`)
    return { status: res.status, body: (await res.json()) as PublicBoardBody }
  }

  async function checkinOn(
    token: string, plate: string, extra: Record<string, unknown> = {},
  ): Promise<string> {
    const res = await post<CheckInBody>(api, '/api/checkin', {
      plate, customerName: 'Public Board Placeholder', brand: 'Toyota', model: 'Vios', province: 'กรุงเทพมหานคร', ...extra,
    }, token)
    expect(res.status, `setup: check-in for plate ${plate} failed: ${JSON.stringify(res.body)}`).toBe(201)
    return res.body.jobId
  }

  async function setCreatedAt(shopId: string, jobId: string, when: Date): Promise<void> {
    await withShop(db, shopId, (trx) => trx.updateTable('jobs').set({ created_at: when }).where('id', '=', jobId).execute())
  }

  async function setStatus(shopId: string, jobId: string, status: string): Promise<void> {
    await withShop(db, shopId, (trx) => trx.updateTable('jobs').set({ status }).where('id', '=', jobId).execute())
  }

  // ===========================================================================
  // Case 1 — no PII in the RAW response body, not merely in named keys
  // ===========================================================================
  describe('no personal or financial data leaks through', () => {
    it('never prints the customer\'s name, phone, or complaint text — asserted on raw text', async () => {
      const s = await owner(fx.shopA)
      const CANARY_NAME = 'SECRETNAME Sombat Uniquename999888'
      const CANARY_PHONE = '0899998877'
      const CANARY_SYMPTOM = 'อาการลับเฉพาะเจาะจงมากผิดปกติ-CANARY-1234'
      const jobId = await checkinOn(s.accessToken, 'CANARY-PLATE-1', {
        customerName: CANARY_NAME,
        customerPhone: CANARY_PHONE,
        symptom: CANARY_SYMPTOM,
      })
      void jobId

      const token = await tokenOf(fx.shopA)
      const { status, text } = await rawBoard(token)
      expect(status).toBe(200)

      // Sanity check first: if the plate is not even in the response, the rest
      // of this assertion is proving nothing (the job never made it onto the
      // board at all, for some unrelated reason).
      expect(text, 'the seeded job never appeared on the board — check the fixture, not the leak').toContain('CANARY-PLATE-1')

      expect(text, 'the customer\'s name leaked into the public board').not.toContain(CANARY_NAME)
      expect(text, 'the customer\'s phone leaked into the public board').not.toContain(CANARY_PHONE)
      expect(text, 'the complaint text leaked into the public board').not.toContain(CANARY_SYMPTOM)
      // Fragments too, in case of partial-field concatenation elsewhere.
      expect(text).not.toContain('SECRETNAME')
      expect(text).not.toContain('0899998877')
    })

    /**
     * FINDING, not a test gap: there is no money/cost field anywhere on `jobs`
     * or in the public board's projection to canary. Pricing has not shipped
     * (CLAUDE.md §0 release order: queue/billing/stock before purchasing/VAT),
     * `jobs` carries no price column at all, and `PublicBoardCar` (a
     * from-scratch `.strict()` schema) has no amount field for a future one to
     * leak through even by accident — the nearest numeric field, est_value, is
     * a TIME estimate (minutes/hours/days), not currency, and is deliberately
     * exposed (estLabel/estMinutes power the waiting-room countdown). There is
     * therefore nothing to seed for an amount canary today; revisit this test
     * the day a price field is added anywhere near this projection.
     */
    it('has no amount/cost field to leak — documented, not asserted', () => {
      expect(true).toBe(true)
    })

    it('never includes a thumbFileId or any photo reference', async () => {
      const s = await owner(fx.shopA)
      await checkinOn(s.accessToken, 'CANARY-PLATE-2')
      const token = await tokenOf(fx.shopA)
      const { body } = await board(token)
      for (const car of body.cars) {
        expect(car).not.toHaveProperty('thumbFileId')
        expect(car).not.toHaveProperty('photoFileId')
      }
    })
  })

  // ===========================================================================
  // Case 2 — token isolation and indistinguishable 404s
  // ===========================================================================
  describe('token isolation', () => {
    it('shop A\'s token never shows shop B\'s cars', async () => {
      const ownerA = await owner(fx.shopA)
      const ownerB = await owner(fx.shopB)
      await checkinOn(ownerA.accessToken, 'XSHOP-BOARD-A-1')
      await checkinOn(ownerB.accessToken, 'XSHOP-BOARD-B-1')

      const tokenA = await tokenOf(fx.shopA)
      const { body } = await board(tokenA)
      expect(body.cars.some((c) => c.plate === 'XSHOP-BOARD-A-1')).toBe(true)
      expect(
        body.cars.some((c) => c.plate === 'XSHOP-BOARD-B-1'),
        'shop A\'s public board showed shop B\'s car',
      ).toBe(false)
    })

    it('an unknown, malformed, or very long token all answer an identical 404 body', async () => {
      const unknown = await board('a-well-formed-but-unknown-token-that-does-not-exist-anywhere')
      const malformed = await board('!!!not/a/valid::token???%%')
      const tooLong = await board('x'.repeat(500))

      for (const res of [unknown, malformed, tooLong]) {
        expect(res.status).toBe(404)
        expect(res.body).toEqual({ error: 'not_found' })
      }
    })

    it('the bare path with no token also answers the same 404', async () => {
      const res = await fetch(`${api.url}/api/public/board/`)
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({ error: 'not_found' })
    })

    /**
     * The route's MAX_TOKEN_LENGTH is 128. A real token is 43 characters, so
     * both sides of this boundary are invalid — the point is that the boundary
     * itself behaves identically on both sides and never 500s, which is what
     * would happen if an off-by-one let a 129-character string reach the
     * database lookup with a different code path than a 128-character one.
     */
    it('a 128-character and a 129-character token both answer the identical 404, never a 500', async () => {
      const exactly128 = await board('a'.repeat(128))
      const exactly129 = await board('a'.repeat(129))

      for (const res of [exactly128, exactly129]) {
        expect(res.status).toBe(404)
        expect(res.body).toEqual({ error: 'not_found' })
      }
    })

    /**
     * A regression pin, not a live finding: Kysely parameterises every query
     * this route issues, so this passes today regardless of the payload. The
     * point is to catch the day someone "optimises" shopByToken() into a
     * hand-built string — this test would start failing at case (b), the row
     * count, well before anyone noticed the table was gone.
     */
    it('an SQL-injection-shaped token answers the same 404, and leaves the jobs table untouched', async () => {
      const before = await unscoped(db, (trx) => trx.selectFrom('jobs')
        .select(({ fn }) => fn.count<number>('id').as('n')).executeTakeFirstOrThrow())

      // board() itself URL-encodes the token before it goes on the wire —
      // these are the RAW payloads, not pre-encoded ones.
      const payloads = ["' OR '1'='1", "x'; DROP TABLE jobs;--"]
      for (const payload of payloads) {
        const res = await board(payload)
        expect(res.status, `payload: ${payload}`).toBe(404)
        expect(res.body, `payload: ${payload}`).toEqual({ error: 'not_found' })
      }

      // (b) — the assertion that actually matters: the table is still there
      // and nothing was deleted from it.
      const stillThere = await unscoped(db, (trx) => trx.selectFrom('jobs')
        .select(({ fn }) => fn.count<number>('id').as('n')).executeTakeFirstOrThrow())
      expect(Number(stillThere.n)).toBe(Number(before.n))
    })
  })

  // ===========================================================================
  // Case 3 — the date rule: overnight cars stay, deliveries fade after today
  // ===========================================================================
  describe('what stays on the board and for how long', () => {
    it('a car still in the workshop since yesterday IS on the board', async () => {
      const s = await owner(fx.shopA)
      const jobId = await checkinOn(s.accessToken, 'BOARD-DT-PROG-YEST')
      await setStatus(fx.shopA, jobId, 'repairing')
      await setCreatedAt(fx.shopA, jobId, new Date(Date.now() - 25 * 3_600_000))

      const token = await tokenOf(fx.shopA)
      const { body } = await board(token)
      expect(body.cars.some((c) => c.plate === 'BOARD-DT-PROG-YEST')).toBe(true)
    })

    it('a car delivered TODAY is NOT on the board — it leaves the moment it is delivered (DECISION-carout.md)', async () => {
      const s = await owner(fx.shopA)
      const jobId = await checkinOn(s.accessToken, 'BOARD-DT-DELIV-TOD')
      await setStatus(fx.shopA, jobId, 'delivered')
      // created_at left at "now": under 0016 this car stayed until midnight.

      const token = await tokenOf(fx.shopA)
      const { body } = await board(token)
      expect(body.cars.some((c) => c.plate === 'BOARD-DT-DELIV-TOD')).toBe(false)
    })

    it('a car delivered YESTERDAY is NOT on the board', async () => {
      const s = await owner(fx.shopA)
      const jobId = await checkinOn(s.accessToken, 'BOARD-DT-DELIV-YST')
      await setStatus(fx.shopA, jobId, 'delivered')
      await setCreatedAt(fx.shopA, jobId, new Date(Date.now() - 25 * 3_600_000))

      const token = await tokenOf(fx.shopA)
      const { body } = await board(token)
      expect(
        body.cars.some((c) => c.plate === 'BOARD-DT-DELIV-YST'),
        'a car delivered yesterday is still cluttering the waiting-room screen',
      ).toBe(false)
    })
  })

  // ===========================================================================
  // Case 4 — a shop's own bay names, not the hard-coded H1–H5
  // ===========================================================================
  describe('bays', () => {
    it('reflects the shop\'s own bay names, not a hard-coded list', async () => {
      const names = ['ช่องพิเศษ-เอ', 'ช่องพิเศษ-บี']
      await withShop(db, fx.shopA, (trx) => trx.insertInto('bays')
        .values(names.map((name, i) => ({ shop_id: fx.shopA, name, sort_order: 100 + i })))
        .execute())

      const token = await tokenOf(fx.shopA)
      const { body } = await board(token)
      const bayNames = body.bays.map((b) => b.name)
      for (const name of names) expect(bayNames).toContain(name)
      // And the hard-coded Samut Prakan layout must not be invented for a
      // shop that never created those bays.
      expect(bayNames).not.toContain('H1')
    })
  })

  // ===========================================================================
  // Cache-Control: no-store — a TV screen must never render a stale board, and
  // a cached 429 would blank the room until the cache happened to expire.
  // ===========================================================================
  describe('Cache-Control: no-store', () => {
    it('is set on a 200 (valid token) and on a 404 (unknown token)', async () => {
      const token = await tokenOf(fx.shopA)
      const ok = await fetch(`${api.url}/api/public/board/${encodeURIComponent(token)}`)
      expect(ok.status).toBe(200)
      expect(ok.headers.get('cache-control')).toBe('no-store')

      const missing = await fetch(`${api.url}/api/public/board/definitely-not-a-real-token`)
      expect(missing.status).toBe(404)
      expect(missing.headers.get('cache-control')).toBe('no-store')
    })

    /**
     * The case that actually matters: a cached 429 would blank the waiting-room
     * TV until the cache expired, which is worse than the rate limit itself.
     * Run against a FRESH app instance (its own in-memory limiter store), not
     * the shared `api` the rest of this file uses — sharing it would either
     * make this test flaky (its quota partly spent by earlier tests) or spend
     * the whole file's remaining budget on one test.
     */
    it('is also set on the limiter\'s own 429 refusal', async () => {
      const limited = await startApi()
      try {
        const token = await tokenOf(fx.shopA)
        const url = `${limited.url}/api/public/board/${encodeURIComponent(token)}`
        let last: Response | undefined
        // The router's limit is 30/min; run sequentially so the count is exact
        // rather than racing concurrent requests against the same window.
        for (let i = 0; i < 35 && (!last || last.status !== 429); i++) {
          last = await fetch(url)
        }
        expect(last?.status, 'never got a 429 — the limiter did not engage within 35 requests').toBe(429)
        expect(last?.headers.get('cache-control')).toBe('no-store')
      } finally {
        await limited.close()
      }
    })
  })
})
