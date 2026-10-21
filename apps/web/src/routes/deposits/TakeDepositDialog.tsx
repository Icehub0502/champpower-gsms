import { useRef, useState } from 'react';
import { CreateDepositInput, type CreateDepositResult, type Deposit } from '@gsms/contracts/index.js';
import { DepositSlipPrintButton } from '../../components/print/DepositSlipPrintButton';
import { Modal } from '../../components/ui/Modal';
import { api } from '../../lib/api/client';
import { baht } from '../../lib/money';
import { dateKeyThai } from '../../lib/printFormat';
import { describeDepositError } from './depositErrors';
import {
  DepositFields, EMPTY_DRAFT, checkDraft, slipError, useSlipUpload, type DepositDraft, type DraftErrors,
} from './DepositFields';
import { DEPOSITS_PATH, DEPOSIT_REASON_LABEL, newIdempotencyKey } from './depositLabels';

interface TakeDepositDialogProps {
  /** The job the deposit is for; the API takes the job's own customer (CreateDepositInput: jobId alone). */
  jobId: string;
  /** Shown in the title so the counter knows whose money this is. */
  who: string | null;
  onClose: () => void;
  /** After a deposit was saved (the screen behind refreshes its deposit list). */
  onSaved: (deposit: Deposit) => void;
}

/**
 * "รับมัดจำ" from the check-in / quotation pages (CLAUDE.md §5.4: the deposit
 * is its own document, but the button stays where staff already work). A short
 * dialog: amount · channel · reason · expected day · slip. Saving records the
 * money; the DEP number is allocated only when the slip is printed (item 10),
 * which is offered straight after.
 */
export function TakeDepositDialog({ jobId, who, onClose, onSaved }: TakeDepositDialogProps) {
  const [draft, setDraft] = useState<DepositDraft>(EMPTY_DRAFT);
  const [errors, setErrors] = useState<DraftErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [saved, setSaved] = useState<CreateDepositResult | null>(null);
  const slip = useSlipUpload();
  // One key per attempt: a retry after a dropped answer returns the same deposit, never a second one.
  const keyRef = useRef(newIdempotencyKey());

  function change(patch: Partial<DepositDraft>) {
    setDraft((d) => ({ ...d, ...patch }));
    setErrors((e) => {
      const next = { ...e };
      for (const k of Object.keys(patch) as (keyof DepositDraft)[]) delete next[k];
      return next;
    });
    // Different content is a different attempt.
    keyRef.current = newIdempotencyKey();
  }

  async function save() {
    if (busyRef.current) return;
    setFormError(null);
    const found = checkDraft(draft);
    const slipProblem = slipError(slip.slip);
    if (slipProblem) found.slip = slipProblem;
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    const candidate = {
      idempotencyKey: keyRef.current,
      jobId,
      channel: draft.channel,
      reason: draft.reason,
      amount: draft.amount.trim(),
      paymentChannelId: draft.paymentChannelId,
      expectedDate: draft.expectedDate,
      ...(draft.note.trim() !== '' ? { note: draft.note.trim() } : {}),
      ...(slip.slip.status === 'done' ? { slipFileId: slip.slip.fileId } : {}),
    };
    const parsed = CreateDepositInput.safeParse(candidate);
    if (!parsed.success) {
      setFormError('ข้อมูลบางช่องไม่ถูกต้อง กรุณาตรวจอีกครั้ง');
      return;
    }
    busyRef.current = true;
    setBusy(true);
    try {
      const result = await api.post<CreateDepositResult>(DEPOSITS_PATH, parsed.data);
      setSaved(result);
      onSaved(result.deposit);
    } catch (err) {
      const failure = describeDepositError(err);
      if (failure.cancelled) return;
      setErrors((e) => ({ ...e, ...failure.fields }));
      setFormError(failure.text);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  if (saved) {
    const d = saved.deposit;
    return (
      <Modal title="รับมัดจำแล้ว" onClose={onClose}>
        <div className="dp-done" role="status">
          <p className="dp-done-amount">รับมัดจำ <strong className="mono">{baht(d.amount)}</strong></p>
          <p className="qt-line-sub">
            {DEPOSIT_REASON_LABEL[d.reason]} · รับทาง {d.paymentChannelName ?? '-'} · นัดเอารถเข้า {dateKeyThai(d.expectedDate)}
          </p>
          {saved.replayed && <p className="qt-line-sub">รายการนี้บันทึกไปแล้วก่อนหน้า (กดซ้ำ) — แสดงรายการเดิม ไม่มีการรับเงินซ้ำ</p>}
          <p className="qt-line-sub">เลขที่ใบรับเงินมัดจำ (DEP) จะออกตอนพิมพ์ครั้งแรก — พิมพ์ 2 ชุด ให้ลูกค้า 1 ร้านเก็บ 1</p>
          <div className="row-flex">
            {d.next.canPrintSlip && <DepositSlipPrintButton depositId={d.id} className="btn hazard" />}
            <button type="button" className="btn secondary" onClick={onClose}>ปิด</button>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      title={`รับมัดจำ${who ? ` — ${who}` : ''}`}
      onClose={() => { if (!busy) onClose(); }}
      footer={(
        <div className="row-flex">
          <button type="button" className="btn hazard" disabled={busy || slip.slip.status === 'uploading'} onClick={() => void save()}>
            {busy ? 'กำลังบันทึก...' : 'บันทึกรับมัดจำ'}
          </button>
          <button type="button" className="btn secondary" disabled={busy} onClick={onClose}>ยกเลิก</button>
        </div>
      )}
    >
      <form className="ci-dialog" onSubmit={(e) => { e.preventDefault(); void save(); }} noValidate>
        {formError && <p className="ci-form-error" role="alert">{formError}</p>}
        <DepositFields draft={draft} errors={errors} disabled={busy} onChange={change} slip={slip} showChannel />
        <p className="qt-line-sub">มัดจำไม่ใช่การขาย ไม่คิด VAT ตอนรับ และจะหักออกจากยอดที่ลูกค้าต้องจ่ายตอนปิดบิล</p>
      </form>
    </Modal>
  );
}
