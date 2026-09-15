/**
 * WO-001 item 4 — refuse to start as a role row-level security does not apply to.
 *
 * TIER 1: runs with no database. The check's only input is what the server says
 * about `current_user`, so that answer is supplied by a stub driver. This is the
 * seam the WO asks for: "connect as a superuser whose name is NOT postgres (or
 * simulate the pg_roles answer)".
 *
 * What the old code did (WO-001 item 4):
 *
 *     if (/:\/\/postgres[:@]/.test(process.env.DATABASE_URL ?? '')) throw ...
 *
 * A regular expression over the connection STRING. Every case below that is
 * marked "the regex could never see this" is a real way to run the whole system
 * with every tenant policy disabled while the guard stays quiet — and, crucially,
 * while every other test still passes.
 */
import { describe, expect, it } from 'vitest'
import {
  CompiledQuery, Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler,
  type DatabaseConnection, type Driver, type QueryResult,
} from 'kysely'
import type { DB } from '@gsms/db/types.js'
import type { Db } from '@gsms/db/client.js'
import { assertAppRole } from './startupChecks.js'

interface RoleRow { role_name: string; rolsuper: boolean; rolbypassrls: boolean }

/**
 * A Kysely instance that answers every query with `rows`, so `assertAppRole`
 * can be run against any pg_roles answer we like without a server.
 */
function dbAnswering(rows: RoleRow[]): Db {
  const connection: DatabaseConnection = {
    async executeQuery<R>(): Promise<QueryResult<R>> {
      return { rows: rows as unknown as R[] }
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
      yield { rows: rows as unknown as R[] }
    },
  }
  const driver: Driver = {
    async init() {},
    async acquireConnection() { return connection },
    async beginTransaction() {},
    async commitTransaction() {},
    async rollbackTransaction() {},
    async releaseConnection() {},
    async destroy() {},
  }
  return new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (d) => new PostgresIntrospector(d),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  })
}

describe('assertAppRole', () => {
  it('asks the server who it is, rather than parsing the URL', async () => {
    // The whole fix in one assertion: the check must issue a query. A guard
    // built on the connection string issues none, and this stub would never be
    // touched.
    let executed: CompiledQuery | null = null
    const connection: DatabaseConnection = {
      async executeQuery<R>(q: CompiledQuery): Promise<QueryResult<R>> {
        executed = q
        return { rows: [{ role_name: 'gsms_app', rolsuper: false, rolbypassrls: false }] as unknown as R[] }
      },
      // eslint-disable-next-line @typescript-eslint/require-await
      async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> { yield { rows: [] as R[] } },
    }
    const db = new Kysely<DB>({
      dialect: {
        createAdapter: () => new PostgresAdapter(),
        createDriver: () => ({
          async init() {}, async acquireConnection() { return connection },
          async beginTransaction() {}, async commitTransaction() {},
          async rollbackTransaction() {}, async releaseConnection() {}, async destroy() {},
        }),
        createIntrospector: (d) => new PostgresIntrospector(d),
        createQueryCompiler: () => new PostgresQueryCompiler(),
      },
    })

    await expect(assertAppRole(db)).resolves.toBeUndefined()
    expect(executed).not.toBeNull()
    expect(executed!.sql.toLowerCase()).toContain('current_user')
    expect(executed!.sql.toLowerCase()).toContain('pg_roles')
    expect(executed!.sql.toLowerCase()).toContain('rolbypassrls')
  })

  it('starts when the role is gsms_app with neither flag set', async () => {
    const db = dbAnswering([{ role_name: 'gsms_app', rolsuper: false, rolbypassrls: false }])
    await expect(assertAppRole(db)).resolves.toBeUndefined()
  })

  /**
   * THE DISCRIMINATING TEST for item 4, exactly as the WO words it: a superuser
   * that is not called "postgres".
   *
   * Would have FAILED against the old code: DATABASE_URL might read
   * `postgresql://gsms_admin:pw@localhost/gsms`, which `/:\/\/postgres[:@]/`
   * does not match (the character after "postgres" is "_", not ":" or "@"), so
   * the app started, RLS applied to nothing, and every branch could read every
   * other branch's data with no visible symptom.
   */
  it('refuses a superuser whose name is not "postgres"', async () => {
    const db = dbAnswering([{ role_name: 'gsms_admin', rolsuper: true, rolbypassrls: false }])
    await expect(assertAppRole(db)).rejects.toThrow(/expected "gsms_app"/)
  })

  /**
   * Would have FAILED against the old code: a role called anything at all with
   * BYPASSRLS granted. The string "postgres" never appears, and BYPASSRLS is
   * not a property of a URL — it is a property of a role, knowable only by
   * asking the server.
   */
  it('refuses a role with BYPASSRLS even under the expected name', async () => {
    const db = dbAnswering([{ role_name: 'gsms_app', rolsuper: false, rolbypassrls: true }])
    await expect(assertAppRole(db)).rejects.toThrow(/BYPASSRLS/)
  })

  it('refuses a superuser even under the expected name', async () => {
    const db = dbAnswering([{ role_name: 'gsms_app', rolsuper: true, rolbypassrls: false }])
    await expect(assertAppRole(db)).rejects.toThrow(/superuser or has BYPASSRLS/)
  })

  /**
   * Would have FAILED against the old code: this is the PGUSER case from the WO.
   * `postgresql://localhost/gsms` names no user at all, so libpq falls back to
   * PGUSER — which is `postgres` on every developer machine and in every
   * "just get it running" shell. The regex sees a URL with no user in it and is
   * satisfied. The server, asked directly, says `postgres`.
   */
  it('refuses the postgres role arriving via PGUSER with no user in the URL', async () => {
    const db = dbAnswering([{ role_name: 'postgres', rolsuper: true, rolbypassrls: false }])
    await expect(assertAppRole(db)).rejects.toThrow(/expected "gsms_app"/)
  })

  /**
   * The table owner. Owners are exempt from RLS on their own tables unless the
   * table is FORCEd, and "is this role the owner of those 55 tables" is not
   * something a connection string can express either. Caught here by the name
   * check, which is why the name check must stay strict rather than becoming
   * "any non-superuser".
   */
  it('refuses the schema-owning role', async () => {
    const db = dbAnswering([{ role_name: 'gsms_owner', rolsuper: false, rolbypassrls: false }])
    await expect(assertAppRole(db)).rejects.toThrow(/expected "gsms_app"/)
  })

  /**
   * pg_roles returning nothing means the question was not answered. Treating
   * "unknown" as "fine" is how a guard becomes decorative.
   */
  it('refuses to start when the role cannot be determined', async () => {
    const db = dbAnswering([])
    await expect(assertAppRole(db)).rejects.toThrow(/could not determine the database role/)
  })
})
