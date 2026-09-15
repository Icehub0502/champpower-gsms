/**
 * Sessions, in one place.
 *
 * Issuing, rotating and revoking a session all write the same two tables, and
 * the only way to be sure they agree is for there to be exactly one copy of
 * each. Routes call into here; they do not write `sessions` themselves.
 */
import type { Insertable, Updateable } from 'kysely'
import type { ScopedTx, UnscopedTx } from '@gsms/db/client.js'
import type { Sessions } from '@gsms/db/types.js'
import { newJti, refreshExpiresAt, signAccess, signRefresh, type Role } from '../lib/jwt.js'

/**
 * Identity tables (users, sessions, shops, shop_memberships) carry no shop_id
 * and no RLS, so a session write is equally valid inside `unscoped` and inside
 * `withShop` — and both are needed, because revoking sessions and writing the
 * audit_logs row that records the revocation must be one transaction, and
 * audit_logs does have RLS.
 *
 * What this type still refuses is the thing that matters: the bare `Kysely<DB>`
 * pool handle (a write outside any transaction) and `GroupTx` (read-only, and
 * spanning several shops). It was `Kysely<DB>`, which accepted all of them and
 * quietly undid the branding introduced for WO item 12.
 */
export type IdentityTx = ScopedTx | UnscopedTx

export interface MembershipRef {
  shop_id: string
  role: Role
}

export interface IssuedTokens {
  sessionId: string
  jti: string
  accessToken: string
  refreshToken: string
}

/**
 * Create a session row and the pair of tokens that point at it.
 *
 * Returns the row id so a caller that is replacing an older session can record
 * the link — that link is what turns a replayed refresh token from an
 * indistinguishable request into a detectable theft.
 */
export async function issueSession(
  trx: IdentityTx,
  userId: string,
  membership: MembershipRef,
  device: string | null,
): Promise<IssuedTokens> {
  const jti = newJti()
  const row: Insertable<Sessions> = {
    user_id: userId,
    jti,
    device,
    expires_at: refreshExpiresAt(),
    last_used_at: new Date(),
  }
  const inserted = await trx
    .insertInto('sessions')
    .values(row)
    .returning('id')
    .executeTakeFirstOrThrow()

  return {
    sessionId: inserted.id,
    jti,
    accessToken: signAccess({
      sub: userId, shop: membership.shop_id, role: membership.role, jti,
    }),
    refreshToken: signRefresh({
      sub: userId, jti, shop: membership.shop_id, typ: 'refresh',
    }),
  }
}

/**
 * Revoke one session.
 *
 * `replacedBySessionId` is written ONLY when a successor is actually supplied.
 * Passing null leaves whatever is already there alone: null means "I have no
 * successor to record", never "erase the successor". Overwriting it with null
 * destroyed the evidence on exactly the rows worth investigating, because
 * /logout and the admin revoke endpoint both pass no successor.
 */
export async function revokeSession(
  trx: IdentityTx,
  jti: string,
  replacedBySessionId: string | null,
): Promise<void> {
  const patch: Updateable<Sessions> = { revoked_at: new Date() }
  if (replacedBySessionId !== null) patch.replaced_by = replacedBySessionId
  await trx.updateTable('sessions').set(patch).where('jti', '=', jti).execute()
}

/**
 * Revoke every live session a user holds. The single implementation.
 *
 * Callers today: POST /api/admin/users/:id/revoke-sessions, the refresh token
 * reuse path in routes/auth.ts, and both places a disabled account is noticed
 * (requireAuth and /refresh) — noticing without revoking would leave the other
 * devices working until their own tokens expired.
 *
 * TODO (W2, membership management): when `DELETE /api/admin/shops/:shopId/members/:userId`
 * and the "disable user" endpoint are built, both MUST call this function in
 * the same transaction as the membership delete / is_active flip. Removing a
 * membership without revoking sessions leaves a signed token acting for a shop
 * the holder no longer belongs to until it expires. Do not write a second copy
 * of this UPDATE — call this.
 */
export async function revokeAllSessionsForUser(
  trx: IdentityTx,
  userId: string,
): Promise<number> {
  const patch: Updateable<Sessions> = { revoked_at: new Date() }
  const result = await trx
    .updateTable('sessions')
    .set(patch)
    .where('user_id', '=', userId)
    .where('revoked_at', 'is', null)
    .executeTakeFirst()

  return Number(result.numUpdatedRows ?? 0)
}

/** Note that a session was used, for the "where am I signed in" screen later. */
export async function touchSession(trx: IdentityTx, jti: string): Promise<void> {
  const patch: Updateable<Sessions> = { last_used_at: new Date() }
  await trx.updateTable('sessions').set(patch).where('jti', '=', jti).execute()
}
