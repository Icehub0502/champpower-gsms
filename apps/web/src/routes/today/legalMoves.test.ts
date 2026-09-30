import { describe, expect, it } from 'vitest';
import type { StatusKey } from '@champpower/domain';
import { leavesBoard } from './legalMoves';

// Which moves exist is the server's (TodayJob.allowedMoves). This only checks
// which of them get the "this closes the job" confirmation.
describe('leavesBoard — which moves need the confirmation step', () => {
  it('ไม่อนุมัติ and เอารถลง close the job and leave the board', () => {
    expect(leavesBoard('rejected')).toBe(true);
    expect(leavesBoard('carout')).toBe(true);
  });

  it('ส่งแล้ว is undoable, so it is not in the "cannot be undone" set — it has its own dialog', () => {
    expect(leavesBoard('delivered')).toBe(false);
  });

  it('ordinary work moves do not ask', () => {
    for (const s of ['received', 'inspecting', 'quoted', 'approved', 'repairing', 'aligning', 'ready'] satisfies StatusKey[]) {
      expect(leavesBoard(s)).toBe(false);
    }
  });
});
