/**
 * WO-001 item 4 — "connect as a superuser and the app must not start", against
 * a real PostgreSQL.
 *
 * TIER 2, and doubly gated: needs GSMS_TEST_DB *and* DATABASE_ADMIN_URL, the
 * latter being a connection as a role that really is a superuser. The Tier 1
 * suite in startupChecks.test.ts already proves the decision logic against every
 * pg_roles answer, including a superuser not called "postgres"; this file proves
 * the same thing end to end against a server that actually says so, which is the
 * only way to be sure the query itself is right (column names, the
 * `rolname = current_user` join, the cast).
 *
 * Run with, for example:
 *   DATABASE_ADMIN_URL=postgresql://postgres:pw@localhost:5432/gsms npm test -w apps/api
 */
import { describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { createDb } from '@gsms/db/client.js'
import { db } from './db.js'
import { assertAppRole } from './startupChecks.js'
import { adminDatabaseUrl, hasDatabase, tier2 } from '../test/env.js'

describe.skipIf(!hasDatabase)(tier2('startup role check, real server'), () => {
  it('accepts the application connection the rest of the suite uses', async () => {
    await expect(assertAppRole(db)).resolves.toBeUndefined()
  })

  describe.skipIf(!adminDatabaseUrl)('with DATABASE_ADMIN_URL set', () => {
    /**
     * THE PASS CRITERION the WO names. The old guard was a regular expression
     * over the connection string; this asks the server. A superuser role that
     * the regex would have waved through — anything not literally spelled
     * "postgres" in the URL — must be refused here on the FACT of the role.
     */
    it('refuses to start on a superuser connection', async () => {
      const adminDb = createDb(adminDatabaseUrl)
      try {
        await expect(assertAppRole(adminDb)).rejects.toThrow(
          /superuser or has BYPASSRLS|expected "gsms_app"/,
        )
      } finally {
        await adminDb.destroy()
      }
    })

    /**
     * Makes the refusal above meaningful rather than accidental.
     *
     * A test that refuses a connection could be refusing it for the boring
     * reason that the role has the wrong NAME. This asserts that the admin
     * connection genuinely carries the privilege the guard is about — so the
     * previous test is proving "refuses a superuser", not "refuses a typo".
     */
    it('is genuinely privileged, so the refusal above is about privilege', async () => {
      const adminDb = createDb(adminDatabaseUrl)
      try {
        const result = await sql<{ role_name: string; rolsuper: boolean; rolbypassrls: boolean }>`
          select current_user::text as role_name, r.rolsuper, r.rolbypassrls
          from pg_roles r where r.rolname = current_user
        `.execute(adminDb)
        const facts = result.rows[0]
        expect(facts).toBeTruthy()
        expect(
          facts!.rolsuper || facts!.rolbypassrls,
          `DATABASE_ADMIN_URL connects as "${facts!.role_name}", which is neither a `
          + 'superuser nor BYPASSRLS. Point it at a privileged role, or the test '
          + 'above proves only that the name is wrong.',
        ).toBe(true)
      } finally {
        await adminDb.destroy()
      }
    })
  })
})
