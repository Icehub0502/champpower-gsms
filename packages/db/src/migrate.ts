/**
 * Migration runner.
 *
 * Applies every .sql file in ../migrations, in filename order, each inside its
 * own transaction. PostgreSQL can roll back DDL, so a file that fails part way
 * leaves the database exactly as it was — the reason the whole project is on
 * PostgreSQL rather than MySQL, where a failed migration leaves a half-changed
 * schema and a manual repair job.
 *
 * Applied files are recorded with a checksum. Editing a migration that has
 * already run is refused rather than silently ignored: two databases claiming
 * the same version with different schemas is the failure that costs a weekend.
 */
import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import pg from 'pg'

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations')


/**
 * What the connection string actually points at, with the password removed.
 *
 * "password authentication failed" says nothing about which user, host or
 * database was tried, so a wrong DATABASE_URL and a wrong password look
 * identical. Printing the parsed target turns ten minutes of guessing into one
 * glance.
 */
export function describeTarget(url: string): string {
  try {
    const u = new URL(url)
    const user = decodeURIComponent(u.username) || '(no user)'
    const db = u.pathname.replace(/^\//, '') || '(no database)'
    const pw = u.password ? `set, ${u.password.length} chars` : 'MISSING'
    return `${user}@${u.hostname}:${u.port || '5432'}/${db}  (password: ${pw})`
  } catch {
    // Never echo the value: it is a connection string and holds the password.
    // Show its shape only, which is enough to spot stray quotes or spaces.
    const shape = url.replace(/:\/\/([^:@/]*):[^@]*@/, '://$1:***@')
    const hint = url !== url.trim() ? ' (has leading/trailing whitespace)' : /^["']|["']$/.test(url) ? ' (wrapped in quotes)' : ''
    return `UNPARSEABLE${hint} — check for quotes or spaces around the value. Redacted: ${JSON.stringify(shape)}`
  }
}

/**
 * Which connection to use for setup work.
 *
 * Migrations and seeding are administrative: they create tables and write rows
 * that row-level security would otherwise refuse. gsms_app deliberately has
 * neither CREATE on the schema nor a way past RLS — that is the whole point of
 * the split, and it is what makes the isolation tests meaningful.
 *
 * So setup runs as the superuser, and only the running application ever
 * connects as gsms_app.
 */
export function adminUrl(): string {
  const url = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL
  if (!url) {
    console.error('Neither DATABASE_ADMIN_URL nor DATABASE_URL is set. Is .env present at the repo root?')
    process.exit(1)
  }
  if (!process.env.DATABASE_ADMIN_URL) {
    console.warn('DATABASE_ADMIN_URL is not set; falling back to DATABASE_URL.')
    console.warn('That will fail on anything the application role is not allowed to do.')
  }
  return url
}

const LEDGER = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    filename    text PRIMARY KEY,
    checksum    text NOT NULL,
    applied_at  timestamptz NOT NULL DEFAULT now(),
    duration_ms integer NOT NULL
  )`

function sha(text: string): string {
  // Newlines are normalised so a checkout with CRLF does not read as a change.
  return createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex').slice(0, 16)
}

export async function migrate(connectionString: string, opts: { dryRun?: boolean } = {}) {
  const client = new pg.Client({ connectionString })
  // RAISE NOTICE from a migration (e.g. 0024's stale-row count) is otherwise dropped.
  // 42P07 "relation already exists, skipping" is the ledger's own CREATE TABLE IF NOT EXISTS: noise on every run.
  client.on('notice', (n) => { if (n.code !== '42P07') console.log('NOTICE:', n.message) })
  await client.connect()
  try {
    await client.query(LEDGER)

    const files = (await readdir(MIGRATIONS_DIR)).filter(f => f.endsWith('.sql')).sort()
    const { rows } = await client.query<{ filename: string; checksum: string }>(
      'SELECT filename, checksum FROM schema_migrations')
    const applied = new Map(rows.map(r => [r.filename, r.checksum]))

    // Check every already-applied file before running anything new. Finding a
    // modified migration after three new ones have run is a worse position.
    for (const file of files) {
      const seen = applied.get(file)
      if (!seen) continue
      const now = sha(await readFile(join(MIGRATIONS_DIR, file), 'utf8'))
      if (now !== seen) {
        throw new Error(
          `${file} has changed since it was applied (${seen} -> ${now}).\n` +
          `Migrations are append-only. Add a new file that alters what this one created.`)
      }
    }

    const pending = files.filter(f => !applied.has(f))
    if (pending.length === 0) {
      console.log(`up to date — ${files.length} migration(s) applied`)
      return
    }
    if (opts.dryRun) {
      console.log('would apply:'); pending.forEach(f => console.log('  ' + f)); return
    }

    for (const file of pending) {
      const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8')
      const started = Date.now()
      process.stdout.write(`  ${file} ... `)
      try {
        await client.query('BEGIN')
        await client.query(sql)
        const ms = Date.now() - started
        await client.query(
          'INSERT INTO schema_migrations (filename, checksum, duration_ms) VALUES ($1, $2, $3)',
          [file, sha(sql), ms])
        await client.query('COMMIT')
        console.log(`ok (${ms} ms)`)
      } catch (err) {
        await client.query('ROLLBACK')
        console.log('FAILED')
        // The rollback already undid it. Say so, so nobody starts hand-repairing
        // a database that is in fact untouched.
        console.error(`\n${file} failed and was rolled back. The database is unchanged.\n`)
        throw err
      }
    }
    console.log(`applied ${pending.length} migration(s)`)
  } finally {
    await client.end()
  }
}

// Run-as-script check. Comparing against `file://${process.argv[1]}` looks
// equivalent and is not: on Windows argv[1] is C:\dev\... while import.meta.url
// is file:///C:/dev/..., so the two never match and the script exits silently
// having done nothing. pathToFileURL normalises both sides.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

if (invokedDirectly) {
  const url = adminUrl()
  console.log(`connecting to ${describeTarget(url)}`)
  migrate(url, { dryRun: process.argv.includes('--dry-run') })
    .catch(err => {
      console.error(`\n${err.message}`)
      console.error(`while connecting to ${describeTarget(url)}\n`)
      process.exit(1)
    })
}
