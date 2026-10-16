import { useId, useState, type ReactNode } from 'react';
import { Modal } from './Modal';

interface ReasonDialogProps {
  title: string;
  /** What will happen, in plain words, above the reason box. */
  children?: ReactNode;
  confirmLabel: string;
  /** "กำลังบันทึก..." is shown on the button while true, and nothing can be pressed. */
  busy: boolean;
  /** When false the reason may be left empty (sent as undefined). */
  required: boolean;
  reasonLabel?: string;
  /** Dialog-level refusal text from the server. */
  errorText?: string | null;
  /** Server field error for the reason box. */
  fieldError?: string | null;
  danger?: boolean;
  onConfirm: (reason: string | undefined) => void;
  onCancel: () => void;
}

/**
 * A short "why?" prompt before an action that must be explained (undo a
 * confirmation, issue a revision). Reusable: it knows nothing about what the
 * action is. Esc / backdrop do nothing while the request is in flight, so the
 * person always sees the answer to what they pressed.
 */
export function ReasonDialog({
  title, children, confirmLabel, busy, required, reasonLabel = 'เหตุผล', errorText, fieldError, danger, onConfirm, onCancel,
}: ReasonDialogProps) {
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const id = useId();
  const missing = required && reason.trim() === '';
  const shownFieldError = fieldError ?? (touched && missing ? 'จำเป็นต้องกรอก' : null);

  function submit() {
    setTouched(true);
    if (missing) return;
    const t = reason.trim();
    onConfirm(t === '' ? undefined : t);
  }

  return (
    <Modal title={title} onClose={() => { if (!busy) onCancel(); }}>
      <form
        className="ci-dialog"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {children}
        {errorText && <p className="ci-form-error" role="alert">{errorText}</p>}
        <label className={`field ci-field${shownFieldError ? ' has-error' : ''}`} htmlFor={id}>
          <span className="ci-field-label">
            {reasonLabel}
            {!required && <span className="ci-required"> (ไม่บังคับ)</span>}
          </span>
          <textarea
            id={id}
            className="qt-textarea"
            rows={3}
            maxLength={500}
            value={reason}
            disabled={busy}
            aria-invalid={shownFieldError ? true : undefined}
            onChange={(e) => setReason(e.target.value)}
          />
          {shownFieldError && <span className="ci-field-error">{shownFieldError}</span>}
        </label>
        <div className="row-flex">
          <button type="submit" className={`btn${danger ? ' danger' : ''}`} disabled={busy}>
            {busy ? 'กำลังบันทึก...' : confirmLabel}
          </button>
          <button type="button" className="btn secondary" disabled={busy} onClick={onCancel}>
            ยกเลิก
          </button>
        </div>
      </form>
    </Modal>
  );
}
