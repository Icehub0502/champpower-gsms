/**
 * Jobs — opening one, and the two things the board lets staff change about it.
 *
 * Two rules shape everything in this file.
 *
 * 1. `trg_jobs_booking_immutable` (0011) is a BEFORE UPDATE trigger on the
 *    WHOLE jobs table, and it raises whenever `booking_id` changes on a row
 *    that already has one. Every UPDATE here therefore names exactly the
 *    columns it means to change and never mentions `booking_id`. A convenience
 *    "update job" helper that took a partial row would trip the trigger on any
 *    booking-born job the first time someone moved its bay.
 *
 * 2. Nothing pre-checks what a constraint already guarantees. The queue number
 *    is allocated and inserted in one transaction; if it collides, the database
 *    says so and the caller retries or reports. See lib/pgError.ts.
 */
import { sql } from 'kysely'
import type { ScopedTx } from '@gsms/db/client.js'

/**
 * Take the queue-number lock for one (shop, day), held until this transaction
 * ends.
 *
 * WHY A LOCK, when uq_queue_no already refuses duplicates: the constraint
 * decides who wins a race but not how many rounds it takes. Allocation used to
 * be an optimistic max+1 retried up to five times. With N check-ins arriving
 * together each round has exactly one winner, so the last of them needs up to
 * N rounds — and at 8 or more on a busy morning some were told "เลขคิวนี้มีรถ
 * คันอื่นแล้ว" about a number nobody at the counter had typed. Serialising
 * allocation per (shop, day) means each check-in waits a few milliseconds for
 * its predecessor to commit and then reads a max that already includes it: no
 * conflict, no retry, no starvation, however many arrive at once.
 *
 * WHY THE CONSTRAINT STAYS: the lock is taken by the code that OPENS a job;
 * it is not a rule the database enforces on every write. PATCH /jobs/:id/
 * queue-no (a person renumbering a car) does not take it, and nothing stops a
 * future code path forgetting to. uq_queue_no is what actually guarantees two
 * cars never share a number; the lock only makes the common path never need
 * to lean on it.
 *
 * WHICH LOCK: pg_advisory_xact_lock on a single 64-bit key, hashed with
 * hashtextextended() from a string that is namespaced ('queue_no:') and
 * carries the full shop uuid and the date. Chosen over the two-int32 form
 * because that form would have to squeeze a 128-bit uuid into 32 bits; a 64-bit
 * hash of the whole key makes collisions negligible. And a collision is only
 * ever a performance event, never a correctness one — two unrelated
 * (shop, day) pairs would briefly queue behind each other; they could never
 * receive the same number, because the number comes from max() and the
 * constraint, not from the lock. The namespace keeps any future advisory-lock
 * user from colliding with this one by construction.
 *
 * xact, not session: it is released at COMMIT or ROLLBACK automatically, so
 * an error mid-check-in can never leave a (shop, day) locked for the rest of
 * the morning. Different shops and different days never contend at all.
 *
 * Deadlock check: this is always taken before allocate_document_number's row
 * lock on document_series, on every path that opens a job, and nothing takes
 * them in the other order — so no cycle is possible between them.
 */
export async function lockQueueDay(
  trx: ScopedTx,
  shopId: string,
  jobDate: string,
): Promise<void> {
  await sql`select pg_advisory_xact_lock(
    hashtextextended(${'queue_no:' + shopId + ':' + jobDate}, 0))`.execute(trx)
}

/**
 * The next free queue number for (shop, day).
 *
 * `max(queue_no) + 1`, read inside the SAME transaction that goes on to
 * INSERT, and AFTER lockQueueDay() for that (shop, day). Under READ COMMITTED
 * each statement takes a fresh snapshot, so once the lock is granted this
 * SELECT sees the row the previous holder just committed.
 *
 * Served by the constraint's own index (shop_id, job_date, queue_no) as a
 * backward index scan, so no extra index exists for it.
 */
export async function nextQueueNo(
  trx: ScopedTx,
  shopId: string,
  jobDate: string,
): Promise<number> {
  const row = await trx
    .selectFrom('jobs')
    .select(sql<number | null>`max(queue_no)`.as('max_no'))
    .where('shop_id', '=', shopId)
    // The generated type says `job_date` reads back as a Date, so the plain
    // builder will not compare it to a 'YYYY-MM-DD' string. Casting in SQL
    // keeps the value a bound parameter and keeps the comparison on the
    // `date` type, which is what the uq_queue_no index is built on — comparing
    // against a timestamp would not use it.
    .where(sql<boolean>`job_date = ${jobDate}::date`)
    .executeTakeFirst()
  return (row?.max_no ?? 0) + 1
}

/**
 * The job number, from the shop's JOB series counter.
 *
 * `allocate_document_number` (0003_numbering.sql) takes SELECT ... FOR UPDATE
 * on the series row, so concurrent check-ins queue up rather than colliding.
 * CLAUDE.md §5.3 rule 3 forbids `MAX(number)+1` here, and this is why the
 * function exists rather than an application-side counter.
 *
 * PRECONDITION — any new code path that opens a job, i.e. that calls this with
 * 'JOB', MUST call lockQueueDay() for the same (shop, day) FIRST, in the same
 * transaction. Two reasons, both load-bearing:
 *   - Queue numbers: a path that opens a job without the lock goes back to
 *     racing on max(queue_no)+1, and the starvation fixed in c0ad86b returns
 *     for whichever path forgot.
 *   - Deadlock: every existing path takes the advisory lock and THEN this row
 *     lock. A path taking them in the other order can deadlock against a
 *     check-in. One order, everywhere.
 * services/intake.ts openJob() is the only caller today, and does both.
 */
export async function allocateJobNumber(trx: ScopedTx, shopId: string): Promise<string> {
  const result = await sql<{ n: string }>`
    select allocate_document_number(${shopId}::uuid, 'JOB') as n
  `.execute(trx)
  const n = result.rows[0]?.n
  if (!n) throw new Error('allocate_document_number returned nothing')
  return n
}

export interface InsertJob {
  shopId: string
  jobNumber: string
  jobDate: string
  queueNo: number
  customerId: string
  vehicleId: string
  bayId?: string | null | undefined
  mileageInKm?: number | null | undefined
  /**
   * Set ONLY when the job is being opened from a booking. `uq_jobs_booking`
   * makes a second job for the same booking impossible, which is the whole
   * mechanism behind "arrival is a transition, not a creation".
   */
  bookingId?: string | null | undefined
}

export async function insertJob(trx: ScopedTx, input: InsertJob): Promise<{ id: string }> {
  return trx
    .insertInto('jobs')
    .values({
      shop_id: input.shopId,
      job_number: input.jobNumber,
      job_date: input.jobDate,
      queue_no: input.queueNo,
      customer_id: input.customerId,
      vehicle_id: input.vehicleId,
      bay_id: input.bayId ?? null,
      mileage_in_km: input.mileageInKm ?? null,
      booking_id: input.bookingId ?? null,
    })
    .returning('id')
    .executeTakeFirstOrThrow()
}

/** What the customer said is wrong with the car, in their words. */
export async function addComplaint(
  trx: ScopedTx,
  shopId: string,
  jobId: string,
  text: string,
): Promise<void> {
  await trx
    .insertInto('job_complaints')
    .values({ shop_id: shopId, job_id: jobId, text, custom: true, sort_order: 0 })
    .execute()
}

/**
 * Link already-uploaded files to the job and pick the board thumbnail.
 *
 * The bytes were written by the upload endpoint (another slice); this only
 * references the rows. `photo_count` is maintained here because no trigger
 * does it — 0002 declares the column with a default and nothing else.
 */
export async function attachPhotos(
  trx: ScopedTx,
  shopId: string,
  jobId: string,
  fileIds: string[],
): Promise<void> {
  if (fileIds.length === 0) return
  await trx
    .insertInto('job_photos')
    .values(fileIds.map((fileId, i) => ({
      shop_id: shopId,
      job_id: jobId,
      file_id: fileId,
      sort_order: i,
    })))
    .execute()
  await trx
    .updateTable('jobs')
    // Named columns only — see the note at the top of this file about
    // trg_jobs_booking_immutable.
    .set({ thumb_file_id: fileIds[0]!, photo_count: fileIds.length })
    .where('id', '=', jobId)
    .execute()
}

/**
 * Which of these file ids exist and belong to this shop.
 *
 * Read-only use of `files`, which another agent owns this week. RLS narrows
 * the SELECT to the caller's shop, so a file id from another branch simply
 * does not come back and the route answers `unknown_file`.
 */
export async function existingFileIds(
  trx: ScopedTx,
  fileIds: string[],
): Promise<Set<string>> {
  if (fileIds.length === 0) return new Set()
  const rows = await trx
    .selectFrom('files')
    .select(['id'])
    .where('id', 'in', fileIds)
    .execute()
  return new Set(rows.map((r) => r.id))
}

export interface JobBoardFacts {
  id: string
  bay_id: string | null
  queue_no: number | null
  /** Always 'YYYY-MM-DD' in Thai local terms — see the note in the query. */
  job_date: string
  status: string
}

/** The current values, read for the audit log's `before` and for 404s. */
export async function findById(
  trx: ScopedTx,
  id: string,
): Promise<JobBoardFacts | undefined> {
  return trx
    .selectFrom('jobs')
    .select([
      'id',
      'bay_id',
      'queue_no',
      // Formatted in SQL, deliberately. node-postgres parses a `date` into a
      // JS Date at the SERVER PROCESS's local midnight, so a row stored as
      // 2026-09-16 comes back as 2026-09-15T17:00:00.000Z on a machine in
      // Bangkok — and the first person to call .toISOString().slice(0,10) on
      // it gets yesterday. The column is a calendar day, not an instant, and
      // it leaves this repository as the string it actually is.
      sql<string>`to_char(job_date, 'YYYY-MM-DD')`.as('job_date'),
      'status',
    ])
    .where('id', '=', id)
    .where('deleted_at', 'is', null)
    .executeTakeFirst()
}

export async function updateBay(
  trx: ScopedTx,
  jobId: string,
  bayId: string | null,
): Promise<number> {
  const r = await trx
    .updateTable('jobs')
    .set({ bay_id: bayId })
    .where('id', '=', jobId)
    .where('deleted_at', 'is', null)
    .executeTakeFirst()
  return Number(r.numUpdatedRows)
}

export async function updateQueueNo(
  trx: ScopedTx,
  jobId: string,
  queueNo: number | null,
): Promise<number> {
  const r = await trx
    .updateTable('jobs')
    .set({ queue_no: queueNo })
    .where('id', '=', jobId)
    .where('deleted_at', 'is', null)
    .executeTakeFirst()
  return Number(r.numUpdatedRows)
}

// ---------------------------------------------------------------------------
// Status and sub-state — changed from the kanban
// ---------------------------------------------------------------------------

export interface LockedJob {
  id: string
  status: string
  sub_state: string | null
}

/**
 * Read a job's status and TAKE THE ROW LOCK, in the transaction that will
 * change it.
 *
 * FOR UPDATE is what makes the move check honest. Without it two staff
 * dragging the same card both read "inspecting", both pass canMoveTo(), and
 * the second write lands on a status it was never checked against. With it,
 * the second request waits, then reads the status the first one wrote, and is
 * judged against that — so it gets `status_changed` instead of an illegal move
 * quietly applied.
 */
export async function lockForStatusChange(
  trx: ScopedTx,
  id: string,
): Promise<LockedJob | undefined> {
  return trx
    .selectFrom('jobs')
    .select(['id', 'status', 'sub_state'])
    .where('id', '=', id)
    .where('deleted_at', 'is', null)
    .forUpdate()
    .executeTakeFirst()
}

/**
 * The job's status history, oldest first. prevStatusOf() needs it for the one
 * status with two possible predecessors: `ready` came from repairing or, when
 * alignment was not skipped, from aligning — and only the history says which.
 */
export async function statusHistoryOf(
  trx: ScopedTx,
  jobId: string,
): Promise<{ status: string; changed_at: Date }[]> {
  return trx
    .selectFrom('job_status_history')
    .select(['status', 'changed_at'])
    .where('job_id', '=', jobId)
    .orderBy('changed_at', 'asc')
    .orderBy('id', 'asc')
    .execute()
}

export interface ApplyStatus {
  jobId: string
  status: string
  subState: string | null
}

export async function applyStatus(trx: ScopedTx, input: ApplyStatus): Promise<void> {
  // Named columns only — never booking_id; see trg_jobs_booking_immutable in
  // the note at the top of this file.
  await trx
    .updateTable('jobs')
    .set({ status: input.status, sub_state: input.subState })
    .where('id', '=', input.jobId)
    .execute()
}

/**
 * One row per move, append-only. job_board_state reads its timings from here.
 *
 * `reason` is set only for a move that carries one (packages/domain
 * moveRequiresReason — today, undoing a delivery), and must arrive ALREADY
 * TRIMMED: the zod schema trims, and ck_status_history_reason (0019) refuses
 * a value with whitespace at either end rather than trimming it here.
 *
 * Returns the row's id as well as its time: an undo's audit entry points at
 * this row instead of copying the reason (free text stays out of audit_logs).
 */
export async function recordStatusHistory(
  trx: ScopedTx,
  shopId: string,
  jobId: string,
  status: string,
  changedBy: string | null,
  reason: string | null = null,
): Promise<{ id: string; changedAt: Date }> {
  const row = await trx
    .insertInto('job_status_history')
    .values({ shop_id: shopId, job_id: jobId, status, changed_by: changedBy, reason })
    .returning(['id', 'changed_at'])
    .executeTakeFirstOrThrow()
  return { id: row.id, changedAt: row.changed_at }
}

export async function setSubState(
  trx: ScopedTx,
  jobId: string,
  subState: string | null,
): Promise<void> {
  await trx.updateTable('jobs').set({ sub_state: subState }).where('id', '=', jobId).execute()
}

/** The bay's display name and the booking slot, for recomputing a card label after an edit. */
export async function labelFactsOf(
  trx: ScopedTx,
  jobId: string,
): Promise<{ bay_name: string | null; booking_slot_start: Date | null } | undefined> {
  return trx
    .selectFrom('jobs as j')
    .leftJoin('bays as b', 'b.id', 'j.bay_id')
    .leftJoin('bookings as bk', 'bk.id', 'j.booking_id')
    .select(['b.name as bay_name', 'bk.slot_start as booking_slot_start'])
    .where('j.id', '=', jobId)
    .executeTakeFirst()
}

/**
 * How many OTHER cars are standing in this bay right now.
 *
 * Returned so the screen can warn. It is never a reason to refuse the move —
 * see the note in repositories/bays.ts.
 */
export async function countOthersInBay(
  trx: ScopedTx,
  bayId: string,
  exceptJobId: string,
): Promise<number> {
  const row = await trx
    .selectFrom('jobs')
    .select(sql<number>`count(*)`.as('n'))
    .where('bay_id', '=', bayId)
    .where('id', '!=', exceptJobId)
    .where('deleted_at', 'is', null)
    .where('status', 'not in', ['carout', 'rejected'])
    .executeTakeFirst()
  return Number(row?.n ?? 0)
}
