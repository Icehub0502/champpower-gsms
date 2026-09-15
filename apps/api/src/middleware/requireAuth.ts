import type { NextFunction, Request, Response } from 'express'
import { verifyAccess, type AccessPayload, type Role } from '../lib/jwt.js'
import { unscoped } from '@gsms/db/client.js'
import { db } from '../lib/db.js'
import { revokeAllSessionsForUser } from '../services/sessions.js'
import { asyncHandler } from './asyncHandler.js'

export interface AuthedRequest extends Request {
  auth?: AccessPayload
}

/**
 * Verifies the access token, then verifies that the session behind it is still
 * alive, then attaches the payload.
 *
 * The signature alone used to be enough, which made revocation decorative: an
 * owner could revoke every session row of a dismissed member of staff and that
 * person's token kept working until it expired — and /switch-shop would mint
 * them a fresh one indefinitely. The session row is the thing that can be taken
 * away, so it is read on every request.
 *
 * One indexed lookup on sessions.jti, joined to users so a disabled account is
 * caught in the same round trip. If that round trip ever shows up in latency,
 * the escape hatch is a short TTL cache (a few seconds) keyed on jti — which
 * bounds how long a revoked token keeps working. It is deliberately not there
 * yet: this is one shop, pre-launch, and correctness first.
 *
 * Everything downstream reads the shop and the role from here — from the
 * signature — and never from the request body, query or headers.
 */
export const requireAuth = asyncHandler(async (
  req: AuthedRequest,
  res: Response,
  next: NextFunction,
) => {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')
  if (!m) {
    res.status(401).json({ error: 'missing_token' })
    return
  }

  let payload: AccessPayload
  try {
    payload = verifyAccess(m[1]!)
  } catch {
    // Deliberately the same answer for expired, malformed and forged: telling
    // a caller which one it was only helps someone probing.
    res.status(401).json({ error: 'invalid_token' })
    return
  }

  const session = await db
    .selectFrom('sessions as s')
    .innerJoin('users as u', 'u.id', 's.user_id')
    .select(['s.id as session_id', 's.user_id', 's.revoked_at', 's.expires_at', 'u.is_active'])
    .where('s.jti', '=', payload.jti)
    .executeTakeFirst()

  // One code for "your session is over": missing, revoked, or past its
  // expiry. They mean the same thing to a client — sign in again — and /refresh
  // answers the same way, so the two never disagree.
  if (!session || session.revoked_at !== null || session.expires_at < new Date()) {
    res.status(401).json({ error: 'session_revoked' })
    return
  }
  if (!session.is_active) {
    // Disabling the account is what a manager actually does when someone
    // leaves. It has to bite immediately, not at the end of the refresh window
    // — and it has to take the other devices with it, or they keep working
    // until their own access tokens run out.
    // The row's user_id, not the token's sub: the database is the authority on
    // whose session this is.
    await unscoped(db, (trx) => revokeAllSessionsForUser(trx, session.user_id))
    res.status(401).json({ error: 'account_disabled' })
    return
  }

  req.auth = payload
  next()
})

/**
 * Role gate. Checked here, at the route, on the server — never by hiding a
 * button. A hidden button is a hint; this is the rule.
 */
export function requireRole(...allowed: Role[]) {
  return (req: AuthedRequest, res: Response, next: NextFunction) => {
    if (!req.auth) {
      res.status(401).json({ error: 'missing_token' })
      return
    }
    if (!allowed.includes(req.auth.role)) {
      res.status(403).json({ error: 'forbidden' })
      return
    }
    next()
  }
}
