import { doc, setDoc } from 'firebase/firestore';
import { boardPayloadFor, type Job, type Vehicle } from '@champpower/domain';
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
