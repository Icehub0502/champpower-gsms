import { describe, expect, it } from 'vitest';
import {
  allowedMovesFrom,
  isCounterOnlyMove,
  isTerminal,
  moveRequiresReason,
  nextStatusOf,
  prevStatusOf,
} from './transitions.js';
import {
  CAROUT_SOURCES,
  DECISION_KEYS,
  EXIT_STATUSES,
  STATUS_FLOW,
  type StatusKey,
} from './statusFlow.js';
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

const ALL = STATUS_FLOW.map((s) => s.key);
// ready's step back depends on history; give every status the same history so
// the "who may move to X" sweeps below see ready's real moves.
const READY_HIST = hist('repairing', 'ready');
const sourcesOf = (to: StatusKey) => ALL.filter((k) => moves(k, READY_HIST).includes(to));

describe('delivered is an exit, but may be undone (DECISION-carout.md §3)', () => {
  it('is not in the terminal set, and can step back to ready', () => {
    expect(isTerminal('delivered')).toBe(false);
    expect(moves('delivered')).toEqual(['ready']);
  });

  it('still has no forward move', () => {
    expect(nextStatusOf({ status: 'delivered' })).toBeNull();
  });

  it('comes from ready only', () => {
    expect(sourcesOf('delivered')).toEqual(['ready']);
  });
});

describe('three independent exits (DECISION-carout.md §1)', () => {
  it('are delivered, rejected and carout', () => {
    expect(EXIT_STATUSES.slice().sort()).toEqual(['carout', 'delivered', 'rejected']);
  });

  it('rejected comes from quoted only', () => {
    expect(sourcesOf('rejected')).toEqual(['quoted']);
  });

  it('no exit leads to another exit — none is a step after another', () => {
    for (const e of EXIT_STATUSES) {
      for (const other of EXIT_STATUSES) expect(moves(e), `${e} -> ${other}`).not.toContain(other);
    }
  });
});

describe('carout — only before a quotation exists (DECISION-carout.md §1)', () => {
  it('received and inspecting may end in carout, and nothing else may', () => {
    expect(CAROUT_SOURCES).toEqual(['received', 'inspecting']);
    expect(sourcesOf('carout')).toEqual(['received', 'inspecting']);
  });

  it('quoted onwards may not — a refused quote is rejected, and no car leaves mid-repair', () => {
    for (const s of ['quoted', 'approved', 'repairing', 'aligning', 'ready', 'delivered', 'rejected', 'carout'] as const) {
      expect(moves(s, READY_HIST), `${s} must not allow carout`).not.toContain('carout');
    }
  });
});

describe('moveRequiresReason', () => {
  it('requires a reason to undo a delivery', () => {
    expect(moveRequiresReason('delivered', 'ready')).toBe(true);
  });

  it('requires none for any other legal move', () => {
    for (const from of ALL) {
      for (const to of moves(from, READY_HIST)) {
        if (from === 'delivered' && to === 'ready') continue;
        expect(moveRequiresReason(from, to), `${from} -> ${to}`).toBe(false);
      }
    }
  });
});

describe('isCounterOnlyMove — what the technician may not do', () => {
  it('covers the quote decision and taking it back', () => {
    expect(isCounterOnlyMove('quoted', 'approved')).toBe(true);
    expect(isCounterOnlyMove('quoted', 'rejected')).toBe(true);
    expect(isCounterOnlyMove('approved', 'quoted')).toBe(true);
  });

  it('does NOT cover carout, delivering or undoing a delivery — the owner has not restricted those', () => {
    expect(isCounterOnlyMove('received', 'carout')).toBe(false);
    expect(isCounterOnlyMove('inspecting', 'carout')).toBe(false);
    expect(isCounterOnlyMove('ready', 'delivered')).toBe(false);
    expect(isCounterOnlyMove('delivered', 'ready')).toBe(false);
  });

  it('covers nothing but the quote decision among all legal moves', () => {
    for (const from of ALL) {
      for (const to of moves(from, READY_HIST)) {
        const decision = (from === 'quoted' && (to === 'approved' || to === 'rejected'))
          || (from === 'approved' && to === 'quoted');
        expect(isCounterOnlyMove(from, to), `${from} -> ${to}`).toBe(decision);
      }
    }
  });

  it('leaves moving a car along the workshop to the technician, unchanged', () => {
    const open: [StatusKey, StatusKey][] = [
      ['received', 'inspecting'], ['inspecting', 'received'], ['inspecting', 'quoted'],
      ['quoted', 'inspecting'], ['approved', 'repairing'], ['repairing', 'approved'],
      ['repairing', 'aligning'], ['repairing', 'ready'], ['aligning', 'ready'],
      ['aligning', 'repairing'], ['ready', 'repairing'], ['ready', 'aligning'],
    ];
    for (const [from, to] of open) expect(isCounterOnlyMove(from, to), `${from} -> ${to}`).toBe(false);
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
    expect(moves('quoted')).toEqual(['approved', 'inspecting', 'rejected']);
    expect(moves('approved')).toEqual(['quoted', 'repairing']);
    expect(moves('repairing')).toEqual(['aligning', 'approved', 'ready']);
    expect(moves('aligning')).toEqual(['ready', 'repairing']);
    expect(moves('ready', hist('repairing', 'ready'))).toEqual(['delivered', 'repairing']);
    expect(moves('delivered')).toEqual(['ready']);
    expect(moves('rejected')).toEqual([]);
    expect(moves('carout')).toEqual([]);
  });
});
