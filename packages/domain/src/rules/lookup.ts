import type { Job } from '../types/job.js';
import type { Customer, Vehicle } from '../types/vehicle.js';

/** Doc id for the public lookup collection — plate text, case/space-insensitive so
 * "1กข 1234" and "1กข1234" resolve to the same record. */
export function normalizePlateKey(plate: string): string {
  return (plate || '').replace(/\s+/g, '').toUpperCase();
}

export interface LookupPart {
  name: string;
  qty?: string;
  unit?: string;
  brand?: string;
  photos?: string[];
}

/**
 * Public, no-login record a customer reaches by scanning a QR code and typing their
 * own plate — deliberately excludes phone, price, and everything else jobs/vehicles/
 * customers carries that isn't meant for a stranger with the right plate number to
 * see. Mirrors the board's boardPayloadFor() pattern: this is the only function
 * allowed to shape what ends up in /lookup/{plateKey}.
 */
export interface LookupEntry {
  jobId: string;
  plate: string;
  province: string;
  brand: string;
  model: string;
  color: string;
  customerName: string;
  status: string;
  photo: string;
  parts: LookupPart[];
  updatedAt: string;
}

export function lookupPayloadFor(
  job: Job,
  vehicle: Vehicle | undefined,
  customer: Customer | undefined,
  now: string,
): LookupEntry {
  return {
    jobId: job.id,
    plate: vehicle?.plate || '',
    province: vehicle?.province || '',
    brand: vehicle?.brand || '',
    model: vehicle?.model || '',
    color: vehicle?.color || '',
    customerName: customer?.name || '',
    status: job.status,
    photo: job.thumb || '',
    parts: (job.partsNeeded || []).map((p) => ({
      name: p.name,
      qty: p.qty,
      unit: p.unit,
      brand: p.brand,
      photos: p.photos,
    })),
    updatedAt: now,
  };
}
