/**
 * Administration of people, not of data.
 *
 * Everything here is scoped to the caller's active shop, taken from the signed
 * token. A manager at Samut Prakan administers Samut Prakan; belonging to the
 * same owner group is not permission to touch another branch's staff
 * (CLAUDE.md §12.1, escalation rule 2).
 */
import { z } from 'zod'
import { withShop } from '@gsms/db/client.js'
import { db } from '../lib/db.js'
import { requireAuth, requireRole, type AuthedRequest } from '../middleware/requireAuth.js'
import { asyncRouter } from '../middleware/asyncHandler.js'
import { revokeAllSessionsForUser } from '../services/sessions.js'

// Every handler on this router is wrapped; see middleware/asyncHandler.ts.
export const adminRouter = asyncRouter()

const userIdParam = z.object({ id: z.string().uuid() })

/**
 * Sign someone out everywhere, now.
 *
 * This is the thing an owner reaches for when a member of staff leaves or a
 * phone is lost, and until now it did not exist: /logout only ever revoked the
 * caller's own session. Because requireAuth reads the session row on every
 * request, the effect is immediate rather than "within fifteen minutes".
 */
adminRouter.post(
  '/users/:id/revoke-sessions',
  requireAuth,
  requireRole('owner', 'manager'),
  async (req: AuthedRequest, res) => {
    const parsed = userIdParam.safeParse(req.params)
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request' })
      return
    }
    const auth = req.auth!
    const targetUserId = parsed.data.id

    // The shop comes from the token, never from the body: §8 rule 2. The target
    // must be a member of THIS shop, or a manager could sign out staff at a
    // branch they have no authority over.
    const membership = await db
      .selectFrom('shop_memberships')
      .select(['id'])
      .where('user_id', '=', targetUserId)
      .where('shop_id', '=', auth.shop)
      .executeTakeFirst()

    if (!membership) {
      res.status(404).json({ error: 'user_not_found' })
      return
    }

    // audit_logs carries a shop_id and therefore RLS, so the write has to
    // happen inside a transaction that has declared which shop it acts for.
    // `sessions` has no shop_id and is unaffected by that declaration.
    const revoked = await withShop(db, auth.shop, async (trx) => {
      const count = await revokeAllSessionsForUser(trx, targetUserId)
      await trx.insertInto('audit_logs').values({
        shop_id: auth.shop,
        actor_id: auth.sub,
        action: 'revoke_sessions',
        entity_type: 'users',
        entity_id: targetUserId,
        before: null,
        after: JSON.stringify({ revoked_count: count }),
      }).execute()
      return count
    })

    res.json({ revoked })
  },
)
