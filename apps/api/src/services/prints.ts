/**
 * Print history (DECISION-2026-10-15 s2): "พิมพ์ครั้งที่ N" and the warning when a
 * paper already in the customer's hand no longer matches the system.
 *
 * The browser prints, the server counts. The client calls recordPrint BEFORE
 * window.print(); the row it creates is where N on the paper comes from, so N can
 * never be a number the history does not contain. What is recorded is "the system
 * produced a print", not "paper came out" - the browser cannot tell a print from a
 * cancelled dialog (AC-G11).
 *
 * Changed content: each print stores a sha-256 of the printable content as it
 * stood. The next print (or the history read) compares the content NOW with the
 * latest stored hash. That is a comparison of what was shown, not a guess from
 * timestamps (AC-G5).
 *
 * Lock order: job -> document (the quotation or the receipt). A work order has no
 * document of its own, so its counter is serialised by the job lock alone.
 */
import { createHash } from 'node:crypto'
import { workOrderLineIds } from '@champpower/domain'
import type { PrintHistory, PrintResult } from '@gsms/contracts/index.js'
import type { ScopedTx } from '@gsms/db/client.js'
import * as quotationRepo from '../repositories/quotation.js'
import * as receiptRepo from '../repositories/receipt.js'
import * as printsRepo from '../repositories/prints.js'
import { writeAudit } from './audit.js'

type DocType = 'quotation' | 'work_order' | 'receipt'

export type PrintError =
  | { code: 'job_not_found' }
  | { code: 'quotation_missing' }
  | { code: 'quotation_not_confirmed' }
  | { code: 'receipt_not_found' }
  | { code: 'receipt_not_issued' }
  | { code: 'print_content_changed'; printCount: number; lastPrintedAt: string }

type Result<T> = { ok: true; value: T } | { ok: false; error: PrintError }
const err = (error: PrintError): { ok: false; error: PrintError } => ({ ok: false, error })
const ok = <T>(value: T): { ok: true; value: T } => ({ ok: true, value })

interface Subject {
  subjectId: string
  documentId: string | null
  number: string | null
  status: string
  revision: number | null
  hash: string
  mark: 'draft' | 'void' | null
}

const sha = (v: unknown): string => createHash('sha256').update(JSON.stringify(v)).digest('hex')

/** Resolve what is being printed and fingerprint its printable content. `lock` takes the document row. */
async function resolve(trx: ScopedTx, jobId: string, docType: DocType, lock: boolean): Promise<Result<Subject>> {
  if (docType === 'receipt') {
    const found = await receiptRepo.findReceiptOfJob(trx, jobId)
    if (!found) return err({ code: 'receipt_not_found' })
    const doc = lock ? await receiptRepo.lockReceipt(trx, found.id) : found
    if (!doc) return err({ code: 'receipt_not_found' })
    if (doc.status === 'draft') return err({ code: 'receipt_not_issued' })
    const lines = await receiptRepo.getReceiptLines(trx, doc.id)
    return ok({
      subjectId: doc.id, documentId: doc.id, number: doc.number, status: doc.status, revision: null,
      mark: doc.status === 'void' ? 'void' : null,
      // An issued receipt is frozen, so this only ever changes by being voided - which is exactly
      // the change a reprint should warn about.
      hash: sha({ n: doc.number, st: doc.status, t: doc.grand_total, d: doc.discount, l: lines.map((l) => [l.id, l.name_snapshot, l.qty, l.fulfilled_qty, l.unit_price, l.line_total]) }),
    })
  }

  const live0 = await quotationRepo.findLiveQuotation(trx, jobId)
  if (!live0) return err({ code: 'quotation_missing' })
  const doc = lock ? await quotationRepo.lockDocument(trx, live0.id) : live0
  if (!doc) return err({ code: 'quotation_missing' })
  const lines = await quotationRepo.getLines(trx, doc.id)

  if (docType === 'quotation') {
    return ok({
      subjectId: doc.id, documentId: doc.id, number: doc.number, status: doc.status, revision: doc.revision,
      mark: doc.status === 'draft' ? 'draft' : null,
      // Everything the paper shows: both totals, both discounts, every line with its decision.
      hash: sha({
        n: doc.number, st: doc.status, r: doc.revision, ot: doc.offered_total, at: doc.approved_total,
        d: doc.discount, od: doc.offered_discount,
        l: lines.map((l) => [l.id, l.parent_line_id, l.name_snapshot, l.qty, l.unit_price, l.approval_status, l.approved_amount, l.decline_reason]),
      }),
    })
  }

  // work_order: the approved lines of the CONFIRMED quotation; counted per job.
  if (doc.status !== 'signed') return err({ code: 'quotation_not_confirmed' })
  const keep = new Set(workOrderLineIds(lines.map((l) => ({
    id: l.id, parentLineId: l.parent_line_id, approvalStatus: l.approval_status as 'approved' | 'pending' | 'declined',
    declineReason: null, declineNote: null,
  }))))
  return ok({
    subjectId: jobId, documentId: null, number: null, status: doc.status, revision: doc.revision, mark: null,
    hash: sha({ q: doc.id, r: doc.revision, l: lines.filter((l) => keep.has(l.id)).map((l) => [l.id, l.name_snapshot, l.qty, l.unit, l.warranty_name]) }),
  })
}

export async function recordPrint(
  trx: ScopedTx, shopId: string, jobId: string, actor: { id: string },
  input: { docType: DocType; copySet: PrintResult['copySet']; acknowledgeChange: boolean },
): Promise<Result<PrintResult>> {
  const job = await receiptRepo.jobBillingFacts(trx, jobId, { lock: true })
  if (!job) return err({ code: 'job_not_found' })
  const s = await resolve(trx, jobId, input.docType, true)
  if (!s.ok) return s
  const sub = s.value

  const last = await printsRepo.latestPrint(trx, input.docType, sub.subjectId)
  const changed = !!last && last.content_hash !== sub.hash
  if (changed && !input.acknowledgeChange) {
    return err({ code: 'print_content_changed', printCount: last!.seq, lastPrintedAt: last!.printed_at.toISOString() })
  }
  const seq = (last?.seq ?? 0) + 1
  const row = await printsRepo.insertPrint(trx, {
    shopId, jobId, documentId: sub.documentId, docType: input.docType, subjectId: sub.subjectId, seq,
    statusAtPrint: sub.status, revision: sub.revision, copySet: input.copySet, contentHash: sub.hash,
    acknowledgedChange: changed && input.acknowledgeChange, printedBy: actor.id,
  })
  const names = await receiptRepo.userNames(trx, [actor.id])
  // A reprint of a receipt is where cheating hides, so it is audited as well as counted.
  if (input.docType === 'receipt' && seq > 1) {
    await writeAudit(trx, {
      shopId, actorId: actor.id, action: 'receipt_reprinted', entityType: 'documents', entityId: sub.subjectId,
      after: { printNo: seq },
    })
  }
  return ok({
    docType: input.docType, subjectId: sub.subjectId, documentNumber: sub.number, printNo: seq, isReprint: seq > 1,
    printedAt: row.printedAt.toISOString(), printedByName: names.get(actor.id) ?? null, statusAtPrint: sub.status,
    copySet: input.copySet, mark: sub.mark,
    previous: last ? { seq: last.seq, printedAt: last.printed_at.toISOString(), printedByName: last.printed_by_name } : null,
    contentChangedSincePrevious: changed,
  })
}

export async function history(
  trx: ScopedTx, jobId: string, docType: DocType, limit: number, offset: number,
): Promise<Result<PrintHistory>> {
  const job = await receiptRepo.jobBillingFacts(trx, jobId)
  if (!job) return err({ code: 'job_not_found' })
  const s = await resolve(trx, jobId, docType, false)
  // Nothing printable (yet) is not an error for a history read: there is simply nothing to warn about.
  if (!s.ok) {
    return ok({ docType, subjectId: docType === 'work_order' ? jobId : null, documentNumber: null, printCount: 0, contentChangedSinceLastPrint: false, items: [], total: 0 })
  }
  const sub = s.value
  const [{ rows, total }, last] = await Promise.all([
    printsRepo.listPrints(trx, docType, sub.subjectId, limit, offset),
    printsRepo.latestPrint(trx, docType, sub.subjectId),
  ])
  return ok({
    docType, subjectId: sub.subjectId, documentNumber: sub.number, printCount: total,
    contentChangedSinceLastPrint: !!last && last.content_hash !== sub.hash,
    items: rows.map((r) => ({
      id: r.id, seq: r.seq, printedAt: r.printed_at.toISOString(), printedByName: r.printed_by_name,
      statusAtPrint: r.status_at_print, revision: r.revision, copySet: r.copy_set as PrintResult['copySet'],
      acknowledgedChange: r.acknowledged_change,
    })),
    total,
  })
}
