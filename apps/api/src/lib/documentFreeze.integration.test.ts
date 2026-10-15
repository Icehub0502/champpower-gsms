/**
 * P3.1 migration 0022 — a numbered document and its lines cannot be changed
 * except where the quotation lifecycle says so. Proved against a real server,
 * with straight SQL through withShop (no API route exists for these yet; the
 * route-level tests belong with the endpoints).
 *
 * Migration 0023 (documents.job_id immutable once attached) is proved in its own
 * describe block at the bottom.
 *
 * TIER 2. Needs PostgreSQL with migrations 0001-0024 applied and the
 * connection made as gsms_app. Skipped (never silently passed) otherwise.
 *
 * Every refusal asserted here must carry SQLSTATE GS002 and the right TABLE:
 * a refusal for some other reason (a CHECK, a typo in the test's SQL) would
 * otherwise look exactly like a pass.
 *
 * Cleanup: gsms_app cannot delete a numbered document — that is the point of the
 * trigger — so rows are removed over the ADMIN connection with
 * session_replication_role = replica, which switches user triggers off. Never
 * done by the code under test.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import pg from 'pg'
import { withShop } from '@gsms/db/client.js'
import { DocumentFrozenError, DocumentJobImmutableError, DocumentLineFrozenError } from '@gsms/contracts/index.js'
import { db } from './db.js'
import { mapPgError } from './pgError.js'
import { adminDatabaseUrl, hasDatabase, tier2 } from '../test/env.js'
import { createTwoShopFixture, type TwoShopFixture } from '../test/fixtures.js'

type Tx = Parameters<Parameters<typeof withShop>[2]>[0]

describe.skipIf(!hasDatabase)(tier2('document + line freeze (migration 0022)'), () => {
  let fx: TwoShopFixture
  let customerId: string
  let seq = 0

  const inShop = <T>(fn: (trx: Tx) => Promise<T>) => withShop(db, fx.shopA, fn)

  beforeAll(async () => {
    fx = await createTwoShopFixture('p31freeze')
    const c = await inShop((trx) => sql<{ id: string }>`
      insert into customers (shop_id, name, phone)
      values (${fx.shopA}, 'Freeze Customer', '0800000099') returning id`.execute(trx))
    customerId = c.rows[0]!.id
  })

  afterAll(async () => {
    if (adminDatabaseUrl && fx) {
      const admin = new pg.Client({ connectionString: adminDatabaseUrl })
      await admin.connect()
      try {
        await admin.query('set session_replication_role = replica')
        await admin.query('delete from document_lines where shop_id = any($1)', [[fx.shopA, fx.shopB]])
        await admin.query('delete from documents where shop_id = any($1)', [[fx.shopA, fx.shopB]])
      } finally { await admin.end() }
    }
    await fx?.cleanup()
  })

  // ---------------------------------------------------------------------------
  // helpers
  // ---------------------------------------------------------------------------
  async function newDraft(type: 'quotation' | 'receipt' = 'quotation'): Promise<string> {
    const r = await inShop((trx) => sql<{ id: string }>`
      insert into documents (shop_id, customer_id, type, series)
      values (${fx.shopA}, ${customerId}, ${type}, 'IV') returning id`.execute(trx))
    return r.rows[0]!.id
  }

  async function addLine(
    docId: string, o: { name?: string; price?: number; parent?: string | null } = {},
  ): Promise<string> {
    const r = await inShop((trx) => sql<{ id: string }>`
      insert into document_lines (shop_id, document_id, name_snapshot, qty, unit_price,
                                  line_total, parent_line_id)
      values (${fx.shopA}, ${docId}, ${o.name ?? 'ลูกหมาก'}, 1, ${o.price ?? 1000},
              ${o.price ?? 1000}, ${o.parent ?? null}) returning id`.execute(trx))
    return r.rows[0]!.id
  }

  const issue = (id: string) => inShop((trx) => sql`
    update documents set status = 'issued', number = ${'T-' + (++seq) + '-' + id.slice(0, 6)},
           numbered_on = current_date, issued_at = now() where id = ${id}`.execute(trx))

  const confirm = (id: string) => inShop((trx) => sql`
    update documents set status = 'signed', signed_at = now() where id = ${id}`.execute(trx))

  /** A quotation with one top-level line (and optionally a child), at the given state. */
  async function quotation(to: 'draft' | 'issued' | 'signed', withChild = false) {
    const doc = await newDraft()
    const line = await addLine(doc)
    const child = withChild ? await addLine(doc, { name: 'ลูกหมากย่อย', price: 0, parent: line }) : null
    if (to !== 'draft') await issue(doc)
    if (to === 'signed') await confirm(doc)
    return { doc, line, child }
  }

  /** Run a statement in its own transaction and demand GS002 on `table`. */
  async function refused(
    table: 'documents' | 'document_lines', fn: (trx: Tx) => Promise<unknown>, hint?: string,
  ) {
    let caught: unknown
    try { await inShop(fn) } catch (e) { caught = e }
    expect(caught, 'the statement should have been refused').toBeTruthy()
    const e = caught as { code?: string; table?: string; hint?: string }
    expect(e.code, `expected SQLSTATE GS002, got ${e.code}`).toBe('GS002')
    expect(e.table).toBe(table)
    if (hint !== undefined) expect(e.hint).toBe(hint)
    return caught
  }

  const status = async (id: string) => (await inShop((trx) => sql<{ status: string; discount: string; approved_total: string }>`
    select status, discount, approved_total from documents where id = ${id}`.execute(trx))).rows[0]!

  // ---------------------------------------------------------------------------
  describe('draft', () => {
    it.each(['issued', 'signed', 'void', 'superseded'])(
      'refuses INSERTing a document directly as %s', async (st) => {
        await refused('documents', (trx) => sql`
          insert into documents (shop_id, customer_id, type, series, status, number, numbered_on,
                                 void_reason)
          values (${fx.shopA}, ${customerId}, 'quotation', 'IV', ${st}, ${'T-INS-' + (++seq)},
                  current_date, ${st === 'void' ? 'x' : null})`.execute(trx))
      })

    it('is fully editable: line content, insert, delete, document fields', async () => {
      const { doc, line } = await quotation('draft')
      await inShop((trx) => sql`update document_lines set unit_price = 1, name_snapshot = 'x' where id = ${line}`.execute(trx))
      const extra = await addLine(doc)
      await inShop((trx) => sql`delete from document_lines where id = ${extra}`.execute(trx))
      await inShop((trx) => sql`update documents set discount = 50, offered_total = 7 where id = ${doc}`.execute(trx))
    })

    it('never lets a line move to another document, even a draft one', async () => {
      const a = await quotation('draft')
      const b = await newDraft()
      await refused('document_lines', (trx) => sql`
        update document_lines set document_id = ${b} where id = ${a.line}`.execute(trx))
    })

    it('a draft document can be deleted and takes its lines with it', async () => {
      const { doc, line } = await quotation('draft')
      await inShop((trx) => sql`delete from documents where id = ${doc}`.execute(trx))
      const left = await inShop((trx) => sql`select 1 from document_lines where id = ${line}`.execute(trx))
      expect(left.rows).toHaveLength(0)
    })
  })

  // ---------------------------------------------------------------------------
  describe('issued quotation: lines', () => {
    it.each([
      ['unit_price', "unit_price = 1"],
      ['qty', "qty = 2"],
      ['line_total', "line_total = 1"],
      ['name_snapshot', "name_snapshot = 'changed'"],
      ['is_vatable', "is_vatable = true"],
      ['sort_order', "sort_order = 9"],
      ['fulfilled_qty', "fulfilled_qty = 1"],
    ])('refuses a change to %s (content is locked)', async (_col, setClause) => {
      const { line } = await quotation('issued')
      await refused('document_lines', (trx) =>
        sql`update document_lines set ${sql.raw(setClause)} where id = ${line}`.execute(trx))
    })

    it('refuses changing parent_line_id after draft', async () => {
      const { line, child } = await quotation('issued', true)
      await refused('document_lines', (trx) =>
        sql`update document_lines set parent_line_id = null where id = ${child}`.execute(trx))
      await refused('document_lines', (trx) =>
        sql`update document_lines set parent_line_id = ${child} where id = ${line}`.execute(trx))
    })

    it('allows the customer-decision columns on a top-level line', async () => {
      const { line } = await quotation('issued')
      await inShop((trx) => sql`
        update document_lines set approval_status = 'approved', decided_at = now(),
               decided_by = ${fx.userId} where id = ${line}`.execute(trx))
      await inShop((trx) => sql`
        update document_lines set approval_status = 'declined', decline_reason = 'too_expensive',
               decline_note = 'ราคาสูง' where id = ${line}`.execute(trx))
      await inShop((trx) => sql`
        update document_lines set approval_status = 'approved', decline_reason = null,
               decline_note = null, approved_amount = 800 where id = ${line}`.execute(trx))
    })

    it('allows the same decision columns on a set CHILD, and still locks its content', async () => {
      const { child } = await quotation('issued', true)
      await inShop((trx) => sql`
        update document_lines set approval_status = 'declined', decline_reason = 'not_needed_yet',
               decided_at = now(), decided_by = ${fx.userId} where id = ${child}`.execute(trx))
      await refused('document_lines', (trx) =>
        sql`update document_lines set unit_price = 5 where id = ${child}`.execute(trx))
    })

    it('refuses a decision change and a content change in the same UPDATE', async () => {
      const { line } = await quotation('issued')
      await refused('document_lines', (trx) => sql`
        update document_lines set approval_status = 'approved', unit_price = 1 where id = ${line}`.execute(trx))
    })

    it('refuses adding a line to an issued document', async () => {
      const { doc } = await quotation('issued')
      await refused('document_lines', (trx) => sql`
        insert into document_lines (shop_id, document_id, name_snapshot, unit_price, line_total)
        values (${fx.shopA}, ${doc}, 'late addition', 1, 1)`.execute(trx))
    })

    it('refuses deleting a line of an issued document', async () => {
      const { line } = await quotation('issued')
      await refused('document_lines', (trx) =>
        sql`delete from document_lines where id = ${line}`.execute(trx))
    })

    it('refuses moving a line to another document', async () => {
      const a = await quotation('issued')
      const b = await newDraft()
      await refused('document_lines', (trx) => sql`
        update document_lines set document_id = ${b} where id = ${a.line}`.execute(trx))
    })
  })

  // ---------------------------------------------------------------------------
  describe('issued quotation: the document row', () => {
    it('allows approved_total to change (decisions); discount only back to offered_discount (0024)', async () => {
      const { doc } = await quotation('issued')
      await inShop((trx) => sql`update documents set approved_total = 900 where id = ${doc}`.execute(trx))
      expect(Number((await status(doc)).approved_total)).toBe(900)
      // the agreed discount moves at confirm (issued -> signed), never inside issued
      await refused('documents', (trx) => sql`update documents set discount = 100 where id = ${doc}`.execute(trx), 'document_frozen_columns')
      // setting it equal to offered_discount (0 here) is the permitted heal
      await inShop((trx) => sql`update documents set discount = offered_discount where id = ${doc}`.execute(trx))
    })

    it.each([
      ['offered_total', 'offered_total = 1'],
      ['grand_total', 'grand_total = 1'],
      ['vat_mode', "vat_mode = 'add_7'"],
      ['number', "number = 'HACKED'"],
      ['buyer_legal_name', "buyer_legal_name = 'someone else'"],
      ['customer_id', null],
    ])('refuses a change to %s', async (_c, setClause) => {
      const { doc } = await quotation('issued')
      const stmt = setClause ?? `customer_id = '${fx.shopA}'`   // any other value; GS002 fires before the FK
      await refused('documents', (trx) =>
        sql`update documents set ${sql.raw(stmt)} where id = ${doc}`.execute(trx))
    })

    it('refuses discount changing together with a content column', async () => {
      const { doc } = await quotation('issued')
      await refused('documents', (trx) =>
        sql`update documents set discount = 5, grand_total = 5 where id = ${doc}`.execute(trx))
    })

    it('cannot be deleted', async () => {
      const { doc } = await quotation('issued')
      await refused('documents', (trx) => sql`delete from documents where id = ${doc}`.execute(trx))
    })
  })

  // ---------------------------------------------------------------------------
  describe('issued -> signed (confirm)', () => {
    it('a draft cannot jump straight to signed (must be issued first)', async () => {
      const { doc } = await quotation('draft')
      await refused('documents', (trx) => sql`
        update documents set status = 'signed', signed_at = now(),
               number = 'T-SKIP-' || substr(id::text, 1, 6), numbered_on = current_date
         where id = ${doc}`.execute(trx))
    })

    it('is allowed with signed_at, carrying the approved_total and discount adjustments', async () => {
      const { doc } = await quotation('issued')
      await inShop((trx) => sql`
        update documents set status = 'signed', signed_at = now(), approved_total = 700, discount = 20
         where id = ${doc}`.execute(trx))
      expect((await status(doc)).status).toBe('signed')
    })

    it('is refused without signed_at', async () => {
      const { doc } = await quotation('issued')
      await refused('documents', (trx) => sql`update documents set status = 'signed' where id = ${doc}`.execute(trx))
    })

    it('is refused when the same UPDATE also changes anything else', async () => {
      const { doc } = await quotation('issued')
      await refused('documents', (trx) => sql`
        update documents set status = 'signed', signed_at = now(), grand_total = 1 where id = ${doc}`.execute(trx))
    })

    it('is refused for a receipt (only quotations are confirmed)', async () => {
      const doc = await newDraft('receipt')
      await issue(doc)
      await refused('documents', (trx) => sql`
        update documents set status = 'signed', signed_at = now() where id = ${doc}`.execute(trx))
    })
  })

  // ---------------------------------------------------------------------------
  describe('signed quotation: nothing changes', () => {
    it('refuses every line change: decision, content, insert, delete', async () => {
      const { doc, line } = await quotation('signed')
      await refused('document_lines', (trx) =>
        sql`update document_lines set approval_status = 'approved' where id = ${line}`.execute(trx))
      await refused('document_lines', (trx) =>
        sql`update document_lines set approved_amount = 1 where id = ${line}`.execute(trx))
      await refused('document_lines', (trx) =>
        sql`update document_lines set unit_price = 1 where id = ${line}`.execute(trx))
      await refused('document_lines', (trx) => sql`
        insert into document_lines (shop_id, document_id, name_snapshot, unit_price, line_total)
        values (${fx.shopA}, ${doc}, 'late', 1, 1)`.execute(trx))
      await refused('document_lines', (trx) =>
        sql`delete from document_lines where id = ${line}`.execute(trx))
    })

    it('refuses every document change, including a no-op and discount', async () => {
      const { doc } = await quotation('signed')
      await refused('documents', (trx) => sql`update documents set discount = 1 where id = ${doc}`.execute(trx))
      await refused('documents', (trx) => sql`update documents set approved_total = 1 where id = ${doc}`.execute(trx))
      await refused('documents', (trx) => sql`update documents set status = 'signed' where id = ${doc}`.execute(trx))
      await refused('documents', (trx) => sql`delete from documents where id = ${doc}`.execute(trx))
    })

    it('can be un-confirmed: signed -> issued touches only status and signed_at', async () => {
      const { doc, line } = await quotation('signed')
      await inShop((trx) => sql`update documents set status = 'issued', signed_at = null where id = ${doc}`.execute(trx))
      expect((await status(doc)).status).toBe('issued')
      // and decisions are editable again
      await inShop((trx) => sql`update document_lines set approval_status = 'approved' where id = ${line}`.execute(trx))
    })

    it('refuses an un-confirm that sets the discount to anything but offered_discount, or changes the number', async () => {
      const { doc } = await quotation('signed')
      await refused('documents', (trx) => sql`
        update documents set status = 'issued', signed_at = null, discount = 9 where id = ${doc}`.execute(trx))
      await refused('documents', (trx) => sql`
        update documents set status = 'issued', signed_at = null, number = 'X' where id = ${doc}`.execute(trx))
    })

    it('refuses an un-confirm that leaves signed_at set', async () => {
      const { doc } = await quotation('signed')
      await refused('documents', (trx) => sql`update documents set status = 'issued' where id = ${doc}`.execute(trx))
    })
  })

  // ---------------------------------------------------------------------------
  describe('superseded and void: nothing, ever', () => {
    it('signed -> superseded changes status only; afterwards the document and its lines are closed', async () => {
      const { doc, line } = await quotation('signed')
      await refused('documents', (trx) => sql`
        update documents set status = 'superseded', number = 'Y' where id = ${doc}`.execute(trx))
      await inShop((trx) => sql`update documents set status = 'superseded' where id = ${doc}`.execute(trx))
      await refused('documents', (trx) => sql`update documents set discount = 1 where id = ${doc}`.execute(trx))
      await refused('documents', (trx) => sql`update documents set status = 'issued', signed_at = null where id = ${doc}`.execute(trx))
      await refused('document_lines', (trx) => sql`update document_lines set approval_status = 'approved' where id = ${line}`.execute(trx))
      await refused('document_lines', (trx) => sql`delete from document_lines where id = ${line}`.execute(trx))
    })

    it('issued -> void (system close: job_closed, voided_by NULL) touches only the void columns', async () => {
      const { doc, line } = await quotation('issued')
      await refused('documents', (trx) => sql`
        update documents set status = 'void', void_reason = 'job_closed', voided_at = now(), grand_total = 1
         where id = ${doc}`.execute(trx))
      await inShop((trx) => sql`
        update documents set status = 'void', void_reason = 'job_closed', voided_at = now(), voided_by = null
         where id = ${doc}`.execute(trx))
      await refused('documents', (trx) => sql`update documents set void_reason = 'edited' where id = ${doc}`.execute(trx))
      await refused('document_lines', (trx) => sql`update document_lines set approval_status = 'declined', decline_reason = 'other' where id = ${line}`.execute(trx))
    })

    it('a manual void by a user (voided_by set) is the same transition', async () => {
      const { doc } = await quotation('issued')
      await inShop((trx) => sql`
        update documents set status = 'void', void_reason = 'wrong customer', voided_at = now(),
               voided_by = ${fx.userId} where id = ${doc}`.execute(trx))
    })

    it('a void cannot change the discount or approved_total on the way out', async () => {
      const { doc } = await quotation('issued')
      await refused('documents', (trx) => sql`
        update documents set status = 'void', void_reason = 'x', voided_at = now(), discount = 3 where id = ${doc}`.execute(trx))
    })

    it('a draft can be closed by the system as void/job_closed', async () => {
      const { doc } = await quotation('draft')
      await inShop((trx) => sql`
        update documents set status = 'void', void_reason = 'job_closed', voided_at = now(),
               number = 'T-VOIDDRAFT-' || substr(id::text, 1, 6), numbered_on = current_date
         where id = ${doc}`.execute(trx))
    })
  })

  // ---------------------------------------------------------------------------
  describe('documents other than quotations', () => {
    it('an issued receipt: lines fully locked (even decision columns) and the row frozen', async () => {
      const doc = await newDraft('receipt')
      const line = await addLine(doc)
      await issue(doc)
      await refused('document_lines', (trx) =>
        sql`update document_lines set approval_status = 'approved' where id = ${line}`.execute(trx))
      await refused('documents', (trx) => sql`update documents set discount = 1 where id = ${doc}`.execute(trx))
    })
  })

  // ---------------------------------------------------------------------------
  describe('concurrency: a late decision cannot slip in after the freeze', () => {
    it('a decision racing a confirm is refused once the confirm commits', async () => {
      const { doc, line } = await quotation('issued')
      let release!: () => void
      const gate = new Promise<void>((r) => { release = r })
      let confirmed!: () => void
      const confirmedStarted = new Promise<void>((r) => { confirmed = r })

      const confirmTx = inShop(async (trx) => {
        await sql`update documents set status = 'signed', signed_at = now() where id = ${doc}`.execute(trx)
        confirmed()
        await gate            // hold the transaction open, row lock held
      })
      await confirmedStarted

      const decision = inShop((trx) => sql`
        update document_lines set approval_status = 'approved' where id = ${line}`.execute(trx))
        .then(() => null, (e: unknown) => e)

      // give the decision time to reach the lock and block
      await new Promise((r) => setTimeout(r, 300))
      release()
      await confirmTx
      const err = (await decision) as { code?: string; table?: string } | null
      expect(err?.code).toBe('GS002')
      expect(err?.table).toBe('document_lines')
    })
  })

  // ---------------------------------------------------------------------------
  describe('API mapping (by err.code only)', () => {
    it('maps a refused line change to 409 document_line_frozen, matching the strict contract', async () => {
      const { line } = await quotation('signed')
      const err = await refused('document_lines', (trx) =>
        sql`update document_lines set unit_price = 1 where id = ${line}`.execute(trx))
      const mapped = mapPgError(err)
      expect(mapped?.status).toBe(409)
      expect(DocumentLineFrozenError.parse(mapped?.body).error).toBe('document_line_frozen')
    })

    it('maps a refused document change to 409 document_frozen, matching the strict contract', async () => {
      const { doc } = await quotation('signed')
      const err = await refused('documents', (trx) =>
        sql`update documents set discount = 1 where id = ${doc}`.execute(trx))
      const mapped = mapPgError(err)
      expect(mapped?.status).toBe(409)
      expect(DocumentFrozenError.parse(mapped?.body).error).toBe('document_frozen')
    })
  })

  // ---------------------------------------------------------------------------
  // Migration 0023: documents.job_id is NULL -> value once, on a draft, then fixed.
  // ---------------------------------------------------------------------------
  describe('job_id immutable (migration 0023)', () => {
    const HINT = 'document_job_id_immutable'

    async function newJob(): Promise<string> {
      const n = ++seq
      const v = await inShop((trx) => sql<{ id: string }>`
        insert into vehicles (shop_id, customer_id, plate, brand, model)
        values (${fx.shopA}, ${customerId}, ${'JOB' + n + '-' + Date.now()}, 'Toyota', 'Vigo') returning id`.execute(trx))
      const j = await inShop((trx) => sql<{ id: string }>`
        insert into jobs (shop_id, job_number, vehicle_id, customer_id)
        values (${fx.shopA}, ${'T0023-' + n + '-' + Date.now()}, ${v.rows[0]!.id}, ${customerId}) returning id`.execute(trx))
      return j.rows[0]!.id
    }

    async function draftWith(jobId: string | null): Promise<string> {
      const r = await inShop((trx) => sql<{ id: string }>`
        insert into documents (shop_id, customer_id, type, series, job_id)
        values (${fx.shopA}, ${customerId}, 'quotation', 'IV', ${jobId}) returning id`.execute(trx))
      return r.rows[0]!.id
    }

    /** The whole row as JSON, updated_at included, so "unchanged" means unchanged. */
    const snapshot = async (id: string) => (await inShop((trx) => sql<{ r: Record<string, unknown> }>`
      select to_jsonb(d) as r from documents d where id = ${id}`.execute(trx))).rows[0]!.r

    const setJob = (id: string, jobId: string | null) => (trx: Tx) =>
      sql`update documents set job_id = ${jobId} where id = ${id}`.execute(trx)

    /** Refuse with the job hint and prove the row did not move. */
    async function refusedJob(id: string, jobId: string | null) {
      const before = await snapshot(id)
      await refused('documents', setJob(id, jobId), HINT)
      expect(await snapshot(id)).toEqual(before)
    }

    it('1. a draft with job A cannot be re-pointed at job B', async () => {
      const a = await newJob(); const b = await newJob()
      const doc = await draftWith(a)
      await refusedJob(doc, b)
    })

    it('2. a draft with job A cannot be detached (A -> NULL)', async () => {
      const doc = await draftWith(await newJob())
      await refusedJob(doc, null)
    })

    it('3. NULL -> job attaches once; afterwards A->B, A->NULL and re-attach are refused, A->A is allowed', async () => {
      const a = await newJob(); const b = await newJob()
      const doc = await draftWith(null)
      await inShop(setJob(doc, a))
      expect((await snapshot(doc)).job_id).toBe(a)
      await refusedJob(doc, b)
      await refusedJob(doc, null)
      await refusedJob(doc, b)                 // a second "first attach" is still just A -> B
      await inShop(setJob(doc, a))             // A -> A: not a change, the trigger does not fire
      expect((await snapshot(doc)).job_id).toBe(a)
    })

    it('4. issued, signed, superseded and void rows refuse a job_id change in the 0022 trigger (pinned hints)', async () => {
      // One job per document: uq_live_quotation_per_job allows a single live quotation per job.
      const b = await newJob()

      const issued = await draftWith(await newJob()); await issue(issued)
      await refused('documents', setJob(issued, b), 'document_frozen_columns')

      const signed = await draftWith(await newJob()); await issue(signed); await confirm(signed)
      await refused('documents', setJob(signed, b), 'document_signed')

      const superseded = await draftWith(await newJob()); await issue(superseded); await confirm(superseded)
      await inShop((trx) => sql`update documents set status = 'superseded' where id = ${superseded}`.execute(trx))
      await refused('documents', setJob(superseded, b), 'document_closed')

      const voided = await draftWith(await newJob()); await issue(voided)
      await inShop((trx) => sql`
        update documents set status = 'void', void_reason = 'wrong customer', voided_at = now(),
               voided_by = ${fx.userId} where id = ${voided}`.execute(trx))
      await refused('documents', setJob(voided, b), 'document_closed')
    })

    it('5. an issued document with NULL job_id cannot be attached afterwards', async () => {
      const doc = await draftWith(null)
      await issue(doc)                          // a jobless draft can be issued: the schema allows it
      const before = await snapshot(doc)
      await refused('documents', setJob(doc, await newJob()), 'document_frozen_columns')
      expect(await snapshot(doc)).toEqual(before)
    })

    it('6. PINNED: one UPDATE that attaches AND issues a draft is allowed (draft rows are free in 0022; NULL -> value on a draft in 0023)', async () => {
      const a = await newJob()
      const doc = await draftWith(null)
      await inShop((trx) => sql`
        update documents set job_id = ${a}, status = 'issued', number = ${'T-ATT-' + (++seq)},
               numbered_on = current_date, issued_at = now() where id = ${doc}`.execute(trx))
      const s = await snapshot(doc)
      expect(s.status).toBe('issued')
      expect(s.job_id).toBe(a)
      // and from then on it is fixed
      await refused('documents', setJob(doc, await newJob()), 'document_frozen_columns')
    })

    it('7. ordinary draft updates and a successful attach still advance updated_at', async () => {
      const doc = await draftWith(null)
      const t0 = (await snapshot(doc)).updated_at
      await inShop((trx) => sql`update documents set discount = 5 where id = ${doc}`.execute(trx))
      const t1 = (await snapshot(doc)).updated_at
      expect(t1).not.toBe(t0)
      await inShop(setJob(doc, await newJob()))
      const t2 = (await snapshot(doc)).updated_at
      expect(t2).not.toBe(t1)
    })

    it('8. two transactions attach different jobs to one NULL draft: the loser is refused after re-reading', async () => {
      const a = await newJob(); const b = await newJob()
      const doc = await draftWith(null)
      let release!: () => void
      const gate = new Promise<void>((r) => { release = r })
      let attached!: () => void
      const attachedStarted = new Promise<void>((r) => { attached = r })

      const winner = inShop(async (trx) => {
        await setJob(doc, a)(trx)
        attached()
        await gate                              // row lock held until released
      })
      await attachedStarted

      const loser = inShop(setJob(doc, b)).then(() => null, (e: unknown) => e)
      await new Promise((r) => setTimeout(r, 300))   // let the loser reach the row lock
      release()
      await winner

      const err = (await loser) as { code?: string; table?: string; hint?: string } | null
      expect(err?.code).toBe('GS002')
      expect(err?.table).toBe('documents')
      expect(err?.hint).toBe(HINT)
      expect((await snapshot(doc)).job_id).toBe(a)
    })

    it('9. shop B cannot touch shop A\'s draft (RLS: zero rows, nothing changes)', async () => {
      const a = await newJob()
      const doc = await draftWith(null)
      const before = await snapshot(doc)
      const res = await withShop(db, fx.shopB, (trx) => sql`
        update documents set job_id = ${a} where id = ${doc}`.execute(trx))
      expect(Number(res.numAffectedRows ?? 0)).toBe(0)
      expect(await snapshot(doc)).toEqual(before)
    })

    it.todo('cross-shop attach refused by composite FK (0024)')

    it('the refusal maps to 409 document_job_immutable, matching the strict contract', async () => {
      const doc = await draftWith(await newJob())
      const err = await refused('documents', setJob(doc, await newJob()), HINT)
      const mapped = mapPgError(err)
      expect(mapped?.status).toBe(409)
      expect(DocumentJobImmutableError.parse(mapped?.body).error).toBe('document_job_immutable')
    })
  })

  // ---------------------------------------------------------------------------
  // Migration 0024 — offered_discount vs agreed discount (test 6 of the brief)
  // ---------------------------------------------------------------------------
  describe('offered discount (migration 0024)', () => {
    /** An issued quotation whose offer carried a 150 discount (offered_discount = discount = 150). */
    async function issuedWithOffer(offered = 150) {
      const doc = await newDraft()
      const line = await addLine(doc)
      await inShop((trx) => sql`update documents set discount = ${offered}, offered_discount = ${offered} where id = ${doc}`.execute(trx))
      await issue(doc)
      return { doc, line }
    }
    const signWith = (doc: string, agreed: number) => inShop((trx) => sql`
      update documents set status = 'signed', signed_at = now(), discount = ${agreed}, approved_total = 700 where id = ${doc}`.execute(trx))
    const row = async (id: string) => (await inShop((trx) => sql<{ discount: string; offered_discount: string; approved_total: string }>`
      select discount, offered_discount, approved_total from documents where id = ${id}`.execute(trx))).rows[0]!

    it('a draft is issued with discount = offered_discount; a mismatch is refused (document_frozen_columns)', async () => {
      const doc = await newDraft()
      await addLine(doc)
      await inShop((trx) => sql`update documents set discount = 100, offered_discount = 50 where id = ${doc}`.execute(trx))
      await refused('documents', (trx) => sql`
        update documents set status = 'issued', number = ${'T-D-' + (++seq)}, numbered_on = current_date, issued_at = now()
         where id = ${doc}`.execute(trx), 'document_frozen_columns')
    })

    it('confirm may move discount away from offered_discount; offered_discount itself is frozen on issued and signed', async () => {
      const { doc } = await issuedWithOffer()
      await refused('documents', (trx) => sql`update documents set offered_discount = 1 where id = ${doc}`.execute(trx))
      await signWith(doc, 300)
      expect(Number((await row(doc)).discount)).toBe(300)
      expect(Number((await row(doc)).offered_discount)).toBe(150)
      await refused('documents', (trx) => sql`update documents set offered_discount = 1 where id = ${doc}`.execute(trx))
    })

    it('signed -> issued: discount may only be set equal to offered_discount (with approved_total)', async () => {
      const { doc } = await issuedWithOffer()
      await signWith(doc, 300)
      await refused('documents', (trx) => sql`
        update documents set status = 'issued', signed_at = null, discount = 300 where id = ${doc}`.execute(trx), 'document_unconfirm_invalid')
      await inShop((trx) => sql`
        update documents set status = 'issued', signed_at = null, discount = offered_discount, approved_total = 850
         where id = ${doc}`.execute(trx))
      const r = await row(doc)
      expect(Number(r.discount)).toBe(150)
      expect(Number(r.approved_total)).toBe(850)
    })

    it.each([
      ['offered_total', 'offered_total = 1'],
      ['grand_total', 'grand_total = 1'],
      ['number', "number = 'HACKED'"],
      ['offered_discount', 'offered_discount = 0'],
    ])('signed -> issued is refused (GS002) when it also changes %s', async (_c, clause) => {
      const { doc } = await issuedWithOffer()
      await signWith(doc, 300)
      await refused('documents', (trx) => sql`
        update documents set status = 'issued', signed_at = null, discount = ${sql.raw(clause === 'offered_discount = 0' ? '0' : 'offered_discount')}, ${sql.raw(clause)}
         where id = ${doc}`.execute(trx))
    })

    it('superseded and void rows keep offered_discount frozen', async () => {
      const { doc } = await issuedWithOffer()
      await inShop((trx) => sql`update documents set status = 'superseded' where id = ${doc}`.execute(trx))
      await refused('documents', (trx) => sql`update documents set offered_discount = 1 where id = ${doc}`.execute(trx))
    })
  })
})
