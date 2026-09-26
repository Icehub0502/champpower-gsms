/**
 * The queue-number allocator is only correct under READ COMMITTED — pinned here.
 *
 * TIER 2. Skipped when GSMS_TEST_DB is unset; see src/test/env.ts.
 *
 * Why this is a test and not a comment: openJob() takes lockQueueDay() and then
 * reads max(queue_no). Under READ COMMITTED every statement takes a FRESH
 * snapshot, so once the lock is granted, that read sees the row the previous
 * holder just committed. Under REPEATABLE READ (or SERIALIZABLE) the snapshot is
 * taken at the transaction's FIRST statement — withShop()'s set_config, long
 * before the lock — so the read after the lock still sees the old max, every
 * waiter computes the same number, and the starvation fixed in c0ad86b comes
 * straight back. Nothing in the code forces READ COMMITTED: it is only
 * PostgreSQL's default. One `ALTER DATABASE gsms SET
 * default_transaction_isolation = 'repeatable read'`, or a change to how
 * withShop() opens its transaction, would break allocation silently. This test
 * turns that into a red build instead.
 *
 * If you ever DO need a stricter level for withShop, the allocator must change
 * with it — see lockQueueDay() in repositories/jobs.ts — not just this test.
 */
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { withShop } from '@gsms/db/client.js'
import { db } from './db.js'
import { hasDatabase, tier2 } from '../test/env.js'

describe.skipIf(!hasDatabase)(tier2('transaction isolation the allocator depends on'), () => {
  it('withShop() transactions run at READ COMMITTED', async () => {
    // No rows are read, so any shop id will do; only the transaction's own
    // setting is being examined.
    const level = await withShop(db, randomUUID(), async (trx) => {
      const r = await sql<{ level: string }>`
        select current_setting('transaction_isolation') as level`.execute(trx)
      return r.rows[0]?.level
    })
    expect(level, 'lockQueueDay() + max(queue_no) is only correct under READ COMMITTED').toBe('read committed')
  })

  it('the database default has not been raised underneath it', async () => {
    // The usual way this would break: a database- or role-level default, set by
    // someone tuning the server who never read the allocator.
    const r = await sql<{ level: string }>`
      select current_setting('default_transaction_isolation') as level`.execute(db)
    expect(r.rows[0]?.level).toBe('read committed')
  })
})
