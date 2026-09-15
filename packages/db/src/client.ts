/**
 * The database client, and the only sanctioned way to reach tenant data.
 *
 * Row-level security is the last line of defence, not the only one. Every
 * request that touches shop data runs inside a transaction that has declared
 * which shop it is acting for; RLS then refuses anything outside it. A query
 * issued outside `withShop` sees nothing at all, which is the correct failure:
 * an empty result is recoverable, a leak across branches is not.
 */
import { Kysely, PostgresDialect, sql, type Transaction } from 'kysely'
import pg from 'pg'
import type { DB } from './types.js'

// numeric (OID 1700) must stay a string. Parsed into a JS number it silently
// loses precision, and this schema stores money in numeric(12,2).
pg.types.setTypeParser(1700, (v) => v)
// int8 (OID 20) arrives as a string by default. Every int8 here is a row count
// or a small counter, far inside Number.MAX_SAFE_INTEGER.
pg.types.setTypeParser(20, (v) => Number(v))

export type Db = Kysely<DB>

/**
 * The three kinds of transaction are deliberately NOT interchangeable.
 *
 * They were all `Transaction<DB>` before, which meant `unscoped(db, t =>
 * shopRepo.list(t))` compiled happily and returned every shop of every owner
 * group. The brand is erased at runtime — it exists purely so that passing an
 * identity-table transaction to a function that expects a shop-scoped one is a
 * compile error instead of a cross-tenant read.
 */
declare const txScope: unique symbol

/** Inside `withShop`: app.current_shop_id is set, RLS narrows to that shop. */
export type ScopedTx = Transaction<DB> & { readonly [txScope]: 'scoped' }
/** Inside `withShops`: several shops, READ ONLY, for the owner's group view. */
export type GroupTx = Transaction<DB> & { readonly [txScope]: 'group' }
/** Inside `unscoped`: identity tables only. No shop filter of any kind. */
export type UnscopedTx = Transaction<DB> & { readonly [txScope]: 'unscoped' }

/** @deprecated kept so older imports still resolve; prefer ScopedTx. */
export type Scoped = ScopedTx

/**
 * A query that is still running has already lost the request that asked for it,
 * and an idle transaction holds locks that block everyone else. Both are
 * capped so one stuck statement cannot take the shop's afternoon with it.
 * Overridable because a report or a migration-adjacent job may legitimately
 * need longer than a counter request does.
 */
const STATEMENT_TIMEOUT_MS = Number(process.env.PG_STATEMENT_TIMEOUT_MS ?? 10_000)
const IDLE_TX_TIMEOUT_MS = Number(process.env.PG_IDLE_TX_TIMEOUT_MS ?? 15_000)

export function createDb(connectionString: string): Db {
  return new Kysely<DB>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({
        connectionString,
        max: 10,
        // A request that cannot get a connection should fail fast and be
        // retried, rather than pile up behind a stuck query.
        connectionTimeoutMillis: 5_000,
        idleTimeoutMillis: 30_000,
        // Set on the connection itself, so it applies to every statement on
        // every pooled session without any code having to remember to ask.
        options:
          `-c statement_timeout=${STATEMENT_TIMEOUT_MS} ` +
          `-c idle_in_transaction_session_timeout=${IDLE_TX_TIMEOUT_MS}`,
      }),
    }),
  })
}

/**
 * Run `fn` as the given shop.
 *
 * set_config(..., true) is transaction-local, so the setting is discarded when
 * the transaction ends — including on error. That matters with a connection
 * pool: without the local flag, one request's shop id would stay on the
 * connection and become the next request's default.
 */
export async function withShop<T>(
  db: Db,
  shopId: string,
  fn: (trx: ScopedTx) => Promise<T>,
): Promise<T> {
  return db.transaction().execute(async (trx) => {
    await sql`select set_config('app.current_shop_id', ${shopId}, true)`.execute(trx)
    return fn(trx as ScopedTx)
  })
}

/**
 * Run `fn` able to READ across every shop the given user is a member of — the
 * owner's group view, and nothing else.
 *
 * The shop list is resolved here, from `shop_memberships`, inside the same
 * transaction. It used to be an argument, which meant the caller could pass any
 * array it liked and the database would agree: membership is the permission,
 * and a permission a caller can name is not a permission.
 *
 * Writes are impossible because the transaction declares itself READ ONLY
 * before anything else runs, so PostgreSQL refuses INSERT, UPDATE and DELETE
 * outright. The previous comment here claimed WITH CHECK made writes
 * impossible; that was wrong for DELETE, which PostgreSQL governs with USING
 * alone — a DELETE would have applied to every shop in the list.
 */
export async function withShops<T>(
  db: Db,
  userId: string,
  fn: (trx: GroupTx) => Promise<T>,
): Promise<T> {
  return db.transaction().execute(async (trx) => {
    // Must come before any other statement in the transaction.
    await sql`set transaction read only`.execute(trx)

    const rows = await trx
      .selectFrom('shop_memberships')
      .select(['shop_id'])
      .where('user_id', '=', userId)
      .execute()
    const shopIds = [...new Set(rows.map((r) => r.shop_id))]
    if (shopIds.length === 0) throw new Error('withShops: user has no shop membership')

    const list = `{${shopIds.join(',')}}`
    await sql`select set_config('app.current_shop_ids', ${list}, true)`.execute(trx)
    return fn(trx as GroupTx)
  })
}

/**
 * For the few tables that have no shop_id and therefore no RLS: users,
 * sessions, shops, owner_groups, shop_memberships. Authentication has to read
 * these before any shop is known.
 *
 * Anything with a shop_id goes through withShop. If you find yourself reaching
 * for this to read shop data, that is the bug — and the branded transaction
 * type above now makes the compiler say so.
 */
export async function unscoped<T>(db: Db, fn: (trx: UnscopedTx) => Promise<T>): Promise<T> {
  return db.transaction().execute((trx) => fn(trx as UnscopedTx))
}
