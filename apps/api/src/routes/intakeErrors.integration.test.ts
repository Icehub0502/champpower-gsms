/**
 * The intake refusals, parsed against their contract schemas.
 *
 * The screen will read these bodies with `safeParse` from packages/contracts
 * (errors.ts) and treat anything that does not parse as an unknown error. So
 * the property that matters is not "the API sends a 409" — the other suites
 * cover that — but "the body the API actually sends parses under the schema the
 * screen uses". Each test below provokes one refusal for real and parses the
 * HTTP body.
 *
 * The first block is TIER 1 (no database): the schemas refuse a field they do
 * not list — the guarantee that a phone or address cannot ride along on a
 * candidate or an owner even if the server were ever changed to send one.
 * The rest is TIER 2 and skipped when GSMS_TEST_DB is unset.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { withShop } from '@gsms/db/client.js'
import {
  BookingAlreadyArrivedError,
  BookingNotFoundError,
  BookingNotOpenError,
  CustomerAmbiguousError,
  IntakeDetailsRequiredError,
  IntakeRefusal,
  InvalidRequestError,
  JobNumberSeriesMissingError,
  QueueNoTakenError,
  UnknownBayError,
  UnknownFileError,
  VehicleOwnerMismatchError,
  VehicleRequiredError,
} from '@gsms/contracts/index.js'
import { detailsRequiredMessage } from './queue.js'
import { db } from '../lib/db.js'
import { hasDatabase, tier2 } from '../test/env.js'
import {
  createTwoShopFixture, get, issueTokensFor, post, startApi,
  type RunningApi, type TwoShopFixture,
} from '../test/fixtures.js'

const ID = '11111111-1111-4111-8111-111111111111'
const ID2 = '22222222-2222-4222-8222-222222222222'

describe('the refusal schemas refuse fields they do not list (tier 1)', () => {
  it('a candidate carrying a phone does not parse', () => {
    const withPhone = {
      error: 'customer_ambiguous',
      message: 'x',
      candidates: [{ id: ID, name: 'ก' }, { id: ID2, name: 'ข', phone: '0812345678' }],
    }
    expect(CustomerAmbiguousError.safeParse(withPhone).success).toBe(false)
  })

  it('an owner carrying a phone does not parse', () => {
    const withPhone = {
      error: 'vehicle_owner_mismatch',
      message: 'x',
      vehicleId: ID,
      currentOwner: { id: ID, name: 'ก', phone: '0812345678' },
      newOwner: { id: null, name: 'ข' },
    }
    expect(VehicleOwnerMismatchError.safeParse(withPhone).success).toBe(false)
  })

  it('an unknown missing-field name does not parse', () => {
    const body = { error: 'intake_details_required', message: 'x', fields: { address: ['required'] } }
    expect(IntakeDetailsRequiredError.safeParse(body).success).toBe(false)
  })

  it('a NEW owner carrying a phone does not parse either', () => {
    const body = {
      error: 'vehicle_owner_mismatch', message: 'x', vehicleId: ID,
      currentOwner: { id: ID, name: 'ก' },
      newOwner: { id: null, name: 'ข', phone: '0812345678' },
    }
    expect(VehicleOwnerMismatchError.safeParse(body).success).toBe(false)
  })

  it('an unknown TOP-LEVEL key does not parse', () => {
    const body = {
      error: 'customer_ambiguous', message: 'x',
      candidates: [{ id: ID, name: 'ก' }, { id: ID2, name: 'ข' }], debug: 'leak',
    }
    expect(CustomerAmbiguousError.safeParse(body).success).toBe(false)
    expect(UnknownBayError.safeParse({ error: 'unknown_bay', message: 'x', bayId: ID }).success).toBe(false)
  })

  it('an ambiguity needs at least two candidates — one is not a choice', () => {
    const one = { error: 'customer_ambiguous', message: 'x', candidates: [{ id: ID, name: 'ก' }] }
    expect(CustomerAmbiguousError.safeParse(one).success).toBe(false)
  })

  it('the union recognises every code, and nothing else', () => {
    for (const error of [
      'unknown_bay', 'unknown_file', 'booking_not_found', 'booking_already_arrived',
      'booking_not_open', 'job_number_series_missing', 'vehicle_required',
    ]) {
      expect(IntakeRefusal.safeParse({ error, message: 'x' }).success, error).toBe(true)
    }
    expect(IntakeRefusal.safeParse({
      error: 'invalid_request', message: 'x', fields: { plate: ['required'] },
    }).success).toBe(true)
    expect(IntakeRefusal.safeParse({ error: 'something_else', message: 'x' }).success).toBe(false)
  })
})

describe('the intake_details_required message is true to what is missing (tier 1)', () => {
  // The review found it always said "this car has never been here", even when
  // the car IS on file and only the customer's name is missing. That case cannot
  // be reached through the API today (check-in requires a name; a booking always
  // carries a contact name), so its wording is pinned here directly.
  it('calls the car new only when brand or model is missing', () => {
    expect(detailsRequiredMessage(['brand', 'model'])).toMatch(/^รถคันนี้ยังไม่เคยเข้าร้าน/)
    expect(detailsRequiredMessage(['model'])).toMatch(/^รถคันนี้ยังไม่เคยเข้าร้าน/)
  })

  it('asks only for the name when only the name is missing — no claim the car is new', () => {
    const msg = detailsRequiredMessage(['customerName'])
    expect(msg).not.toMatch(/ยังไม่เคยเข้าร้าน/)
    expect(msg).toContain('ชื่อลูกค้า')
  })
})

describe.skipIf(!hasDatabase)(tier2('intake refusals parse under their contract schemas'), () => {
  let api: RunningApi
  let fx: TwoShopFixture

  beforeAll(async () => {
    api = await startApi()
    fx = await createTwoShopFixture('wo003err')
  })
  afterAll(async () => {
    await fx?.cleanup()
    await api?.close()
  })

  const token = async () => (await issueTokensFor(fx.userId, fx.shopA, 'owner')).accessToken

  /** Assert the body parses, and show zod's reason if it does not. */
  function parses(schema: { safeParse: (v: unknown) => { success: boolean; error?: unknown } }, body: unknown) {
    const r = schema.safeParse(body)
    expect(r.success, `body did not parse: ${JSON.stringify(body)} — ${JSON.stringify(r.error)}`).toBe(true)
  }

  it('customer_ambiguous from check-in', async () => {
    const t = await token()
    const shared = '0877001100'
    await withShop(db, fx.shopA, (trx) => trx.insertInto('customers').values([
      { shop_id: fx.shopA, name: 'พ่อ', phone: shared },
      { shop_id: fx.shopA, name: 'ลูก', phone: shared },
    ]).execute())
    const res = await post(api, '/api/checkin', {
      plate: 'ณณ 1001', customerName: 'ใครสักคน', customerPhone: shared, brand: 'Toyota', model: 'Vios',
    }, t)
    expect(res.status).toBe(409)
    parses(CustomerAmbiguousError, res.body)
  })

  it('customer_ambiguous from the customer lookup (same schema)', async () => {
    const t = await token()
    const res = await get(api, '/api/checkin/customer-lookup?phone=0877001100', t)
    expect(res.status).toBe(409)
    parses(CustomerAmbiguousError, res.body)
  })

  it('vehicle_owner_mismatch', async () => {
    const t = await token()
    const first = await post(api, '/api/checkin', {
      plate: 'ณณ 2002', customerName: 'เจ้าของเดิม', customerPhone: '0877002201', brand: 'Isuzu', model: 'D-Max',
    }, t)
    expect(first.status).toBe(201)
    const res = await post(api, '/api/checkin', {
      plate: 'ณณ 2002', customerName: 'เจ้าของใหม่', customerPhone: '0877002202', brand: 'Isuzu', model: 'D-Max',
    }, t)
    expect(res.status).toBe(409)
    parses(VehicleOwnerMismatchError, res.body)
  })

  it('intake_details_required and vehicle_required, both from arrival', async () => {
    const t = await token()
    const booking = await post<{ id: string }>(api, '/api/bookings', {
      source: 'phone',
      slotStart: new Date(Date.now() + 3_600_000).toISOString(),
      slotEnd: new Date(Date.now() + 7_200_000).toISOString(),
      bayId: null,
      contactName: 'จองทางโทรศัพท์',
    }, t)
    expect(booking.status, JSON.stringify(booking.body)).toBe(201)

    // Nothing typed and no car on the booking: vehicle_required.
    const bare = await post(api, `/api/bookings/${booking.body.id}/arrive`, {}, t)
    expect(bare.status).toBe(409)
    parses(VehicleRequiredError, bare.body)

    // A plate nobody has seen, with no brand or model: intake_details_required.
    const thin = await post(api, `/api/bookings/${booking.body.id}/arrive`, { plate: 'ณณ 3003' }, t)
    expect(thin.status).toBe(409)
    parses(IntakeDetailsRequiredError, thin.body)
    expect(Object.keys((thin.body as { fields: object }).fields).sort()).toEqual(['brand', 'model'])
  })

  it('queue_no_taken carries the refused number as data', async () => {
    const t = await token()
    const jobDate = '2030-02-01'
    const a = await post(api, '/api/checkin', {
      plate: 'ณณ 4004', customerName: 'คิวหนึ่ง', brand: 'Toyota', model: 'Vios', jobDate, queueNo: 7,
    }, t)
    expect(a.status).toBe(201)
    const b = await post(api, '/api/checkin', {
      plate: 'ณณ 4005', customerName: 'คิวสอง', brand: 'Toyota', model: 'Vios', jobDate, queueNo: 7,
    }, t)
    expect(b.status).toBe(409)
    parses(QueueNoTakenError, b.body)
    expect((b.body as { queueNo: number }).queueNo).toBe(7)
  })

  async function booking(name: string): Promise<string> {
    const res = await post<{ id: string }>(api, '/api/bookings', {
      source: 'phone', bayId: null, contactName: name,
      slotStart: new Date(Date.now() + 3_600_000).toISOString(),
      slotEnd: new Date(Date.now() + 7_200_000).toISOString(),
    }, await token())
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    return res.body.id
  }

  it('intake_details_required from arrival says the car is new', async () => {
    const t = await token()
    const id = await booking('รถใหม่')
    const res = await post(api, `/api/bookings/${id}/arrive`, { plate: 'ณณ 5005' }, t)
    expect(res.status).toBe(409)
    parses(IntakeDetailsRequiredError, res.body)
    expect((res.body as { message: string }).message).toMatch(/^รถคันนี้ยังไม่เคยเข้าร้าน/)
  })

  it('unknown_bay and unknown_file', async () => {
    const t = await token()
    const base = { customerName: 'ทดสอบ', brand: 'Toyota', model: 'Vios' }
    const bay = await post(api, '/api/checkin', { ...base, plate: 'ณณ 6006', bayId: ID }, t)
    expect(bay.status).toBe(400)
    parses(UnknownBayError, bay.body)
    const file = await post(api, '/api/checkin', { ...base, plate: 'ณณ 6007', photoFileIds: [ID] }, t)
    expect(file.status).toBe(400)
    parses(UnknownFileError, file.body)
  })

  it('invalid_request carries the failing fields, from check-in and from arrival', async () => {
    const t = await token()
    const ci = await post(api, '/api/checkin', { plate: 'ณณ 7007', customerName: 'ขาดยี่ห้อ' }, t)
    expect(ci.status).toBe(400)
    parses(InvalidRequestError, ci.body)
    expect(Object.keys((ci.body as { fields: object }).fields))
      .toEqual(expect.arrayContaining(['brand', 'model']))

    const arr = await post(api, `/api/bookings/${ID}/arrive`, { mileageInKm: 'lots' }, t)
    expect(arr.status).toBe(400)
    parses(InvalidRequestError, arr.body)
    expect((arr.body as { fields: object }).fields).toHaveProperty('mileageInKm')
  })

  it('invalid_request from the two lookups carries message and fields (LOW 3)', async () => {
    const t = await token()
    // No plate at all.
    const vehicle = await get(api, '/api/checkin/vehicle-lookup', t)
    expect(vehicle.status).toBe(400)
    parses(InvalidRequestError, vehicle.body)
    expect((vehicle.body as { fields: object }).fields).toHaveProperty('plate')

    // A phone that is not one — and it must not be echoed back.
    const junk = '12ab-LOOKUP-CANARY'
    const customer = await get(api, `/api/checkin/customer-lookup?phone=${encodeURIComponent(junk)}`, t)
    expect(customer.status).toBe(400)
    parses(InvalidRequestError, customer.body)
    expect(JSON.stringify(customer.body)).not.toContain(junk)
    expect((customer.body as { fields: { phone: string[] } }).fields.phone).toEqual(['invalid_phone'])
  })

  it('booking_not_found, booking_already_arrived, booking_not_open', async () => {
    const t = await token()
    const car = { brand: 'Toyota', model: 'Vios' }

    const missing = await post(api, `/api/bookings/${ID}/arrive`, { plate: 'ณณ 8008', ...car }, t)
    expect(missing.status).toBe(404)
    parses(BookingNotFoundError, missing.body)

    const arrived = await booking('มาแล้ว')
    const first = await post(api, `/api/bookings/${arrived}/arrive`, { plate: 'ณณ 8009', ...car }, t)
    expect(first.status, JSON.stringify(first.body)).toBe(201)
    const again = await post(api, `/api/bookings/${arrived}/arrive`, { plate: 'ณณ 8009', ...car }, t)
    expect(again.status).toBe(409)
    parses(BookingAlreadyArrivedError, again.body)

    const cancelled = await booking('ยกเลิกแล้ว')
    const cancel = await fetch(`${api.url}/api/bookings/${cancelled}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` },
      body: JSON.stringify({ status: 'cancelled' }),
    })
    expect(cancel.status).toBe(200)
    const late = await post(api, `/api/bookings/${cancelled}/arrive`, { plate: 'ณณ 8010', ...car }, t)
    expect(late.status).toBe(409)
    parses(BookingNotOpenError, late.body)
  })

  it('job_number_series_missing — a shop set up without its JOB series', async () => {
    // Shop B's JOB series is removed for this test (the fixture seeds it, and
    // its cleanup deletes whatever series remain). A 500, but still a body the
    // screen can parse and explain.
    await withShop(db, fx.shopB, (trx) => trx.deleteFrom('document_series')
      .where('shop_id', '=', fx.shopB).where('series', '=', 'JOB').execute())
    const { accessToken } = await issueTokensFor(fx.userId, fx.shopB, 'owner')
    const res = await post(api, '/api/checkin', {
      plate: 'ณณ 9009', customerName: 'ไม่มีเลขงาน', brand: 'Toyota', model: 'Vios',
    }, accessToken)
    expect(res.status).toBe(500)
    parses(JobNumberSeriesMissingError, res.body)
  })
})
