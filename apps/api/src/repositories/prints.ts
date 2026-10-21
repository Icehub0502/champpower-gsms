/**
 * document_prints (0025): one append-only row per print action. RLS scopes every
 * query to the caller's shop.
 */
import type { ScopedTx } from '@gsms/db/client.js'

export interface PrintRow {
  id: string
  seq: number
  printed_at: Date
  printed_by_name: string | null
  status_at_print: string
  revision: number | null
  copy_set: string
  acknowledged_change: boolean
  content_hash: string
}

const COLS = [
  'p.id', 'p.seq', 'p.printed_at', 'u.name as printed_by_name', 'p.status_at_print', 'p.revision',
  'p.copy_set', 'p.acknowledged_change', 'p.content_hash',
] as const

export async function latestPrint(trx: ScopedTx, docType: string, subjectId: string): Promise<PrintRow | undefined> {
  return trx.selectFrom('document_prints as p').leftJoin('users as u', 'u.id', 'p.printed_by')
    .select(COLS).where('p.doc_type', '=', docType).where('p.subject_id', '=', subjectId)
    .orderBy('p.seq', 'desc').limit(1).executeTakeFirst()
}

export async function listPrints(
  trx: ScopedTx, docType: string, subjectId: string, limit: number, offset: number,
): Promise<{ rows: PrintRow[]; total: number }> {
  const rows = await trx.selectFrom('document_prints as p').leftJoin('users as u', 'u.id', 'p.printed_by')
    .select(COLS).where('p.doc_type', '=', docType).where('p.subject_id', '=', subjectId)
    .orderBy('p.seq', 'desc').limit(limit).offset(offset).execute()
  const t = await trx.selectFrom('document_prints').select((eb) => eb.fn.countAll<number>().as('n'))
    .where('doc_type', '=', docType).where('subject_id', '=', subjectId).executeTakeFirstOrThrow()
  return { rows, total: Number(t.n) }
}

export async function insertPrint(trx: ScopedTx, p: {
  shopId: string; jobId: string | null; documentId: string | null; docType: string; subjectId: string; seq: number
  statusAtPrint: string; revision: number | null; copySet: string; contentHash: string
  acknowledgedChange: boolean; printedBy: string
}): Promise<{ id: string; printedAt: Date }> {
  const r = await trx.insertInto('document_prints').values({
    shop_id: p.shopId, job_id: p.jobId, document_id: p.documentId, doc_type: p.docType, subject_id: p.subjectId,
    seq: p.seq, status_at_print: p.statusAtPrint, revision: p.revision, copy_set: p.copySet,
    content_hash: p.contentHash, acknowledged_change: p.acknowledgedChange, printed_by: p.printedBy,
  }).returning(['id', 'printed_at']).executeTakeFirstOrThrow()
  return { id: r.id, printedAt: r.printed_at }
}
