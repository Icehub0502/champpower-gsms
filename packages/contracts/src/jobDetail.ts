// One job, read on its own — and the short list the counter uses to find a job
// that has already left the boards.
//
//   GET /api/jobs/:id                              JobDetail
//   GET /api/jobs?status=delivered&date=today       DeliveredJobsPage
//
// Why these exist (DECISION-carout.md §3): "ส่งแล้ว" takes a card off /today
// and the TV at once, but a mistaken press must still be undoable — from the
// job's own screen, where its history shows who moved it, when, and why.
//
// Every object here is .strict(): a field the server starts sending without a
// schema change is refused, not passed along. That is the guard against a
// cost or margin figure creeping into a response an advisor receives
// (CLAUDE.md §12.2) — there is no money on a job today, and none can appear
// here without someone writing it into this file first.

import { z } from 'zod';
import { uuid } from './common.js';
import { StatusKey, SubState } from './today.js';

const isoDateTime = z.string().datetime();

// Who made a move: the user's display name only — never a login id, email or
// phone. null when the row predates the actor being recorded, or the user
// was removed (changed_by ON DELETE SET NULL).
export const HistoryActor = z
  .object({
    userId: uuid,
    name: z.string(),
  })
  .strict();
export type HistoryActor = z.infer<typeof HistoryActor>;

export const JobHistoryEntry = z
  .object({
    // A plain string, not StatusKey: history records what happened, and an
    // imported row may carry a status that is no longer a job status
    // (0017 deliberately leaves job_status_history unconstrained).
    status: z.string(),
    statusLabel: z.string(),
    changedAt: isoDateTime,
    changedBy: HistoryActor.nullable(),
    // Why — present where a reason was required (undoing a delivery),
    // job_status_history.reason (migration 0019); null on every other move.
    reason: z.string().nullable(),
  })
  .strict();
export type JobHistoryEntry = z.infer<typeof JobHistoryEntry>;

export const JobDetail = z
  .object({
    jobId: uuid,
    jobNumber: z.string(),
    queueNo: z.number().int().nullable(),
    status: StatusKey,
    statusLabel: z.string(),
    subState: SubState.nullable(),
    jobType: z.enum(['normal', 'warranty_claim']),
    source: z.enum(['walk_in', 'booked']),
    plate: z.string().nullable(),
    province: z.string().nullable(),
    brand: z.string().nullable(),
    model: z.string().nullable(),
    color: z.string().nullable(),
    customerName: z.string().nullable(),
    bayName: z.string().nullable(),
    createdAt: isoDateTime,
    statusChangedAt: isoDateTime,
    // Whether the job is on /today and the public board right now — false for
    // the three exits (delivered, rejected, carout).
    onBoard: z.boolean(),
    // Oldest first.
    history: z.array(JobHistoryEntry),
    // For THIS caller, decided on the server exactly as on /today: the
    // transition table fed the real history, filtered by the role rule the
    // PATCH enforces. movesNeedingReason is the subset that must be sent with
    // `reason` (UpdateJobStatusInput).
    allowedMoves: z.array(StatusKey),
    movesNeedingReason: z.array(StatusKey),
  })
  .strict();
export type JobDetail = z.infer<typeof JobDetail>;

// -----------------------------------------------------------------------------
// Today's delivered jobs — where the counter finds one to undo
// -----------------------------------------------------------------------------

export const JOB_LIST_MAX_PAGE_SIZE = 50;

// Deliberately narrow: the one list the undo needs. Widening it (other
// statuses, other dates) is a new decision, not a new query-string value.
export const JobListQuery = z
  .object({
    status: z.literal('delivered'),
    date: z.literal('today'),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(JOB_LIST_MAX_PAGE_SIZE).default(20),
  })
  .strict();
export type JobListQuery = z.infer<typeof JobListQuery>;

export const DeliveredJobItem = z
  .object({
    jobId: uuid,
    jobNumber: z.string(),
    queueNo: z.number().int().nullable(),
    plate: z.string().nullable(),
    province: z.string().nullable(),
    brand: z.string().nullable(),
    model: z.string().nullable(),
    customerName: z.string().nullable(),
    // When it was delivered (the latest 'delivered' history row).
    deliveredAt: isoDateTime,
  })
  .strict();
export type DeliveredJobItem = z.infer<typeof DeliveredJobItem>;

export const DeliveredJobsPage = z
  .object({
    items: z.array(DeliveredJobItem),
    page: z.number().int().min(1),
    pageSize: z.number().int().min(1),
    total: z.number().int().min(0),
  })
  .strict();
export type DeliveredJobsPage = z.infer<typeof DeliveredJobsPage>;
