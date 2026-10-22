/**
 * The seam between billing and the stock ledger (WO-006).
 *
 * Closing a bill hands back the stock reserved for approved lines that were not done (CLAUDE.md
 * s5.1 rule 7, s6 rule 2). The caller holds its transaction and has already taken the job and the
 * receipt; this runs as the LAST step of the lock order (jobs -> documents -> document_lines -> stock).
 *
 * The work is in stockReservation.releaseForReceipt: for each approved-but-not-done line it
 * `unreserve`s min(reservedForLine, qty - fulfilledQty) (the unfinished share of each component for a
 * set) with idempotency_key `unreserve:receipt:{receiptId}:{lineId}`, closes the line's shortfall
 * suggestion, and writes parts that were ISSUED but not used (AC-H4) to the audit log without
 * blocking. Returns how many quotation lines it actually released, so the caller can tell the screen.
 */
import type { ScopedTx } from '@gsms/db/client.js'
import { releaseForReceipt } from './stockReservation.js'

export interface UnreserveLine {
  lineId: string
  sourceLineId: string | null
  skuId: string | null
  qty: string
  fulfilledQty: string
}

export async function releaseUnusedReservations(
  trx: ScopedTx,
  input: { shopId: string; receiptId: string; actorId: string; lines: readonly UnreserveLine[] },
): Promise<number> {
  return releaseForReceipt(trx, {
    shopId: input.shopId,
    receiptId: input.receiptId,
    actorId: input.actorId,
    lines: input.lines.map((l) => ({ lineId: l.lineId, sourceLineId: l.sourceLineId, qty: l.qty, fulfilledQty: l.fulfilledQty })),
  })
}
