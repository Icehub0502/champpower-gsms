/**
 * Payment channel settings (Ice 20 Oct, P3.2 B3). List, create, rename / change
 * the surcharge / deactivate, reorder. No delete: payments reference channels.
 * Every change is audited (a surcharge percent moves money).
 */
import { formatSatang, toSatang } from '@champpower/domain'
import type { PaymentChannel } from '@gsms/contracts/index.js'
import type { ScopedTx } from '@gsms/db/client.js'
import * as repo from '../repositories/channels.js'
import { writeAudit } from './audit.js'

export type ChannelError =
  | { code: 'channel_not_found' }
  | { code: 'channel_name_taken' }
  | { code: 'last_active_channel' }

type Result<T> = { ok: true; value: T } | { ok: false; error: ChannelError }

export const channelOut = (r: repo.ChannelRow): PaymentChannel => ({
  id: r.id, name: r.name, kind: r.kind as PaymentChannel['kind'],
  surchargePercent: r.surcharge_percent, active: r.is_active, sortOrder: r.sort_order,
})

/** "3" -> "3.00": the canonical numeric(5,2) text. */
const percentText = (p: string): string => formatSatang(toSatang(p))

export async function list(trx: ScopedTx, shopId: string, includeInactive: boolean): Promise<PaymentChannel[]> {
  await repo.ensureSeeded(trx, shopId)
  return (await repo.list(trx, includeInactive)).map(channelOut)
}

export async function create(
  trx: ScopedTx, shopId: string, actorId: string,
  input: { name: string; kind: PaymentChannel['kind']; surchargePercent: string },
): Promise<Result<PaymentChannel>> {
  await repo.ensureSeeded(trx, shopId)
  const row = await repo.insert(trx, {
    shopId, name: input.name, kind: input.kind, surchargePercent: percentText(input.surchargePercent),
    sortOrder: await repo.nextSortOrder(trx),
  })
  await writeAudit(trx, {
    shopId, actorId, action: 'payment_channel_created', entityType: 'payment_channels', entityId: row.id,
    after: { name: row.name, kind: row.kind, surchargePercent: row.surcharge_percent },
  })
  return { ok: true, value: channelOut(row) }
}

export async function patch(
  trx: ScopedTx, shopId: string, actorId: string, id: string,
  p: { name?: string; surchargePercent?: string; isActive?: boolean },
): Promise<Result<PaymentChannel>> {
  const before = await repo.lockOne(trx, id)
  if (!before) return { ok: false, error: { code: 'channel_not_found' } }
  // Never leave the shop with nothing to take money through.
  if (p.isActive === false && before.is_active && (await repo.countActive(trx)) <= 1) {
    return { ok: false, error: { code: 'last_active_channel' } }
  }
  const row = await repo.patch(trx, id, {
    name: p.name, surchargePercent: p.surchargePercent === undefined ? undefined : percentText(p.surchargePercent), isActive: p.isActive,
  })
  await writeAudit(trx, {
    shopId, actorId, action: 'payment_channel_changed', entityType: 'payment_channels', entityId: id,
    before: { name: before.name, surchargePercent: before.surcharge_percent, isActive: before.is_active },
    after: { name: row.name, surchargePercent: row.surcharge_percent, isActive: row.is_active },
  })
  return { ok: true, value: channelOut(row) }
}

/** `ids` first, in that order; any channel not named follows in its old order. */
export async function reorder(trx: ScopedTx, shopId: string, actorId: string, ids: readonly string[]): Promise<Result<PaymentChannel[]>> {
  const unique = [...new Set(ids)]
  const found = await repo.getMany(trx, unique)
  if (found.length !== unique.length) return { ok: false, error: { code: 'channel_not_found' } }
  const all = await repo.list(trx, true)
  const rest = all.filter((c) => !unique.includes(c.id)).map((c) => c.id)
  const order = [...unique, ...rest]
  for (const [i, id] of order.entries()) await repo.setSortOrder(trx, id, i)
  await writeAudit(trx, { shopId, actorId, action: 'payment_channels_reordered', entityType: 'payment_channels', entityId: null, after: { ids: order } })
  return { ok: true, value: (await repo.list(trx, true)).map(channelOut) }
}
