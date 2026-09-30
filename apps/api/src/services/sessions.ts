/**
 * Sessions, in one place.
 *
 * Issuing, rotating and revoking a session all write the same two tables, and
 * the only way to be sure they agree is for there to be exactly one copy of
 * each. Routes call into here; they do not write `sessions` themselves.
 */
import { sql, type Insertable, type Updateable } from 'kysely'
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
  // now(), the database clock: the refresh grace window compares this column
  // with the database's now(), so both sides of that subtraction must come
  // from the same clock. An app-host Date would put them on two.
  const patch = replacedBySessionId !== null
    ? { revoked_at: sql<Date>`now()`, replaced_by: replacedBySessionId }
    : { revoked_at: sql<Date>`now()` }
  // `revoked_at IS NULL`: the first revocation time is evidence and the refresh
  // grace window is measured from it. A second revoke must not move it.
  await trx.updateTable('sessions').set(patch)
    .where('jti', '=', jti).where('revoked_at', 'is', null).execute()
}

/**
 * How long after a rotation the immediately-previous refresh token is still
 * answered with the successor's session instead of being read as theft.
 * See the GRACE note in routes/auth.ts for why this exists and its limits.
 */
export const REFRESH_GRACE_SECONDS = 10

/**
 * Rotate atomically: retire `oldSessionId` in favour of `newSessionId`, but
 * only if nobody else has retired it first.
 *
 * The single conditional UPDATE is the whole point. Read-then-write let two
 * requests holding the same cookie both see a live session and both mint a
 * successor. Here the loser blocks on the row lock until the winner commits,
 * re-evaluates `revoked_at IS NULL`, matches 0 rows, and gets `false` — the
 * caller must then abandon its own successor (roll back) and fall through to
 * the grace/theft decision, never keep a second child of the same parent.
 * `revoked_at` and `replaced_by` are set in one statement (CHECK in 0012).
 */
export async function rotateSession(
  trx: IdentityTx,
  oldSessionId: string,
  newSessionId: string,
): Promise<boolean> {
  const rows = await trx
    .updateTable('sessions')
    // now(): the database clock, same as the grace-window check (see revokeSession).
    .set({ revoked_at: sql<Date>`now()`, replaced_by: newSessionId })
    .where('id', '=', oldSessionId)
    .where('revoked_at', 'is', null)
    .returning('id')
    .execute()
  return rows.length === 1
}

/**
 * Tokens for a session that ALREADY exists — no row is inserted.
 *
 * Used only by the refresh grace path, which must hand a second caller a
 * working credential for the successor the first caller already created,
 * without minting a sibling. Signing lives here so there is one place that
 * builds tokens.
 */
export function tokensForExistingSession(
  userId: string,
  jti: string,
  membership: MembershipRef,
): { accessToken: string; refreshToken: string } {
  return {
    accessToken: signAccess({ sub: userId, shop: membership.shop_id, role: membership.role, jti }),
    refreshToken: signRefresh({ sub: userId, jti, shop: membership.shop_id, typ: 'refresh' }),
  }
}

/**
 * Revoke a session AND everything it was rotated into.
 *
 * Logout needs the forward chain: the tab that presents X may have lost a
 * refresh race and X may already have been rotated to Y (and Y to Z) an
 * instant earlier. Revoking only X would leave Y, the session the browser is
 * actually holding, alive. The walk follows `replaced_by` only, and only rows
 * of the same user; sessions that merely belong to the same user (another
 * device) are untouched. Rows that are already revoked keep their original
 * `revoked_at`. Returns the ids this call revoked, so the caller can audit
 * exactly what changed, and whether the presented session had already been
 * rotated (worth recording, not an alarm: a tab that lost a race logs out).
 *
 * WHY THE ORDER MATTERS. The presented row is locked first, in its own
 * statement. `rotateSession` retires a parent with a conditional UPDATE on that
 * same row, so the two serialise: either the rotation committed before we got
 * the lock, and the statement below (which takes a fresh snapshot, READ
 * COMMITTED) sees the successor; or we hold the lock and the rotation waits,
 * then matches 0 rows because we revoked the parent. Doing it all in one CTE
 * statement would let a successor commit after that statement's snapshot but
 * before its UPDATE, and leave the newest session alive. The same argument
 * repeats down the chain (a middle session may rotate while we walk), so the
 * walk is repeated until a pass revokes nothing: a revoked row can no longer
 * gain a successor, and any successor that appeared is found on the next pass.
 */
export async function revokeSessionChain(
  trx: IdentityTx,
  jti: string,
  expectedUserId?: string,
): Promise<{ revokedIds: string[]; presentedWasRotated: boolean }> {
  const locked = await sql<{ id: string; replaced_by: string | null }>`
    SELECT id, replaced_by FROM sessions
     WHERE jti = ${jti}
       AND (${expectedUserId ?? null}::uuid IS NULL OR user_id = ${expectedUserId ?? null}::uuid)
       FOR UPDATE`.execute(trx)
  const presented = locked.rows[0]
  if (!presented) return { revokedIds: [], presentedWasRotated: false }

  const revokedIds: string[] = []
  for (let pass = 0; pass < 8; pass++) {
    const result = await sql<{ id: string }>`
      WITH RECURSIVE chain AS (
        SELECT id, user_id, replaced_by FROM sessions WHERE id = ${presented.id}
        UNION
        SELECT s.id, s.user_id, s.replaced_by
          FROM sessions s JOIN chain c ON s.id = c.replaced_by AND s.user_id = c.user_id
      )
      UPDATE sessions SET revoked_at = now()
       WHERE id IN (SELECT id FROM chain) AND revoked_at IS NULL
      RETURNING id`.execute(trx)
    if (result.rows.length === 0) break
    revokedIds.push(...result.rows.map((r) => r.id))
  }
  return { revokedIds, presentedWasRotated: presented.replaced_by !== null }
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
  const result = await trx
    .updateTable('sessions')
    .set({ revoked_at: sql<Date>`now()` })
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
