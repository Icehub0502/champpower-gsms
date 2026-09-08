import { Router } from 'express';
import { boardPayloadFor, lookupPayloadFor, normalizePlateKey } from '@champpower/domain';
import { listJobs } from '../db/jobs.js';
import { getVehicleById } from '../db/vehicles.js';
import { getCustomerById } from '../db/customers.js';

export const publicRouter = Router();

/**
 * Public, no-login waiting-room board. Deliberately mirrors packages/domain's
 * boardPayloadFor() exactly — see apps/web/src/lib/firebase/board.ts (now removed) for
 * the privacy rationale: no customer name, phone, complaints, or price ever leaves
 * this endpoint.
 */
publicRouter.get('/board', async (_req, res) => {
  try {
    const jobs = await listJobs(false);
    const now = new Date().toISOString();
    const vehicleIds = Array.from(new Set(jobs.map((j) => j.vehicleId)));
    const vehicles = await Promise.all(vehicleIds.map((id) => getVehicleById(id)));
    const vehicleById = new Map(vehicleIds.map((id, i) => [id, vehicles[i] || undefined]));
    const entries = jobs.map((job) => boardPayloadFor(job, vehicleById.get(job.vehicleId), now));
    res.json(entries);
  } catch (err) {
    res.status(500).json({ error: 'internal_error' });
  }
});

/**
 * Public "find my car" lookup, reached via QR code. Mirrors lookupPayloadFor() exactly —
 * excludes phone, price, and everything else not meant for a stranger with the right
 * plate number to see.
 */
publicRouter.get('/lookup', async (req, res) => {
  const plate = typeof req.query.plate === 'string' ? req.query.plate : '';
  const plateKey = normalizePlateKey(plate);
  if (!plateKey) {
    res.status(400).json({ error: 'missing_plate' });
    return;
  }
  try {
    const jobs = await listJobs(false);
    let bestJob = null as (typeof jobs)[number] | null;
    let bestVehicle = undefined as Awaited<ReturnType<typeof getVehicleById>> | undefined;
    for (const job of jobs) {
      const vehicle = await getVehicleById(job.vehicleId);
      if (vehicle && normalizePlateKey(vehicle.plate) === plateKey) {
        if (!bestJob || job.createdAt > bestJob.createdAt) {
          bestJob = job;
          bestVehicle = vehicle;
        }
      }
    }
    if (!bestJob) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const customer = await getCustomerById(bestJob.customerId);
    const entry = lookupPayloadFor(bestJob, bestVehicle || undefined, customer || undefined, new Date().toISOString());
    res.json(entry);
  } catch (err) {
    res.status(500).json({ error: 'internal_error' });
  }
});
