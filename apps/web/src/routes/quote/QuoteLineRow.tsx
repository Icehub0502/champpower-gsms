import { useState } from 'react';
import { formatQtyCenti, toQtyCenti, type DeclineReason } from '@champpower/domain';
import type { QuotationLine } from '@gsms/contracts/index.js';
import { baht, typedSatang } from '../../lib/money';
import type { QuoteFailure } from './quoteErrors';
import { DeclineForm } from './DeclineForm';
import { DECLINE_REASON_LABEL, LINE_TYPE_LABEL, PRICE_SOURCE_LABEL } from './quoteLabels';
import type { RevisionMark } from './quoteView';

export type RowMode = 'draft' | 'decide' | 'view';

export interface LineActions {
  onQty: (line: QuotationLine, qty: string) => void;
  /** Resolves true when saved; a failed save keeps what was typed in the box. */
  onPrice: (line: QuotationLine, unitPrice: string) => Promise<boolean>;
  onRemove: (line: QuotationLine) => void;
  onApprove: (line: QuotationLine) => void;
  /** Resolves true when the server accepted; the form stays open (with its errors) otherwise. */
  onDecline: (line: QuotationLine, reason: DeclineReason, note: string | undefined) => Promise<boolean>;
}

interface QuoteLineRowProps {
  line: QuotationLine;
  isChild: boolean;
  /** Set heads only: how many pieces the set has. */
  childCount: number;
  mode: RowMode;
  revision: RevisionMark;
  /** A cut set without an agreed amount yet (server's next.setsNeedingAmountLineIds). */
  needsAmount: boolean;
  /** Key of the mutation in flight anywhere on the page. */
  busyKey: string | null;
  failure: QuoteFailure | null;
  actions: LineActions;
}

function qtyText(qty: string): string {
  try {
    const c = toQtyCenti(qty);
    return c % 100 === 0 ? String(c / 100) : formatQtyCenti(c);
  } catch {
    return qty;
  }
}

function stepQty(qty: string, delta: number): string | null {
  try {
    const next = toQtyCenti(qty) + delta;
    return next >= 100 ? formatQtyCenti(next) : null;
  } catch {
    return null;
  }
}

function StatusPill({ line }: { line: QuotationLine }) {
  if (line.approvalStatus === 'approved') return <span className="pill pill-success">อนุมัติ</span>;
  if (line.approvalStatus === 'declined') {
    const reason = line.declineReason ? DECLINE_REASON_LABEL[line.declineReason] : '';
    return <span className="pill pill-danger">ไม่อนุมัติ{reason && ` · ${reason}`}</span>;
  }
  return <span className="pill pill-muted">รอลูกค้าตัดสิน</span>;
}

/**
 * One line of the quotation, in the prototype's panel-A shape: the name block
 * on the left, and its controls kept together as ONE block on the right that
 * wraps as a whole on a narrow screen (the prototype's own fix for buttons
 * scattering at 390px). A declined line stays on screen with its reason
 * (CLAUDE.md §5.1 #2) — nothing here hides it.
 */
export function QuoteLineRow({ line, isChild, childCount, mode, revision, needsAmount, busyKey, failure, actions }: QuoteLineRowProps) {
  const [declining, setDeclining] = useState(false);
  const [priceDraft, setPriceDraft] = useState<string | null>(null);
  const busy = busyKey !== null;
  const key = (what: string) => `${what}:${line.id}`;
  const fields = failure?.fields ?? {};
  const priceInvalid = priceDraft !== null && typedSatang(priceDraft) === null;
  const priceError = priceInvalid ? 'ราคาต้องเป็นตัวเลข 0 ขึ้นไป ทศนิยมไม่เกิน 2 ตำแหน่ง' : fields.unitPrice ?? null;
  const qtyError = fields.qty ?? null;
  const editable = mode === 'draft' && !isChild;
  const isSet = childCount > 0;
  // The decision buttons' accessible names carry the line's name: a screen reader lists
  // "อนุมัติ ผ้าเบรกหน้า", not ten identical "อนุมัติ". Each starts with the visible text
  // (WCAG 2.5.3 label in name), so voice control by what is on screen still works.
  const approveText = busyKey === key('approve') ? 'กำลังบันทึก...' : 'อนุมัติ';
  const declineText = line.approvalStatus === 'declined' ? 'เปลี่ยนเหตุผล' : 'ไม่อนุมัติ';

  function savePrice() {
    if (priceDraft === null || priceInvalid) return;
    void actions.onPrice(line, priceDraft.trim()).then((ok) => { if (ok) setPriceDraft(null); });
  }

  return (
    <li className={`qt-line${isChild ? ' is-child' : ''} is-${line.approvalStatus}`} data-line-id={line.id}>
      <div className="qt-line-main">
        <div className="qt-line-name">
          {isChild && <span aria-hidden="true">↳ </span>}
          <strong>{line.name}</strong>
          {line.brand && <span className="qt-line-sub"> · {line.brand}</span>}
          {isSet && <span className="pill pill-info">ชุด {childCount} รายการ</span>}
        </div>
        <div className="qt-line-sub">
          {LINE_TYPE_LABEL[line.lineType]} · {qtyText(line.qty)} {line.unit ?? 'หน่วย'}
          {!isChild && <> × <span className="mono">{baht(line.unitPrice)}</span></>}
          {!isChild && line.priceSource && <> · {PRICE_SOURCE_LABEL[line.priceSource]}</>}
          {line.warranty && <> · ประกัน {line.warranty.name}</>}
        </div>
        <div className="qt-line-tags">
          <StatusPill line={line} />
          {revision === 'carried' && <span className="pill pill-success">ตกลงไว้แล้ว</span>}
          {revision === 'ask' && <span className="pill pill-warning">ต้องถามใหม่</span>}
          {needsAmount && <span className="pill pill-warning">ต้องกรอกยอดใหม่ก่อนยืนยัน</span>}
          {line.decidedByName && line.approvalStatus !== 'pending' && (
            <span className="qt-line-sub">โดย {line.decidedByName}</span>
          )}
        </div>
        {line.approvalStatus === 'declined' && line.declineNote && (
          <p className="qt-line-note">“{line.declineNote}”</p>
        )}
        {failure?.text && <p className="ci-field-error" role="alert">{failure.text}</p>}
      </div>

      <div className="qt-line-money">
        {isChild ? (
          <span className="qt-line-sub">รวมในราคาชุด</span>
        ) : line.approvedAmount !== null ? (
          <span className="mono">
            เสนอ {baht(line.lineTotal)} → ตกลง <strong>{baht(line.approvedAmount)}</strong>
          </span>
        ) : (
          <strong className="mono">{baht(line.lineTotal)}</strong>
        )}
      </div>

      {editable && (
        <div className="qt-line-controls">
          <div className="qt-qty" role="group" aria-label="จำนวน">
            <button
              type="button" className="btn secondary small" aria-label="ลดจำนวน"
              disabled={busy || stepQty(line.qty, -100) === null}
              onClick={() => { const q = stepQty(line.qty, -100); if (q) actions.onQty(line, q); }}
            >−</button>
            <span className="mono">{qtyText(line.qty)}</span>
            <button
              type="button" className="btn secondary small" aria-label="เพิ่มจำนวน"
              disabled={busy || stepQty(line.qty, 100) === null}
              onClick={() => { const q = stepQty(line.qty, 100); if (q) actions.onQty(line, q); }}
            >+</button>
          </div>
          <label className={`qt-price${priceError ? ' has-error' : ''}`}>
            <span>฿</span>
            <input
              inputMode="decimal"
              aria-label="ราคาต่อหน่วย"
              value={priceDraft ?? line.unitPrice}
              disabled={busy}
              aria-invalid={priceError ? true : undefined}
              onChange={(e) => setPriceDraft(e.target.value)}
              onBlur={savePrice}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); savePrice(); } }}
            />
          </label>
          <button
            type="button" className="btn danger small" aria-label={`ลบ ${line.name}`}
            disabled={busy}
            onClick={() => actions.onRemove(line)}
          >
            {busyKey === key('remove') ? 'กำลังลบ...' : 'ลบ'}
          </button>
          {/* A tap that lands while the price (saved on blur) is on the wire is refused by the
              page's one-at-a-time guard; this says why nothing happened, so it is tapped again. */}
          {busyKey === key('price') && <span className="qt-line-sub" role="status">กำลังบันทึกราคา…</span>}
          {(priceError || qtyError) && <span className="ci-field-error">{priceError ?? qtyError}</span>}
        </div>
      )}

      {mode === 'decide' && !declining && (
        <div className="qt-line-controls">
          <button
            type="button"
            className={`btn small${line.approvalStatus === 'approved' ? '' : ' secondary'}`}
            aria-label={`${approveText} ${line.name}`}
            aria-pressed={line.approvalStatus === 'approved'}
            disabled={busy || line.approvalStatus === 'approved'}
            onClick={() => actions.onApprove(line)}
          >
            {approveText}
          </button>
          <button
            type="button"
            className="btn danger small"
            aria-label={`${declineText} ${line.name}`}
            aria-pressed={line.approvalStatus === 'declined'}
            disabled={busy}
            onClick={() => setDeclining(true)}
          >
            {declineText}
          </button>
        </div>
      )}

      {mode === 'decide' && declining && (
        <DeclineForm
          busy={busy}
          saving={busyKey === key('decline')}
          fields={fields}
          onSubmit={(reason, note) => {
            void actions.onDecline(line, reason, note).then((ok) => { if (ok) setDeclining(false); });
          }}
          onCancel={() => setDeclining(false)}
        />
      )}
    </li>
  );
}
