import { describe, expect, it } from 'vitest';
import { allowedMovesFrom, isTerminal, nextStatusOf, prevStatusOf } from './transitions.js';
import { CAROUT_SOURCES, DECISION_KEYS, STATUS_FLOW, type StatusKey } from './statusFlow.js';
import type { StatusHistoryEntry } from '../types/job.js';

function hist(...statuses: StatusKey[]): StatusHistoryEntry[] {
  return statuses.map((status, i) => ({ status, changedAt: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00Z` }));
}
const moves = (status: StatusKey, statusHistory: StatusHistoryEntry[] = []) =>
  allowedMovesFrom({ status, statusHistory }).slice().sort();

describe('the ten statuses (decision 6)', () => {
  it('has no scheduled status — an appointment is a booking, not a job', () => {
    expect(STATUS_FLOW.map((s) => s.key)).not.toContain('scheduled');
    expect(STATUS_FLOW).toHaveLength(10);
  });

  it('answers the quote with yes or no only', () => {
    expect(DECISION_KEYS).toEqual(['approved', 'rejected']);
  });
});

describe('nextStatusOf — the default forward button', () => {
  it('walks MAIN_PATH forward', () => {
    expect(nextStatusOf({ status: 'received' })?.key).toBe('inspecting');
    expect(nextStatusOf({ status: 'approved' })?.key).toBe('repairing');
    expect(nextStatusOf({ status: 'aligning' })?.key).toBe('ready');
  });

  it('still offers aligning from repairing — skipping is allowed, not the default', () => {
    expect(nextStatusOf({ status: 'repairing' })?.key).toBe('aligning');
  });

  it('is null at the decision point — the decision buttons take over', () => {
    expect(nextStatusOf({ status: 'quoted' })).toBeNull();
  });

  it('is null at every terminal status', () => {
    expect(nextStatusOf({ status: 'delivered' })).toBeNull();
    expect(nextStatusOf({ status: 'rejected' })).toBeNull();
    expect(nextStatusOf({ status: 'carout' })).toBeNull();
  });
});

describe('rejected is terminal (decision 6)', () => {
  it('goes nowhere — no rejected -> carout any more, no step back', () => {
    expect(isTerminal('rejected')).toBe(true);
    expect(isTerminal('carout')).toBe(true);
    expect(moves('rejected')).toEqual([]);
    expect(prevStatusOf({ status: 'rejected', statusHistory: hist('quoted', 'rejected') })).toBeNull();
  });

  it('carout is terminal too, and stays a distinct status', () => {
    expect(moves('carout')).toEqual([]);
    expect(prevStatusOf({ status: 'carout', statusHistory: hist('quoted', 'carout') })).toBeNull();
  });
});

describe('delivered is finished, not terminal (code review MEDIUM)', () => {
  it('is not in the terminal set, and can step back to ready', () => {
    // Column 4 holds ready and delivered; a mis-drag must be undoable until a
    // numbered receipt exists (WO-005 will add that refusal).
    expect(isTerminal('delivered')).toBe(false);
    expect(moves('delivered')).toEqual(['ready']);
  });

  it('still has no forward move', () => {
    expect(nextStatusOf({ status: 'delivered' })).toBeNull();
  });
});

describe('carout sources', () => {
  it('any open status up to and including aligning may end in carout', () => {
    for (const s of ['received', 'inspecting', 'quoted', 'approved', 'repairing', 'aligning'] as const) {
      expect(moves(s), `${s} should allow carout`).toContain('carout');
    }
    expect(CAROUT_SOURCES).toHaveLength(6);
  });

  it('ready may NOT — a finished car leaving is delivered, and never owing', () => {
    expect(moves('ready')).not.toContain('carout');
  });

  it('terminal statuses may not', () => {
    expect(moves('delivered')).not.toContain('carout');
    expect(moves('rejected')).not.toContain('carout');
  });
});

describe('aligning is skippable (decision 7)', () => {
  it('repairing may go straight to ready', () => {
    expect(moves('repairing')).toContain('ready');
    expect(moves('repairing')).toContain('aligning');
  });

  it('ready steps back to repairing when it came straight from repairing', () => {
    const statusHistory = hist('received', 'inspecting', 'quoted', 'approved', 'repairing', 'ready');
    expect(prevStatusOf({ status: 'ready', statusHistory })?.key).toBe('repairing');
  });

  it('ready steps back to aligning when it went through alignment', () => {
    const statusHistory = hist('received', 'inspecting', 'quoted', 'approved', 'repairing', 'aligning', 'ready');
    expect(prevStatusOf({ status: 'ready', statusHistory })?.key).toBe('aligning');
  });

  it('reads the LATEST arrival at ready, not the first', () => {
    // First pass went through aligning; the car was sent back and then
    // finished straight from repairing.
    const statusHistory = hist('repairing', 'aligning', 'ready', 'repairing', 'ready');
    expect(prevStatusOf({ status: 'ready', statusHistory })?.key).toBe('repairing');
  });

  it('falls back to REPAIRING when history does not say — never invents an alignment', () => {
    // Code review, HIGH: this used to fall back to aligning, recording an
    // alignment the car may never have had — the exact lie decision 7 exists to
    // prevent. Every car reaching ready went through repairing; only alignment
    // is optional, so repairing is the fallback that cannot fabricate a step.
    expect(prevStatusOf({ status: 'ready', statusHistory: [] })?.key).toBe('repairing');
  });

  it('after a delivery is undone, looks past delivered to the real work — no alignment', () => {
    // Code review, HIGH, second case: the entry before the latest ready is
    // delivered, which says nothing about the work done.
    const statusHistory = hist('received', 'inspecting', 'quoted', 'approved', 'repairing', 'ready', 'delivered', 'ready');
    expect(prevStatusOf({ status: 'ready', statusHistory })?.key).toBe('repairing');
  });

  it('after a delivery is undone, still finds an alignment that DID happen', () => {
    const statusHistory = hist('repairing', 'aligning', 'ready', 'delivered', 'ready');
    expect(prevStatusOf({ status: 'ready', statusHistory })?.key).toBe('aligning');
  });
});

describe('the whole table', () => {
  it('matches the table written in transitions.ts', () => {
    expect(moves('received')).toEqual(['carout', 'inspecting']);
    expect(moves('inspecting')).toEqual(['carout', 'quoted', 'received']);
    expect(moves('quoted')).toEqual(['approved', 'carout', 'inspecting', 'rejected']);
    expect(moves('approved')).toEqual(['carout', 'quoted', 'repairing']);
    expect(moves('repairing')).toEqual(['aligning', 'approved', 'carout', 'ready']);
    expect(moves('aligning')).toEqual(['carout', 'ready', 'repairing']);
    expect(moves('ready', hist('repairing', 'ready'))).toEqual(['delivered', 'repairing']);
    expect(moves('delivered')).toEqual(['ready']);
  });
});
