/* eslint-disable no-console */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './pool.js';

// Dead-simple migration runner: applies every .sql file in ./migrations, in filename
// order, that isn't already recorded in schema_migrations. No migration framework
// dependency, per the spec ("keep it dead simple").
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

async function ensureTrackingTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      filename VARCHAR(255) NOT NULL,
      applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_schema_migrations_filename (filename)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
}

async function appliedMigrations(): Promise<Set<string>> {
  const [rows] = await pool.query('SELECT filename FROM schema_migrations');
  return new Set((rows as { filename: string }[]).map((r) => r.filename));
}

function splitStatements(sql: string): string[] {
  // Migrations here never use string literals containing ';', so a naive split is safe
  // and avoids pulling in a SQL-aware parser for a one-off runner.
  return sql
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function migrate(): Promise<void> {
  await ensureTrackingTable();
  const applied = await appliedMigrations();
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    const statements = splitStatements(sql);
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      for (const statement of statements) {
        await conn.query(statement);
      }
      await conn.query('INSERT INTO schema_migrations (filename) VALUES (?)', [file]);
      await conn.commit();
      console.log(`applied ${file}`);
    } catch (err) {
      await conn.rollback();
      throw new Error(`migration ${file} failed: ${(err as Error).message}`);
    } finally {
      conn.release();
    }
  }
  console.log('migrations up to date');
}

// Allow `npm run migrate` (invoked as a script) as well as being imported elsewhere.
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  migrate()
    .then(() => pool.end())
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    });
}
