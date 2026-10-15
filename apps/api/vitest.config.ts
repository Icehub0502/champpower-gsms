/**
 * Test configuration for apps/api.
 *
 * Two tiers live in this suite:
 *
 *   Tier 1  runs anywhere, including a laptop with no PostgreSQL. Pure
 *           functions, the JWT algorithm pin, the async-handler wrapper, the
 *           startup role check (driven through a fake driver), and the bcrypt
 *           timing property.
 *   Tier 2  needs a real PostgreSQL with migrations 0001-0012 applied and the
 *           connection made as the `gsms_app` role. Gated, and SKIPPED — never
 *           silently passed — when that database is absent.
 *
 * The gate needs care. `apps/api/src/lib/db.ts` throws at import time when
 * DATABASE_URL is unset, so a Tier 1 test that transitively imports it (every
 * route does) cannot run without *some* value in that variable. Setting a
 * placeholder is safe — pg.Pool does not connect until a query is issued — but
 * it would also make `if (process.env.DATABASE_URL)` true everywhere and drag
 * the Tier 2 tests into a run that cannot possibly satisfy them.
 *
 * So the real answer is captured here, once, before the placeholder is
 * installed, and published as GSMS_TEST_DB. Tests gate on that (via
 * `hasDatabase` in src/test/env.ts), never on DATABASE_URL directly.
 */
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import { dbName, selectTestDb } from './src/test/testDbSelect.js'

// vitest is started by `npm test`, which loads no .env, so DATABASE_URL was
// empty here and GSMS_TEST_DB came out '' — every Tier 2 test skipped on a
// machine that had a perfectly good database. Load it explicitly, from the repo
// root, before the tier is decided. fileURLToPath rather than .pathname: on
// Windows the latter yields /C:/... which existsSync does not accept.
const envFile = fileURLToPath(new URL('../../.env', import.meta.url))
if (existsSync(envFile)) process.loadEnvFile(envFile)

// DATABASE_URL (loaded above) is the DEV database. Tier 2 must never touch it:
// the tests insert and delete rows, and the dev DB holds real data. The test
// database comes only from TEST_DATABASE_URL / TEST_DATABASE_ADMIN_URL, read
// from the environment or a gitignored .env.test (real env vars win).
// See packages/db/README.md.
const devDatabaseUrl = process.env.DATABASE_URL?.trim() ?? ''
const testEnvFile = fileURLToPath(new URL('../../.env.test', import.meta.url))
if (existsSync(testEnvFile)) process.loadEnvFile(testEnvFile)

const testDb = selectTestDb({
  testUrl: process.env.TEST_DATABASE_URL,
  testAdminUrl: process.env.TEST_DATABASE_ADMIN_URL,
  devUrl: devDatabaseUrl,
})
if (!testDb.url) console.warn(`\n[vitest] ${testDb.skipReason}\n`)
if (testDb.warning) console.warn(`\n[vitest] WARNING: ${testDb.warning}\n`)
const realDatabaseUrl = testDb.url

// `@champpower/domain`'s package.json points `main` at `./dist/index.js`, and
// nothing in `npm test -w apps/api` rebuilds that dist first. A reviewer
// proved the consequence directly: revert a rule in packages/domain/src,
// leave dist stale, run this suite — green, because every test that exercises
// domain logic was importing the OLD compiled code the whole time. A
// regression test guarding a rule it never actually runs is worse than no
// test: it reads as coverage while proving nothing. `@gsms/contracts` and
// `@gsms/db` export `./src/*.ts` directly and are unaffected; domain is the
// only package in this monorepo resolved through a build artifact, which is
// what makes this alias necessary here and nowhere else.
//
// This does NOT change how production or `tsx watch` resolve the package —
// packages/domain/package.json is untouched on purpose, so a stale dist can
// still bite the dev server or a production build. That is a separate,
// wider-blast-radius decision. This alias only guarantees that THIS test run
// always sees current source.
const domainSrc = fileURLToPath(new URL('../../packages/domain/src/index.ts', import.meta.url))

export default defineConfig({
  resolve: {
    alias: { '@champpower/domain': domainSrc },
  },
  test: {
    include: ['src/**/*.test.ts'],
    // bcrypt at cost 10 in pure JS is slow on purpose; the timing test takes
    // dozens of hashes and must not be cut off half way through.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    env: {
      // A placeholder that parses as a connection string and points at a port
      // nothing listens on, so any test that accidentally issues a query fails
      // loudly (ECONNREFUSED) rather than reaching a real database.
      DATABASE_URL: realDatabaseUrl || 'postgresql://gsms_app@127.0.0.1:1/gsms_no_database',
      GSMS_TEST_DB: realDatabaseUrl ? '1' : '',
      // env.ts reads this name for the admin-gated suites. Always the TEST
      // admin URL, never the dev one; empty skips those suites.
      DATABASE_ADMIN_URL: testDb.adminUrl,
      DEV_DATABASE_NAME: dbName(devDatabaseUrl),
      // Long enough to satisfy the length guard in lib/jwt.ts.
      JWT_SECRET: process.env.JWT_SECRET ?? 'test-secret-that-is-long-enough-for-the-guard-0123456789',
      CORS_ORIGINS: process.env.CORS_ORIGINS ?? 'http://localhost:5173',
      // Matches the production cost, because the timing test is only meaningful
      // at the cost the real hashes were produced at.
      BCRYPT_COST: process.env.BCRYPT_COST ?? '10',
    },
  },
})
