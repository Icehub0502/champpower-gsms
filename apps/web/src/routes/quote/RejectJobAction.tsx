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

/**
 * Closing a job as "ไม่อนุมัติ" is not a refusal of an alternative (D13), so
 * chose_alternative is not offered — the job-status door does not accept it.
 */
const CLOSE_REASONS = DECLINE_REASON_OPTIONS.filter((r) => r !== 'chose_alternative');

interface RejectJobActionProps {
  job: JobDetail;
  quotation: Quotation | null;
  busyKey: string | null;
  guard: QuotationState['guard'];
  onRejected: (result: UpdateJobStatusResult) => void;
}

function failureText(f: QuoteFailure): string {
  // The job-status door's own refusals are not in QuotationBody.
  if (f.body === null && f.code === 'status_changed') return 'มีคนเปลี่ยนสถานะงานนี้ไปแล้ว — โหลดหน้าใหม่แล้วตรวจอีกครั้ง';
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
export function RejectJobAction({ job, quotation, busyKey, guard, onRejected }: RejectJobActionProps) {
  const [open, setOpen] = useState(false);
  const [failure, setFailure] = useState<QuoteFailure | null>(null);
  const busy = busyKey !== null;
  const pending = quotation?.status === 'issued' ? quotation.next.undecidedLineIds.length : 0;
  const needsReason = pending > 0;

  async function reject(reason?: DeclineReason, note?: string): Promise<boolean> {
    setFailure(null);
    const body: UpdateJobStatusInput = {
      to: 'rejected',
      fromStatus: job.status,
      ...(reason ? { declineReason: reason as JobDeclineReason } : {}),
      ...(note ? { declineNote: note } : {}),
    };
    const result = await guard('reject', () =>
      api.patch<UpdateJobStatusResult>(`/api/jobs/${encodeURIComponent(job.jobId)}/status`, body));
    if (result.ok) {
      setOpen(false);
      onRejected(result.value);
      return true;
    }
    if (!result.failure.cancelled) setFailure(result.failure);
    return false;
  }

  // The server names the job-status fields declineReason / declineNote; the form's are reason / note.
  const fields: Record<string, string> = {};
  if (failure?.fields.declineReason) fields.reason = failure.fields.declineReason;
  if (failure?.fields.declineNote) fields.note = failure.fields.declineNote;
  const dialogText = failure && Object.keys(fields).length === 0 ? failureText(failure) : null;

  return (
    <>
      <button type="button" className="btn danger" disabled={busy} onClick={() => { setFailure(null); setOpen(true); }}>
        ไม่อนุมัติ (ปิดงาน)…
      </button>
      {open && (
        <Modal title="ไม่อนุมัติ — ปิดงาน" onClose={() => { if (!busy) setOpen(false); }}>
          <div className="ci-dialog">
            <p>
              <strong>{job.jobNumber}</strong> {job.plate ?? ''} จะถูกปิดเป็น “ไม่อนุมัติ” และออกจากกระดาน ย้อนกลับไม่ได้
            </p>
            {needsReason && (
              <p>ลูกค้ายังไม่ได้ตอบอีก <strong>{pending}</strong> รายการ — เลือกเหตุผลที่ลูกค้าไม่เอา ระบบจะบันทึกเหตุผลนี้ให้ทุกรายการที่ค้างอยู่</p>
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
