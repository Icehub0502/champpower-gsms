/**
 * Issuing a quotation moves the job to `quoted` (owner decision, 3 Oct 2026),
 * in the SAME transaction as the issue. Domain rule: jobStatusOnIssue().
 *
 * TIER 2. Needs PostgreSQL with migrations 0001-0022 and DATABASE_ADMIN_URL
 * (cleanup of numbered documents, and the temporary failure trigger).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { DocumentSeriesMissingError } from '@gsms/contracts/index.js'
import { withShop } from '@gsms/db/client.js'
import { db } from '../lib/db.js'
import { adminDatabaseUrl, hasDatabase, tier2 } from '../test/env.js'
import {
  createTwoShopFixture, get, issueTokensFor, patch, post, startApi,
  type RunningApi, type TwoShopFixture,
} from '../test/fixtures.js'

const REASON = 'ออกใบเสนอราคา'

describe.skipIf(!hasDatabase || !adminDatabaseUrl)(
  tier2('issuing a quotation moves the job to quoted (same transaction)'),
  () => {
    let api: RunningApi
    let fx: TwoShopFixture
    let seq = 0
    const tag = Math.floor(Math.random() * 9000) + 1000

    beforeAll(async () => {
      api = await startApi({ intakeWriteLimit: 1_000_000 })
      fx = await createTwoShopFixture('p31issue')
    })

    afterAll(async () => {
      if (fx) {
        const admin = new pg.Client({ connectionString: adminDatabaseUrl })
        await admin.connect()
        try {
          await admin.query('set session_replication_role = replica')
          for (const t of ['document_lines', 'documents']) {
            await admin.query(`delete from ${t} where shop_id = any($1)`, [[fx.shopA, fx.shopB]])
          }
        } finally { await admin.end() }
      }
      await fx?.cleanup()
      await api?.close()
    })

    const tok = async (shop: string) => (await issueTokensFor(fx.userId, shop, 'owner')).accessToken
    const POST = async (path: string, body: unknown, shop = fx.shopA) => post<any>(api, path, body, await tok(shop)) // eslint-disable-line @typescript-eslint/no-explicit-any
    const PATCH = async (path: string, body: unknown, shop = fx.shopA) => patch<any>(api, path, body, await tok(shop)) // eslint-disable-line @typescript-eslint/no-explicit-any
    const GET = async (path: string, shop = fx.shopA) => get<any>(api, path, await tok(shop)) // eslint-disable-line @typescript-eslint/no-explicit-any

    async function checkIn(shop = fx.shopA): Promise<string> {
      seq++
      const res = await POST('/api/checkin', {
        plate: `ฉก ${tag}${seq}`.slice(0, 12), customerName: 'ทดสอบ', brand: 'Toyota', model: 'Vios', province: 'กรุงเทพมหานคร',
      }, shop)
      expect(res.status, JSON.stringify(res.body)).toBe(201)
      return res.body.jobId as string
    }

    async function move(jobId: string, from: string, to: string, shop = fx.shopA): Promise<void> {
      const r = await PATCH(`/api/jobs/${jobId}/status`, { to, fromStatus: from }, shop)
      expect(r.status, JSON.stringify(r.body)).toBe(200)
    }

    async function draftWithLine(jobId: string, shop = fx.shopA): Promise<void> {
      expect((await POST(`/api/jobs/${jobId}/quotation`, {}, shop)).status).toBe(201)
      const l = await POST(`/api/jobs/${jobId}/quotation/lines`, {
        kind: 'free', name: 'ลูกหมาก', lineType: 'part', qty: '1', unitPrice: '100', addToCatalog: false,
      }, shop)
      expect(l.status, JSON.stringify(l.body)).toBe(201)
    }

    const status = (jobId: string, shop = fx.shopA) =>
      withShop(db, shop, async (t) => (await t.selectFrom('jobs').select('status').where('id', '=', jobId).executeTakeFirstOrThrow()).status)

    const history = (jobId: string, shop = fx.shopA) =>
      withShop(db, shop, (t) => t.selectFrom('job_status_history')
        .select(['status', 'changed_by', 'changed_at', 'reason']).where('job_id', '=', jobId)
        .orderBy('changed_at', 'asc').orderBy('id', 'asc').execute())

    it('received -> quoted in ONE history row, by the issuer, with the reason; no invented inspecting', async () => {
      const jobId = await checkIn()
      const before = (await history(jobId)).length
      await draftWithLine(jobId)
      const issued = await POST(`/api/jobs/${jobId}/quotation/issue`, {})
      expect(issued.status, JSON.stringify(issued.body)).toBe(200)
      expect(issued.body.status).toBe('issued')
      expect(await status(jobId)).toBe('quoted')

      const rows = (await history(jobId)).slice(before)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ status: 'quoted', changed_by: fx.userId, reason: REASON })
      expect(rows[0]!.changed_at).toBeInstanceOf(Date)
      expect((await history(jobId)).map((r) => r.status)).not.toContain('inspecting')
    })

    it('writes the normal job_status_changed audit row', async () => {
      const jobId = await checkIn()
      await draftWithLine(jobId)
      await POST(`/api/jobs/${jobId}/quotation/issue`, {})
      const rows = await withShop(db, fx.shopA, (t) => t.selectFrom('audit_logs')
        .select(['actor_id', 'after']).where('action', '=', 'job_status_changed').where('entity_id', '=', jobId).execute())
      expect(rows).toHaveLength(1)
      expect(rows[0]!.actor_id).toBe(fx.userId)
      expect(JSON.stringify(rows[0]!.after)).toContain('quoted')
    })

    it('inspecting -> quoted', async () => {
      const jobId = await checkIn()
      await move(jobId, 'received', 'inspecting')
      await draftWithLine(jobId)
      expect((await POST(`/api/jobs/${jobId}/quotation/issue`, {})).status).toBe(200)
      expect(await status(jobId)).toBe('quoted')
      const rows = await history(jobId)
      expect(rows.at(-1)).toMatchObject({ status: 'quoted', reason: REASON, changed_by: fx.userId })
    })

    async function confirmAll(jobId: string): Promise<void> {
      const q = await GET(`/api/jobs/${jobId}/quotation`)
      for (const l of q.body.lines.filter((x: any) => x.parentLineId === null)) { // eslint-disable-line @typescript-eslint/no-explicit-any
        expect((await PATCH(`/api/jobs/${jobId}/quotation/lines/${l.id}/decision`, { decision: 'approved' })).status).toBe(200)
      }
      const c = await POST(`/api/jobs/${jobId}/quotation/confirm`, {})
      expect(c.status, JSON.stringify(c.body)).toBe(200)
    }

    it('issuing a revision while the job is approved leaves the status and history alone', async () => {
      const jobId = await checkIn()
      await draftWithLine(jobId)
      await POST(`/api/jobs/${jobId}/quotation/issue`, {})
      await confirmAll(jobId)
      expect(await status(jobId)).toBe('approved')
      const histBefore = (await history(jobId)).length

      expect((await POST(`/api/jobs/${jobId}/quotation/revise`, {})).status).toBe(201)
      expect((await POST(`/api/jobs/${jobId}/quotation/issue`, {})).status).toBe(200)
      expect(await status(jobId)).toBe('approved')
      expect(await history(jobId)).toHaveLength(histBefore)
    })

    it('issuing a revision while the job is repairing leaves the status and history alone', async () => {
      const jobId = await checkIn()
      await draftWithLine(jobId)
      await POST(`/api/jobs/${jobId}/quotation/issue`, {})
      await confirmAll(jobId)
      await move(jobId, 'approved', 'repairing')
      const histBefore = (await history(jobId)).length

      expect((await POST(`/api/jobs/${jobId}/quotation/revise`, {})).status).toBe(201)
      expect((await POST(`/api/jobs/${jobId}/quotation/issue`, {})).status).toBe(200)
      expect(await status(jobId)).toBe('repairing')
      expect(await history(jobId)).toHaveLength(histBefore)
    })

    const seriesNext = (shop: string) =>
      withShop(db, shop, async (t) => (await t.selectFrom('document_series').select(['next_no', 'period_key'])
        .where('series', '=', 'QUO').executeTakeFirstOrThrow()))

    it('atomic: a failure AFTER the number and the status were written rolls back both', async () => {
      const jobId = await checkIn()
      await draftWithLine(jobId)
      const seriesBefore = await seriesNext(fx.shopA)
      const histBefore = (await history(jobId)).length

      // A trigger that refuses the history row the issue writes — i.e. a failure
      // AFTER allocate_document_number and after the job row was updated.
      const fn = `p31_fail_${randomUUID().replace(/-/g, '').slice(0, 10)}`
      const admin = new pg.Client({ connectionString: adminDatabaseUrl })
      await admin.connect()
      try {
        await admin.query(`create function ${fn}() returns trigger language plpgsql as $$
          begin
            if new.job_id = '${jobId}' and new.reason = '${REASON}' then raise exception 'forced failure'; end if;
            return new;
          end $$`)
        await admin.query(`create trigger ${fn} before insert on job_status_history for each row execute function ${fn}()`)
        const res = await POST(`/api/jobs/${jobId}/quotation/issue`, {})
        expect(res.status).toBe(500)
      } finally {
        await admin.query(`drop trigger if exists ${fn} on job_status_history`)
        await admin.query(`drop function if exists ${fn}()`)
        await admin.end()
      }

      const q = await GET(`/api/jobs/${jobId}/quotation`)
      expect(q.body.status).toBe('draft')
      expect(q.body.number).toBeNull()
      expect(await status(jobId)).toBe('received')
      expect(await history(jobId)).toHaveLength(histBefore)
      expect(await seriesNext(fx.shopA)).toEqual(seriesBefore)
    })

    it('atomic: a missing QUO series (GS001 -> 409 document_series_missing) leaves the status, history and document untouched', async () => {
      const jobId = await checkIn(fx.shopB)
      await draftWithLine(jobId, fx.shopB)
      const histBefore = (await history(jobId, fx.shopB)).length
      await withShop(db, fx.shopB, (t) => t.updateTable('document_series').set({ is_active: false }).where('series', '=', 'QUO').execute())
      try {
        const res = await POST(`/api/jobs/${jobId}/quotation/issue`, {}, fx.shopB)
        expect(res.status).toBe(409)
        expect(DocumentSeriesMissingError.safeParse(res.body).success, JSON.stringify(res.body)).toBe(true)
      } finally {
        await withShop(db, fx.shopB, (t) => t.updateTable('document_series').set({ is_active: true }).where('series', '=', 'QUO').execute())
      }
      const q = await GET(`/api/jobs/${jobId}/quotation`, fx.shopB)
      expect(q.body.status).toBe('draft')
      expect(q.body.number).toBeNull()
      expect(await status(jobId, fx.shopB)).toBe('received')
      expect(await history(jobId, fx.shopB)).toHaveLength(histBefore)
    })

    it('two shops: shop B cannot issue shop A\'s quotation, and issuing in B moves only B\'s job', async () => {
      const jobA = await checkIn(fx.shopA)
      await draftWithLine(jobA, fx.shopA)
      const jobB = await checkIn(fx.shopB)
      await draftWithLine(jobB, fx.shopB)

      const cross = await POST(`/api/jobs/${jobA}/quotation/issue`, {}, fx.shopB)
      expect(cross.status).toBe(404)
      expect(await status(jobA, fx.shopA)).toBe('received')

      expect((await POST(`/api/jobs/${jobB}/quotation/issue`, {}, fx.shopB)).status).toBe(200)
      expect(await status(jobB, fx.shopB)).toBe('quoted')
      expect(await status(jobA, fx.shopA)).toBe('received')
      // B's rows are invisible from A's scope
      expect(await withShop(db, fx.shopA, (t) => t.selectFrom('job_status_history').select('id').where('job_id', '=', jobB).execute())).toHaveLength(0)
    })
  },
)
