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
import type { IntakeRequiredField } from '@gsms/contracts/index.js'
import { isQueueNoConflict } from '../lib/pgError.js'
import { bangkokToday } from '../lib/bangkokDate.js'
import * as customersRepo from '../repositories/customers.js'
import * as vehiclesRepo from '../repositories/vehicles.js'
import * as baysRepo from '../repositories/bays.js'
import * as jobsRepo from '../repositories/jobs.js'
import { writeAudit } from './audit.js'

const MAX_ATTEMPTS = 5

/**
 * The retry for the ONE collision the queue lock cannot prevent.
 *
 * It used to be the whole concurrency strategy: an optimistic max+1, raced and
 * retried up to five times. That starved — the last of N simultaneous
 * check-ins needed up to N rounds — and told staff a number was taken when
 * nobody had typed it. Opening a job now takes lockQueueDay() first, so two
 * check-ins for the same (shop, day) no longer race at all.
 *
 * What is left is a write that does NOT take that lock: a person renumbering
 * a car through PATCH /jobs/:id/queue-no onto exactly the number a check-in
 * is allocating at the same moment. Rare, but real — so a number the SERVER
 * chose is still re-chosen if uq_queue_no refuses it. A number a PERSON typed
 * is never retried: they meant it, and the honest answer is
 * "คิว 6 มีรถคันอื่นแล้ว". Hence the `serverAllocated` flag.
 *
 * The retry wraps the WHOLE transaction, not just the INSERT: a failed
 * statement aborts the PostgreSQL transaction it is in, so there is nothing
 * left to retry inside it. Five attempts is now far more than the one
 * remaining case can need.
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

  /**
   * The car the BOOKING names. Consulted before the plate; the plate typed at
   * arrival only decides whether an empty province may be filled onto it.
   */
  vehicleId?: string | null | undefined
  /**
   * A car the COUNTER picked, answering vehicle_ambiguous. Wins over the
   * booking's car. Must be visible to this shop (else unknown_vehicle) and,
   * when a plate is typed, carry that plate (else vehicle_plate_mismatch).
   */
  pickedVehicleId?: string | undefined
  /** A customer already on file, from the booking. */
  customerId?: string | null | undefined

  plate?: string | undefined
  customerName?: string | undefined
  customerPhone?: string | undefined
  brand?: string | undefined
  model?: string | undefined
  color?: string | undefined
  year?: string | undefined
  /**
   * A plate area — one of PLATE_AREAS, the 77 provinces plus เบตง; the contract
   * refuses anything else. Part of how the car is FOUND —
   * vehiclesRepo.choosePlateMatch — and required to CREATE one. A car
   * already on file never has its province rewritten; one with NO province
   * gets this one, with a `vehicle_province_filled` audit row.
   */
  province?: string | undefined
  /** Answers `vehicle_ambiguous` with "none of those, a new car". Never defaulted. */
  confirmNewVehicle?: boolean | undefined
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
  // Serialise every job opening for this (shop, day) — see lockQueueDay() for
  // why the lock exists alongside uq_queue_no.
  //
  // Taken on BOTH paths, typed and server-allocated. Be precise about who that
  // helps, because an earlier comment here got it wrong (code review): it helps
  // SERVER allocation. With every opening serialised, a server-chosen max+1 can
  // never collide with a typed number being inserted at the same instant, so
  // the server path never needs its retry. It does NOT, and cannot, protect a
  // TYPED number: if a person types exactly the number the server would pick
  // next, whichever opening runs first takes it, and if the server went first
  // the typed request gets a 409 — which is correct, because the number really
  // is taken. The lock decides the order; it does not make a collision vanish.
  await jobsRepo.lockQueueDay(trx, input.shopId, jobDate)
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
  // Typed to the contract's IntakeRequiredField, so this service cannot name
  // a missing field the error schema does not know.
  | { kind: 'details_required'; fields: IntakeRequiredField[] }
  | { kind: 'customer_ambiguous'; candidates: customersRepo.CustomerCandidate[] }
  | { kind: 'vehicle_ambiguous'; candidates: vehiclesRepo.VehicleRow[] }
  /** A picked vehicleId this shop cannot see — nonexistent or another branch's, alike. */
  | { kind: 'unknown_vehicle' }
  /** A picked vehicleId whose plate is not the plate typed. */
  | { kind: 'vehicle_plate_mismatch' }
  | {
      kind: 'vehicle_owner_mismatch'
      vehicleId: string
      currentOwner: customersRepo.CustomerCandidate
      /** `id` is null when the person described is not a customer yet. */
      newOwner: { id: string | null; name: string | null }
    }

/**
 * How many times resolveCar may start over after losing a province fill to a
 * concurrent check-in. Each restart sees the car WITH the other request's
 * province, which makes it a different car or no candidate at all, so one
 * restart settles it; the bound is only there so a bug cannot loop.
 */
const MAX_RESOLVE_ATTEMPTS = 3

/**
 * Find or create the customer and the car.
 *
 * `jobs.customer_id` and `jobs.vehicle_id` are NOT NULL, so this has to end
 * with both. The order matters: an existing plate brings its own customer,
 * which is how a returning customer avoids being created a second time under
 * a slightly different spelling of their name.
 *
 * Nothing is written until every refusal has been decided. The walk-in door
 * COMMITS when it returns a refusal (only arrival rolls back), so a write
 * made before a refusal would outlive the refusal it came with.
 */
async function resolveCar(
  trx: ScopedTx,
  input: OpenJobInput,
  attempt = 1,
): Promise<CarResolution> {
  // ---------------------------------------------------------------------
  // 1. The car: picked by the counter, named by the booking, or by the plate.
  // ---------------------------------------------------------------------
  let vehicle: vehiclesRepo.VehicleRow | undefined
  // The province the car will carry once this job opens, when it has none on
  // file. Only ever the province typed NOW, only onto an empty one.
  let fillProvince: string | null = null
  const typedKey = input.plate ? vehiclesRepo.plateKeyOf(input.plate) : null
  const plateAgrees = (v: vehiclesRepo.VehicleRow) =>
    typedKey === null || vehiclesRepo.plateKeyOf(v.plate) === typedKey

  if (input.pickedVehicleId) {
    // The counter answered vehicle_ambiguous by picking one. An id this shop
    // cannot see gets ONE answer whether it does not exist or belongs to
    // another branch — never a fallback to the plate, which used to create a
    // new car silently and would differ between the two cases.
    vehicle = await vehiclesRepo.findById(trx, input.shopId, input.pickedVehicleId)
    if (!vehicle) return { kind: 'unknown_vehicle' }
    // A stale form, or an id pasted from another car: the plate on the form
    // and the car picked must be the same car before anything is written to it.
    if (!plateAgrees(vehicle)) return { kind: 'vehicle_plate_mismatch' }
    if (vehicle.province === null && input.province) fillProvince = input.province
  } else if (input.vehicleId) {
    // The booking's own car. The booking row is this shop's, so this is found
    // unless the car was removed; then the plate decides, as before.
    vehicle = await vehiclesRepo.findById(trx, input.shopId, input.vehicleId)
    // Fill only when what was typed is this car's plate — a different plate
    // typed at arrival says nothing about where THIS car is registered.
    if (vehicle && vehicle.province === null && input.province && plateAgrees(vehicle)) {
      fillProvince = input.province
    }
  }
  if (!vehicle && input.plate) {
    // Matched on (plate_key, province), so spacing and punctuation do not
    // matter — and never matched at all if the plate is in this shop's
    // match_blocklist. Never a guess between two cars: see choosePlateMatch.
    const match = vehiclesRepo.choosePlateMatch(
      await vehiclesRepo.candidatesByPlate(trx, input.shopId, input.plate, input.province),
      input.province,
      { confirmNewVehicle: input.confirmNewVehicle },
    )
    if (match.kind === 'ambiguous') return { kind: 'vehicle_ambiguous', candidates: match.candidates }
    if (match.kind === 'one') {
      vehicle = match.vehicle
      fillProvince = match.fillProvince
    }
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

  // A booking made for one car, arriving with a DIFFERENT car the counter
  // picked, when nothing else says who is standing there (no customer on the
  // booking, no phone anywhere). The booked car's owner is then the only
  // evidence of who the booking is for, so it stands in as the named
  // customer: if the picked car belongs to somebody else, the ordinary
  // owner-mismatch refusal below fires instead of the car being switched
  // silently (security review, 30 Sep 2026).
  if (
    !namedCustomerId && !phoneIsEvidence
    && input.pickedVehicleId && input.vehicleId && input.pickedVehicleId !== input.vehicleId
  ) {
    const booked = await vehiclesRepo.findById(trx, input.shopId, input.vehicleId)
    if (booked) namedCustomerId = booked.customer_id
  }

  // ---------------------------------------------------------------------
  // 3. The car is on file. Does the caller agree about who owns it?
  // ---------------------------------------------------------------------
  if (vehicle) {
    const found = vehicle
    const owner = found.customer_id
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
    const contradicted = contradictedById || contradictedByPhone

    // A car sold on, or a relative bringing it in — routine at a garage, and
    // precisely why it must never happen silently: moving the car pours one
    // customer's repair history into another's, and there is no way back once
    // a few visits have piled up on top. Two seconds of interruption is the
    // cheaper side of that trade by a wide margin.
    if (contradicted && !input.confirmOwnerChange) {
      const newOwner = namedCustomerId ? await customersRepo.findById(trx, namedCustomerId) : undefined
      return {
        kind: 'vehicle_owner_mismatch',
        vehicleId: found.id,
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
    // The last refusal on this path, decided before anything is written.
    if (contradicted && !namedCustomerId && !input.customerName) {
      return { kind: 'details_required', fields: ['customerName'] }
    }

    // ----- Every refusal is behind us. Writes start here. -----

    if (fillProvince) {
      if (await vehiclesRepo.fillProvince(trx, input.shopId, found.id, fillProvince)) {
        await writeAudit(trx, {
          shopId: input.shopId,
          actorId: input.actorId,
          action: 'vehicle_province_filled',
          entityType: 'vehicles',
          entityId: found.id,
          before: { province: null },
          after: { province: fillProvince },
        })
      } else {
        // 0 rows: a concurrent check-in gave this car a province between our
        // read and our write (the UPDATE waited on its row lock, then found
        // province no longer NULL). If it wrote the same province, this is
        // still the car. If it wrote another, this car is — by the owner's
        // rule — a different car from the one at the counter, so start over
        // and let the plate match decide again. Nothing has been written yet.
        const now = await vehiclesRepo.findById(trx, input.shopId, found.id)
        if (now?.province !== fillProvince) {
          if (attempt >= MAX_RESOLVE_ATTEMPTS) throw new Error('resolveCar: province fill kept losing races')
          return resolveCar(trx, input, attempt + 1)
        }
      }
    }

    if (!contradicted) {
      return { kind: 'ok', customerId: namedCustomerId ?? owner, vehicleId: found.id }
    }

    // Confirmed. If the new owner does not exist yet, they do now.
    let newOwnerId = namedCustomerId
    if (!newOwnerId) {
      const created = await customersRepo.create(trx, {
        shopId: input.shopId,
        name: input.customerName!,
        phone: input.customerPhone,
        leadSource: input.leadSource,
      })
      newOwnerId = created.id
    }

    await vehiclesRepo.changeOwner(trx, input.shopId, found.id, newOwnerId)
    // Ids only here. Who moved which car to whom, and when — enough to
    // reconstruct it, with no personal data in the log.
    await writeAudit(trx, {
      shopId: input.shopId,
      actorId: input.actorId,
      action: 'vehicle_owner_changed',
      entityType: 'vehicles',
      entityId: found.id,
      before: { customer_id: owner },
      after: { customer_id: newOwnerId, confirmed: true },
    })
    return { kind: 'ok', customerId: newOwnerId, vehicleId: found.id }
  }

  // ---------------------------------------------------------------------
  // 4. A car nobody has seen before. brand and model are NOT NULL and a
  //    customer needs a name, so anything still missing has to be asked for
  //    rather than invented — a placeholder here is a row someone has to
  //    correct later, and nobody ever does.
  // ---------------------------------------------------------------------
  const missing: IntakeRequiredField[] = []
  if (!input.brand) missing.push('brand')
  if (!input.model) missing.push('model')
  // Required because the car is FOUND by it next time. A car created without
  // one is exactly the empty-province row that makes a later plate ambiguous.
  if (!input.province) missing.push('province')
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
    province: input.province,
  })
  return { kind: 'ok', customerId, vehicleId: created.id }
}
