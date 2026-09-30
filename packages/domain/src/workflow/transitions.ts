import type { Job, StatusHistoryEntry } from '../types/job.js';
import {
  CAROUT_SOURCES,
  DECISION_KEYS,
  MAIN_PATH,
  STATUS_FLOW,
  TERMINAL_STATUSES,
  statusOf,
  type StatusDef,
  type StatusKey,
} from './statusFlow.js';

/**
 * How a job moves between its ten statuses.
 *
 * THE TRANSITION TABLE lives in allowedMovesFrom() below and nowhere else — the
 * job screen's buttons and the kanban's drag (rules/kanban.ts canMoveTo) both
 * read it. Written out:
 *
 *   from        forward                          back                 exit
 *   received    inspecting                       —                    carout
 *   inspecting  quoted                           received             carout
 *   quoted      approved                         inspecting           rejected
 *   approved    repairing                        quoted (undo "yes")  —
 *   repairing   aligning | ready  (skip align)   approved             —
 *   aligning    ready                            repairing            —
 *   ready       —                                repairing|aligning   delivered
 *                                                 (whichever it came from)
 *   delivered   —                                ready (undo, REASON REQUIRED)
 *   rejected    — terminal                       —                    —
 *   carout      — terminal                       —                    —
 *
 * The decisions that shape it:
 *   DECISION-carout.md (30 Sep 2026) — THREE INDEPENDENT EXITS, one source each:
 *       delivered from ready, rejected from quoted, carout from received or
 *       inspecting (before any quotation). This shop never lets a car leave
 *       mid-repair, so approved..ready have no carout. A customer who wants to
 *       come back later is `rejected` with the reason "ไว้ครั้งหน้า", and the
 *       return visit is a NEW job linked to this one — never a carout, never a
 *       reopened job. Undoing a mistaken delivered is allowed to the staff who
 *       may deliver, without waiting for a manager, but always with a reason.
 *   DECISION-7-today.md §6 — `scheduled` is gone: an appointment is a booking,
 *       never a job status. `rejected` is terminal.
 *   DECISION-7-today.md §7 — aligning is SKIPPABLE: repairing -> ready is legal.
 *       Forcing every car through a step that did not happen would make staff
 *       tap past it, and "average time waiting for alignment" would be a lie.
 */

export function isDecisionPoint(statusKey: string): boolean {
  return statusKey === 'quoted';
}

export function isTerminal(statusKey: string): boolean {
  return (TERMINAL_STATUSES as string[]).includes(statusKey);
}

/**
 * What the single "next step" button does. Null at a terminal status, and null
 * at the decision point (the decision buttons take over there).
 *
 * This is the DEFAULT forward step, not the only legal one: from `repairing`
 * the button still offers `aligning`, while allowedMovesFrom() also permits
 * going straight to `ready`.
 */
export function nextStatusOf(job: Pick<Job, 'status'>): StatusDef | null {
  const k = job.status;
  if (isDecisionPoint(k) || isTerminal(k)) return null;
  const i = MAIN_PATH.indexOf(k);
  if (i === -1 || i >= MAIN_PATH.length - 1) return null;
  return STATUS_FLOW.find((s) => s.key === MAIN_PATH[i + 1]) ?? null;
}

/**
 * The step back from the current status, or null.
 *
 * - `rejected` and `carout` are terminal: there is no step back out of them.
 * - `approved` steps back to `quoted` — the customer's "yes" taken back.
 * - `ready` steps back to the LAST WORKING STATUS the car was actually in —
 *   `repairing` or `aligning`, read from history — never to one it did not
 *   visit. Since aligning became skippable (decision 7), "the status before
 *   ready" is not a constant, and inventing an alignment the car never had is
 *   the one thing this must not do: it would write a step into the record that
 *   did not happen, and "time waiting for alignment" stops meaning anything.
 *
 *   Why "last working status", not "the entry just before the latest ready":
 *   a car can reach ready more than once. After ready -> delivered -> ready
 *   (a delivery undone), the entry before the latest ready is `delivered`,
 *   which says nothing about the work — the answer is further back.
 *
 *   When history does not say at all, the answer is `repairing`, NOT
 *   `aligning`: every car that reaches ready has been through repairing (only
 *   alignment is optional), so repairing is the one step back that can never
 *   invent something that did not happen. The earlier fallback to aligning —
 *   the MAIN_PATH predecessor — did exactly that, and was caught in review.
 * - everything else walks MAIN_PATH backwards.
 */
export function prevStatusOf(job: Pick<Job, 'status' | 'statusHistory'>): StatusDef | null {
  const k = job.status;
  if (k === 'rejected' || k === 'carout') return null;
  if (k === 'approved') return statusOf('quoted');
  if (k === 'ready') return statusOf(lastWorkingStatus(job.statusHistory ?? []) ?? 'repairing');
  const i = MAIN_PATH.indexOf(k);
  if (i <= 0) return null;
  return statusOf(MAIN_PATH[i - 1]!);
}

/** The most recent `repairing` or `aligning` in history — the last work the car actually had. */
function lastWorkingStatus(history: StatusHistoryEntry[]): 'repairing' | 'aligning' | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const s = history[i]?.status;
    if (s === 'repairing' || s === 'aligning') return s;
  }
  return null;
}

/**
 * Every status the job may move to next — THE transition table.
 * See the table at the top of this file.
 */
export function allowedMovesFrom(job: Pick<Job, 'status' | 'statusHistory'>): StatusKey[] {
  const k = job.status;
  if (k === 'rejected' || k === 'carout') return [];

  const moves = new Set<StatusKey>();
  const next = nextStatusOf(job);
  if (next) moves.add(next.key);
  const prev = prevStatusOf(job);
  if (prev) moves.add(prev.key);
  if (isDecisionPoint(k)) for (const d of DECISION_KEYS) moves.add(d);
  // Decision 7: alignment is optional.
  if (k === 'repairing') moves.add('ready');
  if (CAROUT_SOURCES.includes(k)) moves.add('carout');
  return [...moves];
}

/**
 * Must the person making this move say WHY?
 *
 * One move today: `delivered -> ready`, undoing a "ส่งแล้ว" pressed by mistake
 * (DECISION-carout.md §3). Delivered takes the card off every board at once,
 * so undoing it rewrites what the shop told itself had happened; the history
 * must show who undid it, when, and why. The API refuses the move without a
 * reason and the screen asks for one — both read THIS function, so they cannot
 * drift apart.
 */
export function moveRequiresReason(from: string, to: string): boolean {
  return from === 'delivered' && to === 'ready';
}

/**
 * Is this move one only the COUNTER may make — never the technician?
 *
 * CLAUDE.md §12.1 lets the technician update a job's status
 * ("อัปเดตสถานะงาน") but gives quoting and taking the customer's approval
 * ("ทำใบเสนอราคา / รับอนุมัติลูกค้า") to the counter alone. So the technician
 * is barred from exactly the customer's decision on the quote, in either
 * gesture:
 *
 *   quoted   -> approved | rejected   the customer's answer to the quote
 *   approved -> quoted                taking that answer back
 *
 * Everything else stays open to the technician, deliberately, including
 * carout (from received / inspecting), ready -> delivered, and undoing a
 * delivery — DECISION-carout.md §3 gives the undo to "the same roles that may
 * press delivered", and the owner has not restricted the technician from
 * either. Whether he should is an open question to the owner (30 Sep 2026);
 * if the answer is yes, it is one line here and nowhere else.
 */
export function isCounterOnlyMove(from: string, to: string): boolean {
  const decisions = DECISION_KEYS as readonly string[];
  if (from === 'quoted' && decisions.includes(to)) return true;
  if (decisions.includes(from) && to === 'quoted') return true;
  return false;
}
