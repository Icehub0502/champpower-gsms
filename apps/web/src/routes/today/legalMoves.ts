import { isTerminal, kanbanColumnOf, type StatusKey } from '@champpower/domain';

// Which moves a card may make is NOT decided here any more: the server sends
// each card's `allowedMoves` (packages/contracts today.ts), computed from the
// job's real status history and the caller's role. The tap menu and the drop
// targets read that list only. This file just classifies a move the server
// already allowed.

/**
 * A move that closes the job for good AND takes the card off the board — today
 * exactly ไม่อนุมัติ (rejected) and เอารถลง (carout). These get the sheet's own
 * confirmation step, which says they cannot be undone.
 *
 * `delivered` is NOT here, and the reason is not "it stays on the board" (it
 * does not: since DECISION-carout.md it leaves at once, and kanbanColumnOf is
 * null for it too). It is not TERMINAL — a mistaken ส่งแล้ว can be undone from
 * the "ส่งแล้ววันนี้" panel — so it does not get the "cannot be undone" wording.
 * It has its own confirmation (DeliverConfirmDialog, "ยืนยันว่ารถออกจากอู่แล้ว").
 * Terminal with no kanban column is the exact set here.
 */
export function leavesBoard(to: StatusKey): boolean {
  return isTerminal(to) && kanbanColumnOf(to) === null;
}
