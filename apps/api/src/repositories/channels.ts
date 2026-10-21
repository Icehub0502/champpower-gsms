/**
 * payment_channels (0025, Ice 20 Oct P3.2 B3): the shop's own list of ways to be
 * paid. RLS scopes every query to the caller's shop. Never deleted - payments
 * reference them - only deactivated.
 */
import { sql } from 'kysely'
import type { ScopedTx } from '@gsms/db/client.js'

export interface ChannelRow {
  id: string
  name: string
  kind: string
  surcharge_percent: string
  is_active: boolean
  sort_order: number
}

const COLS = ['id', 'name', 'kind', 'surcharge_percent', 'is_active', 'sort_order'] as const

/** A shop that has none yet gets its one cash channel (idempotent: only inserts into an empty list). */
export async function ensureSeeded(trx: ScopedTx, shopId: string): Promise<void> {
  await sql`select seed_payment_channels(${shopId}::uuid)`.execute(trx)
}

export async function list(trx: ScopedTx, includeInactive: boolean): Promise<ChannelRow[]> {
  let q = trx.selectFrom('payment_channels').select(COLS)
  if (!includeInactive) q = q.where('is_active', '=', true)
  return q.orderBy('sort_order', 'asc').orderBy('name', 'asc').limit(200).execute()
}

export async function getMany(trx: ScopedTx, ids: readonly string[]): Promise<ChannelRow[]> {
  if (ids.length === 0) return []
  return trx.selectFrom('payment_channels').select(COLS).where('id', 'in', [...ids]).execute()
}

/** Lock one channel while it is renamed / deactivated. */
export async function lockOne(trx: ScopedTx, id: string): Promise<ChannelRow | undefined> {
  return trx.selectFrom('payment_channels').select(COLS).where('id', '=', id).forUpdate().executeTakeFirst()
}

export async function countActive(trx: ScopedTx): Promise<number> {
  const r = await trx.selectFrom('payment_channels').select(sql<string>`count(*)`.as('n')).where('is_active', '=', true).executeTakeFirstOrThrow()
  return Number(r.n)
}

export async function nextSortOrder(trx: ScopedTx): Promise<number> {
  const r = await trx.selectFrom('payment_channels').select(sql<number | null>`max(sort_order)`.as('m')).executeTakeFirstOrThrow()
  return (r.m ?? -1) + 1
}

export async function insert(trx: ScopedTx, c: { shopId: string; name: string; kind: string; surchargePercent: string; sortOrder: number }): Promise<ChannelRow> {
  return trx.insertInto('payment_channels')
    .values({ shop_id: c.shopId, name: c.name, kind: c.kind, surcharge_percent: c.surchargePercent, sort_order: c.sortOrder })
    .returning(COLS).executeTakeFirstOrThrow()
}

export async function patch(trx: ScopedTx, id: string, p: { name?: string; surchargePercent?: string; isActive?: boolean }): Promise<ChannelRow> {
  const set: Record<string, unknown> = {}
  if (p.name !== undefined) set.name = p.name
  if (p.surchargePercent !== undefined) set.surcharge_percent = p.surchargePercent
  if (p.isActive !== undefined) set.is_active = p.isActive
  return trx.updateTable('payment_channels').set(set).where('id', '=', id).returning(COLS).executeTakeFirstOrThrow()
}

export async function setSortOrder(trx: ScopedTx, id: string, order: number): Promise<void> {
  await trx.updateTable('payment_channels').set({ sort_order: order }).where('id', '=', id).execute()
}
