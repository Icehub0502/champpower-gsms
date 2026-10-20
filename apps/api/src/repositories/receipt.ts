/**
 * Receipts (`documents.type = 'receipt'`), their lines, payments and reversals.
 * Every function takes a ScopedTx, so RLS narrows every row to the caller's shop;
 * no function here takes a shop id for filtering.
 *
 * Writes follow migrations 0022/0024/0025: a DRAFT receipt and its lines may
 * change freely; once `issued` the row and its lines are frozen (GS002), and the
 * only exit is -> void (status, void_reason, voided_at, voided_by). payments,
 * payment_reversals and daily_closings are append-only (0025 trigger).
 */
import { sql } from 'kysely'
import type { ScopedTx } from '@gsms/db/client.js'

// -----------------------------------------------------------------------------
// Documents
// -----------------------------------------------------------------------------

export interface ReceiptDocRow {
  id: string
  job_id: string | null
  customer_id: string
  status: string
  number: string | null
  source_document_id: string | null
  bill_subtotal: string | null
  discount: string
  /** The discount AGREED on the quotation (reference). */
  offered_discount: string
  /** The quotation's approved_total at snapshot. */
  approved_total: string
  grand_total: string
  discount_reason: string | null
  discount_entered_at: Date | null
  discount_approved_by: string | null
  receipt_snapshot: unknown
  issued_at: Date | null
  issued_by: string | null
  voided_at: Date | null
  voided_by: string | null
  void_reason: string | null
}

const DOC_COLUMNS = [
  'id', 'job_id', 'customer_id', 'status', 'number', 'source_document_id', 'bill_subtotal', 'discount',
  'offered_discount', 'approved_total', 'grand_total', 'discount_reason', 'discount_entered_at',
  'discount_approved_by', 'receipt_snapshot', 'issued_at', 'issued_by', 'voided_at', 'voided_by', 'void_reason',
] as const

/** The job's standing receipt (draft or issued), else its most recently voided one. */
export async function findReceiptOfJob(trx: ScopedTx, jobId: string): Promise<ReceiptDocRow | undefined> {
  const live = await trx.selectFrom('documents').select(DOC_COLUMNS)
    .where('job_id', '=', jobId).where('type', '=', 'receipt').where('status', 'in', ['draft', 'issued'])
    .executeTakeFirst()
  if (live) return live as ReceiptDocRow
  return (await trx.selectFrom('documents').select(DOC_COLUMNS)
    .where('job_id', '=', jobId).where('type', '=', 'receipt').where('status', '=', 'void')
    .orderBy('voided_at', 'desc').limit(1).executeTakeFirst()) as ReceiptDocRow | undefined
}

export async function lockReceipt(trx: ScopedTx, id: string): Promise<ReceiptDocRow | undefined> {
  return (await trx.selectFrom('documents').select(DOC_COLUMNS).where('id', '=', id).forUpdate().executeTakeFirst()) as ReceiptDocRow | undefined
}

export async function getReceipt(trx: ScopedTx, id: string): Promise<ReceiptDocRow | undefined> {
  return (await trx.selectFrom('documents').select(DOC_COLUMNS).where('id', '=', id).executeTakeFirst()) as ReceiptDocRow | undefined
}

export async function insertDraftReceipt(
  trx: ScopedTx,
  input: { shopId: string; jobId: string; customerId: string; quotationId: string; agreedDiscount: string; approvedTotal: string },
): Promise<string> {
  const row = await trx.insertInto('documents').values({
    shop_id: input.shopId,
    job_id: input.jobId,
    customer_id: input.customerId,
    type: 'receipt',
    series: 'REC',
    source_document_id: input.quotationId,
    // Reference copies of the quotation's agreed figures; the receipt's own discount starts at 0.
    offered_discount: input.agreedDiscount,
    approved_total: input.approvedTotal,
    bill_subtotal: '0',
    discount: '0',
    grand_total: '0',
  }).returning(['id']).executeTakeFirstOrThrow()
  return row.id
}

export async function deleteDraftReceipt(trx: ScopedTx, id: string): Promise<void> {
  // Only a draft may go (trg_documents_no_delete); its lines cascade.
  await trx.deleteFrom('documents').where('id', '=', id).where('status', '=', 'draft').execute()
}

export async function writeDraftTotals(
  trx: ScopedTx,
  id: string,
  t: { subtotal: string; discount: string; billTotal: string },
): Promise<void> {
  await trx.updateTable('documents')
    .set({ bill_subtotal: t.subtotal, discount: t.discount, grand_total: t.billTotal })
    .where('id', '=', id).execute()
}

export async function writeDraftDiscount(
  trx: ScopedTx,
  id: string,
  p: { discount?: string; reason?: string },
): Promise<void> {
  const set: Record<string, unknown> = {}
  if (p.discount !== undefined) { set.discount = p.discount; set.discount_entered_at = new Date() }
  if (p.reason !== undefined) set.discount_reason = p.reason
  if (Object.keys(set).length === 0) return
  await trx.updateTable('documents').set(set).where('id', '=', id).execute()
}

export interface IssueWrite {
  number: string
  numberedOn: string
  issuedBy: string
  issuedAt: Date
  subtotal: string
  discount: string
  billTotal: string
  discountReason: string | null
  discountApprovedBy: string | null
  snapshot: unknown
}

/** draft -> issued in ONE update; the number comes from allocate_document_number in this same transaction. */
export async function markReceiptIssued(trx: ScopedTx, id: string, w: IssueWrite): Promise<void> {
  await trx.updateTable('documents').set({
    number: w.number,
    numbered_on: sql`${w.numberedOn}::date`,
    status: 'issued',
    issued_at: w.issuedAt,
    issued_by: w.issuedBy,
    bill_subtotal: w.subtotal,
    discount: w.discount,
    grand_total: w.billTotal,
    discount_reason: w.discountReason,
    discount_approved_by: w.discountApprovedBy,
    receipt_snapshot: JSON.stringify(w.snapshot),
  }).where('id', '=', id).execute()
}

export async function markReceiptVoid(trx: ScopedTx, id: string, input: { reason: string; voidedBy: string }): Promise<void> {
  await trx.updateTable('documents')
    .set({ status: 'void', void_reason: input.reason, voided_at: new Date(), voided_by: input.voidedBy })
    .where('id', '=', id).execute()
}

export async function allocateReceiptNumber(trx: ScopedTx, shopId: string): Promise<string> {
  const result = await sql<{ n: string }>`select allocate_document_number(${shopId}::uuid, 'REC') as n`.execute(trx)
  const n = result.rows[0]?.n
  if (!n) throw new Error('allocate_document_number returned nothing')
  return n
}

// -----------------------------------------------------------------------------
// Lines
// -----------------------------------------------------------------------------

export interface ReceiptLineRow {
  id: string
  source_line_id: string | null
  parent_line_id: string | null
  sort_order: number
  line_type: string
  name_snapshot: string
  brand_snapshot: string | null
  qty: string
  unit: string | null
  unit_price: string
  approved_amount: string | null
  line_total: string
  sku_id: string | null
  warranty_term_id: string | null
  warranty_name: string | null
  warranty_days: number | null
  warranty_max_km: number | null
  fulfilled_qty: string | null
  fulfilled_at: Date | null
  fulfilled_by: string | null
  fulfilled_by_name: string | null
}

const LINE_COLUMNS = [
  'dl.id', 'dl.source_line_id', 'dl.parent_line_id', 'dl.sort_order', 'dl.line_type', 'dl.name_snapshot',
  'dl.brand_snapshot', 'dl.qty', 'dl.unit', 'dl.unit_price', 'dl.approved_amount', 'dl.line_total', 'dl.sku_id',
  'dl.warranty_term_id', 'dl.warranty_name', 'dl.warranty_days', 'dl.warranty_max_km',
  'dl.fulfilled_qty', 'dl.fulfilled_at', 'dl.fulfilled_by', 'u.name as fulfilled_by_name',
] as const

export async function getReceiptLines(trx: ScopedTx, receiptId: string, opts: { lock?: boolean } = {}): Promise<ReceiptLineRow[]> {
  let q = trx.selectFrom('document_lines as dl')
    .leftJoin('users as u', 'u.id', 'dl.fulfilled_by')
    .select(LINE_COLUMNS)
    .where('dl.document_id', '=', receiptId)
    .orderBy('dl.sort_order', 'asc').orderBy('dl.id', 'asc')
  // FOR UPDATE OF dl: do not lock the users row the join touches.
  if (opts.lock) q = q.forUpdate('dl')
  return q.execute() as Promise<ReceiptLineRow[]>
}

/** The quotation's lines as the receipt copies them (sku_id included, which the quotation view never needs). */
export interface SourceLineRow {
  source_line_id: string | null
  id: string
  parent_line_id: string | null
  sort_order: number
  line_type: string
  catalog_item_id: string | null
  sku_id: string | null
  name_snapshot: string
  brand_snapshot: string | null
  qty: string
  unit: string | null
  unit_price: string
  is_vatable: boolean
  approval_status: string
  approved_amount: string | null
  warranty_term_id: string | null
  warranty_name: string | null
  warranty_days: number | null
  warranty_max_km: number | null
}

export async function getSourceLines(trx: ScopedTx, quotationId: string): Promise<SourceLineRow[]> {
  return trx.selectFrom('document_lines').select([
    'id', 'source_line_id', 'parent_line_id', 'sort_order', 'line_type', 'catalog_item_id', 'sku_id', 'name_snapshot',
    'brand_snapshot', 'qty', 'unit', 'unit_price', 'is_vatable', 'approval_status', 'approved_amount',
    'warranty_term_id', 'warranty_name', 'warranty_days', 'warranty_max_km',
  ]).where('document_id', '=', quotationId).orderBy('sort_order', 'asc').orderBy('id', 'asc').execute() as Promise<SourceLineRow[]>
}

export interface NewReceiptLine {
  shopId: string
  documentId: string
  parentLineId: string | null
  src: SourceLineRow
  sortOrder: number
  /** Carried tick (rebuild), already validated by the caller. */
  fulfilledQty?: string | null
  lineTotal?: string
  fulfilledBy?: string | null
}

export async function insertReceiptLine(trx: ScopedTx, l: NewReceiptLine): Promise<string> {
  const s = l.src
  const row = await trx.insertInto('document_lines').values({
    shop_id: l.shopId,
    document_id: l.documentId,
    parent_line_id: l.parentLineId,
    source_line_id: s.id,
    sort_order: l.sortOrder,
    line_type: s.line_type,
    catalog_item_id: s.catalog_item_id,
    sku_id: s.sku_id,
    name_snapshot: s.name_snapshot,
    brand_snapshot: s.brand_snapshot,
    qty: s.qty,
    unit: s.unit,
    unit_price: s.unit_price,
    is_vatable: s.is_vatable,
    approved_amount: s.approved_amount,
    // The receipt line is, by construction, an approved one.
    approval_status: 'approved',
    warranty_term_id: s.warranty_term_id,
    warranty_name: s.warranty_name,
    warranty_days: s.warranty_days,
    warranty_max_km: s.warranty_max_km,
    line_total: l.lineTotal ?? '0',
    fulfilled_qty: l.fulfilledQty ?? null,
    fulfilled_at: l.fulfilledQty != null ? new Date() : null,
    fulfilled_by: l.fulfilledBy ?? null,
  }).returning(['id']).executeTakeFirstOrThrow()
  return row.id
}

export async function writeTick(
  trx: ScopedTx,
  lineId: string,
  w: { fulfilledQty: string; lineTotal: string; by: string },
): Promise<void> {
  await trx.updateTable('document_lines')
    .set({ fulfilled_qty: w.fulfilledQty, line_total: w.lineTotal, fulfilled_at: new Date(), fulfilled_by: w.by })
    .where('id', '=', lineId).execute()
}

export async function writeLineTotal(trx: ScopedTx, lineId: string, lineTotal: string): Promise<void> {
  await trx.updateTable('document_lines').set({ line_total: lineTotal }).where('id', '=', lineId).execute()
}

// -----------------------------------------------------------------------------
// Payments
// -----------------------------------------------------------------------------

export interface PaymentRow {
  id: string
  method: string
  amount: string
  change_given: string
  received_at: Date
  received_by_name: string | null
  reversed: boolean
}

export async function getPayments(trx: ScopedTx, receiptId: string): Promise<PaymentRow[]> {
  const rows = await trx.selectFrom('payments as p')
    .leftJoin('users as u', 'u.id', 'p.received_by')
    .leftJoin('payment_reversals as r', 'r.payment_id', 'p.id')
    .select(['p.id', 'p.method', 'p.amount', 'p.change_given', 'p.received_at', 'u.name as received_by_name', 'r.id as reversal_id'])
    .where('p.document_id', '=', receiptId)
    .orderBy('p.received_at', 'asc').orderBy('p.id', 'asc')
    .execute()
  return rows.map((r) => ({
    id: r.id, method: r.method, amount: r.amount, change_given: r.change_given,
    received_at: r.received_at, received_by_name: r.received_by_name, reversed: r.reversal_id !== null,
  }))
}

export async function insertPayment(
  trx: ScopedTx,
  p: { shopId: string; documentId: string; method: string; amount: string; changeGiven: string; receivedBy: string; receivedAt: Date },
): Promise<string> {
  const row = await trx.insertInto('payments').values({
    shop_id: p.shopId, document_id: p.documentId, method: p.method, amount: p.amount,
    change_given: p.changeGiven, received_by: p.receivedBy, received_at: p.receivedAt,
  }).returning(['id']).executeTakeFirstOrThrow()
  return row.id
}

export async function insertReversal(
  trx: ScopedTx,
  r: { shopId: string; paymentId: string; documentId: string; method: string; amount: string; reason: string; by: string },
): Promise<void> {
  await trx.insertInto('payment_reversals').values({
    shop_id: r.shopId, payment_id: r.paymentId, document_id: r.documentId, method: r.method,
    amount: r.amount, reason: r.reason, reversed_by: r.by,
  }).execute()
}

// -----------------------------------------------------------------------------
// Job and people facts the receipt needs
// -----------------------------------------------------------------------------

export interface JobBillingFacts {
  id: string
  job_number: string
  status: string
  sub_state: string | null
  job_type: string
  customer_id: string
  mileage_in_km: number | null
  tax_invoice_requested: boolean
  customer_name: string | null
  customer_phone: string | null
  plate: string | null
  province: string | null
  brand: string | null
  model: string | null
}

export async function jobBillingFacts(trx: ScopedTx, jobId: string, opts: { lock?: boolean } = {}): Promise<JobBillingFacts | undefined> {
  let q = trx.selectFrom('jobs as j')
    .innerJoin('customers as c', 'c.id', 'j.customer_id')
    .innerJoin('vehicles as v', 'v.id', 'j.vehicle_id')
    .select([
      'j.id', 'j.job_number', 'j.status', 'j.sub_state', 'j.job_type', 'j.customer_id', 'j.mileage_in_km',
      'j.tax_invoice_requested', 'c.name as customer_name', 'c.phone as customer_phone',
      'v.plate', 'v.province', 'v.brand', 'v.model',
    ])
    .where('j.id', '=', jobId).where('j.deleted_at', 'is', null)
  // Lock the job row only (the customer and vehicle joins are read-only context).
  if (opts.lock) q = q.forUpdate('j')
  return q.executeTakeFirst()
}

export async function userNames(trx: ScopedTx, ids: ReadonlyArray<string | null>): Promise<Map<string, string>> {
  const want = [...new Set(ids.filter((x): x is string => !!x))]
  if (want.length === 0) return new Map()
  const rows = await trx.selectFrom('users').select(['id', 'name']).where('id', 'in', want).execute()
  return new Map(rows.map((r) => [r.id, r.name]))
}

export async function setTaxInvoiceRequested(
  trx: ScopedTx,
  jobId: string,
  w: { requested: boolean; by: string },
): Promise<void> {
  // Named columns only: never booking_id (trg_jobs_booking_immutable, see repositories/jobs.ts).
  await trx.updateTable('jobs').set({
    tax_invoice_requested: w.requested,
    tax_invoice_requested_at: w.requested ? new Date() : null,
    tax_invoice_requested_by: w.requested ? w.by : null,
  }).where('id', '=', jobId).execute()
}

/** A deposit still held against this job. P3.2 cannot offset it (B2). */
export async function heldDepositOfJob(trx: ScopedTx, jobId: string): Promise<{ id: string; amount: string } | undefined> {
  return trx.selectFrom('deposits').select(['id', 'amount'])
    .where('job_id', '=', jobId).where('status', '=', 'held').limit(1).executeTakeFirst()
}
