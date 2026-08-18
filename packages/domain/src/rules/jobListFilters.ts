import type { Job } from '../types/job.js';
import { isRejectedCarout } from '../workflow/transitions.js';
import { dayKey, todayKey } from '../utils/date.js';

type ScopableJob = Pick<Job, 'status' | 'appointmentDate' | 'createdAt' | 'deletedAt'>;

export interface DayScopeOptions {
  dayFilter: string | null; // null/'all' = every day
  apptFilterOnly?: boolean;
}

/**
 * The main job list: not-yet-delivered, not a dead-end carout, newest first. Scoped to
 * one day by default — at 20-30 cars/day an unfiltered list stops being usable within a
 * week (see the original app's v2.6.0 changelog entry).
 */
export function dayScopedJobs<T extends ScopableJob>(jobs: T[], opts: DayScopeOptions): T[] {
  const active = jobs
    .filter((j) => !j.deletedAt)
    .filter((j) => j.status !== 'delivered' && !isRejectedCarout(j))
    .slice()
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  // The appointment banner needs to cut across day boundaries — a car checked in last
  // week with a today's-date appointment wouldn't show up under "today" otherwise,
  // since that view scopes by check-in date, not appointment date.
  if (opts.apptFilterOnly) {
    return active.filter((j) => j.appointmentDate && j.appointmentDate <= todayKey());
  }
  if (!opts.dayFilter || opts.dayFilter === 'all') return active;
  return active.filter((j) => dayKey(j.createdAt) === opts.dayFilter);
}

export function filterByStatus<T extends Pick<Job, 'status'>>(jobs: T[], statusFilter: string): T[] {
  if (statusFilter === 'all') return jobs;
  return jobs.filter((j) => j.status === statusFilter);
}
