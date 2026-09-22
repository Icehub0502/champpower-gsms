/**
 * PostgreSQL errors, translated into the house error envelope.
 *
 * The intake path deliberately does NOT pre-check the things a database
 * constraint already guarantees: whether a booking already has a job, whether a
 * queue number is free, whether a bay slot overlaps. A SELECT-then-INSERT is
 * exactly the prototype's bug — two tablets at the counter both pass the check
 * before either writes, and the shop ends up with two queue entries for one
 * car. So the write goes in, the database refuses it, and this module turns
 * that refusal into something a person at the counter can read.
 *
 * ---------------------------------------------------------------------------
 * HOUSE CONVENTION FOR APPLICATION SQLSTATEs
 * ---------------------------------------------------------------------------
 * A condition the database raises deliberately carries its own SQLSTATE, so
 * the API can recognise it structurally instead of reading English prose out
 * of an exception message.
 *
 *   - Five characters, A-Z and 0-9, ALWAYS beginning `GS`. Never `00`, `01` or
 *     `02`: those are the standard's own classes (success, warning, no data)
 *     and a code there would be indistinguishable from PostgreSQL's.
 *   - Every code is registered in one table, so two migrations cannot invent
 *     the same one for different things. The register belongs in CLAUDE.md §9;
 *     it is NOT in this file, and this list is a mirror, not the source:
 *         GS001  document series missing (allocate_document_number, 0014)
 *   - The API maps on `err.code` ONLY. Nothing here reads `err.message` — a
 *     message is for the server log and can be reworded, translated or
 *     localised by the server's lc_messages without warning.
 *   - `RAISE ... USING` should carry `TABLE =` and `HINT =` alongside
 *     `ERRCODE`, so a mapping has structure to key on when a single code ever
 *     needs to mean slightly different things in different places.
 *
 * Matching is otherwise by CONSTRAINT NAME, never by SQLSTATE alone. 23505 means "some
 * unique constraint", and jobs alone has three; answering "การจองนี้ถูกเปิดงาน
 * ไปแล้ว" to a job-number collision would be a confident lie. If the name is
 * not one we know, the error is rethrown to the central handler in app.ts,
 * which answers `internal_error` — no PostgreSQL text ever reaches a client.
 */
import type { Response } from 'express'

/** The subset of node-postgres' error shape this module reads. */
interface PgErrorLike {
  code?: string
  constraint?: string
  message?: string
}

function asPgError(err: unknown): PgErrorLike | null {
  if (typeof err !== 'object' || err === null) return null
  const e = err as PgErrorLike
  return typeof e.code === 'string' ? e : null
}

export interface MappedError {
  status: number
  body: { error: string; message: string }
}

/** Extra facts only the caller knows, used to put real values in the message. */
export interface PgErrorContext {
  /** The queue number that was rejected, so the message can name it. */
  queueNo?: number | null
}

export function mapPgError(err: unknown, ctx: PgErrorContext = {}): MappedError | null {
  const pg = asPgError(err)
  if (!pg) return null

  // unique_violation
  if (pg.code === '23505') {
    // CLAUDE.md §5.8 rule 1 — one booking yields at most one job. The second
    // concurrent "รถมาถึงแล้ว" lands here, which is the whole point: the losing
    // request finds out from the database, not from a check it raced past.
    if (pg.constraint === 'uq_jobs_booking') {
      return {
        status: 409,
        body: {
          error: 'booking_already_arrived',
          message: 'การจองนี้ถูกเปิดงานไปแล้ว',
        },
      }
    }
    // Two cars answering to the same number called across the shop floor is a
    // real-world collision, not a database nicety (WO-003-ANSWERS.md §c).
    if (pg.constraint === 'uq_queue_no') {
      const n = ctx.queueNo
      return {
        status: 409,
        body: {
          error: 'queue_no_taken',
          message: n == null ? 'เลขคิวนี้มีรถคันอื่นแล้ว' : `คิว ${n} มีรถคันอื่นแล้ว`,
        },
      }
    }
  }

  // exclusion_violation — the gist range overlap on bookings.
  if (pg.code === '23P01' && pg.constraint === 'ex_bookings_no_overlap') {
    return {
      status: 409,
      body: {
        error: 'bay_slot_taken',
        message: 'ช่องยกนี้มีคิวจองทับเวลากันอยู่',
      },
    }
  }

  // GS001 is raised by allocate_document_number when the shop has no active
  // series for the document being numbered (migration 0014, which exists so
  // this can be matched on a code the database states deliberately instead of
  // on the wording of an exception message).
  //
  // A shop that reaches this was created WITHOUT its document series seeded.
  // seed_document_series() is called from packages/db/src/seed.ts and nowhere
  // else today; the durable fix is for the shop-creation endpoint, when it is
  // written, to call it in the same transaction that inserts the shop. This
  // mapping is the symptom's bedside manner, not its cure.
  //
  // 500, not 409: a conflict invites the caller to change the request and try
  // again, and nothing the counter can type will conjure a document series.
  // The shop is set up incompletely and the status code should say so — but a
  // 500 is still allowed a readable message (CLAUDE.md §9 mandates the
  // { error, message } shape and forbids stack traces, not sentences), so the
  // person at the desk gets something they can act on and the monitor gets the
  // truth. The PostgreSQL message itself is never forwarded.
  if (pg.code === 'GS001') {
    return {
      status: 500,
      body: {
        error: 'job_number_series_missing',
        message: 'สาขานี้ยังไม่ได้ตั้งค่าเลขที่ใบงาน (ชุด JOB) กรุณาตั้งค่าก่อนเปิดงาน',
      },
    }
  }

  return null
}

/**
 * True when this error is the queue-number unique violation.
 *
 * Used by the allocator's bounded retry: a number the server picked itself and
 * lost a race for is worth picking again, whereas a number staff typed in is a
 * 409 they need to see.
 */
export function isQueueNoConflict(err: unknown): boolean {
  const pg = asPgError(err)
  return pg?.code === '23505' && pg.constraint === 'uq_queue_no'
}

/**
 * Answer a mapped error, or rethrow. Returns nothing: every caller's next
 * statement is a `return`, so there is no "did it handle it?" branch to get
 * wrong.
 */
export function sendPgError(res: Response, err: unknown, ctx: PgErrorContext = {}): void {
  const mapped = mapPgError(err, ctx)
  if (!mapped) throw err
  res.status(mapped.status).json(mapped.body)
}
