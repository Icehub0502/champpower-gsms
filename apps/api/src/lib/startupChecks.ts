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
  assertRefreshTtl()
  assertCorsConfig()
  await assertAppRole(db)
  await assertReadCommitted(db)
}

/**
 * The refresh window has to stay inside the range the shop agreed to.
 *
 * WO-001 deliberately cut this from 30 days to 14: the garage runs shared
 * machines at the counter and phones that get lost, and rotation means a person
 * who uses the system daily never meets the ceiling at all — the only people it
 * logs out are the ones who have been away a fortnight, who should be proving
 * who they are again anyway.
 *
 * That decision lived in a code default and was silently undone by a `.env`
 * that still said 30d. A default only protects the case where nobody sets the
 * variable, which is never true in a real deployment. So the range is checked,
 * and a value outside it stops the boot rather than quietly widening the window
 * a stolen token stays useful in.
 */
const MAX_REFRESH_DAYS = 14

export function assertRefreshTtl(ttl = process.env.JWT_REFRESH_TTL ?? '14d'): void {
  const m = /^(\d+)([smhd])$/.exec(ttl)
  if (!m) {
    throw new Error(
      `JWT_REFRESH_TTL is "${ttl}", which is not a duration like "14d". Refusing to start.`,
    )
  }
  const ms = Number(m[1]) * { s: 1e3, m: 6e4, h: 36e5, d: 864e5 }[m[2] as 's' | 'm' | 'h' | 'd']
  const days = ms / 864e5
  if (days <= 0 || days > MAX_REFRESH_DAYS) {
    throw new Error(
      `JWT_REFRESH_TTL is "${ttl}" (${days} days); the agreed maximum is ` +
      `${MAX_REFRESH_DAYS} days (docs/ARCHITECTURE.md §7). Refusing to start. ` +
      'Widening this is a security decision, not a configuration tweak.',
    )
  }
}

/**
 * CORS must name real origins, and must not be defeated by a near-miss.
 *
 * Two failures this closes, both of which have already happened here:
 *
 *   `*`              — app.ts builds its allow-list by splitting CORS_ORIGINS,
 *                      so a literal asterisk becomes an allowed origin and,
 *                      paired with `credentials: true`, is an account-takeover
 *                      path rather than a loose setting.
 *   `CORS_ORIGIN`    — singular, no S. Nothing reads it. Someone sets it,
 *                      sees a variable with a plausible name, and believes the
 *                      policy is configured while the real one is untouched.
 *                      A variable that looks like configuration but is inert is
 *                      worse than one that is missing.
 *
 * Deleting the stray value from one `.env` fixes today; refusing to boot on it
 * fixes every `.env` anyone writes afterwards.
 */
export function assertCorsConfig(env: NodeJS.ProcessEnv = process.env): void {
  const raw = env.CORS_ORIGINS ?? ''
  const origins = raw.split(',').map((s) => s.trim()).filter(Boolean)

  if (origins.length === 0) {
    throw new Error('CORS_ORIGINS is not set; refusing to start with an open CORS policy')
  }
  if (origins.includes('*')) {
    throw new Error(
      'CORS_ORIGINS contains "*". With credentials enabled that allows any site ' +
      'to make authenticated requests as a signed-in user. Name the real origins.',
    )
  }
  if (env.CORS_ORIGIN !== undefined) {
    throw new Error(
      'CORS_ORIGIN (singular) is set, and nothing reads it — the variable this ' +
      'application uses is CORS_ORIGINS. Remove it, so nobody believes the CORS ' +
      'policy is configured when it is not.',
    )
  }
}

/**
 * Refuse to run unless new transactions default to READ COMMITTED.
 *
 * The queue-number allocator (repositories/jobs.ts lockQueueDay + nextQueueNo)
 * is correct ONLY under READ COMMITTED: each statement takes a fresh snapshot,
 * so once the advisory lock is granted, max(queue_no) sees the row the previous
 * holder just committed. Under REPEATABLE READ or SERIALIZABLE the snapshot is
 * taken at the transaction's first statement — before the lock — so every
 * waiter reads the same stale max, and the starvation fixed in c0ad86b returns:
 * staff told "เลขคิวนี้มีรถคันอื่นแล้ว" about numbers nobody typed.
 *
 * Nothing in the code pins READ COMMITTED; it is only PostgreSQL's default. The
 * tier-2 test (lib/isolation.integration.test.ts) catches a change in THIS
 * repository. It cannot catch the person who runs
 * `ALTER DATABASE gsms SET default_transaction_isolation = 'repeatable read'` on
 * the production server one evening — this check does, the next time the API
 * starts, before a single check-in is taken.
 */
export async function assertReadCommitted(db: Db): Promise<void> {
  const result = await sql<{ level: string }>`
    select current_setting('default_transaction_isolation') as level
  `.execute(db)
  const level = result.rows[0]?.level
  if (level !== 'read committed') {
    throw new Error(
      `default_transaction_isolation is "${level ?? 'unknown'}", expected "read committed". ` +
      'The queue-number allocator depends on it (see lockQueueDay in repositories/jobs.ts); ' +
      'under a stricter level concurrent check-ins are refused numbers nobody typed. ' +
      'Refusing to start. Undo the setting (ALTER DATABASE / ALTER ROLE ... RESET ' +
      'default_transaction_isolation) or change the allocator — not this check.',
    )
  }
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
