import type { Job } from '../types/job.js';
import type { Vehicle } from '../types/vehicle.js';
import { statusOf } from '../workflow/statusFlow.js';
import { estLabel, estMinutes, repairEndedAt, repairStartedAt } from './eta.js';

export interface BoardEntry {
  queueNo: string;
  plate: string;
  province: string;
  brand: string;
  model: string;
  color: string;
  thumb: string;
  bay: string;
  est: string;
  estMins: number;
  workStart: string;
  workEnd: string;
  status: string;
  statusLabel: string;
  statusCls: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * The public waiting-room board only ever gets what a customer needs to find their own
 * car — queue number, full plate, make/model/colour, bay, live ETA, status, thumbnail.
 * Deliberately excludes name, phone, complaints, and price: those never leave this
 * function.
 */
export function boardPayloadFor(job: Job, vehicle: Vehicle | undefined, nowIso: string): BoardEntry {
  const st = statusOf(job.status);
  return {
    queueNo: job.queueNo || '',
    plate: vehicle?.plate || '',
    province: vehicle?.province || '',
    brand: vehicle?.brand || '',
    model: vehicle?.model || '',
    color: vehicle?.color || '',
    thumb: job.thumb || '',
    bay: job.bay || '',
    est: estLabel(job),
    estMins: estMinutes(job),
    workStart: repairStartedAt(job),
    workEnd: repairEndedAt(job),
    status: job.status || 'received',
    statusLabel: st.label,
    statusCls: st.cls,
    createdAt: job.createdAt || nowIso,
    updatedAt: nowIso,
  };
}
