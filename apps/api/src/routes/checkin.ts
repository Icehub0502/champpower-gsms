/**
 * Walk-in check-in — a car with no booking, in front of the counter now.
 *
 * The work is in services/intake.ts, shared with the arrival transition,
 * because a walk-in and a booked car that turns up are the same event. This
 * file is the door: validate, call, translate the outcome.
 *
 * One transaction covers the whole thing. Half of it committing is worse than
 * none of it — a customer with no car, or a job with no complaint line, is a
 * row someone has to clean up by hand later.
 */
import { withShop } from '@gsms/db/client.js'
import {
  CheckInInput,
  CustomerLookupQuery,
  VehicleLookupQuery,
  type CheckInResult,
  type CustomerAmbiguousError,
  type InvalidRequestError,
  type CustomerLookupResult,
  type VehicleLookupResult,
} from '@gsms/contracts/index.js'
import { db } from '../lib/db.js'
import { requireAuth, requireRole, type AuthedRequest } from '../middleware/requireAuth.js'
import { asyncRouter } from '../middleware/asyncHandler.js'
import { sendPgError } from '../lib/pgError.js'
import { fieldErrorsOf } from '../lib/fieldErrors.js'
import * as customersRepo from '../repositories/customers.js'
import * as vehiclesRepo from '../repositories/vehicles.js'
import { openJob, withQueueNoRetry, type OpenJobOutcome } from '../services/intake.js'
import { BOARD_READ_ROLES, INTAKE_WRITE_ROLES, sendIntakeOutcome } from './queue.js'

export const checkinRouter = asyncRouter()

checkinRouter.post(
  '/',
  requireAuth,
  requireRole(...INTAKE_WRITE_ROLES),
  async (req: AuthedRequest, res) => {
    const parsed = CheckInInput.safeParse(req.body)
    if (!parsed.success) {
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
    const serverAllocated = input.queueNo === undefined

    try {
      const outcome = await withQueueNoRetry<OpenJobOutcome>(serverAllocated, () =>
        withShop(db, auth.shop, (trx) =>
          openJob(trx, {
            shopId: auth.shop,
            actorId: auth.sub,
            source: 'walk_in',
            plate: input.plate,
            customerName: input.customerName,
            customerPhone: input.customerPhone,
            brand: input.brand,
            model: input.model,
            color: input.color,
            year: input.year,
            province: input.province,
            leadSource: input.leadSource,
            mileageInKm: input.mileageInKm,
            queueNo: input.queueNo,
            jobDate: input.jobDate,
            symptom: input.symptom,
            bayId: input.bayId,
            photoFileIds: input.photoFileIds,
            // Both present only on a second attempt, after the counter has
            // seen and answered a 409.
            customerId: input.customerId,
            confirmOwnerChange: input.confirmOwnerChange,
          })))

      if (outcome.kind !== 'ok') {
        sendIntakeOutcome(res, outcome)
        return
      }
      const result: CheckInResult = {
        jobId: outcome.jobId,
        queueNo: outcome.queueNo,
        jobDate: outcome.jobDate,
        customerId: outcome.customerId,
        vehicleId: outcome.vehicleId,
      }
      res.status(201).json(result)
    } catch (err) {
      sendPgError(res, err, { queueNo: input.queueNo ?? null })
    }
  },
)

/**
 * Prefill by plate.
 *
 * The counter types the plate first; everything else on the form should already
 * be filled in by the time they look up, or they retype it slightly differently
 * and the shop ends up with the same car twice.
 */
checkinRouter.get(
  '/vehicle-lookup',
  requireAuth,
  requireRole(...BOARD_READ_ROLES),
  async (req: AuthedRequest, res) => {
    const q = VehicleLookupQuery.safeParse(req.query)
    if (!q.success) {
      const body: InvalidRequestError = {
        error: 'invalid_request',
        message: 'ข้อมูลที่กรอกไม่ครบหรือไม่ถูกต้อง',
        fields: fieldErrorsOf(q.error),
      }
      res.status(400).json(body)
      return
    }

    const found = await withShop(db, req.auth!.shop, async (trx) => {
      const vehicle = await vehiclesRepo.findByPlate(trx, q.data.plate)
      if (!vehicle) return undefined
      const customer = await customersRepo.findById(trx, vehicle.customer_id)
      const result: VehicleLookupResult = {
        vehicleId: vehicle.id,
        customerId: vehicle.customer_id,
        plate: vehicle.plate,
        brand: vehicle.brand,
        model: vehicle.model,
        color: vehicle.color,
        year: vehicle.year,
        province: vehicle.province,
        customerName: customer?.name ?? null,
        customerPhone: customer?.phone ?? null,
      }
      return result
    })

    if (!found) {
      res.status(404).json({ error: 'vehicle_not_found', message: 'ไม่พบรถทะเบียนนี้' })
      return
    }
    res.json(found)
  },
)

/** Prefill by phone, for the customer who cannot remember which car they brought. */
checkinRouter.get(
  '/customer-lookup',
  requireAuth,
  requireRole(...BOARD_READ_ROLES),
  async (req: AuthedRequest, res) => {
    const q = CustomerLookupQuery.safeParse(req.query)
    if (!q.success) {
      const body: InvalidRequestError = {
        error: 'invalid_request',
        message: 'ข้อมูลที่กรอกไม่ครบหรือไม่ถูกต้อง',
        fields: fieldErrorsOf(q.error),
      }
      res.status(400).json(body)
      return
    }

    const match = await withShop(db, req.auth!.shop, async (trx) => {
      // A blocked number answers "not found" here, not just in the resolver.
      // If this returned a name, staff would accept the prefill and post an
      // explicit customerId, and the resolver would honour it — the guard has
      // to be on the screen's first question, not only its last.
      const found = await customersRepo.findByPhone(trx, req.auth!.shop, q.data.phone)
      if (found.kind !== 'one') return found
      // W4: held-deposit lookup by phone
      const result: CustomerLookupResult = {
        customerId: found.customer.id,
        name: found.customer.name,
        phone: found.customer.phone,
        vehicles: await customersRepo.vehiclesOf(trx, found.customer.id),
      }
      return { kind: 'one' as const, result }
    })

    // 'blocked' answers the same as 'none' here: from the counter's point of
    // view there is nobody to prefill from, and saying "this number is
    // blocklisted" would only invite arguing with it.
    if (match.kind === 'none' || match.kind === 'blocked') {
      res.status(404).json({ error: 'customer_not_found', message: 'ไม่พบลูกค้าเบอร์นี้' })
      return
    }
    if (match.kind === 'ambiguous') {
      // The same answer the resolver gives, so the screen has one branch to
      // handle rather than two — and prefilling the oldest of them would be
      // the exact guess this rule exists to prevent.
      // Same schema as the resolver's refusal (packages/contracts errors.ts),
      // built as an explicit id+name projection for the same reason.
      const body: CustomerAmbiguousError = {
        error: 'customer_ambiguous',
        message: 'เบอร์นี้มีลูกค้ามากกว่าหนึ่งราย กรุณาเลือกว่าเป็นรายไหน',
        candidates: match.candidates.map((c) => ({ id: c.id, name: c.name })),
      }
      res.status(409).json(body)
      return
    }
    res.json(match.result)
  },
)
