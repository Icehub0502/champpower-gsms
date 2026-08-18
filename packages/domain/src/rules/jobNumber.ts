import type { Job } from '../types/job.js';

/**
 * PGyymmdd-NNN, sequential per day. Pure function version of the original genJobNumber:
 * takes today's job list and "now" explicitly instead of reading global state, so it can
 * be unit tested and run on the server without a DOM.
 */
export function genJobNumber(existingJobs: Pick<Job, 'jobNumber'>[], now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const ymd = `${String(now.getFullYear()).slice(2)}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const prefix = `PG${ymd}`;
  const todayCount = existingJobs.filter((j) => j.jobNumber?.startsWith(prefix)).length;
  return `${prefix}-${String(todayCount + 1).padStart(3, '0')}`;
}
