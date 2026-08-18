import type { Job } from '../types/job.js';
import { dayKey, dayLabel, shiftDay, todayKey } from '../utils/date.js';

/** Falls back to createdAt if the car was never actually marked delivered. */
export function deliveredAtOf(job: Pick<Job, 'statusHistory' | 'createdAt'>): string {
  const h = job.statusHistory || [];
  for (let i = h.length - 1; i >= 0; i--) {
    const entry = h[i];
    if (entry && entry.status === 'delivered') return entry.changedAt;
  }
  return job.createdAt;
}

export function warrantyEndDate(
  job: Pick<Job, 'warrantyDays' | 'statusHistory' | 'createdAt'> | null | undefined,
): string | null {
  if (!job || !job.warrantyDays) return null;
  return shiftDay(dayKey(deliveredAtOf(job)), job.warrantyDays);
}

export interface WarrantyStatus {
  cls: 'expired' | 'today' | 'active';
  label: string;
}

/** A chip-ready {cls, label}, or null if no warranty was ever set on this job. */
export function warrantyStatus(
  job: Pick<Job, 'warrantyDays' | 'statusHistory' | 'createdAt'> | null | undefined,
): WarrantyStatus | null {
  if (!job || !job.warrantyDays) return null;
  const end = warrantyEndDate(job);
  if (!end) return null;
  const today = todayKey();
  if (end < today) return { cls: 'expired', label: `หมดประกันแล้ว (${dayLabel(end)})` };
  if (end === today) return { cls: 'today', label: 'หมดประกันวันนี้' };
  return { cls: 'active', label: `ประกันถึง ${dayLabel(end)}` };
}
