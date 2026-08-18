import type { Job } from '../types/job.js';

/** 11 general lifts (H1-H11) plus the wheel-alignment rack. */
export const ALIGN_BAY = 'ตั้งศูนย์';
export const WORK_BAYS = ['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'H7', 'H8', 'H9', 'H10', 'H11', ALIGN_BAY];

/**
 * A car can only be in one bay at a time. Delivered jobs don't hold a bay even if the
 * field was never cleared, so the floor view doesn't lie about what's actually parked.
 */
export function jobInBay(
  activeJobs: Pick<Job, 'id' | 'bay' | 'status'>[],
  bay: string,
  excludeJobId?: string,
): Pick<Job, 'id' | 'bay' | 'status'> | null {
  return activeJobs.find((j) => j.bay === bay && j.id !== excludeJobId && j.status !== 'delivered') ?? null;
}
