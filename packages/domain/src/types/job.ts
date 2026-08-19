import type { StatusKey } from '../workflow/statusFlow.js';

export interface StatusHistoryEntry {
  status: StatusKey;
  changedAt: string; // ISO timestamp
}

export interface TechnicianHistoryEntry {
  name: string;
  changedAt: string;
  changedBy?: string;
}

export interface Complaint {
  text: string;
  custom?: boolean;
}

/** A priced line item on the job's quote — one brand/price per row, per the schema. */
export interface PartNeeded {
  id: string;
  name: string;
  qty?: string;
  unit?: string;
  price?: string;
  brand?: string;
  note?: string;
  photo?: string; // data:image/jpeg;base64,... — the replaced part, shown to the customer
}

export interface JobSignatures {
  inspector?: string; // data:image/png;base64,...
  quoter?: string;
  customer?: string;
}

export interface JobNote {
  text: string;
  at: string;
  by?: string;
}

export interface Job {
  id: string;
  jobNumber: string;
  queueNo?: string;
  vehicleId: string;
  customerId: string;
  mileageIn?: string;
  status: StatusKey;
  statusHistory: StatusHistoryEntry[];
  technician?: string;
  technicianHistory?: TechnicianHistoryEntry[];
  bay?: string;
  appointmentDate?: string | null;
  complaints: Complaint[];
  partsNeeded: PartNeeded[];
  priceEstimate?: number | string;
  discountType?: 'amount' | 'percent';
  discountValue?: number | string;
  estValue?: number | string;
  estUnit?: 'minute' | 'hour' | 'day';
  warrantyDays?: number;
  signatures?: JobSignatures;
  notes?: JobNote[];
  thumb?: string;
  photoCount?: number;
  createdAt: string;
  deletedAt?: string | null;
  deletedBy?: string;
}
