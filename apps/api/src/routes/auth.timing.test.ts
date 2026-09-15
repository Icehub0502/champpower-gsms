/**
 * WO-001 item 5 (wall-clock half) — login must not be a timing oracle.
 *
 * TIER 1: runs with no database. The measurement is taken at the bcrypt seam,
 * `verifyPasswordConstantWork`, not over HTTP: an HTTP measurement would fold in
 * the rate limiter, JSON parsing, the event loop and a database round trip, all
 * of which are noisier than the effect being measured and none of which are what
 * the fix changed.
 *
 * The WO's criterion: "response time for an existing user versus a non-existent
 * user differs by no more than 20%".
 *
 * Three paths, not two:
 *   A. the user exists, the password is wrong        -> a real hash
 *   B. no such user                                  -> the boot-time dummy hash
 *   C. the user exists but the account is disabled   -> a real hash, and the
 *      route calls this BEFORE consulting is_active, so it is path A's cost
 *
 * Against the old code, B and C both returned without calling bcrypt at all:
 * roughly 2ms against roughly 200ms, a ratio near 100x, not 1.2x.
 *
 * Anti-flake measures, because a test that fails on a busy CI box teaches people
 * to ignore it:
 *   - MEDIAN, not mean. One GC pause ruins a mean; a median shrugs it off.
 *   - Samples are INTERLEAVED (A,B,C,A,B,C...) so a machine that gets slower
 *     part-way through penalises all three paths equally rather than the one
 *     that happened to run last.
 *   - A warm-up round is discarded, so JIT compilation of bcryptjs is not
 *     counted against whichever path ran first.
 *   - The assertion is on the ratio of the slowest median to the fastest, which
 *     is symmetric: it does not matter which path wins.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { hashSync } from 'bcryptjs'
import { verifyPasswordConstantWork } from './auth.js'

const COST = Number(process.env.BCRYPT_COST ?? 10)
const SAMPLES = 11
const WARMUP = 3
/** The WO's number. */
const MAX_RATIO = 1.2

let realHash: string

beforeAll(() => {
  realHash = hashSync('the-right-password', COST)
})

function median(xs: number[]): number {
  const sorted = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!
}

async function timeOnce(storedHash: string | null): Promise<number> {
  const started = performance.now()
  await verifyPasswordConstantWork('a-wrong-password', storedHash)
  return performance.now() - started
}

describe('login timing', () => {
  it('costs the same whether the user exists, does not exist, or is disabled', async () => {
    const paths: Record<string, string | null> = {
      'existing user, wrong password': realHash,
      'no such user': null,
      // A disabled account is read from `users` with its hash intact; the route
      // hands that hash straight to this function and only then looks at
      // is_active. The old code's `user?.is_active === true &&` guard is what
      // made this path measurably different from the one above.
      'existing user, account disabled': realHash,
    }
    const names = Object.keys(paths)
    const timings: Record<string, number[]> = Object.fromEntries(names.map((n) => [n, []]))

    for (let i = 0; i < SAMPLES + WARMUP; i++) {
      for (const name of names) {
        const ms = await timeOnce(paths[name]!)
        if (i >= WARMUP) timings[name]!.push(ms)
      }
    }

    const medians = Object.fromEntries(names.map((n) => [n, median(timings[n]!)]))
    const values = Object.values(medians)
    const slowest = Math.max(...values)
    const fastest = Math.min(...values)
    const ratio = slowest / fastest

    const report = names.map((n) => `${n}: ${medians[n]!.toFixed(1)}ms`).join(' | ')

    // If bcrypt were being skipped on any path, that path's median would be
    // sub-millisecond and this would be enormous. Guard against the degenerate
    // case explicitly so a divide-by-almost-zero cannot pass.
    expect(fastest, `a path finished implausibly fast — bcrypt was skipped. ${report}`)
      .toBeGreaterThan(1)

    expect(ratio, `login timing differs by more than ${((MAX_RATIO - 1) * 100).toFixed(0)}%. ${report}`)
      .toBeLessThanOrEqual(MAX_RATIO)
  })

  /**
   * The same measurement stated the other way round: whatever the caller asks
   * about, a comparison against a 60-character cost-10 hash happens. A path
   * that took under a millisecond did not run bcrypt.
   */
  it('spends real bcrypt time on the no-such-user path', async () => {
    const samples: number[] = []
    for (let i = 0; i < 5; i++) samples.push(await timeOnce(null))
    expect(median(samples)).toBeGreaterThan(1)
  })
})
