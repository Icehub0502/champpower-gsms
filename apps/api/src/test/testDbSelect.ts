/**
 * Decides which database the Tier 2 tests may touch. Pure, so it can be tested
 * and so vitest.config.ts stays readable.
 *
 * The rule: Tier 2 runs against TEST_DATABASE_URL and nothing else. It never
 * falls back to DATABASE_URL, because that is the dev database the running
 * server and UX sessions use (and soon real catalog data).
 *
 * Error messages never include a URL: a connection string carries a password.
 */

/** Names that are never a test database, whatever DATABASE_URL says. */
const FORBIDDEN_NAMES = new Set(['gsms', 'postgres'])

/** Decoded database name; '' when the URL or the percent-encoding is invalid. */
export function dbName(url: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname.replace(/^\//, ''))
  } catch {
    return ''
  }
}

/** host:port with the default port made explicit; '' when unparseable. */
function hostPort(url: string): string {
  try {
    const u = new URL(url)
    return `${u.hostname.toLowerCase()}:${u.port || '5432'}`
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
  /** Non-fatal but loud; '' when none. */
  warning: string
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
      url: '', adminUrl: '', warning: '',
      skipReason:
        'TEST_DATABASE_URL is not set: Tier 2 (database) tests are SKIPPED. ' +
        'They never fall back to DATABASE_URL. Run `npm run test-db:setup -w packages/db`, ' +
        'then copy .env.test.example to .env.test and fill it in.',
    }
  }

  const testName = dbName(url)
  if (!testName) {
    throw new Error('TEST_DATABASE_URL is unparseable or has no usable database name (URL not shown: it holds a password).')
  }
  if (FORBIDDEN_NAMES.has(testName.toLowerCase())) {
    throw new Error(
      `Refusing to run: TEST_DATABASE_URL names database "${testName}", which is never a test database. ` +
      'Use a dedicated database such as gsms_test.')
  }
  if (dev && dbName(dev) === testName) {
    throw new Error(
      `Refusing to run: TEST_DATABASE_URL points at database "${testName}", the same as DATABASE_URL. ` +
      'The tests write and delete rows; point TEST_DATABASE_URL at a dedicated database such as gsms_test.')
  }
  if (adminUrl) {
    if (dbName(adminUrl) !== testName || hostPort(adminUrl) !== hostPort(url)) {
      throw new Error(
        'Refusing to run: TEST_DATABASE_ADMIN_URL differs from TEST_DATABASE_URL in host, port or database name. ' +
        'Both must point at the same test database.')
    }
  }
  return {
    url, adminUrl, skipReason: '',
    warning: adminUrl ? '' :
      'TEST_DATABASE_URL is set but TEST_DATABASE_ADMIN_URL is not: the admin-gated suites ' +
      '(quotation, catalog, lock order, ...) are SKIPPED, so most of Tier 2 is NOT running.',
  }
}
