import { isTerminal, kanbanColumnOf, type StatusKey } from '@champpower/domain';

// Which moves a card may make is NOT decided here any more: the server sends
// each card's `allowedMoves` (packages/contracts today.ts), computed from the
// job's real status history and the caller's role. The tap menu and the drop
// targets read that list only. This file just classifies a move the server
// already allowed.

/**
 * A move that closes the job AND takes the card off the board — today exactly
 * ไม่อนุมัติ (rejected) and เอารถลง (carout). These get a confirmation step.
 *
 * Terminal alone is not enough: `delivered` is terminal too, but it stays on
 * the board (column 4, dimmed for the day), so ส่งแล้ว — the most ordinary
 * move on the board — must not ask "are you sure this car is leaving?".
 * Terminal with no kanban column is the exact set.
 */
export function leavesBoard(to: StatusKey): boolean {
  return isTerminal(to) && kanbanColumnOf(to) === null;
}
