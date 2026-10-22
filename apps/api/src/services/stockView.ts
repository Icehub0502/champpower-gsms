/**
 * Stock rows -> wire objects, and the ONE place cost is stripped by role (CLAUDE.md s12.2).
 *
 * A role that may not see cost receives objects WITHOUT the keys (avgCost, stockValue, unitCost):
 * not null, not "hidden by the screen" - absent. Every wire object is .strict() in
 * packages/contracts/src/stock.ts, so adding a cost key anywhere else is a parse failure.
 */
import {
  MoneyError, formatQty, formatSatang, knownCost, mayEverSeeCost, stockStatusOf, toQtyCenti,
  type StockingPolicy,
} from '@champpower/domain'
import type { CountSheetRow, MoveRow, SkuRow } from '@gsms/contracts/index.js'
import type { MoveListRow, SkuRecord } from '../repositories/stock.js'

/** "320.0000" -> 3200000 (ten-thousandths), or null. */
function toTenThousandths(v: string): bigint | null {
  const m = /^(\d+)(?:\.(\d{1,4}))?$/.exec(v.trim())
  if (!m) return null
  return BigInt(m[1]!) * 10000n + BigInt((m[2] ?? '').padEnd(4, '0'))
}

/** qty (hundredths) x unit cost (ten-thousandths) -> satang, rounded once, half up. */
function valueSatang(onHandCenti: number, avgCost: string): string | null {
  const c = toTenThousandths(avgCost)
  if (c === null) return null
  const satang = (BigInt(onHandCenti) * c + 5000n) / 10000n
  const n = Number(satang)
  if (!Number.isSafeInteger(n)) throw new MoneyError('stock value overflow')
  return formatSatang(n)
}

export function skuView(r: SkuRecord, role: string): SkuRow {
  const counted = r.on_hand !== null
  const onHand = counted ? toQtyCenti(r.on_hand!) : null
  const reserved = counted ? toQtyCenti(r.reserved!) : null
  const out: SkuRow = {
    id: r.id,
    code: r.code,
    name: r.name,
    category: r.category,
    unit: r.unit,
    stockingPolicy: r.stocking_policy as StockingPolicy,
    reorderPoint: r.reorder_point,
    shelfLocation: r.shelf_location,
    isActive: r.is_active,
    legacyHadStock: r.legacy_had_stock,
    counted,
    status: stockStatusOf({
      balance: counted ? { onHand: onHand!, reserved: reserved! } : null,
      stockingPolicy: r.stocking_policy as StockingPolicy,
      reorderPointCenti: r.reorder_point === null ? null : toQtyCenti(r.reorder_point),
      isActive: r.is_active,
    }),
    onHand: counted ? formatQty(onHand!) : null,
    reserved: counted ? formatQty(reserved!) : null,
    available: counted ? formatQty(onHand! - reserved!) : null,
  }
  if (mayEverSeeCost(role)) {
    const cost = knownCost(r.avg_cost)
    out.avgCost = cost
    out.stockValue = counted && cost !== null ? valueSatang(onHand!, cost) : null
  }
  return out
}

export function countSheetRowView(r: SkuRecord, role: string, lastCountedAt: Date | undefined): CountSheetRow {
  return { ...skuView(r, role), lastCountedAt: lastCountedAt ? lastCountedAt.toISOString() : null }
}

export function moveView(r: MoveListRow, role: string): MoveRow {
  const out: MoveRow = {
    id: r.id,
    type: r.type as MoveRow['type'],
    qty: r.qty,
    onHandAfter: r.on_hand_after,
    reservedAfter: r.reserved_after,
    reason: r.reason,
    at: r.created_at.toISOString(),
    user: r.user_id ? { id: r.user_id, name: r.user_name } : null,
    ref: r.ref_line_id && r.document_id
      ? {
          kind: 'document_line', documentId: r.document_id, documentType: r.document_type ?? 'unknown',
          documentNumber: r.document_number, lineId: r.ref_line_id, lineName: r.line_name,
          jobId: r.job_id, jobNumber: r.job_number,
        }
      : null,
  }
  if (mayEverSeeCost(role)) out.unitCost = r.unit_cost
  return out
}
