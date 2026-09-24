/**
 * Placeholder phones in a shop whose blocklist table is EMPTY — against a real
 * PostgreSQL.
 *
 * TIER 2. Skipped when GSMS_TEST_DB is unset; see src/test/env.ts.
 *
 * Why a separate file, and why an empty table: migration 0015 seeded known
 * placeholders into match_blocklist only for shops that existed when it ran.
 * Production runs migrations against an empty database and creates its shops
 * afterwards, so the real shop's table starts EMPTY. A fixture shop created by
 * createTwoShopFixture() is in exactly that state — it has no seed rows — so it
 * exercises what production actually has, with no shared rows deleted to fake it.
 *
 * The defect this guards: 0993333333 (from the production dump itself) was
 * protected only by a seed row. With the table empty, the first person keyed as
 * 0993333333 became a customer and every later stranger with that number was
 * MATCHED to them. No second customer was ever created, so the auto-block
 * threshold (more than 3 customers on one number) could never fire either. The
 * merge was silent and permanent. The fix lives in the pure floor
 * (packages/domain isPlaceholderKey); this test proves it reaches the resolver.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { withShop } from '@gsms/db/client.js'
import { db } from '../lib/db.js'
import { hasDatabase, tier2 } from '../test/env.js'
import {
  createTwoShopFixture, get, issueTokensFor, post, startApi,
  type RunningApi, type TwoShopFixture,
} from '../test/fixtures.js'

interface CheckInBody { jobId: string; customerId: string; vehicleId: string }

describe.skipIf(!hasDatabase)(tier2('placeholder phones with an empty blocklist'), () => {
  let api: RunningApi
  let fx: TwoShopFixture

  beforeAll(async () => {
    api = await startApi()
    fx = await createTwoShopFixture('wo003ph')
  })
  afterAll(async () => {
    await fx?.cleanup()
    await api?.close()
  })

  const checkIn = async (plate: string, customerName: string, customerPhone: string) => {
    const { accessToken } = await issueTokensFor(fx.userId, fx.shopA, 'owner')
    return post<CheckInBody>(api, '/api/checkin', {
      plate, customerName, customerPhone, brand: 'Toyota', model: 'Vigo',
    }, accessToken)
  }

  it('starts from a genuinely empty blocklist, as production does', async () => {
    // If this ever fails, the fixture started seeding the table and the test
    // below stopped proving anything about the floor.
    const rows = await withShop(db, fx.shopA, (trx) =>
      trx.selectFrom('match_blocklist').select(['id']).execute())
    expect(rows).toHaveLength(0)
  })

  it('two different people keyed as 0993333333 become two customers, not one', async () => {
    const first = await checkIn('ผผ 1001', 'คนแรก', '0993333333')
    const second = await checkIn('ผผ 1002', 'คนที่สอง', '0993333333')

    expect(first.status).toBe(201)
    expect(second.status).toBe(201)
    expect(second.body.customerId).not.toBe(first.body.customerId)

    // Both still carry the number — a placeholder is stored, just never used
    // to FIND anyone.
    const stored = await withShop(db, fx.shopA, (trx) =>
      trx.selectFrom('customers').select(['name', 'phone'])
        .where('id', 'in', [first.body.customerId, second.body.customerId])
        .orderBy('name').execute())
    expect(stored.map((c) => c.phone)).toEqual(['0993333333', '0993333333'])
  })

  it('the same number typed with separators is caught too', async () => {
    const a = await checkIn('ผผ 2001', 'คนที่สาม', '099-333-3333')
    const b = await checkIn('ผผ 2002', 'คนที่สี่', '099 333 3333')
    expect(b.body.customerId).not.toBe(a.body.customerId)
  })

  it('the prefill lookup does not offer a stranger for the placeholder', async () => {
    const { accessToken } = await issueTokensFor(fx.userId, fx.shopA, 'owner')
    const res = await get(api, '/api/checkin/customer-lookup?phone=0993333333', accessToken)
    expect(res.status).toBe(404)
  })

  it('a real number still finds the same customer — the floor did not over-reach', async () => {
    const a = await checkIn('ผผ 3001', 'ลูกค้าจริง', '0812345666')
    const b = await checkIn('ผผ 3002', 'ลูกค้าจริง', '081-234-5666')
    expect(b.body.customerId).toBe(a.body.customerId)
  })
})
