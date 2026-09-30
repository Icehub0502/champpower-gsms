import { useEffect, useRef, useState } from 'react';
import {
  ApiError as ApiErrorBody,
  STATUS_REASON_MAX,
  StatusMoveReason,
  type JobDetail,
  type JobHistoryEntry,
  type UpdateJobStatusInput,
  type UpdateJobStatusResult,
} from '@gsms/contracts/index.js';
import { ApiError, api } from '../../lib/api/client';
import { isSessionCancelled } from '../../lib/api/sessionCancelled';
import { Icon } from '../../components/ui/Icon';
import { useJobDetail } from './useDeliveredData';
import { isStaleJob, reasonFieldText, undoErrorText } from './messages';

/** "30 ก.ย. 16:05 น." — shop time, so a phone set to another zone still agrees with the counter. */
export function formatWhen(iso: string): string {
  return `${new Date(iso).toLocaleString('th-TH', {
    timeZone: 'Asia/Bangkok',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })} น.`;
}

function HistoryItem({ entry }: { entry: JobHistoryEntry }) {
  // The server records a reason only where one was required, i.e. an undo. A
  // reason on a row that lands in "พร้อมส่ง" is therefore "someone took this
  // delivery back" — said in words, not left for a reader to infer.
  const isUndo = entry.status === 'ready' && entry.reason !== null;
  return (
    <li className={`kb-hist-item${isUndo ? ' is-undo' : ''}`}>
      <div className="kb-hist-head">
        <strong>{entry.statusLabel}</strong>
        {isUndo && <span className="kb-hist-tag">ย้อนกลับจากส่งแล้ว</span>}
      </div>
      <div className="kb-hist-meta">
        {formatWhen(entry.changedAt)} · โดย {entry.changedBy ? entry.changedBy.name : 'ไม่ทราบผู้ทำรายการ'}
      </div>
      {entry.reason !== null && (
        <div className="kb-hist-reason">
          <span className="kb-hist-reason-label">เหตุผล: </span>
          {entry.reason}
        </div>
      )}
    </li>
  );
}

interface UndoFormProps {
  detail: JobDetail;
  needsReason: boolean;
  onCancel: () => void;
  onDone: (result: UpdateJobStatusResult) => void;
  /** The job is no longer what was shown: leave the form, keep the words. */
  onStale: (text: string) => void;
  onBusyChange: (busy: boolean) => void;
}

/** Reason box + confirm for delivered -> ready. The server decides whether a reason is needed. */
function UndoForm({ detail, needsReason, onCancel, onDone, onStale, onBusyChange }: UndoFormProps) {
  const [text, setText] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const areaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    areaRef.current?.focus();
  }, []);

  const trimmedLength = text.trim().length;
  const overBy = trimmedLength - STATUS_REASON_MAX;

  async function submit() {
    if (pending) return;
    setFormError(null);
    let reason: string | undefined;
    if (needsReason) {
      const parsed = StatusMoveReason.safeParse(text);
      if (!parsed.success) {
        setFieldError(reasonFieldText(parsed.error.issues[0]?.code === 'too_big' ? 'too_big' : 'too_small'));
        areaRef.current?.focus();
        return;
      }
      reason = parsed.data; // trimmed by the schema — the same text the server will store
    }
    setFieldError(null);
    setPending(true);
    onBusyChange(true);
    try {
      const body: UpdateJobStatusInput = { to: 'ready', fromStatus: detail.status, reason };
      const result = await api.patch<UpdateJobStatusResult>(`/api/jobs/${detail.jobId}/status`, body);
      onDone(result);
    } catch (err) {
      if (isSessionCancelled(err)) return; // logged out / switched user: say nothing
      if (err instanceof ApiError && err.status === 400) {
        const body = ApiErrorBody.safeParse(err.body);
        const code = body.success ? body.data.fields?.reason?.[0] : undefined;
        if (code !== undefined) {
          setFieldError(reasonFieldText(code));
          areaRef.current?.focus();
          return;
        }
        // A 400 that does not name the reason box (or is not the agreed shape)
        // is an unknown error — never guessed at.
      }
      const text = undoErrorText(err);
      setFormError(text);
      if (isStaleJob(err)) onStale(text);
    } finally {
      setPending(false);
      onBusyChange(false);
    }
  }

  return (
    <form
      className="kb-undo"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      noValidate
    >
      <h4 id="kb-undo-title">ย้อนกลับเป็นพร้อมส่ง</h4>
      <p className="kb-undo-note">
        รถจะกลับไปอยู่ในคอลัมน์ “พร้อมชำระ / ส่งมอบ” ประวัติงานจะบันทึกว่าใครย้อนกลับและเพราะอะไร
      </p>
      {formError && (
        <p className="kb-sheet-error" role="alert">
          {formError}
        </p>
      )}
      {needsReason && (
        <div className={`kb-undo-field${fieldError ? ' has-error' : ''}`}>
          <label htmlFor="kb-undo-reason">
            เหตุผลที่ย้อนกลับ <span className="kb-undo-required">(จำเป็น)</span>
          </label>
          <textarea
            id="kb-undo-reason"
            ref={areaRef}
            rows={3}
            value={text}
            disabled={pending}
            aria-invalid={fieldError ? true : undefined}
            aria-describedby={fieldError ? 'kb-undo-count kb-undo-error' : 'kb-undo-count'}
            placeholder="เช่น กดส่งแล้วผิดคัน / ลูกค้ายังไม่ได้รับรถ"
            onChange={(e) => {
              setText(e.target.value);
              if (fieldError) setFieldError(null);
            }}
          />
          <div className="kb-undo-foot">
            {fieldError ? (
              <span id="kb-undo-error" className="kb-undo-error" role="alert">
                <Icon name="alert" size={13} /> {fieldError}
              </span>
            ) : (
              <span />
            )}
            <span id="kb-undo-count" className={`kb-undo-count mono${overBy > 0 ? ' is-over' : ''}`}>
              {trimmedLength}/{STATUS_REASON_MAX}
              {overBy > 0 && ` (เกิน ${overBy})`}
            </span>
          </div>
        </div>
      )}
      <div className="row-flex">
        <button type="submit" className="btn danger" disabled={pending}>
          {pending ? 'กำลังบันทึก…' : 'ยืนยันย้อนกลับ'}
        </button>
        <button type="button" className="btn secondary" disabled={pending} onClick={onCancel}>
          ยกเลิก
        </button>
      </div>
    </form>
  );
}

interface DeliveredJobDetailProps {
  jobId: string;
  onBack: () => void;
  /** The undo succeeded; the panel closes and the board reloads. */
  onUndone: (detail: JobDetail) => void;
  onBusyChange: (busy: boolean) => void;
}

export function DeliveredJobDetail({ jobId, onBack, onUndone, onBusyChange }: DeliveredJobDetailProps) {
  const { state, reload } = useJobDetail(jobId);
  const [undoing, setUndoing] = useState(false);
  // Outlives the form: a "the job moved on" refusal closes the form (the job is
  // re-read and the button may be gone), and the reason must not vanish with it.
  const [notice, setNotice] = useState<string | null>(null);

  const back = (
    <button type="button" className="btn secondary small" onClick={onBack}>
      <Icon name="back" size={14} /> กลับรายการ
    </button>
  );

  if (state.kind === 'loading') {
    return (
      <div className="kb-dl">
        {back}
        <p className="page-loading" role="status">กำลังโหลดรายละเอียด…</p>
      </div>
    );
  }
  if (state.kind === 'error') {
    return (
      <div className="kb-dl">
        {back}
        <div className="empty-state" role="alert">
          {state.notFound ? 'ไม่พบใบงานนี้' : 'โหลดรายละเอียดงานไม่สำเร็จ'}
          {!state.notFound && (
            <div style={{ marginTop: 10 }}>
              <button type="button" className="btn secondary" onClick={() => void reload()}>
                ลองใหม่
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }

  const d = state.data;
  const title = [d.brand, d.model].filter(Boolean).join(' ') || 'ไม่ระบุรุ่น';
  // Offered only when the SERVER says this caller may take the job back to
  // ready — never inferred from a role name on this screen.
  const canUndo = d.status === 'delivered' && d.allowedMoves.includes('ready');
  const needsReason = d.movesNeedingReason.includes('ready');
  // Newest first: the reader is here for what happened last.
  const history = [...d.history].reverse();

  return (
    <div className="kb-dl">
      {back}

      <section aria-label="สรุปงาน" className="kb-dl-summary">
        <div className="kb-dl-summary-top">
          <span className="mono">{d.jobNumber}</span>
          <span className="kb-hist-tag">{d.statusLabel}</span>
        </div>
        <div className="kb-dl-title">{title}</div>
        <dl className="kb-dl-facts">
          <dt>ทะเบียน</dt>
          <dd>{[d.plate, d.province].filter(Boolean).join(' ') || '—'}</dd>
          <dt>ลูกค้า</dt>
          <dd>{d.customerName ?? '—'}</dd>
          <dt>คิว</dt>
          <dd>{d.queueNo ?? '—'}</dd>
          <dt>เปลี่ยนสถานะล่าสุด</dt>
          <dd>{formatWhen(d.statusChangedAt)}</dd>
        </dl>
      </section>

      {notice && (
        <p className="kb-sheet-error" role="alert">
          {notice}
        </p>
      )}

      {undoing && canUndo ? (
        <UndoForm
          detail={d}
          needsReason={needsReason}
          onCancel={() => setUndoing(false)}
          onDone={() => onUndone(d)}
          onStale={(text) => {
            setNotice(text);
            setUndoing(false);
            void reload();
          }}
          onBusyChange={onBusyChange}
        />
      ) : canUndo ? (
        <div>
          <button
            type="button"
            className="btn danger"
            onClick={() => {
              setNotice(null);
              setUndoing(true);
            }}
          >
            ย้อนกลับเป็นพร้อมส่ง
          </button>
        </div>
      ) : (
        <p className="kb-undo-note" role="status">
          {d.status === 'delivered'
            ? 'บัญชีนี้ย้อนกลับรายการส่งแล้วไม่ได้'
            : `งานนี้ไม่ได้อยู่ในสถานะ “ส่งแล้ว” แล้ว (ตอนนี้: ${d.statusLabel})`}
        </p>
      )}

      <section aria-labelledby="kb-hist-title">
        <h4 id="kb-hist-title" className="kb-dl-h">
          ประวัติสถานะ <span className="kb-dl-h-sub">(ล่าสุดอยู่บนสุด)</span>
        </h4>
        {history.length === 0 ? (
          <p className="page-sub">ยังไม่มีประวัติ</p>
        ) : (
          <ol className="kb-hist">
            {history.map((h, i) => (
              <HistoryItem key={`${h.changedAt}|${h.status}|${i}`} entry={h} />
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
