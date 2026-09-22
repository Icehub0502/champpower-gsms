/**
 * Tier 2 fixtures — only ever reached from a `describe.skipIf(!hasDatabase)`.
 *
 * Nothing in this module issues a query at import time, so importing it on a
 * machine with no PostgreSQL is harmless (pg.Pool does not dial until asked).
 *
 * The rows created here go into the identity tables (owner_groups, shops, users,
 * shop_memberships), which carry no shop_id and therefore no RLS — see the note
 * in migration 0012 section 5 for why that is deliberate and what it costs.
 */
import { createServer, type Server } from 'node:http'
import { randomUUID } from 'node:crypto'
import { hashSync } from 'bcryptjs'
import { sql } from 'kysely'
import { unscoped, withShop } from '@gsms/db/client.js'
import { db } from '../lib/db.js'
import { issueSession, type IssuedTokens } from '../services/sessions.js'
import type { Role } from '../lib/jwt.js'

export const PASSWORD = 'correct-horse-battery-staple'

export interface TwoShopFixture {
  ownerGroupId: string
  shopA: string
  shopB: string
  userId: string
  loginId: string
  /** A second user who belongs to shopB only. */
  outsiderId: string
  outsiderLoginId: string
  cleanup: () => Promise<void>
}

/**
 * One owner group, two branches, one user who is a member of both, and one user
 * who is a member of the second branch only.
 *
 * Two shops in ONE group is the hard case on purpose: the cross-branch tests
 * would be trivially satisfied by an `owner_group_id` filter, and CLAUDE.md §8.1
 * rule 2 says that filter is exactly the wrong one.
 */
export async function createTwoShopFixture(prefix = 'wo001'): Promise<TwoShopFixture> {
  const tag = randomUUID().slice(0, 8)
  const hash = hashSync(PASSWORD, 10)

  const group = await db.insertInto('owner_groups')
    .values({ name: `${prefix}-group-${tag}`, slug: `${prefix}-group-${tag}` })
    .returning('id').executeTakeFirstOrThrow()

  const [a, b] = await db.insertInto('shops')
    .values([
      { owner_group_id: group.id, name: `${prefix}-A-${tag}`, slug: `${prefix}-a-${tag}` },
      { owner_group_id: group.id, name: `${prefix}-B-${tag}`, slug: `${prefix}-b-${tag}` },
    ])
    .returning(['id', 'slug']).execute()

  // A shop that cannot number a job is not a realistic shop. Document series
  // are created by seed_document_series(), which packages/db/src/seed.ts calls
  // and nothing else does — there is no shop-creation endpoint yet — so a
  // fixture shop without this call makes every intake test exercise a branch
  // that only a misconfigured branch would ever reach.
  // It runs inside withShop because document_series carries RLS: the INSERT's
  // WITH CHECK compares shop_id against current_shop_id(), which is NULL
  // outside a shop scope, so on the bare handle every row would be refused.
  for (const shop of [a!, b!]) {
    await withShop(db, shop.id, (trx) =>
      sql`select seed_document_series(${shop.id}::uuid)`.execute(trx))
  }

  const loginId = `${prefix}-user-${tag}@example.test`
  const user = await db.insertInto('users')
    .values({ login_id: loginId, password_hash: hash, name: 'Fixture User', is_active: true })
    .returning('id').executeTakeFirstOrThrow()

  const outsiderLoginId = `${prefix}-outsider-${tag}@example.test`
  const outsider = await db.insertInto('users')
    .values({ login_id: outsiderLoginId, password_hash: hash, name: 'Outsider', is_active: true })
    .returning('id').executeTakeFirstOrThrow()

  await db.insertInto('shop_memberships').values([
    { user_id: user.id, shop_id: a!.id, role: 'owner' },
    { user_id: user.id, shop_id: b!.id, role: 'owner' },
    { user_id: outsider.id, shop_id: b!.id, role: 'advisor' },
  ]).execute()

  return {
    ownerGroupId: group.id,
    // `shops` was inserted in order, but RETURNING order is not guaranteed by
    // the standard, so match on the slug rather than on the array position.
    shopA: (a!.slug.endsWith('-a-' + tag) ? a! : b!).id,
    shopB: (a!.slug.endsWith('-a-' + tag) ? b! : a!).id,
    userId: user.id,
    loginId,
    outsiderId: outsider.id,
    outsiderLoginId,
    async cleanup() {
      // Order matters: audit_logs and customers reference shops with RESTRICT.
      // Both carry RLS, so the deletes must run inside withShop — outside it
      // `current_shop_id()` is NULL and the DELETE would silently affect no rows
      // and then the shops DELETE would fail on the foreign key.
      for (const shopId of [a!.id, b!.id]) {
        await withShop(db, shopId, async (trx) => {
          await trx.deleteFrom('audit_logs').where('shop_id', '=', shopId).execute()
          // Jobs reference customers with RESTRICT, and bookings reference
          // bays, so the order here is the foreign keys' order, not a
          // convenient one. document_series is on the list because the shop
          // DELETE below references it with RESTRICT too — a fixture that
          // seeds it has to clear it.
          await trx.deleteFrom('job_complaints').where('shop_id', '=', shopId).execute()
          await trx.deleteFrom('job_photos').where('shop_id', '=', shopId).execute()
          await trx.deleteFrom('jobs').where('shop_id', '=', shopId).execute()
          await trx.deleteFrom('bookings').where('shop_id', '=', shopId).execute()
          await trx.deleteFrom('vehicles').where('shop_id', '=', shopId).execute()
          await trx.deleteFrom('customers').where('shop_id', '=', shopId).execute()
          await trx.deleteFrom('bays').where('shop_id', '=', shopId).execute()
          await trx.deleteFrom('document_series').where('shop_id', '=', shopId).execute()
          // Auto rows appear on their own whenever a test drives a shared
          // phone past the threshold, so this is not optional tidying: shops
          // references match_blocklist with RESTRICT.
          await trx.deleteFrom('match_blocklist').where('shop_id', '=', shopId).execute()
        })
      }
      await db.deleteFrom('sessions').where('user_id', 'in', [user.id, outsider.id]).execute()
      await db.deleteFrom('shop_memberships').where('user_id', 'in', [user.id, outsider.id]).execute()
      await db.deleteFrom('users').where('id', 'in', [user.id, outsider.id]).execute()
      await db.deleteFrom('shops').where('id', 'in', [a!.id, b!.id]).execute()
      await db.deleteFrom('owner_groups').where('id', '=', group.id).execute()
    },
  }
}

/**
 * Mint a real session without going through /login.
 *
 * Deliberate: the per-IP limiter on /api/auth/login allows 20 attempts per
 * fifteen minutes and the per-account limiter allows 10, which is correct
 * behaviour and must not be weakened for the tests' convenience. A suite that
 * signs in thirty times would be testing the rate limiter by accident and would
 * start failing halfway through. Tests whose SUBJECT is /login call it; every
 * other test asks for a session directly, through the same
 * `services/sessions.ts` the endpoint uses.
 */
export async function issueTokensFor(
  userId: string, shopId: string, role: Role = 'owner',
): Promise<IssuedTokens> {
  // `unscoped`, not a bare `db.transaction()`: since WO item 12 the session
  // helpers only accept a branded ScopedTx or UnscopedTx, so that an identity
  // write cannot be issued on the raw pool handle outside any transaction.
  return unscoped(db, (trx) =>
    issueSession(trx, userId, { shop_id: shopId, role }, 'vitest'))
}

/** Read audit_logs for one shop. They carry RLS, so this needs a shop scope. */
export async function auditFor(
  shopId: string, action: string, entityId?: string,
): Promise<{ action: string; actor_id: string | null; entity_id: string | null }[]> {
  return withShop(db, shopId, async (trx) => {
    let q = trx.selectFrom('audit_logs')
      .select(['action', 'actor_id', 'entity_id'])
      .where('action', '=', action)
    if (entityId) q = q.where('entity_id', '=', entityId)
    return q.execute()
  })
}

export interface RunningApi {
  url: string
  close: () => Promise<void>
}

/** Start the real Express app on an ephemeral port. */
export async function startApi(): Promise<RunningApi> {
  const { app } = await import('../app.js')
  const server: Server = createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  if (typeof addr === 'string' || addr === null) throw new Error('no port')
  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()) }),
  }
}

export interface ApiResponse<T = Record<string, unknown>> {
  status: number
  body: T
  /**
   * Cookies the response set, name -> value, ignoring attributes (Path,
   * HttpOnly, ...). Since WO-004/T6 the refresh token never appears in a JSON
   * body (routes/auth.ts) — it only ever travels this way, under
   * `gsms_rt` — so any test that needs the rotated token reads it from here.
   */
  cookies: Record<string, string>
}

/** Parses one or more `Set-Cookie` response headers into name -> value pairs.
 * Node's fetch (undici) exposes them individually via `getSetCookie()`
 * rather than folded into one combined header. */
function parseSetCookies(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of headers.getSetCookie()) {
    const firstPair = raw.split(';', 1)[0]!
    const eq = firstPair.indexOf('=')
    if (eq === -1) continue
    out[firstPair.slice(0, eq).trim()] = firstPair.slice(eq + 1).trim()
  }
  return out
}

export async function post<T = Record<string, unknown>>(
  api: RunningApi, path: string, body: unknown, token?: string,
): Promise<ApiResponse<T>> {
  const res = await fetch(`${api.url}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body ?? {}),
  })
  return {
    status: res.status,
    body: (await res.json().catch(() => ({}))) as T,
    cookies: parseSetCookies(res.headers),
  }
}

export async function patch<T = Record<string, unknown>>(
  api: RunningApi, path: string, body: unknown, token?: string,
): Promise<ApiResponse<T>> {
  const res = await fetch(`${api.url}${path}`, {
    method: 'PATCH',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body ?? {}),
  })
  return {
    status: res.status,
    body: (await res.json().catch(() => ({}))) as T,
    cookies: parseSetCookies(res.headers),
  }
}

export async function get<T = Record<string, unknown>>(
  api: RunningApi, path: string, token?: string,
): Promise<ApiResponse<T>> {
  const res = await fetch(`${api.url}${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  })
  return {
    status: res.status,
    body: (await res.json().catch(() => ({}))) as T,
    cookies: parseSetCookies(res.headers),
  }
}

/**
 * The name of the refresh cookie, mirrored from routes/auth.ts.
 *
 * Kept here rather than exported from the route so a rename there fails these
 * tests loudly instead of quietly changing what they exercise.
 */
export const REFRESH_COOKIE_NAME = 'gsms_rt'

/**
 * Call /api/auth/refresh or /api/auth/logout the way a browser does: with the
 * refresh token in its cookie.
 *
 * The endpoint accepts the token from the cookie and nowhere else — the body
 * fallback was removed deliberately (see the note on `refreshSchema` in
 * routes/auth.ts). A test that reached in through a back door would be proving
 * a code path that production never runs, which is worse than no test.
 */
export async function postWithRefreshCookie<T = Record<string, unknown>>(
  api: RunningApi, path: string, refreshToken: string, body: unknown = {},
): Promise<ApiResponse<T>> {
  const res = await fetch(`${api.url}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: `${REFRESH_COOKIE_NAME}=${refreshToken}`,
    },
    body: JSON.stringify(body),
  })
  return {
    status: res.status,
    body: (await res.json().catch(() => ({}))) as T,
    cookies: parseSetCookies(res.headers),
  }
}

/** The jti inside an access or refresh token, without verifying it. */
export function jtiOf(token: string): string {
  const [, payload] = token.split('.')
  return (JSON.parse(Buffer.from(payload!, 'base64url').toString()) as { jti: string }).jti
}

export function shopOf(token: string): string {
  const [, payload] = token.split('.')
  return (JSON.parse(Buffer.from(payload!, 'base64url').toString()) as { shop: string }).shop
}
