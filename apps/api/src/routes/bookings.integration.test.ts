/**
 * WO-003 T9 — bookings and the arrival transition, against a real PostgreSQL.
 *
 * TIER 2. Skipped when GSMS_TEST_DB is unset; see src/test/env.ts.
 *
 * This file is the regression guard for CLAUDE.md §5.8: arrival is a
 * transition on an existing booking, never a second creation, and the
 * prototype's worst bug — the old row bouncing back onto the board after
 * "create new queue" — is exactly what `uq_jobs_booking`, the queue_board
 * view's NOT EXISTS clause, and the arrival transaction's all-or-nothing
 * rollback are built to make structurally impossible. Every test here tries to
 * reopen that hole from a different angle rather than merely demonstrating the
 * happy path.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { withShop } from '@gsms/db/client.js'
import * as bookingsRepo from '../repositories/bookings.js'
import { db } from '../lib/db.js'
import { hasDatabase, tier2 } from '../test/env.js'
import {
  auditFor, createTwoShopFixture, get, issueTokensFor, post, startApi,
  type RunningApi, type TwoShopFixture,
} from '../test/fixtures.js'

interface BookingBody {
  id: string
  status: string
  bayId: string | null
  jobId: string | null
}
interface ArriveBody { jobId: string; queueNo: number; jobDate: string }
interface QueueBoardBody {
  items: { kind: string; refId: string; jobId: string | null; status: string }[]
  total: number
}

describe.skipIf(!hasDatabase)(tier2('bookings and arrival (POST /api/bookings, POST /:id/arrive)'), () => {
  let api: RunningApi
  let fx: TwoShopFixture

  beforeAll(async () => {
    api = await startApi()
    fx = await createTwoShopFixture('wo003book')
  })
  afterAll(async () => {
    await fx?.cleanup()
    await api?.close()
  })

  const owner = (shopId: string) => issueTokensFor(fx.userId, shopId, 'owner')
  const asRole = (shopId: string, role: Parameters<typeof issueTokensFor>[2]) =>
    issueTokensFor(fx.userId, shopId, role)

  function hourSlot(offsetHours: number): { slotStart: string; slotEnd: string } {
    const base = Date.now() + offsetHours * 3_600_000
    return {
      slotStart: new Date(base).toISOString(),
      slotEnd: new Date(base + 3_600_000).toISOString(),
    }
  }

  async function insertBay(name: string): Promise<string> {
    const row = await withShop(db, fx.shopA, (trx) => trx.insertInto('bays')
      .values({ shop_id: fx.shopA, name, sort_order: 0 })
      .returning('id').executeTakeFirstOrThrow())
    return row.id
  }

  /** A phone booking — contact only, no customer/vehicle on file yet. */
  async function bookPhone(
    token: string, offsetHours: number, extra: Record<string, unknown> = {},
  ): Promise<BookingBody> {
    const res = await post<BookingBody>(api, '/api/bookings', {
      source: 'phone',
      ...hourSlot(offsetHours),
      bayId: null,
      contactName: 'Phone Customer',
      contactPhone: '0822220000',
      ...extra,
    }, token)
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    return res.body
  }

  // ===========================================================================
  // Case 1 — concurrent arrival yields exactly one job
  // ===========================================================================
  describe('concurrent arrival', () => {
    it('fires the transition twice at once and gets exactly one 201 and one 409, with exactly one job row', async () => {
      const s = await owner(fx.shopA)
      const booking = await bookPhone(s.accessToken, 1)

      const arriveOnce = () => post<ArriveBody>(api, `/api/bookings/${booking.id}/arrive`, {
        plate: 'RACE-ARRIVE-1', customerName: 'Phone Customer', brand: 'Isuzu', model: 'D-Max', province: 'กรุงเทพมหานคร',
      }, s.accessToken)

      const [a, b] = await Promise.all([arriveOnce(), arriveOnce()])
      const statuses = [a.status, b.status].sort()
      expect(statuses, JSON.stringify({ a, b })).toEqual([201, 409])

      const loser = a.status === 409 ? a : b
      expect(loser.body).toMatchObject({ error: 'booking_already_arrived' })
      expect((loser.body as unknown as { message: string }).message).toBe('การจองนี้ถูกเปิดงานไปแล้ว')

      // The assertion that actually matters: not "one request looked right",
      // but that only one row exists. Two 201s could both look correct while
      // uq_jobs_booking silently lost the second insert to a caught exception
      // somewhere upstream — counting the rows is what rules that out.
      const count = await withShop(db, fx.shopA, (trx) => trx.selectFrom('jobs')
        .select(({ fn }) => fn.count<number>('id').as('n'))
        .where('booking_id', '=', booking.id).executeTakeFirstOrThrow())
      expect(Number(count.n)).toBe(1)
    })
  })

  // ===========================================================================
  // Case 2 — a converted booking leaves the board on its own
  // ===========================================================================
  describe('booking -> job transition on the board', () => {
    it('shows the booking, then shows one job row and no booking row, while the booking record itself survives as arrived', async () => {
      const s = await owner(fx.shopA)
      const booking = await bookPhone(s.accessToken, 2)

      const before = await get<QueueBoardBody>(api, '/api/queue?limit=100', s.accessToken)
      expect(before.body.items.some((r) => r.kind === 'booking' && r.refId === booking.id)).toBe(true)

      const arrived = await post<ArriveBody>(api, `/api/bookings/${booking.id}/arrive`, {
        plate: 'BOOKING-VANISH-1', customerName: 'Phone Customer', brand: 'Mazda', model: 'BT-50', province: 'กรุงเทพมหานคร',
      }, s.accessToken)
      expect(arrived.status, JSON.stringify(arrived.body)).toBe(201)

      const after = await get<QueueBoardBody>(api, '/api/queue?limit=100', s.accessToken)
      const bookingRows = after.body.items.filter((r) => r.kind === 'booking' && r.refId === booking.id)
      const jobRows = after.body.items.filter((r) => r.kind === 'job' && r.refId === arrived.body.jobId)
      expect(bookingRows, 'the converted booking is still on the board as a booking row').toHaveLength(0)
      expect(jobRows).toHaveLength(1)

      // Nobody deleted anything: the booking row is still there, just arrived.
      const row = await withShop(db, fx.shopA, (trx) => trx.selectFrom('bookings')
        .select(['status']).where('id', '=', booking.id).executeTakeFirstOrThrow())
      expect(row.status).toBe('arrived')
    })
  })

  // ===========================================================================
  // Case 3 — a refused arrival strands nothing
  // ===========================================================================
  describe('a refused arrival rolls all the way back', () => {
    it('leaves the booking booked and arrivable again, rather than stuck at "arrived" with no job', async () => {
      const s = await owner(fx.shopA)
      const booking = await bookPhone(s.accessToken, 3)

      // No vehicle_id on the booking and no plate typed here: openJob cannot
      // identify a car, so this must fail with vehicle_required.
      const refused = await post(api, `/api/bookings/${booking.id}/arrive`, {}, s.accessToken)
      expect(refused.status).toBe(409)
      expect(refused.body).toMatchObject({ error: 'vehicle_required' })

      // If the status change had committed while the job failed to open, the
      // booking would now be invisible on the board (queue_board only lists
      // 'booked'/'confirmed') AND unable to arrive a second time (markArrived
      // only matches 'booked'/'confirmed'). Both checks below would fail
      // together if the transaction rollback in bookings.ts ever regressed.
      const row = await withShop(db, fx.shopA, (trx) => trx.selectFrom('bookings')
        .select(['status']).where('id', '=', booking.id).executeTakeFirstOrThrow())
      expect(row.status, 'the booking was left stranded at arrived with no job').toBe('booked')

      const board = await get<QueueBoardBody>(api, '/api/queue?limit=100', s.accessToken)
      expect(board.body.items.some((r) => r.kind === 'booking' && r.refId === booking.id)).toBe(true)

      // And it really can still be arrived, this time with the missing fact
      // supplied.
      const retried = await post<ArriveBody>(api, `/api/bookings/${booking.id}/arrive`, {
        plate: 'STRAND-RETRY-1', customerName: 'Phone Customer', brand: 'Ford', model: 'Ranger', province: 'กรุงเทพมหานคร',
      }, s.accessToken)
      expect(retried.status, JSON.stringify(retried.body)).toBe(201)
    })
  })

  // ===========================================================================
  // Case 4 — a new plate with no brand/model is refused, not invented
  //
  // Reached through arrival, not walk-in: CheckInInput (checkin.ts) makes
  // brand/model/customerName required at the schema, so a walk-in missing them
  // never reaches openJob's own `details_required` outcome at all — see
  // checkin.integration.test.ts. ArriveInput makes every one of those fields
  // optional, because the booking may already supply it, so a phone booking
  // that types only a plate is the case that actually exercises this branch of
  // resolveCar.
  // ===========================================================================
  describe('arrival with a brand-new plate and no brand/model', () => {
    it('answers 409 intake_details_required with a fields map, and creates no vehicle row', async () => {
      const s = await owner(fx.shopA)
      const booking = await bookPhone(s.accessToken, 4)
      const plate = 'ARRIVE-NODETAILS-1'

      const res = await post(api, `/api/bookings/${booking.id}/arrive`, {
        plate,
        // brand and model omitted on purpose; the booking supplies
        // customerName/customerPhone as contact_name/contact_phone, so those
        // are not what is missing here.
      }, s.accessToken)
      expect(res.status).toBe(409)
      expect(res.body).toMatchObject({ error: 'intake_details_required' })
      const fields = (res.body as { fields: Record<string, unknown> }).fields
      expect(fields).toHaveProperty('brand')
      expect(fields).toHaveProperty('model')

      const rows = await withShop(db, fx.shopA, (trx) => trx.selectFrom('vehicles')
        .select(['id']).where('plate', '=', plate).execute())
      expect(rows, 'a vehicle row was created despite the refusal').toHaveLength(0)

      // And, per case 3, the booking itself must not be stranded either.
      const row = await withShop(db, fx.shopA, (trx) => trx.selectFrom('bookings')
        .select(['status']).where('id', '=', booking.id).executeTakeFirstOrThrow())
      expect(row.status).toBe('booked')
    })
  })

  // ===========================================================================
  // Case 5 — bay double-booking is refused by the database
  // ===========================================================================
  describe('overlapping bookings on the same bay', () => {
    it('refuses the second one through the API with 409 bay_slot_taken', async () => {
      const s = await owner(fx.shopA)
      const bayId = await insertBay('overlap-bay')
      const base = Date.now() + 24 * 3_600_000

      const first = await post<BookingBody>(api, '/api/bookings', {
        source: 'phone', bayId,
        slotStart: new Date(base).toISOString(),
        slotEnd: new Date(base + 3_600_000).toISOString(),
        contactName: 'Overlap One', contactPhone: '0833330001',
      }, s.accessToken)
      expect(first.status).toBe(201)

      const second = await post(api, '/api/bookings', {
        source: 'phone', bayId,
        // Overlaps the first by 30 minutes.
        slotStart: new Date(base + 1_800_000).toISOString(),
        slotEnd: new Date(base + 5_400_000).toISOString(),
        contactName: 'Overlap Two', contactPhone: '0833330002',
      }, s.accessToken)
      expect(second.status).toBe(409)
      expect(second.body).toMatchObject({ error: 'bay_slot_taken' })
    })

    /**
     * The same collision, one layer down, with no zod validation and no route
     * in the way — proof that the exclusion refuses it, not application code
     * translating a check it ran itself. If this test could not be written —
     * if the repository happily inserted both rows — the 409 above would be
     * apps/api guessing, not the database deciding.
     */
    it('is the database\'s EXCLUDE constraint, not application logic: the raw repository insert fails the same way', async () => {
      const bayId = await insertBay('overlap-bay-raw')
      const base = Date.now() + 48 * 3_600_000
      await withShop(db, fx.shopA, (trx) => bookingsRepo.create(trx, {
        shopId: fx.shopA, createdBy: null, source: 'phone', bayId,
        slotStart: new Date(base).toISOString(), slotEnd: new Date(base + 3_600_000).toISOString(),
        contactName: 'Raw One',
      }))

      await expect(withShop(db, fx.shopA, (trx) => bookingsRepo.create(trx, {
        shopId: fx.shopA, createdBy: null, source: 'phone', bayId,
        slotStart: new Date(base + 1_800_000).toISOString(),
        slotEnd: new Date(base + 5_400_000).toISOString(),
        contactName: 'Raw Two',
      }))).rejects.toMatchObject({ code: '23P01', constraint: 'ex_bookings_no_overlap' })
    })
  })

  // ===========================================================================
  // Case 6 — a booking with no bay may overlap freely
  // ===========================================================================
  describe('bay-less bookings', () => {
    it('two bookings at the identical time, both with no bay, both succeed', async () => {
      const s = await owner(fx.shopA)
      const slot = hourSlot(72)

      const first = await post(api, '/api/bookings', {
        source: 'phone', bayId: null, ...slot,
        contactName: 'No Bay One', contactPhone: '0844440001',
      }, s.accessToken)
      const second = await post(api, '/api/bookings', {
        source: 'phone', bayId: null, ...slot,
        contactName: 'No Bay Two', contactPhone: '0844440002',
      }, s.accessToken)
      expect(first.status).toBe(201)
      expect(second.status).toBe(201)
    })
  })

  // ===========================================================================
  // Case 7 — cross-shop reads and writes
  // ===========================================================================
  describe('cross-shop isolation', () => {
    it('shop B lists none of shop A\'s bookings, while shop A sees its own', async () => {
      const s = await owner(fx.shopA)
      const booking = await bookPhone(s.accessToken, 96)

      const listA = await get<{ items: BookingBody[] }>(api, '/api/bookings?limit=100', s.accessToken)
      expect(listA.body.items.some((b) => b.id === booking.id)).toBe(true)

      const asB = await owner(fx.shopB)
      const listB = await get<{ items: BookingBody[] }>(api, '/api/bookings?limit=100', asB.accessToken)
      expect(listB.body.items.some((b) => b.id === booking.id)).toBe(false)
    })

    it('shop B cannot arrive shop A\'s booking: 404, not a leak', async () => {
      const s = await owner(fx.shopA)
      const booking = await bookPhone(s.accessToken, 97)
      const asB = await owner(fx.shopB)

      const res = await post(api, `/api/bookings/${booking.id}/arrive`, {
        plate: 'XSHOP-ARRIVE-1', customerName: 'x', brand: 'x', model: 'x', province: 'กรุงเทพมหานคร',
      }, asB.accessToken)
      expect(res.status).toBe(404)
      expect(res.body).toMatchObject({ error: 'booking_not_found' })
    })
  })

  // ===========================================================================
  // Case 12 — role gates
  // ===========================================================================
  describe('role gates', () => {
    it('a viewer cannot create a booking', async () => {
      const viewer = await asRole(fx.shopA, 'viewer')
      const res = await post(api, '/api/bookings', {
        source: 'phone', ...hourSlot(120), bayId: null, contactName: 'x', contactPhone: '0855550001',
      }, viewer.accessToken)
      expect(res.status).toBe(403)
    })

    it('a technician cannot arrive a booking', async () => {
      const owned = await owner(fx.shopA)
      const booking = await bookPhone(owned.accessToken, 121)
      const tech = await asRole(fx.shopA, 'technician')
      const res = await post(api, `/api/bookings/${booking.id}/arrive`, {
        plate: 'ROLE-TECH-1', customerName: 'x', brand: 'x', model: 'x', province: 'กรุงเทพมหานคร',
      }, tech.accessToken)
      expect(res.status).toBe(403)
    })
  })

  // ===========================================================================
  // Case 13 — audit rows
  // ===========================================================================
  describe('audit log', () => {
    it('writes booking_created and booking_arrived', async () => {
      const s = await owner(fx.shopA)
      const booking = await bookPhone(s.accessToken, 130)
      expect((await auditFor(fx.shopA, 'booking_created', booking.id)).length).toBeGreaterThan(0)

      const arrived = await post<ArriveBody>(api, `/api/bookings/${booking.id}/arrive`, {
        plate: 'AUDIT-ARRIVE-1', customerName: 'Phone Customer', brand: 'Nissan', model: 'Navara', province: 'กรุงเทพมหานคร',
      }, s.accessToken)
      expect(arrived.status).toBe(201)
      expect((await auditFor(fx.shopA, 'booking_arrived', booking.id)).length).toBeGreaterThan(0)
    })
  })
})
