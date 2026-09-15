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
import { verifyRefresh, type Role } from '../lib/jwt.js'
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

const refreshSchema = z.object({
  refreshToken: z.string().min(1),
  // §8 rule 2: the active shop normally travels inside the signed refresh
  // token. An explicit shopId is accepted only as an override and is still
  // checked against a real membership below.
  shopId: z.string().uuid().optional(),
})

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

  res.json({
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
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

  let payload
  try {
    payload = verifyRefresh(parsed.data.refreshToken)
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

  res.json({
    accessToken: tokens.accessToken,
    // Rotated. Store this one and discard the token you presented.
    refreshToken: tokens.refreshToken,
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

  res.json({
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
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
  res.json({ ok: true })
})
