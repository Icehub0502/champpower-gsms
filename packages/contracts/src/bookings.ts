import { z } from 'zod';
import { plate as plateSchema, thaiPhone } from './common.js';
// Arrival captures the car, so it reuses check-in's own vocabulary rather
// than growing a parallel one that drifts. See ArriveInput below.
import { LeadSource } from './checkin.js';

const isoDateTime = z.string().datetime();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'invalid_date');

export const BookingSource = z.enum(['walk_in', 'phone', 'line', 'page', 'self_service']);
export type BookingSource = z.infer<typeof BookingSource>;

export const BookingStatus = z.enum(['booked', 'confirmed', 'arrived', 'no_show', 'cancelled']);
export type BookingStatus = z.infer<typeof BookingStatus>;

export const CreateBookingInput = z
  .object({
    source: BookingSource,
    slotStart: isoDateTime,
    slotEnd: isoDateTime,
    // A booking with no bay is a soft reservation — packages/db/migrations
    // /0008_booking.sql deliberately excludes bay-less rows from the overlap
    // constraint, so it is allowed to collide in time with anything.
    bayId: uuidNullable(),
    // Known customer/vehicle, when the caller already has them on file.
    customerId: z.string().uuid().optional(),
    vehicleId: z.string().uuid().optional(),
    // For a booking taken over the phone before any customer record exists.
    contactName: z.string().trim().min(1).max(200).optional(),
    contactPhone: thaiPhone.optional(),
    note: z.string().trim().max(2000).optional(),
  })
  .refine((v) => v.customerId !== undefined || (v.contactName !== undefined && v.contactName.length > 0), {
    message: 'customer_id_or_contact_name_required',
    path: ['contactName'],
  });
export type CreateBookingInput = z.infer<typeof CreateBookingInput>;

function uuidNullable() {
  return z.string().uuid().nullable().optional();
}

export const UpdateBookingInput = z.object({
  source: BookingSource.optional(),
  slotStart: isoDateTime.optional(),
  slotEnd: isoDateTime.optional(),
  bayId: uuidNullable(),
  customerId: z.string().uuid().optional(),
  vehicleId: z.string().uuid().optional(),
  contactName: z.string().trim().min(1).max(200).optional(),
  contactPhone: thaiPhone.optional(),
  note: z.string().trim().max(2000).optional(),
  status: BookingStatus.optional(),
});
export type UpdateBookingInput = z.infer<typeof UpdateBookingInput>;

// What the counter fills in the moment the car actually shows up. This is a
// state transition on an existing booking (booked/confirmed -> arrived, and
// the server opens the job in the same transaction) — it is never a create.
// The prototype's worst bug was a "new queue" button that created a second
// job next to the booking instead of advancing it; do not reintroduce that
// shape here. See CLAUDE.md §5.8 and WO-003 §1. `uq_jobs_booking` remains the
// enforcement: a booking yields at most one job, whatever this schema allows.
//
// It also CAPTURES THE CAR, which is why every check-in field appears here.
// A booking taken over the phone legitimately knows nothing about the vehicle
// — often not even which of the customer's cars is coming — until it turns up
// in front of the counter. Arrival is a check-in that happens to carry a
// booking; the only difference from a walk-in is that a row already exists
// saying this car was expected, and that row may already name the customer.
//
// Every field is optional because the booking is the fallback for each one:
// what is supplied now wins, otherwise the booking's own value is used
// (customer_id, vehicle_id, contact_name, contact_phone, bay_id), and only
// when both are absent is anything missing. The single hard requirement is
// that the car must end up identifiable — an existing vehicle_id on the
// booking, or a plate typed here.
export const ArriveInput = z.object({
  plate: plateSchema.optional(),
  customerName: z.string().trim().min(1).max(200).optional(),
  customerPhone: thaiPhone.optional(),
  brand: z.string().trim().min(1).max(100).optional(),
  model: z.string().trim().min(1).max(100).optional(),
  color: z.string().trim().max(50).optional(),
  year: z.string().trim().max(10).optional(),
  mileageInKm: z.number().int().min(0).optional(),
  bayId: z.string().uuid().optional(),
  queueNo: z.number().int().min(1).optional(),
  jobDate: isoDate.optional(),
  symptom: z.string().trim().max(2000).optional(),
  photoFileIds: z.array(z.string().uuid()).max(30).optional(),
  leadSource: LeadSource.optional(),

  // Answers to the two refusals the resolver can return — see the identical
  // pair on CheckInInput, which they must stay in step with, since one service
  // opens the job for both doors.
  customerId: z.string().uuid().optional(),
  confirmOwnerChange: z.boolean().optional(),
});
export type ArriveInput = z.infer<typeof ArriveInput>;

// The candidate list on a 409 customer_ambiguous. Id and name only: the caller
// is choosing between people, not browsing them.
export const CustomerCandidate = z.object({
  id: z.string().uuid(),
  name: z.string().nullable(),
});
export type CustomerCandidate = z.infer<typeof CustomerCandidate>;

export const BookingSummary = z.object({
  id: z.string().uuid(),
  source: BookingSource,
  slotStart: isoDateTime,
  slotEnd: isoDateTime,
  status: BookingStatus,
  bayId: z.string().uuid().nullable(),
  bayName: z.string().nullable(),
  customerId: z.string().uuid().nullable(),
  vehicleId: z.string().uuid().nullable(),
  contactName: z.string().nullable(),
  contactPhone: z.string().nullable(),
  note: z.string().nullable(),
  jobId: z.string().uuid().nullable(),
  createdAt: isoDateTime,
});
export type BookingSummary = z.infer<typeof BookingSummary>;
