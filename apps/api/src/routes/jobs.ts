import { Router } from 'express';
import type { Customer, Vehicle } from '@champpower/domain';
import { genJobNumber, genQueueNo, normalizePlateKey, todaysJobs } from '@champpower/domain';
import {
  createJob,
  getJobById,
  hardDeleteJob,
  listJobs,
  restoreJob,
  softDeleteJob,
  updateJob,
} from '../db/jobs.js';
import { createVehicle, getVehicleById } from '../db/vehicles.js';
import { createCustomer } from '../db/customers.js';
import { requireAuth, type AuthedRequest } from '../middleware/requireAuth.js';
import { requireAdmin } from '../middleware/requireAdmin.js';
import { emitAuthed, emitPublic } from '../lib/socket.js';

export const jobsRouter = Router();
jobsRouter.use(requireAuth);

async function broadcastJobChange(id: string): Promise<void> {
  const job = await getJobById(id);
  emitAuthed('job:changed', { id, job });
  emitPublic('board:changed');
  if (job) {
    const vehicle = await getVehicleById(job.vehicleId);
    if (vehicle?.plate) {
      emitPublic('lookup:changed', { plateKey: normalizePlateKey(vehicle.plate) });
    }
  }
}

jobsRouter.get('/', async (req, res) => {
  const includeDeleted = req.query.includeDeleted === '1' || req.query.includeDeleted === 'true';
  try {
    res.json(await listJobs(includeDeleted));
  } catch {
    res.status(500).json({ error: 'internal_error' });
  }
});

jobsRouter.get('/:id', async (req, res) => {
  try {
    const job = await getJobById(req.params.id!);
    if (!job) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.json(job);
  } catch {
    res.status(500).json({ error: 'internal_error' });
  }
});

jobsRouter.post('/', async (req, res) => {
  const body = req.body as {
    vehicleId?: string;
    customerId?: string;
    vehicle?: Omit<Vehicle, 'id' | 'customerId'>;
    customer?: Omit<Customer, 'id'>;
    mileageIn?: string;
    complaints?: { text: string; custom?: boolean }[];
  };

  // Check-in can either reference an existing vehicle/customer by id, or send
  // inline `vehicle`/`customer` objects for a brand-new car — validate up front
  // rather than letting a missing field surface as a confusing 500 later.
  if (!body.vehicleId && !body.vehicle) {
    res.status(400).json({ error: 'missing_vehicle' });
    return;
  }
  if (!body.customerId && !body.customer) {
    res.status(400).json({ error: 'missing_customer' });
    return;
  }
  if ((body.vehicleId && body.vehicle) || (body.customerId && body.customer)) {
    res.status(400).json({ error: 'ambiguous_vehicle_or_customer' });
    return;
  }

  try {
    let vehicleId = body.vehicleId;
    let customerId = body.customerId;

    if (body.customer) {
      const customer = await createCustomer(body.customer);
      customerId = customer.id;
    }
    if (body.vehicle) {
      const vehicle = await createVehicle({ ...body.vehicle, customerId: customerId! });
      vehicleId = vehicle.id;
    }

    const now = new Date();
    const existingJobs = await listJobs(true);
    const jobNumber = genJobNumber(existingJobs, now);
    const queueNo = genQueueNo(todaysJobs(existingJobs, now));
    const job = await createJob({
      vehicleId: vehicleId!,
      customerId: customerId!,
      mileageIn: body.mileageIn,
      jobNumber,
      queueNo,
      complaints: body.complaints,
      createdAt: now.toISOString(),
    });
    await broadcastJobChange(job.id);
    res.status(201).json(job);
  } catch {
    res.status(500).json({ error: 'internal_error' });
  }
});

jobsRouter.patch('/:id', async (req: AuthedRequest, res) => {
  try {
    const job = await updateJob(req.params.id!, { ...req.body, changedBy: req.authUser?.email });
    if (!job) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    await broadcastJobChange(job.id);
    res.json(job);
  } catch {
    res.status(500).json({ error: 'internal_error' });
  }
});

jobsRouter.delete('/:id', async (req: AuthedRequest, res) => {
  try {
    const ok = await softDeleteJob(req.params.id!, req.authUser?.email || '');
    if (!ok) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    await broadcastJobChange(req.params.id!);
    res.status(204).end();
  } catch {
    res.status(500).json({ error: 'internal_error' });
  }
});

jobsRouter.post('/:id/restore', async (req, res) => {
  try {
    const job = await restoreJob(req.params.id!);
    if (!job) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    await broadcastJobChange(job.id);
    res.json(job);
  } catch {
    res.status(500).json({ error: 'internal_error' });
  }
});

jobsRouter.delete('/:id/permanent', requireAdmin, async (req, res) => {
  try {
    const ok = await hardDeleteJob(req.params.id!);
    if (!ok) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    emitAuthed('job:changed', { id: req.params.id, job: null });
    emitPublic('board:changed');
    res.status(204).end();
  } catch {
    res.status(500).json({ error: 'internal_error' });
  }
});
