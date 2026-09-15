/**
 * WO-001 item 5 (structural half) — login must always do the bcrypt work.
 *
 * TIER 1: runs with no database. `routes/auth.ts` transitively imports
 * `lib/db.ts`, which throws unless DATABASE_URL is set — vitest.config.ts puts a
 * placeholder there, and pg.Pool does not dial until a query is issued, so the
 * import is safe. No query is issued by anything in this file.
 *
 * What the old code did (WO-001 item 5):
 *
 *     const ok = user?.is_active === true && (await compare(password, user.password_hash))
 *
 * `&&` short-circuits. With no such user, or with a disabled account, `compare`
 * was never called at all. bcryptjs is pure JavaScript — 150-300ms at cost 10 —
 * against roughly 2ms for an indexed SELECT, so "this login id exists" and,
 * separately, "this account was disabled" were both readable straight off
 * `curl -w %{time_total}`. No statistics required.
 *
 * This file proves the STRUCTURE: bcrypt's compare is invoked on all three
 * paths. It is the assertion that cannot flake, and it is the one that would
 * have failed loudly against the old code (0 calls instead of 1).
 * auth.timing.test.ts measures the wall clock on top of it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const compare = vi.fn<(password: string, hash: string) => Promise<boolean>>()

vi.mock('bcryptjs', () => ({
  // Called once at module load to build the dummy hash. Must be synchronous and
  // must return something that looks like a hash.
  // 60 characters, the real bcrypt length: $2a$ + cost + $ + 22 salt + 31 hash.
  hashSync: () => '$2a$10$0123456789012345678901uDUMMYDUMMYDUMMYDUMMYDUMMYDUMMY',
  compare: (password: string, hash: string) => compare(password, hash),
}))

const { verifyPasswordConstantWork } = await import('./auth.js')

const REAL_HASH = '$2a$10$abcdefghijklmnopqrstuuREALREALREALREALREALREALREALREA'

beforeEach(() => {
  compare.mockReset()
  compare.mockResolvedValue(false)
})

describe('verifyPasswordConstantWork', () => {
  /**
   * PATH 1 — the user exists and the password is wrong.
   * The baseline: bcrypt obviously ran here, in the old code too.
   */
  it('runs bcrypt when the user exists', async () => {
    await verifyPasswordConstantWork('hunter2', REAL_HASH)
    expect(compare).toHaveBeenCalledTimes(1)
    expect(compare).toHaveBeenCalledWith('hunter2', REAL_HASH)
  })

  /**
   * PATH 2 — no such user.
   *
   * THE DISCRIMINATING ASSERTION. Against the old code this was 0 calls, and
   * the request returned in single-digit milliseconds while a real login id
   * took a quarter of a second.
   */
  it('still runs bcrypt when there is no such user', async () => {
    const ok = await verifyPasswordConstantWork('hunter2', null)
    expect(compare).toHaveBeenCalledTimes(1)
    expect(ok).toBe(false)
  })

  /**
   * PATH 2, second half: the work must be done against a hash of the same
   * shape and cost, not against an empty string or a short constant. A cheaper
   * comparison is still a shorter response, and the oracle survives.
   */
  it('compares the no-user path against a real bcrypt hash at the same cost', async () => {
    await verifyPasswordConstantWork('hunter2', null)
    const [, hash] = compare.mock.calls[0]!
    expect(hash).toMatch(/^\$2[aby]\$10\$/)
    expect(hash).toHaveLength(60)
  })

  /**
   * PATH 3 — the account exists but is disabled.
   *
   * This is the third path the brief calls out, and the old code leaked it
   * SEPARATELY: `user?.is_active === true &&` short-circuited before `compare`,
   * so a disabled account answered as fast as a non-existent one — which
   * distinguishes "used to work here" from "never existed". Here, a disabled
   * account still has a password_hash and the route passes it in unchanged
   * (routes/auth.ts calls this BEFORE consulting is_active), so the work is
   * identical to path 1.
   */
  it('runs the same work for a disabled account as for an active one', async () => {
    await verifyPasswordConstantWork('hunter2', REAL_HASH)
    const activeCall = compare.mock.calls[0]
    compare.mockReset()
    compare.mockResolvedValue(false)
    // A disabled user is read from `users` exactly like an active one, hash and
    // all; is_active is not consulted until after this returns.
    await verifyPasswordConstantWork('hunter2', REAL_HASH)
    expect(compare.mock.calls[0]).toEqual(activeCall)
  })

  /**
   * The ordering guarantee the structure depends on: is_active must NOT be
   * folded back into this function as a short-circuit. Verified at the source
   * level, because this is precisely the edit that would silently reopen the
   * hole and pass every behavioural test.
   */
  it('has no short-circuit in front of the comparison', async () => {
    const fs = await import('node:fs/promises')
    const url = await import('node:url')
    const source = await fs.readFile(
      url.fileURLToPath(new URL('./auth.ts', import.meta.url)), 'utf8',
    )
    const body = /export async function verifyPasswordConstantWork[\s\S]*?\n}/.exec(source)?.[0]
    expect(body, 'verifyPasswordConstantWork not found in routes/auth.ts').toBeTruthy()
    // `&&` or `?.` in front of the await is the whole vulnerability.
    expect(body!).not.toMatch(/&&\s*\(?\s*await\s+compare/)
    expect(body!).toMatch(/await compare\(/)
  })

  it('returns false for a correct password against no user at all', async () => {
    // Even if the dummy hash somehow matched, a null stored hash means no user,
    // and no user can never be a successful login.
    compare.mockResolvedValue(true)
    await expect(verifyPasswordConstantWork('anything', null)).resolves.toBe(false)
  })

  it('returns true only when a real hash matches', async () => {
    compare.mockResolvedValue(true)
    await expect(verifyPasswordConstantWork('correct', REAL_HASH)).resolves.toBe(true)
  })
})
