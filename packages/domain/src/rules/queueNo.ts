import type { Job } from '../types/job.js';
import { dayKey } from '../utils/date.js';

/**
 * Next queue number for today, sequential starting at 1. Takes the max of today's
 * existing numbers rather than a plain count, so a manually-corrected or skipped
 * number never gets reused by the next car checked in.
 */
export function genQueueNo(todayJobs: Pick<Job, 'queueNo'>[]): string {
  const nums = todayJobs
    .map((j) => parseInt(j.queueNo || '', 10))
    .filter((n) => Number.isFinite(n) && n > 0);
  const max = nums.length ? Math.max(...nums) : 0;
  return String(max + 1);
}

/** Jobs checked in today, the scope genQueueNo should be given. */
export function todaysJobs<T extends { createdAt: string }>(jobs: T[], now: Date = new Date()): T[] {
  const key = dayKey(now);
  return jobs.filter((j) => dayKey(j.createdAt) === key);
}
