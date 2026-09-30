/**
 * A blank optional field means "not given" — never a 400, never an empty string stored.
 *
 * The defect (code review, 26 Sep 2026, MEDIUM): the check-in page sends
 * `province.trim()`, which is `''` when nobody types one, and the contract
 * answered 400 invalid_request — so a walk-in with no province could not open a
 * job at all. The same trap sat on every optional text field that has a format
 * or a minimum length (phone, date, lead source, bay, and on arrival the plate,
 * name, brand and model). packages/contracts common.ts blankAsAbsent() now turns
 * a blank into `undefined` before the field's own rules run.
 *
 * Tier 1 checks the schemas directly; tier 2 checks the real endpoints store
 * NULL, and that on arrival a blank falls back to the booking instead of being
 * refused.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { withShop } from '@gsms/db/client.js'
import { ArriveInput, CheckInInput } from '@gsms/contracts/index.js'
import { db } from '../lib/db.js'
import { hasDatabase, tier2 } from '../test/env.js'
import {
  createTwoShopFixture, issueTokensFor, post, startApi,
  type RunningApi, type TwoShopFixture,
} from '../test/fixtures.js'

// Every optional field a person types or picks, left blank the way a form sends it.
const BLANK_OPTIONALS = {
  customerPhone: '', color: '', year: '', province: '', jobDate: '',
  symptom: '', bayId: '', leadSource: '',
}

describe('blank optional fields in the schemas (tier 1)', () => {
  const required = { plate: 'บบ 1234', customerName: 'ชื่อ', brand: 'Toyota', model: 'Vios', province: 'กรุงเทพมหานคร' }

  it('CheckInInput accepts every optional field blank, and treats each as absent', () => {
    const r = CheckInInput.safeParse({ ...required, ...BLANK_OPTIONALS })
    expect(r.success, JSON.stringify(r.success ? null : r.error.flatten())).toBe(true)
    if (!r.success) return
    for (const k of Object.keys(BLANK_OPTIONALS)) {
      expect((r.data as Record<string, unknown>)[k], `${k} should be absent`).toBeUndefined()
    }
  })

  it('whitespace-only counts as blank', () => {
    const r = CheckInInput.safeParse({ ...required, province: '   ', customerPhone: '  ' })
    expect(r.success).toBe(true)
  })

  it('a non-blank value is still checked in full', () => {
    expect(CheckInInput.safeParse({ ...required, customerPhone: 'abc' }).success).toBe(false)
    expect(CheckInInput.safeParse({ ...required, jobDate: 'tomorrow' }).success).toBe(false)
    expect(CheckInInput.safeParse({ ...required, leadSource: 'tiktok' }).success).toBe(false)
  })

  it('a REQUIRED field left blank is still refused', () => {
    expect(CheckInInput.safeParse({ ...required, plate: '' }).success).toBe(false)
    expect(CheckInInput.safeParse({ ...required, customerName: '' }).success).toBe(false)
  })

  // LOW 1 (code review): null counts as absent too, and the numeric fields are
  // wrapped — an empty number box arrives as '' or null, never as a number.
  const OPTIONAL_CHECKIN = [...Object.keys(BLANK_OPTIONALS), 'queueNo', 'mileageInKm']
  const OPTIONAL_ARRIVE = [...OPTIONAL_CHECKIN, 'plate', 'customerName', 'brand', 'model']

  for (const empty of ['', null] as const) {
    it(`CheckInInput: ${JSON.stringify(empty)} on each optional field parses as absent`, () => {
      for (const field of OPTIONAL_CHECKIN) {
        const r = CheckInInput.safeParse({ ...required, [field]: empty })
        expect(r.success, `${field}=${JSON.stringify(empty)} was refused`).toBe(true)
        if (r.success) expect((r.data as Record<string, unknown>)[field], field).toBeUndefined()
      }
    })

    it(`ArriveInput: ${JSON.stringify(empty)} on each optional field parses as absent`, () => {
      for (const field of OPTIONAL_ARRIVE) {
        const r = ArriveInput.safeParse({ [field]: empty })
        expect(r.success, `${field}=${JSON.stringify(empty)} was refused`).toBe(true)
        if (r.success) expect((r.data as Record<string, unknown>)[field], field).toBeUndefined()
      }
    })
  }

  it('a non-blank bad NUMBER is still refused', () => {
    expect(CheckInInput.safeParse({ ...required, queueNo: 0 }).success).toBe(false)
    expect(CheckInInput.safeParse({ ...required, queueNo: 'five' }).success).toBe(false)
    expect(CheckInInput.safeParse({ ...required, mileageInKm: -1 }).success).toBe(false)
    expect(ArriveInput.safeParse({ mileageInKm: 1.5 }).success).toBe(false)
  })

  it('ArriveInput accepts every optional field blank, including the car and customer fields', () => {
    const r = ArriveInput.safeParse({
      ...BLANK_OPTIONALS, plate: '', customerName: '', brand: '', model: '', province: 'กรุงเทพมหานคร',
    })
    expect(r.success, JSON.stringify(r.success ? null : r.error.flatten())).toBe(true)
  })
})

describe.skipIf(!hasDatabase)(tier2('blank optional fields at the endpoints'), () => {
  let api: RunningApi
  let fx: TwoShopFixture

  beforeAll(async () => {
    api = await startApi()
    fx = await createTwoShopFixture('wo003blank')
  })
  afterAll(async () => {
    await fx?.cleanup()
    await api?.close()
  })

  const token = async () => (await issueTokensFor(fx.userId, fx.shopA, 'owner')).accessToken

  it('a walk-in with every optional field blank opens a job, and stores NULL, not ""', async () => {
    // Province is set AFTER the blanks: a new car cannot be created without one
    // (owner decision, 29 Sep 2026 — see the next test).
    const res = await post<{ jobId: string; customerId: string; vehicleId: string; jobDate: string }>(
      api, '/api/checkin',
      { plate: 'บบ 2345', customerName: 'ไม่กรอกอะไรเลย', brand: 'Toyota', model: 'Vios', ...BLANK_OPTIONALS, province: 'กรุงเทพมหานคร' },
      await token(),
    )
    expect(res.status, JSON.stringify(res.body)).toBe(201)

    const stored = await withShop(db, fx.shopA, async (trx) => ({
      vehicle: await trx.selectFrom('vehicles').select(['color', 'year', 'province'])
        .where('id', '=', res.body.vehicleId).executeTakeFirstOrThrow(),
      customer: await trx.selectFrom('customers').select(['phone', 'lead_source'])
        .where('id', '=', res.body.customerId).executeTakeFirstOrThrow(),
      job: await trx.selectFrom('jobs').select(['bay_id'])
        .where('id', '=', res.body.jobId).executeTakeFirstOrThrow(),
      complaints: await trx.selectFrom('job_complaints').select(['id'])
        .where('job_id', '=', res.body.jobId).execute(),
    }))
    expect(stored.vehicle).toEqual({ color: null, year: null, province: 'กรุงเทพมหานคร' })
    expect(stored.customer).toEqual({ phone: null, lead_source: null })
    expect(stored.job.bay_id).toBeNull()
    expect(stored.complaints, 'a blank symptom became a complaint line').toHaveLength(0)
    // A blank job date means "today", exactly as if it had been left out.
    expect(res.body.jobDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('a blank province on a NEW car is asked for (409 naming province), never a 400', async () => {
    const res = await post(api, '/api/checkin',
      { plate: 'บบ 2346', customerName: 'ไม่กรอกจังหวัด', brand: 'Toyota', model: 'Vios', province: '' },
      await token())
    expect(res.status, JSON.stringify(res.body)).toBe(409)
    expect(res.body).toMatchObject({ error: 'intake_details_required', fields: { province: ['required'] } })
  })

  it('on arrival, a blank falls back to the booking — it is not a 400', async () => {
    const t = await token()
    const booking = await post<{ id: string }>(api, '/api/bookings', {
      source: 'phone',
      slotStart: new Date(Date.now() + 3_600_000).toISOString(),
      slotEnd: new Date(Date.now() + 7_200_000).toISOString(),
      bayId: null,
      contactName: 'จองไว้',
    }, t)
    expect(booking.status, JSON.stringify(booking.body)).toBe(201)

    // Every field blank: the booking has no car, so the honest answer is
    // vehicle_required — NOT invalid_request.
    const allBlank = await post(api, `/api/bookings/${booking.body.id}/arrive`, {
      ...BLANK_OPTIONALS, plate: '', customerName: '', brand: '', model: '', province: 'กรุงเทพมหานคร',
    }, t)
    expect(allBlank.status).toBe(409)
    expect(allBlank.body).toMatchObject({ error: 'vehicle_required' })

    // A plate, with brand and model blank: the details are asked for, not a 400.
    const brandBlank = await post(api, `/api/bookings/${booking.body.id}/arrive`, {
      plate: 'บบ 3456', brand: '', model: '', province: '',
    }, t)
    expect(brandBlank.status).toBe(409)
    expect(brandBlank.body).toMatchObject({ error: 'intake_details_required' })
  })
})
