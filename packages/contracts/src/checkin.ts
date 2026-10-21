// The walk-in check-in form. Fields are ported from the prototype's
// AddJobModal.jsx (see WO-003 step 0) — only the fields staff actually fill
// in every time made the cut. No price, deposit, quotation, part, or stock
// field belongs here: those are W3-W5 and this work order forbids building
// ahead of them.

import { z } from 'zod';
import { PLATE_AREAS } from '@champpower/domain';
import { blankAsAbsent, plate as plateSchema, thaiPhone } from './common.js';
import { DepositWarning } from './deposits.js';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'invalid_date');

// A plate area: one of the 77 provinces or เบตง, nothing else. Cars are matched
// on (plate_key, province), so "กทม" and "กรุงเทพมหานคร" as free text would be
// two different cars. The list is PLATE_AREAS in @champpower/domain
// (rules/provinces.ts) — the one list; the screen offers it as a picker, and
// the API refuses anything outside it.
export const Province = z.enum(PLATE_AREAS);
export type Province = z.infer<typeof Province>;

// Same list as customers.lead_source in packages/db/migrations/0002_core.sql.
// 'unknown' has to exist as a real option — without it staff pick at random
// to get past the form, per CLAUDE.md §5.7.
export const LeadSource = z.enum([
  'page',
  'line',
  'shopfront_sign',
  'referral',
  'google',
  'passing_by',
  'other',
  'unknown',
]);
export type LeadSource = z.infer<typeof LeadSource>;

export const CheckInInput = z.object({
  plate: plateSchema,
  customerName: z.string().trim().min(1).max(200),
  // Optional on the form, but the shop asks for it almost every time — kept
  // optional rather than required because a walk-in must never be blocked
  // for lack of a phone number.
  customerPhone: blankAsAbsent(thaiPhone),
  brand: z.string().trim().min(1).max(100),
  model: z.string().trim().min(1).max(100),
  color: blankAsAbsent(z.string().trim().max(50)),
  year: blankAsAbsent(z.string().trim().max(10)),
  // จังหวัด, picked from the 78 plate areas. Part of how a car is found: the same plate in
  // two provinces is two cars (owner decision, 29 Sep 2026). Optional in the
  // schema because a car already on file can be found without it; REQUIRED for a
  // new car — the server answers intake_details_required naming `province`.
  // An existing car's province is never rewritten; an EMPTY one is filled, with
  // an audit row (vehiclesRepo.choosePlateMatch).
  province: blankAsAbsent(Province),
  mileageInKm: blankAsAbsent(z.number().int().min(0)),
  // Omitted = server allocates max(queue_no)+1 for (shop, jobDate) inside the
  // same transaction as the insert. Supplied = staff is fixing a collision or
  // deliberately reordering; the database still enforces uniqueness.
  queueNo: blankAsAbsent(z.number().int().min(1)),
  // Defaults to today in Asia/Bangkok when omitted. The prototype lets staff
  // key a job in for an earlier day (a car that arrived after the desk closed
  // out the day, for instance) — jobs.job_date exists specifically for this,
  // separate from created_at.
  jobDate: blankAsAbsent(isoDate),
  symptom: blankAsAbsent(z.string().trim().max(2000)),
  bayId: blankAsAbsent(z.string().uuid()),
  // Already uploaded via the files endpoint before this form is submitted.
  photoFileIds: z.array(z.string().uuid()).max(30).optional(),
  leadSource: blankAsAbsent(LeadSource),

  // Sent on the SECOND attempt, after the server refused the first one.
  //
  // `customerId` answers a 409 `customer_ambiguous`: two or more customers
  // share this phone number and the server will not guess which one is at the
  // counter. `confirmOwnerChange` answers a 409 `vehicle_owner_mismatch`: this
  // plate is on file against a different customer, and moving it pours one
  // person's repair history into another's, so it takes a deliberate second
  // request. Neither is ever defaulted on; both mean "I saw the warning".
  customerId: z.string().uuid().optional(),
  confirmOwnerChange: z.boolean().optional(),
  // Both answer a 409 `vehicle_ambiguous`: the plate matches more than one car
  // and the server will not guess. `vehicleId` = "it is this one" (one of the
  // candidates). `confirmNewVehicle` = "none of those — a new car in the
  // province I picked"; it only skips cars whose province is unknown, never a
  // car already on file with the same plate AND province.
  vehicleId: z.string().uuid().optional(),
  confirmNewVehicle: z.boolean().optional(),

  // The held-deposit warning (CLAUDE.md §5.4 item 3, P3.3) is on the RESPONSE:
  // CheckInResult.heldDeposits. It needs nothing from the request.
});
export type CheckInInput = z.infer<typeof CheckInInput>;

export const CheckInResult = z.object({
  jobId: z.string().uuid(),
  queueNo: z.number().int(),
  jobDate: isoDate,
  customerId: z.string().uuid(),
  vehicleId: z.string().uuid(),
  // P3.3: deposits this customer (or this phone) still has `held`. Empty when none. Show
  // "ลูกค้ารายนี้มีมัดจำค้าง ฿X" with a button -> POST /api/deposits/:id/attach { jobId }.
  heldDeposits: z.array(DepositWarning).default([]),
});
export type CheckInResult = z.infer<typeof CheckInResult>;

// The form looks up an existing car by plate to prefill brand/model/color.
// The server matches on vehicles.plate_key, a generated STORED column that
// strips spaces/dashes and upper-cases — so "กก 1234" and "กก1234" resolve
// to the same car (packages/db/migrations/0002_core.sql). With a province the
// lookup is exact; without one it answers 409 `vehicle_ambiguous` when the plate
// is on file in more than one province.
export const VehicleLookupQuery = z.object({
  plate: plateSchema,
  province: blankAsAbsent(Province),
});
export type VehicleLookupQuery = z.infer<typeof VehicleLookupQuery>;

export const VehicleLookupResult = z.object({
  vehicleId: z.string().uuid(),
  customerId: z.string().uuid(),
  plate: z.string(),
  brand: z.string(),
  model: z.string(),
  color: z.string().nullable(),
  year: z.string().nullable(),
  province: z.string().nullable(),
  customerName: z.string().nullable(),
  customerPhone: z.string().nullable(),
});
export type VehicleLookupResult = z.infer<typeof VehicleLookupResult>;

export const CustomerLookupQuery = z.object({
  phone: thaiPhone,
});
export type CustomerLookupQuery = z.infer<typeof CustomerLookupQuery>;

export const CustomerLookupResult = z.object({
  customerId: z.string().uuid(),
  name: z.string().nullable(),
  phone: z.string().nullable(),
  // P3.3: the warning as soon as the phone is known, before the job is even opened.
  heldDeposits: z.array(DepositWarning).default([]),
  vehicles: z.array(
    z.object({
      vehicleId: z.string().uuid(),
      plate: z.string(),
      brand: z.string(),
      model: z.string(),
    }),
  ),
});
export type CustomerLookupResult = z.infer<typeof CustomerLookupResult>;
