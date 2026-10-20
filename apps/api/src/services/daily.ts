/**
 * The daily summary.
 *
 * TWO FIGURES, NEVER MERGED (CLAUDE.md s5.4 rule 9). "เงินเข้า" is built from
 * payments by the day the money was RECEIVED (less change, less refunds dated that
 * day, channel surcharges included); "ยอดขาย" from receipts by the day the BILL WAS
 * CLOSED. They come from different tables and different queries on purpose, and
 * nothing here adds one to the other. A deposit taken on the 3rd and billed on the
 * 8th is correct in both: the 3rd shows money in and no sale, the 8th the sale.
 *
 * Channel surcharges (Ice 20 Oct, P3.2 B3; DEFAULT pending Ice (B3 surcharge
 * display)): inside "money in" (it is money received) and a separate category in
 * sales ("ค่าธรรมเนียมรับชำระ"), never part of the bill total or the 40% base.
 *
 * No till count (Ice 20 Oct, P3.2 B7 cut): the cash figure is information only.
 */
import { discountPercentText, formatSatang, sumSatang, toSatang } from '@champpower/domain'
import type { DailySummary } from '@gsms/contracts/index.js'
import type { ScopedTx } from '@gsms/db/client.js'
import { bangkokToday, endOfDayExclusive, startOfDay } from '../lib/bangkokDate.js'
import * as repo from '../repositories/daily.js'

const METHODS = ['cash', 'transfer', 'card'] as const
type Kind = (typeof METHODS)[number]

export async function dailySummary(trx: ScopedTx, date: string | undefined): Promise<DailySummary> {
  const day = date ?? bangkokToday()
  const start = startOfDay(day)
  const end = endOfDayExclusive(day)

  const [pay, rev, payCh, revCh, issued, voidedToday, claims] = await Promise.all([
    repo.paymentSumsByMethod(trx, start, end),
    repo.reversalSumsByMethod(trx, start, end),
    repo.paymentSumsByChannel(trx, start, end),
    repo.reversalSumsByChannel(trx, start, end),
    repo.receiptsIssuedBetween(trx, start, end),
    repo.receiptsVoidedBetween(trx, start, end),
    repo.warrantyClaimsDeliveredBetween(trx, start, end),
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

  // By the shop's own channel. A channel with a refund but no new payment today still gets its row.
  const keyOf = (id: string | null, kind: string) => `${id ?? 'none'}|${kind}`
  const channels = new Map<string, { channelId: string | null; name: string; kind: Kind; received: number; change: number; surcharge: number; reversed: number }>()
  for (const p of payCh) {
    channels.set(keyOf(p.channel_id, p.kind), {
      channelId: p.channel_id, name: p.name ?? 'ไม่ระบุช่องทาง', kind: p.kind as Kind,
      received: toSatang(p.received), change: toSatang(p.change), surcharge: toSatang(p.surcharge), reversed: 0,
    })
  }
  for (const r of revCh) {
    const k = keyOf(r.channel_id, r.kind)
    const row = channels.get(k) ?? { channelId: r.channel_id, name: r.name ?? 'ไม่ระบุช่องทาง', kind: r.kind as Kind, received: 0, change: 0, surcharge: 0, reversed: 0 }
    row.reversed += toSatang(r.amount)
    channels.set(k, row)
  }
  const surchargeIn = sumSatang(pay.map((p) => toSatang(p.surcharge)))

  const moneyIn = {
    label: `เงินเข้าวันที่ ${day} (ตามวันที่รับเงิน · เขตเวลา Asia/Bangkok) · รวมค่าธรรมเนียมช่องทาง · หักเงินทอนและเงินคืนที่ยกเลิกใบเสร็จในวันนี้`,
    paymentCount: pay.reduce((a, p) => a + p.rows, 0),
    reversalCount: rev.reduce((a, p) => a + p.rows, 0),
    byMethod: byMethod.map((b) => ({
      method: b.method, received: formatSatang(b.received), changeGiven: formatSatang(b.change),
      reversed: formatSatang(b.reversed), net: formatSatang(b.net),
    })),
    byChannel: [...channels.values()].map((c) => ({
      channelId: c.channelId, name: c.name, kind: c.kind, received: formatSatang(c.received),
      changeGiven: formatSatang(c.change), surcharge: formatSatang(c.surcharge), reversed: formatSatang(c.reversed),
      net: formatSatang(c.received - c.change - c.reversed),
    })),
    surchargeTotal: formatSatang(surchargeIn),
    total: formatSatang(sumSatang(byMethod.map((b) => b.net))),
    changeCount: pay.reduce((a, p) => a + p.change_rows, 0),
    changeTotal: formatSatang(sumSatang(byMethod.map((b) => b.change))),
  }

  // ---- ยอดขาย ---- (receipts numbered today and still standing; voided ones are shown apart)
  const standing = issued.filter((r) => r.status === 'issued')
  const gone = issued.filter((r) => r.status === 'void')
  const sub = sumSatang(standing.map((r) => toSatang(r.bill_subtotal ?? '0')))
  // Line discounts + document discounts: every baht taken off.
  const disc = sumSatang(standing.map((r) => toSatang(r.discount) + toSatang(r.line_discounts)))
  const total = sumSatang(standing.map((r) => toSatang(r.grand_total)))
  const sales = {
    label: `ยอดขายวันที่ ${day} (ตามวันที่ปิดบิล) · ไม่รวมใบเสร็จที่ยกเลิก · ไม่รวมงานเคลมประกัน · ค่าธรรมเนียมรับชำระแยกเป็นอีกหมวด`,
    billCount: standing.length,
    customerCount: new Set(standing.map((r) => r.customer_id)).size,
    subtotal: formatSatang(sub), discountTotal: formatSatang(disc), billTotal: formatSatang(total),
    surchargeTotal: formatSatang(sumSatang(standing.map((r) => toSatang(r.surcharge)))),
    overCeiling: standing.filter((r) => r.discount_approved_by !== null).map((r) => {
      const d = toSatang(r.discount) + toSatang(r.line_discounts)
      return {
        receiptId: r.id, number: r.number, discount: formatSatang(d),
        percent: discountPercentText(toSatang(r.bill_subtotal ?? '0'), d),
        approvedByName: r.approved_by_name, reason: r.discount_reason,
      }
    }),
    belowAgreed: standing.filter((r) => toSatang(r.grand_total) < toSatang(r.approved_total)).map((r) => ({
      receiptId: r.id, number: r.number, billTotal: r.grand_total, agreedTotal: r.approved_total,
    })),
  }
  const voided = {
    issuedToday: { count: gone.length, billTotal: formatSatang(sumSatang(gone.map((r) => toSatang(r.grand_total)))) },
    voidedToday: { count: voidedToday.length, billTotal: formatSatang(sumSatang(voidedToday.map((r) => toSatang(r.grand_total)))) },
  }

  return {
    date: day, timezone: 'Asia/Bangkok', moneyIn, sales, voided, warrantyClaimsDelivered: claims,
    cashReceivedNet: formatSatang(byMethod.find((b) => b.method === 'cash')!.net),
  }
}
