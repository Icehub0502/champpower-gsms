/**
 * Province at check-in — stored on a new car, never rewritten on an existing one.
 *
 * TIER 2. Skipped when GSMS_TEST_DB is unset; see src/test/env.ts.
 *
 * The defect: the check-in page collects จังหวัด, vehicles.province exists in the
 * schema (0002), but nothing between the two carried it, so what staff typed was
 * thrown away. These tests pin the two halves of the fix: a NEW car keeps the
 * province it was checked in with, and an EXISTING car's province is not rewritten
 * by a later check-in that says something different — the same principle as never
 * changing a car's owner silently.
 *
 * Deliberately NOT tested, because it is not decided: whether province should be
 * part of how a car is found. Cars are matched on plate_key alone; see the open
 * question on vehiclesRepo.findByPlate.
 */
// Plates here are ordinary ones. (Repeated-digit plates used to be refused as
// match keys by a pattern rule; that rule is gone, so this is no longer a
// constraint, just a habit that keeps these tests about province alone.)
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { withShop } from '@gsms/db/client.js'
import { db } from '../lib/db.js'
import { hasDatabase, tier2 } from '../test/env.js'
import {
  createTwoShopFixture, get, issueTokensFor, post, startApi,
  type RunningApi, type TwoShopFixture,
} from '../test/fixtures.js'

interface CheckInBody { jobId: string; customerId: string; vehicleId: string }
interface LookupBody { vehicleId: string; province: string | null }

describe.skipIf(!hasDatabase)(tier2('province at check-in'), () => {
  let api: RunningApi
  let fx: TwoShopFixture

  beforeAll(async () => {
    api = await startApi()
    fx = await createTwoShopFixture('wo003prov')
  })
  afterAll(async () => {
    await fx?.cleanup()
    await api?.close()
  })

  const token = async () => (await issueTokensFor(fx.userId, fx.shopA, 'owner')).accessToken
  const storedProvince = (vehicleId: string) =>
    withShop(db, fx.shopA, async (trx) =>
      (await trx.selectFrom('vehicles').select(['province']).where('id', '=', vehicleId)
        .executeTakeFirstOrThrow()).province)

  it('a new car checked in with a province stores it, and the lookup returns it', async () => {
    const t = await token()
    const res = await post<CheckInBody>(api, '/api/checkin', {
      plate: 'ฒฒ 1234', customerName: 'จังหวัดใหม่', customerPhone: '0811230001',
      brand: 'Toyota', model: 'Vios', province: 'นนทบุรี',
    }, t)
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    expect(await storedProvince(res.body.vehicleId)).toBe('นนทบุรี')

    const lookup = await get<LookupBody>(api, `/api/checkin/vehicle-lookup?plate=${encodeURIComponent('ฒฒ1234')}`, t)
    expect(lookup.status).toBe(200)
    expect(lookup.body.province).toBe('นนทบุรี')
  })

  it('an existing car keeps its province when a later check-in says something different', async () => {
    const t = await token()
    const first = await post<CheckInBody>(api, '/api/checkin', {
      plate: 'ฒฒ 5678', customerName: 'เจ้าของเดิม', customerPhone: '0811230002',
      brand: 'Isuzu', model: 'D-Max', province: 'กรุงเทพมหานคร',
    }, t)
    expect(first.status, JSON.stringify(first.body)).toBe(201)

    // Same plate, same owner (same phone, so no ownership question arises), a
    // different province typed at the counter.
    const again = await post<CheckInBody>(api, '/api/checkin', {
      plate: 'ฒฒ 5678', customerName: 'เจ้าของเดิม', customerPhone: '0811230002',
      brand: 'Isuzu', model: 'D-Max', province: 'ชลบุรี',
    }, t)
    expect(again.status, JSON.stringify(again.body)).toBe(201)

    // Still found by plate alone — the same car, not a new one.
    expect(again.body.vehicleId).toBe(first.body.vehicleId)
    // And not rewritten.
    expect(await storedProvince(first.body.vehicleId)).toBe('กรุงเทพมหานคร')
  })

  it('a province is optional — a walk-in without one still checks in', async () => {
    const t = await token()
    const res = await post<CheckInBody>(api, '/api/checkin', {
      plate: 'ฒฒ 3579', customerName: 'ไม่ระบุจังหวัด', brand: 'Honda', model: 'City',
    }, t)
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    expect(await storedProvince(res.body.vehicleId)).toBeNull()
  })

  it('an existing car with NO province stays empty when a later check-in brings one', async () => {
    // Never-overwrite includes NULL, for now: whether an empty province may be
    // filled in (reviewer: "only when NULL, with an audit row") is with the owner.
    const t = await token()
    const car = { customerName: 'ยังไม่มีจังหวัด', customerPhone: '0811230004', brand: 'Mazda', model: '2' }
    const first = await post<CheckInBody>(api, '/api/checkin', { plate: 'ฒฒ 4680', ...car }, t)
    expect(first.status, JSON.stringify(first.body)).toBe(201)
    expect(await storedProvince(first.body.vehicleId)).toBeNull()

    const again = await post<CheckInBody>(api, '/api/checkin', { plate: 'ฒฒ 4680', ...car, province: 'ระยอง' }, t)
    expect(again.body.vehicleId).toBe(first.body.vehicleId)
    expect(await storedProvince(first.body.vehicleId)).toBeNull()
  })

  it('an arrival that creates a new car stores the province typed at arrival', async () => {
    const t = await token()
    const booking = await post<{ id: string }>(api, '/api/bookings', {
      source: 'phone', bayId: null, contactName: 'จองแล้วมา',
      slotStart: new Date(Date.now() + 3_600_000).toISOString(),
      slotEnd: new Date(Date.now() + 7_200_000).toISOString(),
    }, t)
    expect(booking.status, JSON.stringify(booking.body)).toBe(201)
    const arrived = await post<CheckInBody>(api, `/api/bookings/${booking.body.id}/arrive`, {
      plate: 'ฒฒ 5791', brand: 'Nissan', model: 'Navara', province: 'สมุทรปราการ',
    }, t)
    expect(arrived.status, JSON.stringify(arrived.body)).toBe(201)
    expect(await storedProvince(arrived.body.vehicleId)).toBe('สมุทรปราการ')
  })
})
