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

// 409 — the database refused to change a numbered document (SQLSTATE GS002,
// table documents): it is issued/signed/superseded/void and the change is not
// one the lifecycle allows. The fix is a new revision or a void, never a retry.
export const DocumentFrozenError = payloadless('document_frozen');
export type DocumentFrozenError = z.infer<typeof DocumentFrozenError>;

// 409 — same refusal for a LINE of a numbered document (SQLSTATE GS002, table
// document_lines): the line's content is locked, or its document no longer
// accepts line changes at all.
export const DocumentLineFrozenError = payloadless('document_line_frozen');
export type DocumentLineFrozenError = z.infer<typeof DocumentLineFrozenError>;

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

// =============================================================================
// Quotation, catalog and pricing refusals (P3.1)
// =============================================================================
// Same rules as above: strict, `error` is a literal code, `message` is Thai for
// the counter. Bodies with data carry only what the screen needs to recover.
// 400 validation failures use InvalidRequestError (fields, never an echo of
// the input); the codes below are the state conflicts (409), business rules
// (422) and missing things (404).

export const QuotationNotFoundError = payloadless('quotation_not_found');
export type QuotationNotFoundError = z.infer<typeof QuotationNotFoundError>;

export const QuotationLineNotFoundError = payloadless('quotation_line_not_found');
export type QuotationLineNotFoundError = z.infer<typeof QuotationLineNotFoundError>;

export const JobNotFoundError = payloadless('job_not_found');
export type JobNotFoundError = z.infer<typeof JobNotFoundError>;

export const CatalogItemNotFoundError = payloadless('catalog_item_not_found');
export type CatalogItemNotFoundError = z.infer<typeof CatalogItemNotFoundError>;

export const VehicleModelNotFoundError = payloadless('vehicle_model_not_found');
export type VehicleModelNotFoundError = z.infer<typeof VehicleModelNotFoundError>;

export const OfferedItemNotFoundError = payloadless('offered_item_not_found');
export type OfferedItemNotFoundError = z.infer<typeof OfferedItemNotFoundError>;

// 403 — the role may not do this (void, fix a price, merge...). Never says who may.
export const ForbiddenError = payloadless('forbidden');
export type ForbiddenError = z.infer<typeof ForbiddenError>;

// 409 — the job already has a live quotation (draft / issued / signed).
export const QuotationExistsError = payloadless('quotation_exists');
export type QuotationExistsError = z.infer<typeof QuotationExistsError>;

// 409 — a draft-only action on a quotation that is not a draft (the content
// is locked once a number is allocated; also the answer to GS002).
export const QuotationNotDraftError = payloadless('quotation_not_draft');
export type QuotationNotDraftError = z.infer<typeof QuotationNotDraftError>;

// 409 — a decision on a quotation that is not 'issued'.
export const QuotationNotIssuedError = payloadless('quotation_not_issued');
export type QuotationNotIssuedError = z.infer<typeof QuotationNotIssuedError>;

// 409 — the quotation is frozen: confirmed, superseded or void. Revise instead.
export const QuotationFrozenError = payloadless('quotation_frozen');
export type QuotationFrozenError = z.infer<typeof QuotationFrozenError>;

// 409 — nothing to issue.
export const QuotationEmptyError = payloadless('quotation_empty');
export type QuotationEmptyError = z.infer<typeof QuotationEmptyError>;

// 409 — confirm needs every top-level line decided. Names the ones that are not.
export const DecisionsIncompleteError = z
  .object({
    error: z.literal('decisions_incomplete'),
    message: z.string(),
    lineIds: z.array(uuid).min(1),
  })
  .strict();
export type DecisionsIncompleteError = z.infer<typeof DecisionsIncompleteError>;

// 409 — a set had pieces cut and has no agreed amount yet (D10).
export const SetAmountRequiredError = z
  .object({
    error: z.literal('set_amount_required'),
    message: z.string(),
    lineIds: z.array(uuid).min(1),
  })
  .strict();
export type SetAmountRequiredError = z.infer<typeof SetAmountRequiredError>;

// 422 — an agreed amount above 2x the offer (almost certainly a typo). Revise instead.
export const ApprovedAmountTooHighError = z
  .object({
    error: z.literal('amount_over_2x'),
    message: z.string(),
    lineId: uuid,
    offered: z.string(),
    max: z.string(),
  })
  .strict();
export type ApprovedAmountTooHighError = z.infer<typeof ApprovedAmountTooHighError>;

// 422 — the set was offered at 0 (free); an agreed amount above 0 would be a
// repricing, which needs a new revision. Own code so the screen does not say "typo".
export const ApprovedAmountAboveFreeSetError = z
  .object({
    error: z.literal('amount_above_offer_free_set'),
    message: z.string(),
    lineId: uuid,
  })
  .strict();
export type ApprovedAmountAboveFreeSetError = z.infer<typeof ApprovedAmountAboveFreeSetError>;

// 400 — approved_amount sent for a line that is not a cut set.
export const ApprovedAmountNotAllowedError = z
  .object({
    error: z.literal('approved_amount_not_allowed'),
    message: z.string(),
    lineId: uuid,
  })
  .strict();
export type ApprovedAmountNotAllowedError = z.infer<typeof ApprovedAmountNotAllowedError>;

// 409 — undo-confirm after the Bangkok day ended.
export const UndoDifferentDayError = payloadless('undo_confirm_different_day');
export type UndoDifferentDayError = z.infer<typeof UndoDifferentDayError>;

// 409 — undo-confirm after the job moved past 'approved'.
export const UndoJobMovedOnError = payloadless('undo_confirm_job_moved_on');
export type UndoJobMovedOnError = z.infer<typeof UndoJobMovedOnError>;

// 409 — the job cannot go approved -> quoted while its quotation is confirmed.
export const QuotationConfirmedError = payloadless('quotation_confirmed');
export type QuotationConfirmedError = z.infer<typeof QuotationConfirmedError>;

// 409 — someone set the first price before you. Carries the price that stands.
export const PriceAlreadySetError = z
  .object({
    error: z.literal('price_already_set'),
    message: z.string(),
    existingPrice: z.string(),
    scope: z.enum(['model', 'base']),
  })
  .strict();
export type PriceAlreadySetError = z.infer<typeof PriceAlreadySetError>;

// 409 — an item with a similar name exists in the category. Id, name, category only.
export const SimilarItemFoundError = z
  .object({
    error: z.literal('similar_item_found'),
    message: z.string(),
    similar: z
      .array(z.object({ id: uuid, category: z.string(), name: z.string() }).strict())
      .min(1)
      .max(10),
  })
  .strict();
export type SimilarItemFoundError = z.infer<typeof SimilarItemFoundError>;

// 409 — an item with exactly this name already exists in the category.
export const CatalogItemExistsError = z
  .object({ error: z.literal('catalog_item_exists'), message: z.string(), itemId: uuid })
  .strict();
export type CatalogItemExistsError = z.infer<typeof CatalogItemExistsError>;

// 409 — merging would make a loop, or merge an item into itself / an already merged item.
export const MergeNotAllowedError = payloadless('merge_not_allowed');
export type MergeNotAllowedError = z.infer<typeof MergeNotAllowedError>;

// 409 — both items have a price for these models; the manager must choose.
export const MergePriceConflictError = z
  .object({
    error: z.literal('merge_price_conflict'),
    message: z.string(),
    vehicleModelIds: z.array(uuid).min(1),
  })
  .strict();
export type MergePriceConflictError = z.infer<typeof MergePriceConflictError>;

// 409 — this brand + model is already in the controlled list.
export const VehicleModelExistsError = z
  .object({ error: z.literal('vehicle_model_exists'), message: z.string(), vehicleModelId: uuid })
  .strict();
export type VehicleModelExistsError = z.infer<typeof VehicleModelExistsError>;

/** Every refusal the quotation / catalog doors can answer with. */
export const QuotationRefusal = z.discriminatedUnion('error', [
  QuotationNotFoundError,
  QuotationLineNotFoundError,
  JobNotFoundError,
  CatalogItemNotFoundError,
  VehicleModelNotFoundError,
  OfferedItemNotFoundError,
  ForbiddenError,
  QuotationExistsError,
  QuotationNotDraftError,
  QuotationNotIssuedError,
  QuotationFrozenError,
  QuotationEmptyError,
  DecisionsIncompleteError,
  SetAmountRequiredError,
  ApprovedAmountTooHighError,
  ApprovedAmountAboveFreeSetError,
  ApprovedAmountNotAllowedError,
  UndoDifferentDayError,
  UndoJobMovedOnError,
  QuotationConfirmedError,
  PriceAlreadySetError,
  SimilarItemFoundError,
  CatalogItemExistsError,
  MergeNotAllowedError,
  MergePriceConflictError,
  VehicleModelExistsError,
  InvalidRequestError,
]);
export type QuotationRefusal = z.infer<typeof QuotationRefusal>;

// 409 — the shop has no active QUO (quotation) document series, so no number can
// be issued. Setup fault, not something retyping fixes. Mapped on err.code GS001
// (CLAUDE.md §9.1) from the quotation issue route only; job numbers keep their own
// mapping in lib/pgError.ts.
export const DocumentSeriesMissingError = payloadless('document_series_missing');
export type DocumentSeriesMissingError = z.infer<typeof DocumentSeriesMissingError>;

/** QuotationRefusal plus the document-series refusal the issue door can also answer with. */
export const QuotationIssueRefusal = z.union([QuotationRefusal, DocumentSeriesMissingError]);
export type QuotationIssueRefusal = z.infer<typeof QuotationIssueRefusal>;

// 404 — a warranty term id that is not this shop's (a missing one and another shop's look identical).
export const WarrantyTermNotFoundError = payloadless('warranty_term_not_found');
export type WarrantyTermNotFoundError = z.infer<typeof WarrantyTermNotFoundError>;

// 404 — a vehicle id that is not this shop's.
export const VehicleNotFoundError = payloadless('vehicle_not_found');
export type VehicleNotFoundError = z.infer<typeof VehicleNotFoundError>;
