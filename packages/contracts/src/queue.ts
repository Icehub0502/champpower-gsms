// The "cars in the shop right now" board. Backed by the `queue_board` view
// (packages/db/migrations/0013_queue_board.sql, per WO-003-ANSWERS.md §a) —
// this file only shapes the API's request/response, not the SQL.

import { z } from 'zod';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'invalid_date');

// `from`/`to` filter ONLY the booking rows on the board. Job rows are never
// date-filtered: a car that arrived yesterday and is still mid-repair must
// stay visible, or the board lies to staff the moment it crosses midnight
// (WO-003-ANSWERS.md §a — this is the bug that made `queue_today` wrong).
// Default window when both are omitted: today .. +7 days, applied by the API
// handler, not by this schema.
export const QueueBoardQuery = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
});
export type QueueBoardQuery = z.infer<typeof QueueBoardQuery>;

export const QueueBoardRow = z.object({
  kind: z.enum(['booking', 'job']),
  refId: z.string().uuid(),
  bayId: z.string().uuid().nullable(),
  bayName: z.string().nullable(),
  at: z.string().datetime(),
  status: z.string(),
  source: z.string(),
  customerName: z.string().nullable(),
  phone: z.string().nullable(),
  plate: z.string().nullable(),
  brand: z.string().nullable(),
  model: z.string().nullable(),
  color: z.string().nullable(),
  queueNo: z.number().int().nullable(),
  jobId: z.string().uuid().nullable(),
  jobType: z.enum(['normal', 'warranty_claim']).nullable(),
  thumbFileId: z.string().uuid().nullable(),
  assignedTechnicianId: z.string().uuid().nullable(),
  assignedTeamId: z.string().uuid().nullable(),
  note: z.string().nullable(),
});
export type QueueBoardRow = z.infer<typeof QueueBoardRow>;

// The bay can be changed from the board itself, not only at check-in —
// whoever is standing at the bay is the one who knows the car moved
// (WO-003-ANSWERS.md §b). `null` clears the assignment.
export const UpdateBayInput = z.object({
  bayId: z.string().uuid().nullable(),
});
export type UpdateBayInput = z.infer<typeof UpdateBayInput>;

// Queue numbers are per (shop, job_date) and staff can renumber to fix a
// collision or reorder — see WO-003-ANSWERS.md §c. The database enforces
// uniqueness; a conflicting number here comes back as a 409, not a 400.
export const UpdateQueueNoInput = z.object({
  queueNo: z.number().int().min(1).nullable(),
});
export type UpdateQueueNoInput = z.infer<typeof UpdateQueueNoInput>;
