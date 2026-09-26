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
 * How a job moves between its ten statuses (DECISION-7-today.md, 24 Sep 2026).
 *
 * THE TRANSITION TABLE lives in allowedMovesFrom() below and nowhere else — the
 * job screen's buttons and the kanban's drag (rules/kanban.ts canMoveTo) both
 * read it. Written out:
 *
 *   from        forward                          back                 carout?
 *   received    inspecting                       —                    yes
 *   inspecting  quoted                           received             yes
 *   quoted      approved | rejected  (decision)  inspecting           yes
 *   approved    repairing                        quoted (undo "yes")  yes
 *   repairing   aligning | ready  (skip align)   approved             yes
 *   aligning    ready                            repairing            yes
 *   ready       delivered                        repairing|aligning   no
 *                                                 (whichever it came from)
 *   delivered   —                                ready                —
 *   rejected    — terminal                       —                    —
 *   carout      — terminal                       —                    —
 *
 * Two decisions shape it:
 *   §6  `scheduled` is gone — an appointment is a booking, never a job status.
 *       `rejected` is terminal (no rejected -> carout any more).
 *   §7  aligning is SKIPPABLE: repairing -> ready is legal. Forcing every car
 *       through a step that did not happen would make staff tap past it, and
 *       from that day "average time waiting for alignment" would be a lie.
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
