import type { Job } from '../types/job.js';
import { isTerminal } from '../workflow/transitions.js';
import { dayKey, todayKey } from '../utils/date.js';

type ScopableJob = Pick<Job, 'status' | 'appointmentDate' | 'createdAt' | 'deletedAt'>;

export interface DayScopeOptions {
  dayFilter: string | null; // null/'all' = every day
  apptFilterOnly?: boolean;
}

/**
 * The main job list: open jobs only, newest first. Scoped to one day by default — at
 * 20-30 cars/day an unfiltered list stops being usable within a week (see the original
 * app's v2.6.0 changelog entry).
 *
 * "Open" = not delivered and not terminal (rejected, carout). `delivered` is named on its
 * own because it is finished but NOT terminal — it can still step back to ready — so
 * isTerminal() alone would leave delivered jobs in this list.
 *
 * Every carout is closed now: before decision 6 a carout WITH an appointment was a car at
 * home waiting to return, and stayed in this list. That state no longer exists — a return
 * visit is a booking, and arrives as a new job.
 */
export function dayScopedJobs<T extends ScopableJob>(jobs: T[], opts: DayScopeOptions): T[] {
  const active = jobs
    .filter((j) => !j.deletedAt)
    .filter((j) => j.status !== 'delivered' && !isTerminal(j.status))
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
