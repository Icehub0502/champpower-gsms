/**
 * TIER 2 — price_key() must agree with priceKey() (CLAUDE.md §11: migration
 * safety finding on 0020). Both sides fold ASCII only and strip the same
 * explicit code points; packages/domain/src/rules/priceKeyFixtures.ts is the
 * one list both a domain vitest and this test check against, so neither can
 * drift from the other by accident.
 *
 * Skipped when GSMS_TEST_DB is unset (src/test/env.ts) — this test needs
 * migration 0020 applied, which as of this file is proven on a scratch clone
 * only (see packages/db/bench/), not yet on the shared dev database. Point
 * GSMS_TEST_DB / DATABASE_URL at that scratch clone to run it for real; once
 * 0020 lands on the shared dev database this runs unchanged in the normal
 * tier-2 suite.
 */
import { sql } from 'kysely'
import { describe, expect, it } from 'vitest'
import { PRICE_KEY_FIXTURES } from '@champpower/domain'
import { db } from './db.js'
import { hasDatabase, tier2 } from '../test/env.js'

describe.skipIf(!hasDatabase)(tier2('price_key() SQL matches priceKey() JS — shared fixture'), () => {
  for (const f of PRICE_KEY_FIXTURES) {
    it(f.label, async () => {
      const row = await sql<{ got: string }>`select price_key(${f.input}) as got`.execute(db)
      expect(row.rows[0]?.got).toBe(f.expected)
    })
  }
})
