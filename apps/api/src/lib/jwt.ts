/**
 * Token handling.
 *
 * Two tokens, on purpose:
 *   access  — short-lived, carries the shop and role, never stored server-side
 *   refresh — long-lived, one row in `sessions`, revocable, and rotated on every
 *             use so a stolen copy stops working the moment the real holder
 *             refreshes (see routes/auth.ts).
 *
 * The old system issued a single 30-day token with no way to revoke it. A
 * member of staff leaving meant their token stayed valid for a month; here,
 * revoking the session row cuts access on the very next request, because
 * requireAuth reads that row every time.
 */
import jwt, { type SignOptions } from 'jsonwebtoken'
import { randomUUID } from 'node:crypto'

export type Role =
  | 'owner' | 'manager' | 'assistant_manager' | 'advisor'
  | 'technician' | 'accountant' | 'viewer'

/**
 * HS256 is the only algorithm this system issues or accepts. Pinning it on
 * verify closes the classic confusion attack where a caller supplies a token
 * whose header names a different algorithm and the library obligingly follows
 * it; pinning it on sign makes sure the two ends can never drift apart.
 */
const ALG = 'HS256' as const

export interface AccessPayload {
  sub: string          // user id
  /**
   * The shop this token acts for. It lives in the signed token and nowhere
   * else: CLAUDE.md §8 rule 2. If a client could name its own shop in a body
   * or a header, one group would read another group's data immediately.
   */
  shop: string
  role: Role
  jti: string          // ties the access token to its session row
}

export interface RefreshPayload {
  sub: string
  jti: string
  /**
   * The active shop travels with the refresh token. Without it the client has
   * to name a shop on /refresh, which is exactly the "client chooses its own
   * tenant" pattern §8 rule 2 forbids — and the old code's attempt to read it
   * from the body silently snapped every refresh back to the first shop.
   */
  shop: string
  typ: 'refresh'
}

function secret(): string {
  const value = process.env.JWT_SECRET
  if (!value) throw new Error('JWT_SECRET is not set')
  if (value.length < 32) {
    // A short secret is guessable, and a forged token is a login as anyone.
    throw new Error('JWT_SECRET is too short; use at least 32 characters')
  }
  return value
}

const ACCESS_TTL = (process.env.JWT_ACCESS_TTL ?? '15m') as SignOptions['expiresIn']
/**
 * 14 days, down from 30. Rotation on every refresh makes this a sliding window
 * for anyone who actually uses the app daily, so the shorter ceiling costs a
 * working member of staff nothing and halves the window a stolen token is
 * useful in.
 */
const REFRESH_TTL_RAW = process.env.JWT_REFRESH_TTL ?? '14d'
const REFRESH_TTL = REFRESH_TTL_RAW as SignOptions['expiresIn']

export function newJti(): string {
  return randomUUID()
}

export function signAccess(p: AccessPayload): string {
  return jwt.sign(p, secret(), { algorithm: ALG, expiresIn: ACCESS_TTL })
}

export function signRefresh(p: RefreshPayload): string {
  return jwt.sign(p, secret(), { algorithm: ALG, expiresIn: REFRESH_TTL })
}

export function verifyAccess(token: string): AccessPayload {
  const p = jwt.verify(token, secret(), { algorithms: [ALG] }) as AccessPayload & { typ?: string }
  // A refresh token presented as an access token would otherwise be accepted,
  // since both are signed with the same key.
  if (p.typ === 'refresh') throw new Error('refresh token used as access token')
  return p
}

export function verifyRefresh(token: string): RefreshPayload {
  const p = jwt.verify(token, secret(), { algorithms: [ALG] }) as RefreshPayload
  if (p.typ !== 'refresh') throw new Error('not a refresh token')
  return p
}

/** The `exp` claim of an access token, in ms, so a socket can time itself out. */
export function accessExpiresAtMs(token: string): number | null {
  const decoded = jwt.decode(token) as { exp?: number } | null
  return typeof decoded?.exp === 'number' ? decoded.exp * 1000 : null
}

/** When the refresh token expires, for the `sessions` row. */
export function refreshExpiresAt(): Date {
  const m = /^(\d+)([smhd])$/.exec(REFRESH_TTL_RAW)
  if (!m) throw new Error(`JWT_REFRESH_TTL is not a duration: ${REFRESH_TTL_RAW}`)
  const n = Number(m[1])
  const ms = { s: 1e3, m: 6e4, h: 36e5, d: 864e5 }[m[2] as 's' | 'm' | 'h' | 'd']
  return new Date(Date.now() + n * ms)
}

/**
 * Prove the token configuration is usable, at boot.
 *
 * Both of these used to be checked lazily, which meant a missing JWT_SECRET or
 * a JWT_REFRESH_TTL of "2 weeks" started the process happily and surfaced as a
 * 500 on the first person trying to sign in — most likely the first person of
 * the morning, at the counter, with a customer waiting. Called from
 * lib/startupChecks.ts.
 */
export function assertTokenConfig(): void {
  secret()
  refreshExpiresAt()
}
