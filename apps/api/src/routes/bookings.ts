/**
 * Bookings, and the transition that ends one.
 *
 * There is no "create a job from this booking" endpoint here, and there never
 * should be. `POST /:id/arrive` ADVANCES a booking that already exists; the
 * button on the screen says "รถมาถึงแล้ว", not "สร้างคิวใหม่". That naming is
 * the whole lesson of CLAUDE.md §5.8: in the prototype the arrival button
 * created a fifth thing beside the booking, the quotation, the deposit and the
 * queue entry, and the old row bounced back onto the board because nothing in
 * the database knew the two were the same car.
 *
 * Nothing here asks "does this booking already have a job?" before writing.
 * `uq_jobs_booking` answers that question correctly under concurrency; a
 * SELECT cannot, because two tablets both pass it before either writes.
 */
import { z } from 'zod'
import { withShop } from '@gsms/db/client.js'
import {
  ArriveInput,
  CreateBookingInput,
  PageQuery,
  UpdateBookingInput,
  type BookingAlreadyArrivedError,
  type BookingNotFoundError,
  type BookingNotOpenError,
  type BookingSummary,
  type InvalidRequestError,
} from '@gsms/contracts/index.js'
import { db } from '../lib/db.js'
import { requireAuth, requireRole, type AuthedRequest } from '../middleware/requireAuth.js'
import { asyncRouter } from '../middleware/asyncHandler.js'
import { sendPgError } from '../lib/pgError.js'
import { fieldErrorsOf } from '../lib/fieldErrors.js'
import { addDays, bangkokToday, endOfDayExclusive, startOfDay } from '../lib/bangkokDate.js'
import * as bookingsRepo from '../repositories/bookings.js'
import * as baysRepo from '../repositories/bays.js'
import * as customersRepo from '../repositories/customers.js'
import * as vehiclesRepo from '../repositories/vehicles.js'
import { writeAudit } from '../services/audit.js'
import { openJob, withQueueNoRetry, type OpenJobOutcome } from '../services/intake.js'
import { BOARD_READ_ROLES, INTAKE_WRITE_ROLES, sendIntakeOutcome } from './queue.js'

export const bookingsRouter = asyncRouter()

/**
 * Thrown to undo the `status = 'arrived'` when the job cannot be opened.
 *
 * The status change and the job are one transaction by design. Returning the
 * refusal normally would COMMIT the status change, leaving a booking marked
 * arrived with no job behind it — off the board (the view only hides bookings
 * that have a job, but 'arrived' is not in the view's status filter either),
 * and unable to arrive again because `markArrived` only matches
 * booked/confirmed. That is a car stranded between two states, which is worse
 * than the error that caused it.
 */
class ArrivalRefused extends Error {
  constructor(readonly outcome: Exclude<OpenJobOutcome, { kind: 'ok' }>) {
    super('arrival refused')
  }
}

const idParam = z.object({ id: z.string().uuid() })
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const ListQuery = z.object({ from: isoDate.optional(), to: isoDate.optional(), status: z.string().optional() })

function toSummary(r: bookingsRepo.BookingSummaryRow): BookingSummary {
  return {
    id: r.id,
    source: r.source as BookingSummary['source'],
    slotStart: r.slot_start.toISOString(),
    slotEnd: r.slot_end.toISOString(),
    status: r.status as BookingSummary['status'],
    bayId: r.bay_id,
    bayName: r.bay_name,
    customerId: r.customer_id,
    vehicleId: r.vehicle_id,
    contactName: r.contact_name,
    contactPhone: r.contact_phone,
    note: r.note,
    jobId: r.job_id,
    createdAt: r.created_at.toISOString(),
  }
}

/**
 * Confirm that a customer or vehicle id names a row in THIS shop.
 *
 * Foreign key checks in PostgreSQL run with row-level security bypassed, so a
 * booking could otherwise be written pointing at another branch's customer.
 * Under `withShop` these SELECTs see only this shop, so a foreign id comes back
 * empty and the request is refused.
 */
async function unknownReference(
  trx: Parameters<typeof bookingsRepo.create>[0],
  shopId: string,
  ids: { customerId?: string | undefined; vehicleId?: string | undefined; bayId?: string | null | undefined },
): Promise<string | null> {
  if (ids.customerId && !(await customersRepo.findById(trx, ids.customerId))) return 'unknown_customer'
  if (ids.vehicleId && !(await vehiclesRepo.findById(trx, shopId, ids.vehicleId))) return 'unknown_vehicle'
  if (ids.bayId && !(await baysRepo.findById(trx, ids.bayId))) return 'unknown_bay'
  return null
}

const REFERENCE_MESSAGES: Record<string, string> = {
  unknown_customer: 'ไม่พบลูกค้ารายนี้ในสาขานี้',
  unknown_vehicle: 'ไม่พบรถคันนี้ในสาขานี้',
  unknown_bay: 'ไม่พบช่องยกนี้ในสาขานี้',
}

bookingsRouter.post(
  '/',
  requireAuth,
  requireRole(...INTAKE_WRITE_ROLES),
  async (req: AuthedRequest, res) => {
    const parsed = CreateBookingInput.safeParse(req.body)
    if (!parsed.success) {
      // Codes only: zod's default messages can quote the value that failed
      // (lib/fieldErrors.ts), and a phone or a name is not ours to echo.
      const body: InvalidRequestError = {
        error: 'invalid_request',
        message: 'ข้อมูลที่กรอกไม่ครบหรือไม่ถูกต้อง',
        fields: fieldErrorsOf(parsed.error),
      }
      res.status(400).json(body)
      return
    }
    const auth = req.auth!
    const input = parsed.data

    try {
      const outcome = await withShop(db, auth.shop, async (trx) => {
        const bad = await unknownReference(trx, auth.shop, input)
        if (bad) return { kind: 'bad_reference' as const, code: bad }

        // No overlap check in code. `ex_bookings_no_overlap` is a gist
        // exclusion constraint and it is the only thing that can decide this
        // correctly when two people take a booking at the same moment.
        const booking = await bookingsRepo.create(trx, {
          shopId: auth.shop,
          createdBy: auth.sub,
          source: input.source,
          slotStart: input.slotStart,
          slotEnd: input.slotEnd,
          bayId: input.bayId,
          customerId: input.customerId,
          vehicleId: input.vehicleId,
          contactName: input.contactName,
          contactPhone: input.contactPhone
            ? customersRepo.normalisePhone(input.contactPhone)
            : undefined,
          note: input.note,
        })

        await writeAudit(trx, {
          shopId: auth.shop,
          actorId: auth.sub,
          action: 'booking_created',
          entityType: 'bookings',
          entityId: booking.id,
          before: null,
          after: {
            source: input.source,
            slot_start: input.slotStart,
            slot_end: input.slotEnd,
            bay_id: input.bayId ?? null,
          },
        })

        const summary = await bookingsRepo.findSummary(trx, booking.id)
        return { kind: 'ok' as const, summary: summary! }
      })

      if (outcome.kind === 'bad_reference') {
        res.status(400).json({ error: outcome.code, message: REFERENCE_MESSAGES[outcome.code] })
        return
      }
      res.status(201).json(toSummary(outcome.summary))
    } catch (err) {
      sendPgError(res, err)
    }
  },
)

bookingsRouter.get(
  '/',
  requireAuth,
  requireRole(...BOARD_READ_ROLES),
  async (req: AuthedRequest, res) => {
    const q = ListQuery.safeParse(req.query)
    const page = PageQuery.safeParse(req.query)
    if (!q.success || !page.success) {
      res.status(400).json({ error: 'invalid_request' })
      return
    }
    const today = bangkokToday()
    const from = q.data.from ?? today
    const to = q.data.to ?? addDays(today, 7)
    if (to < from) {
      res.status(400).json({ error: 'invalid_request', message: 'ช่วงวันที่ไม่ถูกต้อง' })
      return
    }

    const result = await withShop(db, req.auth!.shop, (trx) =>
      bookingsRepo.list(trx, {
        from: startOfDay(from),
        to: endOfDayExclusive(to),
        status: q.data.status,
        limit: page.data.limit,
        offset: page.data.offset,
      }))

    res.json({ items: result.items.map(toSummary), total: result.total })
  },
)

bookingsRouter.patch(
  '/:id',
  requireAuth,
  requireRole(...INTAKE_WRITE_ROLES),
  async (req: AuthedRequest, res) => {
    const params = idParam.safeParse(req.params)
    const parsed = UpdateBookingInput.safeParse(req.body)
    if (!params.success || !parsed.success) {
      res.status(400).json({ error: 'invalid_request' })
      return
    }
    const auth = req.auth!
    const id = params.data.id
    const input = parsed.data

    try {
      const outcome = await withShop(db, auth.shop, async (trx) => {
        const before = await bookingsRepo.findSummary(trx, id)
        if (!before) return { kind: 'not_found' as const }

        const bad = await unknownReference(trx, auth.shop, input)
        if (bad) return { kind: 'bad_reference' as const, code: bad }

        const changed = await bookingsRepo.patch(trx, id, {
          ...input,
          contactPhone: input.contactPhone
            ? customersRepo.normalisePhone(input.contactPhone)
            : undefined,
        })
        if (changed === 0) return { kind: 'ok' as const, summary: before }

        await writeAudit(trx, {
          shopId: auth.shop,
          actorId: auth.sub,
          action: 'booking_updated',
          entityType: 'bookings',
          entityId: id,
          before: {
            status: before.status,
            bay_id: before.bay_id,
            slot_start: before.slot_start.toISOString(),
            slot_end: before.slot_end.toISOString(),
          },
          after: {
            status: input.status ?? before.status,
            bay_id: input.bayId === undefined ? before.bay_id : input.bayId,
            slot_start: input.slotStart ?? before.slot_start.toISOString(),
            slot_end: input.slotEnd ?? before.slot_end.toISOString(),
          },
        })

        const after = await bookingsRepo.findSummary(trx, id)
        return { kind: 'ok' as const, summary: after! }
      })

      if (outcome.kind === 'not_found') {
        res.status(404).json({ error: 'booking_not_found', message: 'ไม่พบการจองนี้' })
        return
      }
      if (outcome.kind === 'bad_reference') {
        res.status(400).json({ error: outcome.code, message: REFERENCE_MESSAGES[outcome.code] })
        return
      }
      res.json(toSummary(outcome.summary))
    } catch (err) {
      sendPgError(res, err)
    }
  },
)

/**
 * The arrival transition. The car is here.
 *
 * Booking -> arrived and the job opened in ONE transaction, with the job
 * carrying `booking_id`. The moment that row commits, the booking leaves the
 * board on its own: `queue_board` excludes any booking a job points at, so
 * nothing is deleted and nothing has to be remembered.
 *
 * Fire this twice at once and exactly one job appears. The second request
 * finds the booking no longer in ('booked','confirmed') — it waited on the row
 * lock — and if it somehow got past that, `uq_jobs_booking` refuses the insert.
 * Two independent guarantees, neither of them a SELECT.
 *
 * It also captures the car. A booking taken over the phone may know only a
 * name and a number, so every check-in field may be supplied here and the
 * booking is the fallback for each one: what is typed now wins, otherwise the
 * booking's own value is used. The job is opened by the SAME `openJob` the
 * walk-in door calls — a second implementation would drift, and the drifting
 * one would be whichever the shop uses less.
 */
bookingsRouter.post(
  '/:id/arrive',
  requireAuth,
  requireRole(...INTAKE_WRITE_ROLES),
  async (req: AuthedRequest, res) => {
    const params = idParam.safeParse(req.params)
    const parsed = ArriveInput.safeParse(req.body ?? {})
    if (!params.success || !parsed.success) {
      // Built as the contract type, with the failing fields when the BODY was
      // at fault; a malformed booking id in the path has no field to point at.
      const body: InvalidRequestError = {
        error: 'invalid_request',
        message: 'ข้อมูลที่กรอกไม่ครบหรือไม่ถูกต้อง',
        ...(parsed.success ? {} : { fields: fieldErrorsOf(parsed.error) }),
      }
      res.status(400).json(body)
      return
    }
    const auth = req.auth!
    const bookingId = params.data.id
    const input = parsed.data
    const serverAllocated = input.queueNo === undefined

    type ArriveOutcome =
      | { kind: 'opened'; outcome: OpenJobOutcome }
      | { kind: 'not_found' }
      | { kind: 'already_arrived' }
      | { kind: 'not_open'; status: string }

    try {
      const arrival = await withQueueNoRetry<ArriveOutcome>(serverAllocated, () =>
        withShop(db, auth.shop, async (trx): Promise<ArriveOutcome> => {
          const booking = await bookingsRepo.markArrived(trx, bookingId)
          if (!booking) {
            // Only reached once the UPDATE has already decided; this read is
            // for the WORDING of the failure, not for the decision.
            const status = await bookingsRepo.statusOf(trx, bookingId)
            if (status === undefined) return { kind: 'not_found' }
            if (status === 'arrived') return { kind: 'already_arrived' }
            return { kind: 'not_open', status }
          }

          // The merge: typed now wins, the booking is the fallback. A phone
          // booking contributes contact_name/contact_phone and nothing else;
          // a booking made for a known customer contributes their ids.
          const outcome = await openJob(trx, {
            shopId: auth.shop,
            actorId: auth.sub,
            source: 'booked',
            // The link. This is what makes the booking disappear from the
            // board and what makes a second arrival impossible.
            bookingId: booking.id,
            // The booking's car, and separately the car the counter picked
            // (only when answering vehicle_ambiguous). The pick wins, but is
            // checked: visible to this shop, same plate as typed, and — when
            // nothing else says who is here — owned by the booking's customer
            // or confirmed as an owner change (services/intake.ts).
            vehicleId: booking.vehicle_id,
            pickedVehicleId: input.vehicleId,
            plate: input.plate,
            customerName: input.customerName ?? booking.contact_name ?? undefined,
            customerPhone: input.customerPhone ?? booking.contact_phone ?? undefined,
            brand: input.brand,
            model: input.model,
            color: input.color,
            year: input.year,
            province: input.province,
            leadSource: input.leadSource,
            mileageInKm: input.mileageInKm,
            queueNo: input.queueNo,
            jobDate: input.jobDate,
            symptom: input.symptom ?? booking.note ?? undefined,
            bayId: input.bayId ?? booking.bay_id,
            photoFileIds: input.photoFileIds,
            customerId: input.customerId ?? booking.customer_id ?? undefined,
            confirmOwnerChange: input.confirmOwnerChange,
            confirmNewVehicle: input.confirmNewVehicle,
          })

          // A refusal has to take the status change with it, or the booking
          // sits at 'arrived' with no job: invisible on the board, and
          // impossible to arrive again. Throwing rolls the transaction back —
          // which is also what makes the three resolver refusals safe to
          // retry: the booking is still 'booked' when the counter resends.
          if (outcome.kind !== 'ok') throw new ArrivalRefused(outcome)

          // The booking learns what the arrival worked out. Same transaction
          // as the job, so the two can never disagree.
          await bookingsRepo.backfillIdentity(
            trx, booking.id, outcome.customerId, outcome.vehicleId)

          await writeAudit(trx, {
            shopId: auth.shop,
            actorId: auth.sub,
            action: 'booking_arrived',
            entityType: 'bookings',
            entityId: booking.id,
            before: { status: 'booked_or_confirmed', job_id: null },
            after: {
              status: 'arrived',
              job_id: outcome.jobId,
              job_date: outcome.jobDate,
              queue_no: outcome.queueNo,
              bay_id: input.bayId ?? booking.bay_id,
            },
          })

          return { kind: 'opened', outcome }
        }))

      switch (arrival.kind) {
        // Each built as its contract type (packages/contracts errors.ts).
        case 'not_found': {
          const body: BookingNotFoundError = { error: 'booking_not_found', message: 'ไม่พบการจองนี้' }
          res.status(404).json(body)
          return
        }
        case 'already_arrived': {
          const body: BookingAlreadyArrivedError = {
            error: 'booking_already_arrived',
            message: 'การจองนี้ถูกเปิดงานไปแล้ว',
          }
          res.status(409).json(body)
          return
        }
        case 'not_open': {
          const body: BookingNotOpenError = {
            error: 'booking_not_open',
            message: `การจองนี้อยู่ในสถานะ ${arrival.status} จึงเปิดงานไม่ได้`,
          }
          res.status(409).json(body)
          return
        }
        default: {
          const ok = arrival.outcome as Extract<OpenJobOutcome, { kind: 'ok' }>
          res.status(201).json({
            jobId: ok.jobId,
            queueNo: ok.queueNo,
            jobDate: ok.jobDate,
            customerId: ok.customerId,
            vehicleId: ok.vehicleId,
            bookingId,
          })
        }
      }
    } catch (err) {
      if (err instanceof ArrivalRefused) {
        sendIntakeOutcome(res, err.outcome)
        return
      }
      sendPgError(res, err, { queueNo: input.queueNo ?? null })
    }
  },
)
