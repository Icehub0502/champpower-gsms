/**
 * Sign in, stay signed in, switch branch, sign out.
 *
 * The shape that matters: a user is an identity, a membership is a permission,
 * and a token acts for exactly one shop. Switching branch is not a client-side
 * filter — it is a fresh session, issued only after the membership is checked
 * again on the server.
 */
import { compare, hashSync } from 'bcryptjs'
import { z } from 'zod'
import { sql } from 'kysely'
import { unscoped, withShop } from '@gsms/db/client.js'
import { randomUUID } from 'node:crypto'
import { db } from '../lib/db.js'
import { refreshExpiresAt, verifyRefresh, type Role } from '../lib/jwt.js'
import { requireAuth, type AuthedRequest } from '../middleware/requireAuth.js'
import { asyncRouter } from '../middleware/asyncHandler.js'
import {
  issueSession, revokeAllSessionsForUser, revokeSession, touchSession,
} from '../services/sessions.js'

// Every handler on this router is wrapped; see middleware/asyncHandler.ts.
export const authRouter = asyncRouter()

const loginSchema = z.object({
  loginId: z.string().trim().min(1).max(200),
  password: z.string().min(1).max(200),
  shopId: z.string().uuid().optional(),
})

/**
 * There is deliberately no `refreshToken` field here.
 *
 * The token arrives one way and one way only: the httpOnly cookie below, which
 * the browser attaches by itself. A body fallback existed briefly, justified as
 * "for non-browser clients"; an audit of the whole repository found no such
 * client, and none is planned — the LINE bot (CLAUDE.md §5.9) is server-side
 * and never holds a user's refresh token.
 *
 * It is not kept behind a test-only flag either. A credential-accepting path
 * switched on by an environment variable is itself the risk: set that variable
 * wrongly in production once and the door is open, silently. Tests set the
 * cookie directly, the same way a browser does, so the code under test is the
 * code that runs in production.
 *
 * If a non-browser client ever genuinely exists, this comes back with its own
 * review. "In case we need it" is how a door stays propped open for years.
 */
const refreshSchema = z.object({
  // §8 rule 2: the active shop normally travels inside the signed refresh
  // token. An explicit shopId is accepted only as an override and is still
  // checked against a real membership below.
  shopId: z.string().uuid().optional(),
})

/**
 * The refresh token cookie.
 *
 * `httpOnly` — page JavaScript, including an XSS payload, can never read it.
 * `secure` — sent only over HTTPS in production; browsers also special-case
 *   `http://localhost` as a secure context, so this does not need to relax in
 *   dev (see apps/web/vite.config.ts for the matching same-origin proxy that
 *   makes SameSite=Strict work in dev at all).
 * `sameSite: 'strict'` — the line between "an XSS costs the session" and "an
 *   XSS costs fifteen minutes" (WO-004/T6). Settled in docs/ARCHITECTURE.md
 *   §7 over `Lax`; do not soften it because a cross-site deployment (e.g. an
 *   ngrok tunnel) makes it inconvenient — fix the topology instead.
 * `path: '/api/auth'` — the cookie has no reason to be sent to any other
 *   route; this is also what keeps it off the (larger) attack surface of every
 *   other endpoint.
 */
const REFRESH_COOKIE_NAME = 'gsms_rt'
const REFRESH_COOKIE_PATH = '/api/auth'

function refreshCookieOptions(maxAgeMs?: number) {
  return {
    httpOnly: true,
    secure: true,
    sameSite: 'strict' as const,
    path: REFRESH_COOKIE_PATH,
    ...(maxAgeMs !== undefined ? { maxAge: maxAgeMs } : {}),
  }
}

function setRefreshCookie(res: import('express').Response, token: string): void {
  const maxAgeMs = refreshExpiresAt().getTime() - Date.now()
  res.cookie(REFRESH_COOKIE_NAME, token, refreshCookieOptions(maxAgeMs))
}

function clearRefreshCookie(res: import('express').Response): void {
  res.clearCookie(REFRESH_COOKIE_NAME, refreshCookieOptions())
}

/** The cookie is the only source; see the note on `refreshSchema` above. */
function readRefreshToken(req: import('express').Request): string | undefined {
  const cookieValue = (req as { cookies?: Record<string, unknown> }).cookies?.[REFRESH_COOKIE_NAME]
  return typeof cookieValue === 'string' && cookieValue ? cookieValue : undefined
}

interface Membership { shop_id: string; role: Role; shop_name: string; shop_slug: string }

/**
 * `shop_memberships.role` is a plain text column, so the database can hold a
 * role this code has never heard of — someone adds one in SQL, or a migration
 * introduces it before the API knows it. Casting it into the Role union would
 * let that flow through as though it were valid and be handed straight to
 * requireRole. Parsing it instead means an unknown role fails loudly, here.
 */
const roleSchema = z.enum([
  'owner', 'manager', 'assistant_manager', 'advisor',
  'technician', 'accountant', 'viewer',
]) satisfies z.ZodType<Role>

async function membershipsOf(userId: string): Promise<Membership[]> {
  const rows = await db
    .selectFrom('shop_memberships as m')
    .innerJoin('shops as s', 's.id', 'm.shop_id')
    .select(['m.shop_id', 'm.role', 's.name as shop_name', 's.slug as shop_slug'])
    .where('m.user_id', '=', userId)
    .orderBy('s.name')
    .execute()

  return rows.map((r) => ({
    shop_id: r.shop_id,
    role: roleSchema.parse(r.role),
    shop_name: r.shop_name,
    shop_slug: r.shop_slug,
  }))
}

/**
 * A bcrypt hash of a random string, computed once at boot at the same cost as
 * the real hashes.
 *
 * It exists so that the no-such-user path costs the same as the wrong-password
 * path. bcryptjs is pure JavaScript: ~150-300ms at cost 10, against ~2ms for an
 * indexed SELECT. Short-circuiting the comparison away when there is no user
 * made "this login id exists" — and separately "this account was disabled" —
 * readable straight off `curl -w %{time_total}`, no statistics needed.
 */
const BCRYPT_COST = Number(process.env.BCRYPT_COST ?? 10)
const DUMMY_HASH = hashSync(randomUUID(), BCRYPT_COST)

/**
 * Always runs bcrypt, whatever the caller asked about.
 *
 * Exported as the seam a test uses to prove that the no-user path still reaches
 * `compare()`. There is no `&&` in front of the comparison and there must never
 * be one: that operator is the whole vulnerability.
 */
export async function verifyPasswordConstantWork(
  password: string,
  storedHash: string | null,
): Promise<boolean> {
  const matched = await compare(password, storedHash ?? DUMMY_HASH)
  return storedHash !== null && matched
}

authRouter.post('/login', async (req, res) => {
  const parsed = loginSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_request', fields: parsed.error.flatten().fieldErrors })
    return
  }
  const { loginId, password, shopId } = parsed.data

  const user = await db
    .selectFrom('users')
    .select(['id', 'login_id', 'name', 'password_hash', 'is_active'])
    .where(sql`lower(login_id)`, '=', loginId.toLowerCase())
    .executeTakeFirst()

  const passwordOk = await verifyPasswordConstantWork(password, user?.password_hash ?? null)

  // One answer for "no such user", "wrong password", "account disabled", "no
  // branch" and "not a member of that branch". Every one of those used to be
  // distinguishable, and each distinction confirms that a login id is real.
  const memberships = user && passwordOk && user.is_active ? await membershipsOf(user.id) : []
  const chosen = shopId
    ? memberships.find((m) => m.shop_id === shopId)
    : memberships[0]

  if (!user || !passwordOk || !user.is_active || !chosen) {
    res.status(401).json({ error: 'invalid_credentials' })
    return
  }

  const device = String(req.headers['user-agent'] ?? '').slice(0, 200) || null
  const tokens = await unscoped(db, (trx) => issueSession(trx, user.id, chosen, device))

  setRefreshCookie(res, tokens.refreshToken)
  res.json({
    accessToken: tokens.accessToken,
    // No refreshToken field here — WO-004/T6 condition 2. It travels only as
    // the httpOnly cookie set above; page JavaScript must never hold it.
    user: { id: user.id, loginId: user.login_id, name: user.name },
    shop: { id: chosen.shop_id, name: chosen.shop_name, slug: chosen.shop_slug, role: chosen.role },
    shops: memberships.map((m) => ({
      id: m.shop_id, name: m.shop_name, slug: m.shop_slug, role: m.role,
    })),
  })
})

/**
 * Exchange a refresh token for a new pair, and rotate it.
 *
 * The old token stops working the instant this succeeds. The client MUST
 * replace its stored refresh token with the one returned here; keeping the old
 * one and presenting it again looks exactly like a stolen token being replayed,
 * and is treated as one.
 */
authRouter.post('/refresh', async (req, res) => {
  const parsed = refreshSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_request', fields: parsed.error.flatten().fieldErrors })
    return
  }

  const refreshToken = readRefreshToken(req)
  if (!refreshToken) {
    // No cookie means no session to refresh. Answered as 401 rather than 400:
    // nothing about the request is malformed, the caller simply is not signed
    // in, and the client's reaction — send the user to the login screen — is
    // the same as for every other expired-session answer here.
    res.status(401).json({ error: 'session_revoked' })
    return
  }

  let payload
  try {
    payload = verifyRefresh(refreshToken)
  } catch {
    res.status(401).json({ error: 'invalid_token' })
    return
  }

  // The signature alone is not enough. The session row is what makes a token
  // revocable: revoke it and the next refresh fails, whatever the holder still
  // has in their browser.
  const session = await db
    .selectFrom('sessions as s')
    .innerJoin('users as u', 'u.id', 's.user_id')
    .select([
      's.id as session_id', 's.user_id', 's.revoked_at', 's.expires_at',
      's.replaced_by', 's.device', 'u.is_active',
    ])
    .where('s.jti', '=', payload.jti)
    .executeTakeFirst()

  if (!session) {
    res.status(401).json({ error: 'session_revoked' })
    return
  }

  /**
   * A token that was already rotated away, presented again. The legitimate
   * holder got a new one and would never send this; someone else has a copy.
   * Which of the two is the thief is unknowable, so the whole chain goes.
   *
   * MODEL NOTE — `replaced_by` is doing two jobs here and it should not be.
   * It means both "this session was superseded" and "treat a replay of this as
   * theft", and those are not the same thing: /switch-shop supersedes a session
   * deliberately and must therefore pass no successor (see that handler), which
   * is a workaround, not the model. The intended model is a
   * `sessions.revoked_reason` column ('logout' | 'rotated' | 'switched_shop' |
   * 'admin' | 'reuse') with this check keying on 'rotated' alone. It is
   * deferred on purpose: migration 0012 is being repaired for the cross-tenant
   * DELETE hole and must not grow more surface meanwhile.
   */
  if (session.revoked_at !== null && session.replaced_by !== null) {
    // audit_logs carries a shop_id and therefore RLS; the row has to be written
    // inside a transaction that has declared its shop.
    await withShop(db, payload.shop, async (trx) => {
      await revokeAllSessionsForUser(trx, session.user_id)
      await trx.insertInto('audit_logs').values({
        shop_id: payload.shop,
        actor_id: session.user_id,
        action: 'refresh_reuse_detected',
        entity_type: 'sessions',
        entity_id: session.session_id,
        before: null,
        after: JSON.stringify({ device: session.device }),
      }).execute()
    })
    res.status(401).json({ error: 'session_revoked' })
    return
  }

  if (session.revoked_at !== null || session.expires_at < new Date()) {
    res.status(401).json({ error: 'session_revoked' })
    return
  }
  if (!session.is_active) {
    // Detecting a disabled account is not enough; WO item 2 asks for the
    // sessions to actually go. Otherwise every other device keeps its access
    // token until it expires and can keep presenting this same refresh token.
    await unscoped(db, (trx) => revokeAllSessionsForUser(trx, session.user_id))
    res.status(401).json({ error: 'account_disabled' })
    return
  }

  const memberships = await membershipsOf(session.user_id)
  // Re-read the role on every refresh. A demotion must take effect within one
  // access-token lifetime, not at the end of the refresh token's fortnight.
  const wanted = parsed.data.shopId ?? payload.shop
  const current = memberships.find((m) => m.shop_id === wanted)
  if (!current) {
    // The membership behind this session is gone. Only this session dies — the
    // user may still legitimately belong to another branch.
    await unscoped(db, (trx) => revokeSession(trx, payload.jti, null))
    res.status(403).json({ error: 'no_shop_membership' })
    return
  }

  const tokens = await unscoped(db, async (trx) => {
    const issued = await issueSession(
      trx, session.user_id, current, session.device,
    )
    await revokeSession(trx, payload.jti, issued.sessionId)
    return issued
  })

  setRefreshCookie(res, tokens.refreshToken)
  res.json({
    accessToken: tokens.accessToken,
    // Rotated, and set as the httpOnly cookie above — never in this body.
    // Whatever refresh token the caller presented (cookie or fallback body)
    // is now dead; the cookie just set is the only live one.
    shop: {
      id: current.shop_id, name: current.shop_name, slug: current.shop_slug, role: current.role,
    },
  })
})

/**
 * Switch branch.
 *
 * This issues a NEW session, not a new token on the old one. Reusing the jti
 * was an unlimited renewal loop: call this every fourteen minutes and the
 * access token never expired, while the sessions table showed one ordinary row
 * that nobody would look at twice. The client MUST replace both stored tokens
 * with the pair returned here — the old refresh token is revoked.
 */
authRouter.post('/switch-shop', requireAuth, async (req: AuthedRequest, res) => {
  const parsed = z.object({ shopId: z.string().uuid() }).safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_request' })
    return
  }
  const auth = req.auth!
  const memberships = await membershipsOf(auth.sub)
  const target = memberships.find((m) => m.shop_id === parsed.data.shopId)
  if (!target) {
    // Asking for a shop you have no membership in is the exact attack this
    // endpoint exists to stop. It is refused, not silently ignored.
    res.status(403).json({ error: 'not_a_member_of_shop' })
    return
  }

  const device = String(req.headers['user-agent'] ?? '').slice(0, 200) || null
  const tokens = await unscoped(db, async (trx) => {
    const issued = await issueSession(trx, auth.sub, target, device)
    /**
     * No successor recorded, deliberately.
     *
     * A switch is not a rotation whose replay we are watching for, and
     * /refresh reads a revoked session that HAS a successor as proof of token
     * theft. Recording one here meant the everyday case — the queue board left
     * open on a tablet in the garage while the same account switches branch on
     * the office desktop — made the tablet's honest refresh look like a replay
     * and signed the user out of every device, with an audit entry accusing
     * them of theft. With no successor the old token is simply dead: /refresh
     * answers 401 session_revoked and leaves the chain alone. See the model
     * note at the reuse-detection site for the proper fix.
     */
    await revokeSession(trx, auth.jti, null)
    return issued
  })

  setRefreshCookie(res, tokens.refreshToken)
  res.json({
    accessToken: tokens.accessToken,
    shop: { id: target.shop_id, name: target.shop_name, slug: target.shop_slug, role: target.role },
  })
})

authRouter.get('/me', requireAuth, async (req: AuthedRequest, res) => {
  const auth = req.auth!
  const user = await db
    .selectFrom('users')
    .select(['id', 'login_id', 'name'])
    .where('id', '=', auth.sub)
    .executeTakeFirst()
  if (!user) {
    res.status(404).json({ error: 'not_found' })
    return
  }
  const memberships = await membershipsOf(user.id)
  const active = memberships.find((m) => m.shop_id === auth.shop)
  if (!active) {
    // The token names a shop this user is no longer a member of. Returning the
    // rest of the answer with the shop quietly missing left the client showing
    // a signed-in screen with no branch, which nobody could explain. The
    // session goes too — it is acting for a branch its holder has left — but
    // only this one, since other memberships may still be good.
    await unscoped(db, (trx) => revokeSession(trx, auth.jti, null))
    res.status(403).json({ error: 'shop_membership_revoked' })
    return
  }

  await unscoped(db, (trx) => touchSession(trx, auth.jti))

  res.json({
    user: { id: user.id, loginId: user.login_id, name: user.name },
    shop: {
      id: active.shop_id, name: active.shop_name, slug: active.shop_slug, role: active.role,
    },
    shops: memberships.map((m) => ({
      id: m.shop_id, name: m.shop_name, slug: m.shop_slug, role: m.role,
    })),
  })
})

authRouter.post('/logout', requireAuth, async (req: AuthedRequest, res) => {
  // No successor: a logout ends the chain rather than continuing it, and
  // revokeSession leaves any `replaced_by` already on the row intact.
  await unscoped(db, (trx) => revokeSession(trx, req.auth!.jti, null))
  // The session row is already dead, so the cookie is inert either way — but
  // an inert cookie still sitting in the jar is one more thing to explain
  // during an incident, and clearing it is one line.
  clearRefreshCookie(res)
  res.json({ ok: true })
})
