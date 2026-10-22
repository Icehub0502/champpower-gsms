/**
 * Realtime signal after a stock write: `stock:changed` to the shop's staff room.
 *
 * A stock change can happen deep inside another module's transaction (confirm a quotation, end a
 * job, close a bill). The event must go out only if THAT transaction commits, and the module that
 * owns the route should not need to know which SKUs moved. So the ledger code calls
 * noteStockChange(trx, ...) while it works, and the route wraps its transaction in
 * withShopStock(), which emits what was noted once - and only once - the transaction has committed.
 * A rolled-back transaction emits nothing: the WeakMap entry dies with the trx object.
 *
 * The event is a refetch signal: ids only, never a quantity or a name (StockChangedEvent).
 */
import { withShop, type Db, type ScopedTx } from '@gsms/db/client.js'
import { STOCK_CHANGED_EVENT, type StockChangedEvent } from '@gsms/contracts/index.js'
import { emitAuthed } from './socket.js'

const pending = new WeakMap<object, StockChangedEvent[]>()

export function noteStockChange(trx: ScopedTx, ev: StockChangedEvent): void {
  if (ev.skuIds.length === 0) return
  const list = pending.get(trx) ?? []
  list.push(ev)
  pending.set(trx, list)
}

/** withShop() that emits the noted stock events after commit. Use it wherever a stock write may happen. */
export async function withShopStock<T>(db: Db, shopId: string, fn: (trx: ScopedTx) => Promise<T>): Promise<T> {
  let noted: StockChangedEvent[] = []
  const result = await withShop(db, shopId, async (trx) => {
    const r = await fn(trx)
    noted = pending.get(trx) ?? []
    return r
  })
  for (const ev of noted) emitAuthed(shopId, STOCK_CHANGED_EVENT, ev)
  return result
}
