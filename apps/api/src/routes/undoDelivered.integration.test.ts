/**
 * Undoing a delivery — delivered -> ready, with a reason (DECISION-carout.md §3).
 *
 * TIER 2. Skipped when GSMS_TEST_DB is unset; see src/test/env.ts.
 *
 * Needs migrations 0018 + 0019 (they ship together). The refusals — no reason,
 * blank, too long, a reason where none belongs, a read-only role — are in
 * exits.integration.test.ts; this file is the path that succeeds, and what it
 * leaves behind: the reason on the history row and NOWHERE else, and an audit
 * entry that points at that row.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { withShop } from '@gsms/db/client.js'
import { db } from '../lib/db.js'
import { hasDatabase, tier2 } from '../test/env.js'
import {
  auditFor, createTwoShopFixture, get, issueTokensFor, patch, post, startApi,
  type RunningApi, type TwoShopFixture,
} from '../test/fixtures.js'

type Role = Parameters<typeof issueTokensFor>[2]
interface HistoryEntry { status: string; changedBy: { userId: string; name: string } | null; reason: string | null }
interface Detail { status: string; onBoard: boolean; history: HistoryEntry[] }

describe.skipIf(!hasDatabase)(tier2('undo delivered -> ready with a reason'), () => {
  let api: RunningApi
  let fx: TwoShopFixture

  beforeAll(async () => {
    api = await startApi()
    fx = await createTwoShopFixture('undo0019')
  })
  afterAll(async () => {
    await fx?.cleanup()
    await api?.close()
  })

  const tokenAs = async (role: Role, shop = fx.shopA) =>
    (await issueTokensFor(fx.userId, shop, role)).accessToken

  let seq = 0
  async function deliveredJob(): Promise<string> {
    seq++
    const res = await post<{ jobId: string }>(api, '/api/checkin', {
      plate: `คค ${String(2000 + seq)}`, customerName: 'ทดสอบ', brand: 'Toyota', model: 'Vios', province: 'กรุงเทพมหานคร',
    }, await tokenAs('owner'))
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    const jobId = res.body.jobId
    const path = ['inspecting', 'quoted', 'approved', 'repairing', 'ready', 'delivered']
    const start = Date.now() - 60_000
    await withShop(db, fx.shopA, async (trx) => {
      await trx.updateTable('jobs').set({ status: 'delivered' }).where('id', '=', jobId).execute()
      await trx.insertInto('job_status_history').values(path.map((status, i) => ({
        shop_id: fx.shopA, job_id: jobId, status, changed_at: new Date(start + i * 1000),
      }))).execute()
    })
    return jobId
  }

  const undo = async (jobId: string, reason: string, role: Role = 'advisor', shop = fx.shopA) =>
    patch(api, `/api/jobs/${jobId}/status`, { to: 'ready', fromStatus: 'delivered', reason }, await tokenAs(role, shop))

  /** The newest history row of the job — the one the undo wrote. */
  const lastHistory = (jobId: string) => withShop(db, fx.shopA, (trx) => trx
    .selectFrom('job_status_history')
    .select(['id', 'status', 'reason', 'changed_by'])
    .where('job_id', '=', jobId)
    .orderBy('changed_at', 'desc')
    .orderBy('id', 'desc')
    .executeTakeFirstOrThrow())

  const REASON = 'กดผิด ลูกค้ายังไม่มารับรถ'

  it('with a reason: 200, back on /today, the reason stored TRIMMED on the history row', async () => {
    const jobId = await deliveredJob()
    // Padded with JavaScript whitespace that btrim() would miss (NBSP, tab,
    // newline, ideographic space): zod trims it, and 0019's CHECK would refuse
    // the row if anything untrimmed reached the database.
    const res = await undo(jobId, ` \t ${REASON}\n　`)
    expect(res.status, JSON.stringify(res.body)).toBe(200)

    const today = await get<{ jobs: { jobId: string }[] }>(api, '/api/jobs/today', await tokenAs('owner'))
    expect(today.body.jobs.some((j) => j.jobId === jobId)).toBe(true)

    const row = await lastHistory(jobId)
    expect(row).toMatchObject({ status: 'ready', reason: REASON, changed_by: fx.userId })
  })

  it('writes audit job_delivery_undone pointing at the history row — never the reason text', async () => {
    const jobId = await deliveredJob()
    expect((await undo(jobId, REASON)).status).toBe(200)
    const row = await lastHistory(jobId)

    // Job id and user id are the row's own entity_id and actor_id.
    const audit = await auditFor(fx.shopA, 'job_delivery_undone', jobId)
    expect(audit).toHaveLength(1)
    expect(audit[0]!.entity_id).toBe(jobId)
    expect(audit[0]!.actor_id).toBe(fx.userId)
    const entry = await withShop(db, fx.shopA, (trx) => trx.selectFrom('audit_logs')
      .select(['before', 'after']).where('action', '=', 'job_delivery_undone').where('entity_id', '=', jobId)
      .executeTakeFirstOrThrow())
    expect(entry.after).toEqual({ status: 'ready', status_history_id: row.id })
    // Free text stays out of audit_logs in every audit row of this move.
    const all = await withShop(db, fx.shopA, (trx) => trx.selectFrom('audit_logs')
      .select(['before', 'after']).where('entity_id', '=', jobId).execute())
    expect(JSON.stringify(all)).not.toContain(REASON)
  })

  it('GET /api/jobs/:id shows who undid it and why', async () => {
    const jobId = await deliveredJob()
    expect((await undo(jobId, REASON)).status).toBe(200)
    const res = await get<Detail>(api, `/api/jobs/${jobId}`, await tokenAs('advisor'))
    expect(res.status).toBe(200)
    expect(res.body.onBoard).toBe(true)
    const last = res.body.history[res.body.history.length - 1]!
    expect(last.status).toBe('ready')
    expect(last.reason).toBe(REASON)
    expect(last.changedBy?.userId).toBe(fx.userId)
    expect(last.changedBy?.name).toBeTruthy()
  })

  it('a technician may undo too, with a reason — same roles as delivered', async () => {
    const jobId = await deliveredJob()
    const res = await undo(jobId, REASON, 'technician')
    expect(res.status, JSON.stringify(res.body)).toBe(200)
  })

  it('shop B cannot undo shop A\'s delivery — 404, nothing written', async () => {
    const jobId = await deliveredJob()
    const res = await undo(jobId, REASON, 'owner', fx.shopB)
    expect(res.status).toBe(404)
    expect(await auditFor(fx.shopA, 'job_delivery_undone', jobId)).toHaveLength(0)
    expect((await lastHistory(jobId)).status).toBe('delivered')
  })

  it('the database itself refuses an untrimmed or empty reason (ck_status_history_reason)', async () => {
    const jobId = await deliveredJob()
    for (const bad of [' x', 'x ', '﻿x', '', 'a'.repeat(501), '\u{1F600}'.repeat(251)]) {
      await expect(withShop(db, fx.shopA, (trx) => trx.insertInto('job_status_history')
        .values({ shop_id: fx.shopA, job_id: jobId, status: 'ready', reason: bad }).execute()),
      `accepted ${JSON.stringify(bad.slice(0, 12))}`).rejects.toMatchObject({ code: '23514' })
    }
    // The largest values the API accepts pass: 500 UTF-16 units either way.
    for (const ok of ['a'.repeat(500), '\u{1F600}'.repeat(250), 'ก ข']) {
      await withShop(db, fx.shopA, (trx) => trx.insertInto('job_status_history')
        .values({ shop_id: fx.shopA, job_id: jobId, status: 'ready', reason: ok }).execute())
    }
  })
})
