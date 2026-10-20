/**
 * P3.2 billing - the main path through the API, written by the author as a smoke
 * check. The separate test phase owns the full AC matrix (P3.2-REQUIREMENTS-DRAFT
 * s5/s10); this file only proves the transaction, the lock path and the contracts
 * run end to end. NOT RUN after the 20 Oct rework (B1 present step, B3 channels,
 * B4 line discounts): the lead asked for type-check only until gsms_test is reset.
 *
 * TIER 2: PostgreSQL with migrations through 0025, connection as gsms_app, and
 * DATABASE_ADMIN_URL for cleanup (numbered documents and append-only rows can
 * only be deleted with triggers off).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import pg from 'pg'
import { withShop } from '@gsms/db/client.js'
import { db } from '../lib/db.js'
import { adminDatabaseUrl, hasDatabase, tier2 } from '../test/env.js'
import {
  createTwoShopFixture, get, issueTokensFor, patch, post, put, startApi,
  type RunningApi, type TwoShopFixture,
} from '../test/fixtures.js'

type Role = Parameters<typeof issueTokensFor>[2]
/* eslint-disable @typescript-eslint/no-explicit-any */

describe.skipIf(!hasDatabase || !adminDatabaseUrl)(tier2('P3.2 billing API (needs DATABASE_ADMIN_URL)'), () => {
  let api: RunningApi
  let fx: TwoShopFixture
  const runTag = Math.floor(Math.random() * 9000) + 1000
  let plateSeq = 0

  beforeAll(async () => {
    api = await startApi({ intakeWriteLimit: 1_000_000 })
    fx = await createTwoShopFixture('p32b')
  })

  afterAll(async () => {
    if (fx) {
      const admin = new pg.Client({ connectionString: adminDatabaseUrl })
      await admin.connect()
      try {
        await admin.query('set session_replication_role = replica')
        const shops = [[fx.shopA, fx.shopB]]
        for (const t of [
          'document_prints', 'payment_reversals', 'payments', 'payment_channels', 'document_lines', 'documents',
          'job_status_history',
        ]) await admin.query(`delete from ${t} where shop_id = any($1)`, shops)
      } finally { await admin.end() }
    }
    await fx?.cleanup()
    await api?.close()
  })

  const tokens = new Map<string, string>()
  async function tok(role: Role, shop: string): Promise<string> {
    const k = `${shop}|${role}`
    let t = tokens.get(k)
    if (!t) { t = (await issueTokensFor(fx.userId, shop, role)).accessToken; tokens.set(k, t) }
    return t
  }
  const GET = async (p: string, role: Role = 'owner', shop = fx.shopA) => get<any>(api, p, await tok(role, shop))
  const POST = async (p: string, b: unknown = {}, role: Role = 'owner', shop = fx.shopA) => post<any>(api, p, b, await tok(role, shop))
  const PATCH = async (p: string, b: unknown = {}, role: Role = 'owner', shop = fx.shopA) => patch<any>(api, p, b, await tok(role, shop))
  const PUT = async (p: string, b: unknown = {}, role: Role = 'owner', shop = fx.shopA) => put<any>(api, p, b, await tok(role, shop))

  /** The shop's channels by name; the shop gets its cash channel on first read. */
  async function channels(shop = fx.shopA): Promise<{ cash: string; bank: string; card: string }> {
    const list = (await GET('/api/payment-channels', 'owner', shop)).body.items as any[]
    const cash = list.find((c) => c.kind === 'cash').id as string
    const mk = async (name: string, kind: string, surchargePercent: string) => {
      const r = await POST('/api/payment-channels', { name, kind, surchargePercent }, 'owner', shop)
      if (r.status === 201) return r.body.id as string
      return list.find((c) => c.name === name).id as string
    }
    return { cash, bank: await mk('ออมสิน', 'transfer', '0'), card: await mk('รูดบัตร', 'card', '3.00') }
  }

  /** A job at `ready` whose quotation (two lines, 3,000 + 2,000, discount `discount`) is confirmed. */
  async function readyJob(discount = '0', shop = fx.shopA): Promise<{ jobId: string }> {
    plateSeq++
    const ci = await POST('/api/checkin', { plate: `กข ${runTag}${plateSeq}`.slice(0, 12), customerName: 'ทดสอบ', brand: 'Toyota', model: 'Vios', province: 'กรุงเทพมหานคร' }, 'owner', shop)
    expect(ci.status, JSON.stringify(ci.body)).toBe(201)
    const jobId: string = ci.body.jobId
    await withShop(db, shop, async (trx) => {
      await trx.updateTable('jobs').set({ status: 'quoted' }).where('id', '=', jobId).execute()
    })
    const base = `/api/jobs/${jobId}/quotation`
    expect((await POST(base, {}, 'owner', shop)).status).toBe(201)
    for (const [name, price] of [['ลูกหมากปีกนกล่าง', '3000.00'], ['ค่าแรงตั้งศูนย์', '2000.00']] as const) {
      const r = await POST(`${base}/lines`, { kind: 'free', name, unitPrice: price, qty: '1', lineType: name.startsWith('ค่าแรง') ? 'labor' : 'part', addToCatalog: false }, 'owner', shop)
      expect(r.status, JSON.stringify(r.body)).toBe(201)
    }
    if (discount !== '0') expect((await PATCH(base, { discount }, 'owner', shop)).status).toBe(200)
    const over = Number(discount) > 2000
    const issued = await POST(`${base}/issue`, {}, 'owner', shop)
    expect(issued.status, JSON.stringify(issued.body)).toBe(200)
    for (const l of issued.body.lines) {
      expect((await PATCH(`${base}/lines/${l.id}/decision`, { decision: 'approved' }, 'owner', shop)).status).toBe(200)
    }
    const c = await POST(`${base}/confirm`, over ? { adjustments: { discount: { amount: discount, reason: 'ลูกค้าประจำ' } } } : {}, 'owner', shop)
    expect(c.status, JSON.stringify(c.body)).toBe(200)
    await withShop(db, shop, async (trx) => {
      await trx.updateTable('jobs').set({ status: 'ready' }).where('id', '=', jobId).execute()
    })
    return { jobId }
  }

  const allDone = (r: any) => ({ lines: r.lines.filter((l: any) => l.parentLineId === null).map((l: any) => ({ lineId: l.id, fulfilledQty: l.qty })) })
  const present = (jobId: string, role: Role = 'owner') => POST(`/api/jobs/${jobId}/receipt/present`, {}, role)

  it('draft -> tick -> present -> close with change -> frozen receipt; a retry replays', async () => {
    const ch = await channels()
    const { jobId } = await readyJob('500.00')
    const d = await POST(`/api/jobs/${jobId}/receipt`)
    expect(d.status, JSON.stringify(d.body)).toBe(201)
    expect(d.body.status).toBe('draft')
    expect(d.body.next.blockers).toContain('lines_unanswered')

    const early = await POST(`/api/jobs/${jobId}/receipt/close`, { payments: [{ channelId: ch.cash, amount: '4500' }] })
    expect(early.status).toBe(409)
    expect(early.body.error).toBe('fulfillment_incomplete')

    const t = await PUT(`/api/jobs/${jobId}/receipt/fulfillment`, allDone(d.body))
    expect(t.status, JSON.stringify(t.body)).toBe(200)
    expect(t.body.discount.state).toBe('carried')
    expect(t.body.totals.billTotal).toBe('4500.00')
    expect(t.body.totals.billTotal).toBe(t.body.totals.agreedTotal)

    // B1: ticks done, but the customer has not been shown the bill yet.
    const notShown = await POST(`/api/jobs/${jobId}/receipt/close`, { payments: [{ channelId: ch.cash, amount: '4500' }] })
    expect(notShown.status).toBe(409)
    expect(notShown.body.error).toBe('bill_not_presented')
    const pres = await present(jobId)
    expect(pres.status, JSON.stringify(pres.body)).toBe(200)
    expect(pres.body.presentation).toMatchObject({ billTotal: '4500.00', valid: true })

    const short = await POST(`/api/jobs/${jobId}/receipt/close`, { payments: [{ channelId: ch.cash, amount: '4000' }] })
    expect(short.status).toBe(409)
    expect(short.body).toMatchObject({ error: 'payment_short', short: '500.00' })

    const body = { payments: [{ channelId: ch.bank, amount: '3000' }, { channelId: ch.cash, amount: '2000' }] }
    const closed = await POST(`/api/jobs/${jobId}/receipt/close`, body)
    expect(closed.status, JSON.stringify(closed.body)).toBe(201)
    expect(closed.body.change).toBe('500.00')
    expect(closed.body.receipt.status).toBe('issued')
    expect(closed.body.receipt.number).toMatch(/^RC\d{2}\d{2}\d{2}\d{3}$/)
    const cash = closed.body.receipt.payments.find((p: any) => p.method === 'cash')
    expect(cash).toMatchObject({ amount: '2000.00', changeGiven: '500.00', net: '1500.00' })
    expect(closed.body.receipt.paidNet).toBe('4500.00')

    const again = await POST(`/api/jobs/${jobId}/receipt/close`, body)
    expect(again.status).toBe(200)
    expect(again.body.replayed).toBe(true)
    const other = await POST(`/api/jobs/${jobId}/receipt/close`, { payments: [{ channelId: ch.cash, amount: '4500' }] })
    expect(other.status).toBe(409)
    expect(other.body.error).toBe('already_billed')
    expect((await PUT(`/api/jobs/${jobId}/receipt/fulfillment`, allDone(d.body))).status).toBe(409)
  })

  it('a change after the bill was shown makes the presentation stale (B1)', async () => {
    const ch = await channels()
    const { jobId } = await readyJob()
    const d = await POST(`/api/jobs/${jobId}/receipt`)
    await PUT(`/api/jobs/${jobId}/receipt/fulfillment`, allDone(d.body))
    expect((await present(jobId)).status).toBe(200)
    const line = d.body.lines[0]
    const disc = await PUT(`/api/jobs/${jobId}/receipt/lines/${line.id}/discount`, { discount: '100', reason: 'ลูกค้าประจำ' })
    expect(disc.status, JSON.stringify(disc.body)).toBe(200)
    expect(disc.body.presentation.valid).toBe(false)
    expect(disc.body.next.blockers).toContain('presentation_stale')
    const stale = await POST(`/api/jobs/${jobId}/receipt/close`, { payments: [{ channelId: ch.cash, amount: '4900' }] })
    expect(stale.status).toBe(409)
    expect(stale.body.error).toBe('presentation_stale')
    await present(jobId)
    const ok = await POST(`/api/jobs/${jobId}/receipt/close`, { payments: [{ channelId: ch.cash, amount: '4900' }] })
    expect(ok.status, JSON.stringify(ok.body)).toBe(201)
    expect(ok.body.receipt.totals).toMatchObject({ lineDiscountTotal: '100.00', totalDiscount: '100.00', billTotal: '4900.00' })
  })

  it('a card channel adds its surcharge on top: recorded on the payment, not a discount', async () => {
    const ch = await channels()
    const { jobId } = await readyJob()
    const d = await POST(`/api/jobs/${jobId}/receipt`)
    await PUT(`/api/jobs/${jobId}/receipt/fulfillment`, allDone(d.body))
    await present(jobId)
    const r = await POST(`/api/jobs/${jobId}/receipt/close`, { payments: [{ channelId: ch.card, amount: '5000' }] })
    expect(r.status, JSON.stringify(r.body)).toBe(201)
    expect(r.body.surchargeTotal).toBe('150.00')
    expect(r.body.receipt.totals).toMatchObject({ billTotal: '5000.00', surchargeTotal: '150.00', totalPaid: '5150.00', totalDiscount: '0.00' })
    expect(r.body.receipt.payments[0]).toMatchObject({ amount: '5150.00', surchargeAmount: '150.00' })
  })

  it('the 40% ceiling counts line discounts + document discount, judged by the closer', async () => {
    const ch = await channels()
    const { jobId } = await readyJob('3000.00') // 60% of 5,000, carried
    const d = await POST(`/api/jobs/${jobId}/receipt`)
    await PUT(`/api/jobs/${jobId}/receipt/fulfillment`, allDone(d.body))
    await present(jobId)
    const pay = { payments: [{ channelId: ch.cash, amount: '2000' }] }
    const adv = await POST(`/api/jobs/${jobId}/receipt/close`, pay, 'advisor')
    expect(adv.status, JSON.stringify(adv.body)).toBe(403)
    expect(adv.body.error).toBe('discount_requires_manager')
    expect((await POST(`/api/jobs/${jobId}/receipt/close`, pay, 'manager')).status).toBe(400)
    const ok = await POST(`/api/jobs/${jobId}/receipt/close`, { ...pay, discountReason: 'ลูกค้าประจำ' }, 'manager')
    expect(ok.status, JSON.stringify(ok.body)).toBe(201)
    expect(ok.body.receipt.discount.exceedsCeiling).toBe(true)
  })

  it('a line not done: the agreed discount is not carried and must be typed', async () => {
    const ch = await channels()
    const { jobId } = await readyJob('500.00')
    const d = await POST(`/api/jobs/${jobId}/receipt`)
    const [a, b] = d.body.lines
    await PUT(`/api/jobs/${jobId}/receipt/fulfillment`, { lines: [{ lineId: a.id, fulfilledQty: a.qty }, { lineId: b.id, fulfilledQty: '0' }] })
    const r = await GET(`/api/jobs/${jobId}/receipt`)
    expect(r.body.discount.state).toBe('needs_entry')
    expect(r.body.next.blockers).toContain('discount_entry_required')
    expect((await present(jobId)).body.error).toBe('discount_entry_required')
    const blocked = await POST(`/api/jobs/${jobId}/receipt/close`, { payments: [{ channelId: ch.cash, amount: '3000' }] })
    expect(blocked.body.error).toBe('discount_entry_required')
  })

  it('void is owner only, reverses the money on the void day (surcharge included), keeps the number', async () => {
    const ch = await channels()
    const { jobId } = await readyJob()
    const d = await POST(`/api/jobs/${jobId}/receipt`)
    await PUT(`/api/jobs/${jobId}/receipt/fulfillment`, allDone(d.body))
    await present(jobId)
    const closed = await POST(`/api/jobs/${jobId}/receipt/close`, { payments: [{ channelId: ch.cash, amount: '5000' }] })
    expect(closed.status).toBe(201)
    expect((await POST(`/api/jobs/${jobId}/receipt/void`, { reason: 'ผิดช่องทาง' }, 'manager')).status).toBe(403)
    const v = await POST(`/api/jobs/${jobId}/receipt/void`, { reason: 'ผิดช่องทาง' })
    expect(v.status, JSON.stringify(v.body)).toBe(200)
    expect(v.body.status).toBe('void')
    expect(v.body.number).toBe(closed.body.receipt.number)
    const s = await GET('/api/daily-summary')
    expect(s.status, JSON.stringify(s.body)).toBe(200)
    expect(Number(s.body.moneyIn.byMethod.find((m: any) => m.method === 'cash').reversed)).toBeGreaterThanOrEqual(5000)
    // The two figures stay separate objects and are never summed into one.
    expect(s.body.sales).toBeDefined()
    expect(s.body.moneyIn).toBeDefined()
    expect(s.body.total).toBeUndefined()
  })

  it('channel settings: owner/manager only, deactivate never delete, not the last one', async () => {
    const ch = await channels()
    expect((await POST('/api/payment-channels', { name: 'x', kind: 'cash' }, 'advisor')).status).toBe(403)
    const renamed = await PATCH(`/api/payment-channels/${ch.bank}`, { name: 'กสิกร' }, 'manager')
    expect(renamed.status, JSON.stringify(renamed.body)).toBe(200)
    expect((await PATCH(`/api/payment-channels/${ch.bank}`, { isActive: false }, 'manager')).body.isActive).toBe(false)
    const list = await GET('/api/payment-channels?includeInactive=true')
    expect(list.body.items.some((c: any) => c.id === ch.bank && !c.isActive)).toBe(true)
    // Shop B cannot touch shop A's channel.
    expect((await PATCH(`/api/payment-channels/${ch.cash}`, { name: 'hack' }, 'owner', fx.shopB)).status).toBe(404)
  })

  it('print N counts per subject and the technician prints only the work order', async () => {
    const { jobId } = await readyJob()
    const p1 = await POST(`/api/jobs/${jobId}/prints`, { docType: 'work_order' }, 'technician')
    expect(p1.status, JSON.stringify(p1.body)).toBe(201)
    expect(p1.body.printNo).toBe(1)
    const p2 = await POST(`/api/jobs/${jobId}/prints`, { docType: 'work_order' })
    expect(p2.body.printNo).toBe(2)
    expect((await POST(`/api/jobs/${jobId}/prints`, { docType: 'receipt' }, 'technician')).status).toBe(403)
    const h = await GET(`/api/jobs/${jobId}/prints?docType=work_order`)
    expect(h.body.printCount).toBe(2)
    expect(h.body.contentChangedSinceLastPrint).toBe(false)
  })

  it('shop B cannot see shop A\'s receipt or prints', async () => {
    const { jobId } = await readyJob()
    await POST(`/api/jobs/${jobId}/receipt`)
    expect((await GET(`/api/jobs/${jobId}/receipt`, 'owner', fx.shopB)).status).toBe(404)
    expect((await POST(`/api/jobs/${jobId}/prints`, { docType: 'work_order' }, 'owner', fx.shopB)).status).toBe(404)
  })

  it('a deliver without a receipt is refused', async () => {
    const { jobId } = await readyJob()
    const r = await PATCH(`/api/jobs/${jobId}/status`, { to: 'delivered', fromStatus: 'ready' })
    expect(r.status, JSON.stringify(r.body)).toBe(409)
    expect(r.body.error).toBe('receipt_required')
  })
})
