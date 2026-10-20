/**
 * The daily summary and the cash count.
 *
 * TWO FIGURES, NEVER MERGED (CLAUDE.md s5.4 rule 9). "เงินเข้า" is built from
 * payments by the day the money was RECEIVED (less change, less refunds dated that
 * day); "ยอดขาย" from receipts by the day the BILL WAS CLOSED. They come from
 * different tables and different queries on purpose, and nothing here adds one to
 * the other. A deposit taken on the 3rd and billed on the 8th is correct in both:
 * the 3rd shows money in and no sale, the 8th shows the sale.
 */
import {
  CASH_COUNT_ROLES, bangkokDayKey, cashVariance, countNeedsNote, discountPercentText, formatSatang,
  sumSatang, toSatang,
} from '@champpower/domain'
import type { CashClosing, DailySummary } from '@gsms/contracts/index.js'
import type { ScopedTx } from '@gsms/db/client.js'
import { bangkokToday, endOfDayExclusive, startOfDay } from '../lib/bangkokDate.js'
import * as repo from '../repositories/daily.js'
import { writeAudit } from './audit.js'

const METHODS = ['cash', 'transfer', 'card'] as const

const closingOut = (r: repo.ClosingRow): CashClosing => ({
  id: r.id, businessDate: r.business_date, revision: r.revision, expectedCash: r.expected_cash,
  countedCash: r.counted_cash, variance: r.variance ?? '0.00', note: r.note, recountReason: r.recount_reason,
  closedByName: r.closed_by_name, closedAt: r.closed_at.toISOString(),
})

/** Cash net of change and of cash refunds dated the day: what the drawer should hold. Satang. */
async function expectedCashSatang(trx: ScopedTx, start: Date, end: Date): Promise<number> {
  const [pay, rev] = await Promise.all([repo.paymentSumsByMethod(trx, start, end), repo.reversalSumsByMethod(trx, start, end)])
  const c = pay.find((p) => p.method === 'cash')
  const r = rev.find((p) => p.method === 'cash')
  return toSatang(c?.received ?? '0') - toSatang(c?.change ?? '0') - toSatang(r?.amount ?? '0')
}

export async function dailySummary(trx: ScopedTx, date: string | undefined, role: string): Promise<DailySummary> {
  const day = date ?? bangkokToday()
  const start = startOfDay(day)
  const end = endOfDayExclusive(day)

  const [pay, rev, issued, voidedToday, claims, closings] = await Promise.all([
    repo.paymentSumsByMethod(trx, start, end),
    repo.reversalSumsByMethod(trx, start, end),
    repo.receiptsIssuedBetween(trx, start, end),
    repo.receiptsVoidedBetween(trx, start, end),
    repo.warrantyClaimsDeliveredBetween(trx, start, end),
    repo.closingsOfDate(trx, day),
  ])

  // ---- เงินเข้า ----
  const byMethod = METHODS.map((m) => {
    const p = pay.find((x) => x.method === m)
    const r = rev.find((x) => x.method === m)
    const received = toSatang(p?.received ?? '0')
    const change = toSatang(p?.change ?? '0')
    const reversed = toSatang(r?.amount ?? '0')
    return { method: m, received, change, reversed, net: received - change - reversed }
  })
  const moneyIn = {
    label: `เงินเข้าวันที่ ${day} (ตามวันที่รับเงิน · เขตเวลา Asia/Bangkok) · หักเงินทอนและเงินคืนที่ยกเลิกใบเสร็จในวันนี้`,
    paymentCount: pay.reduce((a, p) => a + p.rows, 0),
    reversalCount: rev.reduce((a, p) => a + p.rows, 0),
    byMethod: byMethod.map((b) => ({
      method: b.method, received: formatSatang(b.received), changeGiven: formatSatang(b.change),
      reversed: formatSatang(b.reversed), net: formatSatang(b.net),
    })),
    total: formatSatang(sumSatang(byMethod.map((b) => b.net))),
    changeCount: pay.reduce((a, p) => a + p.change_rows, 0),
    changeTotal: formatSatang(sumSatang(byMethod.map((b) => b.change))),
  }

  // ---- ยอดขาย ---- (receipts numbered today and still standing; voided ones are shown apart)
  const standing = issued.filter((r) => r.status === 'issued')
  const gone = issued.filter((r) => r.status === 'void')
  const sub = sumSatang(standing.map((r) => toSatang(r.bill_subtotal ?? '0')))
  const disc = sumSatang(standing.map((r) => toSatang(r.discount)))
  const total = sumSatang(standing.map((r) => toSatang(r.grand_total)))
  const sales = {
    label: `ยอดขายวันที่ ${day} (ตามวันที่ปิดบิล) · ไม่รวมใบเสร็จที่ยกเลิก · ไม่รวมงานเคลมประกัน`,
    billCount: standing.length,
    customerCount: new Set(standing.map((r) => r.customer_id)).size,
    subtotal: formatSatang(sub), discountTotal: formatSatang(disc), billTotal: formatSatang(total),
    overCeiling: standing.filter((r) => r.discount_approved_by !== null).map((r) => ({
      receiptId: r.id, number: r.number, discount: r.discount,
      percent: discountPercentText(toSatang(r.bill_subtotal ?? '0'), toSatang(r.discount)),
      approvedByName: r.approved_by_name, reason: r.discount_reason,
    })),
    belowAgreed: standing.filter((r) => toSatang(r.grand_total) < toSatang(r.approved_total)).map((r) => ({
      receiptId: r.id, number: r.number, billTotal: r.grand_total, agreedTotal: r.approved_total,
    })),
  }
  const voided = {
    issuedToday: { count: gone.length, billTotal: formatSatang(sumSatang(gone.map((r) => toSatang(r.grand_total)))) },
    voidedToday: { count: voidedToday.length, billTotal: formatSatang(sumSatang(voidedToday.map((r) => toSatang(r.grand_total)))) },
  }

  // ---- ลิ้นชัก ----
  const expected = sumSatang([byMethod.find((b) => b.method === 'cash')!.net])
  const latest = closings.length > 0 ? closings[closings.length - 1]! : null
  const after = latest ? await repo.cashReceivedAfter(trx, start, end, latest.closed_at) : '0'

  return {
    date: day, timezone: 'Asia/Bangkok', moneyIn, sales, voided, warrantyClaimsDelivered: claims,
    cash: {
      expected: formatSatang(expected),
      closing: latest ? closingOut(latest) : null,
      history: closings.map(closingOut),
      receivedAfterCount: after,
      canCount: (CASH_COUNT_ROLES as readonly string[]).includes(role),
    },
  }
}

// -----------------------------------------------------------------------------
// Cash count (DEFAULT pending Ice, P3.2 B7): manager and up; no opening float;
// a recount is a NEW row with a reason - the old row is never touched.
// -----------------------------------------------------------------------------

export type CountError =
  | { code: 'count_future_date' }
  | { code: 'recount_reason_required' }
  | { code: 'invalid_request'; fields: Record<string, string[]> }

export async function recordCount(
  trx: ScopedTx, shopId: string, actor: { id: string; role: string },
  input: { date: string; countedCash: string; note?: string; recountReason?: string },
): Promise<{ ok: true; value: CashClosing } | { ok: false; error: CountError }> {
  if (!(CASH_COUNT_ROLES as readonly string[]).includes(actor.role)) throw new Error('recordCount called without a counting role')
  if (input.date > bangkokToday()) return { ok: false, error: { code: 'count_future_date' } }
  // Not a real calendar day (2026-02-31) would reach ::date as a 22008 error; refuse it here.
  if (bangkokDayKey(startOfDay(input.date)) !== input.date) {
    return { ok: false, error: { code: 'invalid_request', fields: { date: ['invalid_date'] } } }
  }

  await repo.lockCountDay(trx, shopId, input.date)
  const prior = await repo.closingsOfDate(trx, input.date)
  const last = prior.length > 0 ? prior[prior.length - 1]! : null
  if (last && !input.recountReason?.trim()) return { ok: false, error: { code: 'recount_reason_required' } }

  const expected = await expectedCashSatang(trx, startOfDay(input.date), endOfDayExclusive(input.date))
  const counted = toSatang(input.countedCash)
  const variance = cashVariance(expected, counted)
  if (countNeedsNote(variance) && !input.note?.trim()) {
    return { ok: false, error: { code: 'invalid_request', fields: { note: ['required_when_variance'] } } }
  }

  const id = await repo.insertClosing(trx, {
    shopId, date: input.date, revision: (last?.revision ?? 0) + 1, expected: formatSatang(expected),
    counted: formatSatang(counted), note: input.note?.trim() || null,
    recountReason: last ? input.recountReason!.trim() : null, supersedes: last?.id ?? null, by: actor.id,
  })
  await writeAudit(trx, {
    shopId, actorId: actor.id, action: last ? 'cash_recounted' : 'cash_counted', entityType: 'daily_closings', entityId: id,
    after: {
      date: input.date, revision: (last?.revision ?? 0) + 1, expected: formatSatang(expected),
      counted: formatSatang(counted), variance: formatSatang(variance), note: input.note ?? null,
      recountReason: input.recountReason ?? null,
    },
  })
  const row = (await repo.closingsOfDate(trx, input.date)).find((r) => r.id === id)!
  return { ok: true, value: closingOut(row) }
}
