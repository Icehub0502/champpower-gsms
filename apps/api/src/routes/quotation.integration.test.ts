/**
 * P3.1 quotation + per-line approval — acceptance criteria (docs/WORK-ORDERS/
 * P3.1-TECH-PLAN-v3.md §12, AC1-AC21 incl. AC18b), D10 in full, the Q2 tiers,
 * Q1 (a job ending), the freeze through the API, the write paths DECISION-
 * 2026-10-03 §C kept in scope, and two-shop isolation for every quotation
 * endpoint.
 *
 * TIER 2. Needs PostgreSQL with migrations 0001-0022 applied, the connection
 * made as gsms_app, and DATABASE_ADMIN_URL (cleanup of numbered documents
 * needs triggers off — gsms_app cannot delete them, which is the point).
 *
 * Written by someone who did NOT write the API. A test that fails here is a
 * finding, not an inconvenience: do not weaken an assertion to make it pass.
 * Tests whose name starts with "BUG?" encode the spec's behaviour for a case
 * the WIP code is suspected not to meet.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { sql } from 'kysely'
import pg from 'pg'
import { isTrueDecline } from '@champpower/domain'
import type { OfferedItemPage, Quotation, WorkOrder } from '@gsms/contracts/index.js'
import { withShop } from '@gsms/db/client.js'
import { db } from '../lib/db.js'
import { adminDatabaseUrl, hasDatabase, tier2 } from '../test/env.js'
import {
  createTwoShopFixture, del, get, issueTokensFor, patch, post, startApi,
  type ApiResponse, type RunningApi, type TwoShopFixture,
} from '../test/fixtures.js'

type Role = Parameters<typeof issueTokensFor>[2]
type Res<T = any> = ApiResponse<T> // eslint-disable-line @typescript-eslint/no-explicit-any
type Line = Quotation['lines'][number]

interface Seed {
  w90: string
  w365: string
  vehicleModel: string
  ball: string
  labor: string
  unpriced: string
  modelPriced: string
  set: string
  setChildren: string[]
}

const COST_KEY = /cost|margin|profit/i

/** Every key, at every depth, of a JSON value. */
function allKeys(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) v.forEach((x) => allKeys(x, out))
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) { out.push(k); allKeys(x, out) }
  }
  return out
}

describe.skipIf(!hasDatabase || !adminDatabaseUrl)(
  tier2('P3.1 quotation API — AC1-AC21, D10, Q1, Q2, freeze, isolation (needs DATABASE_ADMIN_URL)'),
  () => {
    let api: RunningApi
    let fx: TwoShopFixture
    const seeds = {} as Record<string, Seed>

    // -------------------------------------------------------------------------
    // lifecycle
    // -------------------------------------------------------------------------
    beforeAll(async () => {
      api = await startApi({ intakeWriteLimit: 1_000_000 })
      fx = await createTwoShopFixture('p31q')
      seeds[fx.shopA] = await seedShop(fx.shopA)
      seeds[fx.shopB] = await seedShop(fx.shopB)
    })

    afterAll(async () => {
      if (fx) {
        const admin = new pg.Client({ connectionString: adminDatabaseUrl })
        await admin.connect()
        try {
          // gsms_app may not delete a numbered document (the trigger is the
          // feature), so triggers are switched off on this admin session only.
          await admin.query('set session_replication_role = replica')
          const shops = [[fx.shopA, fx.shopB]]
          for (const t of [
            'vehicle_offered_items', 'document_lines', 'documents', 'catalog_model_prices',
            'catalog_set_components', 'catalog_items', 'warranty_terms', 'vehicle_models',
          ]) await admin.query(`delete from ${t} where shop_id = any($1)`, shops)
        } finally { await admin.end() }
      }
      await fx?.cleanup()
      await api?.close()
    })

    // -------------------------------------------------------------------------
    // helpers
    // -------------------------------------------------------------------------
    const tokenCache = new Map<string, string>()
    async function tok(role: Role = 'owner', shop = fx.shopA, userId = fx.userId): Promise<string> {
      const key = `${userId}|${shop}|${role}`
      let t = tokenCache.get(key)
      if (!t) { t = (await issueTokensFor(userId, shop, role)).accessToken; tokenCache.set(key, t) }
      return t
    }
    const GET = async <T = any>(path: string, role: Role = 'owner', shop = fx.shopA): Promise<Res<T>> =>
      get<T>(api, path, await tok(role, shop))
    const POST = async <T = any>(path: string, body: unknown = {}, role: Role = 'owner', shop = fx.shopA): Promise<Res<T>> =>
      post<T>(api, path, body, await tok(role, shop))
    const PATCH = async <T = any>(path: string, body: unknown = {}, role: Role = 'owner', shop = fx.shopA): Promise<Res<T>> =>
      patch<T>(api, path, body, await tok(role, shop))
    const DEL = async <T = any>(path: string, role: Role = 'owner', shop = fx.shopA): Promise<Res<T>> =>
      del<T>(api, path, await tok(role, shop))

    async function seedShop(shop: string): Promise<Seed> {
      return withShop(db, shop, async (trx) => {
        const id = async (q: ReturnType<typeof sql<{ id: string }>>) => (await q.execute(trx)).rows[0]!.id
        const w90 = await id(sql<{ id: string }>`insert into warranty_terms (shop_id, name, days, max_km)
          values (${shop}, 'รับประกัน 90 วัน', 90, null) returning id`)
        const w365 = await id(sql<{ id: string }>`insert into warranty_terms (shop_id, name, days, max_km)
          values (${shop}, '1 ปี / 20,000 กม.', 365, 20000) returning id`)
        const vehicleModel = await id(sql<{ id: string }>`insert into vehicle_models (shop_id, brand, name, year_range)
          values (${shop}, 'Toyota', 'Vios', '2013-2022') returning id`)
        const item = (category: string, name: string, lineType: string, base: string | null, w: string | null, isSet = false) =>
          id(sql<{ id: string }>`insert into catalog_items (shop_id, category, name, line_type, base_price, warranty_term_id, is_set)
            values (${shop}, ${category}, ${name}, ${lineType}, ${base}, ${w}, ${isSet}) returning id`)
        const ball = await item('ช่วงล่าง', 'ลูกหมากปีกนกล่าง', 'part', '1000.00', w90)
        const labor = await item('ค่าแรง', 'ค่าแรงตั้งศูนย์', 'labor', '500.00', null)
        const unpriced = await item('ช่วงล่าง', 'ยางครอบแร็ค', 'part', null, null)
        const modelPriced = await item('ช่วงล่าง', 'ลูกหมากแร็ค', 'part', '800.00', w90)
        await sql`insert into catalog_model_prices (shop_id, item_id, vehicle_model_id, price)
          values (${shop}, ${modelPriced}, ${vehicleModel}, '1200.00')`.execute(trx)
        const set = await item('ชุดโปร', 'ชุดโปรช่วงล่าง', 'part', '6000.00', w365, true)
        const kids: string[] = []
        const comps: Array<[string, string, string | null]> = [
          ['ลูกหมากบน', 'part', w90], ['ลูกหมากล่าง', 'part', w90], ['คันชัก', 'part', w365],
          ['ยางกันโคลง', 'part', null], ['ลูกปืนล้อ', 'part', w90],
        ]
        for (const [i, [name, lt, w]] of comps.entries()) {
          const cid = await item('ชิ้นส่วนชุด', name, lt, null, w)
          kids.push(cid)
          await sql`insert into catalog_set_components (shop_id, set_item_id, component_item_id, component_name, line_type, qty, sort_order)
            values (${shop}, ${set}, ${cid}, ${name}, ${lt}, '1', ${i})`.execute(trx)
        }
        // The sixth component is labour with no catalog item behind it.
        await sql`insert into catalog_set_components (shop_id, set_item_id, component_item_id, component_name, line_type, qty, sort_order)
          values (${shop}, ${set}, null, 'ค่าแรงประกอบติดตั้งรวมตั้งศูนย์', 'labor', '1', 5)`.execute(trx)
        return { w90, w365, vehicleModel, ball, labor, unpriced, modelPriced, set, setChildren: kids }
      })
    }

    let plateSeq = 0
    const runTag = Math.floor(Math.random() * 9000) + 1000

    /** Check a car in on `shop`; the job is left at `received`. */
    async function checkIn(shop = fx.shopA, brand = 'Toyota', model = 'Vios'): Promise<{ jobId: string; vehicleId: string }> {
      plateSeq++
      const res = await POST<{ jobId: string; vehicleId: string }>('/api/checkin', {
        plate: `กข ${runTag}${plateSeq}`.slice(0, 12), customerName: 'ทดสอบ', brand, model, province: 'กรุงเทพมหานคร',
      }, 'owner', shop)
      expect(res.status, JSON.stringify(res.body)).toBe(201)
      return { jobId: res.body.jobId, vehicleId: res.body.vehicleId }
    }

    async function seedPath(jobId: string, statuses: string[], shop = fx.shopA): Promise<void> {
      const start = Date.now() - 60_000 - statuses.length * 1000
      await withShop(db, shop, async (trx) => {
        await trx.updateTable('jobs').set({ status: statuses[statuses.length - 1]! }).where('id', '=', jobId).execute()
        await trx.insertInto('job_status_history').values(statuses.map((status, i) => ({
          shop_id: shop, job_id: jobId, status, changed_at: new Date(start + i * 1000),
        }))).execute()
      })
    }

    async function jobStatus(jobId: string, shop = fx.shopA): Promise<string> {
      return (await withShop(db, shop, (trx) => trx.selectFrom('jobs').select('status').where('id', '=', jobId).executeTakeFirstOrThrow())).status
    }

    /** A job at `quoted` with an empty DRAFT quotation. */
    async function draftQuote(shop = fx.shopA, brand?: string, model?: string): Promise<{ jobId: string; vehicleId: string }> {
      const j = await checkIn(shop, brand, model)
      await seedPath(j.jobId, ['inspecting', 'quoted'], shop)
      const q = await POST(`/api/jobs/${j.jobId}/quotation`, {}, 'owner', shop)
      expect(q.status, JSON.stringify(q.body)).toBe(201)
      return j
    }

    const base = (jobId: string) => `/api/jobs/${jobId}/quotation`

    async function addItem(jobId: string, itemId: string, extra: object = {}, kind: 'item' | 'set' = 'item', shop = fx.shopA): Promise<Res<Quotation>> {
      const r = await POST<Quotation>(`${base(jobId)}/lines`, { kind, itemId, ...extra }, 'owner', shop)
      expect(r.status, JSON.stringify(r.body)).toBe(201)
      return r
    }
    async function addFree(
      jobId: string,
      name: string,
      unitPrice: string,
      o: { lineType?: string; qty?: string; brand?: string; warrantyTermId?: string } = {},
      shop = fx.shopA,
    ): Promise<Quotation> {
      const r = await POST<Quotation>(`${base(jobId)}/lines`, {
        kind: 'free', name, unitPrice, qty: o.qty ?? '1', lineType: o.lineType ?? 'part',
        brand: o.brand, warrantyTermId: o.warrantyTermId, addToCatalog: false,
      }, 'owner', shop)
      expect(r.status, JSON.stringify(r.body)).toBe(201)
      return r.body
    }
    const view = async (jobId: string, role: Role = 'owner', shop = fx.shopA) => {
      const r = await GET<Quotation>(base(jobId), role, shop)
      expect(r.status, JSON.stringify(r.body)).toBe(200)
      return r.body
    }
    async function issue(jobId: string, shop = fx.shopA): Promise<Quotation> {
      const r = await POST<Quotation>(`${base(jobId)}/issue`, {}, 'owner', shop)
      expect(r.status, JSON.stringify(r.body)).toBe(200)
      return r.body
    }
    // Untyped on purpose: a refusal body is {error, fields}, not a Quotation.
    const decideRaw = (jobId: string, lineId: string, body: object, role: Role = 'owner', shop = fx.shopA) =>
      PATCH<any>(`${base(jobId)}/lines/${lineId}/decision`, body, role, shop) // eslint-disable-line @typescript-eslint/no-explicit-any
    async function approve(jobId: string, lineId: string, shop = fx.shopA): Promise<Quotation> {
      const r = await decideRaw(jobId, lineId, { decision: 'approved' }, 'owner', shop)
      expect(r.status, JSON.stringify(r.body)).toBe(200)
      return r.body
    }
    async function decline(jobId: string, lineId: string, reason = 'too_expensive', note?: string, shop = fx.shopA): Promise<Quotation> {
      const r = await decideRaw(jobId, lineId, { decision: 'declined', reason, ...(note ? { note } : {}) }, 'owner', shop)
      expect(r.status, JSON.stringify(r.body)).toBe(200)
      return r.body
    }
    const confirmRaw = (jobId: string, body: object = {}, role: Role = 'owner', shop = fx.shopA) =>
      POST<any>(`${base(jobId)}/confirm`, body, role, shop) // eslint-disable-line @typescript-eslint/no-explicit-any
    async function confirm(jobId: string, body: object = {}, role: Role = 'owner', shop = fx.shopA): Promise<Quotation> {
      const r = await confirmRaw(jobId, body, role, shop)
      expect(r.status, JSON.stringify(r.body)).toBe(200)
      return r.body
    }
    const byName = (v: Quotation, name: string): Line => {
      const l = v.lines.find((x) => x.name === name)
      if (!l) throw new Error(`no line named ${name}: ${v.lines.map((x) => x.name).join(', ')}`)
      return l
    }
    const kids = (v: Quotation, parentId: string) => v.lines.filter((l) => l.parentLineId === parentId)

    /** An ISSUED quotation holding one set (header + 6 children) and nothing else. */
    async function issuedSet(o: { shop?: string; unitPrice?: string } = {}) {
      const shop = o.shop ?? fx.shopA
      const j = await draftQuote(shop)
      const v0 = (await addItem(j.jobId, seeds[shop]!.set, o.unitPrice ? { unitPrice: o.unitPrice } : {}, 'set', shop)).body
      const parent = v0.lines.find((l) => l.parentLineId === null)!
      const v = await issue(j.jobId, shop)
      return { ...j, shop, parentId: parent.id, children: kids(v, parent.id), view: v }
    }

    async function auditRows(shop: string, action: string, entityId?: string) {
      return withShop(db, shop, async (trx) => {
        let q = trx.selectFrom('audit_logs').select(['action', 'actor_id', 'entity_id', 'before', 'after']).where('action', '=', action)
        if (entityId) q = q.where('entity_id', '=', entityId)
        return q.execute()
      })
    }
    async function docRow(jobId: string, shop = fx.shopA) {
      return withShop(db, shop, async (trx) => (await sql<{
        id: string; status: string; void_reason: string | null; voided_by: string | null; voided_at: Date | null
        revision: number; approved_total: string; discount: string; number: string | null
      }>`select id, status, void_reason, voided_by, voided_at, revision, approved_total, discount, number
         from documents where job_id = ${jobId} and type = 'quotation' order by revision desc, created_at desc`.execute(trx)).rows)
    }
    async function lineRows(documentId: string, shop = fx.shopA) {
      return withShop(db, shop, async (trx) => (await sql<{
        id: string; approval_status: string; decline_reason: string | null; decline_note: string | null; approved_amount: string | null
      }>`select id, approval_status, decline_reason, decline_note, approved_amount from document_lines
         where document_id = ${documentId} order by sort_order`.execute(trx)).rows)
    }
    async function sqlRefused(shop: string, stmt: ReturnType<typeof sql>) {
      let caught: unknown
      try { await withShop(db, shop, (trx) => stmt.execute(trx)) } catch (e) { caught = e }
      return caught as { code?: string; table?: string } | undefined
    }

    // =========================================================================
    // AC1-AC10 (v2 §12, carried into v3)
    // =========================================================================
    describe('AC1-AC10', () => {
      it('AC1: 4 lines, approve 2 -> the work order has exactly those 2; the 2 declined stay on the quotation with their reasons', async () => {
        const { jobId } = await draftQuote()
        await addFree(jobId, 'ลูกหมากล่าง', '1000.00')
        await addFree(jobId, 'ค่าแรงเปลี่ยน', '500.00', { lineType: 'labor' })
        await addFree(jobId, 'ยางกันโคลง', '300.00', { qty: '2' })
        await addFree(jobId, 'ค่าตั้งศูนย์', '100.00', { lineType: 'fee' })
        const v = await issue(jobId)
        expect(v.totals.offeredTotal).toBe('2200.00')
        await approve(jobId, byName(v, 'ลูกหมากล่าง').id)
        await approve(jobId, byName(v, 'ค่าแรงเปลี่ยน').id)
        await decline(jobId, byName(v, 'ยางกันโคลง').id, 'too_expensive')
        await decline(jobId, byName(v, 'ค่าตั้งศูนย์').id, 'other', 'ลูกค้าตั้งเอง')
        const c = await confirm(jobId)
        expect(c.status).toBe('signed')
        expect(c.totals.approvedTotal).toBe('1500.00')
        expect(c.totals.offeredTotal).toBe('2200.00')
        // declined lines are still on the document, with why
        expect(byName(c, 'ยางกันโคลง')).toMatchObject({ approvalStatus: 'declined', declineReason: 'too_expensive' })
        expect(byName(c, 'ค่าตั้งศูนย์')).toMatchObject({ approvalStatus: 'declined', declineReason: 'other', declineNote: 'ลูกค้าตั้งเอง' })
        const wo = await GET<WorkOrder>(`/api/jobs/${jobId}/work-order`)
        expect(wo.status).toBe(200)
        expect(wo.body.lines.map((l) => l.name).sort()).toEqual(['ค่าแรงเปลี่ยน', 'ลูกหมากล่าง'])
        expect(await jobStatus(jobId)).toBe('approved')
      })

      it('AC2: an issued quotation cannot be changed through the API (409) nor by direct SQL (GS002)', async () => {
        const { jobId } = await draftQuote()
        await addFree(jobId, 'ลูกหมาก', '1000.00')
        const v = await issue(jobId)
        const lineId = v.lines[0]!.id
        const attempts: Array<[string, Res]> = [
          ['PATCH discount', await PATCH(base(jobId), { discount: '10.00' })],
          ['POST line', await POST(`${base(jobId)}/lines`, { kind: 'free', name: 'x', unitPrice: '1', addToCatalog: false })],
          ['PATCH line', await PATCH(`${base(jobId)}/lines/${lineId}`, { qty: '9' })],
          ['DELETE line', await DEL(`${base(jobId)}/lines/${lineId}`)],
          ['issue twice', await POST(`${base(jobId)}/issue`, {})],
        ]
        for (const [what, r] of attempts) {
          expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBe(409)
          expect(r.body.error, what).toBe('quotation_not_draft')
        }
        // The same attempts straight at the table: the database is the last wall.
        const direct = await sqlRefused(fx.shopA, sql`update document_lines set unit_price = 1 where id = ${lineId}`)
        expect(direct?.code).toBe('GS002')
        expect(direct?.table).toBe('document_lines')
        const doc = await sqlRefused(fx.shopA, sql`update documents set number = 'HACK-1' where job_id = ${jobId}`)
        expect(doc?.code).toBe('GS002')
        expect(doc?.table).toBe('documents')
        expect((await view(jobId)).lines[0]!.unitPrice).toBe('1000.00')
      })

      it('AC3: a typed first price shows up on the very next search and on the next added line, no reload (see catalog suite for the model/base split)', async () => {
        const { jobId, vehicleId } = await draftQuote()
        await withShop(db, fx.shopA, (trx) => sql`update vehicles set vehicle_model_id = ${seeds[fx.shopA]!.vehicleModel} where id = ${vehicleId}`.execute(trx))
        const s = seeds[fx.shopA]!
        const before = await GET(`/api/catalog/search?q=${encodeURIComponent('ยางครอบ')}&jobId=${jobId}`)
        expect(before.body.items[0]).toMatchObject({ itemId: s.unpriced, price: null, priceSource: 'none' })
        const w = await POST('/api/catalog/prices', { jobId, itemId: s.unpriced, price: '350.00' })
        expect(w.status, JSON.stringify(w.body)).toBe(201)
        const after = await GET(`/api/catalog/search?q=${encodeURIComponent('ยางครอบ')}&jobId=${jobId}`)
        expect(after.body.items[0]).toMatchObject({ price: '350.00', priceSource: 'model' })
        const q = await addItem(jobId, s.unpriced)
        expect(byName(q.body, 'ยางครอบแร็ค')).toMatchObject({ unitPrice: '350.00', listPrice: '350.00', priceSource: 'model' })
      })

      it('AC4: no query in the P3.1 files bypasses the shop scope (no `unscoped`, no SELECT *)', () => {
        const root = fileURLToPath(new URL('..', import.meta.url))
        for (const f of ['routes/quotation.ts', 'routes/catalog.ts', 'services/quotation.ts', 'services/catalogPricing.ts',
          'services/quotationView.ts', 'repositories/quotation.ts', 'repositories/catalog.ts']) {
          const src = readFileSync(`${root}${f}`, 'utf8')
          expect(src, f).not.toMatch(/\bunscoped\b/)
          expect(src, f).not.toMatch(/selectAll\(/)
          expect(src, f).not.toMatch(/select\s+\*/i)
        }
      })

      it.todo('AC5: eyeball at 390 / 820 / 1180 / 1440px — a human gate, not automatable here')

      it('AC6: a set adds 1 parent + 6 children; the money counts once; every line carries its term (days + km + name)', async () => {
        const s = seeds[fx.shopA]!
        const { jobId } = await draftQuote()
        const v = (await addItem(jobId, s.set, {}, 'set')).body
        const parent = v.lines.find((l) => l.parentLineId === null)!
        const children = kids(v, parent.id)
        expect(v.lines).toHaveLength(7)
        expect(children).toHaveLength(6)
        expect(parent).toMatchObject({ unitPrice: '6000.00', lineTotal: '6000.00' })
        expect(children.every((c) => c.unitPrice === '0.00' && c.lineTotal === '0.00')).toBe(true)
        expect(v.totals.offeredTotal).toBe('6000.00')
        expect(v.totals.offeredSubtotal).toBe('6000.00')
        expect(parent.warranty).toEqual({ termId: s.w365, name: '1 ปี / 20,000 กม.', days: 365, maxKm: 20000 })
        expect(byName(v, 'ลูกหมากบน').warranty).toEqual({ termId: s.w90, name: 'รับประกัน 90 วัน', days: 90, maxKm: null })
        expect(byName(v, 'คันชัก').warranty).toEqual({ termId: s.w365, name: '1 ปี / 20,000 กม.', days: 365, maxKm: 20000 })
        // a component with no linked item, or an item with no term, has no warranty
        expect(byName(v, 'ยางกันโคลง').warranty).toBeNull()
        expect(byName(v, 'ค่าแรงประกอบติดตั้งรวมตั้งศูนย์')).toMatchObject({ lineType: 'labor', warranty: null })
      })

      it('AC7 (#186): two alternatives, approve one, decline the other as chose_alternative -> only one is counted', async () => {
        const { jobId } = await draftQuote()
        await addFree(jobId, 'ลูกหมาก TRW', '1500.00', { brand: 'TRW' })
        await addFree(jobId, 'ลูกหมาก Febi', '1100.00', { brand: 'Febi' })
        const v = await issue(jobId)
        await approve(jobId, byName(v, 'ลูกหมาก TRW').id)
        await decline(jobId, byName(v, 'ลูกหมาก Febi').id, 'chose_alternative')
        const c = await confirm(jobId)
        expect(c.totals.offeredTotal).toBe('2600.00')
        expect(c.totals.approvedTotal).toBe('1500.00')
        const wo = await GET<WorkOrder>(`/api/jobs/${jobId}/work-order`)
        expect(wo.body.lines.map((l) => l.name)).toEqual(['ลูกหมาก TRW'])
      })

      it('AC9: undo confirm is refused once the job has moved on to repair', async () => {
        const { jobId } = await draftQuote()
        await addFree(jobId, 'ลูกหมาก', '1000.00')
        const v = await issue(jobId)
        await approve(jobId, v.lines[0]!.id)
        await confirm(jobId)
        await seedPath(jobId, ['inspecting', 'quoted', 'approved', 'repairing'])
        const r = await POST(`${base(jobId)}/confirm/undo`, { reason: 'ลูกค้าเปลี่ยนใจ' })
        expect(r.status, JSON.stringify(r.body)).toBe(409)
        expect(r.body.error).toBe('undo_confirm_job_moved_on')
        expect((await view(jobId)).status).toBe('signed')
      })

      it('AC9: undo confirm is refused on a later calendar day (Bangkok)', async () => {
        const { jobId } = await draftQuote()
        await addFree(jobId, 'ลูกหมาก', '1000.00')
        const v = await issue(jobId)
        await approve(jobId, v.lines[0]!.id)
        await confirm(jobId)
        const admin = new pg.Client({ connectionString: adminDatabaseUrl })
        await admin.connect()
        try {
          await admin.query('set session_replication_role = replica')
          await admin.query(`update documents set signed_at = now() - interval '2 days' where job_id = $1 and type = 'quotation'`, [jobId])
        } finally { await admin.end() }
        const r = await POST(`${base(jobId)}/confirm/undo`, { reason: 'ลูกค้าเปลี่ยนใจ' })
        expect(r.status, JSON.stringify(r.body)).toBe(409)
        expect(r.body.error).toBe('undo_confirm_different_day')
        expect((await view(jobId)).status).toBe('signed')
      })

      it('AC10: no cost / margin / profit key in any quotation response for advisor or technician', async () => {
        const s = seeds[fx.shopA]!
        const { jobId, vehicleId } = await draftQuote()
        const bodies: unknown[] = []
        bodies.push((await addItem(jobId, s.set, {}, 'set')).body)
        const v = await issue(jobId)
        const p = v.lines.find((l) => l.parentLineId === null)!
        await decline(jobId, kids(v, p.id)[0]!.id, 'next_time')
        await approve(jobId, p.id)
        for (const role of ['advisor', 'technician'] as const) {
          for (const path of [base(jobId), `/api/jobs/${jobId}/work-order`, `/api/vehicles/${vehicleId}/offered-items`]) {
            const r = await GET(path, role)
            if (r.status === 200) bodies.push(r.body)
          }
        }
        await confirm(jobId, { adjustments: { setLines: [{ lineId: p.id, approvedAmount: '5000.00', reason: 'ตัดตั้งศูนย์' }] } })
        bodies.push(await view(jobId, 'advisor'))
        const offending = [...new Set(allKeys(bodies).filter((k) => COST_KEY.test(k)))]
        expect(offending).toEqual([])
      })
    })

    // =========================================================================
    // D10 — sets, in full
    // =========================================================================
    describe('D10 sets', () => {
      it('AC11: decline 1 of 6 children -> confirm refused until an agreed amount is given; then the work order has 5 and approved_total is the agreed amount', async () => {
        const s = await issuedSet()
        const cut = s.children[2]!
        const afterDecline = await decline(s.jobId, cut.id, 'not_needed_yet')
        // declining a child is accepted and leaves the parent alone
        expect(afterDecline.lines.find((l) => l.id === s.parentId)!.approvalStatus).toBe('pending')
        await approve(s.jobId, s.parentId)
        const mid = await view(s.jobId)
        expect(mid.next.setsNeedingAmountLineIds).toEqual([s.parentId])
        expect(mid.next.canConfirm).toBe(false)

        const refused = await confirmRaw(s.jobId)
        expect(refused.status, JSON.stringify(refused.body)).toBe(409)
        expect(refused.body).toMatchObject({ error: 'set_amount_required', lineIds: [s.parentId] })
        expect((await view(s.jobId)).status).toBe('issued')

        const ok = await confirm(s.jobId, { adjustments: { setLines: [{ lineId: s.parentId, approvedAmount: '5200.00', reason: 'ตัดออก 1 รายการ' }] } })
        expect(ok.status).toBe('signed')
        expect(ok.totals.approvedTotal).toBe('5200.00')
        expect(ok.totals.offeredTotal).toBe('6000.00')
        expect(ok.lines.find((l) => l.id === s.parentId)).toMatchObject({ approvedAmount: '5200.00', lineTotal: '6000.00' })
        // the cut piece is still on the document with its reason
        expect(ok.lines.find((l) => l.id === cut.id)).toMatchObject({ approvalStatus: 'declined', declineReason: 'not_needed_yet' })

        const wo = await GET<WorkOrder>(`/api/jobs/${s.jobId}/work-order`)
        const woKids = wo.body.lines.filter((l) => l.parentLineId === s.parentId)
        expect(woKids).toHaveLength(5)
        expect(woKids.map((l) => l.id)).not.toContain(cut.id)
        expect(wo.body.lines).toHaveLength(6)
      })

      it('AC12: declining all 6 children declines the parent by itself; the set is worth 0', async () => {
        const s = await issuedSet()
        let v = s.view
        for (const c of s.children) v = await decline(s.jobId, c.id, 'too_expensive')
        const parent = v.lines.find((l) => l.id === s.parentId)!
        expect(parent).toMatchObject({ approvalStatus: 'declined', declineReason: 'too_expensive' })
        const c = await confirm(s.jobId)
        expect(c.totals.approvedTotal).toBe('0.00')
        // nothing approved: the quotation freezes but the job stays at quoted (D5)
        expect(c.status).toBe('signed')
        expect(await jobStatus(s.jobId)).toBe('quoted')
      })

      it('AC12: children declined for different reasons -> the parent is declined as other + the fixed note', async () => {
        const s = await issuedSet()
        let v = s.view
        for (const [i, c] of s.children.entries()) v = await decline(s.jobId, c.id, i === 0 ? 'next_time' : 'too_expensive')
        expect(v.lines.find((l) => l.id === s.parentId)).toMatchObject({
          approvalStatus: 'declined', declineReason: 'other', declineNote: 'ปฏิเสธครบทุกรายการในชุด',
        })
      })

      it('AC13: declining the parent declines every child with the same reason; a child already declined keeps its own', async () => {
        const s = await issuedSet()
        const early = s.children[0]!
        await decline(s.jobId, early.id, 'going_elsewhere')
        const v = await decline(s.jobId, s.parentId, 'too_expensive')
        const ch = kids(v, s.parentId)
        expect(ch).toHaveLength(6)
        expect(ch.every((c) => c.approvalStatus === 'declined')).toBe(true)
        expect(ch.find((c) => c.id === early.id)!.declineReason).toBe('going_elsewhere')
        expect(ch.filter((c) => c.id !== early.id).every((c) => c.declineReason === 'too_expensive')).toBe(true)
      })

      it('re-approving a fully declined set restores all six children; approving a child of an auto-declined parent puts the parent back to pending', async () => {
        const s = await issuedSet()
        await decline(s.jobId, s.parentId, 'next_time')
        const v = await approve(s.jobId, s.parentId)
        expect(v.lines.every((l) => l.approvalStatus === 'approved')).toBe(true)

        const t = await issuedSet()
        for (const c of t.children) await decline(t.jobId, c.id, 'too_expensive')
        const w = await approve(t.jobId, t.children[0]!.id)
        expect(w.lines.find((l) => l.id === t.parentId)!.approvalStatus).toBe('pending')
        expect(w.lines.find((l) => l.id === t.children[0]!.id)!.approvalStatus).toBe('approved')
      })

      it('approving the parent approves pending children but leaves an already declined child declined', async () => {
        const s = await issuedSet()
        await decline(s.jobId, s.children[1]!.id, 'too_expensive')
        const v = await approve(s.jobId, s.parentId)
        const ch = kids(v, s.parentId)
        expect(ch.filter((c) => c.approvalStatus === 'approved')).toHaveLength(5)
        expect(ch.find((c) => c.id === s.children[1]!.id)!.approvalStatus).toBe('declined')
      })

      it('a decline needs a reason, and "other" needs a note (400 with the field named)', async () => {
        const s = await issuedSet()
        const noReason = await decideRaw(s.jobId, s.children[0]!.id, { decision: 'declined' })
        expect(noReason.status).toBe(400)
        expect(noReason.body.fields).toMatchObject({ reason: ['required'] })
        const noNote = await decideRaw(s.jobId, s.children[0]!.id, { decision: 'declined', reason: 'other' })
        expect(noNote.status).toBe(400)
        expect(noNote.body.fields).toMatchObject({ note: ['required'] })
      })

      it('the DB writes the whole cascade or none of it — a failed decision leaves the set untouched', async () => {
        const s = await issuedSet()
        const bad = await decideRaw(s.jobId, s.parentId, { decision: 'declined', reason: 'other' })
        expect(bad.status).toBe(400)
        const v = await view(s.jobId)
        expect(v.lines.every((l) => l.approvalStatus === 'pending')).toBe(true)
      })
    })

    // =========================================================================
    // Q2 — the agreed amount of a cut set, through the API
    // =========================================================================
    describe('AC21 / Q2 tiers via POST …/confirm', () => {
      async function cutSet(o: { unitPrice?: string } = {}) {
        const s = await issuedSet(o)
        await decline(s.jobId, s.children[0]!.id, 'not_needed_yet')
        await approve(s.jobId, s.parentId)
        return s
      }
      const withAmount = (parentId: string, approvedAmount: string, reason = 'ตัดออก') =>
        ({ adjustments: { setLines: [{ lineId: parentId, approvedAmount, reason }] } })

      it('negative is refused (the money type cannot even carry a sign) and nothing is written', async () => {
        const s = await cutSet()
        const r = await confirmRaw(s.jobId, withAmount(s.parentId, '-1.00'))
        expect(r.status, JSON.stringify(r.body)).toBe(400)
        const v = await view(s.jobId)
        expect(v.status).toBe('issued')
        expect(v.lines.find((l) => l.id === s.parentId)!.approvedAmount).toBeNull()
      })

      it('0 is accepted with a reason (given away free): approved total 0', async () => {
        const s = await cutSet()
        const c = await confirm(s.jobId, withAmount(s.parentId, '0.00'))
        expect(c.lines.find((l) => l.id === s.parentId)!.approvedAmount).toBe('0.00')
        expect(c.totals.approvedTotal).toBe('0.00')
      })

      it('lower than offered is accepted', async () => {
        const s = await cutSet()
        const c = await confirm(s.jobId, withAmount(s.parentId, '4999.99'))
        expect(c.totals.approvedTotal).toBe('4999.99')
      })

      it('21: 1.3x the offer is accepted (the cut can raise the price: the bundle discount went with the piece)', async () => {
        const s = await cutSet()
        const c = await confirm(s.jobId, withAmount(s.parentId, '7800.00'))
        expect(c.totals.approvedTotal).toBe('7800.00')
        expect(c.totals.offeredTotal).toBe('6000.00')
      })

      it('exactly 2x is accepted; 2x + 0.01 is refused with 422 amount_over_2x naming the line, the offer and the ceiling', async () => {
        const s = await cutSet()
        const over = await confirmRaw(s.jobId, withAmount(s.parentId, '12000.01'))
        expect(over.status, JSON.stringify(over.body)).toBe(422)
        expect(over.body).toMatchObject({ error: 'amount_over_2x', lineId: s.parentId, offered: '6000.00', max: '12000.00' })
        expect((await view(s.jobId)).status).toBe('issued')
        const edge = await confirm(s.jobId, withAmount(s.parentId, '12000.00'))
        expect(edge.totals.approvedTotal).toBe('12000.00')
      })

      it('21: 10x the offer is refused', async () => {
        const s = await cutSet()
        const r = await confirmRaw(s.jobId, withAmount(s.parentId, '60000.00'))
        expect(r.status).toBe(422)
        expect(r.body.error).toBe('amount_over_2x')
      })

      it('a set offered at 0 cannot be moved upward (its own code), but may stay 0', async () => {
        const s = await cutSet({ unitPrice: '0' })
        const up = await confirmRaw(s.jobId, withAmount(s.parentId, '0.01'))
        expect(up.status, JSON.stringify(up.body)).toBe(422)
        expect(up.body).toMatchObject({ error: 'amount_above_offer_free_set', lineId: s.parentId })
        const same = await confirm(s.jobId, withAmount(s.parentId, '0.00'))
        expect(same.totals.approvedTotal).toBe('0.00')
      })

      it('the reason is mandatory and non-blank (400)', async () => {
        const s = await cutSet()
        for (const reason of ['', '   ']) {
          const r = await confirmRaw(s.jobId, withAmount(s.parentId, '5000.00', reason))
          expect(r.status).toBe(400)
        }
      })

      it('an agreed amount is accepted only for a cut set (400 approved_amount_not_allowed)', async () => {
        const s = await cutSet()
        // a second, plain line on the same quotation is not a cut set. It must be
        // added before issue, so build a fresh quote with a plain line + a cut set.
        const j = await draftQuote()
        await addFree(j.jobId, 'ลูกหมาก', '1000.00')
        const v = await issue(j.jobId)
        await approve(j.jobId, v.lines[0]!.id)
        const r = await confirmRaw(j.jobId, withAmount(v.lines[0]!.id, '900.00'))
        expect(r.status, JSON.stringify(r.body)).toBe(400)
        expect(r.body).toMatchObject({ error: 'approved_amount_not_allowed', lineId: v.lines[0]!.id })
        expect(s.parentId).toBeTruthy()
      })

      it('BUG?: confirm is all-or-nothing — a refused second adjustment must not leave the first one written', async () => {
        const s1 = await cutSet()
        // two cut sets on ONE quotation
        const j = await draftQuote()
        const a = (await addItem(j.jobId, seeds[fx.shopA]!.set, {}, 'set')).body
        const pa = a.lines.find((l) => l.parentLineId === null)!
        const b = (await addItem(j.jobId, seeds[fx.shopA]!.set, { unitPrice: '1000.00' }, 'set')).body
        const pb = b.lines.filter((l) => l.parentLineId === null).find((l) => l.id !== pa.id)!
        const v = await issue(j.jobId)
        await decline(j.jobId, kids(v, pa.id)[0]!.id, 'not_needed_yet')
        await decline(j.jobId, kids(v, pb.id)[0]!.id, 'not_needed_yet')
        await approve(j.jobId, pa.id)
        await approve(j.jobId, pb.id)
        const r = await confirmRaw(j.jobId, {
          adjustments: { setLines: [
            { lineId: pa.id, approvedAmount: '5000.00', reason: 'ตัดออก' }, // valid
            { lineId: pb.id, approvedAmount: '2000.01', reason: 'ตัดออก' }, // > 2x of 1000.00
          ] },
        })
        expect(r.status, JSON.stringify(r.body)).toBe(422)
        const after = await view(j.jobId)
        expect(after.status).toBe('issued')
        expect(after.lines.find((l) => l.id === pa.id)!.approvedAmount, 'first adjustment leaked past a refused confirm').toBeNull()
        expect(s1.parentId).toBeTruthy()
      })

      it('AC14: changing the discount at confirm needs a reason (400 without); with one, the audit keeps old -> new in the SAME entry as the set amount', async () => {
        const s = await cutSet()
        const none = await confirmRaw(s.jobId, { adjustments: { discount: { amount: '100.00', reason: '' } } })
        expect(none.status).toBe(400)
        const missing = await confirmRaw(s.jobId, { adjustments: { discount: { amount: '100.00' } } })
        expect(missing.status).toBe(400)
        expect((await view(s.jobId)).status).toBe('issued')

        const c = await confirm(s.jobId, {
          adjustments: {
            setLines: [{ lineId: s.parentId, approvedAmount: '5200.00', reason: 'ตัดออก 1 รายการ' }],
            discount: { amount: '200.00', reason: 'ลูกค้าประจำ' },
          },
        })
        expect(c.totals).toMatchObject({ discount: '200.00', approvedSubtotal: '5200.00', approvedTotal: '5000.00' })
        const doc = (await docRow(s.jobId))[0]!
        const rows = await auditRows(fx.shopA, 'quotation_confirmed', doc.id)
        expect(rows).toHaveLength(1)
        expect(rows[0]!.before).toMatchObject({ discount: '0.00' })
        expect(rows[0]!.after).toMatchObject({
          discount: '200.00', discountReason: 'ลูกค้าประจำ', approvedTotal: '5000.00',
          setLines: [{ lineId: s.parentId, approvedAmount: '5200.00', reason: 'ตัดออก 1 รายการ' }],
        })
      })

      it('a discount larger than the approved subtotal clamps; the approved total is never negative', async () => {
        const j = await draftQuote()
        await addFree(j.jobId, 'ลูกหมาก', '1000.00')
        await addFree(j.jobId, 'ยาง', '400.00')
        const v = await issue(j.jobId)
        await approve(j.jobId, byName(v, 'ลูกหมาก').id)
        await decline(j.jobId, byName(v, 'ยาง').id, 'too_expensive')
        const c = await confirm(j.jobId, { adjustments: { discount: { amount: '5000.00', reason: 'ทดสอบ' } } })
        expect(c.totals.approvedTotal).toBe('0.00')
        expect(c.totals.approvedDiscount).toBe('1000.00')
        // the offered side is frozen at issue (two-totals rule, CLAUDE.md §5.1 item 3): a discount set at confirm moves only the approved side
        expect(c.totals.offeredDiscount).toBe('0.00')
        expect(c.totals.offeredTotal).toBe('1400.00')
      })
    })

    // =========================================================================
    // Q1 — a job ending without a repair
    // =========================================================================
    describe('AC18 / Q1', () => {
      const move = async (jobId: string, from: string, to: string, extra: object = {}, role: Role = 'advisor') =>
        patch<any>(api, `/api/jobs/${jobId}/status`, { to, fromStatus: from, ...extra }, await tok(role)) // eslint-disable-line @typescript-eslint/no-explicit-any

      async function issuedWithPending() {
        const j = await draftQuote()
        await addFree(j.jobId, 'ลูกหมาก', '1000.00')
        await addFree(j.jobId, 'ยาง', '400.00')
        await addFree(j.jobId, 'น้ำมัน', '200.00')
        const v = await issue(j.jobId)
        return { ...j, v }
      }

      it('rejected with pending lines and NO reason -> 400 naming declineReason; nothing changes', async () => {
        const { jobId, v } = await issuedWithPending()
        const r = await move(jobId, 'quoted', 'rejected')
        expect(r.status, JSON.stringify(r.body)).toBe(400)
        expect(r.body.fields).toMatchObject({ declineReason: ['required'] })
        expect(await jobStatus(jobId)).toBe('quoted')
        const q = await view(jobId)
        expect(q.status).toBe('issued')
        expect(q.lines.every((l) => l.approvalStatus === 'pending')).toBe(true)
        expect(v.status).toBe('issued')
      })

      it('"other" needs a note; chose_alternative is not accepted at all', async () => {
        const { jobId } = await issuedWithPending()
        const noNote = await move(jobId, 'quoted', 'rejected', { declineReason: 'other' })
        expect(noNote.status).toBe(400)
        expect(noNote.body.fields).toMatchObject({ declineNote: ['required'] })
        const alt = await move(jobId, 'quoted', 'rejected', { declineReason: 'chose_alternative' })
        expect(alt.status).toBe(400)
        expect(await jobStatus(jobId)).toBe('quoted')
      })

      it('rejected + reason: pending lines are declined with it, decided lines keep their result, the quotation is void/job_closed/voided_by NULL, audit document_closed_by_job', async () => {
        const { jobId, v } = await issuedWithPending()
        await approve(jobId, byName(v, 'ลูกหมาก').id)
        await decline(jobId, byName(v, 'ยาง').id, 'next_time')
        const r = await move(jobId, 'quoted', 'rejected', { declineReason: 'too_expensive' })
        expect(r.status, JSON.stringify(r.body)).toBe(200)
        expect(await jobStatus(jobId)).toBe('rejected')

        const [doc] = await docRow(jobId)
        expect(doc).toMatchObject({ status: 'void', void_reason: 'job_closed', voided_by: null })
        expect(doc!.voided_at).toBeTruthy()
        expect(doc!.number).toBe(v.number) // the number stays in the sequence
        const lines = await lineRows(doc!.id)
        const byId = new Map(lines.map((l) => [l.id, l]))
        expect(byId.get(byName(v, 'ลูกหมาก').id)).toMatchObject({ approval_status: 'approved', decline_reason: null })
        expect(byId.get(byName(v, 'ยาง').id)).toMatchObject({ approval_status: 'declined', decline_reason: 'next_time' })
        expect(byId.get(byName(v, 'น้ำมัน').id)).toMatchObject({ approval_status: 'declined', decline_reason: 'too_expensive' })

        const closed = await auditRows(fx.shopA, 'document_closed_by_job', doc!.id)
        expect(closed).toHaveLength(1)
        expect(closed[0]!.actor_id).toBeNull()
        expect(await auditRows(fx.shopA, 'document_voided', doc!.id)).toHaveLength(0)
        // no live quotation is left to appear under "waiting for the customer"
        expect((await GET(base(jobId))).status).toBe(404)
      })

      it('rejected with every line already decided needs no reason', async () => {
        const j = await draftQuote()
        await addFree(j.jobId, 'ลูกหมาก', '1000.00')
        const v = await issue(j.jobId)
        await decline(j.jobId, v.lines[0]!.id, 'too_expensive')
        const r = await move(j.jobId, 'quoted', 'rejected')
        expect(r.status, JSON.stringify(r.body)).toBe(200)
        expect((await docRow(j.jobId))[0]).toMatchObject({ status: 'void', void_reason: 'job_closed', voided_by: null })
      })

      it('carout needs no reason: an issued quotation is closed by the system, pending lines stay pending', async () => {
        const { jobId, v } = await issuedWithPending()
        await seedPath(jobId, ['inspecting'])
        const r = await move(jobId, 'inspecting', 'carout')
        expect(r.status, JSON.stringify(r.body)).toBe(200)
        const [doc] = await docRow(jobId)
        expect(doc).toMatchObject({ status: 'void', void_reason: 'job_closed', voided_by: null })
        const lines = await lineRows(doc!.id)
        expect(lines.every((l) => l.approval_status === 'pending')).toBe(true)
        expect(await auditRows(fx.shopA, 'document_closed_by_job', doc!.id)).toHaveLength(1)
        expect(v.number).toBe(doc!.number)
      })

      // Owner decision (Oct 2026): a draft has no number (ck_number_when_issued) and no
      // accounting effect, so on job close it is left exactly as it was — not voided,
      // not deleted, not audited as closed_by_job. The job closes normally.
      it.each([
        ['carout', ['inspecting'], 'inspecting', {}],
        ['rejected', ['inspecting', 'quoted'], 'quoted', {}],
      ] as const)('a DRAFT quotation is left untouched when the job ends as %s', async (to, path, from, extra) => {
        const j = await draftQuote()
        await addFree(j.jobId, 'ลูกหมาก', '1000.00')
        await seedPath(j.jobId, [...path])
        const r = await move(j.jobId, from, to, extra)
        expect(r.status, JSON.stringify(r.body)).toBe(200)
        expect(await jobStatus(j.jobId)).toBe(to)
        const [doc] = await docRow(j.jobId)
        expect(doc).toMatchObject({ status: 'draft', void_reason: null, voided_by: null, voided_at: null, number: null })
        expect(await auditRows(fx.shopA, 'document_closed_by_job', doc!.id)).toHaveLength(0)
        expect((await lineRows(doc!.id)).every((l) => l.approval_status === 'pending')).toBe(true)
      })

      it('a SIGNED quotation is untouched when the job is rejected afterwards (everything-declined, D5)', async () => {
        const j = await draftQuote()
        await addFree(j.jobId, 'ลูกหมาก', '1000.00')
        const v = await issue(j.jobId)
        await decline(j.jobId, v.lines[0]!.id, 'too_expensive')
        await confirm(j.jobId)
        expect(await jobStatus(j.jobId)).toBe('quoted')
        const r = await move(j.jobId, 'quoted', 'rejected')
        expect(r.status, JSON.stringify(r.body)).toBe(200)
        const [doc] = await docRow(j.jobId)
        expect(doc).toMatchObject({ status: 'signed', void_reason: null, voided_by: null })
        expect(await auditRows(fx.shopA, 'document_closed_by_job', doc!.id)).toHaveLength(0)
      })

      it('AC18b: an advisor calling void directly gets 403; the owner may, and that audits document_voided (a different kind)', async () => {
        const { jobId } = await issuedWithPending()
        const no = await POST(`${base(jobId)}/void`, { reason: 'ลองยิงตรง' }, 'advisor')
        expect(no.status).toBe(403)
        const mgr = await POST(`${base(jobId)}/void`, { reason: 'ลองยิงตรง' }, 'manager')
        expect(mgr.status).toBe(403)
        expect((await view(jobId)).status).toBe('issued')

        const yes = await POST<Quotation>(`${base(jobId)}/void`, { reason: 'ออกผิดใบ' }, 'owner')
        expect(yes.status, JSON.stringify(yes.body)).toBe(200)
        const [doc] = await docRow(jobId)
        expect(doc).toMatchObject({ status: 'void', void_reason: 'ออกผิดใบ', voided_by: fx.userId })
        expect(await auditRows(fx.shopA, 'document_voided', doc!.id)).toHaveLength(1)
        expect(await auditRows(fx.shopA, 'document_closed_by_job', doc!.id)).toHaveLength(0)
      })

      it('owner decision 8: approved -> quoted is refused (409 quotation_confirmed) while the quotation is confirmed', async () => {
        const j = await draftQuote()
        await addFree(j.jobId, 'ลูกหมาก', '1000.00')
        const v = await issue(j.jobId)
        await approve(j.jobId, v.lines[0]!.id)
        await confirm(j.jobId)
        expect(await jobStatus(j.jobId)).toBe('approved')
        const r = await move(j.jobId, 'approved', 'quoted')
        expect(r.status, JSON.stringify(r.body)).toBe(409)
        expect(r.body.error).toBe('quotation_confirmed')
        expect(await jobStatus(j.jobId)).toBe('approved')
      })
    })

    // =========================================================================
    // Freeze through the API
    // =========================================================================
    describe('freeze through the API', () => {
      it('a SIGNED quotation refuses every content change and a second confirm (409), at the service and again in the DB', async () => {
        const j = await draftQuote()
        await addFree(j.jobId, 'ลูกหมาก', '1000.00')
        const v = await issue(j.jobId)
        await approve(j.jobId, v.lines[0]!.id)
        await confirm(j.jobId)
        const lineId = v.lines[0]!.id
        const cases: Array<[string, Res, string]> = [
          ['PATCH discount', await PATCH(base(j.jobId), { discount: '1.00' }), 'quotation_not_draft'],
          ['POST line', await POST(`${base(j.jobId)}/lines`, { kind: 'free', name: 'x', unitPrice: '1', addToCatalog: false }), 'quotation_not_draft'],
          ['PATCH line', await PATCH(`${base(j.jobId)}/lines/${lineId}`, { unitPrice: '1' }), 'quotation_not_draft'],
          ['DELETE line', await DEL(`${base(j.jobId)}/lines/${lineId}`), 'quotation_not_draft'],
          ['issue', await POST(`${base(j.jobId)}/issue`, {}), 'quotation_not_draft'],
          ['decide', await decideRaw(j.jobId, lineId, { decision: 'declined', reason: 'too_expensive' }), 'quotation_not_issued'],
          ['confirm again', await confirmRaw(j.jobId), 'quotation_not_issued'],
        ]
        for (const [what, r, code] of cases) {
          expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBe(409)
          expect(r.body.error, what).toBe(code)
        }
        const stmt = await sqlRefused(fx.shopA, sql`update document_lines set approval_status = 'declined' where id = ${lineId}`)
        expect(stmt?.code).toBe('GS002')
        const after = await view(j.jobId)
        expect(after.lines[0]).toMatchObject({ unitPrice: '1000.00', approvalStatus: 'approved' })
      })

      it('deciding or confirming a DRAFT is refused (409 quotation_not_issued); revising a draft is refused (409 quotation_frozen)', async () => {
        const j = await draftQuote()
        const q = await addFree(j.jobId, 'ลูกหมาก', '1000.00')
        const lineId = q.lines[0]!.id
        expect((await decideRaw(j.jobId, lineId, { decision: 'approved' })).body.error).toBe('quotation_not_issued')
        expect((await confirmRaw(j.jobId)).body.error).toBe('quotation_not_issued')
        expect((await POST(`${base(j.jobId)}/confirm/undo`, { reason: 'x' })).body.error).toBe('quotation_not_confirmed')
        const rev = await POST(`${base(j.jobId)}/revise`, {})
        expect(rev.status).toBe(409)
        expect(rev.body.error).toBe('quotation_frozen')
      })

      it('issuing an empty quotation is refused (409 quotation_empty) and no number is burnt', async () => {
        const j = await draftQuote()
        const r = await POST(`${base(j.jobId)}/issue`, {})
        expect(r.status).toBe(409)
        expect(r.body.error).toBe('quotation_empty')
        expect((await docRow(j.jobId))[0]!.number).toBeNull()
      })

      it('only one live quotation per job (409 quotation_exists)', async () => {
        const j = await draftQuote()
        const r = await POST(base(j.jobId), {})
        expect(r.status).toBe(409)
        expect(r.body.error).toBe('quotation_exists')
      })

      it('a voided quotation cannot be voided or revised again; the number sequence has no gap or repeat across issue/void', async () => {
        const a = await draftQuote()
        await addFree(a.jobId, 'ก', '10.00')
        const va = await issue(a.jobId)
        const b = await draftQuote()
        await addFree(b.jobId, 'ข', '10.00')
        const vb = await issue(b.jobId)
        const n = (s: string | null) => Number(s!.slice(-3))
        expect(n(vb.number)).toBe(n(va.number) + 1)
        expect(va.number).not.toBe(vb.number)
        const voided = await POST(`${base(a.jobId)}/void`, { reason: 'ออกผิด' })
        expect(voided.status).toBe(200)
        // the live-quotation lookup no longer finds it
        expect((await POST(`${base(a.jobId)}/void`, { reason: 'อีกครั้ง' })).status).toBe(404)
        // and a new quotation for the same job takes the NEXT number, not the voided one's
        const again = await POST<Quotation>(base(a.jobId), {})
        expect(again.status).toBe(201)
        await addFree(a.jobId, 'ค', '10.00')
        const v2 = await issue(a.jobId)
        expect(n(v2.number)).toBeGreaterThan(n(vb.number))
      })

      it('sets: deleting a draft set header removes its children; a child can be edited but is never counted', async () => {
        const j = await draftQuote()
        const v = (await addItem(j.jobId, seeds[fx.shopA]!.set, {}, 'set')).body
        const parent = v.lines.find((l) => l.parentLineId === null)!
        const child = kids(v, parent.id)[0]!
        // BUG? a child carrying a price must still add nothing (v3 §3: the total counts parents only)
        const edited = await PATCH<Quotation>(`${base(j.jobId)}/lines/${child.id}`, { unitPrice: '999999.99' })
        expect(edited.status, JSON.stringify(edited.body)).toBe(200)
        expect(edited.body.totals.offeredTotal).toBe('6000.00')
        const r = await DEL<Quotation>(`${base(j.jobId)}/lines/${parent.id}`)
        expect(r.status).toBe(200)
        expect(r.body.lines).toHaveLength(0)
      })

      it('BUG?: deleting a line that is NOT on this quotation is refused with 404 quotation_line_not_found, and the other quotation keeps it', async () => {
        const mine = await draftQuote()
        const other = await draftQuote()
        const q = await addFree(other.jobId, 'ของใบอื่น', '10.00')
        const r = await DEL(`${base(mine.jobId)}/lines/${q.lines[0]!.id}`)
        expect(r.status, JSON.stringify(r.body)).toBe(404)
        expect(r.body.error).toBe('quotation_line_not_found')
        expect((await view(other.jobId)).lines).toHaveLength(1)
      })
    })

    // =========================================================================
    // Write paths kept in scope (DECISION-2026-10-03 §C)
    // =========================================================================
    describe('vehicle_offered_items on confirm', () => {
      const offered = async (vehicleId: string) =>
        (await GET<OfferedItemPage>(`/api/vehicles/${vehicleId}/offered-items`)).body

      it('AC16 (D13): next_time is remembered; chose_alternative and every other reason are NOT', async () => {
        const { jobId, vehicleId } = await draftQuote()
        await addFree(jobId, 'ไว้ครั้งหน้า', '700.00')
        await addFree(jobId, 'เลือกตัวอื่น', '800.00')
        await addFree(jobId, 'แพงไป', '900.00')
        await addFree(jobId, 'ซื้อแล้ว', '100.00')
        const v = await issue(jobId)
        await decline(jobId, byName(v, 'ไว้ครั้งหน้า').id, 'next_time')
        await decline(jobId, byName(v, 'เลือกตัวอื่น').id, 'chose_alternative')
        await decline(jobId, byName(v, 'แพงไป').id, 'too_expensive')
        await approve(jobId, byName(v, 'ซื้อแล้ว').id)
        expect((await offered(vehicleId)).total).toBe(0) // nothing is written before confirm
        await confirm(jobId)
        const o = await offered(vehicleId)
        expect(o.items.map((i) => i.name)).toEqual(['ไว้ครั้งหน้า'])
        expect(o.total).toBe(1)
        expect(o.items[0]).toMatchObject({ unitPrice: '700.00', qty: '1.00', lineType: 'part' })
        expect(isTrueDecline('chose_alternative')).toBe(false)
        expect(isTrueDecline('next_time')).toBe(true)
      })

      it('a declined set is remembered once (the parent), not as seven rows', async () => {
        const s = await issuedSet()
        await decline(s.jobId, s.parentId, 'next_time')
        await confirm(s.jobId)
        const o = await offered(s.vehicleId)
        expect(o.items.map((i) => i.name)).toEqual(['ชุดโปรช่วงล่าง'])
      })

      it('undo confirm removes what the confirm wrote; confirming again writes it once more', async () => {
        const { jobId, vehicleId } = await draftQuote()
        await addFree(jobId, 'ไว้ครั้งหน้า', '700.00')
        await addFree(jobId, 'ซื้อ', '100.00')
        const v = await issue(jobId)
        await decline(jobId, byName(v, 'ไว้ครั้งหน้า').id, 'next_time')
        await approve(jobId, byName(v, 'ซื้อ').id)
        await confirm(jobId)
        expect((await offered(vehicleId)).total).toBe(1)
        const undo = await POST<Quotation>(`${base(jobId)}/confirm/undo`, { reason: 'ลูกค้าแก้' })
        expect(undo.status, JSON.stringify(undo.body)).toBe(200)
        expect(undo.body.status).toBe('issued')
        expect((await offered(vehicleId)).total).toBe(0)
        expect(await jobStatus(jobId)).toBe('quoted')
        await confirm(jobId)
        expect((await offered(vehicleId)).total).toBe(1)
      })

      it('AC20: another person with the same role may undo; the audit keeps who confirmed and who undid it apart', async () => {
        const advisorA = await tok('advisor', fx.shopB, fx.outsiderId)
        const advisorB = await tok('advisor', fx.shopB, fx.userId)
        const j = await draftQuote(fx.shopB)
        const P = (path: string, body: object, token: string) => post<any>(api, path, body, token) // eslint-disable-line @typescript-eslint/no-explicit-any
        expect((await P(`${base(j.jobId)}/lines`, { kind: 'free', name: 'ลูกหมาก', unitPrice: '1000', addToCatalog: false }, advisorA)).status).toBe(201)
        expect((await P(`${base(j.jobId)}/issue`, {}, advisorA)).status).toBe(200)
        const v = await (async () => (await get<Quotation>(api, base(j.jobId), advisorA)).body)()
        expect((await patch<any>(api, `${base(j.jobId)}/lines/${v.lines[0]!.id}/decision`, { decision: 'approved' }, advisorA)).status).toBe(200) // eslint-disable-line @typescript-eslint/no-explicit-any
        expect((await P(`${base(j.jobId)}/confirm`, {}, advisorA)).status).toBe(200)

        const undo = await P(`${base(j.jobId)}/confirm/undo`, { reason: 'ลูกค้าขอแก้' }, advisorB)
        expect(undo.status, JSON.stringify(undo.body)).toBe(200)
        expect(undo.body.status).toBe('issued')

        const [doc] = await docRow(j.jobId, fx.shopB)
        const confirmed = await auditRows(fx.shopB, 'quotation_confirmed', doc!.id)
        const undone = await auditRows(fx.shopB, 'quotation_confirm_undone', doc!.id)
        expect(confirmed).toHaveLength(1)
        expect(undone).toHaveLength(1)
        expect(confirmed[0]!.actor_id).toBe(fx.outsiderId)
        expect(undone[0]!.actor_id).toBe(fx.userId)
        expect(undone[0]!.after).toMatchObject({ status: 'issued', reason: 'ลูกค้าขอแก้' })
      })
    })

    describe('warranty snapshot — the one function on every line-creating path', () => {
      const W90 = (s: Seed) => ({ termId: s.w90, name: 'รับประกัน 90 วัน', days: 90, maxKm: null })

      it('item path: the line carries termId + name + days + km as sold', async () => {
        const s = seeds[fx.shopA]!
        const { jobId } = await draftQuote()
        const v = (await addItem(jobId, s.ball)).body
        expect(byName(v, 'ลูกหมากปีกนกล่าง').warranty).toEqual(W90(s))
      })

      it('free-text path with a chosen term, and with none', async () => {
        const s = seeds[fx.shopA]!
        const { jobId } = await draftQuote()
        await addFree(jobId, 'มีประกัน', '100.00', { warrantyTermId: s.w365 })
        const v = await addFree(jobId, 'ไม่มีประกัน', '100.00')
        expect(byName(v, 'มีประกัน').warranty).toEqual({ termId: s.w365, name: '1 ปี / 20,000 กม.', days: 365, maxKm: 20000 })
        expect(byName(v, 'ไม่มีประกัน').warranty).toBeNull()
      })

      it('later edits to a term never reach a line already sold, on the item path or the set path', async () => {
        const s = seeds[fx.shopA]!
        const { jobId } = await draftQuote()
        await addItem(jobId, s.ball)
        await addItem(jobId, s.set, {}, 'set')
        // the shop changes its standard term afterwards
        await withShop(db, fx.shopA, (trx) => sql`update warranty_terms set days = 7, name = 'เปลี่ยนแล้ว' where id = ${s.w90}`.execute(trx))
        try {
          const v = await view(jobId)
          expect(byName(v, 'ลูกหมากปีกนกล่าง').warranty).toEqual(W90(s))
          expect(byName(v, 'ลูกหมากบน').warranty).toEqual(W90(s))
        } finally {
          await withShop(db, fx.shopA, (trx) => sql`update warranty_terms set days = 90, name = 'รับประกัน 90 วัน' where id = ${s.w90}`.execute(trx))
        }
      })

      it('revise copy: the new revision keeps the snapshot even after the term changed', async () => {
        const s = seeds[fx.shopA]!
        const { jobId } = await draftQuote()
        await addItem(jobId, s.ball)
        await issue(jobId)
        await withShop(db, fx.shopA, (trx) => sql`update warranty_terms set days = 7, name = 'เปลี่ยนแล้ว' where id = ${s.w90}`.execute(trx))
        try {
          const r = await POST<Quotation>(`${base(jobId)}/revise`, { reason: 'แก้ราคา' })
          expect(r.status, JSON.stringify(r.body)).toBe(201)
          expect(byName(r.body, 'ลูกหมากปีกนกล่าง').warranty).toEqual(W90(s))
        } finally {
          await withShop(db, fx.shopA, (trx) => sql`update warranty_terms set days = 90, name = 'รับประกัน 90 วัน' where id = ${s.w90}`.execute(trx))
        }
      })

      it('offered-items re-add: the line carries the catalog item\'s term (as of the day it is re-offered)', async () => {
        const s = seeds[fx.shopA]!
        const { jobId, vehicleId } = await draftQuote()
        await addItem(jobId, s.ball)
        const v = await issue(jobId)
        const lineId = byName(v, 'ลูกหมากปีกนกล่าง').id
        await decline(jobId, lineId, 'next_time')
        await confirm(jobId)
        const o = (await GET<OfferedItemPage>(`/api/vehicles/${vehicleId}/offered-items`)).body
        expect(o.items).toHaveLength(1)
        // the next visit starts a new draft (rev 2)
        const rev = await POST<Quotation>(`${base(jobId)}/revise`, { reason: 'เสนออีกครั้ง' })
        expect(rev.status, JSON.stringify(rev.body)).toBe(201)
        const re = await POST<Quotation>(`${base(jobId)}/lines`, { kind: 'offered', offeredItemId: o.items[0]!.id })
        expect(re.status, JSON.stringify(re.body)).toBe(201)
        const fresh = re.body.lines.filter((l) => l.name === 'ลูกหมากปีกนกล่าง' && l.approvalStatus === 'pending')
        expect(fresh).toHaveLength(1)
        expect(fresh[0]!.warranty).toEqual(W90(s))
        expect(fresh[0]!.unitPrice).toBe('1000.00')
      })
    })

    // =========================================================================
    // Roles
    // =========================================================================
    const woPath = (id: string): string => '/api/jobs/' + id + '/work-order'

    describe('roles (CLAUDE.md §12.1)', () => {
      it('the technician cannot create, edit, decide or confirm a quotation (403)', async () => {
        const { jobId } = await draftQuote()
        for (const [r, what] of [
          [await POST(base(jobId), {}, 'technician'), 'create'],
          [await POST(`${base(jobId)}/lines`, { kind: 'free', name: 'x', unitPrice: '1', addToCatalog: false }, 'technician'), 'add'],
          [await POST(`${base(jobId)}/issue`, {}, 'technician'), 'issue'],
          [await confirmRaw(jobId, {}, 'technician'), 'confirm'],
        ] as Array<[Res, string]>) expect(r.status, what).toBe(403)
      })

      it('viewer and accountant may read a quotation but not write; no token is 401', async () => {
        const { jobId } = await draftQuote()
        for (const role of ['viewer', 'accountant'] as const) {
          expect((await GET(base(jobId), role)).status).toBe(200)
          expect((await POST(`${base(jobId)}/lines`, { kind: 'free', name: 'x', unitPrice: '1', addToCatalog: false }, role)).status).toBe(403)
        }
        expect((await get(api, base(jobId))).status).toBe(401)
        expect((await get(api, `/api/jobs/${jobId}/work-order`)).status).toBe(401)
      })

      it('BUG?: the technician does not see prices — the quotation read is closed to him (403); the work order is his document', async () => {
        const { jobId } = await draftQuote()
        await addFree(jobId, 'ลูกหมาก', '1000.00')
        const r = await GET(base(jobId), 'technician')
        expect(r.status, 'a technician must not receive the quotation (selling prices): CLAUDE.md §12.1').toBe(403)
      })

      it('BUG?: the technician cannot read what the customer was offered and at what price (offered-items)', async () => {
        const { vehicleId } = await draftQuote()
        const r = await GET(`/api/vehicles/${vehicleId}/offered-items`, 'technician')
        expect(r.status, 'offered-items carries unitPrice').toBe(403)
      })

      it('the work order has exactly the documented keys — no price, total, discount, number or cost, even for the owner', async () => {
        const s = await issuedSet()
        await approve(s.jobId, s.parentId)
        await confirm(s.jobId)
        for (const role of ['technician', 'owner'] as const) {
          const r = await GET<WorkOrder>(`/api/jobs/${s.jobId}/work-order`, role)
          expect(r.status).toBe(200)
          expect(Object.keys(r.body).sort()).toEqual(['brand', 'jobId', 'jobNumber', 'lines', 'model', 'plate', 'province'])
          expect(r.body.lines).toHaveLength(7)
          for (const l of r.body.lines) {
            expect(Object.keys(l).sort()).toEqual(['brand', 'id', 'lineType', 'name', 'parentLineId', 'qty', 'sortOrder', 'unit', 'warrantyName'])
          }
        }
      })

      // Owner ruling DECISION-2026-10-06 §1.
      it('work order: no quotation -> 409 quotation_missing; draft or issued -> 409 quotation_not_confirmed; confirmed -> the approved lines', async () => {
        const j = await checkIn()
        await seedPath(j.jobId, ['inspecting', 'quoted'])
        const none = await GET(woPath(j.jobId), 'technician')
        expect(none.status, JSON.stringify(none.body)).toBe(409)
        expect(none.body.error).toBe('quotation_missing')

        await POST(base(j.jobId), {})
        await addFree(j.jobId, 'ลูกหมาก', '1000.00')
        const draft = await GET(woPath(j.jobId), 'technician')
        expect(draft.status, JSON.stringify(draft.body)).toBe(409)
        expect(draft.body.error).toBe('quotation_not_confirmed')

        const v = await issue(j.jobId)
        const issued = await GET(woPath(j.jobId), 'technician')
        expect(issued.status, JSON.stringify(issued.body)).toBe(409)
        expect(issued.body.error).toBe('quotation_not_confirmed')

        await approve(j.jobId, v.lines[0]!.id)
        expect((await GET(woPath(j.jobId), 'technician')).body.error).toBe('quotation_not_confirmed')
        await confirm(j.jobId)
        const ok = await GET<WorkOrder>(woPath(j.jobId), 'technician')
        expect(ok.status).toBe(200)
        expect(ok.body.lines).toHaveLength(1)
      })

      it('work order: a confirmed quotation with every line declined is 200 with an empty list', async () => {
        const j = await draftQuote()
        await addFree(j.jobId, 'ลูกหมาก', '1000.00')
        const v = await issue(j.jobId)
        await decline(j.jobId, v.lines[0]!.id, 'too_expensive')
        await confirm(j.jobId)
        const r = await GET<WorkOrder>(woPath(j.jobId), 'technician')
        expect(r.status, JSON.stringify(r.body)).toBe(200)
        expect(r.body.lines).toEqual([])
      })
    })

    // =========================================================================
    // Revise (D7) and money display
    // =========================================================================
    describe('revise', () => {
      it('AC (D7): rev 2 is a new draft that copies decisions and approved_amount; rev 1 becomes superseded and cannot change', async () => {
        const s = await issuedSet()
        await decline(s.jobId, s.children[0]!.id, 'not_needed_yet')
        await approve(s.jobId, s.parentId)
        const c = await confirm(s.jobId, { adjustments: { setLines: [{ lineId: s.parentId, approvedAmount: '5200.00', reason: 'ตัดออก' }] } })
        const rev1Id = c.id
        const r = await POST<Quotation>(`${base(s.jobId)}/revise`, { reason: 'เพิ่มรายการ' })
        expect(r.status, JSON.stringify(r.body)).toBe(201)
        expect(r.body).toMatchObject({ revision: 2, status: 'draft', supersedesDocumentId: rev1Id, number: null })
        const np = r.body.lines.find((l) => l.parentLineId === null)!
        expect(np.approvedAmount).toBe('5200.00')
        expect(np.approvalStatus).toBe('approved')
        expect(kids(r.body, np.id).filter((l) => l.approvalStatus === 'declined')).toHaveLength(1)
        expect(r.body.lines).toHaveLength(7)
        const rows = await docRow(s.jobId)
        expect(rows.map((d) => [d.revision, d.status])).toEqual([[2, 'draft'], [1, 'superseded']])
        const poke = await sqlRefused(fx.shopA, sql`update documents set discount = 1 where id = ${rev1Id}`)
        expect(poke?.code).toBe('GS002')
      })
    })

    // =========================================================================
    // AC4 — two shops, every endpoint
    // =========================================================================
    describe('AC4: shop B cannot read, write, decide, confirm, revise, void or see offered items / the work order of shop A; a foreign id looks exactly like a missing one', () => {
      let a: { draft: { jobId: string; lineId: string; vehicleId: string }; issued: { jobId: string; lineId: string; vehicleId: string }; signed: { jobId: string; vehicleId: string }; offeredItemId: string; itemId: string }
      let b: { jobId: string; lineId: string }
      const snapshot = async () => ({
        draft: await view(a.draft.jobId), issued: await view(a.issued.jobId), signed: await view(a.signed.jobId),
        offered: (await GET(`/api/vehicles/${a.signed.vehicleId}/offered-items`)).body,
      })
      let before: Awaited<ReturnType<typeof snapshot>>

      beforeAll(async () => {
        const d = await draftQuote()
        const dq = await addFree(d.jobId, 'ของร้าน A (ร่าง)', '100.00')
        const i = await draftQuote()
        await addFree(i.jobId, 'ของร้าน A (ออกเลข)', '200.00')
        await addFree(i.jobId, 'ของร้าน A (ไว้ครั้งหน้า)', '300.00')
        const iq = await issue(i.jobId)
        const s = await draftQuote()
        await addFree(s.jobId, 'ของร้าน A (เซ็นแล้ว)', '400.00')
        await addFree(s.jobId, 'ของร้าน A (ไว้ครั้งหน้า)', '500.00')
        const sq = await issue(s.jobId)
        await approve(s.jobId, byName(sq, 'ของร้าน A (เซ็นแล้ว)').id)
        await decline(s.jobId, byName(sq, 'ของร้าน A (ไว้ครั้งหน้า)').id, 'next_time')
        await confirm(s.jobId)
        const offered = (await GET<OfferedItemPage>(`/api/vehicles/${s.vehicleId}/offered-items`)).body
        a = {
          draft: { jobId: d.jobId, lineId: dq.lines[0]!.id, vehicleId: d.vehicleId },
          issued: { jobId: i.jobId, lineId: byName(iq, 'ของร้าน A (ออกเลข)').id, vehicleId: i.vehicleId },
          signed: { jobId: s.jobId, vehicleId: s.vehicleId },
          offeredItemId: offered.items[0]!.id,
          itemId: seeds[fx.shopA]!.ball,
        }
        const bj = await draftQuote(fx.shopB)
        const bq = await addFree(bj.jobId, 'ของร้าน B', '50.00', {}, fx.shopB)
        b = { jobId: bj.jobId, lineId: bq.lines[0]!.id }
        before = await snapshot()
      })

      afterAll(async () => {
        // The whole barrage must have changed nothing in shop A.
        expect(await snapshot()).toEqual(before)
      })

      /** Same call with A's ids (foreign) and with random ids (missing), as shop B's owner. */
      async function sameAsMissing(
        call: (ids: { job: string; line: string; vehicle: string; item: string; offered: string }) => Promise<Res>,
        foreign: { job: string; line: string; vehicle?: string; item?: string; offered?: string },
        expectStatus?: number,
      ) {
        const f = await call({ vehicle: a.signed.vehicleId, item: a.itemId, offered: a.offeredItemId, ...foreign })
        const m = await call({ job: randomUUID(), line: randomUUID(), vehicle: randomUUID(), item: randomUUID(), offered: randomUUID() })
        expect({ status: f.status, body: f.body }).toEqual({ status: m.status, body: m.body })
        if (expectStatus) expect(f.status, JSON.stringify(f.body)).toBe(expectStatus)
        else expect(f.status, JSON.stringify(f.body)).toBeGreaterThanOrEqual(400)
        return f
      }
      const asB = { shop: () => fx.shopB }

      it('create / read / patch / add / issue against A\'s job: 404, same body as a missing job', async () => {
        await sameAsMissing(({ job }) => POST(base(job), {}, 'owner', asB.shop()), { job: a.draft.jobId, line: '' }, 404)
        await sameAsMissing(({ job }) => GET(base(job), 'owner', asB.shop()), { job: a.signed.jobId, line: '' }, 404)
        await sameAsMissing(({ job }) => PATCH(base(job), { discount: '5.00' }, 'owner', asB.shop()), { job: a.draft.jobId, line: '' }, 404)
        await sameAsMissing(({ job }) => POST(`${base(job)}/lines`, { kind: 'free', name: 'แทรก', unitPrice: '1', addToCatalog: false }, 'owner', asB.shop()), { job: a.draft.jobId, line: '' }, 404)
        await sameAsMissing(({ job }) => POST(`${base(job)}/issue`, {}, 'owner', asB.shop()), { job: a.draft.jobId, line: '' }, 404)
      })

      it('line patch / delete / decision against A\'s job and A\'s line: 404, same body as a missing line', async () => {
        await sameAsMissing(({ job, line }) => PATCH(`${base(job)}/lines/${line}`, { qty: '9' }, 'owner', asB.shop()), { job: a.draft.jobId, line: a.draft.lineId }, 404)
        await sameAsMissing(({ job, line }) => DEL(`${base(job)}/lines/${line}`, 'owner', asB.shop()), { job: a.draft.jobId, line: a.draft.lineId }, 404)
        await sameAsMissing(({ job, line }) => decideRaw(job, line, { decision: 'approved' }, 'owner', asB.shop()), { job: a.issued.jobId, line: a.issued.lineId }, 404)
      })

      it('confirm / undo / revise / void against A\'s job: 404, same body as a missing job', async () => {
        await sameAsMissing(({ job }) => confirmRaw(job, {}, 'owner', asB.shop()), { job: a.issued.jobId, line: '' }, 404)
        await sameAsMissing(({ job }) => POST(`${base(job)}/confirm/undo`, { reason: 'ลอง' }, 'owner', asB.shop()), { job: a.signed.jobId, line: '' }, 404)
        await sameAsMissing(({ job }) => POST(`${base(job)}/revise`, {}, 'owner', asB.shop()), { job: a.issued.jobId, line: '' }, 404)
        await sameAsMissing(({ job }) => POST(`${base(job)}/void`, { reason: 'ลอง' }, 'owner', asB.shop()), { job: a.issued.jobId, line: '' }, 404)
      })

      it('A\'s work order and A\'s offered items are invisible to B (404 / an empty page, identical to a missing id)', async () => {
        await sameAsMissing(({ job }) => GET(`/api/jobs/${job}/work-order`, 'owner', asB.shop()), { job: a.signed.jobId, line: '' }, 404)
        const o = await sameAsMissing(({ vehicle }) => GET(`/api/vehicles/${vehicle}/offered-items`, 'owner', asB.shop()), { job: '', line: '', vehicle: a.signed.vehicleId }, 200)
        expect(o.body).toEqual({ items: [], total: 0 })
      })

      it('B\'s own quotation cannot reach A\'s lines or A\'s catalog items: same refusal as a missing id', async () => {
        await sameAsMissing(({ line }) => PATCH(`${base(b.jobId)}/lines/${line}`, { qty: '9' }, 'owner', asB.shop()), { job: '', line: a.draft.lineId }, 404)
        await sameAsMissing(({ line }) => DEL(`${base(b.jobId)}/lines/${line}`, 'owner', asB.shop()), { job: '', line: a.draft.lineId }, 404)
        await sameAsMissing(({ item }) => POST(`${base(b.jobId)}/lines`, { kind: 'item', itemId: item }, 'owner', asB.shop()), { job: '', line: '', item: a.itemId }, 404)
        await sameAsMissing(({ item }) => POST(`${base(b.jobId)}/lines`, { kind: 'set', itemId: item }, 'owner', asB.shop()), { job: '', line: '', item: seeds[fx.shopA]!.set }, 404)
        await sameAsMissing(({ offered }) => POST(`${base(b.jobId)}/lines`, { kind: 'offered', offeredItemId: offered }, 'owner', asB.shop()), { job: '', line: '', offered: a.offeredItemId }, 404)
      })

      it('BUG?: a free-text line pointing at A\'s catalog item (useExistingItemId) is a clean 404 in B, identical to a missing item — not a 500', async () => {
        const f = await sameAsMissing(({ item }) => POST(`${base(b.jobId)}/lines`, {
          kind: 'free', name: 'อ้างของร้านอื่น', unitPrice: '10', addToCatalog: true, useExistingItemId: item,
        }, 'owner', asB.shop()), { job: '', line: '', item: a.itemId })
        expect(f.status).toBe(404)
      })

      it('B\'s own reads never contain A\'s rows', async () => {
        const mine = await view(b.jobId, 'owner', fx.shopB)
        expect(mine.lines.map((l) => l.name)).toEqual(['ของร้าน B'])
        const ids = JSON.stringify(mine)
        for (const id of [a.draft.jobId, a.issued.jobId, a.signed.jobId, a.draft.lineId]) expect(ids).not.toContain(id)
      })

      it('B\'s tokens work on B: the same endpoints succeed for its own data (the 404s above are isolation, not a broken route)', async () => {
        const r = await view(b.jobId, 'owner', fx.shopB)
        expect(r.status).toBe('draft')
        const w = await GET(`/api/jobs/${b.jobId}/work-order`, 'owner', fx.shopB)
        expect(w.status).toBe(409) // its own job, a draft quotation: not confirmed (not a 404)
        expect(w.body.error).toBe('quotation_not_confirmed')
      })

      it("numbering is per shop: shop B's counter is not shop A's", async () => {
        const jb = await draftQuote(fx.shopB)
        await addFree(jb.jobId, 'ของร้าน B 2', '1.00', {}, fx.shopB)
        const vb = await issue(jb.jobId, fx.shopB)
        const ja = await draftQuote()
        await addFree(ja.jobId, 'ของร้าน A 2', '1.00')
        const va = await issue(ja.jobId)
        expect(vb.number).toMatch(/\d{3}$/)
        expect(vb.number).not.toBeNull()
        // B has issued fewer documents than A in this run, so B's counter is lower
        const n = (s: string | null) => Number(s!.slice(-3))
        expect(n(vb.number)).toBeLessThan(n(va.number))
      })
    })

    // =========================================================================
    // Quotation screen contract additions (vehicleId, canOpenConfirm, nested confirm errors)
    // =========================================================================
    describe('screen additions to the view', () => {
      it('carries vehicleId and vehicleModelLinked, read from the job row', async () => {
        const j = await draftQuote()
        // check-in may auto-link a catalog model; start from an unlinked vehicle
        await withShop(db, fx.shopA, (trx) => sql`update vehicles set vehicle_model_id = null where id = ${j.vehicleId}`.execute(trx))
        const v0 = await view(j.jobId)
        expect(v0.vehicleId).toBe(j.vehicleId)
        expect(v0.vehicleModelLinked).toBe(false)
        await withShop(db, fx.shopA, (trx) => sql`update vehicles set vehicle_model_id = ${seeds[fx.shopA]!.vehicleModel} where id = ${j.vehicleId}`.execute(trx))
        const v1 = await view(j.jobId)
        expect(v1.vehicleId).toBe(j.vehicleId)
        expect(v1.vehicleModelLinked).toBe(true)
      })

      it("a foreign shop's job id gives 404 (no vehicleId leaks), and its own job gives its own vehicle", async () => {
        const a = await draftQuote()
        const b = await draftQuote(fx.shopB)
        const foreign = await GET(base(a.jobId), 'owner', fx.shopB)
        expect(foreign.status).toBe(404)
        expect(JSON.stringify(foreign.body)).not.toContain(a.vehicleId)
        expect((await view(b.jobId, 'owner', fx.shopB)).vehicleId).toBe(b.vehicleId)
      })

      it('the technician is still refused the view (price gate unchanged)', async () => {
        const j = await draftQuote()
        expect((await GET(base(j.jobId), 'technician')).status).toBe(403)
      })

      it('canOpenConfirm: false while a line is pending, true once decided even if a cut set still lacks its amount', async () => {
        const s = await issuedSet()
        expect(s.view.next.canOpenConfirm).toBe(false)
        await decline(s.jobId, s.children[2]!.id, 'not_needed_yet')
        expect((await view(s.jobId)).next.canOpenConfirm).toBe(false) // the set header is still pending
        await approve(s.jobId, s.parentId)
        const v = await view(s.jobId)
        expect(v.next.setsNeedingAmountLineIds).toEqual([s.parentId])
        expect(v.next.canConfirm).toBe(false)
        expect(v.next.canOpenConfirm).toBe(true)
        // a caller who may not decide is not offered the dialog
        expect((await view(s.jobId, 'viewer')).next.canOpenConfirm).toBe(false)
        // draft and signed are not openable
        const d = await draftQuote()
        expect((await view(d.jobId)).next.canOpenConfirm).toBe(false)
        const done = await confirm(s.jobId, { adjustments: { setLines: [{ lineId: s.parentId, approvedAmount: '5200.00', reason: 'ตัดออก 1 รายการ' }] } })
        expect(done.next.canOpenConfirm).toBe(false)
      })

      it('a confirm body that fails validation names the failing row by its full path', async () => {
        const s = await issuedSet()
        const bad = await confirmRaw(s.jobId, { adjustments: { setLines: [{ lineId: s.parentId, approvedAmount: '5200.00', reason: '' }] } })
        expect(bad.status).toBe(400)
        expect(bad.body.error).toBe('invalid_request')
        expect(bad.body.fields[`adjustments.setLines.${s.parentId}.reason`]).toBeTruthy()
        const idx = await confirmRaw(s.jobId, { adjustments: { setLines: [{ lineId: 'not-a-uuid-ECHO', approvedAmount: '1.00', reason: 'x' }] } })
        expect(idx.status).toBe(400)
        expect(idx.body.fields['adjustments.setLines.0.lineId']).toBeTruthy()
        expect(JSON.stringify(idx.body)).not.toContain('ECHO')
      })
    })
  },
)
