import cors from 'cors'
import express from 'express'
import helmet from 'helmet'
import rateLimit, { ipKeyGenerator } from 'express-rate-limit'
import { authRouter } from './routes/auth.js'
import { adminRouter } from './routes/admin.js'
import { healthRouter } from './routes/health.js'

export const app = express()

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

app.use('/health', healthRouter)
app.use('/api/auth', authRouter)
app.use('/api/admin', adminRouter)

// Routes from the MySQL version are parked until each screen is ported; see
// docs/TEAM.md for the weekly order. They are not mounted, so nothing reaches
// code that still expects the old database.

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err)
  // Never a stack trace to the client: it names files, versions and query
  // fragments that make the next attempt easier.
  res.status(500).json({ error: 'internal_error' })
})
