/**
 * CLAUDE.md 4.x (revised 14 Oct 2026, DECISION-2026-10-14 2): a document read taken
 * before the locks may only find job_id/id. Every decision is made from the row
 * re-read AFTER the lock.
 *
 * Test first: this was run red against the previous jobBackToQuotedBlocked (an
 * unlocked status read) before the fix.
 *
 * TIER 2. Needs PostgreSQL with migrations 0001-0022 and DATABASE_ADMIN_URL.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import pg from 'pg'
import { adminDatabaseUrl, hasDatabase, tier2 } from '../test/env.js'
import {
  createTwoShopFixture, get, issueTokensFor, patch, post, startApi,
  type RunningApi, type TwoShopFixture,
} from '../test/fixtures.js'

describe.skipIf(!hasDatabase || !adminDatabaseUrl)(tier2('lock order: decide from the post-lock read'), () => {
  let api: RunningApi
  let fx: TwoShopFixture
  let seq = 0
  const tag = Math.floor(Math.random() * 9000) + 1000

  beforeAll(async () => {
    api = await startApi({ intakeWriteLimit: 1_000_000 })
    fx = await createTwoShopFixture('lockord')
  })

  afterAll(async () => {
    if (fx) {
      const admin = new pg.Client({ connectionString: adminDatabaseUrl })
      await admin.connect()
      try {
        await admin.query('set session_replication_role = replica')
        for (const t of ['document_lines', 'documents']) await admin.query(`delete from ${t} where shop_id = any($1)`, [[fx.shopA, fx.shopB]])
      } finally { await admin.end() }
    }
    await fx?.cleanup()
    await api?.close()
  })

  const tok = async () => (await issueTokensFor(fx.userId, fx.shopA, 'owner')).accessToken
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const POST = async (path: string, body: unknown = {}) => post<any>(api, path, body, await tok())
  const PATCH = async (path: string, body: unknown = {}) => patch<any>(api, path, body, await tok())
  const GET = async (path: string) => get<any>(api, path, await tok())
  /* eslint-enable @typescript-eslint/no-explicit-any */

  async function confirmedJob(): Promise<{ jobId: string; documentId: string }> {
    seq++
    const c = await POST('/api/checkin', { plate: `ลอ ${tag}${seq}`.slice(0, 12), customerName: 'ทดสอบ', brand: 'ZZBrand', model: 'ZZModel', province: 'กรุงเทพมหานคร' })
    expect(c.status, JSON.stringify(c.body)).toBe(201)
    const jobId = c.body.jobId as string
    const q = `/api/jobs/${jobId}/quotation`
    expect((await POST(q)).status).toBe(201)
    const l = await POST(`${q}/lines`, { kind: 'free', name: 'ลูกหมาก', lineType: 'part', qty: '1', unitPrice: '100', addToCatalog: false })
    expect(l.status, JSON.stringify(l.body)).toBe(201)
    const issued = await POST(`${q}/issue`)
    expect(issued.status, JSON.stringify(issued.body)).toBe(200)
    for (const line of issued.body.lines.filter((x: { parentLineId: string | null }) => x.parentLineId === null)) {
      expect((await PATCH(`${q}/lines/${line.id}/decision`, { decision: 'approved' })).status).toBe(200)
    }
    const conf = await POST(`${q}/confirm`)
    expect(conf.status, JSON.stringify(conf.body)).toBe(200)
    const view = await GET(q)
    return { jobId, documentId: view.body.id as string }
  }

  it('approved -> quoted waits for a voiding transaction and judges the voided document, not the signed one it saw before', async () => {
    const { jobId, documentId } = await confirmedJob()

    const holder = new pg.Client({ connectionString: adminDatabaseUrl })
    await holder.connect()
    try {
      // Another request has the document locked and voided it (void takes the document lock, never the job's).
      await holder.query('begin')
      await holder.query(`update documents set status = 'void', void_reason = 'test', voided_at = now() where id = $1`, [documentId])

      let settled = false
      const move = PATCH(`/api/jobs/${jobId}/status`, { to: 'quoted', fromStatus: 'approved' }).then((r) => { settled = true; return r })
      await new Promise((r) => setTimeout(r, 600))
      // An unlocked read answers at once from the signed snapshot (409 quotation_confirmed); a locked read waits.
      expect(settled, 'the move decided before it held the document lock').toBe(false)

      await holder.query('commit')
      const r = await move
      expect(r.status, JSON.stringify(r.body)).toBe(200)
      expect(r.body.status).toBe('quoted')
    } finally {
      await holder.query('rollback').catch(() => undefined)
      await holder.end()
    }
  })
})
