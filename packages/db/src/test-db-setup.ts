/**
 * Creates and migrates the dedicated TEST database (default name gsms_test).
 *
 *   npm run test-db:setup -w packages/db
 *
 * Reads TEST_DATABASE_ADMIN_URL (a superuser URL whose database is the test
 * database) from the environment or the gitignored repo-root .env.test. It
 * never reads DATABASE_ADMIN_URL as a target, and it aborts if the target name
 * equals the database in DATABASE_URL (the dev database): this script creates
 * roles' grants and applies migrations, and must never be pointed at dev.
 *
 * Idempotent: safe to re-run; it only creates what is missing and applies
 * pending migrations.
 */
import pg from 'pg'
import { describeTarget, migrate } from './migrate.js'

function dbOf(url: string): string {
  return new URL(url).pathname.replace(/^\//, '')
}

const adminUrl = process.env.TEST_DATABASE_ADMIN_URL?.trim()
if (!adminUrl) {
  console.error('TEST_DATABASE_ADMIN_URL is not set. Copy .env.test.example to .env.test and fill it in.')
  process.exit(1)
}

const testDb = dbOf(adminUrl)
const devDb = process.env.DATABASE_URL ? dbOf(process.env.DATABASE_URL) : ''
// The name is interpolated into CREATE DATABASE (identifiers cannot be bound),
// so it is restricted to a safe alphabet.
if (!/^[a-z][a-z0-9_]*$/.test(testDb)) {
  console.error(`Refusing: test database name "${testDb}" must match [a-z][a-z0-9_]*.`)
  process.exit(1)
}
if (testDb === devDb || testDb === 'postgres' || testDb === 'gsms') {
  console.error(`Refusing: "${testDb}" is the dev/maintenance database, not a test database.`)
  process.exit(1)
}

async function main() {
  console.log(`target: ${describeTarget(adminUrl!)}`)

  // 1. Create the database if missing, from the maintenance database.
  const maint = new URL(adminUrl!)
  maint.pathname = '/postgres'
  const m = new pg.Client({ connectionString: maint.toString() })
  await m.connect()
  try {
    const { rowCount } = await m.query('SELECT 1 FROM pg_database WHERE datname = $1', [testDb])
    if (rowCount === 0) {
      await m.query(`CREATE DATABASE ${testDb}`)
      console.log(`created database ${testDb}`)
    } else {
      console.log(`database ${testDb} already exists`)
    }
  } finally {
    await m.end()
  }

  // 2. Role + grants, mirroring packages/db/setup-role.sql. Roles are
  //    cluster-wide, so gsms_app normally exists already (shared with dev, same
  //    password). Grants and default privileges are PER DATABASE, so they are
  //    applied here, before the migrations create tables.
  const c = new pg.Client({ connectionString: adminUrl })
  await c.connect()
  try {
    const { rowCount } = await c.query(`SELECT 1 FROM pg_roles WHERE rolname = 'gsms_app'`)
    if (rowCount === 0) {
      await c.query('CREATE ROLE gsms_app NOLOGIN')
      console.log('created role gsms_app as NOLOGIN. Set its password yourself:')
      console.log(`  psql -U postgres -c "ALTER ROLE gsms_app LOGIN PASSWORD '...'"`)
    } else {
      console.log('role gsms_app exists')
    }
    await c.query(`
      GRANT USAGE ON SCHEMA public TO gsms_app;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO gsms_app;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO gsms_app;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO gsms_app;`)
    const { rows } = await c.query<{ rolsuper: boolean }>(`SELECT rolsuper FROM pg_roles WHERE rolname = 'gsms_app'`)
    if (rows[0]?.rolsuper) throw new Error('gsms_app is a superuser; it would bypass RLS. Fix the role.')
  } finally {
    await c.end()
  }

  // 3. Migrations.
  await migrate(adminUrl!)

  // 4. Cover anything that predates the default privileges (re-runs).
  const g = new pg.Client({ connectionString: adminUrl })
  await g.connect()
  try {
    await g.query(`
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO gsms_app;
      GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO gsms_app;
      GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO gsms_app;`)
  } finally {
    await g.end()
  }
  console.log(`\n${testDb} is ready. Run: npm test -w apps/api`)
}

main().catch(err => {
  console.error(`\n${err.message}`)
  process.exit(1)
})
