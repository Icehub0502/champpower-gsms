// The /today kanban — "ศูนย์ควบคุมงานวันนี้", Figma node 80 (REDESIGN V3).
//
// Authenticated, RLS-scoped, full data. The public waiting-room screen is a
// DIFFERENT endpoint with a DIFFERENT schema (publicBoard.ts) that cannot carry
// a customer field at all — never derive one from the other
// (docs/UI-SPEC-FIGMA.md §2: "ห้ามรวมสอง endpoint เป็นอันเดียว").
//
// Everything the card shows is decided on the server by packages/domain
// (column, label, tone, counts). The screen renders what it is given. The one
// exception is the ticking clock: `sla` carries raw times so the screen can
// call etaState() from packages/domain once a second without asking the server.

import { z } from 'zod';

const isoDateTime = z.string().datetime();

export const StatusKey = z.enum([
  'received', 'inspecting', 'quoted', 'approved', 'scheduled', 'rejected',
  'repairing', 'aligning', 'ready', 'delivered', 'carout',
]);
export type StatusKey = z.infer<typeof StatusKey>;

export const SubState = z.enum([
  'waiting_customer', 'call_customer', 'quote_sent', 'waiting_parts',
  'waiting_qc', 'waiting_wash', 'paid',
]);
export type SubState = z.infer<typeof SubState>;

export const KanbanColumn = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]);
export type KanbanColumn = z.infer<typeof KanbanColumn>;

// red = needs action now · orange = waiting on something · blue = in progress
// or informational · green = done or ready. The card's left stripe takes this
// tone too, NOT its column's colour.
export const CardTone = z.enum(['red', 'orange', 'blue', 'green']);
export type CardTone = z.infer<typeof CardTone>;

export const CardLabel = z.object({
  text: z.string(),
  tone: CardTone,
});
export type CardLabel = z.infer<typeof CardLabel>;

// Raw inputs to packages/domain etaState(), so the card's countdown can tick
// client-side. null when the job has no estimate: no estimate, no SLA — the
// screen must show no countdown rather than invent one.
export const SlaInputs = z.object({
  estMinutes: z.number().int().min(1),
  repairStartedAt: isoDateTime.nullable(),
  repairEndedAt: isoDateTime.nullable(),
});
export type SlaInputs = z.infer<typeof SlaInputs>;

const TodayJobFields = {
  jobId: z.string().uuid(),
  jobNumber: z.string(),
  queueNo: z.number().int().nullable(),
  status: StatusKey,
  statusLabel: z.string(),
  subState: SubState.nullable(),
  label: CardLabel,
  jobType: z.enum(['normal', 'warranty_claim']),
  source: z.enum(['walk_in', 'booked']),

  plate: z.string().nullable(),
  brand: z.string().nullable(),
  model: z.string().nullable(),
  color: z.string().nullable(),
  customerName: z.string().nullable(),
  // Present because "ต้องโทร" on a card without the number to call is a card
  // that sends someone off to look it up. Authenticated staff only.
  phone: z.string().nullable(),

  bayId: z.string().uuid().nullable(),
  bayName: z.string().nullable(),
  // The card's detail line: the first thing the customer said was wrong. Money
  // arrives with billing (W3); a quote amount must never be faked here.
  symptom: z.string().nullable(),
  bookingSlotStart: isoDateTime.nullable(),
  thumbFileId: z.string().uuid().nullable(),

  createdAt: isoDateTime,
  // When the job entered the status it is in now — the "รอ N นาที" line.
  statusChangedAt: isoDateTime,
  sla: SlaInputs.nullable(),
};

// A card on the kanban. `column` is never null here.
export const TodayJob = z.object({ ...TodayJobFields, column: KanbanColumn });
export type TodayJob = z.infer<typeof TodayJob>;

// A job the kanban has no column for: `scheduled` (the customer chose a later
// date) whose car has not yet been taken down. It is still physically in the
// workshop — on a lift, possibly in a bay — so it is returned rather than
// silently dropped. Where to show it is the screen's call; making it vanish is
// not an option.
export const AwaitingTakeDownJob = z.object({ ...TodayJobFields, column: z.null() });
export type AwaitingTakeDownJob = z.infer<typeof AwaitingTakeDownJob>;

// A car expected today that has not arrived. Its button reads "รถมาถึงแล้ว"
// and calls POST /api/bookings/:id/arrive — a transition, never a create.
export const TodayBooking = z.object({
  bookingId: z.string().uuid(),
  at: isoDateTime,
  status: z.string(),
  source: z.string(),
  bayId: z.string().uuid().nullable(),
  bayName: z.string().nullable(),
  customerName: z.string().nullable(),
  phone: z.string().nullable(),
  plate: z.string().nullable(),
  brand: z.string().nullable(),
  model: z.string().nullable(),
  note: z.string().nullable(),
});
export type TodayBooking = z.infer<typeof TodayBooking>;

export const TodayKpis = z.object({
  openJobs: z.number().int().min(0),          // งานเปิดทั้งหมด
  awaitingDecision: z.number().int().min(0),  // รอลูกค้าตัดสินใจ  (column 2)
  inRepair: z.number().int().min(0),          // ซ่อม / ตั้งศูนย์   (column 3)
  readyForHandover: z.number().int().min(0),  // พร้อมส่ง / รอชำระ  (status ready)
});
export type TodayKpis = z.infer<typeof TodayKpis>;

export const TodayPulse = z.object({
  baysInUse: z.number().int().min(0),
  baysActive: z.number().int().min(0),
  // Over cars that arrived TODAY (Bangkok). null = no car arrived today; show
  // "—", not "0 นาที".
  avgInspectionWaitMinutes: z.number().int().min(0).nullable(),
  waitingParts: z.number().int().min(0),
  overSla: z.number().int().min(0),
});
export type TodayPulse = z.infer<typeof TodayPulse>;

export const TodayResponse = z.object({
  // Every car still in the workshop, WHENEVER it arrived — plus today's
  // deliveries. Not date-filtered, deliberately: see the route's doc comment.
  jobs: z.array(TodayJob),
  awaitingTakeDown: z.array(AwaitingTakeDownJob),
  bookings: z.array(TodayBooking),
  kpis: TodayKpis,
  pulse: TodayPulse,
  generatedAt: isoDateTime,
  // True only if the safety cap on rows was hit. A workshop holds tens of
  // cars, not hundreds; if this is ever true, something is wrong upstream.
  truncated: z.boolean(),
});
export type TodayResponse = z.infer<typeof TodayResponse>;

// -----------------------------------------------------------------------------
// Changing a job from the board
// -----------------------------------------------------------------------------

// A drag is a REQUEST. The screen works out the target with
// targetStatusForColumn() from packages/domain and sends it here; the server
// re-checks it with canMoveTo() and is the only thing that decides.
//
// `fromStatus` is what the screen believed the job's status was when the drag
// began. If someone else moved the card in the meantime the server answers 409
// `status_changed` rather than applying a move that was judged against a board
// that no longer exists.
export const UpdateJobStatusInput = z.object({
  to: StatusKey,
  fromStatus: StatusKey,
  // Required when `to` is 'scheduled' — the date the customer will bring the
  // car back. Without it the car can never return to the workshop through the
  // normal flow (packages/domain transitions.ts, isRejectedCarout).
  appointmentDate: isoDateTime.optional(),
});
export type UpdateJobStatusInput = z.infer<typeof UpdateJobStatusInput>;

export const UpdateJobStatusResult = z.object({
  jobId: z.string().uuid(),
  status: StatusKey,
  // The sub-state after the move. It is cleared automatically when it no
  // longer fits the new status (a quote_sent label does not survive approval).
  subState: SubState.nullable(),
  column: KanbanColumn.nullable(),
  statusChangedAt: isoDateTime,
});
export type UpdateJobStatusResult = z.infer<typeof UpdateJobStatusResult>;

// null clears the label; the card falls back to bay / booking / Walk-in.
export const UpdateSubStateInput = z.object({
  subState: SubState.nullable(),
});
export type UpdateSubStateInput = z.infer<typeof UpdateSubStateInput>;

export const UpdateSubStateResult = z.object({
  jobId: z.string().uuid(),
  subState: SubState.nullable(),
  label: CardLabel,
});
export type UpdateSubStateResult = z.infer<typeof UpdateSubStateResult>;
