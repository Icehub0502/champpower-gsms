import { sql } from 'kysely'
import { db } from '../lib/db.js'
import { asyncRouter } from '../middleware/asyncHandler.js'

// Every handler on this router is wrapped; see middleware/asyncHandler.ts.
export const healthRouter = asyncRouter()

/**
 * Liveness plus a real database round-trip. A process that is up but cannot
 * reach PostgreSQL is not healthy, and reporting it as healthy is how an
 * outage stays invisible until someone at the counter notices.
 *
 * The round trip is why this endpoint is rate limited in app.ts: it is
 * unauthenticated and it touches the database, so without a limit it is a free
 * way to exhaust a pool of ten connections.
 */
healthRouter.get('/', async (_req, res) => {
  try {
    await sql`select 1`.execute(db)
    res.json({ ok: true, db: 'up' })
  } catch {
    res.status(503).json({ ok: false, db: 'down' })
  }
})
