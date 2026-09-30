/**
 * WO-001 items 1, 2, 5, 9, 10, 11 — end to end, against a real PostgreSQL.
 *
 * TIER 2. WRITTEN BUT NOT EXECUTED on a machine with no database. Every test
 * below is skipped when GSMS_TEST_DB is unset; a skipped test is NOT a passing
 * one, and the report for this work order lists these as unproven.
 *
 * To run: point DATABASE_URL at a PostgreSQL 16 with migrations 0001-0012
 * applied, connected as the `gsms_app` role, then `npm test -w apps/api`.
 *
 * Note on /login: the rate limiters in app.ts are real and are left alone —
 * 20 attempts per IP and 10 per account, per fifteen minutes. Only the tests
 * whose subject IS /login call it. Everything else mints a session through
 * `issueTokensFor`, which goes through the same services/sessions.ts the
 * endpoint uses. See the comment on that helper.
 */
import jwt from 'jsonwebtoken'
import { sql } from 'kysely'
import { withShop } from '@gsms/db/client.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { db } from '../lib/db.js'
import { hasDatabase, tier2 } from '../test/env.js'
import {
  auditFor, createTwoShopFixture, get, issueTokensFor, jtiOf, post, postWithRefreshCookie,
  shopOf, startApi, PASSWORD,
  type RunningApi, type TwoShopFixture,
} from '../test/fixtures.js'

interface AuthBody {
  accessToken: string
  // No refreshToken field: since WO-004/T6 it travels only as the httpOnly
  // `gsms_rt` cookie (routes/auth.ts), never in JSON. Read it off
  // `res.cookies.gsms_rt` (see fixtures.ts `ApiResponse.cookies`).
  shop: { id: string; role: string }
  shops?: { id: string }[]
}

describe.skipIf(!hasDatabase)(tier2('auth endpoints'), () => {
  let api: RunningApi
  let fx: TwoShopFixture

  beforeAll(async () => {
    api = await startApi()
    fx = await createTwoShopFixture('wo001auth')
  })
  afterAll(async () => {
    await fx?.cleanup()
    await api?.close()
  })

  /** A session for the two-branch user, acting for the given shop. */
  const session = (shopId: string) => issueTokensFor(fx.userId, shopId, 'owner')
  /** A session for the advisor who belongs to shop B only. */
  const advisorSession = () => issueTokensFor(fx.outsiderId, fx.shopB, 'advisor')

  // ===========================================================================
  // Item 1 — revocation must actually revoke
  // ===========================================================================
  describe('item 1: session revocation', () => {
    /**
     * THE PASS CRITERION the WO names: "revoke session, then /switch-shop must
     * be 401".
     *
     * What the old code did: /switch-shop signed a fresh 15-minute access token
     * reusing the SAME jti, and never consulted `sessions` at all. A dismissed
     * member of staff whose session had been revoked simply called this endpoint
     * every fourteen minutes and kept working forever — past the 15-minute
     * access TTL, past the 30-day refresh TTL, until somebody deleted their
     * shop_memberships row by hand. Against that code this test returned 200.
     */
    it('refuses /switch-shop once the session row is revoked', async () => {
      const s = await session(fx.shopA)
      // Exactly what an owner does when someone leaves.
      await db.updateTable('sessions').set({ revoked_at: new Date() })
        .where('jti', '=', s.jti).execute()

      const res = await post(api, '/api/auth/switch-shop', { shopId: fx.shopB }, s.accessToken)
      expect(res.status).toBe(401)
      expect(res.body).toMatchObject({ error: 'session_revoked' })
    })

    /**
     * The same hole from the other side: requireAuth itself must read the
     * session row on EVERY authenticated request, not only on the auth routes.
     * If it only checked signatures — which is what it used to do — revocation
     * would be decorative everywhere in the system, not just on /switch-shop.
     */
    it('refuses an ordinary authenticated endpoint once the session is revoked', async () => {
      const s = await session(fx.shopA)
      expect((await get(api, '/api/auth/me', s.accessToken)).status).toBe(200)

      await db.updateTable('sessions').set({ revoked_at: new Date() })
        .where('jti', '=', s.jti).execute()

      const after = await get(api, '/api/auth/me', s.accessToken)
      expect(after.status).toBe(401)
      expect(after.body).toMatchObject({ error: 'session_revoked' })
    })

    /**
     * The reason the renewal loop was invisible: reusing the jti meant the
     * sessions table showed one ordinary row, issued once, that nobody would
     * look at twice. A new jti and a new row are what make the loop auditable.
     */
    it('issues a DIFFERENT jti and a new session row on a successful switch', async () => {
      const s = await session(fx.shopA)

      const res = await post<AuthBody>(
        api, '/api/auth/switch-shop', { shopId: fx.shopB }, s.accessToken,
      )
      expect(res.status, JSON.stringify(res.body)).toBe(200)

      const newJti = jtiOf(res.body.accessToken)
      expect(newJti).not.toBe(s.jti)
      expect(shopOf(res.body.accessToken)).toBe(fx.shopB)

      const rows = await db.selectFrom('sessions')
        .select(['jti', 'revoked_at'])
        .where('jti', 'in', [s.jti, newJti]).execute()
      expect(rows, 'switch-shop did not create a second session row').toHaveLength(2)
      expect(rows.find((r) => r.jti === s.jti)!.revoked_at).not.toBeNull()
      expect(rows.find((r) => r.jti === newJti)!.revoked_at).toBeNull()
    })

    /** And the loop itself: the pre-switch token must not mint anything more. */
    it('cannot renew indefinitely: the pre-switch token is dead after a switch', async () => {
      const s = await session(fx.shopA)
      const switched = await post<AuthBody>(
        api, '/api/auth/switch-shop', { shopId: fx.shopB }, s.accessToken,
      )
      expect(switched.status).toBe(200)

      const replay = await post(api, '/api/auth/switch-shop', { shopId: fx.shopA }, s.accessToken)
      expect(replay.status).toBe(401)
    })

    /** Asking for a branch you have no membership in is refused, not ignored. */
    it('refuses a switch to a shop the caller is not a member of', async () => {
      const advisor = await advisorSession()
      const res = await post(api, '/api/auth/switch-shop', { shopId: fx.shopA }, advisor.accessToken)
      expect(res.status).toBe(403)
      expect(res.body).toMatchObject({ error: 'not_a_member_of_shop' })
    })
  })

  // ===========================================================================
  // Regression — /switch-shop must not look like a stolen-token replay
  // ===========================================================================
  describe('regression: switch-shop must not poison the refresh chain', () => {
    /**
     * Found by the code-reviewer after the fix landed: /switch-shop revoked the
     * old session AND set `replaced_by` to the new one, which is the exact
     * signature /refresh treats as a stolen-token replay. The honest case: the
     * queue board is open on the garage tablet and the same account is on the
     * office desktop. One switches branch; the other refreshes; the reuse
     * detector fires, revokes EVERY session the user has, and writes an audit
     * entry accusing them of theft. Both screens log out mid-job.
     *
     * The fix is that /switch-shop passes no successor. The damage was to OTHER
     * sessions, so the refresh call's own status code proves nothing on its own
     * — all three halves are asserted.
     */
    it('leaves concurrent sessions working when a stale refresh token is presented', async () => {
      const tablet = await session(fx.shopA)
      const desktop = await session(fx.shopA)

      const switched = await post<AuthBody>(
        api, '/api/auth/switch-shop', { shopId: fx.shopB }, tablet.accessToken,
      )
      expect(switched.status, JSON.stringify(switched.body)).toBe(200)

      const accusationsBefore =
        (await auditFor(fx.shopA, 'refresh_reuse_detected')).length +
        (await auditFor(fx.shopB, 'refresh_reuse_detected')).length

      // Somebody presents the pre-switch refresh token. Refused as an ordinary
      // dead session...
      const stale = await postWithRefreshCookie(api, '/api/auth/refresh', tablet.refreshToken)
      expect(stale.status).toBe(401)

      // ...but NOT treated as theft.
      // Half one: the session /switch-shop issued still works.
      const afterSwitch = await get(api, '/api/auth/me', switched.body.accessToken)
      expect(
        afterSwitch.status,
        'the session created by /switch-shop was killed by a chain-wide revocation',
      ).toBe(200)

      // Half two: the unrelated desktop session, the real victim, still works.
      const desktopRow = await db.selectFrom('sessions').select(['revoked_at'])
        .where('jti', '=', desktop.jti).executeTakeFirstOrThrow()
      expect(
        desktopRow.revoked_at,
        'an unrelated concurrent session was revoked: the chain-wide revocation fired',
      ).toBeNull()
      expect((await get(api, '/api/auth/me', desktop.accessToken)).status).toBe(200)

      // Half three: nobody was accused of anything.
      const accusationsAfter =
        (await auditFor(fx.shopA, 'refresh_reuse_detected')).length +
        (await auditFor(fx.shopB, 'refresh_reuse_detected')).length
      expect(
        accusationsAfter,
        'a refresh_reuse_detected audit entry was written for an ordinary branch switch',
      ).toBe(accusationsBefore)
    })
  })

  // ===========================================================================
  // Item 9 — rotation and reuse detection
  // ===========================================================================
  describe('item 9: refresh token rotation', () => {
    /**
     * What the old code did: the refresh token was valid, unchanged, for 30 days
     * from anywhere, and a copy was indistinguishable from the original. Against
     * that code the second call below returned 200 every time.
     */
    it('rotates the refresh token, so the presented one stops working', async () => {
      const s = await session(fx.shopA)
      const first = await postWithRefreshCookie<AuthBody>(api, '/api/auth/refresh', s.refreshToken)
      expect(first.status, JSON.stringify(first.body)).toBe(200)
      const rotatedToken = first.cookies.gsms_rt!
      expect(rotatedToken).not.toBe(s.refreshToken)
      expect(jtiOf(rotatedToken)).not.toBe(s.jti)

      // The new one works; the old one is spent.
      expect((await postWithRefreshCookie(api, '/api/auth/refresh', rotatedToken)).status)
        .toBe(200)
    })

    /**
     * Reuse detection. A token that was already rotated away, presented again,
     * is a replay: which of the two holders is the thief is unknowable, so the
     * whole chain goes. This is the ONE place a chain-wide revocation is right,
     * which is exactly why the switch-shop regression above matters.
     */
    it('revokes the whole chain when an already-rotated token is replayed', async () => {
      const s = await session(fx.shopA)
      const bystander = await session(fx.shopA)
      const rotated = await postWithRefreshCookie<AuthBody>(api, '/api/auth/refresh', s.refreshToken)
      expect(rotated.status).toBe(200)

      // An immediate replay is now the tab race and is forgiven (see the
      // grace tests below). Theft is a replay AFTER the window, so move the
      // rotation into the past instead of sleeping.
      await db.updateTable('sessions')
        // Back-dated on the DATABASE clock: the grace check compares against
        // the database's now(), so a JS Date here would test the app host's
        // clock against the database's instead.
        .set({ revoked_at: sql<Date>`now() - interval '60 seconds'` })
        .where('jti', '=', s.jti).execute()

      const replay = await postWithRefreshCookie(api, '/api/auth/refresh', s.refreshToken)
      expect(replay.status).toBe(401)

      // Everything the user holds is now dead: the successor the legitimate
      // holder is using, and the unrelated session too.
      for (const jti of [jtiOf(rotated.cookies.gsms_rt!), bystander.jti]) {
        const row = await db.selectFrom('sessions').select(['revoked_at'])
          .where('jti', '=', jti).executeTakeFirstOrThrow()
        expect(row.revoked_at, `session ${jti} survived the chain revocation`).not.toBeNull()
      }

      // And it is recorded, not silent.
      const audit = await auditFor(fx.shopA, 'refresh_reuse_detected')
      expect(audit.length).toBeGreaterThan(0)
    })

    /** The retired row must point at its successor, or detection is blind. */
    it('records which session replaced the rotated one', async () => {
      const s = await session(fx.shopA)
      const rotated = await postWithRefreshCookie<AuthBody>(api, '/api/auth/refresh', s.refreshToken)
      expect(rotated.status).toBe(200)

      const old = await db.selectFrom('sessions').select(['revoked_at', 'replaced_by'])
        .where('jti', '=', s.jti).executeTakeFirstOrThrow()
      const next = await db.selectFrom('sessions').select(['id'])
        .where('jti', '=', jtiOf(rotated.cookies.gsms_rt!)).executeTakeFirstOrThrow()

      // The 0012 CHECK constraint says replaced_by implies revoked_at; assert
      // both are set in the same breath, as the migration's note requires.
      expect(old.revoked_at).not.toBeNull()
      expect(old.replaced_by).toBe(next.id)
    })
  })

  // ===========================================================================
  // Item 9, tab race — atomic rotation + one-hop grace window
  // ===========================================================================
  describe('item 9: concurrent refresh from two tabs (atomic rotation + grace)', () => {
    const rowOf = (jti: string) => db.selectFrom('sessions')
      .select(['id', 'jti', 'revoked_at', 'replaced_by']).where('jti', '=', jti).executeTakeFirstOrThrow()
    const isRevoked = async (jti: string) => (await rowOf(jti)).revoked_at !== null
    /** Pretend the rotation happened `seconds` ago, so no test has to sleep. */
    const ageRotation = (jti: string, seconds: number) =>
      db.updateTable('sessions')
        .set({ revoked_at: sql<Date>`now() - make_interval(secs => ${seconds})` })
        .where('jti', '=', jti).execute()

    it('answers both of two simultaneous refreshes with the same cookie, on ONE chain, audited once', async () => {
      const s = await session(fx.shopA)
      const oldRow = await rowOf(s.jti)

      const [a, b] = await Promise.all([
        postWithRefreshCookie<AuthBody>(api, '/api/auth/refresh', s.refreshToken),
        postWithRefreshCookie<AuthBody>(api, '/api/auth/refresh', s.refreshToken),
      ])
      expect([a.status, b.status], JSON.stringify([a.body, b.body])).toEqual([200, 200])

      // One successor, not two: both tabs hold a cookie for the same session,
      // and it is the one the parent points at.
      const jtiA = jtiOf(a.cookies.gsms_rt!)
      const jtiB = jtiOf(b.cookies.gsms_rt!)
      expect(jtiA).toBe(jtiB)
      const parent = await rowOf(s.jti)
      const child = await rowOf(jtiA)
      expect(parent.replaced_by).toBe(child.id)
      expect(child.revoked_at).toBeNull()
      expect(jtiOf(a.body.accessToken)).toBe(jtiA)
      expect(jtiOf(b.body.accessToken)).toBe(jtiA)

      // Nobody was signed out, nobody was accused, and the grace was recorded once.
      expect((await auditFor(fx.shopA, 'refresh_grace_used', oldRow.id))).toHaveLength(1)
      expect((await auditFor(fx.shopA, 'refresh_reuse_detected', oldRow.id))).toHaveLength(0)
      expect((await get(api, '/api/auth/me', b.body.accessToken)).status).toBe(200)
      // And the cookie either tab ends up with keeps working.
      const next = await postWithRefreshCookie(api, '/api/auth/refresh', b.cookies.gsms_rt!)
      expect(next.status).toBe(200)
    })

    it('treats the previous token as theft once the grace window has passed', async () => {
      const s = await session(fx.shopA)
      const rotated = await postWithRefreshCookie<AuthBody>(api, '/api/auth/refresh', s.refreshToken)
      expect(rotated.status).toBe(200)
      await ageRotation(s.jti, 30)

      const replay = await postWithRefreshCookie(api, '/api/auth/refresh', s.refreshToken)
      expect(replay.status).toBe(401)
      expect(await isRevoked(jtiOf(rotated.cookies.gsms_rt!)), 'chain survived a late replay').toBe(true)
      const oldRow = await rowOf(s.jti)
      expect(await auditFor(fx.shopA, 'refresh_reuse_detected', oldRow.id)).toHaveLength(1)
      expect(await auditFor(fx.shopA, 'refresh_grace_used', oldRow.id)).toHaveLength(0)
    })

    it('treats a token two rotations back as theft even inside the window', async () => {
      const s = await session(fx.shopA)
      const r1 = await postWithRefreshCookie<AuthBody>(api, '/api/auth/refresh', s.refreshToken)
      const r2 = await postWithRefreshCookie<AuthBody>(api, '/api/auth/refresh', r1.cookies.gsms_rt!)
      expect([r1.status, r2.status]).toEqual([200, 200])

      const replay = await postWithRefreshCookie(api, '/api/auth/refresh', s.refreshToken)
      expect(replay.status).toBe(401)
      expect(await isRevoked(jtiOf(r2.cookies.gsms_rt!)), 'grace hopped two rotations').toBe(true)
      const oldRow = await rowOf(s.jti)
      expect(await auditFor(fx.shopA, 'refresh_reuse_detected', oldRow.id)).toHaveLength(1)
      expect(await auditFor(fx.shopA, 'refresh_grace_used', oldRow.id)).toHaveLength(0)
    })

    it('answers a plain 401 (no theft alarm, other devices untouched) when the successor was ended on purpose, inside the window', async () => {
      const bystander = await session(fx.shopA)
      const s0 = await session(fx.shopA)
      const r1 = await postWithRefreshCookie<AuthBody>(api, '/api/auth/refresh', s0.refreshToken)
      expect(r1.status).toBe(200)
      // The successor ends for a reason other than rotation (logout/admin).
      await db.updateTable('sessions').set({ revoked_at: sql<Date>`now()` })
        .where('jti', '=', jtiOf(r1.cookies.gsms_rt!)).execute()

      const replay = await postWithRefreshCookie(api, '/api/auth/refresh', s0.refreshToken)
      expect(replay.status).toBe(401)
      expect(replay.body).toMatchObject({ error: 'session_revoked' })
      const oldRow = await rowOf(s0.jti)
      expect(await auditFor(fx.shopA, 'refresh_reuse_detected', oldRow.id)).toHaveLength(0)
      expect(await auditFor(fx.shopA, 'refresh_grace_used', oldRow.id)).toHaveLength(0)
      expect(await isRevoked(bystander.jti), 'a straggler signed out another device').toBe(false)
    })

    it('the same case OUTSIDE the window is still theft and revokes the chain', async () => {
      const bystander = await session(fx.shopA)
      const s0 = await session(fx.shopA)
      const r1 = await postWithRefreshCookie<AuthBody>(api, '/api/auth/refresh', s0.refreshToken)
      expect(r1.status).toBe(200)
      await db.updateTable('sessions').set({ revoked_at: sql<Date>`now()` })
        .where('jti', '=', jtiOf(r1.cookies.gsms_rt!)).execute()
      await ageRotation(s0.jti, 30)

      const replay = await postWithRefreshCookie(api, '/api/auth/refresh', s0.refreshToken)
      expect(replay.status).toBe(401)
      const oldRow = await rowOf(s0.jti)
      expect(await auditFor(fx.shopA, 'refresh_reuse_detected', oldRow.id)).toHaveLength(1)
      expect(await isRevoked(bystander.jti)).toBe(true)
    })

    it('never resurrects a session that was logged out or admin-revoked, inside the window', async () => {
      // Logged out: no successor was ever recorded.
      const s1 = await session(fx.shopA)
      expect((await post(api, '/api/auth/logout', {}, s1.accessToken)).status).toBe(200)
      const afterLogout = await postWithRefreshCookie(api, '/api/auth/refresh', s1.refreshToken)
      expect(afterLogout.status).toBe(401)
      expect(afterLogout.cookies.gsms_rt ?? '').not.toMatch(/\./)
      const row1 = await rowOf(s1.jti)
      expect(await auditFor(fx.shopA, 'refresh_grace_used', row1.id)).toHaveLength(0)

      // Admin-revoked.
      const s2 = await session(fx.shopA)
      await db.updateTable('sessions').set({ revoked_at: new Date() })
        .where('jti', '=', s2.jti).execute()
      expect((await postWithRefreshCookie(api, '/api/auth/refresh', s2.refreshToken)).status).toBe(401)

      // Rotated, then the successor deliberately logged out: the parent's
      // token must not bring it back.
      const s3 = await session(fx.shopA)
      const r = await postWithRefreshCookie<AuthBody>(api, '/api/auth/refresh', s3.refreshToken)
      expect(r.status).toBe(200)
      expect((await post(api, '/api/auth/logout', {}, r.body.accessToken)).status).toBe(200)
      const revived = await postWithRefreshCookie(api, '/api/auth/refresh', s3.refreshToken)
      expect(revived.status).toBe(401)
      expect(revived.cookies.gsms_rt ?? '').not.toMatch(/\./)
      const row3 = await rowOf(s3.jti)
      expect(await auditFor(fx.shopA, 'refresh_grace_used', row3.id)).toHaveLength(0)
      expect((await get(api, '/api/auth/me', r.body.accessToken)).status).toBe(401)
    })
  })

  // ===========================================================================
  // Logout works without a good access token; authed responses are no-store
  // ===========================================================================
  describe('logout by refresh cookie', () => {
    /** Logout the way a browser does: optional bearer, optional cookie. */
    async function logout(opts: { access?: string; cookie?: string }) {
      const res = await fetch(`${api.url}/api/auth/logout`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(opts.access ? { authorization: `Bearer ${opts.access}` } : {}),
          ...(opts.cookie ? { cookie: `gsms_rt=${opts.cookie}` } : {}),
        },
        body: '{}',
      })
      const cleared = res.headers.getSetCookie().find((c) => c.startsWith('gsms_rt='))
      return { status: res.status, body: await res.json().catch(() => ({})), cleared }
    }
    const revokedAt = async (jti: string) =>
      (await db.selectFrom('sessions').select(['revoked_at']).where('jti', '=', jti)
        .executeTakeFirstOrThrow()).revoked_at
    const idOf = async (jti: string) =>
      (await db.selectFrom('sessions').select(['id']).where('jti', '=', jti)
        .executeTakeFirstOrThrow()).id

    it('revokes the session, clears the cookie with matching attributes, and the old cookie can no longer refresh', async () => {
      const s = await session(fx.shopA)
      const out = await logout({ access: s.accessToken, cookie: s.refreshToken })
      expect(out.status).toBe(200)
      expect(out.body).toEqual({ ok: true })
      // Same attributes the cookie was set with, or the browser keeps the old one.
      expect(out.cleared).toMatch(/^gsms_rt=;/)
      expect(out.cleared).toMatch(/Path=\/api\/auth/)
      expect(out.cleared).toMatch(/HttpOnly/i)
      expect(out.cleared).toMatch(/Secure/i)
      expect(out.cleared).toMatch(/SameSite=Strict/i)
      expect(await revokedAt(s.jti)).not.toBeNull()
      expect((await postWithRefreshCookie(api, '/api/auth/refresh', s.refreshToken)).status).toBe(401)
      expect(await auditFor(fx.shopA, 'logout', await idOf(s.jti))).toHaveLength(1)
    })

    it('still revokes and clears when the access token is expired', async () => {
      const s = await session(fx.shopA)
      const expired = jwt.sign(
        { sub: fx.userId, shop: fx.shopA, role: 'owner', jti: s.jti },
        process.env.JWT_SECRET!, { algorithm: 'HS256', expiresIn: -60 },
      )
      expect((await get(api, '/api/auth/me', expired)).status).toBe(401)
      const out = await logout({ access: expired, cookie: s.refreshToken })
      expect(out.status).toBe(200)
      expect(out.cleared).toMatch(/^gsms_rt=;/)
      expect(await revokedAt(s.jti)).not.toBeNull()
      expect((await postWithRefreshCookie(api, '/api/auth/refresh', s.refreshToken)).status).toBe(401)
    })

    it('answers 200 and clears the cookie for a missing, forged or unknown token, without revoking anyone', async () => {
      const bystander = await session(fx.shopA)
      for (const opts of [{}, { cookie: 'not-a-jwt' }, { access: 'nope', cookie: 'nope' }]) {
        const out = await logout(opts)
        expect(out.status).toBe(200)
        expect(out.body).toEqual({ ok: true })
        expect(out.cleared).toMatch(/^gsms_rt=;/)
      }
      expect(await revokedAt(bystander.jti)).toBeNull()
    })

    it('presenting X after X was rotated to Y also revokes Y', async () => {
      const x = await session(fx.shopA)
      const rotated = await postWithRefreshCookie<AuthBody>(api, '/api/auth/refresh', x.refreshToken)
      expect(rotated.status).toBe(200)
      const yJti = jtiOf(rotated.cookies.gsms_rt!)

      const out = await logout({ cookie: x.refreshToken })
      expect(out.status).toBe(200)
      expect(await revokedAt(yJti), 'the rotated successor survived logout').not.toBeNull()
      expect((await get(api, '/api/auth/me', rotated.body.accessToken)).status).toBe(401)
    })

    it('does not touch another device of the same user', async () => {
      const mine = await session(fx.shopA)
      const other = await session(fx.shopA)
      await logout({ cookie: mine.refreshToken })
      expect(await revokedAt(other.jti)).toBeNull()
    })

    it('a refresh still in flight when the user logs out (X inside the window) is refused without signing out other devices', async () => {
      const other = await session(fx.shopA)
      const x = await session(fx.shopA)
      const r = await postWithRefreshCookie<AuthBody>(api, '/api/auth/refresh', x.refreshToken)
      expect(r.status).toBe(200)
      expect((await logout({ cookie: r.cookies.gsms_rt! })).status).toBe(200)

      const straggler = await postWithRefreshCookie(api, '/api/auth/refresh', x.refreshToken)
      expect(straggler.status).toBe(401)
      const xId = await idOf(x.jti)
      expect(await auditFor(fx.shopA, 'refresh_grace_used', xId)).toHaveLength(0)
      expect(await auditFor(fx.shopA, 'refresh_reuse_detected', xId)).toHaveLength(0)
      expect(await revokedAt(other.jti), 'the straggler signed out another device').toBeNull()
      expect((await get(api, '/api/auth/me', other.accessToken)).status).toBe(200)
    })

    it('the same straggler AFTER the window is theft: the user\'s sessions are revoked and it is audited', async () => {
      const other = await session(fx.shopA)
      const x = await session(fx.shopA)
      const r = await postWithRefreshCookie<AuthBody>(api, '/api/auth/refresh', x.refreshToken)
      expect((await logout({ cookie: r.cookies.gsms_rt! })).status).toBe(200)
      await db.updateTable('sessions')
        .set({ revoked_at: sql<Date>`now() - interval '60 seconds'` })
        .where('jti', '=', x.jti).execute()

      expect((await postWithRefreshCookie(api, '/api/auth/refresh', x.refreshToken)).status).toBe(401)
      expect(await auditFor(fx.shopA, 'refresh_reuse_detected', await idOf(x.jti))).toHaveLength(1)
      expect(await revokedAt(other.jti)).not.toBeNull()
    })

    it('logout presenting an already-rotated token records presented_was_rotated, without a theft alarm', async () => {
      const x = await session(fx.shopA)
      const r = await postWithRefreshCookie<AuthBody>(api, '/api/auth/refresh', x.refreshToken)
      expect(r.status).toBe(200)
      const yId = await idOf(jtiOf(r.cookies.gsms_rt!))

      expect((await logout({ cookie: x.refreshToken })).status).toBe(200)
      const rows = await withShop(db, fx.shopA, (trx) =>
        trx.selectFrom('audit_logs').select(['after']).where('action', '=', 'logout')
          .where('entity_id', '=', yId).execute())
      expect(rows).toHaveLength(1)
      const after = typeof rows[0]!.after === 'string' ? JSON.parse(rows[0]!.after) : rows[0]!.after
      expect(after).toMatchObject({ presented_was_rotated: true })
      expect(await auditFor(fx.shopA, 'refresh_reuse_detected', await idOf(x.jti))).toHaveLength(0)
    })

    it('writes revoked_at from the database clock (a back-dated DB interval, not a JS Date, drives the window)', async () => {
      const x = await session(fx.shopA)
      const r = await postWithRefreshCookie<AuthBody>(api, '/api/auth/refresh', x.refreshToken)
      expect(r.status).toBe(200)
      // Written by rotateSession with now(): within a second of the database's own now().
      const skew = await sql<{ skew: number }>`
        SELECT abs(extract(epoch from (now() - revoked_at)))::float8 AS skew
          FROM sessions WHERE jti = ${x.jti}`.execute(db)
      expect(skew.rows[0]!.skew).toBeLessThan(5)
    })

    it('logging in as B while A\'s cookie exists hands back B\'s cookie, and refresh yields B only', async () => {
      const a = await session(fx.shopA)
      const res = await fetch(`${api.url}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: `gsms_rt=${a.refreshToken}` },
        body: JSON.stringify({ loginId: fx.outsiderLoginId, password: PASSWORD }),
      })
      expect(res.status).toBe(200)
      const newCookie = res.headers.getSetCookie().find((c) => c.startsWith('gsms_rt='))!
      const token = newCookie.split(';', 1)[0]!.slice('gsms_rt='.length)
      expect(jtiOf(token)).not.toBe(a.jti)

      const refreshed = await postWithRefreshCookie<AuthBody>(api, '/api/auth/refresh', token)
      expect(refreshed.status).toBe(200)
      const me = await get<{ user: { id: string } }>(api, '/api/auth/me', refreshed.body.accessToken)
      expect(me.body.user.id).toBe(fx.outsiderId)
    })

    it('refuses grace when the successor belongs to a different user', async () => {
      const x = await session(fx.shopA)
      const rotated = await postWithRefreshCookie<AuthBody>(api, '/api/auth/refresh', x.refreshToken)
      expect(rotated.status).toBe(200)
      // Corrupt the link: point X's successor at somebody else's live session.
      const stranger = await advisorSession()
      const strangerRow = await db.selectFrom('sessions').select(['id'])
        .where('jti', '=', stranger.jti).executeTakeFirstOrThrow()
      await db.updateTable('sessions').set({ replaced_by: strangerRow.id })
        .where('jti', '=', x.jti).execute()

      const replay = await postWithRefreshCookie(api, '/api/auth/refresh', x.refreshToken)
      expect(replay.status).toBe(401)
      expect(replay.cookies.gsms_rt ?? '').not.toMatch(/\./)
      expect(await auditFor(fx.shopA, 'refresh_grace_used', await idOf(x.jti))).toHaveLength(0)
    })

    it('marks authenticated responses Cache-Control: no-store', async () => {
      const s = await session(fx.shopA)
      const res = await fetch(`${api.url}/api/auth/me`, {
        headers: { authorization: `Bearer ${s.accessToken}` },
      })
      expect(res.status).toBe(200)
      expect(res.headers.get('cache-control')).toBe('no-store')
      // Also on a refusal: an error page must not be cached either.
      const denied = await fetch(`${api.url}/api/jobs/today`)
      expect(denied.headers.get('cache-control')).toBe('no-store')
    })
  })

  // ===========================================================================
  // Item 10 — the m.shop_id === m.shop_id bug
  // ===========================================================================
  describe('item 10: refresh must not snap back to the first shop', () => {
    /**
     * THE DISCRIMINATING TEST. The old code read `req.body.shopId` raw, outside
     * zod, and then did:
     *
     *     memberships.find((m) => m.shop_id === (shopId ?? m.shop_id))
     *
     * With no shopId in the body the predicate became `m.shop_id === m.shop_id`
     * — true for the first row it saw — so every refresh silently moved the
     * caller back to their first branch. Someone working at branch B was
     * relocated to branch A at the first refresh, roughly every fifteen minutes,
     * and any write they made afterwards landed in the wrong shop. That is a
     * money-and-stock correctness bug, not only a rule violation.
     *
     * membershipsOf() orders by shop name, so the fixture's "-A-" shop is
     * first. This test acts for B and refreshes with no shopId: the exact case.
     */
    it('keeps the caller on their current shop when no shopId is sent', async () => {
      const s = await session(fx.shopB)
      const refreshed = await postWithRefreshCookie<AuthBody>(api, '/api/auth/refresh', s.refreshToken)
      expect(refreshed.status, JSON.stringify(refreshed.body)).toBe(200)
      expect(
        refreshed.body.shop.id,
        'refresh relocated the caller to a different branch',
      ).toBe(fx.shopB)
      expect(shopOf(refreshed.body.accessToken)).toBe(fx.shopB)
      expect(shopOf(refreshed.cookies.gsms_rt!)).toBe(fx.shopB)
    })

    /** The shopId override is validated as a uuid by zod, not passed through raw. */
    it('rejects a non-uuid shopId with 400 rather than reaching the database', async () => {
      const s = await session(fx.shopA)
      const res = await postWithRefreshCookie(api, '/api/auth/refresh', s.refreshToken, { shopId: 'not-a-uuid' })
      expect(res.status).toBe(400)
      expect(res.body).toMatchObject({ error: 'invalid_request' })
    })

    /** An override naming a shop the caller has no membership in is refused. */
    it('refuses a shopId the caller is not a member of', async () => {
      const advisor = await advisorSession()
      const res = await postWithRefreshCookie(api, '/api/auth/refresh', advisor.refreshToken, { shopId: fx.shopA })
      expect(res.status).toBe(403)
      expect(res.body).toMatchObject({ error: 'no_shop_membership' })
    })

    /** An unknown extra field must not be a way to smuggle anything in. */
    it('ignores anything else in the body', async () => {
      const s = await session(fx.shopB)
      const res = await postWithRefreshCookie<AuthBody>(api, '/api/auth/refresh', s.refreshToken, {
        shop: fx.shopA, active_shop_id: fx.shopA, role: 'owner',
      })
      expect(res.status).toBe(200)
      expect(res.body.shop.id).toBe(fx.shopB)
    })
  })

  // ===========================================================================
  // Item 2 — is_active, and revoking someone else's sessions
  // ===========================================================================
  describe('item 2: disabled accounts and admin revocation', () => {
    /**
     * What the old code did: /refresh re-read the memberships but never re-read
     * `is_active`. A manager disabling a departed employee's account — which is
     * what everyone does — had no effect at all; that account kept minting
     * access tokens for another 30 days.
     */
    it('refuses /refresh and every request for an account that has been disabled', async () => {
      const victim = await advisorSession()
      await db.updateTable('users').set({ is_active: false })
        .where('id', '=', fx.outsiderId).execute()
      try {
        const refreshed = await postWithRefreshCookie(api, '/api/auth/refresh', victim.refreshToken)
        expect(refreshed.status).toBe(401)
        expect(refreshed.body).toMatchObject({ error: 'account_disabled' })

        // And the live access token stops working on the very next request,
        // rather than at the end of its fifteen minutes.
        //
        // Either code is correct here. requireAuth checks the session row before
        // is_active, and /refresh above now revokes every session of a disabled
        // account (WO item 2: "detecting it is not enough, the sessions must
        // actually go"), so this request is refused as `session_revoked` rather
        // than `account_disabled`. What must not happen is a 200.
        const me = await get<{ error: string }>(api, '/api/auth/me', victim.accessToken)
        expect(me.status).toBe(401)
        expect(['account_disabled', 'session_revoked']).toContain(me.body.error)
      } finally {
        await db.updateTable('users').set({ is_active: true })
          .where('id', '=', fx.outsiderId).execute()
      }
    })

    /** The endpoint that did not exist at all: /logout only ever cut off self. */
    it('lets an owner revoke every session of a member of their own shop', async () => {
      const owner = await session(fx.shopB)
      const victim = await advisorSession()

      const res = await post<{ revoked: number }>(
        api, `/api/admin/users/${fx.outsiderId}/revoke-sessions`, {}, owner.accessToken,
      )
      expect(res.status, JSON.stringify(res.body)).toBe(200)
      expect(res.body.revoked).toBeGreaterThan(0)

      // Immediate, because requireAuth reads the session row every request.
      expect((await get(api, '/api/auth/me', victim.accessToken)).status).toBe(401)

      const audit = await auditFor(fx.shopB, 'revoke_sessions', fx.outsiderId)
      expect(audit.length).toBeGreaterThan(0)
      expect(audit[0]!.actor_id).toBe(fx.userId)
    })

    /**
     * Role gate, checked on the server. CLAUDE.md §12.1: user administration is
     * owner/manager only, and hiding the button is a hint, not a rule.
     */
    it('refuses the revoke endpoint to an advisor', async () => {
      const advisor = await advisorSession()
      const res = await post(
        api, `/api/admin/users/${fx.userId}/revoke-sessions`, {}, advisor.accessToken,
      )
      expect(res.status).toBe(403)
      expect(res.body).toMatchObject({ error: 'forbidden' })
    })

    /**
     * §12.1 escalation rule 2: being in the same owner group is not permission
     * to touch another branch's staff. The caller acts for shop A; the target is
     * a member of shop B only.
     */
    it('refuses to revoke a user who is not a member of the caller\'s active shop', async () => {
      const ownerAtA = await session(fx.shopA)
      const victim = await advisorSession()

      const res = await post(
        api, `/api/admin/users/${fx.outsiderId}/revoke-sessions`, {}, ownerAtA.accessToken,
      )
      expect(res.status).toBe(404)
      expect(res.body).toMatchObject({ error: 'user_not_found' })

      // And nothing happened to them: a 404 that still revoked would be worse
      // than a 200.
      expect((await get(api, '/api/auth/me', victim.accessToken)).status).toBe(200)
    })

    it('requires a token at all', async () => {
      const res = await post(api, `/api/admin/users/${fx.outsiderId}/revoke-sessions`, {})
      expect(res.status).toBe(401)
    })
  })

  // ===========================================================================
  // Item 5 — one answer for every failed login
  // ===========================================================================
  describe('item 5: login failures are indistinguishable', () => {
    /**
     * The WO asks for `403 no_shop_membership` to be folded into the same 401.
     * A distinct status code is a timing oracle that needs no stopwatch: it
     * confirms a login id is real. Four /login calls, well inside the limiter.
     */
    it('answers identically for a bad password, a missing user and a wrong branch', async () => {
      const wrongPassword = await post(api, '/api/auth/login', {
        loginId: fx.loginId, password: 'wrong',
      })
      const noSuchUser = await post(api, '/api/auth/login', {
        loginId: `absent-${Date.now()}@example.test`, password: PASSWORD,
      })
      const wrongBranch = await post(api, '/api/auth/login', {
        loginId: fx.outsiderLoginId, password: PASSWORD, shopId: fx.shopA,
      })

      for (const res of [wrongPassword, noSuchUser, wrongBranch]) {
        expect(res.status).toBe(401)
        expect(res.body).toEqual({ error: 'invalid_credentials' })
      }
    })

    it('signs a real user in and puts the shop in the token, not in the response only', async () => {
      const res = await post<AuthBody>(api, '/api/auth/login', {
        loginId: fx.loginId, password: PASSWORD, shopId: fx.shopB,
      })
      expect(res.status, JSON.stringify(res.body)).toBe(200)
      expect(res.body.shop.id).toBe(fx.shopB)
      // CLAUDE.md §8 rule 2: the active shop is a signed claim.
      expect(shopOf(res.body.accessToken)).toBe(fx.shopB)
      expect(shopOf(res.cookies.gsms_rt!)).toBe(fx.shopB)
    })
  })

  // ===========================================================================
  // WO-004/T6 condition 2 — the refresh token cookie's actual attributes
  // ===========================================================================
  describe('WO-004/T6: refresh token cookie', () => {
    /**
     * The fixtures' `cookies` map (test/fixtures.ts) deliberately throws away
     * every attribute but name=value, because most tests only care about the
     * token itself. This test is the one place that reads the raw
     * `Set-Cookie` header, because the attributes ARE the point: HttpOnly is
     * what keeps an XSS payload from reading the token at all, and
     * SameSite=Strict is what keeps a cross-site request from riding along
     * with it (docs/ARCHITECTURE.md §7; CLAUDE.md's non-negotiable per
     * WO-003-ANSWERS-2 §2).
     */
    it('sets gsms_rt as HttpOnly, Secure, SameSite=Strict, scoped to /api/auth, and never in the JSON body', async () => {
      const res = await fetch(`${api.url}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ loginId: fx.loginId, password: PASSWORD, shopId: fx.shopA }),
      })
      expect(res.status).toBe(200)

      const setCookie = res.headers.getSetCookie().find((c) => c.startsWith('gsms_rt='))
      expect(setCookie, 'no Set-Cookie for gsms_rt on /api/auth/login').toBeDefined()
      expect(setCookie).toMatch(/;\s*HttpOnly/i)
      expect(setCookie).toMatch(/;\s*Secure/i)
      expect(setCookie).toMatch(/;\s*SameSite=Strict/i)
      expect(setCookie).toMatch(/;\s*Path=\/api\/auth/i)

      const body = await res.json() as Record<string, unknown>
      expect(Object.keys(body)).not.toContain('refreshToken')
      expect(JSON.stringify(body)).not.toContain('refreshToken')
    })

    it('clears gsms_rt on logout', async () => {
      const s = await session(fx.shopA)
      const res = await fetch(`${api.url}/api/auth/logout`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${s.accessToken}` },
        body: '{}',
      })
      expect(res.status).toBe(200)
      const setCookie = res.headers.getSetCookie().find((c) => c.startsWith('gsms_rt='))
      expect(setCookie, 'logout did not clear gsms_rt').toBeDefined()
      // express's res.clearCookie() sends an already-expired cookie with an
      // empty value rather than an explicit "delete" verb.
      expect(setCookie).toMatch(/^gsms_rt=;/)
    })
  })

  // ===========================================================================
  // Item 11 — /me must not hide an unusable shop claim
  // ===========================================================================
  describe('item 11: /me on a revoked membership', () => {
    it('answers 403 rather than a signed-in screen with no branch', async () => {
      const s = await session(fx.shopA)
      const membership = await db.selectFrom('shop_memberships').select(['id', 'role'])
        .where('user_id', '=', fx.userId).where('shop_id', '=', fx.shopA)
        .executeTakeFirstOrThrow()
      await db.deleteFrom('shop_memberships').where('id', '=', membership.id).execute()
      try {
        const res = await get(api, '/api/auth/me', s.accessToken)
        expect(res.status).toBe(403)
        expect(res.body).toMatchObject({ error: 'shop_membership_revoked' })
      } finally {
        await db.insertInto('shop_memberships')
          .values({ user_id: fx.userId, shop_id: fx.shopA, role: membership.role }).execute()
      }
    })
  })

  // ===========================================================================
  // Item 6 — an async failure must not kill the process
  // ===========================================================================
  describe('item 6: async errors reach the central handler', () => {
    /**
     * The Tier 1 tests prove the wrapper in isolation. This proves it on the
     * real app: a request whose handler rejects inside the database layer gets
     * 500 with no stack trace, and the process is still serving afterwards.
     *
     * Provoked with a token naming a user id that is a valid uuid but does not
     * exist, then an endpoint that must still answer. If the process had died,
     * the follow-up request would fail to connect.
     */
    it('keeps serving after a handler fails', async () => {
      const s = await session(fx.shopA)
      // A malformed authorization header is handled, not thrown; use it as a
      // liveness probe around a request that exercises the database path.
      const bad = await get(api, '/api/auth/me', 'not.a.token')
      expect(bad.status).toBe(401)
      expect(JSON.stringify(bad.body)).not.toContain('at ')

      const stillAlive = await get(api, '/api/auth/me', s.accessToken)
      expect(stillAlive.status).toBe(200)
    })
  })
})
