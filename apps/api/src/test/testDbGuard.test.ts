import { describe, expect, it } from 'vitest'
import pg from 'pg'
import { hasDatabase, tier2 } from './env.js'
import { selectTestDb } from './testDbSelect.js'

describe('selectTestDb (Tier 1)', () => {
  it('skips, never falling back to the dev URL, when no test URL is set', () => {
    const r = selectTestDb({ devUrl: 'postgres://gsms_app:x@localhost/gsms' })
    expect(r.url).toBe('')
    expect(r.skipReason).toMatch(/TEST_DATABASE_URL/)
  })
  it('aborts when the test database is the dev database', () => {
    expect(() => selectTestDb({
      testUrl: 'postgres://gsms_app:x@localhost:5433/gsms',
      devUrl: 'postgres://gsms_app:x@localhost/gsms',
    })).toThrow(/same as DATABASE_URL/)
  })
  it('aborts when the admin URL names a different database', () => {
    expect(() => selectTestDb({
      testUrl: 'postgres://gsms_app:x@localhost/gsms_test',
      testAdminUrl: 'postgres://postgres:x@localhost/gsms',
    })).toThrow(/differs/)
  })
  it('accepts a distinct test database', () => {
    const r = selectTestDb({
      testUrl: 'postgres://gsms_app:x@localhost/gsms_test',
      testAdminUrl: 'postgres://postgres:x@localhost/gsms_test',
      devUrl: 'postgres://gsms_app:x@localhost/gsms',
    })
    expect(r.url).not.toBe('')
  })
})

describe.skipIf(!hasDatabase)(tier2('test-database guard: never the dev database, never the owner'), () => {
  it('current_database() is not the dev database and the role is non-superuser gsms_app', async () => {
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL })
    await client.connect()
    try {
      const { rows: [row] } = await client.query<{ db: string; usr: string; su: boolean }>(
        `SELECT current_database() AS db, current_user AS usr,
                (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS su`)
      console.log(`[guard] current_database() = ${row!.db}`)
      expect(row!.db).not.toBe(process.env.DEV_DATABASE_NAME)
      expect(row!.db).not.toBe('gsms')
      expect(row!.usr).toBe('gsms_app')
      expect(row!.su).toBe(false)
    } finally {
      await client.end()
    }
  })
})
