import { describe, expect, it } from 'vitest';
import {
  canMoveTo,
  cardLabelOf,
  isValidSubState,
  kanbanColumnOf,
  kpisOf,
  pulseOf,
  slaOf,
  SUB_STATE_LABEL,
  subStateAfterMove,
  targetStatusForColumn,
  type BoardJob,
} from './kanban.js';
import { statusOf } from '../workflow/statusFlow.js';

// 2026-09-23 10:00 in Bangkok (UTC+7).
const NOW = Date.parse('2026-09-23T03:00:00Z');
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

function row(overrides: Partial<BoardJob> = {}): BoardJob {
  return {
    status: 'received',
    subState: null,
    bayId: null,
    createdAt: minutesAgo(30),
    leftReceivedAt: null,
    repairStartedAt: null,
    repairEndedAt: null,
    estValue: null,
    estUnit: null,
    ...overrides,
  };
}

describe('kanbanColumnOf', () => {
  it('maps the seven in-workshop statuses onto four columns', () => {
    expect(kanbanColumnOf('received')).toBe(1);
    expect(kanbanColumnOf('inspecting')).toBe(2);
    expect(kanbanColumnOf('quoted')).toBe(2);
    expect(kanbanColumnOf('repairing')).toBe(3);
    expect(kanbanColumnOf('aligning')).toBe(3);
    expect(kanbanColumnOf('ready')).toBe(4);
  });

  it('column 4 is ready only — delivered leaves the board the moment it is pressed (DECISION-carout.md)', () => {
    expect(kanbanColumnOf('delivered')).toBeNull();
  });

  it('puts approved in column 3, NOT column 2 where the Figma frame draws it', () => {
    // DECISION-job-status.md §2. Column 2's KPI is "รอลูกค้าตัดสินใจ" and an
    // approved job is one where the customer HAS decided. In column 2 it would
    // inflate that count and send staff to phone customers who already said
    // yes. If this test fails because someone "fixed" the column to match the
    // picture, the fix is wrong — put it back.
    expect(kanbanColumnOf('approved')).toBe(3);
  });

  it('gives the two closed-early statuses no column — they are real, just terminal', () => {
    expect(kanbanColumnOf('rejected')).toBeNull();
    expect(kanbanColumnOf('carout')).toBeNull();
    expect(kanbanColumnOf('not_a_status')).toBeNull();
  });
});

describe('the inspecting label', () => {
  it('is spelled with ก as in the design', () => {
    expect(statusOf('inspecting').label).toBe('ตรวจเช็ก');
  });
});

describe('isValidSubState', () => {
  it('always accepts null — no sub-state is the default', () => {
    for (const s of ['received', 'quoted', 'delivered', 'rejected']) {
      expect(isValidSubState(s, null)).toBe(true);
    }
  });

  it('allows the pairs in the table', () => {
    expect(isValidSubState('quoted', 'quote_sent')).toBe(true);
    expect(isValidSubState('inspecting', 'call_customer')).toBe(true);
    expect(isValidSubState('approved', 'waiting_parts')).toBe(true);
    expect(isValidSubState('repairing', 'waiting_parts')).toBe(true);
    expect(isValidSubState('repairing', 'waiting_qc')).toBe(true);
    expect(isValidSubState('aligning', 'waiting_wash')).toBe(true);
    expect(isValidSubState('ready', 'paid')).toBe(true);
    expect(isValidSubState('ready', 'call_customer')).toBe(true);
    expect(isValidSubState('delivered', 'paid')).toBe(true);
  });

  it('refuses sub-states that describe a different moment', () => {
    expect(isValidSubState('received', 'waiting_customer')).toBe(false);
    // A sent quote means the job IS quoted; move the status, do not label around it.
    expect(isValidSubState('inspecting', 'quote_sent')).toBe(false);
    expect(isValidSubState('quoted', 'paid')).toBe(false);
    expect(isValidSubState('repairing', 'quote_sent')).toBe(false);
    expect(isValidSubState('delivered', 'waiting_parts')).toBe(false);
  });

  it('allows nothing on the statuses that are not kanban columns', () => {
    expect(isValidSubState('rejected', 'call_customer')).toBe(false);
    expect(isValidSubState('carout', 'waiting_customer')).toBe(false);
  });

  it('refuses a value outside the enum', () => {
    expect(isValidSubState('quoted', 'sent')).toBe(false);
    expect(isValidSubState('quoted', '')).toBe(false);
  });
});

describe('subStateAfterMove', () => {
  it('keeps a sub-state that still makes sense', () => {
    expect(subStateAfterMove('repairing', 'waiting_parts')).toBe('waiting_parts');
  });

  it('drops one describing a moment the job has moved past', () => {
    // quoted -> approved: "ส่งราคาแล้ว" is no longer the situation.
    expect(subStateAfterMove('approved', 'quote_sent')).toBeNull();
  });

  it('leaves null as null', () => {
    expect(subStateAfterMove('ready', null)).toBeNull();
  });
});

describe('cardLabelOf — the four-step priority', () => {
  const booking = '2026-09-23T02:00:00Z'; // 09:00 in Bangkok

  it('1. a sub-state wins over everything else', () => {
    expect(cardLabelOf({ subState: 'call_customer', bayName: 'H2', bookingSlotStart: booking }))
      .toEqual({ text: 'ต้องโทร', tone: 'red' });
  });

  it('2. then the bay', () => {
    expect(cardLabelOf({ subState: null, bayName: 'H2', bookingSlotStart: booking }))
      .toEqual({ text: 'ช่อง H2', tone: 'blue' });
  });

  it('3. then the booking time, in Bangkok, whatever zone the machine is in', () => {
    expect(cardLabelOf({ subState: null, bayName: null, bookingSlotStart: booking }))
      .toEqual({ text: 'นัด 09:00', tone: 'red' });
  });

  it('4. otherwise Walk-in', () => {
    expect(cardLabelOf({ subState: null, bayName: null, bookingSlotStart: null }))
      .toEqual({ text: 'Walk-in', tone: 'orange' });
  });

  it('says ส่งราคาแล้ว, never ส่งแล้ว, for a sent quote', () => {
    // "ส่งแล้ว" is the delivered status; two cards with the same word meaning
    // opposite things is how staff misread a busy board.
    expect(SUB_STATE_LABEL.quote_sent).toBe('ส่งราคาแล้ว');
    expect(cardLabelOf({ subState: 'quote_sent', bayName: null, bookingSlotStart: null }).text)
      .not.toBe(statusOf('delivered').label);
  });

  it('gives each tone its meaning', () => {
    const tone = (s: string) => cardLabelOf({ subState: s, bayName: null, bookingSlotStart: null }).tone;
    expect(tone('waiting_parts')).toBe('orange');
    expect(tone('waiting_customer')).toBe('orange');
    expect(tone('quote_sent')).toBe('blue');
    expect(tone('paid')).toBe('green');
  });

  it('falls through an unknown sub-state rather than printing it', () => {
    expect(cardLabelOf({ subState: 'garbage', bayName: 'H1', bookingSlotStart: null }).text).toBe('ช่อง H1');
  });
});

describe('kpisOf — counted from statuses, never from the design', () => {
  it('reproduces the decision\'s arithmetic when nothing has been delivered', () => {
    const rows = [
      ...Array.from({ length: 3 }, () => ({ status: 'received' })),
      ...Array.from({ length: 4 }, () => ({ status: 'inspecting' })),
      ...Array.from({ length: 2 }, () => ({ status: 'quoted' })),
      ...Array.from({ length: 6 }, () => ({ status: 'repairing' })),
      ...Array.from({ length: 3 }, () => ({ status: 'ready' })),
    ];
    // 18 = 3 + 6 + 6 + 3, the four columns.
    expect(kpisOf(rows)).toEqual({ openJobs: 18, awaitingDecision: 6, inRepair: 6, readyForHandover: 3 });
  });

  it('counts an approved job as repair work, not as waiting for a decision', () => {
    expect(kpisOf([{ status: 'approved' }])).toMatchObject({ awaitingDecision: 0, inRepair: 1 });
  });

  it('does not count a delivered car as open, or as waiting to pay', () => {
    expect(kpisOf([{ status: 'ready' }, { status: 'delivered' }]))
      .toEqual({ openJobs: 1, awaitingDecision: 0, inRepair: 0, readyForHandover: 1 });
  });

  it('counts readyForHandover as column 4 exactly, and openJobs as the sum of the columns', () => {
    const k = kpisOf([
      { status: 'received' }, { status: 'quoted' }, { status: 'approved' }, { status: 'ready' }, { status: 'ready' },
    ]);
    expect(k.readyForHandover).toBe(2);
    expect(k.openJobs).toBe(5);
  });

  it('ignores the three exits — none is on the kanban', () => {
    expect(kpisOf([{ status: 'carout' }, { status: 'rejected' }, { status: 'delivered' }])).toEqual({
      openJobs: 0, awaitingDecision: 0, inRepair: 0, readyForHandover: 0,
    });
  });
});

describe('slaOf — eta.ts\'s definition, not a new one', () => {
  const onLift = (startedMinutesAgo: number, est: number) =>
    row({ status: 'repairing', repairStartedAt: minutesAgo(startedMinutesAgo), estValue: est, estUnit: 'minute' });

  it('has no SLA at all without an estimate', () => {
    expect(slaOf(row({ status: 'repairing', repairStartedAt: minutesAgo(600) }), NOW)).toBeNull();
  });

  it('is running inside the estimate', () => {
    expect(slaOf(onLift(20, 60), NOW)?.phase).toBe('running');
  });

  it('is late once the estimate has run out on the lift', () => {
    expect(slaOf(onLift(90, 60), NOW)?.phase).toBe('late');
  });

  it('counts from the lift, not from check-in', () => {
    // Estimated, but not on the lift yet: the clock has not started, however
    // long ago the car arrived.
    const waiting = row({ status: 'approved', createdAt: minutesAgo(600), estValue: 30, estUnit: 'minute' });
    expect(slaOf(waiting, NOW)?.phase).toBe('pending');
  });

  it('freezes once the work has finished', () => {
    const done = row({
      status: 'ready', repairStartedAt: minutesAgo(200), repairEndedAt: minutesAgo(10),
      estValue: 60, estUnit: 'minute',
    });
    expect(slaOf(done, NOW)?.phase).toBe('done');
  });

  it('has no clock for a job sent back before repair, even with old repair times', () => {
    // eta.ts's own rule, applied by eta.ts: back in a pre-repair status = no clock.
    const sentBack = row({ status: 'quoted', repairStartedAt: minutesAgo(300), estValue: 30, estUnit: 'minute' });
    expect(slaOf(sentBack, NOW)?.phase).toBe('pending');
  });
});

describe('pulseOf', () => {
  const bays = [
    { id: 'b1', isActive: true },
    { id: 'b2', isActive: true },
    { id: 'b3', isActive: true },
    { id: 'old', isActive: false },
  ];

  it('counts a bay once however many cars share it, and never a car off the board', () => {
    const p = pulseOf([
      row({ status: 'repairing', bayId: 'b1' }),
      row({ status: 'aligning', bayId: 'b1' }),       // two cars, one bay: allowed, counted once
      row({ status: 'delivered', bayId: 'b2' }),      // gone
      row({ status: 'received', bayId: 'old' }),      // an inactive bay is not capacity
    ], bays, NOW);
    expect(p.baysInUse).toBe(1);
    expect(p.baysActive).toBe(3);
  });

  it('averages the wait for inspection over today\'s cars only, counting still-waiting cars to now', () => {
    const p = pulseOf([
      row({ status: 'inspecting', createdAt: minutesAgo(60), leftReceivedAt: minutesAgo(40) }), // 20
      row({ status: 'received', createdAt: minutesAgo(40) }),                                   // 40, still waiting
      // Arrived yesterday (Bangkok) and still here — stays on the board, but is
      // not one of TODAY'S arrivals, so it does not drag today's average.
      row({ status: 'received', createdAt: minutesAgo(60 * 24) }),
    ], bays, NOW);
    expect(p.avgInspectionWaitMinutes).toBe(30);
  });

  it('leaves out a car whose departure from received was never recorded', () => {
    const p = pulseOf([
      row({ status: 'repairing', createdAt: minutesAgo(50), leftReceivedAt: null }),
      row({ status: 'inspecting', createdAt: minutesAgo(30), leftReceivedAt: minutesAgo(20) }),
    ], bays, NOW);
    expect(p.avgInspectionWaitMinutes).toBe(10);
  });

  it('reports null, not zero, when no car arrived today', () => {
    expect(pulseOf([], bays, NOW).avgInspectionWaitMinutes).toBeNull();
  });

  it('counts waiting-for-parts and over-SLA cars', () => {
    const p = pulseOf([
      row({ status: 'approved', subState: 'waiting_parts' }),
      row({ status: 'repairing', subState: 'waiting_parts' }),
      row({ status: 'repairing', repairStartedAt: minutesAgo(120), estValue: 1, estUnit: 'hour' }),  // late
      row({ status: 'repairing', repairStartedAt: minutesAgo(30), estValue: 1, estUnit: 'hour' }),   // running
      row({ status: 'repairing', repairStartedAt: minutesAgo(900) }),                                // no estimate
    ], bays, NOW);
    expect(p.waitingParts).toBe(2);
    expect(p.overSla).toBe(1);
  });
});

describe('canMoveTo — built on transitions.ts', () => {
  it('allows the next step and the step back', () => {
    expect(canMoveTo({ status: 'received' }, 'inspecting')).toBe(true);
    expect(canMoveTo({ status: 'inspecting' }, 'received')).toBe(true);
    expect(canMoveTo({ status: 'repairing' }, 'aligning')).toBe(true);
    expect(canMoveTo({ status: 'ready' }, 'delivered')).toBe(true);
  });

  it('allows both quote decisions from quoted, and nothing called scheduled', () => {
    expect(canMoveTo({ status: 'quoted' }, 'approved')).toBe(true);
    expect(canMoveTo({ status: 'quoted' }, 'rejected')).toBe(true);
  });

  it('lets an approval be taken back to quoted, but never a rejection', () => {
    expect(canMoveTo({ status: 'approved' }, 'quoted')).toBe(true);
    // Decision 6: rejected is terminal. No step back, no step on to carout.
    expect(canMoveTo({ status: 'rejected' }, 'quoted')).toBe(false);
    expect(canMoveTo({ status: 'rejected' }, 'carout')).toBe(false);
  });

  it('allows skipping alignment — repairing straight to ready (decision 7)', () => {
    expect(canMoveTo({ status: 'repairing' }, 'ready')).toBe(true);
  });

  it('allows carout only before a quote exists (DECISION-carout.md)', () => {
    expect(canMoveTo({ status: 'received' }, 'carout')).toBe(true);
    expect(canMoveTo({ status: 'inspecting' }, 'carout')).toBe(true);
    for (const s of ['quoted', 'approved', 'repairing', 'aligning', 'ready'] as const) {
      expect(canMoveTo({ status: s }, 'carout'), s).toBe(false);
    }
  });

  it('refuses anything else that skips a step', () => {
    expect(canMoveTo({ status: 'received' }, 'repairing')).toBe(false);
    expect(canMoveTo({ status: 'inspecting' }, 'approved')).toBe(false);
    expect(canMoveTo({ status: 'repairing' }, 'quoted')).toBe(false);
    expect(canMoveTo({ status: 'approved' }, 'ready')).toBe(false);
  });

  it('refuses a move to where the job already is', () => {
    expect(canMoveTo({ status: 'repairing' }, 'repairing')).toBe(false);
  });

  it('refuses leaving delivered forward — it is the end of the road', () => {
    expect(canMoveTo({ status: 'delivered' }, 'carout')).toBe(false);
  });
});

describe('targetStatusForColumn — the drop rule', () => {
  it('quoted dropped on column 3 is an approval', () => {
    expect(targetStatusForColumn({ status: 'quoted' }, 3)).toBe('approved');
  });

  it('approved dropped back on column 2 withdraws the yes and returns to quoted', () => {
    expect(targetStatusForColumn({ status: 'approved' }, 2)).toBe('quoted');
  });

  it('refuses taking a car off the lift straight back to waiting for the customer', () => {
    expect(targetStatusForColumn({ status: 'repairing' }, 2)).toBeNull();
    expect(targetStatusForColumn({ status: 'aligning' }, 2)).toBeNull();
  });

  it('refuses skipping the quote', () => {
    expect(targetStatusForColumn({ status: 'inspecting' }, 3)).toBeNull();
    expect(targetStatusForColumn({ status: 'received' }, 3)).toBeNull();
  });

  it('moves forward and back across one column boundary', () => {
    expect(targetStatusForColumn({ status: 'received' }, 2)).toBe('inspecting');
    expect(targetStatusForColumn({ status: 'inspecting' }, 1)).toBe('received');
    expect(targetStatusForColumn({ status: 'aligning' }, 4)).toBe('ready');
    // No history: back to repairing, never an invented alignment (see transitions.ts).
    expect(targetStatusForColumn({ status: 'ready' }, 3)).toBe('repairing');
    const aligned = [
      { status: 'aligning' as const, changedAt: '2026-01-01T00:00:00Z' },
      { status: 'ready' as const, changedAt: '2026-01-02T00:00:00Z' },
    ];
    expect(targetStatusForColumn({ status: 'ready', statusHistory: aligned }, 3)).toBe('aligning');
  });

  it('lands repairing dropped on column 4 on ready — alignment skipped (decision 7)', () => {
    expect(targetStatusForColumn({ status: 'repairing' }, 4)).toBe('ready');
  });

  it('sends ready back to where it actually came from', () => {
    const cameFromRepairing = [
      { status: 'repairing' as const, changedAt: '2026-01-01T00:00:00Z' },
      { status: 'ready' as const, changedAt: '2026-01-02T00:00:00Z' },
    ];
    expect(targetStatusForColumn({ status: 'ready', statusHistory: cameFromRepairing }, 3)).toBe('repairing');
  });

  it('gives no target for a drop onto the job\'s own column', () => {
    // A multi-status column cannot say which status was meant.
    expect(targetStatusForColumn({ status: 'approved' }, 3)).toBeNull();
    expect(targetStatusForColumn({ status: 'ready' }, 4)).toBeNull();
  });

  it('never makes undoing a delivery a drop — that move needs a reason', () => {
    expect(targetStatusForColumn({ status: 'delivered' }, 4)).toBeNull();
    expect(targetStatusForColumn({ status: 'delivered' }, 3)).toBeNull();
  });
});
