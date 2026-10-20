/**
 * The seam between billing and the stock ledger (WO-006, not built yet).
 *
 * Closing a bill must hand back the stock reserved for approved lines that were
 * not done (CLAUDE.md s5.1 rule 7, s6 rule 2). The ledger does not exist in
 * apps/api yet (no reserve / unreserve code, and catalog_items has no sku_id), so
 * nothing can have been reserved and this is a TOLERATED NO-OP (known gap G6):
 * it must not error and must not write a junk stock_moves row.
 *
 * When WO-006 lands, implement here, in the same transaction the caller holds and
 * as the LAST step of the lock order (jobs -> documents -> document_lines -> stock):
 * for each line with a sku_id, `unreserve` min(reservedForLine, qty - fulfilledQty)
 * with idempotency_key `unreserve:receipt:{receiptId}:{lineId}`, cancel the line's
 * purchase suggestion, and report ISSUED-but-unused stock (AC-H4) without blocking.
 * Returns how many lines it actually released, so the caller can tell the screen.
 */
import type { ScopedTx } from '@gsms/db/client.js'

export interface UnreserveLine {
  lineId: string
  sourceLineId: string | null
  skuId: string | null
  qty: string
  fulfilledQty: string
}

export async function releaseUnusedReservations(
  _trx: ScopedTx,
  _input: { shopId: string; receiptId: string; actorId: string; lines: readonly UnreserveLine[] },
): Promise<number> {
  return 0
}
