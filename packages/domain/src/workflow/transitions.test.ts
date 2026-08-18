import { describe, expect, it } from 'vitest';
import { isAppointmentReturn, isRejectedCarout, nextStatusOf, prevStatusOf } from './transitions.js';
import type { StatusHistoryEntry } from '../types/job.js';

function hist(...statuses: string[]): StatusHistoryEntry[] {
  return statuses.map((status, i) => ({ status: status as never, changedAt: `2026-01-0${i + 1}T00:00:00Z` }));
}

describe('nextStatusOf — straight path', () => {
  it('walks MAIN_PATH forward', () => {
    expect(nextStatusOf({ status: 'received' })?.key).toBe('inspecting');
    expect(nextStatusOf({ status: 'approved' })?.key).toBe('repairing');
    expect(nextStatusOf({ status: 'aligning' })?.key).toBe('ready');
  });

  it('returns null at the end of the main path (delivered)', () => {
    expect(nextStatusOf({ status: 'delivered' })).toBeNull();
  });
});

describe('nextStatusOf — decision point', () => {
  it('returns null at เสนอราคา — the 3 decision buttons take over, not a single next button', () => {
    expect(nextStatusOf({ status: 'quoted' })).toBeNull();
  });
});

describe('nextStatusOf — branch ends', () => {
  it('scheduled -> carout', () => {
    expect(nextStatusOf({ status: 'scheduled' })?.key).toBe('carout');
  });
  it('rejected -> carout', () => {
    expect(nextStatusOf({ status: 'rejected' })?.key).toBe('carout');
  });
});

describe('nextStatusOf — appointment return', () => {
  it('carout WITH an appointmentDate resumes into repairing (customer brought the car back)', () => {
    expect(nextStatusOf({ status: 'carout', appointmentDate: '2026-08-20' })?.key).toBe('repairing');
  });
  it('carout with NO appointmentDate is a dead end (came from ไม่อนุมัติ)', () => {
    expect(nextStatusOf({ status: 'carout', appointmentDate: null })).toBeNull();
  });
});

describe('isAppointmentReturn / isRejectedCarout', () => {
  it('are mutually exclusive on carout', () => {
    expect(isAppointmentReturn({ status: 'carout', appointmentDate: '2026-08-20' })).toBe(true);
    expect(isRejectedCarout({ status: 'carout', appointmentDate: '2026-08-20' })).toBe(false);

    expect(isAppointmentReturn({ status: 'carout', appointmentDate: null })).toBe(false);
    expect(isRejectedCarout({ status: 'carout', appointmentDate: null })).toBe(true);
  });

  it('are both false off carout', () => {
    expect(isAppointmentReturn({ status: 'received', appointmentDate: '2026-08-20' })).toBe(false);
    expect(isRejectedCarout({ status: 'received', appointmentDate: null })).toBe(false);
  });
});

describe('prevStatusOf — straight path', () => {
  it('walks MAIN_PATH backward', () => {
    expect(prevStatusOf({ status: 'inspecting', statusHistory: [] })?.key).toBe('received');
    expect(prevStatusOf({ status: 'repairing', statusHistory: [] })?.key).toBe('approved');
  });

  it('returns null at received (start of the road)', () => {
    expect(prevStatusOf({ status: 'received', statusHistory: [] })).toBeNull();
  });
});

describe('prevStatusOf — decision keys collapse back to quoted', () => {
  it('approved / scheduled / rejected all step back to เสนอราคา', () => {
    expect(prevStatusOf({ status: 'approved', statusHistory: [] })?.key).toBe('quoted');
    expect(prevStatusOf({ status: 'scheduled', statusHistory: [] })?.key).toBe('quoted');
    expect(prevStatusOf({ status: 'rejected', statusHistory: [] })?.key).toBe('quoted');
  });
});

describe('prevStatusOf — carout has two possible predecessors', () => {
  it('reads history to find whichever decision actually led here (scheduled)', () => {
    const statusHistory = hist('received', 'inspecting', 'quoted', 'scheduled', 'carout');
    expect(prevStatusOf({ status: 'carout', statusHistory })?.key).toBe('scheduled');
  });

  it('reads history to find whichever decision actually led here (rejected)', () => {
    const statusHistory = hist('received', 'inspecting', 'quoted', 'rejected', 'carout');
    expect(prevStatusOf({ status: 'carout', statusHistory })?.key).toBe('rejected');
  });

  it('falls back to quoted if history is empty/missing the decision', () => {
    expect(prevStatusOf({ status: 'carout', statusHistory: [] })?.key).toBe('quoted');
  });
});
