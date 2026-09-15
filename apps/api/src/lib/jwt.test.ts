/**
 * WO-001 item 15 — `jwt.verify` must pin `algorithms: ['HS256']`.
 *
 * TIER 1: runs with no database.
 *
 * What the old code did (WO-001 item 15): `jwt.verify(token, secret())` with no
 * `algorithms` option. jsonwebtoken then derives the permitted set from the key
 * type, and for a string key that set is ['HS256', 'HS384', 'HS512'] — so a
 * token whose header names HS384 was verified and accepted. The WO calls this
 * "safe today by accident, because the secret happens to be a string": the
 * accepted set is a property of a dependency's internals, not of our design.
 */
import { describe, expect, it } from 'vitest'
import jwt from 'jsonwebtoken'
import {
  accessExpiresAtMs, newJti, signAccess, signRefresh, verifyAccess, verifyRefresh,
  type AccessPayload, type RefreshPayload,
} from './jwt.js'

const SECRET = process.env.JWT_SECRET!

const access: AccessPayload = {
  sub: '11111111-1111-4111-8111-111111111111',
  shop: '22222222-2222-4222-8222-222222222222',
  role: 'advisor',
  jti: newJti(),
}

describe('access token verification', () => {
  it('accepts a token this system issued', () => {
    const p = verifyAccess(signAccess(access))
    expect(p.sub).toBe(access.sub)
    expect(p.shop).toBe(access.shop)
    expect(p.role).toBe('advisor')
    expect(p.jti).toBe(access.jti)
  })

  it('issues tokens whose header says HS256', () => {
    // Pinning only verify would let the two ends drift: if signing ever moved
    // to HS512 the pin would start rejecting our own tokens. Asserting the
    // header keeps that failure here rather than in production at 08:00.
    const header = JSON.parse(
      Buffer.from(signAccess(access).split('.')[0]!, 'base64url').toString(),
    ) as { alg: string }
    expect(header.alg).toBe('HS256')
  })

  /**
   * THE DISCRIMINATING TEST for item 15.
   *
   * Would have FAILED against the old code: with no `algorithms` option,
   * jsonwebtoken verified this HS384 token happily and `verifyAccess` returned
   * a payload. Verified empirically against jsonwebtoken 9 before writing this.
   */
  it('rejects a token signed with a different HMAC algorithm', () => {
    const hs384 = jwt.sign({ ...access }, SECRET, { algorithm: 'HS384', expiresIn: '15m' })
    // Sanity: the token really is valid under the unpinned rules, so this test
    // is about the pin and not about a malformed token.
    expect(() => jwt.verify(hs384, SECRET)).not.toThrow()
    expect(() => verifyAccess(hs384)).toThrow(/invalid algorithm/i)
  })

  /**
   * Defence in depth, NOT a discriminating test — say so rather than let it
   * read as proof. jsonwebtoken 9 already refuses an `alg: none` token when a
   * key is supplied ("jwt signature is required"), so this would also have
   * passed against the unpinned code. It is here because `alg: none` is the
   * attack the pin is famous for, and a future library change must not
   * reintroduce it quietly.
   */
  it('rejects an unsigned (alg: none) token', () => {
    const none = jwt.sign({ ...access }, '', { algorithm: 'none' })
    expect(() => verifyAccess(none)).toThrow()
  })

  it('rejects a token signed with a different secret', () => {
    const forged = jwt.sign({ ...access }, `${SECRET}-not-ours`, { algorithm: 'HS256' })
    expect(() => verifyAccess(forged)).toThrow()
  })

  it('rejects an expired token', () => {
    const stale = jwt.sign({ ...access }, SECRET, { algorithm: 'HS256', expiresIn: '-1s' })
    expect(() => verifyAccess(stale)).toThrow()
  })

  /**
   * Both tokens are signed with the same key, so the signature cannot tell them
   * apart. Without the `typ` check a refresh token — which the client stores for
   * a fortnight and sends to a different endpoint — would be accepted as a
   * 15-minute access token.
   */
  it('refuses a refresh token presented as an access token', () => {
    const refresh = signRefresh({ sub: access.sub, jti: access.jti, shop: access.shop, typ: 'refresh' })
    expect(() => verifyAccess(refresh)).toThrow(/refresh token used as access token/)
  })
})

describe('refresh token verification', () => {
  /**
   * WO-001 item 10, type half.
   *
   * The active shop travels INSIDE the signed refresh token. The old
   * `RefreshPayload` had no `shop` field, which is why /refresh reached into
   * `req.body.shopId` — the "client names its own tenant" pattern CLAUDE.md §8
   * rule 2 forbids, and the source of the `m.shop_id === m.shop_id` bug.
   *
   * Honest note: at runtime the old `signRefresh` would not have stripped an
   * extra property, so this assertion alone does not discriminate. What
   * discriminates is that `RefreshPayload` now REQUIRES `shop: string` — the
   * object literal below does not compile against the old type, and
   * `npm run typecheck -w apps/api` reads this file (see tsconfig.build.json).
   */
  it('carries the shop inside the signature', () => {
    const payload: RefreshPayload = {
      sub: access.sub, jti: access.jti, shop: access.shop, typ: 'refresh',
    }
    const p = verifyRefresh(signRefresh(payload))
    expect(p.shop).toBe(access.shop)
    expect(p.typ).toBe('refresh')
  })

  it('rejects a token signed with a different HMAC algorithm', () => {
    const hs512 = jwt.sign(
      { sub: access.sub, jti: access.jti, shop: access.shop, typ: 'refresh' },
      SECRET, { algorithm: 'HS512', expiresIn: '14d' },
    )
    expect(() => verifyRefresh(hs512)).toThrow(/invalid algorithm/i)
  })

  it('refuses an access token presented as a refresh token', () => {
    expect(() => verifyRefresh(signAccess(access))).toThrow(/not a refresh token/)
  })
})

describe('accessExpiresAtMs', () => {
  /**
   * WO-001 item 8: a socket authenticated at nine in the morning was still
   * receiving that shop's data at five. The disconnect timer needs this value,
   * so a null here would silently disable the timeout.
   */
  it('returns the exp claim in milliseconds', () => {
    const before = Date.now()
    const ms = accessExpiresAtMs(signAccess(access))
    expect(ms).not.toBeNull()
    // Default TTL is 15m. Allow a wide band: the point is that it is a future
    // millisecond timestamp, not the exact TTL.
    expect(ms!).toBeGreaterThan(before)
    expect(ms!).toBeLessThan(before + 24 * 60 * 60 * 1000)
  })

  it('returns null for something that is not a token', () => {
    expect(accessExpiresAtMs('not-a-token')).toBeNull()
  })
})
