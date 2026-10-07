/**
 * P3.1 catalog + standard prices + controlled vehicle models — AC3, AC8, AC10,
 * AC15, AC16/17/19 (catalog side), D8 (first price), D9/8.1 (fixing a price),
 * D12 (similar-name warning, merge), R2 (cars matched to a controlled model),
 * roles, and two-shop isolation for every catalog endpoint.
 *
 * TIER 2. Needs PostgreSQL with migrations 0001-0022 applied (as gsms_app) and
 * DATABASE_ADMIN_URL for cleanup (see quotation.integration.test.ts).
 *
 * Tests whose name starts with "BUG?" encode the spec for a case the WIP code
 * is suspected not to meet. Do not weaken them to make them pass.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { sql } from 'kysely'
import pg from 'pg'
import { resolveCatalogItem, type MergeableItem } from '@champpower/domain'
import type { CatalogSearchResult, Quotation } from '@gsms/contracts/index.js'
import { withShop } from '@gsms/db/client.js'
import { db } from '../lib/db.js'
import { adminDatabaseUrl, hasDatabase, tier2 } from '../test/env.js'
import {
  createTwoShopFixture, del, get, issueTokensFor, patch, post, put, startApi,
  type ApiResponse, type RunningApi, type TwoShopFixture,
} from '../test/fixtures.js'

type Role = Parameters<typeof issueTokensFor>[2]
type Res<T = any> = ApiResponse<T> // eslint-disable-line @typescript-eslint/no-explicit-any

interface Seed {
  vm: string // Toyota Vios
  ball: string // priced 1000.00 base, model price none
  modelPriced: string // base 800, Vios 1200
  unpriced: string
  w90: string
}

const COST_KEY = /cost|margin|profit/i
function allKeys(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) v.forEach((x) => allKeys(x, out))
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.push(k); allKeys(x, out) }
  return out
}

describe.skipIf(!hasDatabase || !adminDatabaseUrl)(
  tier2('P3.1 catalog API — prices, duplicates, merge, vehicle models, isolation (needs DATABASE_ADMIN_URL)'),
  () => {
    let api: RunningApi
    let fx: TwoShopFixture
    const seeds = {} as Record<string, Seed>

    beforeAll(async () => {
      api = await startApi({ intakeWriteLimit: 1_000_000 })
      fx = await createTwoShopFixture('p31c')
      seeds[fx.shopA] = await seedShop(fx.shopA)
      seeds[fx.shopB] = await seedShop(fx.shopB)
    })

    afterAll(async () => {
      if (fx) {
        const admin = new pg.Client({ connectionString: adminDatabaseUrl })
        await admin.connect()
        try {
          await admin.query('set session_replication_role = replica')
          for (const t of [
            'vehicle_offered_items', 'document_lines', 'documents', 'catalog_model_prices',
            'catalog_set_components', 'catalog_items', 'warranty_terms', 'vehicle_models',
          ]) await admin.query(`delete from ${t} where shop_id = any($1)`, [[fx.shopA, fx.shopB]])
        } finally { await admin.end() }
      }
      await fx?.cleanup()
      await api?.close()
    })

    // ------------------------------------------------------------------ helpers
    const tokenCache = new Map<string, string>()
    async function tok(role: Role = 'owner', shop = fx.shopA): Promise<string> {
      const key = `${shop}|${role}`
      let t = tokenCache.get(key)
      if (!t) { t = (await issueTokensFor(fx.userId, shop, role)).accessToken; tokenCache.set(key, t) }
      return t
    }
    const GET = async <T = any>(p: string, role: Role = 'owner', shop = fx.shopA): Promise<Res<T>> => get<T>(api, p, await tok(role, shop))
    const POST = async <T = any>(p: string, b: unknown = {}, role: Role = 'owner', shop = fx.shopA): Promise<Res<T>> => post<T>(api, p, b, await tok(role, shop))
    const PUT = async <T = any>(p: string, b: unknown = {}, role: Role = 'owner', shop = fx.shopA): Promise<Res<T>> => put<T>(api, p, b, await tok(role, shop))
    const PATCH = async <T = any>(p: string, b: unknown = {}, role: Role = 'owner', shop = fx.shopA): Promise<Res<T>> => patch<T>(api, p, b, await tok(role, shop))
    const DEL = async <T = any>(p: string, role: Role = 'owner', shop = fx.shopA): Promise<Res<T>> => del<T>(api, p, await tok(role, shop))

    const q = <T,>(shop: string, fn: (trx: Parameters<Parameters<typeof withShop>[2]>[0]) => Promise<T>) => withShop(db, shop, fn)

    async function seedShop(shop: string): Promise<Seed> {
      return q(shop, async (trx) => {
        const id = async (s: ReturnType<typeof sql<{ id: string }>>) => (await s.execute(trx)).rows[0]!.id
        const w90 = await id(sql<{ id: string }>`insert into warranty_terms (shop_id, name, days, max_km) values (${shop}, 'รับประกัน 90 วัน', 90, null) returning id`)
        const vm = await id(sql<{ id: string }>`insert into vehicle_models (shop_id, brand, name, year_range) values (${shop}, 'Toyota', 'Vios', '2013-2022') returning id`)
        const item = (name: string, base: string | null, w: string | null) =>
          id(sql<{ id: string }>`insert into catalog_items (shop_id, category, name, line_type, base_price, warranty_term_id)
            values (${shop}, 'ช่วงล่าง', ${name}, 'part', ${base}, ${w}) returning id`)
        const ball = await item('ลูกหมากปีกนกล่าง', '1000.00', w90)
        const modelPriced = await item('ลูกหมากแร็ค', '800.00', w90)
        const unpriced = await item('ยางครอบแร็ค', null, null)
        await sql`insert into catalog_model_prices (shop_id, item_id, vehicle_model_id, price) values (${shop}, ${modelPriced}, ${vm}, '1200.00')`.execute(trx)
        return { vm, ball, modelPriced, unpriced, w90 }
      })
    }

    let plateSeq = 0
    const runTag = Math.floor(Math.random() * 9000) + 1000
    async function checkIn(shop = fx.shopA, brand = 'Toyota', model = 'Vios'): Promise<{ jobId: string; vehicleId: string }> {
      plateSeq++
      const r = await POST<{ jobId: string; vehicleId: string }>('/api/checkin', {
        plate: `คก ${runTag}${plateSeq}`.slice(0, 12), customerName: 'ทดสอบ', brand, model, province: 'กรุงเทพมหานคร',
      }, 'owner', shop)
      expect(r.status, JSON.stringify(r.body)).toBe(201)
      return r.body
    }
    /** A job at quoted with a car optionally already matched to a controlled model. */
    async function job(o: { shop?: string; model?: string | null; brand?: string; modelText?: string } = {}) {
      const shop = o.shop ?? fx.shopA
      // With no model asked for, use a car that is NOT in the controlled list (intake now links a
      // car whose brand+model match exactly one controlled model, e.g. Toyota Vios from the seed).
      const unlisted = o.model || o.brand || o.modelText ? {} : { brand: 'ไม่มีในรายการ', modelText: 'รุ่น' + (++plateSeq) }
      const j = await checkIn(shop, o.brand ?? unlisted.brand, o.modelText ?? unlisted.modelText)
      if (o.model) await q(shop, (trx) => sql`update vehicles set vehicle_model_id = ${o.model} where id = ${j.vehicleId}`.execute(trx))
      return j
    }
    const search = (jobId: string, text: string, role: Role = 'owner', shop = fx.shopA) =>
      GET<CatalogSearchResult>(`/api/catalog/search?q=${encodeURIComponent(text)}&jobId=${jobId}`, role, shop)

    async function audit(shop: string, action: string, entityId?: string) {
      return q(shop, async (trx) => {
        let s = trx.selectFrom('audit_logs').select(['action', 'actor_id', 'entity_id', 'before', 'after']).where('action', '=', action)
        if (entityId) s = s.where('entity_id', '=', entityId)
        return s.execute()
      })
    }
    async function newItem(name: string, category = 'ทดสอบ', shop = fx.shopA): Promise<string> {
      const r = await POST<{ id: string }>('/api/catalog/items', { category, name, confirmNotSimilar: true }, 'owner', shop)
      expect(r.status, JSON.stringify(r.body)).toBe(201)
      return r.body.id
    }
    async function createVehicleModel(brand: string, name: string, shop = fx.shopA): Promise<string> {
      const r = await POST<{ id: string }>('/api/vehicle-models', { brand, name }, 'owner', shop)
      expect(r.status, JSON.stringify(r.body)).toBe(201)
      return r.body.id
    }

    // ======================================================================
    // roles
    // ======================================================================
    describe('roles', () => {
      it('advisor+ reaches the working endpoints; technician, viewer and accountant get 403; no token gets 401', async () => {
        const s = seeds[fx.shopA]!
        const { jobId } = await job()
        const probes: Array<[string, () => Promise<Res>]> = [
          ['search', () => search(jobId, 'ลูกหมาก', 'advisor')],
          ['warranty-terms', () => GET('/api/warranty-terms', 'advisor')],
          ['vehicle-models', () => GET('/api/vehicle-models', 'advisor')],
          ['similar', () => GET('/api/catalog/similar?category=ช่วงล่าง&name=ลูกหมาก', 'advisor')],
        ]
        for (const [what, call] of probes) expect((await call()).status, what).toBe(200)
        for (const role of ['technician', 'viewer', 'accountant'] as const) {
          expect((await search(jobId, 'ลูกหมาก', role)).status, `search ${role}`).toBe(403)
          expect((await GET('/api/warranty-terms', role)).status, `warranty ${role}`).toBe(403)
          expect((await GET('/api/vehicle-models', role)).status, `models ${role}`).toBe(403)
          expect((await POST('/api/catalog/prices', { jobId, itemId: s.unpriced, price: '1' }, role)).status, `price ${role}`).toBe(403)
          expect((await POST('/api/catalog/items', { category: 'x', name: 'y' }, role)).status, `item ${role}`).toBe(403)
        }
        expect((await get(api, '/api/warranty-terms')).status).toBe(401)
      })

      it('manager+ only: fix a price, merge, list/assign unmatched models (advisor 403)', async () => {
        const s = seeds[fx.shopA]!
        const nope: Array<[string, Res]> = [
          ['PUT price', await PUT(`/api/catalog/prices/${s.ball}`, { scope: 'base', price: '1', reason: 'x' }, 'advisor')],
          ['merge', await POST(`/api/catalog/items/${s.ball}/merge`, { intoItemId: s.unpriced }, 'advisor')],
          ['unmatched list', await GET('/api/vehicle-models/unmatched', 'advisor')],
          ['unmatched assign', await POST('/api/vehicle-models/unmatched/assign', { brandText: 'a', modelText: 'b', vehicleModelId: s.vm }, 'advisor')],
        ]
        for (const [what, r] of nope) expect(r.status, what).toBe(403)
        for (const role of ['manager', 'assistant_manager'] as const) {
          expect((await GET('/api/vehicle-models/unmatched', role)).status, role).toBe(200)
        }
      })
    })

    // ======================================================================
    // search + price resolution (v3 §4.3)
    // ======================================================================
    describe('search', () => {
      it('a query shorter than 2 characters is a 400; an unknown field is a 400 (strict)', async () => {
        const { jobId } = await job()
        expect((await search(jobId, 'ล')).status).toBe(400)
        expect((await GET(`/api/catalog/search?q=ลูก&jobId=${jobId}&cost=1`)).status).toBe(400)
      })

      it('price: the car\'s model price, else the item\'s base price, else none — and says which', async () => {
        const s = seeds[fx.shopA]!
        const matched = await job({ model: s.vm })
        const unmatched = await job()
        const onMatched = (await search(matched.jobId, 'ลูกหมากแร็ค')).body
        expect(onMatched.vehicleModelLinked).toBe(true)
        expect(onMatched.items[0]).toMatchObject({ itemId: s.modelPriced, price: '1200.00', priceSource: 'model' })
        const onUnmatched = (await search(unmatched.jobId, 'ลูกหมากแร็ค')).body
        expect(onUnmatched.vehicleModelLinked).toBe(false)
        expect(onUnmatched.items[0]).toMatchObject({ price: '800.00', priceSource: 'base', priceRefId: null })
        expect((await search(matched.jobId, 'ยางครอบ')).body.items[0]).toMatchObject({ price: null, priceSource: 'none' })
      })

      it('sets come first; an item carries its warranty term; merged and inactive items are not offered', async () => {
        const j = await job()
        const setId = (await q(fx.shopA, async (trx) => (await sql<{ id: string }>`insert into catalog_items (shop_id, category, name, is_set, base_price)
          values (${fx.shopA}, 'ชุดโปร', 'ชุดค้นหา ลูกหมาก', true, '100.00') returning id`.execute(trx)).rows[0]!.id))
        const dead = await newItem('ลูกหมากเลิกขาย')
        await q(fx.shopA, (trx) => sql`update catalog_items set is_active = false where id = ${dead}`.execute(trx))
        const r = (await search(j.jobId, 'ลูกหมาก')).body
        expect(r.items[0]!.itemId).toBe(setId)
        expect(r.items[0]!.isSet).toBe(true)
        const ball = r.items.find((i) => i.itemId === seeds[fx.shopA]!.ball)!
        expect(ball.warranty).toEqual({ id: seeds[fx.shopA]!.w90, name: 'รับประกัน 90 วัน', days: 90, maxKm: null })
        expect(r.items.map((i) => i.itemId)).not.toContain(dead)
      })

      it('AC10: no cost / margin / profit key in any catalog response for advisor', async () => {
        const s = seeds[fx.shopA]!
        const j = await job({ model: s.vm })
        const bodies: unknown[] = [
          (await search(j.jobId, 'ลูกหมาก', 'advisor')).body,
          (await GET('/api/warranty-terms', 'advisor')).body,
          (await GET('/api/vehicle-models', 'advisor')).body,
          (await GET('/api/catalog/similar?category=ช่วงล่าง&name=ลูกหมากปีก', 'advisor')).body,
          (await POST('/api/catalog/items', { category: 'ช่วงล่าง', name: 'ลูกหมากใหม่ AC10' }, 'advisor')).body,
          (await POST('/api/catalog/prices', { jobId: j.jobId, itemId: s.unpriced, price: '10.00' }, 'advisor')).body,
        ]
        expect([...new Set(allKeys(bodies).filter((k) => COST_KEY.test(k)))]).toEqual([])
      })
    })

    // ======================================================================
    // First price (D8) and fixing it (D9, 8.1)
    // ======================================================================
    describe('standard prices', () => {
      it('AC3/D8: the first price typed for a matched car is saved against its MODEL; the item\'s base price is untouched', async () => {
        const s = seeds[fx.shopA]!
        const itemId = await newItem('อะไหล่ราคาแรก AC3')
        const j = await job({ model: s.vm })
        const w = await POST('/api/catalog/prices', { jobId: j.jobId, itemId, price: '450.00' }, 'advisor')
        expect(w.status, JSON.stringify(w.body)).toBe(201)
        expect(w.body).toMatchObject({ itemId, scope: 'model', price: '450.00' })
        const rows = await q(fx.shopA, async (trx) => (await sql<{ id: string; price: string }>`select id, price from catalog_model_prices where item_id = ${itemId}`.execute(trx)).rows)
        expect(rows).toEqual([{ id: w.body.priceId, price: '450.00' }])
        const base = await q(fx.shopA, async (trx) => (await sql<{ base_price: string | null }>`select base_price from catalog_items where id = ${itemId}`.execute(trx)).rows[0]!)
        expect(base.base_price).toBeNull()
        const audited = await audit(fx.shopA, 'catalog_price_set', w.body.priceId)
        expect(audited).toHaveLength(1)
        expect(audited[0]!.after).toMatchObject({ itemId, price: '450.00' })
      })

      it('AC3/D8: a car with no controlled model saves the first price as the item\'s base price', async () => {
        const itemId = await newItem('อะไหล่ราคาแรกฐาน')
        const j = await job()
        const w = await POST('/api/catalog/prices', { jobId: j.jobId, itemId, price: '300.00' })
        expect(w.status, JSON.stringify(w.body)).toBe(201)
        expect(w.body).toMatchObject({ itemId, scope: 'base', price: '300.00' })
        expect((await search(j.jobId, 'อะไหล่ราคาแรกฐาน')).body.items[0]).toMatchObject({ price: '300.00', priceSource: 'base' })
      })

      it('AC8: a second first-price is refused 409 price_already_set with the existing price, for model and for base', async () => {
        const s = seeds[fx.shopA]!
        const onModel = await newItem('ซ้ำบนรุ่น')
        const m = await job({ model: s.vm })
        expect((await POST('/api/catalog/prices', { jobId: m.jobId, itemId: onModel, price: '100.00' })).status).toBe(201)
        const second = await POST('/api/catalog/prices', { jobId: m.jobId, itemId: onModel, price: '999.00' })
        expect(second.status, JSON.stringify(second.body)).toBe(409)
        expect(second.body).toMatchObject({ error: 'price_already_set', existingPrice: '100.00', scope: 'model' })

        const onBase = await newItem('ซ้ำบนฐาน')
        const b = await job()
        expect((await POST('/api/catalog/prices', { jobId: b.jobId, itemId: onBase, price: '70.00' })).status).toBe(201)
        const again = await POST('/api/catalog/prices', { jobId: b.jobId, itemId: onBase, price: '80.00' })
        expect(again.status).toBe(409)
        expect(again.body).toMatchObject({ error: 'price_already_set', existingPrice: '70.00', scope: 'base' })
      })

      it('AC8/AC19: two people typing the first price at the same moment — exactly one wins, the other is told the winner\'s price', async () => {
        const s = seeds[fx.shopA]!
        const itemId = await newItem('แข่งกันตั้งราคา')
        const j1 = await job({ model: s.vm })
        const j2 = await job({ model: s.vm })
        const [r1, r2] = await Promise.all([
          POST('/api/catalog/prices', { jobId: j1.jobId, itemId, price: '111.00' }),
          POST('/api/catalog/prices', { jobId: j2.jobId, itemId, price: '222.00' }),
        ])
        const statuses = [r1.status, r2.status].sort()
        expect(statuses).toEqual([201, 409])
        const winner = r1.status === 201 ? r1 : r2
        const loser = r1.status === 201 ? r2 : r1
        expect(loser.body).toMatchObject({ error: 'price_already_set', existingPrice: winner.body.price })
        const rows = await q(fx.shopA, async (trx) => (await sql<{ price: string }>`select price from catalog_model_prices where item_id = ${itemId}`.execute(trx)).rows)
        expect(rows).toEqual([{ price: winner.body.price }])
      })

      it('a price of 0 is a deliberate price (free), and is not overwritten by a later first-price', async () => {
        const itemId = await newItem('แถมฟรี')
        const j = await job()
        expect((await POST('/api/catalog/prices', { jobId: j.jobId, itemId, price: '0' })).status).toBe(201)
        const next = await POST('/api/catalog/prices', { jobId: j.jobId, itemId, price: '50.00' })
        expect(next.status).toBe(409)
        expect(next.body.existingPrice).toBe('0.00')
        expect((await search(j.jobId, 'แถมฟรี')).body.items[0]).toMatchObject({ price: '0.00', priceSource: 'base' })
      })

      it('invalid money is a 400 (no negatives, at most 2 decimals, strict body)', async () => {
        const j = await job()
        const s = seeds[fx.shopA]!
        for (const price of ['-1', '1.234', 'abc', '']) {
          expect((await POST('/api/catalog/prices', { jobId: j.jobId, itemId: s.unpriced, price })).status, price).toBe(400)
        }
        expect((await POST('/api/catalog/prices', { jobId: j.jobId, itemId: s.unpriced, price: '1', cost: '1' })).status).toBe(400)
      })

      it('BUG?: a first price for an item that does not exist is a clean 404 catalog_item_not_found, not a 500', async () => {
        const j = await job()
        const r = await POST('/api/catalog/prices', { jobId: j.jobId, itemId: randomUUID(), price: '10.00' })
        expect(r.status, JSON.stringify(r.body)).toBe(404)
        expect(r.body.error).toBe('catalog_item_not_found')
      })

      it('AC8: an advisor fixing a price is 403; a manager may, with a mandatory reason, and the audit keeps old -> new and why', async () => {
        const s = seeds[fx.shopA]!
        const row = await q(fx.shopA, async (trx) => (await sql<{ id: string }>`select id from catalog_model_prices where item_id = ${s.modelPriced}`.execute(trx)).rows[0]!)
        const body = { scope: 'model', price: '1250.00', reason: 'พิมพ์ผิด' }
        expect((await PUT(`/api/catalog/prices/${row.id}`, body, 'advisor')).status).toBe(403)
        expect((await PUT(`/api/catalog/prices/${row.id}`, { ...body, reason: '' }, 'manager')).status).toBe(400)
        expect((await PUT(`/api/catalog/prices/${row.id}`, { scope: 'model', price: '1250.00' }, 'manager')).status).toBe(400)
        expect((await PUT(`/api/catalog/prices/${row.id}`, { ...body, price: '-5' }, 'manager')).status).toBe(400)

        const ok = await PUT(`/api/catalog/prices/${row.id}`, body, 'manager')
        expect(ok.status, JSON.stringify(ok.body)).toBe(200)
        expect(ok.body).toMatchObject({ priceId: row.id, scope: 'model', price: '1250.00' })
        const a = await audit(fx.shopA, 'catalog_price_corrected', row.id)
        expect(a).toHaveLength(1)
        expect(a[0]!.before).toMatchObject({ price: '1200.00', reason: 'พิมพ์ผิด' })
        expect(a[0]!.after).toMatchObject({ price: '1250.00' })
        // put it back so the other tests keep their meaning
        await PUT(`/api/catalog/prices/${row.id}`, { scope: 'model', price: '1200.00', reason: 'คืนค่า' }, 'owner')
      })

      it('BUG?: the PUT response names the CATALOG ITEM in itemId (not the price row id) when the scope is model', async () => {
        const s = seeds[fx.shopA]!
        const row = await q(fx.shopA, async (trx) => (await sql<{ id: string }>`select id from catalog_model_prices where item_id = ${s.modelPriced}`.execute(trx)).rows[0]!)
        const r = await PUT(`/api/catalog/prices/${row.id}`, { scope: 'model', price: '1200.00', reason: 'ตรวจ' }, 'manager')
        expect(r.status).toBe(200)
        expect(r.body.itemId).toBe(s.modelPriced)
      })

      it('fixing the base price (scope base) works with the item id; the wrong scope or an unknown id is 404', async () => {
        const itemId = await newItem('แก้ราคาฐาน')
        const j = await job()
        await POST('/api/catalog/prices', { jobId: j.jobId, itemId, price: '10.00' })
        const ok = await PUT(`/api/catalog/prices/${itemId}`, { scope: 'base', price: '12.00', reason: 'ปรับ' }, 'manager')
        expect(ok.status, JSON.stringify(ok.body)).toBe(200)
        expect(ok.body).toMatchObject({ scope: 'base', price: '12.00' })
        const a = await audit(fx.shopA, 'catalog_price_corrected', itemId)
        expect(a[0]!.before).toMatchObject({ price: '10.00', reason: 'ปรับ' })
        expect((await PUT(`/api/catalog/prices/${itemId}`, { scope: 'model', price: '1', reason: 'x' }, 'manager')).status).toBe(404)
        expect((await PUT(`/api/catalog/prices/${randomUUID()}`, { scope: 'base', price: '1', reason: 'x' }, 'manager')).status).toBe(404)
      })

      it('overriding a price on a quotation line never writes it back to the catalog', async () => {
        const s = seeds[fx.shopA]!
        const j = await job({ model: s.vm })
        await POST(`/api/jobs/${j.jobId}/quotation`, {})
        const r = await POST<Quotation>(`/api/jobs/${j.jobId}/quotation/lines`, { kind: 'item', itemId: s.modelPriced, unitPrice: '999.00' })
        expect(r.status).toBe(201)
        expect(r.body.lines[0]).toMatchObject({ unitPrice: '999.00', listPrice: '1200.00', priceSource: 'model' })
        expect((await search(j.jobId, 'ลูกหมากแร็ค')).body.items[0]!.price).toBe('1200.00')
      })
    })

    // ======================================================================
    // Duplicate names (D12) and merge
    // ======================================================================
    describe('AC15 / D12 similar names and merge', () => {
      it('adding "…L/R" where "…L+R" exists is a 409 similar_item_found naming the existing item; nothing is created', async () => {
        const existing = await newItem('ลูกหมากปีกนกล่าง L+R', 'หมวดซ้ำ')
        const r = await POST('/api/catalog/items', { category: 'หมวดซ้ำ', name: 'ลูกหมากปีกนกล่าง L/R' })
        expect(r.status, JSON.stringify(r.body)).toBe(409)
        expect(r.body.error).toBe('similar_item_found')
        expect(r.body.similar.map((x: { id: string }) => x.id)).toContain(existing)
        const n = await q(fx.shopA, async (trx) => (await sql<{ n: string }>`select count(*) n from catalog_items where name = 'ลูกหมากปีกนกล่าง L/R'`.execute(trx)).rows[0]!.n)
        expect(Number(n)).toBe(0)
      })

      it('GET /catalog/similar finds the same-key, edit-distance-2 and containment cases, only within the category', async () => {
        const a = await newItem('ปีกนกล่างซ้าย', 'หมวดค้นซ้ำ')
        await newItem('ปีกนกล่างซ้าย', 'หมวดอื่น')
        const same = (await GET<{ items: { id: string }[] }>('/api/catalog/similar?category=หมวดค้นซ้ำ&name=' + encodeURIComponent('ปีกนก ล่าง-ซ้าย'))).body.items
        expect(same.map((x) => x.id)).toEqual([a])
        const near = (await GET<{ items: { id: string }[] }>('/api/catalog/similar?category=หมวดค้นซ้ำ&name=' + encodeURIComponent('ปีกนกล่างซ้ายย'))).body.items
        expect(near.map((x) => x.id), 'one-character typo, distance 1').toEqual([a])
        const far = (await GET<{ items: { id: string }[] }>('/api/catalog/similar?category=หมวดค้นซ้ำ&name=' + encodeURIComponent('น้ำมันเกียร์'))).body.items
        expect(far).toEqual([])
      })

      it('left and right are different parts: ปีกนกล่างซ้าย vs ปีกนกล่างขวา are NOT similar (edit distance 3)', async () => {
        await newItem('ปีกนกล่างซ้าย', 'หมวดซ้ายขวา')
        const r = (await GET<{ items: { id: string }[] }>('/api/catalog/similar?category=หมวดซ้ายขวา&name=' + encodeURIComponent('ปีกนกล่างขวา'))).body.items
        expect(r).toEqual([])
        const add = await POST('/api/catalog/items', { category: 'หมวดซ้ายขวา', name: 'ปีกนกล่างขวา' })
        expect(add.status, JSON.stringify(add.body)).toBe(201)
      })

      it('confirmNotSimilar lets the person add it anyway (201) and it is audited', async () => {
        await newItem('คันชักนอก', 'หมวดยืนยัน')
        const r = await POST('/api/catalog/items', { category: 'หมวดยืนยัน', name: 'คันชักนอก L', confirmNotSimilar: true }, 'advisor')
        expect(r.status, JSON.stringify(r.body)).toBe(201)
        expect(await audit(fx.shopA, 'catalog_item_created', r.body.id)).toHaveLength(1)
      })

      it('BUG?: adding the SAME name again (even with confirmNotSimilar) is a 409, not a 500 from the unique index', async () => {
        await newItem('ชื่อซ้ำเป๊ะ', 'หมวดซ้ำเป๊ะ')
        const r = await POST('/api/catalog/items', { category: 'หมวดซ้ำเป๊ะ', name: 'ชื่อซ้ำเป๊ะ', confirmNotSimilar: true })
        expect(r.status, JSON.stringify(r.body)).toBe(409)
      })

      it('merge A into B: A is retired and hidden, B stays; the old document line is NOT rewritten, and the domain resolves A to B', async () => {
        const A = await newItem('ลูกหมากปีกนกล่าง L/R รวม', 'หมวดรวม')
        const B = await newItem('ลูกหมากปีกนกล่าง L+R รวม', 'หมวดรวม')
        // a quotation line that points at A, issued (so the line is frozen)
        const j = await job()
        await POST(`/api/jobs/${j.jobId}/quotation`, {})
        await POST(`/api/jobs/${j.jobId}/quotation/lines`, { kind: 'item', itemId: A, unitPrice: '10.00' })
        expect((await POST(`/api/jobs/${j.jobId}/quotation/issue`, {})).status).toBe(200)

        expect((await POST(`/api/catalog/items/${A}/merge`, { intoItemId: B }, 'advisor')).status).toBe(403)
        const m = await POST(`/api/catalog/items/${A}/merge`, { intoItemId: B, reason: 'ซ้ำกัน' }, 'manager')
        expect(m.status, JSON.stringify(m.body)).toBe(200)
        expect(m.body).toMatchObject({ sourceItemId: A, intoItemId: B })

        const rows = await q(fx.shopA, async (trx) => (await sql<{ id: string; merged_into_id: string | null; is_active: boolean }>`
          select id, merged_into_id, is_active from catalog_items where id in (${A}, ${B})`.execute(trx)).rows)
        const items = new Map<string, MergeableItem>(rows.map((r) => [r.id, { id: r.id, mergedIntoId: r.merged_into_id }]))
        expect(rows.find((r) => r.id === A)).toMatchObject({ merged_into_id: B, is_active: false })
        expect(rows.find((r) => r.id === B)).toMatchObject({ merged_into_id: null, is_active: true })
        expect(resolveCatalogItem(A, items)!.id).toBe(B)

        const line = await q(fx.shopA, async (trx) => (await sql<{ catalog_item_id: string }>`
          select dl.catalog_item_id from document_lines dl join documents d on d.id = dl.document_id where d.job_id = ${j.jobId}`.execute(trx)).rows[0]!)
        expect(line.catalog_item_id, 'the issued document still says what was sold').toBe(A)

        const found = (await search(j.jobId, 'ลูกหมากปีกนกล่าง')).body.items.map((i) => i.itemId)
        expect(found).toContain(B)
        expect(found).not.toContain(A)
        const a = await audit(fx.shopA, 'catalog_item_merged', A)
        expect(a).toHaveLength(1)
        expect(a[0]!.after).toMatchObject({ mergedIntoId: B })
      })

      it('merge moves A\'s model prices to B where B has none; a clash is a 409 listing the models until the manager chooses', async () => {
        const A = await newItem('รวมราคา A', 'หมวดรวมราคา')
        const B = await newItem('รวมราคา B', 'หมวดรวมราคา')
        const m1 = await createVehicleModel('Honda', 'City-รวมราคา')
        const m2 = await createVehicleModel('Honda', 'Jazz-รวมราคา')
        await q(fx.shopA, async (trx) => {
          await sql`insert into catalog_model_prices (shop_id, item_id, vehicle_model_id, price) values
            (${fx.shopA}, ${A}, ${m1}, '100.00'), (${fx.shopA}, ${A}, ${m2}, '200.00'), (${fx.shopA}, ${B}, ${m1}, '999.00')`.execute(trx)
        })
        const clash = await POST(`/api/catalog/items/${A}/merge`, { intoItemId: B }, 'manager')
        expect(clash.status, JSON.stringify(clash.body)).toBe(409)
        expect(clash.body).toMatchObject({ error: 'merge_price_conflict', vehicleModelIds: [m1] })
        // a refused merge changes nothing
        const still = await q(fx.shopA, async (trx) => (await sql<{ merged_into_id: string | null }>`select merged_into_id from catalog_items where id = ${A}`.execute(trx)).rows[0]!)
        expect(still.merged_into_id).toBeNull()

        const ok = await POST(`/api/catalog/items/${A}/merge`, { intoItemId: B, priceConflicts: [{ vehicleModelId: m1, keep: 'source' }] }, 'manager')
        expect(ok.status, JSON.stringify(ok.body)).toBe(200)
        expect(ok.body).toMatchObject({ movedPrices: 2, droppedPrices: 0 })
        const prices = await q(fx.shopA, async (trx) => (await sql<{ vehicle_model_id: string; price: string }>`
          select vehicle_model_id, price from catalog_model_prices where item_id = ${B} order by price`.execute(trx)).rows)
        expect(prices).toEqual([{ vehicle_model_id: m1, price: '100.00' }, { vehicle_model_id: m2, price: '200.00' }])
      })

      it('merging an item into itself, or A into B when B is already merged into A, is refused (409 merge_not_allowed)', async () => {
        const A = await newItem('วงรวม A', 'หมวดวง')
        const B = await newItem('วงรวม B', 'หมวดวง')
        expect((await POST(`/api/catalog/items/${A}/merge`, { intoItemId: A }, 'manager')).body.error).toBe('merge_not_allowed')
        expect((await POST(`/api/catalog/items/${A}/merge`, { intoItemId: B }, 'manager')).status).toBe(200)
        const back = await POST(`/api/catalog/items/${B}/merge`, { intoItemId: A }, 'manager')
        expect(back.status).toBe(409)
        expect(back.body.error).toBe('merge_not_allowed')
      })

      it('BUG?: a three-item loop (A->B, B->C, C->A) is refused too — merges never make a cycle', async () => {
        const A = await newItem('วง3 A', 'หมวดวง3')
        const B = await newItem('วง3 B', 'หมวดวง3')
        const C = await newItem('วง3 C', 'หมวดวง3')
        expect((await POST(`/api/catalog/items/${A}/merge`, { intoItemId: B }, 'manager')).status).toBe(200)
        expect((await POST(`/api/catalog/items/${B}/merge`, { intoItemId: C }, 'manager')).status).toBe(200)
        const close = await POST(`/api/catalog/items/${C}/merge`, { intoItemId: A }, 'manager')
        expect(close.status, JSON.stringify(close.body)).toBe(409)
        expect(close.body.error).toBe('merge_not_allowed')
      })

      it('merging an item that does not exist is a 409 merge_not_allowed', async () => {
        const A = await newItem('รวมไม่เจอ', 'หมวดไม่เจอ')
        const r = await POST(`/api/catalog/items/${A}/merge`, { intoItemId: randomUUID() }, 'manager')
        expect(r.status).toBe(409)
        expect(r.body.error).toBe('merge_not_allowed')
      })
    })

    // ======================================================================
    // Controlled vehicle models (R2)
    // ======================================================================
    describe('AC17 / R2 vehicle models', () => {
      it('GET /vehicle-models searches brand or name, pages, and counts the total', async () => {
        await createVehicleModel('Mazda', 'ค้นหา-2-ก')
        await createVehicleModel('Mazda', 'ค้นหา-2-ข')
        const all = (await GET('/api/vehicle-models?q=ค้นหา-2')).body
        expect(all.total).toBe(2)
        const page = (await GET('/api/vehicle-models?q=ค้นหา-2&limit=1&offset=1')).body
        expect(page.items).toHaveLength(1)
        expect(page.total).toBe(2)
        expect((await GET('/api/vehicle-models?limit=0')).status).toBe(400)
      })

      it('creating a model is advisor+, audited; the same brand+name after normalising is a 409 with the existing id', async () => {
        const id = await createVehicleModel('Subaru', 'Forester-ใหม่')
        expect(await audit(fx.shopA, 'vehicle_model_created', id)).toHaveLength(1)
        const dup = await POST('/api/vehicle-models', { brand: 'SUBARU', name: 'forester ใหม่' }, 'advisor')
        expect(dup.status).toBe(409)
        expect(dup.body).toMatchObject({ error: 'vehicle_model_exists', vehicleModelId: id })
        expect((await POST('/api/vehicle-models', { brand: 'X', name: 'Y' }, 'technician')).status).toBe(403)
      })

      it('AC17: "Chevloret" is not guessed into Chevrolet; its first price lives on the item, not under the typed text', async () => {
        const s = seeds[fx.shopA]!
        const itemId = await newItem('อะไหล่เชฟ AC17', 'หมวด17')
        await createVehicleModel('Chevrolet', 'Spark-17')
        const j = await job({ brand: 'Chevloret', modelText: 'Spark-17' })
        const vm = await q(fx.shopA, async (trx) => (await sql<{ vehicle_model_id: string | null }>`select vehicle_model_id from vehicles where id = ${j.vehicleId}`.execute(trx)).rows[0]!)
        expect(vm.vehicle_model_id).toBeNull()
        expect((await search(j.jobId, 'อะไหล่เชฟ')).body.vehicleModelLinked).toBe(false)
        const w = await POST('/api/catalog/prices', { jobId: j.jobId, itemId, price: '900.00' })
        expect(w.body.scope).toBe('base')
        const stray = await q(fx.shopA, async (trx) => (await sql<{ n: string }>`select count(*) n from catalog_model_prices where item_id = ${itemId}`.execute(trx)).rows[0]!.n)
        expect(Number(stray)).toBe(0)
        expect(s.vm).toBeTruthy()
      })

      it('AC17: matching the group to Chevrolet (manager) links the cars, audits it, and the model price then shows', async () => {
        const model = await createVehicleModel('Chevrolet', 'Cruze-17')
        const itemId = await newItem('อะไหล่เชฟ Cruze', 'หมวด17b')
        await q(fx.shopA, (trx) => sql`insert into catalog_model_prices (shop_id, item_id, vehicle_model_id, price) values (${fx.shopA}, ${itemId}, ${model}, '1500.00')`.execute(trx))
        await q(fx.shopA, (trx) => sql`update catalog_items set base_price = '1000.00' where id = ${itemId}`.execute(trx))
        const j1 = await job({ brand: 'Chevloret', modelText: 'Cruze-17' })
        const j2 = await job({ brand: 'Chevloret', modelText: 'Cruze-17' })
        expect((await search(j1.jobId, 'อะไหล่เชฟ Cruze')).body.items[0]).toMatchObject({ price: '1000.00', priceSource: 'base' })

        const list = (await GET('/api/vehicle-models/unmatched?limit=100', 'manager')).body
        const group = list.items.find((g: { brandText: string; modelText: string }) => g.brandText === 'Chevloret' && g.modelText === 'Cruze-17')
        expect(group.vehicleCount).toBe(2)

        const assign = await POST('/api/vehicle-models/unmatched/assign', { brandText: 'Chevloret', modelText: 'Cruze-17', vehicleModelId: model }, 'manager')
        expect(assign.status, JSON.stringify(assign.body)).toBe(200)
        expect(assign.body.updated).toBe(2)
        expect(await audit(fx.shopA, 'vehicle_model_group_assigned', model)).toHaveLength(1)
        const after = (await GET('/api/vehicle-models/unmatched?limit=100', 'manager')).body
        expect(after.items.find((g: { modelText: string }) => g.modelText === 'Cruze-17')).toBeUndefined()
        const hit = (await search(j2.jobId, 'อะไหล่เชฟ Cruze')).body
        expect(hit.vehicleModelLinked).toBe(true)
        expect(hit.items[0]).toMatchObject({ price: '1500.00', priceSource: 'model' })
      })

      it('PUT /vehicles/:id/model links one car (advisor+), audits it, and is idempotent', async () => {
        const model = await createVehicleModel('Isuzu', 'D-Max-PUT')
        const j = await job({ brand: 'Isuzu', modelText: 'DMax-พิมพ์เอง' })
        const r = await PUT(`/api/vehicles/${j.vehicleId}/model`, { vehicleModelId: model }, 'advisor')
        expect(r.status, JSON.stringify(r.body)).toBe(200)
        expect(r.body).toEqual({ vehicleId: j.vehicleId, vehicleModelId: model })
        expect(await audit(fx.shopA, 'vehicle_model_assigned', j.vehicleId)).toHaveLength(1)
        expect((await PUT(`/api/vehicles/${j.vehicleId}/model`, { vehicleModelId: model }, 'advisor')).status).toBe(200)
        expect((await PUT(`/api/vehicles/${j.vehicleId}/model`, { vehicleModelId: model }, 'technician')).status).toBe(403)
      })

      it('BUG?: PUT /vehicles/:id/model for a car that does not exist is 404 (and writes no audit row), not a silent 200', async () => {
        const model = await createVehicleModel('Isuzu', 'D-Max-PUT2')
        const ghost = randomUUID()
        const r = await PUT(`/api/vehicles/${ghost}/model`, { vehicleModelId: model }, 'advisor')
        expect(r.status, JSON.stringify(r.body)).toBe(404)
        expect(await audit(fx.shopA, 'vehicle_model_assigned', ghost)).toHaveLength(0)
      })

      it('BUG?: PUT /vehicles/:id/model with a model that does not exist is a 4xx with a body, not a 500', async () => {
        const j = await job()
        const r = await PUT(`/api/vehicles/${j.vehicleId}/model`, { vehicleModelId: randomUUID() }, 'advisor')
        expect(r.status, JSON.stringify(r.body)).toBeGreaterThanOrEqual(400)
        expect(r.status).toBeLessThan(500)
      })

      it('BUG?: intake matches a car to the controlled model when EXACTLY ONE row matches its brand+model (v3 §4.2)', async () => {
        await createVehicleModel('Nissan', 'Almera-อัตโนมัติ')
        const j = await job({ brand: 'nissan', modelText: 'Almera อัตโนมัติ' })
        const vm = await q(fx.shopA, async (trx) => (await sql<{ vehicle_model_id: string | null }>`select vehicle_model_id from vehicles where id = ${j.vehicleId}`.execute(trx)).rows[0]!)
        expect(vm.vehicle_model_id, 'services/intake.ts never calls findExactVehicleModel in caf18ed').not.toBeNull()
      })
    })

    // ======================================================================
    // Warranty terms
    // ======================================================================
    describe('warranty terms', () => {
      it('the same name in both shops is two items (uniqueness is per shop)', async () => {
        const a = await newItem('ชื่อเดียวกันสองร้าน', 'หมวดเดียวกัน')
        const b = await newItem('ชื่อเดียวกันสองร้าน', 'หมวดเดียวกัน', fx.shopB)
        expect(a).not.toBe(b)
      })

      it('lists the shop\'s active terms with days and km', async () => {
        const r = await GET('/api/warranty-terms', 'advisor')
        expect(r.status).toBe(200)
        expect(r.body.items).toEqual([{ id: seeds[fx.shopA]!.w90, name: 'รับประกัน 90 วัน', days: 90, maxKm: null }])
      })

      it('creating an item with a term carries it onto the item', async () => {
        const r = await POST('/api/catalog/items', { category: 'ประกัน', name: 'มีประกัน', warrantyTermId: seeds[fx.shopA]!.w90, confirmNotSimilar: true })
        expect(r.status, JSON.stringify(r.body)).toBe(201)
        expect(r.body.warranty).toEqual({ id: seeds[fx.shopA]!.w90, name: 'รับประกัน 90 วัน', days: 90, maxKm: null })
      })
    })

    // ======================================================================
    // AC4 — two shops, every catalog endpoint
    // ======================================================================
    describe('AC4: shop B cannot read, price, merge or link anything of shop A; a foreign id looks exactly like a missing one', () => {
      const asB = () => fx.shopB
      let aJob: { jobId: string; vehicleId: string }
      let aItem: string
      let aModelPriceId: string
      let aStrayVehicle: { jobId: string; vehicleId: string }
      let bJob: { jobId: string; vehicleId: string }
      let bItem: string

      async function counts(shop: string) {
        return q(shop, async (trx) => {
          const one = async (s: ReturnType<typeof sql>) => Number(((await s.execute(trx)).rows[0] as { n: string }).n)
          return {
            items: await one(sql`select count(*) n from catalog_items`),
            prices: await one(sql`select coalesce(sum(price),0) n from catalog_model_prices`),
            base: await one(sql`select coalesce(sum(base_price),0) n from catalog_items`),
            merged: await one(sql`select count(*) n from catalog_items where merged_into_id is not null`),
            models: await one(sql`select count(*) n from vehicle_models`),
            linked: await one(sql`select count(*) n from vehicles where vehicle_model_id is not null`),
            audit: await one(sql`select count(*) n from audit_logs`),
          }
        })
      }
      let before: Awaited<ReturnType<typeof counts>>

      beforeAll(async () => {
        aItem = await newItem('ของร้าน A เท่านั้น', 'หมวดA')
        aJob = await job()
        aStrayVehicle = await job({ brand: 'ยี่ห้อพิมพ์เองA', modelText: 'รุ่นพิมพ์เองA' })
        aModelPriceId = (await q(fx.shopA, async (trx) => (await sql<{ id: string }>`select id from catalog_model_prices where item_id = ${seeds[fx.shopA]!.modelPriced}`.execute(trx)).rows[0]!.id))
        bItem = await newItem('ของร้าน B เท่านั้น', 'หมวดB', fx.shopB)
        bJob = await job({ shop: fx.shopB })
        before = await counts(fx.shopA)
      })
      afterAll(async () => {
        // nothing B did may have moved a single thing in A
        expect(await counts(fx.shopA)).toEqual(before)
      })

      async function sameAsMissing(call: (id: string, other: string) => Promise<Res>, foreign: [string, string?], expectStatus?: number) {
        const f = await call(foreign[0], foreign[1] ?? randomUUID())
        const m = await call(randomUUID(), randomUUID())
        expect({ status: f.status, body: f.body }).toEqual({ status: m.status, body: m.body })
        if (expectStatus) expect(f.status, JSON.stringify(f.body)).toBe(expectStatus)
        else expect(f.status, JSON.stringify(f.body)).toBeGreaterThanOrEqual(400)
        return f
      }

      it('search with A\'s job id finds none of A\'s vehicle context (no model link, same as a missing job); B never sees A\'s items', async () => {
        const mine = (await search(bJob.jobId, 'ของร้าน', 'owner', asB())).body
        expect(mine.items.map((i) => i.name)).toEqual(['ของร้าน B เท่านั้น'])
        const foreign = await search(aJob.jobId, 'ของร้าน', 'owner', asB())
        const missing = await search(randomUUID(), 'ของร้าน', 'owner', asB())
        expect(foreign.status).toBe(missing.status)
        expect(foreign.body).toEqual(missing.body)
        expect(JSON.stringify(foreign.body)).not.toContain(aItem)
      })

      it('first price: A\'s job and/or A\'s item from shop B is refused exactly like missing ids, and writes nothing', async () => {
        await sameAsMissing((job2, item) => POST('/api/catalog/prices', { jobId: job2, itemId: item, price: '1.00' }, 'owner', asB()), [aJob.jobId, aItem], 404)
        await sameAsMissing((item) => POST('/api/catalog/prices', { jobId: bJob.jobId, itemId: item, price: '1.00' }, 'owner', asB()), [aItem], 404)
        await sameAsMissing((job2) => POST('/api/catalog/prices', { jobId: job2, itemId: bItem, price: '1.00' }, 'owner', asB()), [aJob.jobId], 404)
      })

      it('fix a price: A\'s price row / A\'s item id from shop B is a 404 identical to a missing id', async () => {
        await sameAsMissing((id) => PUT(`/api/catalog/prices/${id}`, { scope: 'model', price: '1.00', reason: 'ลอง' }, 'manager', asB()), [aModelPriceId], 404)
        await sameAsMissing((id) => PUT(`/api/catalog/prices/${id}`, { scope: 'base', price: '1.00', reason: 'ลอง' }, 'manager', asB()), [aItem], 404)
      })

      it('merge: A\'s item as source or as target from shop B is a 409 merge_not_allowed identical to a missing id', async () => {
        await sameAsMissing((id) => POST(`/api/catalog/items/${id}/merge`, { intoItemId: bItem }, 'manager', asB()), [aItem], 409)
        await sameAsMissing((id) => POST(`/api/catalog/items/${bItem}/merge`, { intoItemId: id }, 'manager', asB()), [aItem], 409)
      })

      it("link a car: A's car from shop B is a 404 like a missing car, and A's model cannot be attached to B's car (4xx, never 5xx)", async () => {
        const f = await PUT(`/api/vehicles/${aJob.vehicleId}/model`, { vehicleModelId: seeds[fx.shopB]!.vm }, 'advisor', asB())
        const m = await PUT(`/api/vehicles/${randomUUID()}/model`, { vehicleModelId: seeds[fx.shopB]!.vm }, 'advisor', asB())
        expect(m.status, 'a missing car').toBe(404)
        expect(f.status, JSON.stringify(f.body)).toBe(404)
        const x = await PUT(`/api/vehicles/${bJob.vehicleId}/model`, { vehicleModelId: seeds[fx.shopA]!.vm }, 'advisor', asB())
        expect(x.status, JSON.stringify(x.body)).toBeGreaterThanOrEqual(400)
        expect(x.status).toBeLessThan(500)
      })

      it('unmatched list + assign: B sees only its own cars; assigning A\'s group or A\'s model changes nothing in A', async () => {
        const mine = (await GET('/api/vehicle-models/unmatched?limit=100', 'manager', asB())).body
        expect(JSON.stringify(mine)).not.toContain('พิมพ์เองA')
        const none = await POST('/api/vehicle-models/unmatched/assign', { brandText: 'ยี่ห้อพิมพ์เองA', modelText: 'รุ่นพิมพ์เองA', vehicleModelId: seeds[fx.shopB]!.vm }, 'manager', asB())
        expect(none.status).toBe(200)
        expect(none.body.updated).toBe(0)
        const bad = await POST('/api/vehicle-models/unmatched/assign', { brandText: 'ยี่ห้อพิมพ์เองA', modelText: 'รุ่นพิมพ์เองA', vehicleModelId: seeds[fx.shopA]!.vm }, 'manager', asB())
        expect(bad.status, JSON.stringify(bad.body)).toBeLessThan(500)
        expect(aStrayVehicle.vehicleId).toBeTruthy()
      })

      it('lists never contain the other shop: vehicle models, warranty terms, similar names', async () => {
        const models = (await GET('/api/vehicle-models?limit=100', 'owner', asB())).body
        expect(models.items.map((m: { id: string }) => m.id)).not.toContain(seeds[fx.shopA]!.vm)
        expect(models.items.map((m: { id: string }) => m.id)).toContain(seeds[fx.shopB]!.vm)
        const terms = (await GET('/api/warranty-terms', 'owner', asB())).body
        expect(terms.items.map((t: { id: string }) => t.id)).toEqual([seeds[fx.shopB]!.w90])
        const similar = (await GET('/api/catalog/similar?category=' + encodeURIComponent('หมวดA') + '&name=' + encodeURIComponent('ของร้าน A เท่านั้น'), 'owner', asB())).body
        expect(similar.items).toEqual([])
      })

      it('BUG?: an item created in B with a warranty term of A is refused with a clean 4xx, identical to a missing term', async () => {
        const f = await POST('/api/catalog/items', { category: 'x', name: 'อ้างประกันร้านอื่น', warrantyTermId: seeds[fx.shopA]!.w90, confirmNotSimilar: true }, 'owner', asB())
        const m = await POST('/api/catalog/items', { category: 'x', name: 'อ้างประกันร้านอื่น', warrantyTermId: randomUUID(), confirmNotSimilar: true }, 'owner', asB())
        expect({ status: f.status, body: f.body }).toEqual({ status: m.status, body: m.body })
        expect(f.status, JSON.stringify(f.body)).toBeGreaterThanOrEqual(400)
        expect(f.status).toBeLessThan(500)
      })
    })
  },
)
