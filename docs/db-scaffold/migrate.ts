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
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations')

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

if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env.DATABASE_URL
  if (!url) { console.error('DATABASE_URL is not set'); process.exit(1) }
  migrate(url, { dryRun: process.argv.includes('--dry-run') })
    .catch(err => { console.error(err.message); process.exit(1) })
}
