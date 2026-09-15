/**
 * Checks that must hold before the port opens.
 *
 * These are the questions whose wrong answer is invisible at runtime: the app
 * works, the tests pass, and every tenant boundary is quietly gone.
 */
import { sql } from 'kysely'
import type { Db } from '@gsms/db/client.js'
import { assertTokenConfig } from './jwt.js'

/**
 * Everything that must hold before the port opens, in one call.
 *
 * Cheap, synchronous configuration first: there is no point asking the database
 * who it is if the process could not sign a token anyway.
 */
export async function runStartupChecks(db: Db): Promise<void> {
  assertTokenConfig()
  await assertAppRole(db)
}

/** Overridable so a test can point the check at its own role; strict default. */
const EXPECTED_ROLE = process.env.DB_APP_ROLE ?? 'gsms_app'

interface RoleFacts {
  role_name: string
  rolsuper: boolean
  rolbypassrls: boolean
}

/**
 * Refuse to run as a role that row-level security does not apply to.
 *
 * The previous guard was a regular expression over DATABASE_URL looking for the
 * literal name "postgres". It could not see a superuser called anything else,
 * a role with BYPASSRLS, the role that owns the tables (owners bypass RLS on
 * their own tables), or PGUSER=postgres in the environment with no user in the
 * URL at all — which is what anyone debugging reaches for first. The only
 * trustworthy source is the server: ask it who we actually are.
 */
export async function assertAppRole(db: Db): Promise<void> {
  const result = await sql<RoleFacts>`
    select current_user::text as role_name, r.rolsuper, r.rolbypassrls
    from pg_roles r
    where r.rolname = current_user
  `.execute(db)

  const facts = result.rows[0]
  if (!facts) {
    throw new Error('could not determine the database role; refusing to start')
  }
  if (facts.role_name !== EXPECTED_ROLE) {
    throw new Error(
      `database role is "${facts.role_name}", expected "${EXPECTED_ROLE}". ` +
      'The API must connect as the application role, or row-level security ' +
      'will not apply to it.',
    )
  }
  if (facts.rolsuper || facts.rolbypassrls) {
    throw new Error(
      `database role "${facts.role_name}" is a superuser or has BYPASSRLS. ` +
      'Every tenant policy would be ignored. Refusing to start.',
    )
  }
}
