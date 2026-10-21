/**
 * The two-phase stock flow that hangs off a quotation (WO-006, CLAUDE.md s6):
 *
 *   confirm       -> reserveForDocument   approved part lines only, per LINE, set children not parents
 *   undo / revise / void / job ends / receipt closes
 *                 -> releaseDocument / releaseForReceipt
 *   office pulls  -> issueForJob          issue + unreserve in one transaction
 *
 * LOCK ORDER (CLAUDE.md s4.x): jobs -> documents -> document_lines -> stock. Every function here is
 * called by a caller that already holds the job and the document; this file takes the LINES
 * (stockRepo.lockLines) and THEN the balance rows (stockRepo.lockBalances, ascending sku_id), and
 * nothing is read from a line or a balance before its lock.
 *
 * WHAT A CALLER SEES CONCURRENTLY: a second confirm/issue on the same job waits on the job lock; a
 * different job needing the same SKU waits on that SKU's balance row, then sees the first one's
 * reservation in `available` (so the shortfall is judged on what is really left).
 * WHAT A RETRY DOES: every move has a UNIQUE idempotency key (domain stockKeys); a replay inserts
 * nothing and leaves the balance alone. reserve/unreserve keys carry the line's reservation
 * GENERATION so undo -> re-confirm reserves again, while a repeat of the same act does not.
 *
 * Reminder (same as services/quotation.ts): a function that returns an error AFTER writing still
 * commits the request. The issue path therefore validates everything on a copy first, then writes.
 */
import {
  availableCenti, formatQty, planIssue, planStockNeeds, releaseShareCenti, shortfallNeedsAction,
  splitShortfall, stockKeys, toQtyCenti,
  type StockingPolicy, type StockLine,
} from '@champpower/domain'
import type { ScopedTx } from '@gsms/db/client.js'
import type { JobStock, JobStockLine, StockConfirmSummary } from '@gsms/contracts/index.js'
import * as stockRepo from '../repositories/stock.js'
import * as quotationRepo from '../repositories/quotation.js'
import { noteStockChange } from '../lib/stockEvents.js'
import { writeAudit } from './audit.js'
import { BalanceBook } from './stockLedger.js'

// -----------------------------------------------------------------------------
// Shared helpers
// -----------------------------------------------------------------------------

/** A line's SKU: the one frozen onto it, else the catalog's current binding (lines made before the link existed). */
async function effectiveSkus(trx: ScopedTx, lines: readonly stockRepo.StockLineRow[]): Promise<Map<string, string | null>> {
  const unfrozen = lines.filter((l) => l.sku_id === null && l.line_type === 'part' && l.catalog_item_id !== null)
  const viaCatalog = await stockRepo.skuOfCatalogItems(trx, unfrozen.map((l) => l.catalog_item_id!))
  return new Map(lines.map((l) => [l.id, l.sku_id ?? (l.catalog_item_id ? viaCatalog.get(l.catalog_item_id) ?? null : null)]))
}

function toStockLines(lines: readonly stockRepo.StockLineRow[], eff: Map<string, string | null>): StockLine[] {
  return lines.map((l) => ({
    id: l.id,
    parentLineId: l.parent_line_id,
    lineType: l.line_type as StockLine['lineType'],
    approvalStatus: l.approval_status as StockLine['approvalStatus'],
    skuId: eff.get(l.id) ?? null,
    qty: l.qty,
  }))
}

function ledgerByLine(rows: readonly stockRepo.LineLedger[]): Map<string, stockRepo.LineLedger[]> {
  const m = new Map<string, stockRepo.LineLedger[]>()
  for (const r of rows) m.set(r.lineId, [...(m.get(r.lineId) ?? []), r])
  return m
}
const reservedNetOf = (rows: readonly stockRepo.LineLedger[] | undefined) => (rows ?? []).reduce((s, r) => s + r.reservedCenti, 0)
const reserveCountOf = (rows: readonly stockRepo.LineLedger[] | undefined) => (rows ?? []).reduce((s, r) => s + r.reserveCount, 0)

export const emptySummary = (): StockConfirmSummary => ({ reserved: [], shortfalls: [], notCounted: [], unbound: [] })

// -----------------------------------------------------------------------------
// Reserve (inside the confirm transaction)
// -----------------------------------------------------------------------------

export interface ReserveOutcome {
  summary: StockConfirmSummary
  skuIds: string[]
}

/**
 * Reserve what the customer approved. Never blocks: what the shelf cannot cover becomes a shortfall
 * on the line (an open purchase suggestion, and the work order says รออะไหล่); a SKU nobody has ever
 * counted is passed over with a note; a part line with no SKU is listed as unbound.
 */
export async function reserveForDocument(
  trx: ScopedTx,
  a: { shopId: string; documentId: string; jobId: string | null; actorId: string },
): Promise<ReserveOutcome> {
  const summary = emptySummary()
  const lines = await stockRepo.lockLines(trx, a.documentId)
  const eff = await effectiveSkus(trx, lines)
  const chainIssued = await stockRepo.issuedThroughChain(trx, a.documentId)
  const plan = planStockNeeds(toStockLines(lines, eff), chainIssued)
  const lineById = new Map(lines.map((l) => [l.id, l]))

  for (const s of plan.skipped) if (s.reason === 'no_sku') summary.unbound.push({ lineId: s.lineId, name: lineById.get(s.lineId)!.name_snapshot })
  if (plan.needs.length === 0) return { summary, skuIds: [] }

  const ledger = ledgerByLine(await stockRepo.ledgerOfDocument(trx, a.documentId))
  // State, not only the key, says "already reserved": a repeat of this call finds the reservation and stands down.
  const todo = plan.needs.filter((n) => reservedNetOf(ledger.get(n.lineId)) === 0)
  if (todo.length === 0) return { summary, skuIds: [] }

  const skuIds = [...new Set(todo.map((n) => n.skuId))]
  const skus = await stockRepo.getSkusByIds(trx, skuIds)
  const book = new BalanceBook(trx, a.shopId, await stockRepo.lockBalances(trx, skuIds))
  const touched = new Set<string>()
  const audit: Array<{ lineId: string; skuId: string; reserved: string; short: string }> = []

  for (const need of todo) {
    const sku = skus.get(need.skuId)
    const line = lineById.get(need.lineId)!
    if (!sku) continue
    if (!book.has(need.skuId)) {
      summary.notCounted.push({ lineId: need.lineId, name: line.name_snapshot, skuCode: sku.code })
      continue
    }
    const { reserveCenti, shortCenti } = splitShortfall(need.needCenti, availableCenti(book.snapshot(need.skuId)))
    if (reserveCenti > 0) {
      const gen = reserveCountOf(ledger.get(need.lineId)) + 1
      const r = await book.post({
        skuId: need.skuId, type: 'reserve', qtyCenti: reserveCenti, key: stockKeys.reserve(need.lineId, gen),
        documentId: a.documentId, lineId: need.lineId, userId: a.actorId,
      })
      if (r === 'posted') {
        touched.add(need.skuId)
        summary.reserved.push({ lineId: need.lineId, name: line.name_snapshot, skuCode: sku.code, qty: formatQty(reserveCenti) })
      }
    }
    if (shortCenti > 0 && shortfallNeedsAction(sku.stocking_policy as StockingPolicy)) {
      await stockRepo.upsertShortfallSuggestion(trx, a.shopId, need.skuId, need.lineId, shortCenti)
      summary.shortfalls.push({
        lineId: need.lineId, name: line.name_snapshot, skuId: need.skuId, skuCode: sku.code,
        needed: formatQty(need.needCenti), reserved: formatQty(reserveCenti), short: formatQty(shortCenti),
      })
    }
    audit.push({ lineId: need.lineId, skuId: need.skuId, reserved: formatQty(reserveCenti), short: formatQty(shortCenti) })
  }
  await book.flush()

  if (audit.length > 0) {
    await writeAudit(trx, {
      shopId: a.shopId, actorId: a.actorId, action: 'stock_reserved', entityType: 'documents', entityId: a.documentId,
      after: { jobId: a.jobId, lines: audit, notCounted: summary.notCounted.length, unbound: summary.unbound.length },
    })
  }
  const changed = [...touched]
  noteStockChange(trx, { skuIds: [...new Set([...changed, ...summary.shortfalls.map((s) => s.skuId)])], jobId: a.jobId, cause: 'reserve' })
  return { summary, skuIds: changed }
}

// -----------------------------------------------------------------------------
// Release
// -----------------------------------------------------------------------------

export type ReleaseCause = 'undo_confirm' | 'revise' | 'void' | 'job_end'
const RELEASE_REASON: Record<ReleaseCause, string> = {
  undo_confirm: 'ถอยการยืนยันผลลูกค้า',
  revise: 'ออกใบเสนอราคาฉบับใหม่',
  void: 'ยกเลิกใบเสนอราคา',
  job_end: 'งานจบโดยไม่ได้ซ่อม',
}

/**
 * Give back everything still reserved for a quotation, and close the shortfall suggestions of its
 * lines. Reservations are read from the LEDGER (what was actually reserved, on which SKU), never
 * recomputed from the lines, so a SKU re-bound in the catalog since cannot make it release the wrong part.
 * Parts already ISSUED stay issued: they have left the shelf.
 */
export async function releaseDocument(
  trx: ScopedTx,
  a: { shopId: string; documentId: string; jobId: string | null; actorId: string | null; cause: ReleaseCause },
): Promise<{ released: number; skuIds: string[] }> {
  await stockRepo.closeShortfallSuggestionsOfDocument(trx, a.documentId, 'cancelled')
  const targets = (await stockRepo.ledgerOfDocument(trx, a.documentId)).filter((r) => r.reservedCenti > 0)
  if (targets.length === 0) return { released: 0, skuIds: [] }

  // Lines first (lock order), then balances.
  await stockRepo.lockLines(trx, a.documentId)
  const skuIds = [...new Set(targets.map((t) => t.skuId))]
  const book = new BalanceBook(trx, a.shopId, await stockRepo.lockBalances(trx, skuIds))
  const done: Array<{ lineId: string; skuId: string; qty: string }> = []
  for (const t of [...targets].sort((x, y) => x.skuId.localeCompare(y.skuId) || x.lineId.localeCompare(y.lineId))) {
    const r = await book.post({
      skuId: t.skuId, type: 'unreserve', qtyCenti: -t.reservedCenti, key: stockKeys.unreserve(t.lineId, t.reserveCount),
      reason: RELEASE_REASON[a.cause], documentId: a.documentId, lineId: t.lineId, userId: a.actorId,
    })
    if (r === 'posted') done.push({ lineId: t.lineId, skuId: t.skuId, qty: formatQty(t.reservedCenti) })
  }
  await book.flush()
  if (done.length > 0) {
    await writeAudit(trx, {
      shopId: a.shopId, actorId: a.actorId, action: 'stock_released', entityType: 'documents', entityId: a.documentId,
      after: { cause: a.cause, jobId: a.jobId, lines: done },
    })
    noteStockChange(trx, { skuIds, jobId: a.jobId, cause: 'release' })
  }
  return { released: done.length, skuIds }
}

/**
 * P3.2 seam (services/stockHooks.ts): the receipt is closing. Lines the customer approved but that
 * were not done give back their reservation - min(reserved, qty - fulfilled) for a plain line, the
 * unfinished share of every component for a set. Returns how many quotation lines it released.
 * ISSUED-but-unused parts (AC-H4) are not blocked, only written to the audit log for the owner.
 */
export async function releaseForReceipt(
  trx: ScopedTx,
  a: {
    shopId: string
    receiptId: string
    actorId: string
    lines: ReadonlyArray<{ lineId: string; sourceLineId: string | null; qty: string; fulfilledQty: string }>
  },
): Promise<number> {
  const withSource = a.lines.filter((l) => l.sourceLineId !== null)
  if (withSource.length === 0) return 0

  // The quotation lines these receipt lines came from, plus their set components.
  const sourceIds = withSource.map((l) => l.sourceLineId!)
  const rows = await trx
    .selectFrom('document_lines').select(['id', 'document_id', 'parent_line_id'])
    .where((eb) => eb.or([eb('id', 'in', sourceIds), eb('parent_line_id', 'in', sourceIds)]))
    .orderBy('id', 'asc').execute()
  if (rows.length === 0) return 0
  const docIds = [...new Set(rows.map((r) => r.document_id))]
  const ledger = new Map<string, stockRepo.LineLedger[]>()
  for (const d of docIds) for (const [k, v] of ledgerByLine(await stockRepo.ledgerOfDocument(trx, d))) ledger.set(k, v)

  interface Target { lineId: string; documentId: string; receiptLineId: string; childOf: string | null; skuId: string; reserved: number; reserveCount: number; qty: number; fulfilled: number; issued: number }
  const targets: Target[] = []
  for (const l of withSource) {
    const qty = toQtyCenti(l.qty)
    const fulfilled = toQtyCenti(l.fulfilledQty)
    for (const r of rows.filter((x) => x.id === l.sourceLineId || x.parent_line_id === l.sourceLineId)) {
      for (const lg of ledger.get(r.id) ?? []) {
        targets.push({
          lineId: r.id, documentId: r.document_id, receiptLineId: l.lineId, childOf: r.parent_line_id ? r.id : null,
          skuId: lg.skuId, reserved: lg.reservedCenti, reserveCount: lg.reserveCount, qty, fulfilled, issued: lg.issuedCenti,
        })
      }
    }
  }
  const toRelease = targets.filter((t) => releaseShareCenti(t.reserved, t.qty, t.fulfilled, t.childOf !== null) > 0)
  const issuedUnused = targets.filter((t) => t.issued > 0 && t.fulfilled < t.qty)

  let released = 0
  if (toRelease.length > 0) {
    for (const d of docIds) await stockRepo.lockLines(trx, d)
    const skuIds = [...new Set(toRelease.map((t) => t.skuId))]
    const book = new BalanceBook(trx, a.shopId, await stockRepo.lockBalances(trx, skuIds))
    for (const t of [...toRelease].sort((x, y) => x.skuId.localeCompare(y.skuId) || x.lineId.localeCompare(y.lineId))) {
      const share = releaseShareCenti(t.reserved, t.qty, t.fulfilled, t.childOf !== null)
      const r = await book.post({
        skuId: t.skuId, type: 'unreserve', qtyCenti: -share,
        key: stockKeys.receiptRelease(a.receiptId, t.receiptLineId, t.childOf ?? undefined),
        reason: 'ปิดบิล: รายการที่ไม่ได้ทำ', documentId: t.documentId, lineId: t.lineId, userId: a.actorId,
      })
      if (r === 'posted') {
        released++
        if (share === t.reserved) await stockRepo.closeShortfallSuggestion(trx, t.lineId, 'cancelled')
      }
    }
    await book.flush()
    noteStockChange(trx, { skuIds, jobId: null, cause: 'release' })
  }
  if (issuedUnused.length > 0) {
    await writeAudit(trx, {
      shopId: a.shopId, actorId: a.actorId, action: 'stock_issued_unused', entityType: 'documents', entityId: a.receiptId,
      after: { lines: issuedUnused.map((t) => ({ lineId: t.lineId, skuId: t.skuId, issued: formatQty(t.issued) })) },
    })
  }
  return released
}

// -----------------------------------------------------------------------------
// The per-job view (what to pull, what is short)
// -----------------------------------------------------------------------------

interface LineState {
  line: stockRepo.StockLineRow
  skuId: string
  needCenti: number
  issuedCenti: number
  reservedCenti: number
}

async function lineStates(trx: ScopedTx, documentId: string) {
  const lines = await stockRepo.linesOfDocument(trx, documentId)
  const eff = await effectiveSkus(trx, lines)
  const plan = planStockNeeds(toStockLines(lines, eff), new Map())
  const issued = await stockRepo.issuedThroughChain(trx, documentId)
  const ledger = ledgerByLine(await stockRepo.ledgerOfDocument(trx, documentId))
  const byId = new Map(lines.map((l) => [l.id, l]))
  const states: LineState[] = plan.needs.map((n) => {
    const rows = ledger.get(n.lineId)
    return {
      line: byId.get(n.lineId)!,
      // The SKU the ledger already knows beats a re-resolved one.
      skuId: rows && rows.length > 0 ? rows[0]!.skuId : n.skuId,
      needCenti: n.needCenti,
      issuedCenti: issued.get(n.lineId) ?? 0,
      reservedCenti: reservedNetOf(rows),
    }
  })
  return { lines, plan, states, ledger }
}

export async function buildJobStock(trx: ScopedTx, jobId: string): Promise<JobStock> {
  const doc = await quotationRepo.findLiveQuotation(trx, jobId)
  const empty: JobStock = { jobId, quotation: null, lines: [], unboundLines: [], awaitingParts: false }
  if (!doc) return empty
  const quotation = { id: doc.id, number: doc.number, revision: doc.revision }
  if (doc.status !== 'signed') return { ...empty, quotation }

  const { lines, plan, states } = await lineStates(trx, doc.id)
  const skus = await stockRepo.getSkusByIds(trx, [...new Set(states.map((s) => s.skuId))])
  const byId = new Map(lines.map((l) => [l.id, l]))

  const out: JobStockLine[] = []
  for (const s of states) {
    const sku = skus.get(s.skuId)
    if (!sku) continue
    const counted = sku.on_hand !== null
    const remaining = Math.max(0, s.needCenti - s.issuedCenti)
    const policy = sku.stocking_policy as StockingPolicy
    const short = counted && shortfallNeedsAction(policy) ? Math.max(0, remaining - s.reservedCenti) : 0
    out.push({
      lineId: s.line.id,
      parentLineId: s.line.parent_line_id,
      name: s.line.name_snapshot,
      skuId: sku.id,
      skuCode: sku.code,
      skuName: sku.name,
      shelfLocation: sku.shelf_location,
      unit: s.line.unit ?? sku.unit,
      need: formatQty(s.needCenti),
      reserved: formatQty(s.reservedCenti),
      issued: formatQty(s.issuedCenti),
      toIssue: formatQty(Math.min(s.reservedCenti, remaining)),
      shortfall: formatQty(short),
      onHand: sku.on_hand,
      available: counted ? formatQty(toQtyCenti(sku.on_hand!) - toQtyCenti(sku.reserved!)) : null,
      counted,
      stockingPolicy: policy,
      awaitingParts: short > 0,
      done: remaining === 0,
    })
  }
  const unboundLines = plan.skipped.filter((s) => s.reason === 'no_sku').map((s) => ({ lineId: s.lineId, name: byId.get(s.lineId)!.name_snapshot }))
  return { jobId, quotation, lines: out, unboundLines, awaitingParts: out.some((l) => l.awaitingParts) }
}

/** The ids of approved lines the technician must not walk to a shelf for ("รออะไหล่"), set heads included. */
export async function awaitingPartLineIds(trx: ScopedTx, jobId: string): Promise<Set<string>> {
  const stock = await buildJobStock(trx, jobId)
  const ids = new Set(stock.lines.filter((l) => l.awaitingParts).map((l) => l.lineId))
  for (const l of stock.lines) if (l.awaitingParts && l.parentLineId) ids.add(l.parentLineId)
  return ids
}

// -----------------------------------------------------------------------------
// Issue (เบิก)
// -----------------------------------------------------------------------------

export type IssueError =
  | { code: 'job_not_found' }
  | { code: 'quotation_missing' }
  | { code: 'quotation_not_confirmed' }
  | { code: 'line_not_issuable'; lineId: string; reason: 'not_part' | 'not_approved' | 'parent_not_approved' | 'is_set_parent' | 'no_sku' | 'not_in_quotation' }
  | { code: 'sku_not_counted'; lineId: string }
  | { code: 'insufficient_on_hand'; lineId: string; skuId: string; onHand: string; requested: string }
  | { code: 'over_reserved_needs_confirm'; lineId: string; reserved: string; requested: string }

export interface IssueRequest {
  requestId: string
  lines: ReadonlyArray<{ lineId: string; qty: string; allowOverReserved?: boolean }>
}

export interface IssueOutcome {
  replayed: boolean
  issued: Array<{ lineId: string; skuId: string; skuCode: string; qty: string; fromReserved: string; extra: string }>
}

export async function issueForJob(
  trx: ScopedTx,
  a: { shopId: string; jobId: string; actorId: string },
  req: IssueRequest,
): Promise<{ ok: true; value: IssueOutcome } | { ok: false; error: IssueError }> {
  const err = (error: IssueError) => ({ ok: false as const, error })

  // jobs -> documents -> document_lines -> stock
  const job = await quotationRepo.lockJob(trx, a.jobId)
  if (!job) return err({ code: 'job_not_found' })
  const live = await quotationRepo.findLiveQuotation(trx, a.jobId)
  if (!live) return err({ code: 'quotation_missing' })
  const doc = await quotationRepo.lockDocument(trx, live.id)
  if (!doc) return err({ code: 'quotation_missing' })
  if (doc.status !== 'signed') return err({ code: 'quotation_not_confirmed' })
  const lines = await stockRepo.lockLines(trx, doc.id)
  const byId = new Map(lines.map((l) => [l.id, l]))

  // A retry of the same press: lines whose key is already in the ledger are done.
  const fresh: IssueRequest['lines'][number][] = []
  for (const r of req.lines) {
    if (!byId.has(r.lineId)) return err({ code: 'line_not_issuable', lineId: r.lineId, reason: 'not_in_quotation' })
    if (!(await stockRepo.findMoveByKey(trx, stockKeys.issue(r.lineId, req.requestId)))) fresh.push(r)
  }
  if (fresh.length === 0) return { ok: true, value: { replayed: true, issued: [] } }

  const eff = await effectiveSkus(trx, lines)
  const stockLines = toStockLines(lines, eff)
  // Eligibility is judged on the GROSS need (issued history not subtracted): pulling a spare is allowed.
  const gross = planStockNeeds(stockLines, new Map())
  const eligible = new Set(gross.needs.map((n) => n.lineId))
  const skipReason = new Map(gross.skipped.map((s) => [s.lineId, s.reason]))
  for (const r of fresh) {
    if (eligible.has(r.lineId)) continue
    const reason = skipReason.get(r.lineId)
    // 'nothing_left' cannot occur with an empty issued map; map it to the closest honest answer anyway.
    return err({ code: 'line_not_issuable', lineId: r.lineId, reason: reason === undefined || reason === 'nothing_left' ? 'no_sku' : reason })
  }

  const ledger = ledgerByLine(await stockRepo.ledgerOfDocument(trx, doc.id))
  const skuOf = (lineId: string) => {
    const rows = ledger.get(lineId)
    return rows && rows.length > 0 ? rows[0]!.skuId : eff.get(lineId)!
  }
  const skuIds = [...new Set(fresh.map((r) => skuOf(r.lineId)))]
  const skus = await stockRepo.getSkusByIds(trx, skuIds)
  const book = new BalanceBook(trx, a.shopId, await stockRepo.lockBalances(trx, skuIds))

  // Pass 1: judge every line on a COPY of the balances, so an error leaves nothing half-written.
  const sim = new Map(skuIds.map((id) => [id, book.has(id) ? { ...book.snapshot(id) } : null]))
  const plans: Array<{ r: (typeof fresh)[number]; skuId: string; qty: number; issue: number; unreserve: number; extra: number }> = []
  for (const r of fresh) {
    const skuId = skuOf(r.lineId)
    const bal = sim.get(skuId)
    if (!bal) return err({ code: 'sku_not_counted', lineId: r.lineId })
    const qty = toQtyCenti(r.qty)
    const lineReserved = reservedNetOf(ledger.get(r.lineId))
    const p = planIssue({ qtyCenti: qty, lineReservedCenti: lineReserved, onHandCenti: bal.onHand, reservedTotalCenti: bal.reserved, allowOverReserved: r.allowOverReserved === true })
    if (!p.ok) {
      if (p.code === 'insufficient_on_hand') return err({ code: 'insufficient_on_hand', lineId: r.lineId, skuId, onHand: formatQty(bal.onHand), requested: formatQty(qty) })
      return err({ code: 'over_reserved_needs_confirm', lineId: r.lineId, reserved: formatQty(lineReserved), requested: formatQty(qty) })
    }
    bal.onHand -= p.issueCenti
    bal.reserved -= p.unreserveCenti
    plans.push({ r, skuId, qty, issue: p.issueCenti, unreserve: p.unreserveCenti, extra: p.extraCenti })
  }

  // Pass 2: write, in request order.
  const issued: IssueOutcome['issued'] = []
  for (const p of plans) {
    const sku = skus.get(p.skuId)!
    const res = await book.post({
      skuId: p.skuId, type: 'issue', qtyCenti: -p.issue, key: stockKeys.issue(p.r.lineId, req.requestId),
      documentId: doc.id, lineId: p.r.lineId, userId: a.actorId,
    })
    if (res === 'replayed') continue
    if (p.unreserve > 0) {
      await book.post({
        skuId: p.skuId, type: 'unreserve', qtyCenti: -p.unreserve, key: stockKeys.issueUnreserve(p.r.lineId, req.requestId),
        documentId: doc.id, lineId: p.r.lineId, userId: a.actorId,
      })
    }
    issued.push({ lineId: p.r.lineId, skuId: p.skuId, skuCode: sku.code, qty: formatQty(p.issue), fromReserved: formatQty(p.unreserve), extra: formatQty(p.extra) })
    await writeAudit(trx, {
      shopId: a.shopId, actorId: a.actorId, action: 'stock_issued', entityType: 'document_lines', entityId: p.r.lineId,
      after: { documentId: doc.id, jobId: a.jobId, skuId: p.skuId, qty: formatQty(p.issue), fromReserved: formatQty(p.unreserve), extra: formatQty(p.extra), requestId: req.requestId },
    })
  }
  await book.flush()

  // A line that now has what it needs no longer waits on a purchase.
  const after = await lineStates(trx, doc.id)
  for (const s of after.states) {
    if (!plans.some((p) => p.r.lineId === s.line.id)) continue
    const sku = skus.get(s.skuId)
    if (!sku || !shortfallNeedsAction(sku.stocking_policy as StockingPolicy) || sku.on_hand === null) continue
    const short = Math.max(0, s.needCenti - s.issuedCenti - s.reservedCenti)
    if (short === 0) await stockRepo.closeShortfallSuggestion(trx, s.line.id, 'done')
    else await stockRepo.upsertShortfallSuggestion(trx, a.shopId, s.skuId, s.line.id, short)
  }
  noteStockChange(trx, { skuIds, jobId: a.jobId, cause: 'issue' })
  return { ok: true, value: { replayed: false, issued } }
}
