import { useId, useState } from 'react';
import type { DeclineReason } from '@champpower/domain';
import { DECLINE_REASON_LABEL, DECLINE_REASON_OPTIONS } from './quoteLabels';

interface DeclineFormProps {
  busy: boolean;
  saving: boolean;
  /** Server field errors from the last attempt (`reason`, `note`). */
  fields: Record<string, string>;
  onSubmit: (reason: DeclineReason, note: string | undefined) => void;
  onCancel: () => void;
}

/**
 * Why the customer said no to this line: a short dropdown of the reasons the
 * counter really hears, plus free text (CLAUDE.md §5.7 #1 — the dropdown alone
 * misses the reason that matters most; free text alone cannot be counted).
 * "อื่น ๆ" requires the text, as the API does (DecideLineInput).
 */
export function DeclineForm({ busy, saving, fields, onSubmit, onCancel }: DeclineFormProps) {
  const [reason, setReason] = useState<DeclineReason | ''>('');
  const [note, setNote] = useState('');
  const [touched, setTouched] = useState(false);
  const id = useId();

  const reasonError = fields.reason ?? (touched && reason === '' ? 'เลือกเหตุผลก่อน' : null);
  const noteError =
    fields.note ?? (touched && reason === 'other' && note.trim() === '' ? 'เลือก “อื่น ๆ” ต้องพิมพ์เหตุผล' : null);

  function submit() {
    setTouched(true);
    if (reason === '') return;
    if (reason === 'other' && note.trim() === '') return;
    onSubmit(reason, note.trim() === '' ? undefined : note.trim());
  }

  return (
    <form
      className="qt-decline-form"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <label className={`field ci-field${reasonError ? ' has-error' : ''}`} htmlFor={`${id}-r`}>
        <span className="ci-field-label">ทำไมลูกค้าไม่เอา</span>
        <select
          id={`${id}-r`}
          value={reason}
          disabled={busy}
          aria-invalid={reasonError ? true : undefined}
          onChange={(e) => setReason(e.target.value as DeclineReason | '')}
        >
          <option value="">— เลือกเหตุผล —</option>
          {DECLINE_REASON_OPTIONS.map((r) => (
            <option key={r} value={r}>{DECLINE_REASON_LABEL[r]}</option>
          ))}
        </select>
        {reasonError && <span className="ci-field-error">{reasonError}</span>}
      </label>
      <label className={`field ci-field${noteError ? ' has-error' : ''}`} htmlFor={`${id}-n`}>
        <span className="ci-field-label">
          รายละเอียด{reason !== 'other' && <span className="ci-required"> (ไม่บังคับ)</span>}
        </span>
        <input
          id={`${id}-n`}
          value={note}
          maxLength={500}
          disabled={busy}
          aria-invalid={noteError ? true : undefined}
          onChange={(e) => setNote(e.target.value)}
        />
        {noteError && <span className="ci-field-error">{noteError}</span>}
      </label>
      <div className="row-flex">
        <button type="submit" className="btn danger small" disabled={busy}>
          {saving ? 'กำลังบันทึก...' : 'บันทึกว่าไม่อนุมัติ'}
        </button>
        <button type="button" className="btn secondary small" disabled={busy} onClick={onCancel}>
          ยกเลิก
        </button>
      </div>
    </form>
  );
}
