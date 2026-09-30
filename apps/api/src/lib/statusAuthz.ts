/**
 * Who may move a job between statuses — the ROLE half of the question.
 *
 * Lives here, not in a route, because three doors ask it and must get the same
 * answer: GET /api/jobs/today (each card's allowedMoves), GET /api/jobs/:id
 * (the job screen's allowedMoves) and PATCH /api/jobs/:id/status (the 403).
 * If they ever used separate copies, a screen could offer a move the server
 * then refuses — exactly the drift allowedMoves exists to end. Whether the
 * move is legal for the JOB is the other half, answered by allowedMovesFrom() /
 * canMoveTo() in packages/domain.
 */
import { isCounterOnlyMove } from '@champpower/domain'

/**
 * CLAUDE.md §12.1: "อัปเดตสถานะงาน / ถ่ายรูป" is open to the technician as well
 * as the counter — the person at the lift is the one who knows the car moved on.
 */
export const STATUS_WRITE_ROLES = [
  'owner', 'manager', 'assistant_manager', 'advisor', 'technician',
] as const

/**
 * May a caller with this role make this move — as far as ROLE goes?
 *
 * The technician may move a car along the workshop but not make the
 * customer's decision on the quote (nor take it back) — packages/domain
 * isCounterOnlyMove(); the gate is on the ACT, not on the endpoint that
 * carries it. Every role in STATUS_WRITE_ROLES may make every other legal
 * move, so the roles that may press "ส่งแล้ว" are exactly the roles that may
 * undo it (DECISION-carout.md §3 — no waiting for a manager).
 */
export function roleMayMove(role: string, from: string, to: string): boolean {
  if (!(STATUS_WRITE_ROLES as readonly string[]).includes(role)) return false
  if (role === 'technician' && isCounterOnlyMove(from, to)) return false
  return true
}
