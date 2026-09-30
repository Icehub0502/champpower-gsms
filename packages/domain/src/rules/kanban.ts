/**
 * The /today kanban's rules — what column a job sits in, what its card says,
 * what the headline numbers count, and which drags are allowed.
 *
 * Sources, in order of authority:
 *   docs/WORK-ORDERS/DECISION-job-status.md (22 Sep 2026)  — columns, sub-states, label priority
 *   docs/UI-SPEC-FIGMA.md, Figma node 80 (REDESIGN V3)       — KPI and pulse definitions
 *   workflow/transitions.ts, rules/eta.ts                    — the transition and SLA rules, REUSED
 *
 * Everything here is pure. The API resolves column, label and counts with
 * these functions before sending, and the screen imports the same functions
 * when it needs to (a drag preview, a ticking clock). One rule, one home,
 * both sides of the wire — CLAUDE.md §2.
 */
import type { StatusHistoryEntry } from '../types/job.js';
import { MAIN_PATH, type StatusKey } from '../workflow/statusFlow.js';
import { allowedMovesFrom, moveRequiresReason } from '../workflow/transitions.js';
import { estMinutes, etaState, repairCycle, type EtaState } from './eta.js';

// ============================================================================
// Columns
// ============================================================================

export type KanbanColumn = 1 | 2 | 3 | 4;

export interface KanbanColumnDef {
  column: KanbanColumn;
  title: string;
  /** In MAIN_PATH order — the drop rule below depends on this order. */
  statuses: StatusKey[];
}

/**
 * DECISION-job-status.md §2.
 *
 * `approved` is in column 3, NOT column 2 where the raw Figma frame draws it.
 * Column 2's KPI reads "รอลูกค้าตัดสินใจ" — waiting for the customer to decide
 * — and an approved job is one where the customer HAS decided. Left in column
 * 2 it would inflate that count and, worse, send staff to phone customers who
 * already said yes. An approved car is work to start, so it sits with the
 * work. Do not move it back to match the picture.
 *
 * Column 4 is `ready` ONLY (DECISION-carout.md, 30 Sep 2026 — overrides
 * DECISION-job-status.md §2 and the Figma card that faded "ส่งแล้ว" out at the
 * end of the day). A delivered car has left; its card goes the moment
 * "ส่งแล้ว" is pressed.
 */
export const KANBAN_COLUMNS: readonly KanbanColumnDef[] = [
  { column: 1, title: 'รับรถ / ตรวจรับ', statuses: ['received'] },
  { column: 2, title: 'ตรวจเช็ก / รออนุมัติ', statuses: ['inspecting', 'quoted'] },
  { column: 3, title: 'กำลังซ่อม / ตั้งศูนย์', statuses: ['approved', 'repairing', 'aligning'] },
  { column: 4, title: 'พร้อมชำระ / ส่งมอบ', statuses: ['ready'] },
];

/**
 * The column a status belongs in, or null.
 *
 * null for the three exits — `delivered`, `rejected`, `carout`
 * (EXIT_STATUSES, DECISION-carout.md §1). Each takes the card off /today and
 * the public board immediately; the same rule is written for the database as
 * job_board_state.on_board (migration 0018). They stay distinct statuses (the
 * owner's "why customers don't go ahead" report depends on `rejected`). There
 * is no `scheduled`: an appointment is a booking (DECISION-7-today.md §6).
 */
export function kanbanColumnOf(status: string): KanbanColumn | null {
  for (const def of KANBAN_COLUMNS) {
    if ((def.statuses as string[]).includes(status)) return def.column;
  }
  return null;
}

// ============================================================================
// Sub-states
// ============================================================================

export const SUB_STATES = [
  'waiting_customer',
  'call_customer',
  'quote_sent',
  'waiting_parts',
  'waiting_qc',
  'waiting_wash',
  'paid',
] as const;
export type SubState = (typeof SUB_STATES)[number];

/**
 * What each sub-state SAYS on a card. The database stores what a card is
 * (migration 0016's CHECK); this decides the words.
 *
 * quote_sent is "ส่งราคาแล้ว", never "ส่งแล้ว" as the Figma frame has it:
 * "ส่งแล้ว" is also the label of the delivered status, and one board carrying
 * two cards with the same word meaning opposite things — "quote just went
 * out" and "car has gone home" — is a board staff will misread while busy.
 * DECISION-job-status.md §3.
 */
export const SUB_STATE_LABEL: Record<SubState, string> = {
  waiting_customer: 'รอลูกค้า',
  call_customer: 'ต้องโทร',
  quote_sent: 'ส่งราคาแล้ว',
  waiting_parts: 'กำลังรออะไหล่',
  waiting_qc: 'รอตรวจ QC',
  waiting_wash: 'รอล้างรถ',
  paid: 'ชำระแล้ว',
};

export function isSubState(value: unknown): value is SubState {
  return typeof value === 'string' && (SUB_STATES as readonly string[]).includes(value);
}

/**
 * Which sub-states make sense in which status.
 *
 * THIS IS A BUSINESS JUDGEMENT, not a fact about the schema, and it lives here
 * rather than in a database constraint so it can change without a migration
 * (DECISION-job-status.md §4). Read it as "while the job is in <status>, the
 * card may also say <sub-state>":
 *
 *   status       allowed sub-states                  why
 *   ----------   ---------------------------------   -----------------------------------------
 *   received     (none)                              nothing has happened yet; the card shows
 *                                                    its bay, its booking time or "Walk-in"
 *   inspecting   waiting_customer, call_customer     inspection turned something up that the
 *                                                    customer has to hear about before a price
 *   quoted       quote_sent, waiting_customer,       the quote is out and the ball is in the
 *                call_customer                       customer's court
 *   approved     waiting_parts                       approved but cannot start: the part is not
 *                                                    here (the special-order case the owner
 *                                                    asked to be able to count)
 *   repairing    waiting_parts, waiting_qc           stalled mid-job for a part, or the work is
 *                                                    done and waiting to be checked
 *   aligning     waiting_qc, waiting_wash            alignment done, checking or cleaning up
 *   ready        waiting_wash, waiting_customer,     finished; being cleaned, or waiting for —
 *                call_customer, paid                 or needing a call to — the owner, or paid
 *   delivered    paid                                gone, and settled
 *   rejected,    (none)                              closed early; not on the kanban
 *   carout
 *
 * Two choices worth checking with the shop:
 *   - quote_sent is allowed ONLY in `quoted`. A quote that has been sent means
 *     the job IS quoted; a card saying "ส่งราคาแล้ว" while the status still
 *     says ตรวจเช็ก is the status lagging behind, and the fix is to move the
 *     status, not to label around it.
 *   - waiting_customer / call_customer are allowed in `ready` as well as
 *     before approval. A finished car waiting for its owner to collect it is
 *     the other everyday "waiting on the customer" at a garage, and the call
 *     to say "your car is ready" is the other everyday call.
 */
export const SUB_STATES_BY_STATUS: Readonly<Partial<Record<StatusKey, readonly SubState[]>>> = {
  inspecting: ['waiting_customer', 'call_customer'],
  quoted: ['quote_sent', 'waiting_customer', 'call_customer'],
  approved: ['waiting_parts'],
  repairing: ['waiting_parts', 'waiting_qc'],
  aligning: ['waiting_qc', 'waiting_wash'],
  ready: ['waiting_wash', 'waiting_customer', 'call_customer', 'paid'],
  delivered: ['paid'],
};

/** `null` is always valid — it means "no sub-state", the card's default. */
export function isValidSubState(status: string, subState: string | null): boolean {
  if (subState === null) return true;
  if (!isSubState(subState)) return false;
  const allowed = SUB_STATES_BY_STATUS[status as StatusKey];
  return allowed !== undefined && allowed.includes(subState);
}

/**
 * What a job's sub-state becomes when its status changes.
 *
 * Kept if it still makes sense, dropped if it does not. Without this, a card
 * moved from เสนอราคา to อนุมัติ would go on saying "ส่งราคาแล้ว" — a label
 * describing a moment the job has already moved past.
 */
export function subStateAfterMove(to: string, current: string | null): SubState | null {
  return current !== null && isSubState(current) && isValidSubState(to, current) ? current : null;
}

// ============================================================================
// The card's label pill
// ============================================================================

export type CardTone = 'red' | 'orange' | 'blue' | 'green';

export interface CardLabel {
  text: string;
  tone: CardTone;
}

/**
 * Tone by meaning (Figma 80): red = needs action now · orange = waiting on
 * something · blue = in progress or informational · green = done or ready.
 * The card's left stripe takes the same tone as its pill, NOT its column.
 */
const SUB_STATE_TONE: Record<SubState, CardTone> = {
  call_customer: 'red',
  waiting_customer: 'orange',
  waiting_parts: 'orange',
  waiting_qc: 'orange',
  waiting_wash: 'orange',
  quote_sent: 'blue',
  paid: 'green',
};

const BANGKOK_HHMM = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Bangkok',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

export interface CardLabelInput {
  subState: string | null;
  bayName: string | null;
  /** ISO timestamp of the booking slot, when the job came through a booking. */
  bookingSlotStart: string | null;
}

/**
 * DECISION-job-status.md §4 — one slot, filled by the first thing that applies:
 *
 *   1. a sub-state          → its label
 *   2. otherwise, a bay     → "ช่อง {bay}"
 *   3. otherwise, a booking → "นัด HH:MM"   (Bangkok time, whatever the server's clock zone)
 *   4. otherwise            → "Walk-in"
 *
 * The countdown / SLA line is a different part of the card (bottom right) and
 * is not decided here.
 */
export function cardLabelOf(input: CardLabelInput): CardLabel {
  if (input.subState !== null && isSubState(input.subState)) {
    return { text: SUB_STATE_LABEL[input.subState], tone: SUB_STATE_TONE[input.subState] };
  }
  if (input.bayName) return { text: `ช่อง ${input.bayName}`, tone: 'blue' };
  if (input.bookingSlotStart) {
    const t = new Date(input.bookingSlotStart);
    if (!Number.isNaN(t.getTime())) return { text: `นัด ${BANGKOK_HHMM.format(t)}`, tone: 'red' };
  }
  return { text: 'Walk-in', tone: 'orange' };
}

// ============================================================================
// Headline numbers
// ============================================================================

/** The subset of a board row the counting functions read. */
export interface BoardJob {
  status: string;
  subState: string | null;
  bayId: string | null;
  /** ISO. When the car physically arrived — jobs.created_at, NOT job_date (which may be backdated). */
  createdAt: string;
  /** ISO or null. When the car first moved on from 'received'. */
  leftReceivedAt: string | null;
  /** ISO or null. The start of the CURRENT repair pass (the last 'repairing'). */
  repairStartedAt: string | null;
  /** ISO or null. The first finish after that start. */
  repairEndedAt: string | null;
  estValue: number | string | null;
  estUnit: 'minute' | 'hour' | 'day' | null;
}

export interface Kpis {
  /** งานเปิดทั้งหมด — every card on the kanban (the sum of the four columns). */
  openJobs: number;
  /** รอลูกค้าตัดสินใจ — column 2 exactly. */
  awaitingDecision: number;
  /** ซ่อม / ตั้งศูนย์ — column 3 exactly. */
  inRepair: number;
  /** พร้อมส่ง / รอชำระ — column 4 exactly, which is status `ready`. */
  readyForHandover: number;
}

/**
 * The four KPI tiles, counted from real statuses — never from the numbers in
 * the design, which are sample data (DECISION-job-status.md §2).
 *
 * Every tile is a column count, and openJobs is the sum of the four columns —
 * the arithmetic the decision was verified against (18 = 6 + 6 + 3 + 3).
 * Since DECISION-carout.md, column 4 is `ready` only: a delivered car is off
 * the board, so there is nothing left to carve out of a column.
 */
export function kpisOf(rows: readonly Pick<BoardJob, 'status'>[]): Kpis {
  let openJobs = 0;
  let awaitingDecision = 0;
  let inRepair = 0;
  let readyForHandover = 0;
  for (const r of rows) {
    const col = kanbanColumnOf(r.status);
    if (col === null) continue;
    openJobs++;
    if (col === 2) awaitingDecision++;
    if (col === 3) inRepair++;
    if (col === 4) readyForHandover++;
  }
  return { openJobs, awaitingDecision, inRepair, readyForHandover };
}

// ============================================================================
// SLA — the existing definition, reused, not a new one
// ============================================================================

/**
 * The SLA state of one job, using eta.ts's definition EXACTLY: the estimate,
 * counted from when the car goes onto the lift (the last 'repairing'), frozen
 * at the first finish after that.
 *
 * null when the job has no estimate. A job nobody estimated has no SLA, and
 * counting it as over one would punish the shop for not guessing.
 *
 * The times arrive already extracted by the database (view job_board_state,
 * migration 0016), so they are rebuilt into the two-entry history that
 * repairCycle() reads. That keeps eta.ts's own rule — a job sent back to a
 * pre-repair status has no clock at all — applied in eta.ts, and nowhere else.
 */
export function slaOf(
  row: Pick<BoardJob, 'status' | 'repairStartedAt' | 'repairEndedAt' | 'estValue' | 'estUnit'>,
  now: number,
): EtaState | null {
  const mins = estMinutes({
    estValue: row.estValue ?? undefined,
    estUnit: row.estUnit ?? undefined,
  });
  if (!mins) return null;

  const history: StatusHistoryEntry[] = [];
  if (row.repairStartedAt) {
    history.push({ status: 'repairing', changedAt: row.repairStartedAt });
    if (row.repairEndedAt) history.push({ status: 'ready', changedAt: row.repairEndedAt });
  }
  const cycle = repairCycle({ status: row.status as StatusKey, statusHistory: history });
  return etaState(mins, cycle.start, cycle.end, now);
}

// ============================================================================
// The pulse panel under the board
// ============================================================================

export interface BoardBay {
  id: string;
  isActive: boolean;
}

export interface Pulse {
  /** Distinct active bays with a car in them, counting only cars still in the workshop. */
  baysInUse: number;
  /** The shop's active bays. The "M" of "N / M ช่อง". */
  baysActive: number;
  /**
   * เวลารอตรวจเฉลี่ย, in whole minutes, over TODAY'S JOBS ONLY — cars that
   * arrived on the current Bangkok calendar day. Per car: from arrival to the
   * moment it first left 'received', or to `now` for a car still waiting, so a
   * car that has been sitting unseen for three hours counts NOW rather than
   * only after someone finally looks at it. null when no car arrived today.
   */
  avgInspectionWaitMinutes: number | null;
  /** งานรออะไหล่ — cars with sub_state `waiting_parts`. */
  waitingParts: number;
  /** งานเกิน SLA — cars whose estimate has run out while on the lift (slaOf → 'late'). */
  overSla: number;
}

const BANGKOK_YMD = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Bangkok',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/**
 * The four pulse metrics, as the Figma V3 frame names them (V3 wins over the
 * spec prose, which listed "งานรอลูกค้า" third; the frame says "งานรออะไหล่").
 *
 * `now` is a parameter, not Date.now(), so the same rows always give the same
 * answer in a test and a clock is never read behind the caller's back.
 */
export function pulseOf(rows: readonly BoardJob[], bays: readonly BoardBay[], now: number): Pulse {
  const active = new Set(bays.filter((b) => b.isActive).map((b) => b.id));
  const onBoard = rows.filter((r) => kanbanColumnOf(r.status) !== null);

  const occupied = new Set<string>();
  for (const r of onBoard) {
    // onBoard never holds a delivered car (no column), so every bay here is
    // really occupied.
    if (r.bayId !== null && active.has(r.bayId)) occupied.add(r.bayId);
  }

  const today = BANGKOK_YMD.format(new Date(now));
  let waitTotal = 0;
  let waitCount = 0;
  for (const r of onBoard) {
    const arrived = Date.parse(r.createdAt);
    if (!Number.isFinite(arrived) || BANGKOK_YMD.format(new Date(arrived)) !== today) continue;
    let until: number;
    if (r.leftReceivedAt) {
      until = Date.parse(r.leftReceivedAt);
    } else if (r.status === 'received') {
      until = now;
    } else {
      // Moved on, but no history row says when (a job from before status
      // history was written). Unknown is not zero, and it is not "still
      // waiting" either — leave it out rather than invent a number.
      continue;
    }
    if (!Number.isFinite(until) || until < arrived) continue;
    waitTotal += until - arrived;
    waitCount++;
  }

  return {
    baysInUse: occupied.size,
    baysActive: active.size,
    avgInspectionWaitMinutes: waitCount === 0 ? null : Math.round(waitTotal / waitCount / 60000),
    waitingParts: onBoard.filter((r) => r.subState === 'waiting_parts').length,
    overSla: onBoard.filter((r) => slaOf(r, now)?.phase === 'late').length,
  };
}

// ============================================================================
// Drag and drop
// ============================================================================

export interface MovableJob {
  status: StatusKey;
  statusHistory?: StatusHistoryEntry[];
}

/**
 * May this job move from its current status to `to`?
 *
 * Nothing but a lookup in allowedMovesFrom() — THE transition table, in
 * workflow/transitions.ts. This is deliberately not a second table: the job
 * screen's buttons and the kanban's drag answer from the same place, so the
 * kanban can do nothing the job screen could not.
 *
 * In particular no drag can skip a step it is not allowed to skip: received
 * cannot jump to repairing, and a car cannot go from the lift back to "waiting
 * for the customer" in one move. The one skip that IS allowed —
 * repairing -> ready, past an alignment the car did not need — is in the table.
 *
 * NOTE FOR W3: CLAUDE.md §5 rule 5 forbids stepping a job back past a point
 * where a numbered document was issued. No documents exist in this release, so
 * there is nothing to check yet; when quotations land, the server must refuse
 * a backward move across an issued document BEFORE consulting this function.
 * Likewise §5 rule 4: once quotations exist, `quoted -> approved` must require
 * a signed quotation, checked on the server. Today it is a drag.
 */
export function canMoveTo(job: MovableJob, to: StatusKey): boolean {
  if (job.status === to) return false;
  return allowedMovesFrom({ status: job.status, statusHistory: job.statusHistory ?? [] }).includes(to);
}

/**
 * Where a card dropped on `column` actually lands, or null if it cannot.
 *
 * THE RULE: the column's statuses are tried in MAIN_PATH order and the first
 * one canMoveTo() allows wins. Written out for the moves that matter:
 *
 *   from quoted     onto column 3 -> approved     (the customer said yes; the three
 *                                                  exits — delivered, rejected, carout —
 *                                                  have no column, so no drag can make them)
 *   from approved   onto column 2 -> quoted       (the yes is withdrawn; back to deciding)
 *   from repairing  onto column 2 -> refused      (the step back from repairing is
 *   from aligning   onto column 2 -> refused       approved, which is still column 3)
 *   from inspecting onto column 3 -> refused      (nothing may skip the quote)
 *   from aligning   onto column 4 -> ready
 *   from repairing  onto column 4 -> ready        (alignment skipped — decision 7)
 *   from ready      onto column 3 -> repairing or aligning, whichever it came from
 *
 * A drop onto the job's OWN column returns null: a column holding several
 * statuses gives no way to say which one was meant, so moves inside a column
 * (approved -> repairing -> aligning) are made with an explicit status through
 * PATCH /api/jobs/:id/status, not by dragging — as are the exits.
 */
export function targetStatusForColumn(job: MovableJob, column: KanbanColumn): StatusKey | null {
  if (kanbanColumnOf(job.status) === column) return null;
  const def = KANBAN_COLUMNS.find((c) => c.column === column);
  if (!def) return null;
  for (const candidate of MAIN_PATH) {
    // A drop carries no reason, so a move that needs one (undoing a delivery)
    // is never a drop target — it is made from the job screen, with a reason.
    if (moveRequiresReason(job.status, candidate)) continue;
    if (def.statuses.includes(candidate) && canMoveTo(job, candidate)) return candidate;
  }
  return null;
}
