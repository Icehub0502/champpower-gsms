/**
 * P3.1 migration 0022 — a numbered document and its lines cannot be changed
 * except where the quotation lifecycle says so. Proved against a real server,
 * with straight SQL through withShop (no API route exists for these yet; the
 * route-level tests belong with the endpoints).
 *
 * TIER 2. Needs PostgreSQL with migrations 0001-0022 applied and the
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
import { DocumentFrozenError, DocumentLineFrozenError } from '@gsms/contracts/index.js'
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
  async function refused(table: 'documents' | 'document_lines', fn: (trx: Tx) => Promise<unknown>) {
    let caught: unknown
    try { await inShop(fn) } catch (e) { caught = e }
    expect(caught, 'the statement should have been refused').toBeTruthy()
    const e = caught as { code?: string; table?: string }
    expect(e.code, `expected SQLSTATE GS002, got ${e.code}`).toBe('GS002')
    expect(e.table).toBe(table)
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
    it('allows approved_total and discount to change (decisions + adjustment at confirm)', async () => {
      const { doc } = await quotation('issued')
      await inShop((trx) => sql`update documents set approved_total = 900, discount = 100 where id = ${doc}`.execute(trx))
      const s = await status(doc)
      expect(Number(s.approved_total)).toBe(900)
      expect(Number(s.discount)).toBe(100)
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

    it('refuses an un-confirm that also changes the discount, approved_total or number', async () => {
      const { doc } = await quotation('signed')
      await refused('documents', (trx) => sql`
        update documents set status = 'issued', signed_at = null, discount = 9 where id = ${doc}`.execute(trx))
      await refused('documents', (trx) => sql`
        update documents set status = 'issued', signed_at = null, approved_total = 9 where id = ${doc}`.execute(trx))
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
})
