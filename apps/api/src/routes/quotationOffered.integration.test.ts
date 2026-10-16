/**
 * Migration 0024 — documents.offered_discount (the discount on the OFFER, fixed at
 * issue) vs documents.discount (the AGREED discount: only confirm changes it,
 * undo restores it). Owner ruling "model A", 14 Oct 2026.
 *
 * TIER 2. Needs PostgreSQL with migrations 0001-0024 applied, the connection made
 * as gsms_app, and DATABASE_ADMIN_URL (cleanup of numbered documents needs
 * triggers off). The trigger-level cases (brief item 6) live in
 * lib/documentFreeze.integration.test.ts; the pure arithmetic (item 8) in
 * packages/domain/src/rules/quoteDiscount.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { sql } from 'kysely'
import pg from 'pg'
import { offeredFoots, toSatang } from '@champpower/domain'
import { DiscountExceedsApprovedError, DiscountRequiredError, type Quotation } from '@gsms/contracts/index.js'
import { withShop } from '@gsms/db/client.js'
import { db } from '../lib/db.js'
import { adminDatabaseUrl, hasDatabase, tier2 } from '../test/env.js'
import {
  createTwoShopFixture, issueTokensFor, patch, post, get, startApi,
  type ApiResponse, type RunningApi, type TwoShopFixture,
} from '../test/fixtures.js'

type Res<T = any> = ApiResponse<T> // eslint-disable-line @typescript-eslint/no-explicit-any

describe.skipIf(!hasDatabase || !adminDatabaseUrl)(
  tier2('offered discount vs agreed discount (migration 0024)'),
  () => {
    let api: RunningApi
    let fx: TwoShopFixture
    let setItem = ''
    let token = ''

    beforeAll(async () => {
      api = await startApi({ intakeWriteLimit: 1_000_000 })
      fx = await createTwoShopFixture('p31od')
      token = (await issueTokensFor(fx.userId, fx.shopA, 'owner')).accessToken
      await withShop(db, fx.shopA, async (trx) => {
        const item = async (name: string, isSet: boolean) => (await sql<{ id: string }>`
          insert into catalog_items (shop_id, category, name, line_type, base_price, is_set)
          values (${fx.shopA}, 'ชุดโปร', ${name}, 'part', ${isSet ? '6000.00' : null}, ${isSet}) returning id`.execute(trx)).rows[0]!.id
        setItem = await item('ชุดโปรทดสอบ', true)
        for (const [i, name] of ['ก', 'ข', 'ค'].entries()) {
          const cid = await item(`ชิ้น ${name}`, false)
          await sql`insert into catalog_set_components (shop_id, set_item_id, component_item_id, component_name, line_type, qty, sort_order)
            values (${fx.shopA}, ${setItem}, ${cid}, ${name}, 'part', '1', ${i})`.execute(trx)
        }
      })
    })

    afterAll(async () => {
      if (fx) {
        const admin = new pg.Client({ connectionString: adminDatabaseUrl })
        await admin.connect()
        try {
          await admin.query('set session_replication_role = replica')
          for (const t of ['vehicle_offered_items', 'document_lines', 'documents', 'catalog_set_components', 'catalog_items'])
            await admin.query(`delete from ${t} where shop_id = any($1)`, [[fx.shopA, fx.shopB]])
        } finally { await admin.end() }
      }
      await fx?.cleanup()
      await api?.close()
    })

    // ---- helpers ------------------------------------------------------------
    const GET = <T = any>(p: string) => get<T>(api, p, token) // eslint-disable-line @typescript-eslint/no-explicit-any
    const POST = <T = any>(p: string, b: unknown = {}) => post<T>(api, p, b, token) // eslint-disable-line @typescript-eslint/no-explicit-any
    const PATCH = <T = any>(p: string, b: unknown = {}) => patch<T>(api, p, b, token) // eslint-disable-line @typescript-eslint/no-explicit-any
    const base = (jobId: string) => `/api/jobs/${jobId}/quotation`
    let plateSeq = 0
    const runTag = Math.floor(Math.random() * 9000) + 1000

    async function quotedJob(): Promise<string> {
      plateSeq++
      const c = await POST<{ jobId: string }>('/api/checkin', {
        plate: `กข ${runTag}${plateSeq}`.slice(0, 12), customerName: 'ทดสอบ', brand: 'Toyota', model: 'Vios', province: 'กรุงเทพมหานคร',
      })
      expect(c.status, JSON.stringify(c.body)).toBe(201)
      const jobId = c.body.jobId
      const start = Date.now() - 60_000
      await withShop(db, fx.shopA, async (trx) => {
        await trx.updateTable('jobs').set({ status: 'quoted' }).where('id', '=', jobId).execute()
        await trx.insertInto('job_status_history').values(['inspecting', 'quoted'].map((status, i) => ({
          shop_id: fx.shopA, job_id: jobId, status, changed_at: new Date(start + i * 1000),
        }))).execute()
      })
      expect((await POST(base(jobId))).status).toBe(201)
      return jobId
    }
    const addFree = async (jobId: string, name: string, unitPrice: string) => {
      const r = await POST<Quotation>(`${base(jobId)}/lines`, { kind: 'free', name, unitPrice, qty: '1', lineType: 'part', addToCatalog: false })
      expect(r.status, JSON.stringify(r.body)).toBe(201)
    }
    const view = async (jobId: string) => (await GET<Quotation>(base(jobId))).body
    const byName = (v: Quotation, n: string) => v.lines.find((l) => l.name === n)!
    const decide = async (jobId: string, lineId: string, body: object) => {
      const r = await PATCH(`${base(jobId)}/lines/${lineId}/decision`, body)
      expect(r.status, JSON.stringify(r.body)).toBe(200)
    }
    const confirmRaw = (jobId: string, body: object = {}) => POST<any>(`${base(jobId)}/confirm`, body) // eslint-disable-line @typescript-eslint/no-explicit-any
    const confirm = async (jobId: string, body: object = {}) => {
      const r = await confirmRaw(jobId, body)
      expect(r.status, JSON.stringify(r.body)).toBe(200)
      return r.body as Quotation
    }
    const undoRaw = (jobId: string) => POST<any>(`${base(jobId)}/confirm/undo`, { reason: 'ลูกค้าแก้' }) // eslint-disable-line @typescript-eslint/no-explicit-any
    const undo = async (jobId: string) => {
      const r = await undoRaw(jobId)
      expect(r.status, JSON.stringify(r.body)).toBe(200)
      return r.body as Quotation
    }
    const docRows = async (jobId: string) => withShop(db, fx.shopA, async (trx) => (await sql<{
      id: string; status: string; revision: number; discount: string; offered_discount: string
      offered_total: string; approved_total: string; subtotal: string
    }>`select d.id, d.status, d.revision, d.discount, d.offered_discount, d.offered_total, d.approved_total,
              coalesce((select sum(l.line_total) from document_lines l where l.document_id = d.id and l.parent_line_id is null), 0)::text as subtotal
         from documents d where d.job_id = ${jobId} and d.type = 'quotation' order by d.revision`.execute(trx)).rows)
    const audit = async (action: string, entityId: string) => withShop(db, fx.shopA, (trx) =>
      trx.selectFrom('audit_logs').select(['before', 'after']).where('action', '=', action).where('entity_id', '=', entityId).execute())

    /** Two plain lines (3000 + 2000), an offered discount, issued, both approved. */
    async function issuedApproved(offered = '200') {
      const jobId = await quotedJob()
      await addFree(jobId, 'ลูกหมาก', '3000.00')
      await addFree(jobId, 'ยาง', '2000.00')
      expect((await PATCH(base(jobId), { discount: offered })).status).toBe(200)
      expect((await POST(`${base(jobId)}/issue`)).status).toBe(200)
      const v = await view(jobId)
      await decide(jobId, byName(v, 'ลูกหมาก').id, { decision: 'approved' })
      await decide(jobId, byName(v, 'ยาง').id, { decision: 'approved' })
      return { jobId, v }
    }
    /** An issued quotation holding one set with piece 1 declined and the set approved. */
    async function cutSet() {
      const jobId = await quotedJob()
      const add = await POST<Quotation>(`${base(jobId)}/lines`, { kind: 'set', itemId: setItem })
      expect(add.status, JSON.stringify(add.body)).toBe(201)
      expect((await POST(`${base(jobId)}/issue`)).status).toBe(200)
      const v = await view(jobId)
      const parent = v.lines.find((l) => l.parentLineId === null)!
      const child = v.lines.find((l) => l.parentLineId === parent.id)!
      await decide(jobId, child.id, { decision: 'declined', reason: 'not_needed_yet' })
      await decide(jobId, parent.id, { decision: 'approved' })
      return { jobId, parentId: parent.id }
    }
    const cutBody = (parentId: string, amount = '5200.00') =>
      ({ adjustments: { setLines: [{ lineId: parentId, approvedAmount: amount, reason: 'ตัดออก 1 รายการ' }] } })

    // ---- 1 ------------------------------------------------------------------
    it('1. issue 200, confirm 300 with a reason, undo: discount 200.00, approved_total = subtotal - 200, offered_total untouched', async () => {
      const { jobId } = await issuedApproved('200')
      const issued = (await docRows(jobId))[0]!
      expect(issued).toMatchObject({ discount: '200.00', offered_discount: '200.00', offered_total: '4800.00', approved_total: '4800.00' })

      const c = await confirm(jobId, { adjustments: { discount: { amount: '300', reason: 'ลูกค้าประจำ' } } })
      expect(c.totals).toMatchObject({ discount: '300.00', offeredDiscount: '200.00', offeredTotal: '4800.00', approvedTotal: '4700.00' })

      const u = await undo(jobId)
      expect(u.status).toBe('issued')
      expect(u.totals).toMatchObject({ discount: '200.00', offeredDiscount: '200.00', offeredTotal: '4800.00', approvedTotal: '4800.00' })
      const row = (await docRows(jobId))[0]!
      expect(row).toMatchObject({ status: 'issued', discount: '200.00', offered_discount: '200.00', offered_total: '4800.00', approved_total: '4800.00' })
      // the undo audit says what moved
      const a = await audit('quotation_confirm_undone', row.id)
      expect(a).toHaveLength(1)
      expect(a[0]!.before).toMatchObject({ discount: '300.00', approvedTotal: '4700.00' })
      expect(a[0]!.after).toMatchObject({ discount: '200.00', approvedTotal: '4800.00' })
    })

    // ---- 2 ------------------------------------------------------------------
    it('2. after undo, a new decision recomputes approved_total with 200, not 300', async () => {
      const { jobId, v } = await issuedApproved('200')
      await confirm(jobId, { adjustments: { discount: { amount: '300', reason: 'ลูกค้าประจำ' } } })
      await undo(jobId)
      await decide(jobId, byName(v, 'ยาง').id, { decision: 'declined', reason: 'too_expensive' })
      const row = (await docRows(jobId))[0]!
      expect(row.approved_total).toBe('2800.00') // 3000 - 200
      expect(row.discount).toBe('200.00')
    })

    // ---- 3 ------------------------------------------------------------------
    it('3. confirm with a set approved_amount, undo: approved_amount NULL, and the next confirm needs it again', async () => {
      const { jobId, parentId } = await cutSet()
      await confirm(jobId, cutBody(parentId))
      expect(byName(await view(jobId), 'ชุดโปรทดสอบ').approvedAmount).toBe('5200.00')
      await undo(jobId)
      expect(byName(await view(jobId), 'ชุดโปรทดสอบ').approvedAmount).toBeNull()
      const again = await confirmRaw(jobId)
      expect(again.status, JSON.stringify(again.body)).toBe(409)
      expect(again.body).toMatchObject({ error: 'set_amount_required', lineIds: [parentId] })
    })

    // ---- 4 ------------------------------------------------------------------
    it('4. confirm with no adjustment, undo: the money is exactly as before confirm', async () => {
      const { jobId } = await issuedApproved('200')
      const before = (await docRows(jobId))[0]!
      await confirm(jobId)
      await undo(jobId)
      const after = (await docRows(jobId))[0]!
      expect(after).toMatchObject({
        discount: before.discount, offered_discount: before.offered_discount,
        offered_total: before.offered_total, approved_total: before.approved_total,
      })
    })

    // ---- 5 ------------------------------------------------------------------
    it('5a. offered 150, confirm 200, revise from SIGNED: rev 2 starts from 200 and the audit has both values', async () => {
      const { jobId } = await issuedApproved('150')
      await confirm(jobId, { adjustments: { discount: { amount: '200', reason: 'ลูกค้าประจำ' } } })
      const r = await POST<Quotation>(`${base(jobId)}/revise`, { reason: 'เพิ่มรายการ' })
      expect(r.status, JSON.stringify(r.body)).toBe(201)
      const [rev1, rev2] = await docRows(jobId)
      expect(rev1).toMatchObject({ status: 'superseded', discount: '200.00', offered_discount: '150.00' })
      expect(rev2).toMatchObject({ revision: 2, status: 'draft', discount: '200.00', offered_discount: '200.00' })
      const a = await audit('quotation_revised', rev2!.id)
      expect(a).toHaveLength(1)
      expect(a[0]!.after).toMatchObject({ revision: 2, offeredDiscount: '150.00', carriedDiscount: '200.00' })
    })

    it('5b. revise from ISSUED: rev 2 starts from the offered discount (agreed = offered on an issued document)', async () => {
      const { jobId } = await issuedApproved('150')
      const r = await POST<Quotation>(`${base(jobId)}/revise`, {})
      expect(r.status, JSON.stringify(r.body)).toBe(201)
      const [, rev2] = await docRows(jobId)
      expect(rev2).toMatchObject({ revision: 2, discount: '150.00', offered_discount: '150.00' })
      const a = await audit('quotation_revised', rev2!.id)
      expect(a[0]!.after).toMatchObject({ offeredDiscount: '150.00', carriedDiscount: '150.00' })
    })

    it('5c. rev 2 issued: its offered_discount is stored and the new offer foots', async () => {
      const { jobId } = await issuedApproved('150')
      await confirm(jobId, { adjustments: { discount: { amount: '200', reason: 'ลูกค้าประจำ' } } })
      await POST(`${base(jobId)}/revise`, {})
      expect((await POST(`${base(jobId)}/issue`)).status).toBe(200)
      const rev2 = (await docRows(jobId))[1]!
      expect(rev2).toMatchObject({ status: 'issued', discount: '200.00', offered_discount: '200.00', offered_total: '4800.00' })
    })

    // ---- 7 ------------------------------------------------------------------
    it('7. offered_subtotal - offered_discount = offered_total in every status (draft, issued, signed, undone, superseded, void)', async () => {
      const foots = async (jobId: string) => {
        for (const r of await docRows(jobId)) {
          if (r.status === 'draft') continue // a draft has no offered_total yet; the view computes it
          expect(offeredFoots(r.subtotal, r.offered_discount, r.offered_total), `${r.status} rev ${r.revision}`).toBe(true)
        }
      }
      const viewFoots = (v: Quotation) =>
        expect(offeredFoots(v.totals.offeredSubtotal, v.totals.offeredDiscount, v.totals.offeredTotal), `view ${v.status}`).toBe(true)

      const { jobId } = await issuedApproved('150')
      await foots(jobId); viewFoots(await view(jobId))                       // issued
      await confirm(jobId, { adjustments: { discount: { amount: '999', reason: 'ลูกค้าประจำ' } } })
      await foots(jobId); viewFoots(await view(jobId))                       // signed, agreed != offered
      await undo(jobId)
      await foots(jobId); viewFoots(await view(jobId))                       // undone
      await POST(`${base(jobId)}/revise`, {})
      viewFoots(await view(jobId))                                            // rev 2 draft (computed)
      await foots(jobId)                                                      // rev 1 superseded
      // void: a second job, owner-only endpoint
      const other = await issuedApproved('50')
      expect((await POST(`${base(other.jobId)}/void`, { reason: 'ทดสอบ' })).status).toBe(200)
      await foots(other.jobId)                                                // void
      // an entered discount larger than the subtotal is stored clamped, so it still foots
      const big = await quotedJob()
      await addFree(big, 'ลูกหมาก', '300.00')
      await PATCH(base(big), { discount: '500' })
      await POST(`${base(big)}/issue`)
      expect((await docRows(big))[0]).toMatchObject({ offered_discount: '300.00', discount: '300.00', offered_total: '0.00' })
      await foots(big)
    })

    // ---- 9 ------------------------------------------------------------------
    it('9a. two undos at once: one wins, the other is 409 quotation_not_confirmed', async () => {
      const { jobId } = await issuedApproved('200')
      await confirm(jobId, { adjustments: { discount: { amount: '300', reason: 'ลูกค้าประจำ' } } })
      const rs = await Promise.all([undoRaw(jobId), undoRaw(jobId)])
      expect(rs.map((r) => r.status).sort()).toEqual([200, 409])
      expect(rs.find((r) => r.status === 409)!.body.error).toBe('quotation_not_confirmed')
      expect((await docRows(jobId))[0]).toMatchObject({ status: 'issued', discount: '200.00', approved_total: '4800.00' })
    })

    it('9b. confirm and undo at once on a signed quotation: whichever order, the row ends consistent', async () => {
      const { jobId } = await issuedApproved('200')
      await confirm(jobId, { adjustments: { discount: { amount: '300', reason: 'ลูกค้าประจำ' } } })
      // body for the second confirm: same adjustment again (it is only reachable if undo goes first)
      const [c, u]: [Res, Res] = await Promise.all([
        confirmRaw(jobId, { adjustments: { discount: { amount: '300', reason: 'ลูกค้าประจำ' } } }),
        undoRaw(jobId),
      ])
      const row = (await docRows(jobId))[0]!
      expect(u.status, JSON.stringify(u.body)).toBe(200)
      if (c.status === 409) {
        // confirm ran first, saw `signed`, and was refused; undo then won
        expect(c.body.error).toBe('quotation_not_issued')
        expect(row).toMatchObject({ status: 'issued', discount: '200.00', approved_total: '4800.00' })
      } else {
        // undo ran first, the confirm then re-confirmed
        expect(c.status).toBe(200)
        expect(row).toMatchObject({ status: 'signed', discount: '300.00', approved_total: '4700.00' })
      }
      expect(row.offered_discount).toBe('200.00')
    })

    it('9c. two confirms at once: one wins, the other is 409 quotation_not_issued', async () => {
      const { jobId } = await issuedApproved('200')
      const rs = await Promise.all([confirmRaw(jobId), confirmRaw(jobId)])
      expect(rs.map((r) => r.status).sort()).toEqual([200, 409])
      expect(rs.find((r) => r.status === 409)!.body.error).toBe('quotation_not_issued')
    })

    // ---- lead rulings of 15 Oct ---------------------------------------------
    it('A. undo restores a CARRIED non-null prior (rev 1 amount 5200 carried to rev 2, rev 2 confirmed at 5100, undo -> 5200)', async () => {
      const { jobId, parentId } = await cutSet()
      await confirm(jobId, cutBody(parentId, '5200.00'))
      expect((await POST<Quotation>(`${base(jobId)}/revise`, { reason: 'ต่อ' })).status).toBe(201)
      expect((await POST(`${base(jobId)}/issue`)).status).toBe(200)
      const rev2 = await view(jobId)
      const head2 = rev2.lines.find((l) => l.parentLineId === null)!
      expect(head2.approvedAmount).toBe('5200.00') // carried
      await confirm(jobId, cutBody(head2.id, '5100.00'))
      expect(byName(await view(jobId), 'ชุดโปรทดสอบ').approvedAmount).toBe('5100.00')
      await undo(jobId)
      const back = await view(jobId)
      expect(byName(back, 'ชุดโปรทดสอบ').approvedAmount).toBe('5200.00')
      expect(back.totals.approvedTotal).toBe('5200.00')
      expect(back.totals.discount).toBe('0.00')
    })

    it('B. legacy confirm (audit before has no setLines): undo clears the amounts and the totals foot', async () => {
      const { jobId, parentId } = await cutSet()
      await confirm(jobId, cutBody(parentId, '5200.00'))
      const docId = (await docRows(jobId))[0]!.id
      // Recreate the old audit shape: after.setLines present, before.setLines absent.
      const admin = new pg.Client({ connectionString: adminDatabaseUrl })
      await admin.connect()
      try {
        await admin.query('set session_replication_role = replica')
        const r = await admin.query(
          `update audit_logs set before = before - 'setLines' where action = 'quotation_confirmed' and entity_id = $1`, [docId])
        expect(r.rowCount).toBe(1)
      } finally { await admin.end() }
      await undo(jobId)
      const v = await view(jobId)
      expect(byName(v, 'ชุดโปรทดสอบ').approvedAmount).toBeNull()
      expect(toSatang(v.totals.approvedSubtotal) - toSatang(v.totals.approvedDiscount)).toBe(toSatang(v.totals.approvedTotal))
      expect(v.totals.approvedTotal).toBe('6000.00')
      const again = await confirmRaw(jobId)
      expect(again.body).toMatchObject({ error: 'set_amount_required' })
    })

    it('C. a typed discount above the approved subtotal is REFUSED (400 discount_exceeds_approved), nothing written; equal to it is allowed', async () => {
      const { jobId } = await issuedApproved('200')
      const r = await confirmRaw(jobId, { adjustments: { discount: { amount: '99999', reason: 'ทดสอบ' } } })
      expect(r.status, JSON.stringify(r.body)).toBe(400)
      expect(r.body).toMatchObject({ error: 'discount_exceeds_approved', max: '5000.00', fields: { 'adjustments.discount.amount': ['exceeds_approved'] } })
      expect(DiscountExceedsApprovedError.safeParse(r.body).success).toBe(true)
      expect((await docRows(jobId))[0]).toMatchObject({ status: 'issued', discount: '200.00', offered_discount: '200.00' })
      expect(await audit('quotation_confirmed', (await docRows(jobId))[0]!.id)).toHaveLength(0)
      const c = await confirm(jobId, { adjustments: { discount: { amount: '5000', reason: 'ทดสอบ' } } })
      expect(c.totals).toMatchObject({ discount: '5000.00', approvedTotal: '0.00', offeredDiscount: '200.00' })
      // an unclamped confirm records no enteredDiscount
      const ok = await issuedApproved('200')
      await confirm(ok.jobId, { adjustments: { discount: { amount: '300', reason: 'ลูกค้าประจำ' } } })
      const okRow = (await docRows(ok.jobId))[0]!
      expect((await audit('quotation_confirmed', okRow.id))[0]!.after).not.toHaveProperty('enteredDiscount')
      // issue: a discount above the offered subtotal is stored clamped and the issue audit says what was typed
      const big = await quotedJob()
      await addFree(big, 'ลูกหมาก', '300.00')
      await PATCH(base(big), { discount: '500' })
      await POST(`${base(big)}/issue`)
      const bigRow = (await docRows(big))[0]!
      const ia = await audit('quotation_issued', bigRow.id)
      expect(ia[0]!.after).toMatchObject({ offeredDiscount: '300.00' })
      expect(Number((ia[0]!.after as Record<string, string>).enteredDiscount)).toBe(500)
    })

    // ---- DECISION-2026-10-15 §1: no silent carry ------------------------------
    /** Offer 2,000 (1,900 + 100) with discount 200; the customer approves only the 100 line. */
    async function approveOnlyHundred() {
      const jobId = await quotedJob()
      await addFree(jobId, 'ลูกหมาก', '1900.00')
      await addFree(jobId, 'ยาง', '100.00')
      expect((await PATCH(base(jobId), { discount: '200' })).status).toBe(200)
      expect((await POST(`${base(jobId)}/issue`)).status).toBe(200)
      const v = await view(jobId)
      await decide(jobId, byName(v, 'ลูกหมาก').id, { decision: 'declined', reason: 'too_expensive' })
      await decide(jobId, byName(v, 'ยาง').id, { decision: 'approved' })
      return jobId
    }

    it('D1. pass criterion: offer 2,000 discount 200, approve 100, confirm WITHOUT a discount -> 400 discount_required, nothing written', async () => {
      const jobId = await approveOnlyHundred()
      const r = await confirmRaw(jobId)
      expect(r.status, JSON.stringify(r.body)).toBe(400)
      expect(r.body).toMatchObject({ error: 'discount_required', fields: { 'adjustments.discount.amount': ['required'] } })
      expect(DiscountRequiredError.safeParse(r.body).success).toBe(true)
      expect((await docRows(jobId))[0]).toMatchObject({ status: 'issued', discount: '200.00', offered_discount: '200.00' })
      // with an explicit new discount it confirms (and the old 200 is not what is stored)
      const ok = await confirm(jobId, { adjustments: { discount: { amount: '10', reason: 'ลดตามยอดที่เหลือ' } } })
      expect(ok.totals).toMatchObject({ discount: '10.00', offeredDiscount: '200.00', approvedTotal: '90.00' })
    })

    it('D2. approved == offered with a discount: no new discount needed', async () => {
      const { jobId } = await issuedApproved('200')
      const r = await confirmRaw(jobId)
      expect(r.status, JSON.stringify(r.body)).toBe(200)
      expect(r.body.totals).toMatchObject({ discount: '200.00', approvedTotal: '4800.00' })
    })

    it('D3. discount 0: not needed even when lines were declined', async () => {
      const jobId = await quotedJob()
      await addFree(jobId, 'ลูกหมาก', '1900.00')
      await addFree(jobId, 'ยาง', '100.00')
      expect((await POST(`${base(jobId)}/issue`)).status).toBe(200)
      const v = await view(jobId)
      await decide(jobId, byName(v, 'ลูกหมาก').id, { decision: 'declined', reason: 'too_expensive' })
      await decide(jobId, byName(v, 'ยาง').id, { decision: 'approved' })
      const r = await confirmRaw(jobId)
      expect(r.status, JSON.stringify(r.body)).toBe(200)
      expect(r.body.totals).toMatchObject({ discount: '0.00', approvedTotal: '100.00' })
    })

    it('D4. a cut set whose agreed amount is lower, with a discount, also needs a new discount (judged on this request\'s amounts)', async () => {
      const jobId = await quotedJob()
      expect((await POST<Quotation>(`${base(jobId)}/lines`, { kind: 'set', itemId: setItem })).status).toBe(201)
      expect((await PATCH(base(jobId), { discount: '100' })).status).toBe(200)
      expect((await POST(`${base(jobId)}/issue`)).status).toBe(200)
      const v = await view(jobId)
      const parent = v.lines.find((l) => l.parentLineId === null)!
      await decide(jobId, v.lines.find((l) => l.parentLineId === parent.id)!.id, { decision: 'declined', reason: 'not_needed_yet' })
      await decide(jobId, parent.id, { decision: 'approved' })
      const refused = await confirmRaw(jobId, cutBody(parent.id, '5200.00'))
      expect(refused.status, JSON.stringify(refused.body)).toBe(400)
      expect(refused.body.error).toBe('discount_required')
      expect((await docRows(jobId))[0]!.status).toBe('issued')
      const ok = await confirmRaw(jobId, { adjustments: { ...cutBody(parent.id, '5200.00').adjustments, discount: { amount: '50', reason: 'ตัดชิ้นออก' } } })
      expect(ok.status, JSON.stringify(ok.body)).toBe(200)
      expect(ok.body.totals).toMatchObject({ discount: '50.00', approvedTotal: '5150.00' })
    })

    it('D5. undo after a new discount still restores the OFFERED discount (200)', async () => {
      const jobId = await approveOnlyHundred()
      await confirm(jobId, { adjustments: { discount: { amount: '10', reason: 'ลดตามยอดที่เหลือ' } } })
      await undo(jobId)
      expect((await docRows(jobId))[0]).toMatchObject({ status: 'issued', discount: '200.00', offered_discount: '200.00' })
    })

    // ---- fix round (code / security review) ------------------------------------
    /** A set quote (6000) with an offered discount, one piece declined, the set approved. */
    async function cutSetWithDiscount(offered = '100') {
      const jobId = await quotedJob()
      expect((await POST<Quotation>(`${base(jobId)}/lines`, { kind: 'set', itemId: setItem })).status).toBe(201)
      expect((await PATCH(base(jobId), { discount: offered })).status).toBe(200)
      expect((await POST(`${base(jobId)}/issue`)).status).toBe(200)
      const v = await view(jobId)
      const parent = v.lines.find((l) => l.parentLineId === null)!
      await decide(jobId, v.lines.find((l) => l.parentLineId === parent.id)!.id, { decision: 'declined', reason: 'not_needed_yet' })
      await decide(jobId, parent.id, { decision: 'approved' })
      return { jobId, parentId: parent.id }
    }

    it('F1. confirm with setLines AND a new discount, then undo: both are restored (amount NULL, discount back to the offered 100)', async () => {
      const { jobId, parentId } = await cutSetWithDiscount('100')
      const c = await confirm(jobId, { adjustments: { ...cutBody(parentId, '5200.00').adjustments, discount: { amount: '50', reason: 'ตัดชิ้นออก' } } })
      expect(c.totals).toMatchObject({ discount: '50.00', approvedTotal: '5150.00' })
      const u = await undo(jobId)
      expect(byName(u, 'ชุดโปรทดสอบ').approvedAmount).toBeNull()
      expect(u.totals).toMatchObject({ discount: '100.00', offeredDiscount: '100.00', approvedTotal: '5900.00' })
      expect((await docRows(jobId))[0]).toMatchObject({ status: 'issued', discount: '100.00', offered_discount: '100.00', approved_total: '5900.00' })
    })

    it('F2. every line declined with an existing discount: the §1 rule applies (pinned) — 400 without a discount, 200 with 0', async () => {
      const jobId = await quotedJob()
      await addFree(jobId, 'ลูกหมาก', '1900.00')
      await addFree(jobId, 'ยาง', '100.00')
      expect((await PATCH(base(jobId), { discount: '200' })).status).toBe(200)
      expect((await POST(`${base(jobId)}/issue`)).status).toBe(200)
      const v = await view(jobId)
      await decide(jobId, byName(v, 'ลูกหมาก').id, { decision: 'declined', reason: 'too_expensive' })
      await decide(jobId, byName(v, 'ยาง').id, { decision: 'declined', reason: 'too_expensive' })
      const r = await confirmRaw(jobId)
      expect(r.status, JSON.stringify(r.body)).toBe(400)
      expect(r.body.error).toBe('discount_required')
      const zero = await confirmRaw(jobId, { adjustments: { discount: { amount: '0', reason: 'ไม่ทำเลย' } } })
      expect(zero.status, JSON.stringify(zero.body)).toBe(200)
      expect(zero.body.totals).toMatchObject({ discount: '0.00', approvedTotal: '0.00' })
    })

    it('F3. undo reads ITS OWN confirm row (signedAt = documents.signed_at), not merely the newest audit row', async () => {
      const { jobId, parentId } = await cutSet()
      await confirm(jobId, cutBody(parentId, '5200.00'))
      const row = (await docRows(jobId))[0]!
      // A newer, well-formed confirm row that belongs to some other signedAt, claiming a prior of 999.
      const admin = new pg.Client({ connectionString: adminDatabaseUrl })
      await admin.connect()
      try {
        await admin.query('set session_replication_role = replica')
        await admin.query(
          `insert into audit_logs (shop_id, actor_id, action, entity_type, entity_id, before, after, at)
           values ($1, $2, 'quotation_confirmed', 'documents', $3, $4::jsonb, $5::jsonb, now() + interval '1 minute')`,
          [fx.shopA, fx.userId, row.id,
            JSON.stringify({ discount: '0.00', offeredDiscount: '0.00', setLines: [{ lineId: parentId, approvedAmount: '999.00' }] }),
            JSON.stringify({ approvedTotal: '1.00', discount: '0.00', setLines: [{ lineId: parentId, approvedAmount: '1.00', reason: 'x' }], jobAdvancedFrom: null, signedAt: '2020-01-01T00:00:00.000Z' })])
      } finally { await admin.end() }
      await undo(jobId)
      expect(byName(await view(jobId), 'ชุดโปรทดสอบ').approvedAmount).toBeNull() // from OUR row (prior null), not 999
    })

    it('F4. shop B calling undo on shop A\'s confirmed quotation gets 404 and nothing changes', async () => {
      const { jobId } = await issuedApproved('200')
      await confirm(jobId)
      const tokenB = (await issueTokensFor(fx.userId, fx.shopB, 'owner')).accessToken
      const r = await post<any>(api, `${base(jobId)}/confirm/undo`, { reason: 'ลองข้ามร้าน' }, tokenB) // eslint-disable-line @typescript-eslint/no-explicit-any
      expect(r.status, JSON.stringify(r.body)).toBe(404)
      expect((await docRows(jobId))[0]!.status).toBe('signed')
    })

    it('isolation: an unrelated id is not found', async () => {
      expect((await GET(base(randomUUID()))).status).toBe(404)
    })
  },
)
