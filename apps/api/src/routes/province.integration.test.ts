/**
 * Province matching — a car is (plate, province), not plate alone.
 *
 * TIER 2. Skipped when GSMS_TEST_DB is unset; see src/test/env.ts.
 *
 * Owner decision, 29 Sep 2026: the same plate in two provinces is two cars. So
 *   - province is one of the 77 official names, or a 400;
 *   - a NEW car cannot be created without one (409 intake_details_required);
 *   - a plate on file in several provinces is never guessed (409 vehicle_ambiguous);
 *   - a province on file is never rewritten; an EMPTY one is filled, with an
 *     audit row `vehicle_province_filled`, and only when a job actually opens;
 *   - and all of it per shop: another branch's car with the same plate and
 *     province is invisible, never a match, never a candidate.
 *
 * The branch-by-branch rule is pinned in repositories/vehicles.test.ts (tier 1).
 * Here, the same rule end to end through both doors and the lookup.
 *
 * Cars with an empty province can no longer be CREATED through the API, so the
 * "legacy" rows below are inserted directly — they stand for what the WO-004
 * import brings in when the prototype had no province.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { withShop } from '@gsms/db/client.js'
import {
  CustomerAmbiguousError, IntakeDetailsRequiredError, InvalidRequestError, UnknownVehicleError,
  VehicleAmbiguousError, VehicleOwnerMismatchError, VehiclePlateMismatchError,
} from '@gsms/contracts/index.js'
import { BETONG, THAI_PROVINCES } from '@champpower/domain'
import { db } from '../lib/db.js'
import { hasDatabase, tier2 } from '../test/env.js'
import { openJob } from '../services/intake.js'
import * as vehiclesRepo from '../repositories/vehicles.js'
import {
  createTwoShopFixture, get, issueTokensFor, post, startApi,
  type RunningApi, type TwoShopFixture,
} from '../test/fixtures.js'

interface CheckInBody { jobId: string; customerId: string; vehicleId: string }
interface LookupBody { vehicleId: string; province: string | null }

describe.skipIf(!hasDatabase)(tier2('province matching'), () => {
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

  const tokenA = async () => (await issueTokensFor(fx.userId, fx.shopA, 'owner')).accessToken
  const tokenB = async () => (await issueTokensFor(fx.userId, fx.shopB, 'owner')).accessToken

  const storedProvince = (vehicleId: string) =>
    withShop(db, fx.shopA, async (trx) =>
      (await trx.selectFrom('vehicles').select(['province']).where('id', '=', vehicleId)
        .executeTakeFirstOrThrow()).province)

  const vehiclesWithPlateKey = (shopId: string, key: string) =>
    withShop(db, shopId, (trx) =>
      trx.selectFrom('vehicles').select(['id', 'province']).where('plate_key', '=', key).execute())

  const provinceFills = (shopId: string, vehicleId: string) =>
    withShop(db, shopId, (trx) =>
      trx.selectFrom('audit_logs').select(['before', 'after', 'actor_id'])
        .where('action', '=', 'vehicle_province_filled')
        .where('entity_id', '=', vehicleId)
        .execute())

  /**
   * A car as the WO-004 import leaves it: on file, no province — or, with
   * `province`, a car already on file somewhere else. Inserted directly because
   * the API would (rightly) fill a lone empty-province car instead of creating
   * a second one beside it.
   */
  async function legacyCar(
    shopId: string, plate: string, phone: string, province: string | null = null,
  ): Promise<string> {
    return withShop(db, shopId, async (trx) => {
      const c = await trx.insertInto('customers')
        .values({ shop_id: shopId, name: 'ลูกค้าเก่า', phone })
        .returning(['id']).executeTakeFirstOrThrow()
      const v = await trx.insertInto('vehicles')
        .values({ shop_id: shopId, customer_id: c.id, plate, brand: 'Honda', model: 'Jazz', province })
        .returning(['id']).executeTakeFirstOrThrow()
      return v.id
    })
  }

  const walkIn = (plate: string, phone: string, extra: Record<string, unknown> = {}) => ({
    plate, customerName: 'ลูกค้า', customerPhone: phone, brand: 'Toyota', model: 'Vios', ...extra,
  })

  // ---------------------------------------------------------------------------
  // The vocabulary
  // ---------------------------------------------------------------------------

  it('a province outside the 77 is a 400 naming the field — and does not echo it', async () => {
    const res = await post(api, '/api/checkin',
      walkIn('ฒฒ 1001', '0811240001', { province: 'กทม' }), await tokenA())
    expect(res.status).toBe(400)
    const body = InvalidRequestError.parse(res.body)
    expect(body.fields?.province).toEqual(['invalid_value'])
    expect(JSON.stringify(res.body)).not.toContain('กทม')
  })

  it('a new car without a province is refused, naming province — nothing is created', async () => {
    const t = await tokenA()
    const res = await post(api, '/api/checkin', walkIn('ฒฒ 1002', '0811240002'), t)
    expect(res.status, JSON.stringify(res.body)).toBe(409)
    const body = IntakeDetailsRequiredError.parse(res.body)
    expect(Object.keys(body.fields)).toEqual(['province'])
    expect(body.message).toContain('จังหวัด')
    expect(await vehiclesWithPlateKey(fx.shopA, 'ฒฒ1002')).toEqual([])
  })

  it('a new car with a province stores it, and the lookup finds it by plate and province', async () => {
    const t = await tokenA()
    const res = await post<CheckInBody>(api, '/api/checkin',
      walkIn('ฒฒ 1003', '0811240003', { province: 'นนทบุรี' }), t)
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    expect(await storedProvince(res.body.vehicleId)).toBe('นนทบุรี')

    for (const q of ['', `&province=${encodeURIComponent('นนทบุรี')}`]) {
      const lookup = await get<LookupBody>(api,
        `/api/checkin/vehicle-lookup?plate=${encodeURIComponent('ฒฒ1003')}${q}`, t)
      expect(lookup.status).toBe(200)
      expect(lookup.body.vehicleId).toBe(res.body.vehicleId)
    }
    // Same plate, another province: not this car.
    const other = await get(api,
      `/api/checkin/vehicle-lookup?plate=${encodeURIComponent('ฒฒ1003')}&province=${encodeURIComponent('ชลบุรี')}`, t)
    expect(other.status).toBe(404)
  })

  // ---------------------------------------------------------------------------
  // Same plate, two provinces
  // ---------------------------------------------------------------------------

  it('the same plate in another province is a DIFFERENT car, and neither is rewritten', async () => {
    const t = await tokenA()
    const bkk = await post<CheckInBody>(api, '/api/checkin',
      walkIn('ฒฒ 2001', '0811240011', { province: 'กรุงเทพมหานคร' }), t)
    expect(bkk.status, JSON.stringify(bkk.body)).toBe(201)
    const cbi = await post<CheckInBody>(api, '/api/checkin',
      walkIn('ฒฒ 2001', '0811240012', { province: 'ชลบุรี' }), t)
    expect(cbi.status, JSON.stringify(cbi.body)).toBe(201)

    expect(cbi.body.vehicleId).not.toBe(bkk.body.vehicleId)
    expect(cbi.body.customerId).not.toBe(bkk.body.customerId)
    expect(await storedProvince(bkk.body.vehicleId)).toBe('กรุงเทพมหานคร')

    // Coming back with the province: exact, no question asked.
    const again = await post<CheckInBody>(api, '/api/checkin',
      walkIn('ฒฒ 2001', '0811240011', { province: 'กรุงเทพมหานคร' }), t)
    expect(again.status, JSON.stringify(again.body)).toBe(201)
    expect(again.body.vehicleId).toBe(bkk.body.vehicleId)
  })

  it('without a province, a plate on file in two provinces is 409 vehicle_ambiguous — at both the lookup and the check-in', async () => {
    const t = await tokenA()
    // ฒฒ 2001 is on file in กรุงเทพมหานคร and ชลบุรี (previous test).
    const lookup = await get(api, `/api/checkin/vehicle-lookup?plate=${encodeURIComponent('ฒฒ 2001')}`, t)
    expect(lookup.status).toBe(409)
    const lb = VehicleAmbiguousError.parse(lookup.body)
    expect(lb.candidates.map((c) => c.province).sort()).toEqual(['กรุงเทพมหานคร', 'ชลบุรี'])

    const before = await vehiclesWithPlateKey(fx.shopA, 'ฒฒ2001')
    const res = await post(api, '/api/checkin', walkIn('ฒฒ 2001', '0811240013'), t)
    expect(res.status, JSON.stringify(res.body)).toBe(409)
    const body = VehicleAmbiguousError.parse(res.body)
    expect(body.candidates).toHaveLength(2)
    // Vehicle facts only — the strict schema already refuses anything else,
    // and neither owner's name or phone is in the body.
    expect(JSON.stringify(res.body)).not.toContain('0811240011')
    expect(await vehiclesWithPlateKey(fx.shopA, 'ฒฒ2001')).toHaveLength(before.length)
  })

  it('answering vehicle_ambiguous with vehicleId opens the job on the car picked', async () => {
    const t = await tokenA()
    const refused = await post(api, '/api/checkin', walkIn('ฒฒ 2001', '0811240012'), t)
    const pick = VehicleAmbiguousError.parse(refused.body).candidates.find((c) => c.province === 'ชลบุรี')!
    const res = await post<CheckInBody>(api, '/api/checkin',
      walkIn('ฒฒ 2001', '0811240012', { vehicleId: pick.id }), t)
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    expect(res.body.vehicleId).toBe(pick.id)
  })

  // ---------------------------------------------------------------------------
  // A car on file with NO province
  // ---------------------------------------------------------------------------

  it('the only car with this plate, on file without a province, is matched and filled — with an audit row', async () => {
    const t = await tokenA()
    const legacy = await legacyCar(fx.shopA, 'ฒฒ 3001', '0811240021')

    const res = await post<CheckInBody>(api, '/api/checkin',
      walkIn('ฒฒ 3001', '0811240021', { province: 'ระยอง' }), t)
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    expect(res.body.vehicleId).toBe(legacy)
    expect(await storedProvince(legacy)).toBe('ระยอง')

    const fills = await provinceFills(fx.shopA, legacy)
    expect(fills).toHaveLength(1)
    expect(fills[0]!.before).toEqual({ province: null })
    expect(fills[0]!.after).toEqual({ province: 'ระยอง' })
    expect(fills[0]!.actor_id).toBe(fx.userId)

    // Filled once; a later visit with a different province does not rewrite
    // it — that is a different car now.
    const other = await post<CheckInBody>(api, '/api/checkin',
      walkIn('ฒฒ 3001', '0811240022', { province: 'ตราด' }), t)
    expect(other.status, JSON.stringify(other.body)).toBe(201)
    expect(other.body.vehicleId).not.toBe(legacy)
    expect(await storedProvince(legacy)).toBe('ระยอง')
    expect(await provinceFills(fx.shopA, legacy)).toHaveLength(1)
  })

  it('the lookup never fills: looking at a car is not opening a job on it', async () => {
    const t = await tokenA()
    const legacy = await legacyCar(fx.shopA, 'ฒฒ 3002', '0811240023')
    const lookup = await get<LookupBody>(api,
      `/api/checkin/vehicle-lookup?plate=${encodeURIComponent('ฒฒ3002')}&province=${encodeURIComponent('ระยอง')}`, t)
    expect(lookup.status).toBe(200)
    expect(lookup.body.vehicleId).toBe(legacy)
    expect(lookup.body.province).toBeNull()
    expect(await storedProvince(legacy)).toBeNull()
    expect(await provinceFills(fx.shopA, legacy)).toHaveLength(0)
  })

  it('a refusal fills nothing: an owner mismatch on the no-province car leaves it empty', async () => {
    const t = await tokenA()
    const legacy = await legacyCar(fx.shopA, 'ฒฒ 3003', '0811240024')
    const res = await post(api, '/api/checkin',
      walkIn('ฒฒ 3003', '0811240099', { province: 'ระยอง' }), t)
    expect(res.status, JSON.stringify(res.body)).toBe(409)
    expect((res.body as { error: string }).error).toBe('vehicle_owner_mismatch')
    expect(await storedProvince(legacy)).toBeNull()
    expect(await provinceFills(fx.shopA, legacy)).toHaveLength(0)
  })

  it('a no-province car beside one in another province is ambiguous — not filled, answerable either way', async () => {
    const t = await tokenA()
    const legacy = await legacyCar(fx.shopA, 'ฒฒ 3004', '0811240025')
    const bkk = await legacyCar(fx.shopA, 'ฒฒ 3004', '0811240026', 'กรุงเทพมหานคร')

    const refused = await post(api, '/api/checkin',
      walkIn('ฒฒ 3004', '0811240025', { province: 'ระยอง' }), t)
    expect(refused.status, JSON.stringify(refused.body)).toBe(409)
    const body = VehicleAmbiguousError.parse(refused.body)
    expect(body.candidates.map((c) => c.id)).toEqual([legacy])
    expect(await storedProvince(legacy)).toBeNull()

    // "None of those": a new car in ระยอง.
    const fresh = await post<CheckInBody>(api, '/api/checkin',
      walkIn('ฒฒ 3004', '0811240027', { province: 'ระยอง', confirmNewVehicle: true }), t)
    expect(fresh.status, JSON.stringify(fresh.body)).toBe(201)
    expect(fresh.body.vehicleId).not.toBe(legacy)
    expect(fresh.body.vehicleId).not.toBe(bkk)
    expect(await storedProvince(legacy)).toBeNull()
  })

  it('picking the no-province car by id fills its province too', async () => {
    const t = await tokenA()
    const legacy = await legacyCar(fx.shopA, 'ฒฒ 3005', '0811240028')
    await legacyCar(fx.shopA, 'ฒฒ 3005', '0811240029', 'กรุงเทพมหานคร')

    const res = await post<CheckInBody>(api, '/api/checkin',
      walkIn('ฒฒ 3005', '0811240028', { province: 'ระยอง', vehicleId: legacy }), t)
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    expect(res.body.vehicleId).toBe(legacy)
    expect(await storedProvince(legacy)).toBe('ระยอง')
    expect(await provinceFills(fx.shopA, legacy)).toHaveLength(1)
  })

  // ---------------------------------------------------------------------------
  // Arrival goes through the same resolver
  // ---------------------------------------------------------------------------

  async function booking(t: string, contactName: string): Promise<string> {
    const b = await post<{ id: string }>(api, '/api/bookings', {
      source: 'phone', bayId: null, contactName,
      slotStart: new Date(Date.now() + 3_600_000).toISOString(),
      slotEnd: new Date(Date.now() + 7_200_000).toISOString(),
    }, t)
    expect(b.status, JSON.stringify(b.body)).toBe(201)
    return b.body.id
  }

  it('an arrival creating a new car needs a province, and stores it; the refusal leaves the booking open', async () => {
    const t = await tokenA()
    const id = await booking(t, 'จองแล้วมา')
    const refused = await post(api, `/api/bookings/${id}/arrive`,
      { plate: 'ฒฒ 4001', brand: 'Nissan', model: 'Navara' }, t)
    expect(refused.status, JSON.stringify(refused.body)).toBe(409)
    expect(Object.keys(IntakeDetailsRequiredError.parse(refused.body).fields)).toEqual(['province'])

    const arrived = await post<CheckInBody>(api, `/api/bookings/${id}/arrive`,
      { plate: 'ฒฒ 4001', brand: 'Nissan', model: 'Navara', province: 'สมุทรปราการ' }, t)
    expect(arrived.status, JSON.stringify(arrived.body)).toBe(201)
    expect(await storedProvince(arrived.body.vehicleId)).toBe('สมุทรปราการ')
  })

  it('an arrival with an ambiguous plate is refused and rolled back; answering with vehicleId opens it', async () => {
    const t = await tokenA()
    // ฒฒ 2001 is on file in two provinces.
    const id = await booking(t, 'จองสองจังหวัด')
    const refused = await post(api, `/api/bookings/${id}/arrive`, { plate: 'ฒฒ 2001' }, t)
    expect(refused.status, JSON.stringify(refused.body)).toBe(409)
    const pick = VehicleAmbiguousError.parse(refused.body).candidates[0]!

    const arrived = await post<CheckInBody>(api, `/api/bookings/${id}/arrive`,
      { plate: 'ฒฒ 2001', vehicleId: pick.id }, t)
    // The booking was still open after the refusal, or this would be booking_not_open.
    expect(arrived.status, JSON.stringify(arrived.body)).toBe(201)
    expect(arrived.body.vehicleId).toBe(pick.id)
  })

  // ---------------------------------------------------------------------------
  // Two shops
  // ---------------------------------------------------------------------------

  it("another branch's car with the same plate and province is never matched, never a candidate", async () => {
    const tA = await tokenA()
    const tB = await tokenB()
    const inB = await post<CheckInBody>(api, '/api/checkin',
      walkIn('ฒฒ 5001', '0811240041', { province: 'ชลบุรี' }), tB)
    expect(inB.status, JSON.stringify(inB.body)).toBe(201)

    // Shop A: no such car — the lookup does not see B's.
    const look = await get(api,
      `/api/checkin/vehicle-lookup?plate=${encodeURIComponent('ฒฒ5001')}&province=${encodeURIComponent('ชลบุรี')}`, tA)
    expect(look.status).toBe(404)

    // Checking the same (plate, province) into A creates A's own car.
    const inA = await post<CheckInBody>(api, '/api/checkin',
      walkIn('ฒฒ 5001', '0811240041', { province: 'ชลบุรี' }), tA)
    expect(inA.status, JSON.stringify(inA.body)).toBe(201)
    expect(inA.body.vehicleId).not.toBe(inB.body.vehicleId)

    // And A's plate in a second province, beside B's, is ambiguous only
    // with A's own cars: B's never appears as a candidate.
    await post(api, '/api/checkin', walkIn('ฒฒ 5001', '0811240042', { province: 'ตราด' }), tA)
    const amb = await post(api, '/api/checkin', walkIn('ฒฒ 5001', '0811240043'), tA)
    expect(amb.status, JSON.stringify(amb.body)).toBe(409)
    const ids = VehicleAmbiguousError.parse(amb.body).candidates.map((c) => c.id)
    expect(ids).not.toContain(inB.body.vehicleId)
    expect(ids).toHaveLength(2)
  })

  it("filling an empty province in one branch writes nothing in the other", async () => {
    const tA = await tokenA()
    const legacyA = await legacyCar(fx.shopA, 'ฒฒ 5003', '0811240046')
    const legacyB = await legacyCar(fx.shopB, 'ฒฒ 5003', '0811240046')

    const res = await post<CheckInBody>(api, '/api/checkin',
      walkIn('ฒฒ 5003', '0811240046', { province: 'ระยอง' }), tA)
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    expect(res.body.vehicleId).toBe(legacyA)

    const b = await withShop(db, fx.shopB, (trx) => trx.selectFrom('vehicles')
      .select(['province']).where('id', '=', legacyB).executeTakeFirstOrThrow())
    expect(b.province).toBeNull()
    expect(await provinceFills(fx.shopB, legacyB)).toHaveLength(0)
    expect(await provinceFills(fx.shopA, legacyA)).toHaveLength(1)
  })

  // ---------------------------------------------------------------------------
  // เบตง — its own plate area (owner decision, 30 Sep 2026)
  // ---------------------------------------------------------------------------

  it('เบตง is accepted, and กก 1234 เบตง and กก 1234 ยะลา are two cars', async () => {
    const t = await tokenA()
    const betong = await post<CheckInBody>(api, '/api/checkin',
      walkIn('ฒฒ 6001', '0811240051', { province: BETONG }), t)
    expect(betong.status, JSON.stringify(betong.body)).toBe(201)
    expect(await storedProvince(betong.body.vehicleId)).toBe('เบตง')

    const yala = await post<CheckInBody>(api, '/api/checkin',
      walkIn('ฒฒ 6001', '0811240052', { province: 'ยะลา' }), t)
    expect(yala.status, JSON.stringify(yala.body)).toBe(201)
    expect(yala.body.vehicleId).not.toBe(betong.body.vehicleId)
    expect(await storedProvince(yala.body.vehicleId)).toBe('ยะลา')
    expect(await storedProvince(betong.body.vehicleId)).toBe('เบตง')

    // Each is found by its own area.
    for (const [area, id] of [[BETONG, betong.body.vehicleId], ['ยะลา', yala.body.vehicleId]] as const) {
      const look = await get<LookupBody>(api,
        `/api/checkin/vehicle-lookup?plate=${encodeURIComponent('ฒฒ6001')}&province=${encodeURIComponent(area)}`, t)
      expect(look.status).toBe(200)
      expect(look.body.vehicleId).toBe(id)
    }
  })

  it('a spelling of Betong that is not the stored value is refused, not echoed — the picker decides', async () => {
    const res = await post(api, '/api/checkin',
      walkIn('ฒฒ 6002', '0811240053', { province: 'ป้ายเบตง' }), await tokenA())
    expect(res.status).toBe(400)
    expect(InvalidRequestError.parse(res.body).fields?.province).toEqual(['invalid_value'])
    expect(JSON.stringify(res.body)).not.toContain('ป้ายเบตง')
  })

  // ---------------------------------------------------------------------------
  // A picked vehicleId (review MEDIUM + security Lows, 30 Sep 2026)
  // ---------------------------------------------------------------------------

  it('a picked vehicleId whose plate is not the plate typed is 409 vehicle_plate_mismatch, and fills nothing', async () => {
    const t = await tokenA()
    const legacy = await legacyCar(fx.shopA, 'ฒฒ 7001', '0811240061')
    const res = await post(api, '/api/checkin',
      walkIn('ฒฒ 7999', '0811240061', { province: 'ระยอง', vehicleId: legacy }), t)
    expect(res.status, JSON.stringify(res.body)).toBe(409)
    VehiclePlateMismatchError.parse(res.body)
    expect(await storedProvince(legacy)).toBeNull()
    expect(await provinceFills(fx.shopA, legacy)).toHaveLength(0)
    // Nothing created under the typed plate either.
    expect(await vehiclesWithPlateKey(fx.shopA, 'ฒฒ7999')).toEqual([])
  })

  it('a picked vehicleId that does not exist and one from another branch get the SAME answer', async () => {
    const tA = await tokenA()
    const tB = await tokenB()
    const inB = await post<CheckInBody>(api, '/api/checkin',
      walkIn('ฒฒ 7002', '0811240062', { province: 'ชลบุรี' }), tB)
    expect(inB.status, JSON.stringify(inB.body)).toBe(201)

    const body = { province: 'ชลบุรี' }
    const foreign = await post(api, '/api/checkin',
      walkIn('ฒฒ 7002', '0811240063', { ...body, vehicleId: inB.body.vehicleId }), tA)
    const missing = await post(api, '/api/checkin',
      walkIn('ฒฒ 7002', '0811240063', { ...body, vehicleId: '00000000-0000-4000-8000-00000000abcd' }), tA)
    expect(foreign.status).toBe(400)
    expect(missing.status).toBe(400)
    UnknownVehicleError.parse(foreign.body)
    expect(foreign.body).toEqual(missing.body)
    // No fallback to the plate: nothing was created in A.
    expect(await vehiclesWithPlateKey(fx.shopA, 'ฒฒ7002')).toEqual([])
  })

  it('arrival: a foreign vehicleId is unknown_vehicle, and the booking stays open', async () => {
    const tA = await tokenA()
    const tB = await tokenB()
    const inB = await post<CheckInBody>(api, '/api/checkin',
      walkIn('ฒฒ 7003', '0811240064', { province: 'ชลบุรี' }), tB)
    expect(inB.status, JSON.stringify(inB.body)).toBe(201)

    const id = await booking(tA, 'รับรถข้ามสาขา')
    const res = await post(api, `/api/bookings/${id}/arrive`,
      { plate: 'ฒฒ 7003', vehicleId: inB.body.vehicleId }, tA)
    expect(res.status, JSON.stringify(res.body)).toBe(400)
    UnknownVehicleError.parse(res.body)
    const status = await withShop(db, fx.shopA, async (trx) =>
      (await trx.selectFrom('bookings').select(['status']).where('id', '=', id).executeTakeFirstOrThrow()).status)
    expect(status).toBe('booked')
  })

  it('arrival: a picked car owned by someone else than the booking names fires vehicle_owner_mismatch, then succeeds with confirmOwnerChange', async () => {
    const t = await tokenA()
    // The booking is for a known customer (evidence); the picked car is someone else's.
    const bookedFor = await post<CheckInBody>(api, '/api/checkin',
      walkIn('ฒฒ 7004', '0811240065', { province: 'ระยอง' }), t)
    expect(bookedFor.status, JSON.stringify(bookedFor.body)).toBe(201)
    const other = await legacyCar(fx.shopA, 'ฒฒ 7005', '0811240066', 'ตราด')

    const b = await post<{ id: string }>(api, '/api/bookings', {
      source: 'phone', bayId: null, customerId: bookedFor.body.customerId,
      slotStart: new Date(Date.now() + 3_600_000).toISOString(),
      slotEnd: new Date(Date.now() + 7_200_000).toISOString(),
    }, t)
    expect(b.status, JSON.stringify(b.body)).toBe(201)

    const refused = await post(api, `/api/bookings/${b.body.id}/arrive`,
      { plate: 'ฒฒ 7005', vehicleId: other }, t)
    expect(refused.status, JSON.stringify(refused.body)).toBe(409)
    const mm = VehicleOwnerMismatchError.parse(refused.body)
    expect(mm.vehicleId).toBe(other)
    expect(mm.newOwner.id).toBe(bookedFor.body.customerId)

    const ok = await post<CheckInBody>(api, `/api/bookings/${b.body.id}/arrive`,
      { plate: 'ฒฒ 7005', vehicleId: other, confirmOwnerChange: true }, t)
    expect(ok.status, JSON.stringify(ok.body)).toBe(201)
    expect(ok.body.vehicleId).toBe(other)
    expect(ok.body.customerId).toBe(bookedFor.body.customerId)
  })

  it('arrival with NO owner evidence: a picked car that is not the booked car needs confirmOwnerChange', async () => {
    const t = await tokenA()
    // Booking names car X by id, with only a contact NAME — no customer, no phone.
    const x = await legacyCar(fx.shopA, 'ฒฒ 7006', '0811240067', 'ระยอง')
    const y = await legacyCar(fx.shopA, 'ฒฒ 7007', '0811240068', 'ระยอง')
    const b = await post<{ id: string }>(api, '/api/bookings', {
      source: 'phone', bayId: null, vehicleId: x, contactName: 'ไม่มีเบอร์',
      slotStart: new Date(Date.now() + 3_600_000).toISOString(),
      slotEnd: new Date(Date.now() + 7_200_000).toISOString(),
    }, t)
    expect(b.status, JSON.stringify(b.body)).toBe(201)

    const refused = await post(api, `/api/bookings/${b.body.id}/arrive`, { plate: 'ฒฒ 7007', vehicleId: y }, t)
    expect(refused.status, JSON.stringify(refused.body)).toBe(409)
    VehicleOwnerMismatchError.parse(refused.body)
    const ownerOfY = async () => withShop(db, fx.shopA, async (trx) =>
      (await trx.selectFrom('vehicles').select(['customer_id']).where('id', '=', y).executeTakeFirstOrThrow()).customer_id)
    const before = await ownerOfY()

    const ok = await post<CheckInBody>(api, `/api/bookings/${b.body.id}/arrive`,
      { plate: 'ฒฒ 7007', vehicleId: y, confirmOwnerChange: true }, t)
    expect(ok.status, JSON.stringify(ok.body)).toBe(201)
    expect(ok.body.vehicleId).toBe(y)
    expect(await ownerOfY()).not.toBe(before)
  })

  it('GET /vehicle-lookup 409 never lists another branch\'s cars', async () => {
    const tA = await tokenA()
    const tB = await tokenB()
    const inB = await post<CheckInBody>(api, '/api/checkin',
      walkIn('ฒฒ 7008', '0811240069', { province: 'ตาก' }), tB)
    expect(inB.status, JSON.stringify(inB.body)).toBe(201)
    await legacyCar(fx.shopA, 'ฒฒ 7008', '0811240070', 'ระยอง')
    await legacyCar(fx.shopA, 'ฒฒ 7008', '0811240071', 'ตราด')

    const look = await get(api, `/api/checkin/vehicle-lookup?plate=${encodeURIComponent('ฒฒ7008')}`, tA)
    expect(look.status).toBe(409)
    const c = VehicleAmbiguousError.parse(look.body).candidates
    expect(c.map((x) => x.id)).not.toContain(inB.body.vehicleId)
    expect(c.map((x) => x.province).sort()).toEqual(['ตราด', 'ระยอง'])
  })

  // ---------------------------------------------------------------------------
  // Review LOWs, 30 Sep 2026
  // ---------------------------------------------------------------------------

  it('an exact province match is never hidden by the row bound: 20 newer cars elsewhere, the exact one older', async () => {
    const t = await tokenA()
    const exact = await legacyCar(fx.shopA, 'ฒฒ 8001', '0811240080', 'ระยอง')
    const others = THAI_PROVINCES.filter((p) => p !== 'ระยอง').slice(0, 20)
    for (const [i, p] of others.entries()) {
      await legacyCar(fx.shopA, 'ฒฒ 8001', `08112401${String(i).padStart(2, '0')}`, p)
    }
    const look = await get<LookupBody>(api,
      `/api/checkin/vehicle-lookup?plate=${encodeURIComponent('ฒฒ8001')}&province=${encodeURIComponent('ระยอง')}`, t)
    expect(look.status, JSON.stringify(look.body)).toBe(200)
    expect(look.body.vehicleId).toBe(exact)
  })

  it('two cars with no province and a province given: 409, nothing filled', async () => {
    const t = await tokenA()
    const a = await legacyCar(fx.shopA, 'ฒฒ 8002', '0811240081')
    const b = await legacyCar(fx.shopA, 'ฒฒ 8002', '0811240082')
    const res = await post(api, '/api/checkin', walkIn('ฒฒ 8002', '0811240081', { province: 'ระยอง' }), t)
    expect(res.status, JSON.stringify(res.body)).toBe(409)
    expect(VehicleAmbiguousError.parse(res.body).candidates.map((c) => c.id).sort()).toEqual([a, b].sort())
    expect(await storedProvince(a)).toBeNull()
    expect(await storedProvince(b)).toBeNull()
  })

  it('customer_ambiguous beside a fillable car: refused, and the province is NOT filled', async () => {
    const t = await tokenA()
    const legacy = await legacyCar(fx.shopA, 'ฒฒ 8003', '0811240083')
    // Two more customers sharing one number: the phone cannot name anyone.
    await withShop(db, fx.shopA, (trx) => trx.insertInto('customers').values([
      { shop_id: fx.shopA, name: 'คนที่หนึ่ง', phone: '0811240084' },
      { shop_id: fx.shopA, name: 'คนที่สอง', phone: '0811240084' },
    ]).execute())
    const res = await post(api, '/api/checkin', walkIn('ฒฒ 8003', '0811240084', { province: 'ระยอง' }), t)
    expect(res.status, JSON.stringify(res.body)).toBe(409)
    CustomerAmbiguousError.parse(res.body)
    expect(await storedProvince(legacy)).toBeNull()
    expect(await provinceFills(fx.shopA, legacy)).toHaveLength(0)
  })

  it('a province fill together with a confirmed owner change: both happen, both audited', async () => {
    const t = await tokenA()
    const legacy = await legacyCar(fx.shopA, 'ฒฒ 8004', '0811240085')
    const newPhone = '0811240086'
    const refused = await post(api, '/api/checkin', walkIn('ฒฒ 8004', newPhone, { province: 'ระยอง' }), t)
    expect(refused.status, JSON.stringify(refused.body)).toBe(409)
    expect(await storedProvince(legacy)).toBeNull()

    const ok = await post<CheckInBody>(api, '/api/checkin',
      walkIn('ฒฒ 8004', newPhone, { province: 'ระยอง', confirmOwnerChange: true }), t)
    expect(ok.status, JSON.stringify(ok.body)).toBe(201)
    expect(ok.body.vehicleId).toBe(legacy)
    expect(await storedProvince(legacy)).toBe('ระยอง')
    expect(await provinceFills(fx.shopA, legacy)).toHaveLength(1)
    const moved = await withShop(db, fx.shopA, (trx) => trx.selectFrom('audit_logs').select(['action'])
      .where('action', '=', 'vehicle_owner_changed').where('entity_id', '=', legacy).execute())
    expect(moved).toHaveLength(1)
  })

  it('arrival where the booking already names a no-province car: filled when the plate typed is that car\'s, not otherwise', async () => {
    const t = await tokenA()
    const named = async (plate: string, phone: string) => {
      const car = await legacyCar(fx.shopA, plate, phone)
      const b = await post<{ id: string }>(api, '/api/bookings', {
        source: 'phone', bayId: null, vehicleId: car, contactName: 'จองรถเก่า',
        slotStart: new Date(Date.now() + 3_600_000).toISOString(),
        slotEnd: new Date(Date.now() + 7_200_000).toISOString(),
      }, t)
      expect(b.status, JSON.stringify(b.body)).toBe(201)
      return { car, bookingId: b.body.id }
    }

    const same = await named('ฒฒ 8005', '0811240087')
    const a1 = await post<CheckInBody>(api, `/api/bookings/${same.bookingId}/arrive`,
      { plate: 'ฒฒ-8005', province: 'ระยอง' }, t)
    expect(a1.status, JSON.stringify(a1.body)).toBe(201)
    expect(a1.body.vehicleId).toBe(same.car)
    expect(await storedProvince(same.car)).toBe('ระยอง')

    const noPlate = await named('ฒฒ 8006', '0811240088')
    const a2 = await post<CheckInBody>(api, `/api/bookings/${noPlate.bookingId}/arrive`, { province: 'ระยอง' }, t)
    expect(a2.status, JSON.stringify(a2.body)).toBe(201)
    expect(await storedProvince(noPlate.car)).toBe('ระยอง')

    const other = await named('ฒฒ 8007', '0811240089')
    const a3 = await post<CheckInBody>(api, `/api/bookings/${other.bookingId}/arrive`,
      { plate: 'ฒฒ 8999', province: 'ระยอง' }, t)
    expect(a3.status, JSON.stringify(a3.body)).toBe(201)
    // The booking's car is still the car (booking wins, as before) — but a
    // different plate typed says nothing about where IT is registered.
    expect(a3.body.vehicleId).toBe(other.car)
    expect(await storedProvince(other.car)).toBeNull()
  })

  it('two check-ins filling the same empty province at once: the car gets ONE province, the loser opens on a different car', async () => {
    const t = await tokenA()
    const legacy = await legacyCar(fx.shopA, 'ฒฒ 8008', '0811240090')
    const [r1, r2] = await Promise.all([
      post<CheckInBody>(api, '/api/checkin', walkIn('ฒฒ 8008', '0811240090', { province: 'ระยอง' }), t),
      post<CheckInBody>(api, '/api/checkin', walkIn('ฒฒ 8008', '0811240090', { province: 'ตราด' }), t),
    ])
    expect(r1.status, JSON.stringify(r1.body)).toBe(201)
    expect(r2.status, JSON.stringify(r2.body)).toBe(201)
    const onLegacy = [r1, r2].filter((r) => r.body.vehicleId === legacy)
    expect(onLegacy).toHaveLength(1)
    const winner = onLegacy[0] === r1 ? 'ระยอง' : 'ตราด'
    const loser = onLegacy[0] === r1 ? r2 : r1
    expect(await storedProvince(legacy)).toBe(winner)
    expect(await storedProvince(loser.body.vehicleId)).toBe(winner === 'ระยอง' ? 'ตราด' : 'ระยอง')
    expect(await provinceFills(fx.shopA, legacy)).toHaveLength(1)
  })

  it('losing the fill race re-resolves: the job opens on a NEW car, never on a car now in another province', async () => {
    // Deterministic version of the race above. Transaction 1 fills the empty
    // province and holds its row lock; transaction 2 opens a job meanwhile,
    // reads the car as empty, and its UPDATE waits. When 1 commits with ตราด,
    // 2's UPDATE matches 0 rows, 2 re-reads, sees ตราด ≠ ระยอง and starts over —
    // and by the owner's rule the ตราด car is not the ระยอง car.
    const legacy = await legacyCar(fx.shopA, 'ฒฒ 8009', '0811240091')
    let second: Promise<Awaited<ReturnType<typeof openJob>>> | undefined
    await withShop(db, fx.shopA, async (trx) => {
      expect(await vehiclesRepo.fillProvince(trx, fx.shopA, legacy, 'ตราด')).toBe(true)
      second = withShop(db, fx.shopA, (trx2) => openJob(trx2, {
        shopId: fx.shopA, actorId: fx.userId, source: 'walk_in',
        plate: 'ฒฒ 8009', customerName: 'ลูกค้า', customerPhone: '0811240091',
        brand: 'Toyota', model: 'Vios', province: 'ระยอง',
      }))
      // Long enough for the second transaction to reach its UPDATE and block.
      await new Promise((r) => setTimeout(r, 400))
    })
    const out = await second!
    expect(out.kind).toBe('ok')
    if (out.kind !== 'ok') return
    expect(out.vehicleId).not.toBe(legacy)
    expect(await storedProvince(legacy)).toBe('ตราด')
    expect(await storedProvince(out.vehicleId)).toBe('ระยอง')
    // The loser wrote no fill audit for the car it lost.
    expect(await provinceFills(fx.shopA, legacy)).toHaveLength(0)
  })
})
