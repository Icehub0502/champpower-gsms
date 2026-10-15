/**
 * Decides which database the Tier 2 tests may touch. Pure, so it can be tested
 * and so vitest.config.ts stays readable.
 *
 * The rule: Tier 2 runs against TEST_DATABASE_URL and nothing else. It never
 * falls back to DATABASE_URL, because that is the dev database the running
 * server and UX sessions use (and soon real catalog data).
 */

export function dbName(url: string): string {
  try {
    return new URL(url).pathname.replace(/^\//, '')
  } catch {
    return ''
  }
}

export interface TestDbSelection {
  /** '' when Tier 2 must be skipped. */
  url: string
  adminUrl: string
  /** Human-readable reason when url is ''. */
  skipReason: string
}

export function selectTestDb(env: {
  testUrl?: string
  testAdminUrl?: string
  devUrl?: string
}): TestDbSelection {
  const url = env.testUrl?.trim() ?? ''
  const adminUrl = env.testAdminUrl?.trim() ?? ''
  const dev = env.devUrl?.trim() ?? ''

  if (!url) {
    return {
      url: '', adminUrl: '',
      skipReason:
        'TEST_DATABASE_URL is not set: Tier 2 (database) tests are SKIPPED. ' +
        'They never fall back to DATABASE_URL. Run `npm run test-db:setup -w packages/db`, ' +
        'then copy .env.test.example to .env.test and fill it in.',
    }
  }

  const testName = dbName(url)
  if (!testName) throw new Error('TEST_DATABASE_URL has no database name or is unparseable.')

  if (dev && dbName(dev) === testName) {
    throw new Error(
      `Refusing to run: TEST_DATABASE_URL points at database "${testName}", the same as DATABASE_URL. ` +
      'The tests write and delete rows; point TEST_DATABASE_URL at a dedicated database such as gsms_test.')
  }
  if (adminUrl && dbName(adminUrl) !== testName) {
    throw new Error(
      `Refusing to run: TEST_DATABASE_ADMIN_URL database "${dbName(adminUrl)}" differs from ` +
      `TEST_DATABASE_URL database "${testName}".`)
  }
  return { url, adminUrl, skipReason: '' }
}
