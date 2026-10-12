/**
 * Quotations (`documents.type = 'quotation'`) and their lines. Every function
 * takes a ScopedTx, so RLS scopes every row to the caller's shop.
 *
 * Writes here follow migration 0022's allow-lists exactly:
 *   - a draft row/line may change any column
 *   - once issued, a document may only move approved_total / discount (plus
 *     the columns of a legal status transition); a line may only move its
 *     five decision columns (+ approved_amount)
 *   - signed, superseded, void: frozen (except the documented exits)
 * Writing outside those columns is refused by the trigger with SQLSTATE
 * GS002, mapped to a 409 in lib/pgError.ts — this file never needs its own
 * "is this allowed" check for CONTENT; it only needs to check STATUS before
 * attempting a content write, so the error the caller sees is the service's
 * clean 409, not the database's.
 */
import { sql } from 'kysely'
import type { ScopedTx } from '@gsms/db/client.js'

export interface DocumentRow {
  id: string
  job_id: string | null
  customer_id: string
  revision: number
  status: string
  number: string | null
  supersedes_document_id: string | null
  issued_at: Date | null
  signed_at: Date | null
  void_reason: string | null
  voided_by: string | null
  offered_total: string
  approved_total: string
  discount: string
}

const DOCUMENT_COLUMNS = [
  'id', 'job_id', 'customer_id', 'revision', 'status', 'number', 'supersedes_document_id',
  'issued_at', 'signed_at', 'void_reason', 'voided_by', 'offered_total', 'approved_total', 'discount',
] as const

/** The one quotation still live for this job (draft/issued/signed) — uq_live_quotation_per_job guarantees at most one. */
export async function findLiveQuotation(trx: ScopedTx, jobId: string): Promise<DocumentRow | undefined> {
  return trx
    .selectFrom('documents')
    .select(DOCUMENT_COLUMNS)
    .where('job_id', '=', jobId)
    .where('type', '=', 'quotation')
    .where('status', 'in', ['draft', 'issued', 'signed'])
    .executeTakeFirst()
}

export async function getDocument(trx: ScopedTx, documentId: string): Promise<DocumentRow | undefined> {
  return trx.selectFrom('documents').select(DOCUMENT_COLUMNS).where('id', '=', documentId).executeTakeFirst()
}

/** Locks the document row so a concurrent issue/decide/confirm/undo/void/revise on it serialises. */
export async function lockDocument(trx: ScopedTx, documentId: string): Promise<DocumentRow | undefined> {
  return trx.selectFrom('documents').select(DOCUMENT_COLUMNS).where('id', '=', documentId).forUpdate().executeTakeFirst()
}

/** allocate_document_number (0003) takes SELECT ... FOR UPDATE on the series row — concurrent issues queue, never collide. */
export async function allocateQuotationNumber(trx: ScopedTx, shopId: string): Promise<string> {
  const result = await sql<{ n: string }>`select allocate_document_number(${shopId}::uuid, 'QUO') as n`.execute(trx)
  const n = result.rows[0]?.n
  if (!n) throw new Error('allocate_document_number returned nothing')
  return n
}

export async function insertDraftQuotation(
  trx: ScopedTx,
  input: { shopId: string; jobId: string; customerId: string },
): Promise<DocumentRow> {
  const row = await trx
    .insertInto('documents')
    .values({
      shop_id: input.shopId,
      job_id: input.jobId,
      customer_id: input.customerId,
      type: 'quotation',
      series: 'QUO',
      // status defaults to 'draft'; trg_documents_insert_draft would refuse
      // anything else anyway.
    })
    .returning(['id'])
    .executeTakeFirstOrThrow()
  return (await getDocument(trx, row.id))!
}

export async function setDraftDiscount(trx: ScopedTx, documentId: string, discount: string): Promise<void> {
  await trx.updateTable('documents').set({ discount }).where('id', '=', documentId).execute()
}

export interface LineRow {
  id: string
  document_id: string
  parent_line_id: string | null
  sort_order: number
  line_type: string
  catalog_item_id: string | null
  name_snapshot: string
  brand_snapshot: string | null
  qty: string
  unit: string | null
  unit_price: string
  list_price: string | null
  price_source: string | null
  price_ref_id: string | null
  is_vatable: boolean
  line_total: string
  approval_status: string
  decline_reason: string | null
  decline_note: string | null
  decided_at: Date | null
  decided_by: string | null
  decided_by_name: string | null
  approved_amount: string | null
  warranty_term_id: string | null
  warranty_name: string | null
  warranty_days: number | null
  warranty_max_km: number | null
  /** The line on the superseded revision this one was copied from (null for new lines / rev 1). */
  source_line_id: string | null
  src_decided_at: Date | null
  src_catalog_item_id: string | null
  src_name: string | null
  src_line_type: string | null
  src_qty: string | null
  src_unit_price: string | null
  src_warranty_term_id: string | null
  src_warranty_days: number | null
  src_warranty_max_km: number | null
}

const LINE_COLUMNS = [
  'dl.id', 'dl.document_id', 'dl.parent_line_id', 'dl.sort_order', 'dl.line_type', 'dl.catalog_item_id',
  'dl.name_snapshot', 'dl.brand_snapshot', 'dl.qty', 'dl.unit', 'dl.unit_price', 'dl.list_price',
  'dl.price_source', 'dl.price_ref_id', 'dl.is_vatable', 'dl.line_total',
  'dl.approval_status', 'dl.decline_reason', 'dl.decline_note', 'dl.decided_at', 'dl.decided_by',
  'u.name as decided_by_name', 'dl.approved_amount',
  'dl.warranty_term_id', 'dl.warranty_name', 'dl.warranty_days', 'dl.warranty_max_km',
  'dl.source_line_id',
  'src.decided_at as src_decided_at', 'src.catalog_item_id as src_catalog_item_id', 'src.name_snapshot as src_name',
  'src.line_type as src_line_type', 'src.qty as src_qty', 'src.unit_price as src_unit_price',
  'src.warranty_term_id as src_warranty_term_id', 'src.warranty_days as src_warranty_days',
  'src.warranty_max_km as src_warranty_max_km',
] as const

export async function getLines(trx: ScopedTx, documentId: string): Promise<LineRow[]> {
  return trx
    .selectFrom('document_lines as dl')
    .leftJoin('users as u', 'u.id', 'dl.decided_by')
    .leftJoin('document_lines as src', 'src.id', 'dl.source_line_id')
    .select(LINE_COLUMNS)
    .where('dl.document_id', '=', documentId)
    .orderBy('dl.sort_order', 'asc')
    .execute()
}

export async function getLine(trx: ScopedTx, documentId: string, lineId: string): Promise<LineRow | undefined> {
  return trx
    .selectFrom('document_lines as dl')
    .leftJoin('users as u', 'u.id', 'dl.decided_by')
    .leftJoin('document_lines as src', 'src.id', 'dl.source_line_id')
    .select(LINE_COLUMNS)
    .where('dl.document_id', '=', documentId)
    .where('dl.id', '=', lineId)
    .executeTakeFirst()
}

export interface NewLine {
  shopId: string
  documentId: string
  parentLineId: string | null
  sortOrder: number
  lineType: string
  catalogItemId: string | null
  nameSnapshot: string
  brandSnapshot: string | null
  qty: string
  unit: string | null
  unitPrice: string
  listPrice: string | null
  priceSource: string | null
  priceRefId: string | null
  isVatable: boolean
  lineTotal: string
  warrantyTermId: string | null
  warrantyName: string | null
  warrantyDays: number | null
  warrantyMaxKm: number | null
  /** Revision copy only: the line this one came from, and its decision carried over as-is. */
  sourceLineId?: string | null
  decision?: {
    approvalStatus: string; decidedAt: Date | null; decidedBy: string | null
    declineReason: string | null; declineNote: string | null; approvedAmount: string | null
  } | null
}

/** Insert one or more lines (a set header plus its children) in one statement. Draft only — the trigger enforces that. */
export async function insertLines(trx: ScopedTx, lines: readonly NewLine[]): Promise<string[]> {
  if (lines.length === 0) return []
  const rows = await trx
    .insertInto('document_lines')
    .values(lines.map((l) => ({
      shop_id: l.shopId,
      document_id: l.documentId,
      parent_line_id: l.parentLineId,
      sort_order: l.sortOrder,
      line_type: l.lineType,
      catalog_item_id: l.catalogItemId,
      name_snapshot: l.nameSnapshot,
      brand_snapshot: l.brandSnapshot,
      qty: l.qty,
      unit: l.unit,
      unit_price: l.unitPrice,
      list_price: l.listPrice,
      price_source: l.priceSource,
      price_ref_id: l.priceRefId,
      is_vatable: l.isVatable,
      line_total: l.lineTotal,
      warranty_term_id: l.warrantyTermId,
      warranty_name: l.warrantyName,
      warranty_days: l.warrantyDays,
      warranty_max_km: l.warrantyMaxKm,
      source_line_id: l.sourceLineId ?? null,
      ...(l.decision ? {
        approval_status: l.decision.approvalStatus, decided_at: l.decision.decidedAt, decided_by: l.decision.decidedBy,
        decline_reason: l.decision.declineReason, decline_note: l.decision.declineNote, approved_amount: l.decision.approvedAmount,
      } : {}),
    })))
    .returning(['id'])
    .execute()
  return rows.map((r) => r.id)
}

export interface PatchLine {
  nameSnapshot?: string
  brandSnapshot?: string | null
  lineType?: string
  qty?: string
  unit?: string | null
  unitPrice?: string
  listPrice?: string | null
  priceSource?: string | null
  priceRefId?: string | null
  isVatable?: boolean
  lineTotal?: string
  warrantyTermId?: string | null
  warrantyName?: string | null
  warrantyDays?: number | null
  warrantyMaxKm?: number | null
  sortOrder?: number
}

export async function updateLineContent(trx: ScopedTx, documentId: string, lineId: string, patch: PatchLine): Promise<void> {
  const set: Record<string, unknown> = {}
  if (patch.nameSnapshot !== undefined) set.name_snapshot = patch.nameSnapshot
  if (patch.brandSnapshot !== undefined) set.brand_snapshot = patch.brandSnapshot
  if (patch.lineType !== undefined) set.line_type = patch.lineType
  if (patch.qty !== undefined) set.qty = patch.qty
  if (patch.unit !== undefined) set.unit = patch.unit
  if (patch.unitPrice !== undefined) set.unit_price = patch.unitPrice
  if (patch.listPrice !== undefined) set.list_price = patch.listPrice
  if (patch.priceSource !== undefined) set.price_source = patch.priceSource
  if (patch.priceRefId !== undefined) set.price_ref_id = patch.priceRefId
  if (patch.isVatable !== undefined) set.is_vatable = patch.isVatable
  if (patch.lineTotal !== undefined) set.line_total = patch.lineTotal
  if (patch.warrantyTermId !== undefined) set.warranty_term_id = patch.warrantyTermId
  if (patch.warrantyName !== undefined) set.warranty_name = patch.warrantyName
  if (patch.warrantyDays !== undefined) set.warranty_days = patch.warrantyDays
  if (patch.warrantyMaxKm !== undefined) set.warranty_max_km = patch.warrantyMaxKm
  if (patch.sortOrder !== undefined) set.sort_order = patch.sortOrder
  if (Object.keys(set).length === 0) return
  await trx.updateTable('document_lines').set(set).where('id', '=', lineId).where('document_id', '=', documentId).execute()
}

/** Draft only (the trigger refuses it otherwise); children cascade via ON DELETE CASCADE. */
export async function deleteLine(trx: ScopedTx, documentId: string, lineId: string): Promise<void> {
  // document_id in the WHERE besides RLS: a line of another document is never touched.
  await trx.deleteFrom('document_lines').where('id', '=', lineId).where('document_id', '=', documentId).execute()
}

export interface DecisionWrite {
  lineId: string
  approvalStatus: string
  declineReason: string | null
  declineNote: string | null
  decidedBy: string
}

export async function applyDecisions(trx: ScopedTx, changes: readonly DecisionWrite[]): Promise<void> {
  for (const c of changes) {
    await trx
      .updateTable('document_lines')
      .set({
        approval_status: c.approvalStatus,
        decided_at: new Date(),
        decided_by: c.decidedBy,
        decline_reason: c.declineReason,
        decline_note: c.declineNote,
      })
      .where('id', '=', c.lineId)
      .execute()
  }
}

/**
 * What the current confirm of this document recorded about the job, read from the
 * structured `after` of its newest `quotation_confirmed` audit row (never from any
 * message text). `jobAdvancedFrom` is the status confirm moved the job FROM, or null
 * when confirm left the job alone. undefined = no such row (confirmed before this
 * field existed): the caller must then not move the job.
 * Relies on idx_audit_entity (shop_id, entity_type, entity_id).
 */
export async function latestConfirmAfter(trx: ScopedTx, documentId: string): Promise<{ jobAdvancedFrom: string | null } | undefined> {
  const row = await trx
    .selectFrom('audit_logs')
    .select(sql<string | null>`after ->> 'jobAdvancedFrom'`.as('job_advanced_from'))
    .select(sql<boolean>`jsonb_exists(after, 'jobAdvancedFrom')`.as('has_field'))
    .where('entity_type', '=', 'documents')
    .where('entity_id', '=', documentId)
    .where('action', '=', 'quotation_confirmed')
    .orderBy('at', 'desc')
    .limit(1)
    .executeTakeFirst()
  if (!row || !row.has_field) return undefined
  return { jobAdvancedFrom: row.job_advanced_from }
}

/** Draft only: a changed line forgets what the customer decided about the old offer (owner Q2). */
export async function resetDecision(trx: ScopedTx, lineId: string): Promise<void> {
  await trx
    .updateTable('document_lines')
    .set({ approval_status: 'pending', decided_at: null, decided_by: null, decline_reason: null, decline_note: null, approved_amount: null })
    .where('id', '=', lineId)
    .execute()
}

/**
 * Decline the lines that are STILL pending. The approval_status predicate is
 * defence in depth beneath the document lock: a decision recorded a moment
 * earlier is never overwritten by a close.
 */
export async function declinePending(
  trx: ScopedTx,
  lineIds: readonly string[],
  input: { declineReason: string; declineNote: string | null; decidedBy: string },
): Promise<void> {
  if (lineIds.length === 0) return
  await trx
    .updateTable('document_lines')
    .set({ approval_status: 'declined', decided_at: new Date(), decided_by: input.decidedBy, decline_reason: input.declineReason, decline_note: input.declineNote })
    .where('id', 'in', lineIds)
    .where('approval_status', '=', 'pending')
    .execute()
}

export async function setApprovedAmount(trx: ScopedTx, lineId: string, amount: string | null): Promise<void> {
  await trx.updateTable('document_lines').set({ approved_amount: amount }).where('id', '=', lineId).execute()
}

export interface IssueWrite {
  number: string
  offeredTotal: string
  approvedTotal: string
  discount: string
  grandTotal: string
  issuedBy: string
}

export async function markIssued(trx: ScopedTx, documentId: string, w: IssueWrite): Promise<void> {
  await trx
    .updateTable('documents')
    .set({
      number: w.number,
      numbered_on: sql`current_date`,
      status: 'issued',
      issued_at: new Date(),
      issued_by: w.issuedBy,
      offered_total: w.offeredTotal,
      approved_total: w.approvedTotal,
      discount: w.discount,
      grand_total: w.grandTotal,
    })
    .where('id', '=', documentId)
    .execute()
}

export async function updateApprovedTotal(trx: ScopedTx, documentId: string, approvedTotal: string): Promise<void> {
  await trx.updateTable('documents').set({ approved_total: approvedTotal }).where('id', '=', documentId).execute()
}

export async function markSigned(trx: ScopedTx, documentId: string, approvedTotal: string, discount: string): Promise<void> {
  await trx
    .updateTable('documents')
    .set({ approved_total: approvedTotal, discount, status: 'signed', signed_at: new Date() })
    .where('id', '=', documentId)
    .execute()
}

export async function markUnsigned(trx: ScopedTx, documentId: string): Promise<void> {
  await trx.updateTable('documents').set({ status: 'issued', signed_at: null }).where('id', '=', documentId).execute()
}

export async function markSuperseded(trx: ScopedTx, documentId: string): Promise<void> {
  await trx.updateTable('documents').set({ status: 'superseded' }).where('id', '=', documentId).execute()
}

export async function markVoid(
  trx: ScopedTx,
  documentId: string,
  input: { reason: string; voidedBy: string | null },
): Promise<void> {
  await trx
    .updateTable('documents')
    .set({ status: 'void', void_reason: input.reason, voided_at: new Date(), voided_by: input.voidedBy })
    .where('id', '=', documentId)
    .execute()
}

export async function insertRevision(
  trx: ScopedTx,
  input: { shopId: string; jobId: string; customerId: string; revision: number; supersedesDocumentId: string; discount: string },
): Promise<DocumentRow> {
  const row = await trx
    .insertInto('documents')
    .values({
      shop_id: input.shopId,
      job_id: input.jobId,
      customer_id: input.customerId,
      type: 'quotation',
      series: 'QUO',
      revision: input.revision,
      supersedes_document_id: input.supersedesDocumentId,
      discount: input.discount,
    })
    .returning(['id'])
    .executeTakeFirstOrThrow()
  return (await getDocument(trx, row.id))!
}

// -----------------------------------------------------------------------------
// vehicle_offered_items ("เคยเสนอไว้")
// -----------------------------------------------------------------------------

export interface OfferedItemRow {
  id: string
  name: string
  offered_at: Date
  document_line_id: string
}

export async function insertOfferedItem(
  trx: ScopedTx,
  input: { shopId: string; vehicleId: string; documentLineId: string; name: string; catalogItemId: string | null },
): Promise<void> {
  // Same vehicle + same item is offered once: when an earlier revision (or an earlier visit) already
  // left an active row for it, skip. "Same item" = same catalog item, or for free text the same
  // price_key of the name. Revise keeps the old rows, so this is what stops rev 2 duplicating them.
  // Undo-confirm removes only rows whose line belongs to the undone document, so a skipped row is never lost.
  await sql`
    insert into vehicle_offered_items (shop_id, vehicle_id, document_line_id, name)
    select ${input.shopId}, ${input.vehicleId}, ${input.documentLineId}, ${input.name}
    where not exists (
      select 1
        from vehicle_offered_items voi
        join document_lines dl on dl.id = voi.document_line_id
       where voi.vehicle_id = ${input.vehicleId}
         and voi.status = 'declined'
         and (
           (${input.catalogItemId}::uuid is not null and dl.catalog_item_id = ${input.catalogItemId}::uuid)
           or (${input.catalogItemId}::uuid is null and dl.catalog_item_id is null and price_key(voi.name) = price_key(${input.name}))
         )
    )
    on conflict (document_line_id) do nothing`.execute(trx)
}

export async function deleteOfferedItemsOfDocument(trx: ScopedTx, documentId: string): Promise<void> {
  await trx
    .deleteFrom('vehicle_offered_items')
    .where('document_line_id', 'in', (qb) => qb.selectFrom('document_lines').select('id').where('document_id', '=', documentId))
    .execute()
}

export interface OfferedItemListRow {
  id: string
  name: string
  offered_at: Date
  line_type: string
  catalog_item_id: string | null
  unit_price: string
  qty: string
}

export async function listOfferedItems(
  trx: ScopedTx,
  vehicleId: string,
  limit: number,
  offset: number,
): Promise<{ rows: OfferedItemListRow[]; total: number }> {
  const base = trx
    .selectFrom('vehicle_offered_items as voi')
    .innerJoin('document_lines as dl', 'dl.id', 'voi.document_line_id')
    .where('voi.vehicle_id', '=', vehicleId)
    .where('voi.status', '=', 'declined')
  const [rows, countRow] = await Promise.all([
    base
      .select(['voi.id', 'voi.name', 'voi.offered_at', 'dl.line_type', 'dl.catalog_item_id', 'dl.unit_price', 'dl.qty'])
      .orderBy('voi.offered_at', 'desc')
      .limit(limit)
      .offset(offset)
      .execute(),
    base.select((eb) => eb.fn.countAll().as('n')).executeTakeFirst(),
  ])
  return { rows, total: Number(countRow?.n ?? 0) }
}

export async function getOfferedItem(trx: ScopedTx, offeredItemId: string): Promise<(OfferedItemListRow & { vehicle_id: string; status: string }) | undefined> {
  return trx
    .selectFrom('vehicle_offered_items as voi')
    .innerJoin('document_lines as dl', 'dl.id', 'voi.document_line_id')
    .select(['voi.id', 'voi.name', 'voi.offered_at', 'voi.vehicle_id', 'voi.status', 'dl.line_type', 'dl.catalog_item_id', 'dl.unit_price', 'dl.qty'])
    .where('voi.id', '=', offeredItemId)
    .executeTakeFirst()
}

// -----------------------------------------------------------------------------
// Work order — approved lines only, NO price columns selected, ever.
// -----------------------------------------------------------------------------

export interface WorkOrderLineRow {
  id: string
  parent_line_id: string | null
  sort_order: number
  line_type: string
  name_snapshot: string
  brand_snapshot: string | null
  qty: string
  unit: string | null
  warranty_name: string | null
}

// -----------------------------------------------------------------------------
// The job this quotation belongs to, with its vehicle (for price resolution,
// the work order header, and the status-close integration).
// -----------------------------------------------------------------------------

export interface JobWithVehicleRow {
  id: string
  job_number: string
  status: string
  customer_id: string
  vehicle_id: string
  vehicle_model_id: string | null
  plate: string | null
  province: string | null
  brand: string | null
  model: string | null
}

export async function jobWithVehicle(trx: ScopedTx, jobId: string): Promise<JobWithVehicleRow | undefined> {
  return trx
    .selectFrom('jobs as j')
    .innerJoin('vehicles as v', 'v.id', 'j.vehicle_id')
    .select([
      'j.id', 'j.job_number', 'j.status', 'j.customer_id', 'j.vehicle_id', 'v.vehicle_model_id',
      'v.plate', 'v.province', 'v.brand', 'v.model',
    ])
    .where('j.id', '=', jobId)
    .where('j.deleted_at', 'is', null)
    .executeTakeFirst()
}

/** Locks the job row FOR UPDATE — used before a job-status write triggered by confirm/undo-confirm. */
export async function lockJob(trx: ScopedTx, jobId: string): Promise<{ id: string; status: string; sub_state: string | null } | undefined> {
  return trx
    .selectFrom('jobs')
    .select(['id', 'status', 'sub_state'])
    .where('id', '=', jobId)
    .where('deleted_at', 'is', null)
    .forUpdate()
    .executeTakeFirst()
}

export async function getApprovedLines(trx: ScopedTx, documentId: string): Promise<WorkOrderLineRow[]> {
  return trx
    .selectFrom('document_lines')
    .select(['id', 'parent_line_id', 'sort_order', 'line_type', 'name_snapshot', 'brand_snapshot', 'qty', 'unit', 'warranty_name'])
    .where('document_id', '=', documentId)
    .where('approval_status', '=', 'approved')
    .orderBy('sort_order', 'asc')
    .execute()
}
