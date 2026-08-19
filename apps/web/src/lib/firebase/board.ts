import { doc, setDoc } from 'firebase/firestore';
import {
  boardPayloadFor,
  lookupPayloadFor,
  normalizePlateKey,
  type Customer,
  type Job,
  type Vehicle,
} from '@champpower/domain';
import { db } from './client';

/**
 * TEMPORARY: written directly by the client. The intended design (see the migration
 * plan's Phase 8) is a Firestore trigger Cloud Function (onJobWrite) that owns this
 * collection exclusively — firestore.rules already documents that /board write access
 * should be admin-SDK-only once that ships. Until Cloud Functions are deployed, the
 * client writes it directly so the board still works; this call site is the thing to
 * delete when the trigger lands.
 */
export async function syncBoardEntry(job: Job, vehicle: Vehicle | undefined): Promise<void> {
  const payload = boardPayloadFor(job, vehicle, new Date().toISOString());
  await setDoc(doc(db, 'board', job.id), payload);
}

/** Same TEMPORARY-client-write situation as syncBoardEntry above, for /lookup. Skips
 * the write entirely for a job with no plate yet — there'd be nothing to key it by. */
export async function syncLookupEntry(
  job: Job,
  vehicle: Vehicle | undefined,
  customer: Customer | undefined,
): Promise<void> {
  const plateKey = normalizePlateKey(vehicle?.plate || '');
  if (!plateKey) return;
  const payload = lookupPayloadFor(job, vehicle, customer, new Date().toISOString());
  await setDoc(doc(db, 'lookup', plateKey), payload);
}

/** Keeps both public-facing projections (the waiting-room board and the customer's
 * own "find my car" page) in sync with a job in one call — every place that mutates a
 * job's status/bay/vehicle/parts/photos should call this instead of syncBoardEntry
 * directly, so neither one silently drifts out of date. */
export async function syncPublicRecords(
  job: Job,
  vehicle: Vehicle | undefined,
  customer: Customer | undefined,
): Promise<void> {
  await Promise.all([syncBoardEntry(job, vehicle), syncLookupEntry(job, vehicle, customer)]);
}
