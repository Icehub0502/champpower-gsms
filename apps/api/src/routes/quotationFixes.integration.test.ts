/**
 * Fix round of 6-7 Oct 2026 (code review NO-GO, security M1/M2, owner Q1/Q2).
 * TEST FIRST: every test here was run red against the previous code before the
 * fix, then green after. Owner process rule (DECISION-2026-10-06).
 *
 * TIER 2. Needs PostgreSQL with migrations 0001-0022 and DATABASE_ADMIN_URL.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { sql } from 'kysely'
import { withShop } from '@gsms/db/client.js'
import { db } from '../lib/db.js'
import * as quotationRepo from '../repositories/quotation.js'
import { adminDatabaseUrl, hasDatabase, tier2 } from '../test/env.js'
import {
  createTwoShopFixture, del, get, issueTokensFor, patch, post, startApi,
  type RunningApi, type TwoShopFixture,
} from '../test/fixtures.js'

type Role = Parameters<typeof issueTokensFor>[2]

describe.skipIf(!hasDatabase || !adminDatabaseUrl)(tier2('P3.1 fix round — review findings, Q1/Q2, test-first'), () => {
  let api: RunningApi
  let fx: TwoShopFixture
  let seq = 0
  const tag = Math.floor(Math.random() * 9000) + 1000
  let w90 = ''
  let partItem = ''
  let laborItem = ''
  let setItem = ''

  beforeAll(async () => {
    api = await startApi({ intakeWriteLimit: 1_000_000 })
    fx = await createTwoShopFixture('p31fix')
    await withShop(db, fx.shopA, async (trx) => {
      const one = async (q: ReturnType<typeof sql<{ id: string }>>) => (await q.execute(trx)).rows[0]!.id
      w90 = await one(sql<{ id: string }>`insert into warranty_terms (shop_id, name, days, max_km) values (${fx.shopA}, 'ประกัน 90 วัน', 90, null) returning id`)
      partItem = await one(sql<{ id: string }>`insert into catalog_items (shop_id, category, name, line_type, base_price, warranty_term_id) values (${fx.shopA}, 'ช่วงล่าง', 'ลูกหมากทดสอบ', 'part', '1000.00', ${w90}) returning id`)
      laborItem = await one(sql<{ id: string }>`insert into catalog_items (shop_id, category, name, line_type, base_price) values (${fx.shopA}, 'ค่าแรง', 'ค่าแรงทดสอบ', 'labor', '500.00') returning id`)
      setItem = await one(sql<{ id: string }>`insert into catalog_items (shop_id, category, name, line_type, base_price, is_set) values (${fx.shopA}, 'ชุดโปร', 'ชุดทดสอบ', 'part', '6000.00', true) returning id`)
      for (const [i, n] of ['ชิ้น 1', 'ชิ้น 2', 'ชิ้น 3'].entries()) {
        await sql`insert into catalog_set_components (shop_id, set_item_id, component_name, sort_order) values (${fx.shopA}, ${setItem}, ${n}, ${i})`.execute(trx)
      }
    })
  })

  afterAll(async () => {
    if (fx) {
      const admin = new pg.Client({ connectionString: adminDatabaseUrl })
      await admin.connect()
      try {
        await admin.query('set session_replication_role = replica')
        for (const t of ['vehicle_offered_items', 'document_lines', 'documents', 'catalog_model_prices', 'catalog_set_components', 'catalog_items', 'warranty_terms', 'vehicle_models']) {
          await admin.query(`delete from ${t} where shop_id = any($1)`, [[fx.shopA, fx.shopB]])
        }
      } finally { await admin.end() }
    }
    await fx?.cleanup()
    await api?.close()
  })

  const tok = async (role: Role = 'owner', shop = fx.shopA) => (await issueTokensFor(fx.userId, shop, role)).accessToken
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const POST = async (path: string, body: unknown = {}, role: Role = 'owner', shop = fx.shopA) => post<any>(api, path, body, await tok(role, shop))
  const PATCH = async (path: string, body: unknown = {}, role: Role = 'owner', shop = fx.shopA) => patch<any>(api, path, body, await tok(role, shop))
  const GET = async (path: string, role: Role = 'owner', shop = fx.shopA) => get<any>(api, path, await tok(role, shop))
  const DEL = async (path: string, role: Role = 'owner', shop = fx.shopA) => del<any>(api, path, await tok(role, shop))
  /* eslint-enable @typescript-eslint/no-explicit-any */

  async function checkIn(shop = fx.shopA): Promise<string> {
    seq++
    const r = await POST('/api/checkin', { plate: `ฉก ${tag}${seq}`.slice(0, 12), customerName: 'ทดสอบ', brand: 'ZZBrand', model: 'ZZModel', province: 'กรุงเทพมหานคร' }, 'owner', shop)
    expect(r.status, JSON.stringify(r.body)).toBe(201)
    return r.body.jobId as string
  }
  const freeLine = (name = 'ลูกหมาก', unitPrice = '100', extra: object = {}) => ({ kind: 'free', name, lineType: 'part', qty: '1', unitPrice, addToCatalog: false, ...extra })
  const Q = (jobId: string) => `/api/jobs/${jobId}/quotation`

  async function draft(lines: object[] = [freeLine()]): Promise<string> {
    const jobId = await checkIn()
    expect((await POST(Q(jobId))).status).toBe(201)
    for (const l of lines) { const r = await POST(`${Q(jobId)}/lines`, l); expect(r.status, JSON.stringify(r.body)).toBe(201) }
    return jobId
  }
  async function issued(lines?: object[]): Promise<string> {
    const jobId = await draft(lines)
    const r = await POST(`${Q(jobId)}/issue`)
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    return jobId
  }
  const top = async (jobId: string) => (await GET(Q(jobId))).body.lines.filter((l: { parentLineId: string | null }) => l.parentLineId === null)
  async function approveAll(jobId: string) {
    for (const l of await top(jobId)) {
      const r = await PATCH(`${Q(jobId)}/lines/${l.id}/decision`, { decision: 'approved' })
      expect(r.status, JSON.stringify(r.body)).toBe(200)
    }
  }
  async function confirmed(lines?: object[]): Promise<string> {
    const jobId = await issued(lines)
    await approveAll(jobId)
    const r = await POST(`${Q(jobId)}/confirm`)
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    return jobId
  }
  const dbq = <T,>(fn: (trx: Parameters<Parameters<typeof withShop>[2]>[0]) => Promise<T>, shop = fx.shopA) => withShop(db, shop, fn)
  const jobStatus = (jobId: string) => dbq(async (t) => (await t.selectFrom('jobs').select('status').where('id', '=', jobId).executeTakeFirstOrThrow()).status)
  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: adminDatabaseUrl })
    await c.connect()
    try { await c.query('set session_replication_role = replica'); return await fn(c) } finally { await c.end() }
  }

  // ===========================================================================
  // HIGH 1 — lock order jobs -> documents -> document_lines
  // ===========================================================================
  it('HIGH1: job close racing confirm never deadlocks or 500s, and exactly one wins', async () => {
    const outcomes: string[] = []
    for (let i = 0; i < 12; i++) {
      const jobId = await issued()
      await approveAll(jobId)
      const [close, conf] = await Promise.all([
        PATCH(`/api/jobs/${jobId}/status`, { to: 'rejected', fromStatus: 'quoted' }),
        POST(`${Q(jobId)}/confirm`),
      ])
      expect([close.status, conf.status].filter((s) => s >= 500), `iteration ${i}: close=${close.status} ${JSON.stringify(close.body)} confirm=${conf.status} ${JSON.stringify(conf.body)}`).toHaveLength(0)
      expect([close.status, conf.status].filter((s) => s === 200), `iteration ${i}`).toHaveLength(1)
      outcomes.push(close.status === 200 ? 'close' : 'confirm')
    }
    expect(outcomes.length).toBe(12)
  })

  it('HIGH1: job close racing issue / revise / undo never 500s', async () => {
    for (let i = 0; i < 6; i++) {
      const j = await draft()
      const [close, iss] = await Promise.all([
        PATCH(`/api/jobs/${j}/status`, { to: 'carout', fromStatus: 'received' }),
        POST(`${Q(j)}/issue`),
      ])
      expect([close.status, iss.status].filter((s) => s >= 500), `issue-race ${i}: ${JSON.stringify([close.body, iss.body])}`).toHaveLength(0)
    }
    for (let i = 0; i < 6; i++) {
      const j = await confirmed()
      const [undo, close] = await Promise.all([
        POST(`${Q(j)}/confirm/undo`, { reason: 'ทดสอบ' }),
        PATCH(`/api/jobs/${j}/status`, { to: 'quoted', fromStatus: 'approved' }),
      ])
      expect([undo.status, close.status].filter((s) => s >= 500), `undo-race ${i}: ${JSON.stringify([undo.body, close.body])}`).toHaveLength(0)
    }
  })

  // ===========================================================================
  // HIGH 2 — database CHECKs have a domain check in front (CLAUDE.md §4.y)
  // ===========================================================================
  it('HIGH2: labor with is_vatable=true is a 400 with a field error, not a 500', async () => {
    const jobId = await draft([])
    const r = await POST(`${Q(jobId)}/lines`, freeLine('ค่าแรง', '100', { lineType: 'labor', isVatable: true }))
    expect(r.status, JSON.stringify(r.body)).toBe(400)
    expect(r.body).toMatchObject({ error: 'invalid_request' })
    expect(r.body.fields.isVatable).toContain('labor_not_vatable')
  })

  it('HIGH2: patching a vatable part into labor is a 400, not a 500', async () => {
    const jobId = await draft()
    const line = (await top(jobId))[0]
    const r = await PATCH(`${Q(jobId)}/lines/${line.id}`, { lineType: 'labor' })
    expect(r.status, JSON.stringify(r.body)).toBe(400)
    expect(r.body.fields.isVatable).toContain('labor_not_vatable')
  })

  it('HIGH2: qty x price beyond numeric(12,2) is a 400 on add and on patch, and a total that cannot be stored refuses the line that causes it', async () => {
    const jobId = await draft([])
    const add = await POST(`${Q(jobId)}/lines`, freeLine('ใหญ่', '9999999999.99', { qty: '100' }))
    expect(add.status, JSON.stringify(add.body)).toBe(400)
    expect(add.body.error).toBe('invalid_request')

    const ok = await POST(`${Q(jobId)}/lines`, freeLine('เล็ก', '10'))
    expect(ok.status).toBe(201)
    const id = (await top(jobId))[0].id
    const p = await PATCH(`${Q(jobId)}/lines/${id}`, { unitPrice: '9999999999.99', qty: '100' })
    expect(p.status, JSON.stringify(p.body)).toBe(400)

    // two lines that are each fine but whose TOTAL cannot be stored: the second add is refused, so no unrenderable draft exists
    const j2 = await draft([freeLine('a', '9999999999.99')])
    const second = await POST(`${Q(j2)}/lines`, freeLine('b', '9999999999.99'))
    expect(second.status, JSON.stringify(second.body)).toBe(400)
    expect(second.body.fields.unitPrice).toContain('out_of_range')
  })

  // ===========================================================================
  // HIGH 3 — stale approved_amount
  // ===========================================================================
  it('HIGH3: approved_amount is cleared when the set is no longer partially declined, and then asked for again', async () => {
    const jobId = await draft([{ kind: 'set', itemId: setItem }])
    expect((await POST(`${Q(jobId)}/issue`)).status).toBe(200)
    const header = (await top(jobId))[0]
    const kids = (await GET(Q(jobId))).body.lines.filter((l: { parentLineId: string | null }) => l.parentLineId === header.id)
    expect(kids).toHaveLength(3)
    expect((await PATCH(`${Q(jobId)}/lines/${header.id}/decision`, { decision: 'approved' })).status).toBe(200)
    expect((await PATCH(`${Q(jobId)}/lines/${kids[2].id}/decision`, { decision: 'declined', reason: 'not_needed_yet' })).status).toBe(200)
    const c = await POST(`${Q(jobId)}/confirm`, { adjustments: { setLines: [{ lineId: header.id, approvedAmount: '5000', reason: 'ตัดออก 1 ชิ้น' }] } })
    expect(c.status, JSON.stringify(c.body)).toBe(200)
    expect((await POST(`${Q(jobId)}/confirm/undo`, { reason: 'ลูกค้าเปลี่ยนใจ' })).status).toBe(200)

    // the customer takes the piece back: the set is whole again
    expect((await PATCH(`${Q(jobId)}/lines/${kids[2].id}/decision`, { decision: 'approved' })).status).toBe(200)
    const whole = (await GET(Q(jobId))).body.lines.find((l: { id: string }) => l.id === header.id)
    expect(whole.approvedAmount, 'a whole set must not keep an agreed amount').toBeNull()
    // an amount for a set that is not cut is refused
    const bad = await POST(`${Q(jobId)}/confirm`, { adjustments: { setLines: [{ lineId: header.id, approvedAmount: '4000', reason: 'x' }] } })
    expect(bad.status, JSON.stringify(bad.body)).toBe(400)
    expect(bad.body.error).toBe('approved_amount_not_allowed')

    // cut again: the amount must be asked for again, not silently reused
    expect((await PATCH(`${Q(jobId)}/lines/${kids[1].id}/decision`, { decision: 'declined', reason: 'next_time' })).status).toBe(200)
    const again = await POST(`${Q(jobId)}/confirm`)
    expect(again.status, JSON.stringify(again.body)).toBe(409)
    expect(again.body.error).toBe('set_amount_required')
  })

  it('HIGH3: issuing a revision re-runs checkApprovedAmount on a carried agreed amount', async () => {
    const jobId = await draft([{ kind: 'set', itemId: setItem }])
    await POST(`${Q(jobId)}/issue`)
    const header = (await top(jobId))[0]
    const kids = (await GET(Q(jobId))).body.lines.filter((l: { parentLineId: string | null }) => l.parentLineId === header.id)
    await PATCH(`${Q(jobId)}/lines/${header.id}/decision`, { decision: 'approved' })
    await PATCH(`${Q(jobId)}/lines/${kids[2].id}/decision`, { decision: 'declined', reason: 'not_needed_yet' })
    expect((await POST(`${Q(jobId)}/confirm`, { adjustments: { setLines: [{ lineId: header.id, approvedAmount: '5000', reason: 'ตัด' }] } })).status).toBe(200)
    expect((await POST(`${Q(jobId)}/revise`, {})).status).toBe(201)
    // a bad amount sneaks into the draft (direct write, triggers off): issue must refuse it
    await admin((c) => c.query(`update document_lines set approved_amount = '90000.00' where document_id = (select id from documents where job_id = $1 and status = 'draft') and parent_line_id is null and approved_amount is not null`, [jobId]))
    const iss = await POST(`${Q(jobId)}/issue`)
    expect(iss.status, JSON.stringify(iss.body)).toBe(422)
    expect(iss.body.error).toBe('amount_over_2x')
  })

  // ===========================================================================
  // HIGH 4 — one limiter, each request counted once
  // ===========================================================================
  it('HIGH4: the write limiter counts a quotation write once (limit 8 allows 8 writes)', async () => {
    const jobId = await draft([])
    const small = await startApi({ intakeWriteLimit: 8 })
    try {
      const t = await tok()
      const statuses: number[] = []
      for (let i = 0; i < 9; i++) statuses.push((await patch<any>(small, Q(jobId), { discount: String(i) }, t)).status) // eslint-disable-line @typescript-eslint/no-explicit-any
      expect(statuses.slice(0, 8), JSON.stringify(statuses)).toEqual(Array(8).fill(200))
      expect(statuses[8]).toBe(429)
    } finally { await small.close() }
  })

  // ===========================================================================
  // approved_total on issue, and the snapshot read
  // ===========================================================================
  it('approved_total written on issuing a revision equals what the carried decisions approve (read from the DB)', async () => {
    const jobId = await confirmed([freeLine('a', '100'), freeLine('b', '250')])
    expect((await POST(`${Q(jobId)}/revise`, {})).status).toBe(201)
    expect((await POST(`${Q(jobId)}/issue`)).status).toBe(200)
    const row = await dbq(async (t) => t.selectFrom('documents').select(['approved_total', 'offered_total', 'discount']).where('job_id', '=', jobId).where('status', '=', 'issued').executeTakeFirstOrThrow())
    expect(row.offered_total).toBe('350.00')
    expect(row.approved_total, 'carried approvals must be in the stored total').toBe('350.00')
  })

  it('a numbered quotation is read from its stored totals, never recomputed (CLAUDE.md §4.4)', async () => {
    const jobId = await issued([freeLine('a', '100')])
    await admin((c) => c.query(`update documents set offered_total = '1.00', approved_total = '2.00' where job_id = $1`, [jobId]))
    const q = (await GET(Q(jobId))).body
    expect(q.totals.offeredTotal).toBe('1.00')
    expect(q.totals.approvedTotal).toBe('2.00')
  })

  // ===========================================================================
  // MEDIUM
  // ===========================================================================
  it('voiding a draft is a 409, not a 500', async () => {
    const jobId = await draft()
    const r = await POST(`${Q(jobId)}/void`, { reason: 'ทดสอบ' })
    expect(r.status, JSON.stringify(r.body)).toBe(409)
  })

  it('concurrent quotation creates: one 201, the rest 409 quotation_exists, never 500', async () => {
    const jobId = await checkIn()
    const rs = await Promise.all(Array.from({ length: 8 }, () => POST(Q(jobId))))
    expect(rs.filter((r) => r.status >= 500), JSON.stringify(rs.map((r) => r.body))).toHaveLength(0)
    expect(rs.filter((r) => r.status === 201)).toHaveLength(1)
    for (const r of rs.filter((x) => x.status === 409)) expect(r.body.error).toBe('quotation_exists')
  })

  it('M2: a decision is audited with line id and before/after status, without the free-text note', async () => {
    const jobId = await issued([freeLine('a', '100')])
    const line = (await top(jobId))[0]
    const r = await PATCH(`${Q(jobId)}/lines/${line.id}/decision`, { decision: 'declined', reason: 'other', note: 'ชื่อลูกค้าสมชาย ไม่เอา' })
    expect(r.status).toBe(200)
    const rows = await dbq((t) => t.selectFrom('audit_logs').select(['before', 'after', 'actor_id']).where('action', '=', 'quotation_line_decided').where('entity_id', '=', line.id).execute())
    expect(rows).toHaveLength(1)
    expect(JSON.stringify(rows[0]!.before)).toContain('pending')
    expect(JSON.stringify(rows[0]!.after)).toContain('declined')
    expect(JSON.stringify(rows[0]), 'the free-text note must not reach audit_logs').not.toContain('สมชาย')
    expect(rows[0]!.actor_id).toBe(fx.userId)
  })

  it('HIGH1 predicate: closing the job declines ONLY pending lines; an approved line stays approved', async () => {
    const jobId = await issued([freeLine('อนุมัติแล้ว', '100'), freeLine('ยังไม่ตัดสิน', '200')])
    const [approvedLine, pendingLine] = await top(jobId)
    expect((await PATCH(`${Q(jobId)}/lines/${approvedLine.id}/decision`, { decision: 'approved' })).status).toBe(200)
    const close = await PATCH(`/api/jobs/${jobId}/status`, { to: 'rejected', fromStatus: 'quoted', declineReason: 'too_expensive' })
    expect(close.status, JSON.stringify(close.body)).toBe(200)
    const rows = await dbq((t) => t.selectFrom('document_lines').select(['id', 'approval_status', 'decline_reason']).where('id', 'in', [approvedLine.id, pendingLine.id]).execute())
    expect(rows.find((r) => r.id === approvedLine.id)!.approval_status).toBe('approved')
    expect(rows.find((r) => r.id === approvedLine.id)!.decline_reason).toBeNull()
    expect(rows.find((r) => r.id === pendingLine.id)).toMatchObject({ approval_status: 'declined', decline_reason: 'too_expensive' })
  })

  it('HIGH1 predicate (repository, deterministic): declinePending never overwrites a line that is no longer pending', async () => {
    // The service passes only the lines it saw pending, but a decision can land between that read and
    // this UPDATE; the WHERE approval_status = 'pending' is what keeps that decision. Hand the
    // repository an already-approved line to prove the predicate itself, not just the id list.
    const jobId = await issued([freeLine('อนุมัติแล้ว', '100'), freeLine('ยังไม่ตัดสิน', '200')])
    const [approvedLine, pendingLine] = await top(jobId)
    expect((await PATCH(`${Q(jobId)}/lines/${approvedLine.id}/decision`, { decision: 'approved' })).status).toBe(200)
    await dbq((t) => quotationRepo.declinePending(t, [approvedLine.id, pendingLine.id], { declineReason: 'too_expensive', declineNote: null, decidedBy: fx.userId }))
    const rows = await dbq((t) => t.selectFrom('document_lines').select(['id', 'approval_status']).where('id', 'in', [approvedLine.id, pendingLine.id]).execute())
    expect(rows.find((r) => r.id === approvedLine.id)!.approval_status).toBe('approved')
    expect(rows.find((r) => r.id === pendingLine.id)!.approval_status).toBe('declined')
  })

  it('undo-confirm audits the job status change too', async () => {
    const jobId = await confirmed()
    expect((await POST(`${Q(jobId)}/confirm/undo`, { reason: 'ทดสอบ' })).status).toBe(200)
    const rows = await dbq((t) => t.selectFrom('audit_logs').select(['after']).where('action', '=', 'job_status_changed').where('entity_id', '=', jobId).execute())
    // one row from issue (received -> quoted) and one from the undo (approved -> quoted)
    expect(rows.map((r) => JSON.stringify(r.after)).filter((s) => s.includes('quoted'))).toHaveLength(2)
    expect(await jobStatus(jobId)).toBe('quoted')
  })

  it('PATCH warrantyTermId is applied: re-snapshotted, clearable, and a foreign term is a 404', async () => {
    const jobId = await draft([freeLine('a', '100')])
    const line = (await top(jobId))[0]
    const set = await PATCH(`${Q(jobId)}/lines/${line.id}`, { warrantyTermId: w90 })
    expect(set.status, JSON.stringify(set.body)).toBe(200)
    const w = set.body.lines[0].warranty
    expect(w, 'warranty must be snapshotted from the term').toMatchObject({ termId: w90, name: 'ประกัน 90 วัน', days: 90, maxKm: null })
    const cleared = await PATCH(`${Q(jobId)}/lines/${line.id}`, { warrantyTermId: null })
    expect(cleared.body.lines[0].warranty).toBeNull()
    const foreign = await PATCH(`${Q(jobId)}/lines/${line.id}`, { warrantyTermId: randomUUID() })
    expect(foreign.status).toBe(404)
    expect(foreign.body.error).toBe('warranty_term_not_found')
  })

  it('an ended job cannot get a new quotation, a revision, or an issue (409)', async () => {
    const rejected = await checkIn()
    await admin((c) => c.query(`update jobs set status = 'rejected' where id = $1`, [rejected]))
    expect((await POST(Q(rejected))).status).toBe(409)

    const toIssue = await draft()
    await admin((c) => c.query(`update jobs set status = 'delivered' where id = $1`, [toIssue]))
    expect((await POST(`${Q(toIssue)}/issue`)).status).toBe(409)

    const toRevise = await confirmed()
    await admin((c) => c.query(`update jobs set status = 'carout' where id = $1`, [toRevise]))
    expect((await POST(`${Q(toRevise)}/revise`, {})).status).toBe(409)
  })

  it('a merged item is resolved to the survivor wherever an item id is used', async () => {
    const mk = async (name: string) => (await POST('/api/catalog/items', { category: 'รวมแล้ว', name, confirmNotSimilar: true }, 'owner')).body.id as string
    const a = await mk('ก-รายการเก่า'); const b = await mk('ข-รายการใหม่')
    expect((await POST(`/api/catalog/items/${a}/merge`, { intoItemId: b }, 'manager')).status).toBe(200)
    const jobId = await draft([])
    const r = await POST(`${Q(jobId)}/lines`, { kind: 'item', itemId: a, unitPrice: '10' })
    expect(r.status, JSON.stringify(r.body)).toBe(201)
    expect(r.body.lines[0].catalogItemId, 'the line must point at the survivor').toBe(b)
    expect(r.body.lines[0].name).toBe('ข-รายการใหม่')
    const free = await POST(`${Q(jobId)}/lines`, freeLine('x', '5', { addToCatalog: true, useExistingItemId: a }))
    expect(free.body.lines.at(-1).catalogItemId).toBe(b)
  })

  it('M1: revise keeps offered rows; confirming rev 2 with the same next_time line leaves exactly ONE active row; undo removes only its own', async () => {
    const jobId = await issued([freeLine('เอาไว้ก่อน', '100'), freeLine('เอา', '200')])
    const [first, second] = await top(jobId)
    await PATCH(`${Q(jobId)}/lines/${first.id}/decision`, { decision: 'declined', reason: 'next_time' })
    await PATCH(`${Q(jobId)}/lines/${second.id}/decision`, { decision: 'approved' })
    expect((await POST(`${Q(jobId)}/confirm`)).status).toBe(200)
    const vehicleId = await dbq(async (t) => (await t.selectFrom('jobs').select('vehicle_id').where('id', '=', jobId).executeTakeFirstOrThrow()).vehicle_id)
    const offered = async () => (await GET(`/api/vehicles/${vehicleId}/offered-items`)).body.items.length
    expect(await offered()).toBe(1)
    expect((await POST(`${Q(jobId)}/revise`, {})).status).toBe(201)
    expect(await offered(), 'revise must not delete "offer next time" data (rev 2 may never be confirmed)').toBe(1)
    expect((await POST(`${Q(jobId)}/issue`)).status).toBe(200)
    const statusBeforeRev2Confirm = await jobStatus(jobId)
    expect((await POST(`${Q(jobId)}/confirm`)).status).toBe(200)
    expect(await offered(), 'same vehicle + same item must not be offered twice').toBe(1)
    // undo of rev 2's confirm removes only rows that confirm wrote: the rev-1 row stays
    expect((await POST(`${Q(jobId)}/confirm/undo`, { reason: 'ทดสอบ' })).status).toBe(200)
    expect(await offered(), 'undo must not remove the older row it never wrote').toBe(1)
    expect(await jobStatus(jobId), 'undo puts the job back to what it was before THIS confirm').toBe(statusBeforeRev2Confirm)
  })

  it('FIX2: undo of a confirm that did not advance the job (already approved) leaves the job approved', async () => {
    const jobId = await issued([freeLine('a', '100')])
    const l = (await top(jobId))[0]
    expect((await PATCH(`${Q(jobId)}/lines/${l.id}/decision`, { decision: 'approved' })).status).toBe(200)
    // the job is already approved before this confirm runs
    await admin((c) => c.query(`update jobs set status = 'approved' where id = $1`, [jobId]))
    expect((await POST(`${Q(jobId)}/confirm`)).status).toBe(200)
    expect(await jobStatus(jobId)).toBe('approved')
    const undo = await POST(`${Q(jobId)}/confirm/undo`, { reason: 'ทดสอบ' })
    expect(undo.status, JSON.stringify(undo.body)).toBe(200)
    expect(await jobStatus(jobId), 'this confirm never moved the job, so undo must not move it').toBe('approved')
  })

  // ===========================================================================
  // FIX1 — a set's decision does not survive an edit to any member of the set
  // ===========================================================================
  /** A confirmed rev 1 set with the 3rd piece declined and an agreed price, then rev 2 as a draft. */
  async function revisionDraftWithCutSet(extraTop?: object) {
    const jobId = await draft(extraTop ? [{ kind: 'set', itemId: setItem }, extraTop] : [{ kind: 'set', itemId: setItem }])
    expect((await POST(`${Q(jobId)}/issue`)).status).toBe(200)
    const lines = (await GET(Q(jobId))).body.lines
    const header = lines.find((l: { parentLineId: string | null; name: string }) => l.parentLineId === null && l.name === 'ชุดทดสอบ')
    const kids = lines.filter((l: { parentLineId: string | null }) => l.parentLineId === header.id)
    expect((await PATCH(`${Q(jobId)}/lines/${header.id}/decision`, { decision: 'approved' })).status).toBe(200)
    expect((await PATCH(`${Q(jobId)}/lines/${kids[2].id}/decision`, { decision: 'declined', reason: 'next_time' })).status).toBe(200)
    if (extraTop) {
      const other = lines.find((l: { parentLineId: string | null; name: string }) => l.parentLineId === null && l.name !== 'ชุดทดสอบ')
      expect((await PATCH(`${Q(jobId)}/lines/${other.id}/decision`, { decision: 'approved' })).status).toBe(200)
    }
    const c = await POST(`${Q(jobId)}/confirm`, { adjustments: { setLines: [{ lineId: header.id, approvedAmount: '5000', reason: 'ตัดออก 1 ชิ้น' }] } })
    expect(c.status, JSON.stringify(c.body)).toBe(200)
    expect((await POST(`${Q(jobId)}/revise`, {})).status).toBe(201)
    const q = (await GET(Q(jobId))).body
    const h2 = q.lines.find((l: { parentLineId: string | null; name: string }) => l.parentLineId === null && l.name === 'ชุดทดสอบ')
    const k2 = q.lines.filter((l: { parentLineId: string | null }) => l.parentLineId === h2.id)
    expect(h2.decisionCarriedFrom, 'precondition: the set carries on rev 2').not.toBeNull()
    expect(h2.approvedAmount).toBe('5000.00')
    return { jobId, h2, k2 }
  }
  const expectSetReset = async (jobId: string, h2Id: string, expectedLines: number) => {
    const q = (await GET(Q(jobId))).body
    const members = q.lines.filter((l: { id: string; parentLineId: string | null }) => l.id === h2Id || l.parentLineId === h2Id)
    expect(members).toHaveLength(expectedLines)
    for (const m of members) {
      expect(m, m.name).toMatchObject({ approvalStatus: 'pending', approvedAmount: null, decisionCarriedFrom: null, decidedAt: null })
    }
    return q
  }
  const setResetAudits = (jobId: string) => dbq(async (t) => {
    const doc = await t.selectFrom('documents').select('id').where('job_id', '=', jobId).where('status', '=', 'draft').executeTakeFirstOrThrow()
    return t.selectFrom('audit_logs').select(['actor_id', 'after']).where('action', '=', 'set_decision_reset').where('entity_id', '=', doc.id).execute()
  })

  it('FIX1(a): removing a declined child on a revision draft resets the head and every remaining child; the set is not charged', async () => {
    const { jobId, h2, k2 } = await revisionDraftWithCutSet()
    expect((await DEL(`${Q(jobId)}/lines/${k2[2].id}`)).status).toBe(200)
    const q = await expectSetReset(jobId, h2.id, 3)
    expect(q.totals.approvedTotal, 'the set was never re-decided, so it approves nothing').toBe('0.00')
    const audits = await setResetAudits(jobId)
    expect(audits).toHaveLength(1)
    expect(audits[0]!.actor_id).toBe(fx.userId)
    const a = audits[0]!.after as { reasonCode: string; lineIds: string[] }
    expect(a.reasonCode).toBe('set_changed_decision_reset')
    expect([...a.lineIds].sort()).toEqual([h2.id, k2[0].id, k2[1].id].sort())
  })

  it('FIX1(b): patching a child qty on a revision draft resets the whole set', async () => {
    const { jobId, h2, k2 } = await revisionDraftWithCutSet()
    expect((await PATCH(`${Q(jobId)}/lines/${k2[0].id}`, { qty: '2' })).status).toBe(200)
    await expectSetReset(jobId, h2.id, 4)
    expect(await setResetAudits(jobId)).toHaveLength(1)
  })

  it('FIX1(b3): a child patch that changes only sortOrder or brand (not identity) leaves the set decided', async () => {
    const { jobId, h2, k2 } = await revisionDraftWithCutSet()
    expect((await PATCH(`${Q(jobId)}/lines/${k2[0].id}`, { sortOrder: 99 })).status).toBe(200)
    expect((await PATCH(`${Q(jobId)}/lines/${k2[1].id}`, { brand: 'BrandX' })).status).toBe(200)
    const q = (await GET(Q(jobId))).body
    expect(q.lines.find((l: { id: string }) => l.id === h2.id)).toMatchObject({ approvalStatus: 'approved', approvedAmount: '5000.00' })
    expect(q.lines.find((l: { id: string }) => l.id === k2[0].id).approvalStatus).toBe('approved')
    expect(q.lines.find((l: { id: string }) => l.id === k2[2].id).approvalStatus).toBe('declined')
    expect(await setResetAudits(jobId)).toHaveLength(0)
  })

  it('FIX1(b2): patching the head price resets the head AND its children', async () => {
    const { jobId, h2 } = await revisionDraftWithCutSet()
    expect((await PATCH(`${Q(jobId)}/lines/${h2.id}`, { unitPrice: '5500' })).status).toBe(200)
    await expectSetReset(jobId, h2.id, 4)
  })

  it('FIX1(c): editing an unrelated top-level line does NOT reset the set', async () => {
    const { jobId, h2, k2 } = await revisionDraftWithCutSet(freeLine('อื่น', '100'))
    const q0 = (await GET(Q(jobId))).body
    const other = q0.lines.find((l: { parentLineId: string | null; name: string }) => l.parentLineId === null && l.name === 'อื่น')
    expect((await PATCH(`${Q(jobId)}/lines/${other.id}`, { unitPrice: '150' })).status).toBe(200)
    const q = (await GET(Q(jobId))).body
    const head = q.lines.find((l: { id: string }) => l.id === h2.id)
    expect(head).toMatchObject({ approvalStatus: 'approved', approvedAmount: '5000.00' })
    expect(head.decisionCarriedFrom).not.toBeNull()
    expect(q.lines.find((l: { id: string }) => l.id === k2[2].id).approvalStatus).toBe('declined')
    expect(await setResetAudits(jobId)).toHaveLength(0)
  })

  // ===========================================================================
  // Owner Q1 — work order
  // ===========================================================================
  it('Q1: work order — 409 quotation_missing / quotation_not_confirmed, 200 empty only when signed and all declined', async () => {
    const none = await checkIn()
    const a = await GET(`/api/jobs/${none}/work-order`)
    expect(a.status, JSON.stringify(a.body)).toBe(409)
    expect(a.body.error).toBe('quotation_missing')

    const d = await draft()
    const b = await GET(`/api/jobs/${d}/work-order`)
    expect(b.status).toBe(409)
    expect(b.body.error).toBe('quotation_not_confirmed')
    await POST(`${Q(d)}/issue`)
    expect((await GET(`/api/jobs/${d}/work-order`)).body.error).toBe('quotation_not_confirmed')

    const all = await issued([freeLine('a', '100')])
    const l = (await top(all))[0]
    await PATCH(`${Q(all)}/lines/${l.id}/decision`, { decision: 'declined', reason: 'too_expensive' })
    expect((await POST(`${Q(all)}/confirm`)).status).toBe(200)
    const c = await GET(`/api/jobs/${all}/work-order`)
    expect(c.status).toBe(200)
    expect(c.body.lines).toEqual([])
  })

  // ===========================================================================
  // Owner Q2 — decisions carried into a revision
  // ===========================================================================
  it('Q2: unchanged lines keep their decision (decisionCarriedFrom), a changed price resets to pending, new lines are pending', async () => {
    const jobId = await issued([freeLine('คงเดิม', '100'), freeLine('แก้ราคา', '200'), freeLine('แก้จำนวน', '300')])
    await approveAll(jobId)
    expect((await POST(`${Q(jobId)}/confirm`)).status).toBe(200)
    const old = await top(jobId)
    expect((await POST(`${Q(jobId)}/revise`, {})).status).toBe(201)
    let q = (await GET(Q(jobId))).body
    const byName = (n: string) => q.lines.find((l: { name: string }) => l.name === n)
    for (const n of ['คงเดิม', 'แก้ราคา', 'แก้จำนวน']) {
      expect(byName(n).approvalStatus).toBe('approved')
      expect(byName(n).decisionCarriedFrom, n).toBe(old.find((o: { name: string }) => o.name === n).id)
    }
    expect((await PATCH(`${Q(jobId)}/lines/${byName('แก้ราคา').id}`, { unitPrice: '150' })).status).toBe(200)
    expect((await PATCH(`${Q(jobId)}/lines/${byName('แก้จำนวน').id}`, { qty: '2' })).status).toBe(200)
    expect((await POST(`${Q(jobId)}/lines`, freeLine('ใหม่', '50'))).status).toBe(201)
    q = (await GET(Q(jobId))).body
    expect(byName('คงเดิม')).toMatchObject({ approvalStatus: 'approved' })
    expect(byName('คงเดิม').decisionCarriedFrom).not.toBeNull()
    expect(byName('แก้ราคา')).toMatchObject({ approvalStatus: 'pending', decisionCarriedFrom: null })
    expect(byName('แก้จำนวน')).toMatchObject({ approvalStatus: 'pending', decisionCarriedFrom: null })
    expect(byName('ใหม่')).toMatchObject({ approvalStatus: 'pending', decisionCarriedFrom: null })
    // a carried decision keeps its original decided_at / decided_by (L2)
    const carried = await dbq((t) => t.selectFrom('document_lines').select(['decided_at', 'decided_by']).where('id', '=', byName('คงเดิม').id).executeTakeFirstOrThrow())
    const orig = await dbq((t) => t.selectFrom('document_lines').select(['decided_at']).where('id', '=', old.find((o: { name: string }) => o.name === 'คงเดิม').id).executeTakeFirstOrThrow())
    expect(carried.decided_at?.getTime()).toBe(orig.decided_at?.getTime())
  })

  it('L2: a revision carries the discount', async () => {
    const jobId = await draft([freeLine('a', '1000')])
    expect((await PATCH(Q(jobId), { discount: '100' })).status).toBe(200)
    await POST(`${Q(jobId)}/issue`)
    await approveAll(jobId)
    await POST(`${Q(jobId)}/confirm`)
    expect((await POST(`${Q(jobId)}/revise`, {})).status).toBe(201)
    expect((await GET(Q(jobId))).body.totals.discount).toBe('100.00')
  })

  // ===========================================================================
  // LOW
  // ===========================================================================
  it('L4: an offered item of ANOTHER vehicle cannot be re-added to this job', async () => {
    const j1 = await issued([freeLine('เอาไว้ก่อน', '100'), freeLine('เอา', '200')])
    const [first, second] = await top(j1)
    await PATCH(`${Q(j1)}/lines/${first.id}/decision`, { decision: 'declined', reason: 'next_time' })
    await PATCH(`${Q(j1)}/lines/${second.id}/decision`, { decision: 'approved' })
    await POST(`${Q(j1)}/confirm`)
    const vehicleId = await dbq(async (t) => (await t.selectFrom('jobs').select('vehicle_id').where('id', '=', j1).executeTakeFirstOrThrow()).vehicle_id)
    const offeredId = (await GET(`/api/vehicles/${vehicleId}/offered-items`)).body.items[0].id as string

    const j2 = await draft([])
    const r = await POST(`${Q(j2)}/lines`, { kind: 'offered', offeredItemId: offeredId })
    expect(r.status, JSON.stringify(r.body)).toBe(404)
    expect(r.body.error).toBe('offered_item_not_found')
  })

  it('L6: % and _ in a search are literal, not wildcards', async () => {
    const jobId = await draft([])
    const pct = await GET(`/api/catalog/search?q=${encodeURIComponent('%%')}&jobId=${jobId}`)
    expect(pct.status).toBe(200)
    expect(pct.body.items, '"%%" must match nothing').toEqual([])
    const us = await GET(`/api/catalog/search?q=${encodeURIComponent('__')}&jobId=${jobId}`)
    expect(us.body.items).toEqual([])
    const vm = await GET(`/api/vehicle-models?q=${encodeURIComponent('%')}`)
    expect(vm.body.items).toEqual([])
  })

  it('L4 undo: D5 (all declined, job still quoted) can be undone the same day; a moved-on job is refused with job_moved_on', async () => {
    const j = await issued([freeLine('a', '100')])
    const l = (await top(j))[0]
    await PATCH(`${Q(j)}/lines/${l.id}/decision`, { decision: 'declined', reason: 'too_expensive' })
    expect((await POST(`${Q(j)}/confirm`)).status).toBe(200)
    expect(await jobStatus(j)).toBe('quoted')
    const undo = await POST(`${Q(j)}/confirm/undo`, { reason: 'กดผิด' })
    expect(undo.status, JSON.stringify(undo.body)).toBe(200)
    expect(await jobStatus(j)).toBe('quoted')

    const moved = await confirmed()
    expect((await PATCH(`/api/jobs/${moved}/status`, { to: 'repairing', fromStatus: 'approved' })).status).toBe(200)
    const refused = await POST(`${Q(moved)}/confirm/undo`, { reason: 'x' })
    expect(refused.status).toBe(409)
    expect(refused.body.error).toBe('undo_confirm_job_moved_on')
    const notSigned = await issued()
    const ns = await POST(`${Q(notSigned)}/confirm/undo`, { reason: 'x' })
    expect(ns.status).toBe(409)
    expect(ns.body.error, 'not signed has its own code').toBe('quotation_not_confirmed')
  })

  it('L8: assigning a vehicle model records the previous model in the audit before', async () => {
    const jobId = await checkIn()
    const vehicleId = await dbq(async (t) => (await t.selectFrom('jobs').select('vehicle_id').where('id', '=', jobId).executeTakeFirstOrThrow()).vehicle_id)
    const m1 = (await POST('/api/vehicle-models', { brand: 'FixBrand', name: `M1-${tag}` })).body.id as string
    const m2 = (await POST('/api/vehicle-models', { brand: 'FixBrand', name: `M2-${tag}` })).body.id as string
    const put = async (id: string) => fetch(`${api.url}/api/vehicles/${vehicleId}/model`, { method: 'PUT', headers: { 'content-type': 'application/json', authorization: `Bearer ${await tok()}` }, body: JSON.stringify({ vehicleModelId: id }) })
    expect((await put(m1)).status).toBe(200)
    expect((await put(m2)).status).toBe(200)
    const rows = await dbq((t) => t.selectFrom('audit_logs').select(['before', 'after']).where('action', '=', 'vehicle_model_assigned').where('entity_id', '=', vehicleId).orderBy('at', 'asc').execute())
    expect(rows).toHaveLength(2)
    expect(JSON.stringify(rows[1]!.before)).toContain(m1)
    expect(JSON.stringify(rows[1]!.after)).toContain(m2)
  })

  it('M9: search puts sets first, then the shop\'s most-used items', async () => {
    const jobId = await draft([])
    for (let i = 0; i < 3; i++) await POST(`${Q(jobId)}/lines`, { kind: 'item', itemId: laborItem })
    await POST(`${Q(jobId)}/lines`, { kind: 'item', itemId: partItem })
    const r = await GET(`/api/catalog/search?q=${encodeURIComponent('ทดสอบ')}&jobId=${jobId}`)
    const names = r.body.items.map((i: { name: string }) => i.name)
    expect(names[0]).toBe('ชุดทดสอบ')
    expect(names.indexOf('ค่าแรงทดสอบ'), JSON.stringify(names)).toBeLessThan(names.indexOf('ลูกหมากทดสอบ'))
    expect(r.body.items.find((i: { name: string }) => i.name === 'ค่าแรงทดสอบ').section).toBe('frequent')
  })

  it('DEL of a missing quotation line still 404s with the same body (regression for HIGH-fix)', async () => {
    const jobId = await draft()
    const r = await DEL(`${Q(jobId)}/lines/${randomUUID()}`)
    expect(r.status).toBe(404)
  })
})
