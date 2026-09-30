// The refusals the check-in and arrival doors can answer with — as schemas the
// screen can parse.
//
// Why these exist: the bodies carry data the counter needs to recover — the
// customers to choose between, the two owners of a car, which fields are
// missing, which queue number was taken. CLAUDE.md §2 forbids apps/web from
// declaring API types itself, so until these shapes live here the screen could
// only guess at them. The API BUILDS each body through the type inferred below
// (apps/api/src/routes/queue.ts sendIntakeOutcome, lib/pgError.ts), and a
// tier-2 test parses the real HTTP body against each schema, so the two cannot
// drift apart.
//
// Every object is .strict(): a field that is not listed here is a PARSE FAILURE,
// not something passed along quietly. That is deliberate for the two that name
// people. A candidate carries an id and a name — no phone, no address — and an
// owner carries an id and a name, nothing more; if anyone ever adds a phone to
// either on the server, the screen's safeParse fails and the field never reaches
// the page. The screen must treat a body that does not parse as an unknown
// error, never trust part of it (docs/WORK-ORDERS gsms-lead ruling, 25 Sep 2026).
//
// Each follows the house ApiError shape (common.ts): `error` is the snake_case
// code — a LITERAL here, so it discriminates — `message` is Thai for the
// counter, plus the refusal's own fields.

import { z } from 'zod';

const uuid = z.string().uuid();

/** A customer the counter may pick when a phone number matches several. Id and name ONLY. */
export const CustomerCandidate = z
  .object({
    id: uuid,
    name: z.string().nullable(),
  })
  .strict();
export type CustomerCandidate = z.infer<typeof CustomerCandidate>;

// 409 — two or three customers share this phone number and the server will not
// guess which one is at the counter. Resend with `customerId`. (Four or more is
// a placeholder number: never asked, always a new customer — see the blocklist.)
export const CustomerAmbiguousError = z
  .object({
    error: z.literal('customer_ambiguous'),
    message: z.string(),
    candidates: z.array(CustomerCandidate).min(2),
  })
  .strict();
export type CustomerAmbiguousError = z.infer<typeof CustomerAmbiguousError>;

// 409 — this plate is on file against a different customer. Moving it pours one
// person's repair history into another's, so it takes a deliberate second
// request with `confirmOwnerChange: true`. Names only, so the counter can see
// WHO it is about to move the car to.
export const VehicleOwnerMismatchError = z
  .object({
    error: z.literal('vehicle_owner_mismatch'),
    message: z.string(),
    vehicleId: uuid,
    currentOwner: z.object({ id: uuid, name: z.string().nullable() }).strict(),
    // `id` null = the person described is not a customer yet; confirming creates them.
    newOwner: z.object({ id: uuid.nullable(), name: z.string().nullable() }).strict(),
  })
  .strict();
export type VehicleOwnerMismatchError = z.infer<typeof VehicleOwnerMismatchError>;

/**
 * A car the counter may pick when a plate matches more than one. Vehicle facts
 * ONLY — no owner, no phone: brand, model, colour and province are what tell
 * two cars with one plate apart at the counter, and a customer's name has no
 * business in a response about which car this is.
 */
export const VehicleCandidate = z
  .object({
    id: uuid,
    // null = on file without a province (entered before province was required).
    province: z.string().nullable(),
    brand: z.string(),
    model: z.string(),
    color: z.string().nullable(),
  })
  .strict();
export type VehicleCandidate = z.infer<typeof VehicleCandidate>;

// 409 — this plate matches more than one car the server cannot choose between:
// on file in several provinces and none was given, or the province given
// matches no car exactly but cars with an unknown province could be this one.
// Resend with `province`, with `vehicleId` (one of these), or with
// `confirmNewVehicle: true` ("none of these").
export const VehicleAmbiguousError = z
  .object({
    error: z.literal('vehicle_ambiguous'),
    message: z.string(),
    candidates: z.array(VehicleCandidate).min(1),
  })
  .strict();
export type VehicleAmbiguousError = z.infer<typeof VehicleAmbiguousError>;

/** The fields a brand-new car cannot be created without. */
export const IntakeRequiredField = z.enum(['brand', 'model', 'province', 'customerName']);
export type IntakeRequiredField = z.infer<typeof IntakeRequiredField>;

// 409 — a plate nobody has seen before, but not enough to create the car.
// `fields` names each missing one, in the ApiError `fields` shape.
export const IntakeDetailsRequiredError = z
  .object({
    error: z.literal('intake_details_required'),
    message: z.string(),
    fields: z
      .object({
        brand: z.array(z.string()).optional(),
        model: z.array(z.string()).optional(),
        province: z.array(z.string()).optional(),
        customerName: z.array(z.string()).optional(),
      })
      .strict(),
  })
  .strict();
export type IntakeDetailsRequiredError = z.infer<typeof IntakeDetailsRequiredError>;

// 409 — no vehicle on the booking and no plate typed. The counter has to type the plate.
export const VehicleRequiredError = z
  .object({
    error: z.literal('vehicle_required'),
    message: z.string(),
  })
  .strict();
export type VehicleRequiredError = z.infer<typeof VehicleRequiredError>;

// 409 — a queue number a PERSON typed is already taken for that day. `queueNo`
// is the number that was refused, as data, so the screen need not parse it out
// of the message. null only if the server could not attribute it to a typed
// number (the message then reads without one).
export const QueueNoTakenError = z
  .object({
    error: z.literal('queue_no_taken'),
    message: z.string(),
    queueNo: z.number().int().min(1).nullable(),
  })
  .strict();
export type QueueNoTakenError = z.infer<typeof QueueNoTakenError>;

// -----------------------------------------------------------------------------
// The payload-less refusals
// -----------------------------------------------------------------------------
// Each carries only its code and a Thai message. They are schemas all the same,
// because the screen maps every code to its own guidance, and a code it cannot
// parse falls back to "unknown error" — the one answer that tells the person at
// the counter nothing (code review, 26 Sep 2026: before these existed, seven
// codes the check-in and arrival doors really send had no schema).

function payloadless<const C extends string>(code: C) {
  return z.object({ error: z.literal(code), message: z.string() }).strict();
}

// 400 — the bay picked is not one of this shop's active bays.
export const UnknownBayError = payloadless('unknown_bay');
export type UnknownBayError = z.infer<typeof UnknownBayError>;

// 400 — a photo id sent with the check-in is not a file of this shop.
export const UnknownFileError = payloadless('unknown_file');
export type UnknownFileError = z.infer<typeof UnknownFileError>;

// 400 — a picked `vehicleId` (answering vehicle_ambiguous) this shop cannot
// see. The SAME answer whether the id does not exist or is another branch's
// car, so the response never reveals that a car exists elsewhere.
export const UnknownVehicleError = payloadless('unknown_vehicle');
export type UnknownVehicleError = z.infer<typeof UnknownVehicleError>;

// 409 — the picked `vehicleId` is a car with a different plate from the one
// typed. A stale form or a wrong pick; nothing is written to either car.
export const VehiclePlateMismatchError = payloadless('vehicle_plate_mismatch');
export type VehiclePlateMismatchError = z.infer<typeof VehiclePlateMismatchError>;

// 404 — no such booking in this shop.
export const BookingNotFoundError = payloadless('booking_not_found');
export type BookingNotFoundError = z.infer<typeof BookingNotFoundError>;

// 409 — this booking already became a job (a second "รถมาถึงแล้ว" on the same
// booking). Nothing to fix: the car is already on the board.
export const BookingAlreadyArrivedError = payloadless('booking_already_arrived');
export type BookingAlreadyArrivedError = z.infer<typeof BookingAlreadyArrivedError>;

// 409 — the booking is no longer open (cancelled, or marked no-show), so it
// cannot arrive. The message names the status it is in.
export const BookingNotOpenError = payloadless('booking_not_open');
export type BookingNotOpenError = z.infer<typeof BookingNotOpenError>;

// 500 — the shop has no JOB document series, so no job number can be issued.
// A setup fault, not something the counter can fix by retyping.
export const JobNumberSeriesMissingError = payloadless('job_number_series_missing');
export type JobNumberSeriesMissingError = z.infer<typeof JobNumberSeriesMissingError>;

// 400 — the request itself did not validate. `fields` (field name -> messages)
// is present when the failing fields are known; the screen shows them against
// the fields.
export const InvalidRequestError = z
  .object({
    error: z.literal('invalid_request'),
    message: z.string(),
    fields: z.record(z.array(z.string())).optional(),
  })
  .strict();
export type InvalidRequestError = z.infer<typeof InvalidRequestError>;

/**
 * Every refusal the check-in and arrival doors can answer with, discriminated
 * on `error`. If a door starts sending a code that is not in this list, add a
 * schema here first — a code outside the union is exactly the "unknown error"
 * the screen cannot help anyone with.
 */
export const IntakeRefusal = z.discriminatedUnion('error', [
  CustomerAmbiguousError,
  VehicleOwnerMismatchError,
  VehicleAmbiguousError,
  IntakeDetailsRequiredError,
  VehicleRequiredError,
  QueueNoTakenError,
  UnknownBayError,
  UnknownFileError,
  UnknownVehicleError,
  VehiclePlateMismatchError,
  BookingNotFoundError,
  BookingAlreadyArrivedError,
  BookingNotOpenError,
  JobNumberSeriesMissingError,
  InvalidRequestError,
]);
export type IntakeRefusal = z.infer<typeof IntakeRefusal>;
