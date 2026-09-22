// The walk-in check-in form. Fields are ported from the prototype's
// AddJobModal.jsx (see WO-003 step 0) — only the fields staff actually fill
// in every time made the cut. No price, deposit, quotation, part, or stock
// field belongs here: those are W3-W5 and this work order forbids building
// ahead of them.

import { z } from 'zod';
import { plate as plateSchema, thaiPhone } from './common.js';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'invalid_date');

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
  customerPhone: thaiPhone.optional(),
  brand: z.string().trim().min(1).max(100),
  model: z.string().trim().min(1).max(100),
  color: z.string().trim().max(50).optional(),
  year: z.string().trim().max(10).optional(),
  mileageInKm: z.number().int().min(0).optional(),
  // Omitted = server allocates max(queue_no)+1 for (shop, jobDate) inside the
  // same transaction as the insert. Supplied = staff is fixing a collision or
  // deliberately reordering; the database still enforces uniqueness.
  queueNo: z.number().int().min(1).optional(),
  // Defaults to today in Asia/Bangkok when omitted. The prototype lets staff
  // key a job in for an earlier day (a car that arrived after the desk closed
  // out the day, for instance) — jobs.job_date exists specifically for this,
  // separate from created_at.
  jobDate: isoDate.optional(),
  symptom: z.string().trim().max(2000).optional(),
  bayId: z.string().uuid().optional(),
  // Already uploaded via the files endpoint before this form is submitted.
  photoFileIds: z.array(z.string().uuid()).max(30).optional(),
  leadSource: LeadSource.optional(),

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

  // W4: held-deposit lookup by phone. The counter must be warned here if
  // customerPhone matches a deposit still `held`, per CLAUDE.md §5.4 item 3 —
  // not implemented yet because the deposit module does not exist until W4.
  // Left as a marker so this endpoint is not shipped believing the warning
  // already happens.
});
export type CheckInInput = z.infer<typeof CheckInInput>;

export const CheckInResult = z.object({
  jobId: z.string().uuid(),
  queueNo: z.number().int(),
  jobDate: isoDate,
  customerId: z.string().uuid(),
  vehicleId: z.string().uuid(),
});
export type CheckInResult = z.infer<typeof CheckInResult>;

// The form looks up an existing car by plate to prefill brand/model/color.
// The server matches on vehicles.plate_key, a generated STORED column that
// strips spaces/dashes and upper-cases — so "กก 1234" and "กก1234" resolve
// to the same car (packages/db/migrations/0002_core.sql).
export const VehicleLookupQuery = z.object({
  plate: plateSchema,
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
