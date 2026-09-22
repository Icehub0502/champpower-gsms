/**
 * One place to write `audit_logs`.
 *
 * CLAUDE.md §9: every mutation that touches money, stock, documents — or, here,
 * the intake path a car's whole history hangs off — records who did what to
 * which row, and what the value was before and after. The row carries a
 * shop_id and therefore RLS, so it can only be written inside a `withShop`
 * transaction: the SAME transaction as the change it describes, or the log and
 * the data can disagree after a rollback.
 *
 * What must never go in here: customer names, phone numbers, plates
 * (CLAUDE.md §12). `before`/`after` carry ids and operational values — a bay,
 * a queue number, a status — not personal data. The entity id is enough to
 * find the person's record for anyone who is already allowed to see it.
 */
import type { ScopedTx } from '@gsms/db/client.js'

export interface AuditEntry {
  shopId: string
  actorId: string | null
  action: string
  entityType: string
  entityId: string | null
  before?: unknown
  after?: unknown
}

export async function writeAudit(trx: ScopedTx, entry: AuditEntry): Promise<void> {
  await trx
    .insertInto('audit_logs')
    .values({
      shop_id: entry.shopId,
      actor_id: entry.actorId,
      action: entry.action,
      entity_type: entry.entityType,
      entity_id: entry.entityId,
      before: entry.before === undefined ? null : JSON.stringify(entry.before),
      after: entry.after === undefined ? null : JSON.stringify(entry.after),
    })
    .execute()
}
