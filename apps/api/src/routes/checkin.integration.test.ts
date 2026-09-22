/**
 * WO-003 T9 — walk-in check-in, against a real PostgreSQL.
 *
 * TIER 2. Skipped when GSMS_TEST_DB is unset; see src/test/env.ts.
 *
 * The interesting failure mode of this door is not "does it open a job" — the
 * throwaway scripts already showed that once — it is "does it ever invent
 * data or hand two cars the same shout across the shop floor". Every test
 * below targets one of those two things.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { withShop } from '@gsms/db/client.js'
import { db } from '../lib/db.js'
import { hasDatabase, tier2 } from '../test/env.js'
import {
  auditFor, createTwoShopFixture, get, issueTokensFor, post, startApi,
  type RunningApi, type TwoShopFixture,
} from '../test/fixtures.js'

interface CheckInBody { jobId: string; queueNo: number; jobDate: string; customerId: string; vehicleId: string }
interface VehicleLookupBody { vehicleId: string; plate: string }

describe.skipIf(!hasDatabase)(tier2('walk-in check-in (POST /api/checkin, lookups)'), () => {
  let api: RunningApi
  let fx: TwoShopFixture

  beforeAll(async () => {
    api = await startApi()
    fx = await createTwoShopFixture('wo003checkin')
  })
  afterAll(async () => {
    await fx?.cleanup()
    await api?.close()
  })

  const owner = (shopId: string) => issueTokensFor(fx.userId, shopId, 'owner')
  const asRole = (shopId: string, role: Parameters<typeof issueTokensFor>[2]) =>
    issueTokensFor(fx.userId, shopId, role)

  // ===========================================================================
  // Case 4, walk-in half — CheckInInput requires plate/customerName/brand/model,
  // so the walk-in door refuses an incomplete car at the SCHEMA, before openJob's
  // own `details_required` outcome is ever reached. That outcome only exists for
  // the arrival door (ArriveInput), where every one of those fields is optional
  // because the booking may already supply it — see
  // bookings.integration.test.ts, case 4, for the test that reaches it.
  // ===========================================================================
  describe('an unknown plate with missing details', () => {
    it('refuses a walk-in missing brand/model with 400 from validation, before any database write', async () => {
      const s = await owner(fx.shopA)
      const plate = 'NODETAILS-1'
      const res = await post(api, '/api/checkin', {
        plate, customerName: 'No Details Customer',
        // brand and model omitted on purpose.
      }, s.accessToken)
      expect(res.status).toBe(400)
      expect(res.body).toMatchObject({ error: 'invalid_request' })

      const rows = await withShop(db, fx.shopA, (trx) => trx.selectFrom('vehicles')
        .select(['id']).where('plate', '=', plate).execute())
      expect(rows, 'a vehicle row was created despite the refusal').toHaveLength(0)
    })

    it('also refuses when brand and model are present but customerName is not', async () => {
      const s = await owner(fx.shopA)
      const plate = 'NODETAILS-2'
      const res = await post(api, '/api/checkin', {
        plate, brand: 'Toyota', model: 'Hilux',
      }, s.accessToken)
      // zod itself refuses first: customerName is a required field on CheckInInput.
      expect(res.status).toBe(400)
    })
  })

  // ===========================================================================
  // Case 8 — plate normalisation
  // ===========================================================================
  describe('plate normalisation', () => {
    it('matches "กก 1234", "กก1234" and "กก-1234" to the same vehicle, via plate_key', async () => {
      const s = await owner(fx.shopA)
      const checkin = await post<CheckInBody>(api, '/api/checkin', {
        plate: 'กก 1234', customerName: 'Plate Normalise Customer', brand: 'Toyota', model: 'Yaris',
      }, s.accessToken)
      expect(checkin.status, JSON.stringify(checkin.body)).toBe(201)

      const noSpace = await get<VehicleLookupBody>(
        api, `/api/checkin/vehicle-lookup?plate=${encodeURIComponent('กก1234')}`, s.accessToken,
      )
      expect(noSpace.status).toBe(200)
      expect(noSpace.body.vehicleId).toBe(checkin.body.vehicleId)

      const dashed = await get<VehicleLookupBody>(
        api, `/api/checkin/vehicle-lookup?plate=${encodeURIComponent('กก-1234')}`, s.accessToken,
      )
      expect(dashed.status).toBe(200)
      expect(
        dashed.body.vehicleId,
        'plate_key comparison did not match the dashed spelling to the same car',
      ).toBe(checkin.body.vehicleId)
    })
  })

  // ===========================================================================
  // Case 9 — queue numbers: unique per (shop, day), allocated without a race
  // ===========================================================================
  describe('queue number allocation', () => {
    it('concurrent server-allocated check-ins all receive distinct queue numbers', async () => {
      const s = await owner(fx.shopA)
      const jobDate = '2030-01-01' // far future, isolated from every other test's default-today numbers
      const attempts = Array.from({ length: 8 }, (_, i) => post<CheckInBody>(api, '/api/checkin', {
        plate: `RACE-QNO-${i}`, customerName: `Race ${i}`, brand: 'Toyota', model: 'Vios', jobDate,
      }, s.accessToken))

      const results = await Promise.all(attempts)
      for (const r of results) expect(r.status, JSON.stringify(r.body)).toBe(201)

      const queueNos = results.map((r) => r.body.queueNo)
      expect(new Set(queueNos).size, `queue numbers were not all distinct: ${queueNos.join(',')}`)
        .toBe(queueNos.length)
    })

    it('a caller-supplied queue number that is already taken is refused, naming the number', async () => {
      const s = await owner(fx.shopA)
      const jobDate = '2030-01-02'
      const first = await post<CheckInBody>(api, '/api/checkin', {
        plate: 'TAKEN-QNO-1', customerName: 'Taken One', brand: 'Toyota', model: 'Vios',
        jobDate, queueNo: 5,
      }, s.accessToken)
      expect(first.status).toBe(201)
      expect(first.body.queueNo).toBe(5)

      const second = await post(api, '/api/checkin', {
        plate: 'TAKEN-QNO-2', customerName: 'Taken Two', brand: 'Toyota', model: 'Vios',
        jobDate, queueNo: 5,
      }, s.accessToken)
      expect(second.status).toBe(409)
      expect(second.body).toMatchObject({ error: 'queue_no_taken', message: 'คิว 5 มีรถคันอื่นแล้ว' })
    })

    it('the same queue number on a different job date is fine', async () => {
      const s = await owner(fx.shopA)
      const a = await post<CheckInBody>(api, '/api/checkin', {
        plate: 'SAMEDAY-QNO-1', customerName: 'Day A', brand: 'Toyota', model: 'Vios',
        jobDate: '2030-01-03', queueNo: 7,
      }, s.accessToken)
      const b = await post<CheckInBody>(api, '/api/checkin', {
        plate: 'SAMEDAY-QNO-2', customerName: 'Day B', brand: 'Toyota', model: 'Vios',
        jobDate: '2030-01-04', queueNo: 7,
      }, s.accessToken)
      expect(a.status).toBe(201)
      expect(b.status).toBe(201)
    })

    it('the same queue number in a different shop is fine', async () => {
      const asA = await owner(fx.shopA)
      const asB = await owner(fx.shopB)
      const a = await post<CheckInBody>(api, '/api/checkin', {
        plate: 'SAMESHOP-QNO-1', customerName: 'Shop A', brand: 'Toyota', model: 'Vios',
        jobDate: '2030-01-05', queueNo: 9,
      }, asA.accessToken)
      const b = await post<CheckInBody>(api, '/api/checkin', {
        plate: 'SAMESHOP-QNO-2', customerName: 'Shop B', brand: 'Toyota', model: 'Vios',
        jobDate: '2030-01-05', queueNo: 9,
      }, asB.accessToken)
      expect(a.status).toBe(201)
      expect(b.status).toBe(201)
    })
  })

  // ===========================================================================
  // Case 7 (lookups) — cross-shop reads return nothing, not another shop's car
  // ===========================================================================
  describe('cross-shop lookups', () => {
    it('a plate checked in at shop A is not found by shop B\'s vehicle-lookup', async () => {
      const asA = await owner(fx.shopA)
      const plate = 'XSHOP-LOOKUP-1'
      const checkin = await post<CheckInBody>(api, '/api/checkin', {
        plate, customerName: 'Cross Shop Lookup', brand: 'Toyota', model: 'Fortuner',
      }, asA.accessToken)
      expect(checkin.status).toBe(201)

      const asB = await owner(fx.shopB)
      const lookup = await get(api, `/api/checkin/vehicle-lookup?plate=${encodeURIComponent(plate)}`, asB.accessToken)
      expect(lookup.status).toBe(404)
      expect(lookup.body).toMatchObject({ error: 'vehicle_not_found' })
    })
  })

  // ===========================================================================
  // Case 12 — role gates
  // ===========================================================================
  describe('role gates', () => {
    it('a viewer cannot check in', async () => {
      const viewer = await asRole(fx.shopA, 'viewer')
      const res = await post(api, '/api/checkin', {
        plate: 'ROLE-VIEWER-1', customerName: 'x', brand: 'x', model: 'x',
      }, viewer.accessToken)
      expect(res.status).toBe(403)
    })

    it('a technician cannot check in', async () => {
      const tech = await asRole(fx.shopA, 'technician')
      const res = await post(api, '/api/checkin', {
        plate: 'ROLE-TECH-1', customerName: 'x', brand: 'x', model: 'x',
      }, tech.accessToken)
      expect(res.status).toBe(403)
    })

    it('a viewer may still use the read-only lookups', async () => {
      const viewer = await asRole(fx.shopA, 'viewer')
      const res = await get(api, `/api/checkin/vehicle-lookup?plate=${encodeURIComponent('NOTHING-HERE')}`, viewer.accessToken)
      // 404, not 403: the role is allowed to read, there is simply no such car.
      expect(res.status).toBe(404)
    })

    it('check-in requires a token at all', async () => {
      const res = await post(api, '/api/checkin', {
        plate: 'ROLE-NOAUTH-1', customerName: 'x', brand: 'x', model: 'x',
      })
      expect(res.status).toBe(401)
    })
  })

  // ===========================================================================
  // Case 13 — audit rows
  // ===========================================================================
  describe('audit log', () => {
    it('writes job_checked_in for a walk-in', async () => {
      const s = await owner(fx.shopA)
      const checkin = await post<CheckInBody>(api, '/api/checkin', {
        plate: 'AUDIT-CHECKIN-1', customerName: 'Audit Checkin', brand: 'Toyota', model: 'Camry',
      }, s.accessToken)
      expect(checkin.status).toBe(201)
      const audit = await auditFor(fx.shopA, 'job_checked_in', checkin.body.jobId)
      expect(audit.length).toBeGreaterThan(0)
    })
  })
})
