/**
 * The Tier 1 / Tier 2 gate, in one place.
 *
 * `hasDatabase` is false on a machine with no PostgreSQL. Every integration
 * suite is wrapped in `describe.skipIf(!hasDatabase)` with a title that names
 * what goes unproven, so a run without a database reports those tests as
 * SKIPPED. A skipped test must never read as a passing one — the whole point of
 * WO-001 is that fifteen holes went green under a review that was not looking
 * hard enough.
 *
 * See vitest.config.ts for why this reads GSMS_TEST_DB and not DATABASE_URL.
 */
export const hasDatabase = process.env.GSMS_TEST_DB === '1'

/**
 * A separate, more privileged connection, used only by the test that proves the
 * app refuses to start as a superuser. Absent by default; that test skips.
 */
export const adminDatabaseUrl = process.env.DATABASE_ADMIN_URL?.trim() ?? ''

/** Prefix for a skipped suite, so the reason is visible in the run output. */
export function tier2(title: string): string {
  return `[tier2/db] ${title}`
}
