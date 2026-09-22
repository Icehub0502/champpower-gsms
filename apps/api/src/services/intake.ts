/**
 * Opening a job — the one implementation, used by both doors into the shop.
 *
 * A walk-in and a booked car are the same event: a car is in front of the
 * counter and a job has to open. The only difference is that the booked one
 * already has a row saying it was expected, and may already name the customer.
 * `POST /api/checkin` and `POST /api/bookings/:id/arrive` therefore both call
 * `openJob` and differ only in whether they pass a `bookingId` and what they
 * pass as fallbacks. Two code paths that both open a job will drift, and the
 * one that drifts is the one nobody is watching.
 *
 * `openJob` runs INSIDE a transaction the caller already owns, so arrival can
 * advance the booking and open the job atomically. It never opens its own.
 */
import type { ScopedTx } from '@gsms/db/client.js'
import { isQueueNoConflict } from '../lib/pgError.js'
import { bangkokToday } from '../lib/bangkokDate.js'
import * as customersRepo from '../repositories/customers.js'
import * as vehiclesRepo from '../repositories/vehicles.js'
import * as baysRepo from '../repositories/bays.js'
import * as jobsRepo from '../repositories/jobs.js'
import { writeAudit } from './audit.js'

const MAX_ATTEMPTS = 5

/**
 * The retry that exists because nothing pre-checks the queue number.
 *
 * `nextQueueNo` is `max(queue_no) + 1` read inside the transaction that then
 * inserts. Two check-ins a fraction of a second apart can both read 6 before
 * either commits; one of them loses `uq_queue_no` and that is correct — the
 * constraint, not the read, is what stops two cars answering to "6".
 *
 * A number the SERVER guessed is worth guessing again: retry, re-read the max,
 * insert. A number a PERSON typed is not — they meant that number, and the
 * honest answer is "คิว 6 มีรถคันอื่นแล้ว". Hence the `serverAllocated` flag.
 *
 * The retry wraps the WHOLE transaction rather than just the INSERT: a failed
 * statement aborts the PostgreSQL transaction it is in, so there is nothing
 * left to retry inside it. Bounded at five, because beyond that the shop is
 * under a load no garage generates and spinning is worse than a 409 the
 * counter can act on.
 */
export async function withQueueNoRetry<T>(
  serverAllocated: boolean,
  run: () => Promise<T>,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run()
    } catch (err) {
      if (serverAllocated && isQueueNoConflict(err) && attempt < MAX_ATTEMPTS) continue
      throw err
    }
  }
}

/**
 * Everything needed to open a job, with the caller's fallbacks already merged.
 *
 * The merge itself ("what was typed now wins, else what the booking holds")
 * belongs to the arrival route, which is the only caller that HAS a second
 * source. This function sees one flat set of facts.
 */
export interface OpenJobInput {
  shopId: string
  actorId: string | null
  /** Set only by the arrival path. `uq_jobs_booking` enforces at-most-one. */
  bookingId?: string | null | undefined
  source: 'walk_in' | 'booked'

  /** A car already on file. When set, the plate fields are not consulted. */
  vehicleId?: string | null | undefined
  /** A customer already on file, from the booking. */
  customerId?: string | null | undefined

  plate?: string | undefined
  customerName?: string | undefined
  customerPhone?: string | undefined
  brand?: string | undefined
  model?: string | undefined
  color?: string | undefined
  year?: string | undefined
  leadSource?: string | undefined

  /**
   * Set by a caller who has SEEN the `vehicle_owner_mismatch` refusal and
   * resent the same request deliberately. Never defaulted to true anywhere.
   */
  confirmOwnerChange?: boolean | undefined

  mileageInKm?: number | undefined
  queueNo?: number | undefined
  jobDate?: string | undefined
  symptom?: string | undefined
  bayId?: string | null | undefined
  photoFileIds?: string[] | undefined
}

export type OpenJobOutcome =
  | {
      kind: 'ok'
      jobId: string
      queueNo: number
      jobDate: string
      customerId: string
      vehicleId: string
    }
  | { kind: 'unknown_bay' }
  | { kind: 'unknown_file' }
  | Exclude<CarResolution, { kind: 'ok' }>

export async function openJob(
  trx: ScopedTx,
  input: OpenJobInput,
): Promise<OpenJobOutcome> {
  // A bay or a file id from another branch would pass the foreign key —
  // referential integrity runs with RLS bypassed — but cannot be seen from
  // inside this shop's transaction. These are authorisation checks, not race
  // pre-checks: nothing about them is decided by a constraint.
  if (input.bayId) {
    const bay = await baysRepo.findById(trx, input.bayId)
    if (!bay) return { kind: 'unknown_bay' }
  }
  const photoIds = input.photoFileIds ?? []
  if (photoIds.length > 0) {
    const known = await jobsRepo.existingFileIds(trx, photoIds)
    if (photoIds.some((id) => !known.has(id))) return { kind: 'unknown_file' }
  }

  const resolved = await resolveCar(trx, input)
  if (resolved.kind !== 'ok') return resolved

  const jobDate = input.jobDate ?? bangkokToday()
  const queueNo = input.queueNo ?? await jobsRepo.nextQueueNo(trx, input.shopId, jobDate)
  const jobNumber = await jobsRepo.allocateJobNumber(trx, input.shopId)

  const job = await jobsRepo.insertJob(trx, {
    shopId: input.shopId,
    jobNumber,
    jobDate,
    queueNo,
    customerId: resolved.customerId,
    vehicleId: resolved.vehicleId,
    bayId: input.bayId,
    mileageInKm: input.mileageInKm,
    bookingId: input.bookingId,
  })

  if (input.symptom) {
    await jobsRepo.addComplaint(trx, input.shopId, job.id, input.symptom)
  }
  await jobsRepo.attachPhotos(trx, input.shopId, job.id, photoIds)

  // Ids and operational values only — never the name, phone or plate sitting
  // in `input` right here (CLAUDE.md §12).
  await writeAudit(trx, {
    shopId: input.shopId,
    actorId: input.actorId,
    action: 'job_checked_in',
    entityType: 'jobs',
    entityId: job.id,
    before: null,
    after: {
      job_date: jobDate,
      queue_no: queueNo,
      bay_id: input.bayId ?? null,
      customer_id: resolved.customerId,
      vehicle_id: resolved.vehicleId,
      booking_id: input.bookingId ?? null,
      photo_count: photoIds.length,
      source: input.source,
    },
  })

  return {
    kind: 'ok',
    jobId: job.id,
    queueNo,
    jobDate,
    customerId: resolved.customerId,
    vehicleId: resolved.vehicleId,
  }
}

type CarResolution =
  | { kind: 'ok'; customerId: string; vehicleId: string }
  | { kind: 'vehicle_required' }
  | { kind: 'details_required'; fields: string[] }
  | { kind: 'customer_ambiguous'; candidates: customersRepo.CustomerCandidate[] }
  | {
      kind: 'vehicle_owner_mismatch'
      vehicleId: string
      currentOwner: customersRepo.CustomerCandidate
      /** `id` is null when the person described is not a customer yet. */
      newOwner: { id: string | null; name: string | null }
    }

/**
 * Find or create the customer and the car.
 *
 * `jobs.customer_id` and `jobs.vehicle_id` are NOT NULL, so this has to end
 * with both. The order matters: an existing plate brings its own customer,
 * which is how a returning customer avoids being created a second time under
 * a slightly different spelling of their name.
 */
async function resolveCar(trx: ScopedTx, input: OpenJobInput): Promise<CarResolution> {
  // ---------------------------------------------------------------------
  // 1. The car. The booking may already name it; otherwise the plate does.
  // ---------------------------------------------------------------------
  let vehicle = input.vehicleId
    // Invisible here means it belongs to another branch, or to nobody.
    ? await vehiclesRepo.findById(trx, input.vehicleId)
    : undefined
  if (!vehicle && input.plate) {
    // Matched on plate_key, so spacing and punctuation do not matter — and
    // never matched at all if the plate is a known placeholder like 1กก1111.
    vehicle = await vehiclesRepo.findByPlate(trx, input.plate)
  }
  // Nothing to go on. This is the phone booking that arrives knowing only a
  // name and a number; the counter has to type the plate.
  if (!vehicle && !input.plate) return { kind: 'vehicle_required' }

  // ---------------------------------------------------------------------
  // 2. The customer the CALLER named — explicitly, or via their phone.
  //    Resolved even when the car is already known, because comparing the two
  //    is the whole of the owner-mismatch check below.
  // ---------------------------------------------------------------------
  let namedCustomerId = input.customerId ?? null
  // Did the caller give a phone number that actually carries information? A
  // placeholder does not, and neither does a blank. This is what separates
  // "someone new is standing here" from "staff typed 0999999999 again".
  let phoneIsEvidence = false
  if (!namedCustomerId && input.customerPhone) {
    const match = await customersRepo.findByPhone(trx, input.shopId, input.customerPhone)
    if (match.kind === 'ambiguous') {
      // Never the oldest, never the first. The counter is looking at the
      // person; the server is looking at two identical rows.
      return { kind: 'customer_ambiguous', candidates: match.candidates }
    }
    if (match.kind === 'one') namedCustomerId = match.customer.id
    // A real number nobody holds yet: this is a person not on file. Below,
    // that is enough to contradict a car's recorded owner.
    phoneIsEvidence = match.kind === 'one' || match.kind === 'none'
  }

  // ---------------------------------------------------------------------
  // 3. The car is on file. Does the caller agree about who owns it?
  // ---------------------------------------------------------------------
  if (vehicle) {
    const owner = vehicle.customer_id
    const ownerRow = await customersRepo.findById(trx, owner)

    /*
     * Two ways the caller can be describing somebody other than the owner —
     * and the second one is easy to miss, which is exactly how a silent merge
     * gets through:
     *
     *   a) they named a DIFFERENT customer who is already on file.
     *   b) they gave a real phone number that is not the owner's. The person
     *      it belongs to may not exist as a row yet — a car sold to someone
     *      who has never been here — and treating "no customer found" as "no
     *      disagreement" would open the job under the previous owner without
     *      a word. That is the whole failure this rule exists to stop, just
     *      reached from the other side.
     *
     * Deliberately NOT a signal: the customer's NAME. Thai names duplicate
     * heavily — the production dump has 50 groups of customers sharing one
     * (IMPORT-FINDINGS.md §5, "ห้ามใช้ชื่อเป็นกุญแจจับคู่เด็ดขาด") — so a
     * spelling variant would raise this refusal on every second visit until
     * staff learned to click through it without reading, which is worse than
     * not asking.
     *
     * Also not a signal: a phone the owner has never given us. An owner row
     * with no phone cannot contradict anything, and refusing there would
     * interrupt the ordinary case of finally recording someone's number.
     */
    const ownerPhone = customersRepo.normalisePhone(ownerRow?.phone ?? '')
    const givenPhone = customersRepo.normalisePhone(input.customerPhone ?? '')
    const contradictedById = namedCustomerId !== null && namedCustomerId !== owner
    const contradictedByPhone = !namedCustomerId
      && phoneIsEvidence
      && ownerPhone.length > 0
      && givenPhone !== ownerPhone

    if (!contradictedById && !contradictedByPhone) {
      return { kind: 'ok', customerId: namedCustomerId ?? owner, vehicleId: vehicle.id }
    }

    // A car sold on, or a relative bringing it in — routine at a garage, and
    // precisely why it must never happen silently: moving the car pours one
    // customer's repair history into another's, and there is no way back once
    // a few visits have piled up on top. Two seconds of interruption is the
    // cheaper side of that trade by a wide margin.
    if (!input.confirmOwnerChange) {
      const newOwner = namedCustomerId ? await customersRepo.findById(trx, namedCustomerId) : undefined
      return {
        kind: 'vehicle_owner_mismatch',
        vehicleId: vehicle.id,
        // Names, so the counter can see WHO it is about to move the car to
        // rather than comparing two uuids. This is a response to a person at
        // a desk, not a log line — §12 forbids the latter, not the former.
        currentOwner: { id: owner, name: ownerRow?.name ?? null },
        // A null id means "the person you described is not on file yet"; the
        // confirmation below is what creates them.
        newOwner: {
          id: namedCustomerId,
          name: newOwner?.name ?? input.customerName ?? null,
        },
      }
    }

    // Confirmed. If the new owner does not exist yet, they do now.
    let newOwnerId = namedCustomerId
    if (!newOwnerId) {
      if (!input.customerName) return { kind: 'details_required', fields: ['customerName'] }
      const created = await customersRepo.create(trx, {
        shopId: input.shopId,
        name: input.customerName,
        phone: input.customerPhone,
        leadSource: input.leadSource,
      })
      newOwnerId = created.id
    }

    await vehiclesRepo.changeOwner(trx, vehicle.id, newOwnerId)
    // Ids only here. Who moved which car to whom, and when — enough to
    // reconstruct it, with no personal data in the log.
    await writeAudit(trx, {
      shopId: input.shopId,
      actorId: input.actorId,
      action: 'vehicle_owner_changed',
      entityType: 'vehicles',
      entityId: vehicle.id,
      before: { customer_id: owner },
      after: { customer_id: newOwnerId, confirmed: true },
    })
    return { kind: 'ok', customerId: newOwnerId, vehicleId: vehicle.id }
  }

  // ---------------------------------------------------------------------
  // 4. A car nobody has seen before. brand and model are NOT NULL and a
  //    customer needs a name, so anything still missing has to be asked for
  //    rather than invented — a placeholder here is a row someone has to
  //    correct later, and nobody ever does.
  // ---------------------------------------------------------------------
  const missing: string[] = []
  if (!input.brand) missing.push('brand')
  if (!input.model) missing.push('model')
  if (!namedCustomerId && !input.customerName) missing.push('customerName')
  if (missing.length > 0) return { kind: 'details_required', fields: missing }

  let customerId = namedCustomerId
  if (!customerId) {
    const customer = await customersRepo.create(trx, {
      shopId: input.shopId,
      name: input.customerName!,
      phone: input.customerPhone,
      // Recorded once, on the first visit only — CLAUDE.md §5.7 item 2. An
      // existing customer keeps the answer they gave then.
      leadSource: input.leadSource,
    })
    customerId = customer.id
  }

  // W4: held-deposit lookup by phone

  const created = await vehiclesRepo.create(trx, {
    shopId: input.shopId,
    customerId,
    plate: input.plate!,
    brand: input.brand!,
    model: input.model!,
    color: input.color,
    year: input.year,
  })
  return { kind: 'ok', customerId, vehicleId: created.id }
}
