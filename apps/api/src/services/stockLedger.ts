/**
 * The one door through which a quantity changes (WO-006).
 *
 * A BalanceBook holds the balance rows of the SKUs a request is about to touch, ALREADY LOCKED
 * (stockRepo.lockBalances: SELECT ... FOR UPDATE, ascending sku_id), and turns every change into
 * (1) a pure check in packages/domain, (2) one appended ledger row carrying the balance after it,
 * (3) a single balance write at flush(). Nothing else in apps/api writes stock_balances or
 * stock_moves, so "no quantity read outside the lock and written back" is true by construction.
 *
 * REPLAYS: UNIQUE (shop_id, idempotency_key) makes the insert a no-op; post() then returns
 * 'replayed' and changes neither the book nor (therefore) the balance.
 */
import { applyMove, knownCost, type BalanceCenti, type StockMoveType } from '@champpower/domain'
import type { ScopedTx } from '@gsms/db/client.js'
import * as stockRepo from '../repositories/stock.js'

/** A move the domain refused to apply. The services check first, so reaching this means a bug, not a user error. */
export class StockInvariantError extends Error {
  constructor(public readonly code: string, detail: string) {
    super(`stock invariant: ${code} (${detail})`)
    this.name = 'StockInvariantError'
  }
}

export interface PostInput {
  skuId: string
  type: StockMoveType
  /** Signed, in hundredths: reserve +, unreserve -, issue -, count/adjustment delta. */
  qtyCenti: number
  key: string
  reason?: string | null
  userId: string | null
  /** document_line moves carry the document and the line; manual ones carry neither. */
  documentId?: string | null
  lineId?: string | null
}

export class BalanceBook {
  private readonly dirty = new Set<string>()

  constructor(
    private readonly trx: ScopedTx,
    private readonly shopId: string,
    private readonly balances: Map<string, stockRepo.LockedBalance>,
  ) {}

  has(skuId: string): boolean {
    return this.balances.has(skuId)
  }

  get(skuId: string): stockRepo.LockedBalance {
    const b = this.balances.get(skuId)
    if (!b) throw new StockInvariantError('not_locked', 'balance row was not locked before use')
    return b
  }

  snapshot(skuId: string): BalanceCenti {
    const b = this.get(skuId)
    return { onHand: b.onHand, reserved: b.reserved }
  }

  /** Append the move and update the in-memory balance; the balance row is written once, by flush(). */
  async post(m: PostInput): Promise<'posted' | 'replayed'> {
    const cur = this.get(m.skuId)
    const applied = applyMove({ onHand: cur.onHand, reserved: cur.reserved }, m.type, m.qtyCenti)
    if (!applied.ok) throw new StockInvariantError(applied.code, `${m.type} ${m.qtyCenti} on ${m.skuId}`)
    const id = await stockRepo.insertMove(this.trx, {
      shopId: this.shopId,
      skuId: m.skuId,
      type: m.type,
      qtyCenti: m.qtyCenti,
      // Copied from the balance, never from a client. avg_cost is 0 until purchasing exists, and 0 reads as "unknown".
      unitCost: knownCost(cur.avgCost),
      refType: m.documentId ? 'document_line' : null,
      refId: m.documentId ?? null,
      refLineId: m.lineId ?? null,
      idempotencyKey: m.key,
      reason: m.reason ?? null,
      userId: m.userId,
      onHandAfter: applied.balance.onHand,
      reservedAfter: applied.balance.reserved,
    })
    if (id === null) return 'replayed'
    cur.onHand = applied.balance.onHand
    cur.reserved = applied.balance.reserved
    this.dirty.add(m.skuId)
    this.lastMoveId = id
    return 'posted'
  }

  /** Id of the most recent move this book appended. */
  lastMoveId: string | null = null

  async flush(): Promise<void> {
    for (const skuId of [...this.dirty].sort()) {
      await stockRepo.writeBalance(this.trx, this.shopId, skuId, this.snapshot(skuId))
    }
    this.dirty.clear()
  }
}
