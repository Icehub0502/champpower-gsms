import type { PoolConnection } from 'mysql2/promise';
import type {
  Complaint,
  Job,
  JobNote,
  JobSignatures,
  PartNeeded,
  StatusHistoryEntry,
  TechnicianHistoryEntry,
} from '@champpower/domain';
import { pool } from './pool.js';
import { newId } from '../lib/ids.js';

interface JobRow {
  id: string;
  job_number: string;
  queue_no: string | null;
  vehicle_id: string;
  customer_id: string;
  mileage_in: string | null;
  status: string;
  technician: string | null;
  bay: string | null;
  appointment_date: Date | null;
  price_estimate: string | null;
  discount_type: 'amount' | 'percent' | null;
  discount_value: string | null;
  est_value: string | null;
  est_unit: 'minute' | 'hour' | 'day' | null;
  warranty_days: number | null;
  signature_inspector: string | null;
  signature_quoter: string | null;
  signature_customer: string | null;
  thumb: string | null;
  photo_count: number;
  created_at: Date;
  deleted_at: Date | null;
  deleted_by: string | null;
}

function toIso(d: Date | null): string {
  return d ? new Date(d).toISOString() : '';
}

async function loadNested(jobIds: string[]): Promise<{
  statusHistory: Map<string, StatusHistoryEntry[]>;
  technicianHistory: Map<string, TechnicianHistoryEntry[]>;
  complaints: Map<string, Complaint[]>;
  parts: Map<string, PartNeeded[]>;
  notes: Map<string, JobNote[]>;
}> {
  const statusHistory = new Map<string, StatusHistoryEntry[]>();
  const technicianHistory = new Map<string, TechnicianHistoryEntry[]>();
  const complaints = new Map<string, Complaint[]>();
  const parts = new Map<string, PartNeeded[]>();
  const notes = new Map<string, JobNote[]>();
  if (jobIds.length === 0) return { statusHistory, technicianHistory, complaints, parts, notes };

  const [shRows] = await pool.query(
    `SELECT job_id, status, changed_at FROM job_status_history WHERE job_id IN (?) ORDER BY sort_order ASC, changed_at ASC`,
    [jobIds],
  );
  for (const r of shRows as { job_id: string; status: string; changed_at: Date }[]) {
    const list = statusHistory.get(r.job_id) || [];
    list.push({ status: r.status as StatusHistoryEntry['status'], changedAt: toIso(r.changed_at) });
    statusHistory.set(r.job_id, list);
  }

  const [thRows] = await pool.query(
    `SELECT job_id, name, changed_at, changed_by FROM job_technician_history WHERE job_id IN (?) ORDER BY sort_order ASC, changed_at ASC`,
    [jobIds],
  );
  for (const r of thRows as { job_id: string; name: string; changed_at: Date; changed_by: string | null }[]) {
    const list = technicianHistory.get(r.job_id) || [];
    list.push({ name: r.name, changedAt: toIso(r.changed_at), changedBy: r.changed_by || undefined });
    technicianHistory.set(r.job_id, list);
  }

  const [cRows] = await pool.query(
    `SELECT job_id, text, custom FROM job_complaints WHERE job_id IN (?) ORDER BY sort_order ASC`,
    [jobIds],
  );
  for (const r of cRows as { job_id: string; text: string; custom: number }[]) {
    const list = complaints.get(r.job_id) || [];
    list.push({ text: r.text, custom: !!r.custom });
    complaints.set(r.job_id, list);
  }

  const [pRows] = await pool.query(
    `SELECT id, job_id, name, qty, unit, price, brand, note FROM job_parts_needed WHERE job_id IN (?) ORDER BY sort_order ASC`,
    [jobIds],
  );
  const partRows = pRows as {
    id: string;
    job_id: string;
    name: string;
    qty: string | null;
    unit: string | null;
    price: string | null;
    brand: string | null;
    note: string | null;
  }[];
  const partIds = partRows.map((p) => p.id);
  const photosByPart = new Map<string, string[]>();
  if (partIds.length > 0) {
    const [phRows] = await pool.query(
      `SELECT part_id, photo FROM job_part_photos WHERE part_id IN (?) ORDER BY sort_order ASC`,
      [partIds],
    );
    for (const r of phRows as { part_id: string; photo: string }[]) {
      const list = photosByPart.get(r.part_id) || [];
      list.push(r.photo);
      photosByPart.set(r.part_id, list);
    }
  }
  for (const r of partRows) {
    const list = parts.get(r.job_id) || [];
    list.push({
      id: r.id,
      name: r.name,
      qty: r.qty || undefined,
      unit: r.unit || undefined,
      price: r.price || undefined,
      brand: r.brand || undefined,
      note: r.note || undefined,
      photos: photosByPart.get(r.id) || undefined,
    });
    parts.set(r.job_id, list);
  }

  const [nRows] = await pool.query(
    `SELECT job_id, text, \`at\`, \`by\` FROM job_notes WHERE job_id IN (?) ORDER BY sort_order ASC, \`at\` ASC`,
    [jobIds],
  );
  for (const r of nRows as { job_id: string; text: string; at: Date; by: string | null }[]) {
    const list = notes.get(r.job_id) || [];
    list.push({ text: r.text, at: toIso(r.at), by: r.by || undefined });
    notes.set(r.job_id, list);
  }

  return { statusHistory, technicianHistory, complaints, parts, notes };
}

function rowToJob(
  row: JobRow,
  nested: Awaited<ReturnType<typeof loadNested>>,
): Job {
  const signatures: JobSignatures | undefined =
    row.signature_inspector || row.signature_quoter || row.signature_customer
      ? {
          inspector: row.signature_inspector || undefined,
          quoter: row.signature_quoter || undefined,
          customer: row.signature_customer || undefined,
        }
      : undefined;

  return {
    id: row.id,
    jobNumber: row.job_number,
    queueNo: row.queue_no || undefined,
    vehicleId: row.vehicle_id,
    customerId: row.customer_id,
    mileageIn: row.mileage_in || undefined,
    status: row.status as Job['status'],
    statusHistory: nested.statusHistory.get(row.id) || [],
    technician: row.technician || undefined,
    technicianHistory: nested.technicianHistory.get(row.id) || undefined,
    bay: row.bay || undefined,
    appointmentDate: row.appointment_date ? toIso(row.appointment_date) : null,
    complaints: nested.complaints.get(row.id) || [],
    partsNeeded: nested.parts.get(row.id) || [],
    priceEstimate: row.price_estimate || undefined,
    discountType: row.discount_type || undefined,
    discountValue: row.discount_value || undefined,
    estValue: row.est_value || undefined,
    estUnit: row.est_unit || undefined,
    warrantyDays: row.warranty_days ?? undefined,
    signatures,
    notes: nested.notes.get(row.id) || undefined,
    thumb: row.thumb || undefined,
    photoCount: row.photo_count || undefined,
    createdAt: toIso(row.created_at),
    deletedAt: row.deleted_at ? toIso(row.deleted_at) : null,
    deletedBy: row.deleted_by || undefined,
  };
}

export async function listJobs(includeDeleted: boolean): Promise<Job[]> {
  const [rows] = await pool.query(
    includeDeleted
      ? `SELECT * FROM jobs ORDER BY created_at DESC`
      : `SELECT * FROM jobs WHERE deleted_at IS NULL ORDER BY created_at DESC`,
  );
  const jobRows = rows as JobRow[];
  const nested = await loadNested(jobRows.map((r) => r.id));
  return jobRows.map((r) => rowToJob(r, nested));
}

export async function getJobById(id: string): Promise<Job | null> {
  const [rows] = await pool.query(`SELECT * FROM jobs WHERE id = ?`, [id]);
  const jobRows = rows as JobRow[];
  if (jobRows.length === 0) return null;
  const nested = await loadNested([id]);
  return rowToJob(jobRows[0]!, nested);
}

export interface CreateJobInput {
  vehicleId: string;
  customerId: string;
  mileageIn?: string;
  jobNumber: string;
  queueNo?: string;
  complaints?: Complaint[];
  createdAt: string;
}

export async function createJob(input: CreateJobInput): Promise<Job> {
  const id = newId();
  const createdAt = new Date(input.createdAt);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(
      `INSERT INTO jobs (id, job_number, queue_no, vehicle_id, customer_id, mileage_in, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'received', ?)`,
      [id, input.jobNumber, input.queueNo || null, input.vehicleId, input.customerId, input.mileageIn || null, createdAt],
    );
    await conn.query(
      `INSERT INTO job_status_history (id, job_id, status, changed_at, sort_order) VALUES (?, ?, 'received', ?, 0)`,
      [newId(), id, createdAt],
    );
    let order = 0;
    for (const c of input.complaints || []) {
      await conn.query(`INSERT INTO job_complaints (id, job_id, text, custom, sort_order) VALUES (?, ?, ?, ?, ?)`, [
        newId(),
        id,
        c.text,
        c.custom ? 1 : 0,
        order++,
      ]);
    }
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
  const job = await getJobById(id);
  return job!;
}

export interface UpdateJobInput {
  status?: Job['status'];
  technician?: string;
  changedBy?: string;
  bay?: string | null;
  appointmentDate?: string | null;
  mileageIn?: string;
  complaints?: Complaint[];
  partsNeeded?: PartNeeded[];
  priceEstimate?: number | string;
  discountType?: 'amount' | 'percent' | null;
  discountValue?: number | string | null;
  estValue?: number | string;
  estUnit?: 'minute' | 'hour' | 'day';
  warrantyDays?: number;
  signatures?: JobSignatures;
  notes?: JobNote[];
  thumb?: string;
  photoCount?: number;
}

async function replaceComplaints(conn: PoolConnection, jobId: string, complaints: Complaint[]): Promise<void> {
  await conn.query(`DELETE FROM job_complaints WHERE job_id = ?`, [jobId]);
  let order = 0;
  for (const c of complaints) {
    await conn.query(`INSERT INTO job_complaints (id, job_id, text, custom, sort_order) VALUES (?, ?, ?, ?, ?)`, [
      newId(),
      jobId,
      c.text,
      c.custom ? 1 : 0,
      order++,
    ]);
  }
}

async function replaceParts(conn: PoolConnection, jobId: string, parts: PartNeeded[]): Promise<void> {
  await conn.query(`DELETE FROM job_parts_needed WHERE job_id = ?`, [jobId]);
  let order = 0;
  for (const p of parts) {
    const partId = p.id || newId();
    await conn.query(
      `INSERT INTO job_parts_needed (id, job_id, name, qty, unit, price, brand, note, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [partId, jobId, p.name, p.qty || null, p.unit || null, p.price || null, p.brand || null, p.note || null, order++],
    );
    let photoOrder = 0;
    for (const photo of p.photos || []) {
      await conn.query(`INSERT INTO job_part_photos (id, part_id, photo, sort_order) VALUES (?, ?, ?, ?)`, [
        newId(),
        partId,
        photo,
        photoOrder++,
      ]);
    }
  }
}

async function replaceNotes(conn: PoolConnection, jobId: string, notes: JobNote[]): Promise<void> {
  await conn.query(`DELETE FROM job_notes WHERE job_id = ?`, [jobId]);
  let order = 0;
  for (const n of notes) {
    await conn.query(`INSERT INTO job_notes (id, job_id, text, \`at\`, \`by\`, sort_order) VALUES (?, ?, ?, ?, ?, ?)`, [
      newId(),
      jobId,
      n.text,
      new Date(n.at),
      n.by || null,
      order++,
    ]);
  }
}

export async function updateJob(id: string, patch: UpdateJobInput): Promise<Job | null> {
  const existing = await getJobById(id);
  if (!existing) return null;

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const sets: string[] = [];
    const values: unknown[] = [];

    if (patch.status !== undefined && patch.status !== existing.status) {
      sets.push('status = ?');
      values.push(patch.status);
      await conn.query(
        `INSERT INTO job_status_history (id, job_id, status, changed_at, sort_order) VALUES (?, ?, ?, ?, ?)`,
        [newId(), id, patch.status, new Date(), existing.statusHistory.length],
      );
    }
    if (patch.technician !== undefined && patch.technician !== existing.technician) {
      sets.push('technician = ?');
      values.push(patch.technician || null);
      await conn.query(
        `INSERT INTO job_technician_history (id, job_id, name, changed_at, changed_by, sort_order) VALUES (?, ?, ?, ?, ?, ?)`,
        [newId(), id, patch.technician, new Date(), patch.changedBy || null, (existing.technicianHistory || []).length],
      );
    }
    if (patch.bay !== undefined) {
      sets.push('bay = ?');
      values.push(patch.bay || null);
    }
    if (patch.appointmentDate !== undefined) {
      sets.push('appointment_date = ?');
      values.push(patch.appointmentDate ? new Date(patch.appointmentDate) : null);
    }
    if (patch.mileageIn !== undefined) {
      sets.push('mileage_in = ?');
      values.push(patch.mileageIn || null);
    }
    if (patch.priceEstimate !== undefined) {
      sets.push('price_estimate = ?');
      values.push(String(patch.priceEstimate));
    }
    if (patch.discountType !== undefined) {
      sets.push('discount_type = ?');
      values.push(patch.discountType);
    }
    if (patch.discountValue !== undefined) {
      sets.push('discount_value = ?');
      values.push(patch.discountValue === null ? null : String(patch.discountValue));
    }
    if (patch.estValue !== undefined) {
      sets.push('est_value = ?');
      values.push(String(patch.estValue));
    }
    if (patch.estUnit !== undefined) {
      sets.push('est_unit = ?');
      values.push(patch.estUnit);
    }
    if (patch.warrantyDays !== undefined) {
      sets.push('warranty_days = ?');
      values.push(patch.warrantyDays);
    }
    if (patch.signatures !== undefined) {
      sets.push('signature_inspector = ?', 'signature_quoter = ?', 'signature_customer = ?');
      values.push(patch.signatures.inspector || null, patch.signatures.quoter || null, patch.signatures.customer || null);
    }
    if (patch.thumb !== undefined) {
      sets.push('thumb = ?');
      values.push(patch.thumb || null);
    }
    if (patch.photoCount !== undefined) {
      sets.push('photo_count = ?');
      values.push(patch.photoCount);
    }

    if (sets.length > 0) {
      values.push(id);
      await conn.query(`UPDATE jobs SET ${sets.join(', ')} WHERE id = ?`, values);
    }

    if (patch.complaints !== undefined) await replaceComplaints(conn, id, patch.complaints);
    if (patch.partsNeeded !== undefined) await replaceParts(conn, id, patch.partsNeeded);
    if (patch.notes !== undefined) await replaceNotes(conn, id, patch.notes);

    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }

  return getJobById(id);
}

export async function softDeleteJob(id: string, deletedBy: string): Promise<boolean> {
  const [result] = await pool.query(`UPDATE jobs SET deleted_at = ?, deleted_by = ? WHERE id = ? AND deleted_at IS NULL`, [
    new Date(),
    deletedBy,
    id,
  ]);
  return (result as { affectedRows: number }).affectedRows > 0;
}

export async function restoreJob(id: string): Promise<Job | null> {
  await pool.query(`UPDATE jobs SET deleted_at = NULL, deleted_by = NULL WHERE id = ?`, [id]);
  return getJobById(id);
}

export async function hardDeleteJob(id: string): Promise<boolean> {
  const [result] = await pool.query(`DELETE FROM jobs WHERE id = ?`, [id]);
  return (result as { affectedRows: number }).affectedRows > 0;
}

export async function todaysJobNumbers(prefix: string): Promise<number> {
  const [rows] = await pool.query(`SELECT COUNT(*) AS cnt FROM jobs WHERE job_number LIKE ?`, [`${prefix}%`]);
  return (rows as { cnt: number }[])[0]!.cnt;
}

export async function todaysMaxQueueNo(dayStart: Date, dayEnd: Date): Promise<number> {
  const [rows] = await pool.query(
    `SELECT queue_no FROM jobs WHERE created_at >= ? AND created_at < ? AND queue_no IS NOT NULL`,
    [dayStart, dayEnd],
  );
  const nums = (rows as { queue_no: string }[])
    .map((r) => parseInt(r.queue_no, 10))
    .filter((n) => Number.isFinite(n) && n > 0);
  return nums.length ? Math.max(...nums) : 0;
}
