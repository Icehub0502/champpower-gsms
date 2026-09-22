/**
 * Bookings — a car that is expected but not here yet.
 *
 * All four intake paths live in this one table (walk-in, phone/chat, a
 * quotation request before the customer decides, a special-part order with no
 * date yet) because all four compete for the same bays. A booking with no bay
 * is a soft reservation and deliberately does NOT participate in
 * `ex_bookings_no_overlap` — 0008 excludes bay-less rows on purpose, so two
 * soft reservations may sit on the same hour.
 *
 * `bookings.job_id` no longer exists: 0011 moved the link to `jobs.booking_id`
 * so only one side of the relationship can be wrong at a time. `jobId` on the
 * wire therefore comes from a LEFT JOIN, not from a column.
 */
import { sql } from 'kysely'
import type { ScopedTx } from '@gsms/db/client.js'

export interface BookingSummaryRow {
  id: string
  source: string
  slot_start: Date
  slot_end: Date
  status: string
  bay_id: string | null
  bay_name: string | null
  customer_id: string | null
  vehicle_id: string | null
  contact_name: string | null
  contact_phone: string | null
  note: string | null
  job_id: string | null
  created_at: Date
}

const SUMMARY_COLUMNS = [
  'b.id as id',
  'b.source as source',
  'b.slot_start as slot_start',
  'b.slot_end as slot_end',
  'b.status as status',
  'b.bay_id as bay_id',
  'bay.name as bay_name',
  'b.customer_id as customer_id',
  'b.vehicle_id as vehicle_id',
  'b.contact_name as contact_name',
  'b.contact_phone as contact_phone',
  'b.note as note',
  'j.id as job_id',
  'b.created_at as created_at',
] as const

export interface CreateBooking {
  shopId: string
  createdBy: string | null
  source: string
  slotStart: string
  slotEnd: string
  bayId?: string | null | undefined
  customerId?: string | null | undefined
  vehicleId?: string | null | undefined
  contactName?: string | null | undefined
  contactPhone?: string | null | undefined
  note?: string | null | undefined
}

export async function create(trx: ScopedTx, input: CreateBooking): Promise<{ id: string }> {
  return trx
    .insertInto('bookings')
    .values({
      shop_id: input.shopId,
      created_by: input.createdBy,
      source: input.source,
      slot_start: input.slotStart,
      slot_end: input.slotEnd,
      bay_id: input.bayId ?? null,
      customer_id: input.customerId ?? null,
      vehicle_id: input.vehicleId ?? null,
      contact_name: input.contactName ?? null,
      contact_phone: input.contactPhone ?? null,
      note: input.note ?? null,
    })
    .returning('id')
    .executeTakeFirstOrThrow()
}

export async function findSummary(
  trx: ScopedTx,
  id: string,
): Promise<BookingSummaryRow | undefined> {
  return trx
    .selectFrom('bookings as b')
    .leftJoin('bays as bay', 'bay.id', 'b.bay_id')
    .leftJoin('jobs as j', (join) =>
      join.onRef('j.booking_id', '=', 'b.id').on('j.deleted_at', 'is', null))
    .select(SUMMARY_COLUMNS)
    .where('b.id', '=', id)
    .executeTakeFirst()
}

export interface ListBookings {
  from: Date
  to: Date
  status?: string | undefined
  limit: number
  offset: number
}

export async function list(
  trx: ScopedTx,
  q: ListBookings,
): Promise<{ items: BookingSummaryRow[]; total: number }> {
  let base = trx
    .selectFrom('bookings as b')
    .where('b.slot_start', '>=', q.from)
    .where('b.slot_start', '<', q.to)
  if (q.status) base = base.where('b.status', '=', q.status)

  const totalRow = await base
    .select(sql<number>`count(*)`.as('n'))
    .executeTakeFirst()

  const items = await base
    .leftJoin('bays as bay', 'bay.id', 'b.bay_id')
    .leftJoin('jobs as j', (join) =>
      join.onRef('j.booking_id', '=', 'b.id').on('j.deleted_at', 'is', null))
    .select(SUMMARY_COLUMNS)
    .orderBy('b.slot_start', 'asc')
    // A stable tiebreaker, or two bookings on the same slot can swap places
    // between page 1 and page 2 and one of them is never shown.
    .orderBy('b.id', 'asc')
    .limit(q.limit)
    .offset(q.offset)
    .execute()

  return { items, total: Number(totalRow?.n ?? 0) }
}

export interface PatchBooking {
  source?: string | undefined
  slotStart?: string | undefined
  slotEnd?: string | undefined
  bayId?: string | null | undefined
  customerId?: string | undefined
  vehicleId?: string | undefined
  contactName?: string | undefined
  contactPhone?: string | undefined
  note?: string | undefined
  status?: string | undefined
}

/** Returns the number of rows changed; 0 means "no such booking here". */
export async function patch(
  trx: ScopedTx,
  id: string,
  input: PatchBooking,
): Promise<number> {
  const values: Record<string, unknown> = {}
  if (input.source !== undefined) values.source = input.source
  if (input.slotStart !== undefined) values.slot_start = input.slotStart
  if (input.slotEnd !== undefined) values.slot_end = input.slotEnd
  if (input.bayId !== undefined) values.bay_id = input.bayId
  if (input.customerId !== undefined) values.customer_id = input.customerId
  if (input.vehicleId !== undefined) values.vehicle_id = input.vehicleId
  if (input.contactName !== undefined) values.contact_name = input.contactName
  if (input.contactPhone !== undefined) values.contact_phone = input.contactPhone
  if (input.note !== undefined) values.note = input.note
  if (input.status !== undefined) values.status = input.status
  if (Object.keys(values).length === 0) return 0

  const r = await trx
    .updateTable('bookings')
    .set(values)
    .where('id', '=', id)
    .executeTakeFirst()
  return Number(r.numUpdatedRows)
}

/**
 * What the booking contributes to the job it becomes.
 *
 * The contact fields are here because a booking taken over the phone may hold
 * nothing else: no customer row, no vehicle row, just a name and a number
 * written down when they called. Arrival uses them as the fallback for
 * whatever the counter does not retype.
 */
export interface ArrivingBooking {
  id: string
  customer_id: string | null
  vehicle_id: string | null
  bay_id: string | null
  contact_name: string | null
  contact_phone: string | null
  note: string | null
}

/**
 * Move a booking to `arrived`, and hand back what the job needs.
 *
 * One statement, and the `status IN ('booked','confirmed')` predicate is the
 * gate — NOT a SELECT beforehand. Two concurrent "รถมาถึงแล้ว" requests both
 * reach this UPDATE; PostgreSQL makes the second wait on the row lock, and
 * when it proceeds the row no longer matches, so it updates nothing and the
 * caller reports the conflict. `uq_jobs_booking` stands behind it as the
 * second line: even if the status were somehow still open, the INSERT would be
 * refused.
 */
export async function markArrived(
  trx: ScopedTx,
  id: string,
): Promise<ArrivingBooking | undefined> {
  return trx
    .updateTable('bookings')
    .set({ status: 'arrived' })
    .where('id', '=', id)
    .where('status', 'in', ['booked', 'confirmed'])
    .returning(['id', 'customer_id', 'vehicle_id', 'bay_id', 'contact_name', 'contact_phone', 'note'])
    .executeTakeFirst()
}

/**
 * Write back who the customer and the car turned out to be.
 *
 * A booking taken over the phone holds a name and a number and nothing else.
 * Once arrival has resolved that into real rows, the booking has to learn the
 * answer too — in the same transaction that opens the job, or the two rows
 * tell different stories and every report counted from the booking side is
 * wrong. Leaving `bookings.customer_id` NULL forever while `jobs` knows
 * perfectly well who it was is a slow, quiet kind of data loss.
 *
 * Only ever fills blanks in practice, but writes both columns unconditionally:
 * after the owner-change confirmation the car may legitimately belong to
 * someone other than whoever the booking originally named.
 */
export async function backfillIdentity(
  trx: ScopedTx,
  id: string,
  customerId: string,
  vehicleId: string,
): Promise<void> {
  await trx
    .updateTable('bookings')
    .set({ customer_id: customerId, vehicle_id: vehicleId })
    .where('id', '=', id)
    .execute()
}

/** Only for telling a failed arrival apart from a missing booking. */
export async function statusOf(
  trx: ScopedTx,
  id: string,
): Promise<string | undefined> {
  const row = await trx
    .selectFrom('bookings')
    .select(['status'])
    .where('id', '=', id)
    .executeTakeFirst()
  return row?.status
}
