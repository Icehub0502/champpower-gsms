import cookieParser from 'cookie-parser'
import cors from 'cors'
import express from 'express'
import helmet from 'helmet'
import rateLimit, { ipKeyGenerator } from 'express-rate-limit'
import { authRouter } from './routes/auth.js'
import { adminRouter } from './routes/admin.js'
import { healthRouter } from './routes/health.js'
import { queueRouter } from './routes/queue.js'
import { bookingsRouter } from './routes/bookings.js'
import { checkinRouter } from './routes/checkin.js'
import { filesRouter } from './routes/files.js'
import { kanbanRouter } from './routes/kanban.js'
import { publicBoardRouter } from './routes/publicBoard.js'

export interface CreateAppOptions {
  /**
   * TEST-ONLY override for the intake write limiter's ceiling.
   *
   * Every production call site — `export const app` below, which is the only
   * thing `src/index.ts` ever imports — calls `createApp()` with NO options,
   * so production always gets the real number hard-coded a few lines down.
   * There is no request-time input (query, header, body) that reaches this
   * parameter; it can only be set by code that calls `createApp()` directly,
   * which today is `src/test/fixtures.ts#startApi()` and nothing else. A
   * client cannot raise its own ceiling by asking nicely.
   *
   * Why this exists at all: apps/api/src/routes/today.integration.test.ts
   * grew enough setup PATCHes (walking a job through several legal statuses
   * before the move under test) that it started tripping the real 120/min
   * ceiling on tests that had nothing to do with rate limiting — a false
   * failure that would have tempted someone to raise the PRODUCTION limit, or
   * to bypass the API in setup and stop exercising the route at all. Neither
   * is now necessary: a test file that needs headroom asks `startApi()` for
   * it explicitly, and a separate test (today.integration.test.ts, "the real
   * write limiter") starts a SECOND app with no override and proves the real
   * ceiling still bites at 120 on an unmodified instance.
   */
  intakeWriteLimit?: number
}

/**
 * Build the Express app. A factory, not only a module-level singleton, so a
 * test can start a second instance with its own limiter ceiling and its own
 * in-memory rate-limit store — see CreateAppOptions above. Every other line in
 * this function is unchanged from before the factory existed.
 */
export function createApp(options: CreateAppOptions = {}): express.Express {
  const app = express()

  app.use(helmet())

  /**
   * How many reverse proxies sit in front of this process.
   *
   * `trust proxy` decides which entry of X-Forwarded-For becomes req.ip, and
   * req.ip is what the rate limiter counts. Setting it to `true` trusts the whole
   * header, so anyone can prepend an address of their choosing and get a fresh
   * bucket per request; setting it too low behind nginx makes every request look
   * like it came from the proxy, and twenty bad passwords lock out the entire
   * shop. It is therefore a hop count, configured to match the real deployment.
   * 0 = no proxy, the default for running this directly.
   */
  app.set('trust proxy', Number(process.env.TRUST_PROXY ?? 0))

  /**
   * Real origins only.
   *
   * The old config fell back to '*' when CORS_ORIGIN was unset, which meant a
   * missing environment variable quietly opened the API to every site on the
   * internet. Refusing to start is the safer failure.
   */
  const origins = (process.env.CORS_ORIGINS ?? '')
    .split(',').map((s) => s.trim()).filter(Boolean)
  if (origins.length === 0) {
    throw new Error('CORS_ORIGINS is not set; refusing to start with an open CORS policy')
  }
  app.use(cors({ origin: origins, credentials: true }))

  // Photos are files on disk now, not base64 in JSON, so the old 25mb body limit
  // is no longer needed — and a large limit is free denial-of-service.
  app.use(express.json({ limit: '1mb' }))
  // Unsigned: the refresh cookie's only defence is httpOnly + Secure +
  // SameSite=Strict (routes/auth.ts), not a signature — there is nothing here
  // that benefits from cookie-parser's signing.
  app.use(cookieParser())

  /**
   * Three limiters, because one bucket cannot express what we need.
   *
   * The whole /api/auth surface is covered, not just /login: /refresh,
   * /switch-shop and /me all do real work (a bcrypt-free but database-backed
   * round trip each) and were previously unlimited.
   */
  app.use('/api/auth', rateLimit({
    windowMs: 15 * 60_000,
    limit: 300,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'too_many_requests' },
  }))

  // Guessing passwords should be slow. Counted per IP; a real person signing in
  // will never come close.
  app.use('/api/auth/login', rateLimit({
    windowMs: 15 * 60_000,
    limit: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'too_many_attempts' },
  }))

  /**
   * A second counter, on the account rather than the address.
   *
   * Per-IP alone fails both ways round: a whole shop behind one connection shares
   * a bucket, so twenty wrong passwords lock out everyone; and an attacker spread
   * over many addresses never fills any single bucket while hammering one
   * account. Keyed on the submitted login id, normalised, with the IP folded in
   * as the fallback for a request that names no account at all.
   */
  app.use('/api/auth/login', rateLimit({
    windowMs: 15 * 60_000,
    limit: 10,
    standardHeaders: false,
    legacyHeaders: false,
    message: { error: 'too_many_attempts' },
    // Only failures count. Counting successful sign-ins too would mean an account
    // used normally through the day — a shared counter login, a manager on two
    // devices — locks itself out of its own shop, which is the denial of service
    // this limiter exists to prevent, aimed at the wrong person.
    skipSuccessfulRequests: true,
    keyGenerator: (req) => {
      const body = req.body as { loginId?: unknown } | undefined
      const loginId = typeof body?.loginId === 'string' ? body.loginId.trim().toLowerCase() : ''
      return loginId ? `login:${loginId}` : `ip:${ipKeyGenerator(req.ip ?? '')}`
    },
  }))

  /**
   * /health is unauthenticated and does a real database round-trip, so it is a
   * free way to drain a pool of ten connections. Generous enough for any monitor.
   */
  app.use('/health', rateLimit({
    windowMs: 60_000,
    limit: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'too_many_requests' },
  }))

  /**
   * Writes on the intake path, limited; reads left alone.
   *
   * CLAUDE.md §12 asks for a limit on every endpoint that writes. The board is
   * polled by every tablet in the shop all day and must not be throttled, so the
   * limiter skips GET rather than covering the whole surface. The ceiling is
   * generous on purpose: a busy Saturday morning is perhaps twenty check-ins an
   * hour across the counter, and a limit that bites during real work would be
   * met by staff reaching for the paper book.
   *
   * `options.intakeWriteLimit` is TEST-ONLY — see CreateAppOptions above. The
   * production number is 120, right here, unconditionally reachable by no
   * request this process ever handles.
   */
  const intakeWriteLimiter = rateLimit({
    windowMs: 60_000,
    limit: options.intakeWriteLimit ?? 120,
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => req.method === 'GET',
    message: { error: 'too_many_requests' },
  })

  app.use('/health', healthRouter)
  app.use('/api/auth', authRouter)
  app.use('/api/admin', adminRouter)

  // The unauthenticated waiting-room screen. Mounted before the /api routers so a
  // stranger's request never walks through the authenticated ones, and carrying
  // its own limiter (routes/publicBoard.ts) so it cannot be mounted unlimited.
  app.use('/api/public/board', publicBoardRouter)

  // The board (/api/queue) and the two board edits (/api/jobs/:id/bay,
  // /api/jobs/:id/queue-no) share one router, so it mounts at /api. The kanban
  // (/api/jobs/today, /api/jobs/:id/status, /api/jobs/:id/sub-state) rides on the
  // SAME mount so the write limiter runs once per request — two separate
  // app.use('/api', limiter, ...) lines would count every PATCH twice.
  app.use('/api', intakeWriteLimiter, queueRouter, kanbanRouter)
  app.use('/api/bookings', intakeWriteLimiter, bookingsRouter)
  app.use('/api/checkin', intakeWriteLimiter, checkinRouter)

  // Check-in photo upload/retrieval. Shares the intake write limiter — its
  // `skip: GET` means fetching an already-uploaded photo (routes/files.ts GET
  // /api/files/:id) is unlimited while the upload POST is capped like every
  // other intake write. Never express.static: CLAUDE.md §12.
  app.use('/api/files', intakeWriteLimiter, filesRouter)

  // Routes from the MySQL version are parked until each screen is ported; see
  // docs/TEAM.md for the weekly order. They are not mounted, so nothing reaches
  // code that still expects the old database.

  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error(err)
    // Never a stack trace to the client: it names files, versions and query
    // fragments that make the next attempt easier.
    res.status(500).json({ error: 'internal_error' })
  })

  return app
}

// The production singleton. src/index.ts imports this and only this — every
// deployed process gets exactly the app CreateAppOptions' comment describes:
// createApp() with no overrides, the real 120/min ceiling, unconditionally.
export const app = createApp()
