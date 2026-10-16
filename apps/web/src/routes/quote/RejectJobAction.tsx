import { useState } from 'react';
import type { DeclineReason } from '@champpower/domain';
import type { JobDetail, Quotation, UpdateJobStatusInput, UpdateJobStatusResult } from '@gsms/contracts/index.js';
import { Modal } from '../../components/ui/Modal';
import { api } from '../../lib/api/client';
import { DeclineForm } from './DeclineForm';
import type { QuoteFailure } from './quoteErrors';
import { DECLINE_REASON_OPTIONS } from './quoteLabels';
import type { QuotationState } from './useQuotation';

type JobDeclineReason = NonNullable<UpdateJobStatusInput['declineReason']>;

/** The job-status door takes every decline reason except chose_alternative (D13). */
function isJobDeclineReason(r: DeclineReason): r is DeclineReason & JobDeclineReason {
  return r !== 'chose_alternative';
}

/**
 * Closing a job as "ไม่อนุมัติ" is not a refusal of an alternative (D13), so
 * chose_alternative is not offered — the job-status door does not accept it.
 */
const CLOSE_REASONS = DECLINE_REASON_OPTIONS.filter(isJobDeclineReason);

interface RejectJobActionProps {
  job: JobDetail;
  quotation: Quotation | null;
  busyKey: string | null;
  guard: QuotationState['guard'];
  onRejected: (result: UpdateJobStatusResult) => void;
  /** The screen was out of date (status_changed, or the server wanted a reason we did not ask for): re-read job and quotation. */
  onStale: () => void;
  /** Someone moved the job meanwhile (409 status_changed). The page shows the notice. */
  onStatusChanged: () => void;
}

function failureText(f: QuoteFailure): string {
  // The job-status door's own refusals are not in QuotationBody.
  if (f.body === null && f.code === 'illegal_status_move') return 'งานนี้อยู่ในสถานะที่ปิดเป็น “ไม่อนุมัติ” ไม่ได้แล้ว';
  return f.text;
}

/**
 * "ไม่อนุมัติ" for the whole job (v3 §6.4, Q1), through the same job-status
 * door /today uses (PATCH /api/jobs/:id/status). While the issued quotation
 * still has lines the customer has not answered, the server requires WHY —
 * the one place the owner's "why customers say no" report gets its answer for
 * these cases — so the dialog asks with the §5.7 dropdown plus free text. The
 * server then declines those lines with that reason and closes the quotation
 * (void_reason job_closed) in one transaction.
 */
export function RejectJobAction({ job, quotation, busyKey, guard, onRejected, onStale, onStatusChanged }: RejectJobActionProps) {
  const [open, setOpen] = useState(false);
  const [failure, setFailure] = useState<QuoteFailure | null>(null);
  const busy = busyKey !== null;
  const pending = quotation?.status === 'issued' ? quotation.next.undecidedLineIds.length : 0;
  // The quotation on screen can be stale (null, or a draft someone has since
  // issued elsewhere). The server is the judge: once it has asked for a reason,
  // the form stays (review M2).
  const [serverWantsReason, setServerWantsReason] = useState(false);
  const needsReason = pending > 0 || serverWantsReason;

  async function reject(reason?: DeclineReason, note?: string): Promise<boolean> {
    setFailure(null);
    const body: UpdateJobStatusInput = {
      to: 'rejected',
      fromStatus: job.status,
      ...(reason && isJobDeclineReason(reason) ? { declineReason: reason } : {}),
      ...(note ? { declineNote: note } : {}),
    };
    const result = await guard('reject', () =>
      api.patch<UpdateJobStatusResult>(`/api/jobs/${encodeURIComponent(job.jobId)}/status`, body));
    if (result.ok) {
      setOpen(false);
      onRejected(result.value);
      return true;
    }
    if (result.failure.cancelled) return false;
    setFailure(result.failure);
    if (result.failure.fields.declineReason) {
      setServerWantsReason(true);
      onStale();
    } else if (result.failure.code === 'status_changed') {
      // Said by the PAGE (onStatusChanged), not in this dialog: the reload that
      // follows may take "rejected" out of allowedMoves and unmount the dialog.
      onStatusChanged();
      onStale();
    }
    return false;
  }

  // The server names the job-status fields declineReason / declineNote; the form's are reason / note.
  const fields: Record<string, string> = {};
  if (failure?.fields.declineReason) fields.reason = failure.fields.declineReason;
  if (failure?.fields.declineNote) fields.note = failure.fields.declineNote;
  const dialogText = failure && failure.code !== 'status_changed' && Object.keys(fields).length === 0 ? failureText(failure) : null;

  return (
    <>
      <button type="button" className="btn danger" disabled={busy} onClick={() => { setFailure(null); setServerWantsReason(false); setOpen(true); }}>
        ไม่อนุมัติ (ปิดงาน)…
      </button>
      {open && (
        <Modal title="ไม่อนุมัติ — ปิดงาน" onClose={() => { if (!busy) setOpen(false); }}>
          <div className="ci-dialog">
            <p>
              <strong>{job.jobNumber}</strong> {job.plate ?? ''} จะถูกปิดเป็น “ไม่อนุมัติ” และออกจากกระดาน ย้อนกลับไม่ได้
            </p>
            {needsReason && (
              pending > 0
                ? <p>ลูกค้ายังไม่ได้ตอบอีก <strong>{pending}</strong> รายการ — เลือกเหตุผลที่ลูกค้าไม่เอา ระบบจะบันทึกเหตุผลนี้ให้ทุกรายการที่ค้างอยู่</p>
                : <p>มีรายการที่ลูกค้ายังไม่ได้ตัดสิน กรุณาเลือกเหตุผล</p>
            )}
            {dialogText && <p className="ci-form-error" role="alert">{dialogText}</p>}
            {needsReason ? (
              <DeclineForm
                busy={busy}
                saving={busyKey === 'reject'}
                fields={fields}
                options={CLOSE_REASONS}
                submitLabel="ยืนยันไม่อนุมัติ"
                onSubmit={(reason, note) => void reject(reason, note)}
                onCancel={() => setOpen(false)}
              />
            ) : (
              <div className="row-flex">
                <button type="button" className="btn danger" disabled={busy} onClick={() => void reject()}>
                  {busyKey === 'reject' ? 'กำลังบันทึก...' : 'ยืนยันไม่อนุมัติ'}
                </button>
                <button type="button" className="btn secondary" disabled={busy} onClick={() => setOpen(false)}>ย้อนกลับ</button>
              </div>
            )}
          </div>
        </Modal>
      )}
    </>
  );
}
