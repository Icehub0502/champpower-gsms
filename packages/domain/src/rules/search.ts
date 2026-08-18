import type { Job } from '../types/job.js';
import type { Customer, Vehicle } from '../types/vehicle.js';

/**
 * Everything about a job that someone might type into the search box, as one string.
 * Model matters as much as the plate — staff often remember "the white Vios" long
 * before they remember four digits. Spaces/dashes are stripped from the plate copy so
 * "6กข 3896" and "6กข3896" both hit.
 */
export function jobSearchBlob(
  job: Pick<Job, 'jobNumber' | 'bay' | 'technician'>,
  vehicle: Partial<Vehicle> | undefined,
  customer: Partial<Customer> | undefined,
): string {
  const plate = vehicle?.plate || '';
  return [
    job.jobNumber,
    job.bay,
    job.technician,
    plate,
    plate.replace(/[\s-]/g, ''),
    vehicle?.province,
    vehicle?.brand,
    vehicle?.model,
    vehicle?.color,
    customer?.name,
    customer?.phone,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

/** Every word must appear somewhere, in any order — "honda ขาว" and "ขาว honda" both match. */
export function matchesSearch(blob: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const terms = q.split(/\s+/).filter(Boolean);
  return terms.every((t) => blob.includes(t));
}
