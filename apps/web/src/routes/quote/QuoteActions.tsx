import { useState } from 'react';
import { statusOf } from '@champpower/domain';
import type { ConfirmInput, ConfirmResult, IssueInput, Quotation, ReviseInput, UndoConfirmInput } from '@gsms/contracts/index.js';
import { ReasonDialog } from '../../components/ui/ReasonDialog';
import { api } from '../../lib/api/client';
import { ConfirmOutcomeDialog } from './ConfirmOutcomeDialog';
import type { QuoteFailure } from './quoteErrors';
import { quotationPath, type QuotationState, type RunResult } from './useQuotation';

interface QuoteActionsProps {
  jobId: string;
  quotation: Quotation;
  canWrite: boolean;
  busy: string | null;
  run: QuotationState['run'];
}

type Dialog = 'confirm' | 'undo' | 'revise' | null;

/**
 * Panel A's decision row, rebuilt on the server's `next` flags: what the
 * screen may offer is decided by the API from the quotation's real state, not
 * recomputed here. "ยืนยันผลลูกค้า" opens on `next.canOpenConfirm` (true while
 * a cut set still lacks its amount — entering it is what the dialog is for);
 * `next.canConfirm` would stay false until then.
 */
export function QuoteActions({ jobId, quotation, canWrite, busy, run }: QuoteActionsProps) {
  const [dialog, setDialog] = useState<Dialog>(null);
  const [failure, setFailure] = useState<QuoteFailure | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const base = quotationPath(jobId);
  const next = quotation.next;
  const anyBusy = busy !== null;

  async function act<T extends Quotation>(key: string, call: () => Promise<T>): Promise<RunResult<T>> {
    setFailure(null);
    setInfo(null);
    const result = await run(key, call);
    if (!result.ok && !result.failure.cancelled) setFailure(result.failure);
    return result;
  }

  async function confirm(input: ConfirmInput): Promise<QuoteFailure | null> {
    setInfo(null);
    const result = await run('confirm', () => api.post<ConfirmResult>(`${base}/confirm`, input));
    if (!result.ok) return result.failure;
    setDialog(null);
    const unchanged = result.value.jobStatusUnchanged;
    setInfo(unchanged
      ? `ยืนยันผลแล้ว — แต่สถานะงานยังเป็น “${statusOf(unchanged.currentStatus).label}” (ยังไม่ได้ออกใบเสนอราคาตามขั้นตอน) ย้ายสถานะงานที่หน้างานวันนี้`
      : 'ยืนยันผลลูกค้าแล้ว');
    return null;
  }

  if (!canWrite) return null;

  const dialogFailure = failure && dialog !== null ? failure : null;

  return (
    <section className="qt-actions" aria-label="ขั้นตอนใบเสนอราคา">
      {info && <p className="ci-match" role="status">{info}</p>}
      {failure && dialog === null && <p className="ci-form-error" role="alert">{failure.text}</p>}

      <div className="row-flex">
        {next.canEditContent && (
          <button
            type="button" className="btn hazard" disabled={anyBusy || !next.canIssue}
            onClick={() => void act('issue', () => api.post<Quotation>(`${base}/issue`, {} satisfies IssueInput))}
          >
            {busy === 'issue' ? 'กำลังออกใบ...' : 'ออกใบเสนอราคา'}
          </button>
        )}
        {next.canDecide && (
          <button type="button" className="btn" disabled={anyBusy || !next.canOpenConfirm} onClick={() => { setFailure(null); setDialog('confirm'); }}>
            ยืนยันผลลูกค้า
          </button>
        )}
        {next.canUndoConfirm && (
          <button type="button" className="btn secondary" disabled={anyBusy} onClick={() => { setFailure(null); setDialog('undo'); }}>
            ถอยการยืนยัน
          </button>
        )}
        {next.canRevise && (
          <button type="button" className="btn secondary" disabled={anyBusy} onClick={() => { setFailure(null); setDialog('revise'); }}>
            ออกฉบับแก้ไข
          </button>
        )}
      </div>
      {next.canDecide && next.undecidedLineIds.length > 0 && (
        <p className="qt-line-sub">ยังมี {next.undecidedLineIds.length} รายการที่ลูกค้ายังไม่ตัดสิน — ตัดสินให้ครบก่อนกดยืนยัน</p>
      )}
      {next.canEditContent && !next.canIssue && <p className="qt-line-sub">เพิ่มรายการอย่างน้อย 1 รายการก่อนออกใบ</p>}

      {dialog === 'confirm' && (
        <ConfirmOutcomeDialog quotation={quotation} busy={busy === 'confirm'} onSubmit={confirm} onClose={() => setDialog(null)} />
      )}
      {dialog === 'undo' && (
        <ReasonDialog
          title="ถอยการยืนยันผลลูกค้า"
          confirmLabel="ถอยการยืนยัน"
          required
          busy={busy === 'undo'}
          errorText={dialogFailure?.text}
          fieldError={dialogFailure?.fields.reason}
          onCancel={() => setDialog(null)}
          onConfirm={(reason) => {
            const body: UndoConfirmInput = { reason: reason ?? '' };
            void act('undo', () => api.post<Quotation>(`${base}/confirm/undo`, body)).then((r) => { if (r.ok) setDialog(null); });
          }}
        >
          <p>ใบเสนอราคาจะกลับไปเป็น “รอลูกค้าตัดสินใจ” และงานกลับไปที่ “เสนอราคา” — ทำได้เฉพาะวันเดียวกับที่ยืนยัน</p>
        </ReasonDialog>
      )}
      {dialog === 'revise' && (
        <ReasonDialog
          title="ออกใบเสนอราคาฉบับแก้ไข"
          confirmLabel="ออกฉบับแก้ไข"
          required={false}
          busy={busy === 'revise'}
          errorText={dialogFailure?.text}
          fieldError={dialogFailure?.fields.reason}
          onCancel={() => setDialog(null)}
          onConfirm={(reason) => {
            const body: ReviseInput = reason === undefined ? {} : { reason };
            void act('revise', () => api.post<Quotation>(`${base}/revise`, body)).then((r) => { if (r.ok) setDialog(null); });
          }}
        >
          <p>
            ฉบับ {quotation.revision} จะถูกแทนด้วยฉบับ {quotation.revision + 1} (ร่าง) — รายการที่ลูกค้าตกลงไว้แล้วติดไปด้วย
            รายการที่เพิ่มหรือแก้ต้องถามลูกค้าใหม่
          </p>
        </ReasonDialog>
      )}
    </section>
  );
}
