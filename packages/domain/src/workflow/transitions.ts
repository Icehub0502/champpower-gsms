import type { Job } from '../types/job.js';
import { BRANCH_ENDS, DECISION_KEYS, MAIN_PATH, STATUS_FLOW, statusOf, type StatusDef } from './statusFlow.js';

export function isDecisionPoint(statusKey: string): boolean {
  return statusKey === 'quoted';
}

/**
 * เอารถลง after a นัดวันมาทำ isn't really an end state — it's "car's at home, waiting
 * for the appointment date". Once the customer actually brings it back in, there needs
 * to be a next step. A carout job with an appointmentDate still on it (not yet cleared
 * by resumeFromAppointment) is exactly that waiting state; one that came from ไม่อนุมัติ
 * instead has no appointmentDate and correctly stays a dead end.
 */
export function isAppointmentReturn(job: Pick<Job, 'status' | 'appointmentDate'>): boolean {
  return job.status === 'carout' && !!job.appointmentDate;
}

/**
 * The dead-end version — carout with no appointment on it, meaning the road there was
 * ไม่อนุมัติ, not นัดวันมาทำ. These move to their own page (like delivered jobs do)
 * instead of sitting in the main list with nothing left to do.
 */
export function isRejectedCarout(job: Pick<Job, 'status' | 'appointmentDate'>): boolean {
  return job.status === 'carout' && !job.appointmentDate;
}

/**
 * What the single "next step" button should do. Returns null at an end state, and
 * null at the decision point (the three decision buttons take over there).
 */
export function nextStatusOf(job: Pick<Job, 'status' | 'appointmentDate'>): StatusDef | null {
  const k = job.status;
  if (isDecisionPoint(k)) return null;
  if (isAppointmentReturn(job)) return statusOf('repairing');
  const branchEnd = BRANCH_ENDS[k];
  if (branchEnd) return STATUS_FLOW.find((s) => s.key === branchEnd) ?? null;
  const i = MAIN_PATH.indexOf(k);
  if (i === -1 || i >= MAIN_PATH.length - 1) return null;
  return STATUS_FLOW.find((s) => s.key === MAIN_PATH[i + 1]) ?? null;
}

/**
 * The mirror of nextStatusOf: what "back one step" means from the current status.
 * Walks MAIN_PATH backwards so repeated back-taps keep chaining all the way to รับรถ
 * instead of bouncing between two entries. carout is the one case with two possible
 * predecessors (นัดวันมาทำ or ไม่อนุมัติ), so that single step checks history to see
 * which decision actually led here.
 */
export function prevStatusOf(job: Pick<Job, 'status' | 'statusHistory'>): StatusDef | null {
  const k = job.status;
  if (k === 'carout') {
    const h = job.statusHistory || [];
    for (let i = h.length - 2; i >= 0; i--) {
      const entry = h[i];
      if (entry && (entry.status === 'scheduled' || entry.status === 'rejected')) {
        return statusOf(entry.status);
      }
    }
    return statusOf('quoted');
  }
  if (DECISION_KEYS.includes(k)) return statusOf('quoted');
  const i = MAIN_PATH.indexOf(k);
  if (i <= 0) return null;
  return statusOf(MAIN_PATH[i - 1]!);
}
