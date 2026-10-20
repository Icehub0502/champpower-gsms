import { useId, useState } from 'react';
import { discountExceedsSubtotal, fulfilledQtyIssue, toSatang, type FulfilledQtyIssue } from '@champpower/domain';
import {
  FulfilledQtyString, type FulfillmentInput, type LineDiscountInput, type Receipt, type ReceiptLine,
} from '@gsms/contracts/index.js';
import { api } from '../../lib/api/client';
import { baht, typedSatang } from '../../lib/money';
import { qtyText } from '../../lib/printFormat';
import { LINE_TYPE_LABEL } from '../quote/quoteLabels';
import type { BillFailure } from './billErrors';
import { LINE_STATE_LABEL } from './billLabels';
import { receiptPath, type ReceiptState } from './useReceipt';

interface FulfillmentListProps {
  jobId: string;
  receipt: Receipt;
  busy: string | null;
  run: ReceiptState['run'];
}

const ISSUE_TEXT: Record<FulfilledQtyIssue, string> = {
  invalid: 'ใส่ตัวเลข 0 ขึ้นไป ทศนิยมไม่เกิน 2 ตำแหน่ง',
  exceeds_qty: 'มากกว่าจำนวนที่ลูกค้าอนุมัติไม่ได้ — ถ้าทำเพิ่มต้องออกใบเสนอราคาฉบับใหม่',
  set_must_be_whole: 'ชุดต้องเลือก ทำครบ หรือ ไม่ได้ทำ ทั้งชุด',
};

function pillClass(line: ReceiptLine): string {
  switch (line.state) {
    case 'done': return 'pill pill-success';
    case 'partial': return 'pill pill-info';
    case 'not_done': return 'pill pill-muted';
    default: return 'pill pill-warning';
  }
}

/**
 * "ทำจริงไหม" line by line (§5.1 #7, AC-B1..B7). No line starts ticked: each
 * one is answered by a person, and "ทำครบทุกบรรทัด" is a button that WRITES
 * every line's full quantity, not a default (A-7). Every tap is saved on the
 * server at once, so half a bill survives a refresh or a hand-over.
 * A set is answered as a whole (B5); its pieces are listed under it.
 */
export function FulfillmentList({ jobId, receipt, busy, run }: FulfillmentListProps) {
  const [failure, setFailure] = useState<BillFailure | null>(null);
  const [partialFor, setPartialFor] = useState<string | null>(null);
  const [discountFor, setDiscountFor] = useState<string | null>(null);
  const top = receipt.lines.filter((l) => l.parentLineId === null).sort((a, b) => a.sortOrder - b.sortOrder);
  const childrenOf = (id: string) => receipt.lines.filter((l) => l.parentLineId === id).sort((a, b) => a.sortOrder - b.sortOrder);
  const canTick = receipt.next.canTick;
  const anyBusy = busy !== null;
  const unanswered = new Set(receipt.next.unansweredLineIds);

  async function send(key: string, lines: FulfillmentInput['lines']): Promise<boolean> {
    setFailure(null);
    const body: FulfillmentInput = { lines };
    const result = await run(key, () => api.put<Receipt>(`${receiptPath(jobId)}/fulfillment`, body));
    if (!result.ok && !result.failure.cancelled) setFailure(result.failure);
    return result.ok;
  }

  return (
    <section className="card bl-lines" aria-label="ติ๊กว่าทำจริงไหม">
      <div className="bl-lines-head">
        <h3>รายการที่ลูกค้าอนุมัติ ({top.length})</h3>
        {canTick && top.length > 0 && (
          <button
            type="button"
            className="btn secondary small"
            disabled={anyBusy}
            onClick={() => void send('tick-all', top.map((l) => ({ lineId: l.id, fulfilledQty: l.qty })))}
          >
            {busy === 'tick-all' ? 'กำลังบันทึก...' : 'ทำครบทุกบรรทัด'}
          </button>
        )}
      </div>
      {canTick && unanswered.size > 0 && (
        <p className="qt-line-sub">ยังไม่ระบุ {unanswered.size} รายการ — ต้องระบุทุกรายการก่อนปิดบิล</p>
      )}
      {failure && <p className="ci-form-error" role="alert">{failure.text}</p>}

      <ul className="bl-list">
        {top.map((line) => (
          <li key={line.id} className={`bl-line${unanswered.has(line.id) ? ' is-unanswered' : ''}${line.state === 'not_done' ? ' is-off' : ''}`}>
            <div className="bl-line-main">
              <span className="bl-line-name">
                {line.name}{line.brand && <span className="qt-line-sub"> ({line.brand})</span>}
              </span>
              <span className="qt-line-sub">
                {line.isSet ? 'ชุด' : LINE_TYPE_LABEL[line.lineType]} · อนุมัติ {qtyText(line.qty)}{line.unit ? ` ${line.unit}` : ''}
                {!line.isSet && ` × ${baht(line.unitPrice)}`}
                {line.approvedAmount !== null && ` · ราคาที่ตกลง ${baht(line.approvedAmount)}`}
              </span>
              {childrenOf(line.id).length > 0 && (
                <ul className="bl-children">
                  {childrenOf(line.id).map((k) => (
                    <li key={k.id}>– {k.name} · {qtyText(k.qty)}{k.unit ? ` ${k.unit}` : ''}</li>
                  ))}
                </ul>
              )}
              {line.fulfilledByName && (
                <span className="qt-line-sub">ระบุโดย {line.fulfilledByName}</span>
              )}
            </div>
            <div className="bl-line-money">
              <span className={pillClass(line)}>
                {line.state === 'partial' ? `ทำ ${qtyText(line.fulfilledQty)} จาก ${qtyText(line.qty)}` : LINE_STATE_LABEL[line.state]}
              </span>
              <strong className="mono">{line.charged !== null ? baht(line.charged) : '—'}</strong>
              {line.state === 'not_done' && <span className="qt-line-sub">ไม่คิดเงิน</span>}
              {hasLineDiscount(line) && (
                <span className="qt-line-sub">ลดรายการนี้ −{baht(line.discount)}{line.discountReason ? ` (${line.discountReason})` : ''}</span>
              )}
            </div>
            {canTick && (
              <div className="bl-line-ticks" role="group" aria-label={`ทำจริงไหม: ${line.name}`}>
                <button
                  type="button"
                  className={`chip${line.state === 'done' ? ' active' : ''}`}
                  aria-pressed={line.state === 'done'}
                  disabled={anyBusy}
                  onClick={() => { setPartialFor(null); void send(`tick:${line.id}`, [{ lineId: line.id, fulfilledQty: line.qty }]); }}
                >
                  {line.state === 'done' && '✓ '}ทำครบ
                </button>
                {!line.isSet && (
                  <button
                    type="button"
                    className={`chip${line.state === 'partial' ? ' active' : ''}`}
                    aria-pressed={line.state === 'partial'}
                    aria-expanded={partialFor === line.id}
                    disabled={anyBusy}
                    onClick={() => setPartialFor(partialFor === line.id ? null : line.id)}
                  >
                    {line.state === 'partial' && '✓ '}ทำบางส่วน
                  </button>
                )}
                <button
                  type="button"
                  className={`chip${line.state === 'not_done' ? ' active' : ''}`}
                  aria-pressed={line.state === 'not_done'}
                  disabled={anyBusy}
                  onClick={() => { setPartialFor(null); void send(`tick:${line.id}`, [{ lineId: line.id, fulfilledQty: '0' }]); }}
                >
                  {line.state === 'not_done' && '✓ '}ไม่ได้ทำ
                </button>
                {(line.state === 'done' || line.state === 'partial') && (
                  <button
                    type="button"
                    className={`chip${discountFor === line.id ? ' active' : ''}`}
                    aria-expanded={discountFor === line.id}
                    disabled={anyBusy}
                    onClick={() => setDiscountFor(discountFor === line.id ? null : line.id)}
                  >
                    ส่วนลดรายการ
                  </button>
                )}
                {busy === `tick:${line.id}` && <span className="qt-line-sub">กำลังบันทึก...</span>}
              </div>
            )}
            {canTick && discountFor === line.id && (
              <LineDiscountForm
                line={line}
                busy={anyBusy}
                saving={busy === `ldisc:${line.id}`}
                onSave={async (input) => {
                  setFailure(null);
                  const result = await run(`ldisc:${line.id}`, () => api.patch<Receipt>(`${receiptPath(jobId)}/lines/${encodeURIComponent(line.id)}`, input));
                  if (result.ok) setDiscountFor(null);
                  else if (!result.failure.cancelled) setFailure(result.failure);
                }}
              />
            )}
            {canTick && partialFor === line.id && (
              <PartialQtyForm
                line={line}
                busy={anyBusy}
                onSave={async (qty) => {
                  const ok = await send(`tick:${line.id}`, [{ lineId: line.id, fulfilledQty: qty }]);
                  if (ok) setPartialFor(null);
                }}
              />
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function hasLineDiscount(line: ReceiptLine): boolean {
  return line.discount !== '0.00';
}

/**
 * B4: a discount on one done line, with its reason. The amount is checked
 * against the line's charge with the domain rule (refused, not clamped); the
 * 40% ceiling is shown on the whole bill in the discount card.
 */
function LineDiscountForm({ line, busy, saving, onSave }: {
  line: ReceiptLine; busy: boolean; saving: boolean; onSave: (input: LineDiscountInput) => Promise<void>;
}) {
  const amountId = useId();
  const reasonId = useId();
  const [text, setText] = useState(hasLineDiscount(line) ? line.discount : '');
  const [reason, setReason] = useState(line.discountReason ?? '');
  const [touched, setTouched] = useState(false);
  const typed = text.trim() === '' ? null : typedSatang(text.trim());
  let chargedSatang = 0;
  try {
    chargedSatang = line.charged !== null ? toSatang(line.charged) : 0;
  } catch {
    chargedSatang = 0;
  }
  const over = typed !== null && discountExceedsSubtotal(chargedSatang, typed);
  const reasonMissing = typed !== null && typed > 0 && reason.trim() === '';
  const amountError = touched && typed === null ? 'ใส่ตัวเลข ทศนิยมไม่เกิน 2 ตำแหน่ง (ไม่ลด ใส่ 0)' : over ? `ลดเกินราคารายการนี้ (${baht(line.charged ?? '0')}) ไม่ได้` : null;

  return (
    <form
      className="bl-partial"
      onSubmit={(e) => {
        e.preventDefault();
        setTouched(true);
        if (typed === null || over || reasonMissing) return;
        const input: LineDiscountInput = { discount: text.trim() };
        if (reason.trim() !== '') input.discountReason = reason.trim();
        void onSave(input);
      }}
    >
      <label className={`field${amountError ? ' has-error' : ''}`} htmlFor={amountId}>
        <span>ส่วนลดรายการนี้ (บาท)</span>
        <input id={amountId} inputMode="decimal" autoFocus value={text} disabled={busy} onChange={(e) => setText(e.target.value)} />
        {amountError && <span className="ci-field-error">{amountError}</span>}
      </label>
      <label className={`field${touched && reasonMissing ? ' has-error' : ''}`} htmlFor={reasonId}>
        <span>เหตุผล (บังคับเมื่อมีส่วนลด)</span>
        <input id={reasonId} maxLength={500} value={reason} disabled={busy} onChange={(e) => setReason(e.target.value)} />
        {touched && reasonMissing && <span className="ci-field-error">จำเป็นต้องกรอก</span>}
      </label>
      <button type="submit" className="btn small" disabled={busy}>{saving ? 'กำลังบันทึก...' : 'บันทึกส่วนลด'}</button>
    </form>
  );
}

function PartialQtyForm({ line, busy, onSave }: { line: ReceiptLine; busy: boolean; onSave: (qty: string) => Promise<void> }) {
  const id = useId();
  const [text, setText] = useState(line.state === 'partial' && line.fulfilledQty ? line.fulfilledQty : '');
  const [touched, setTouched] = useState(false);
  const trimmed = text.trim();
  const parsed = FulfilledQtyString.safeParse(trimmed);
  // The same front gate the API uses (packages/domain), so the screen and the server agree on "valid".
  const issue: FulfilledQtyIssue | null = parsed.success ? fulfilledQtyIssue({ qty: line.qty, isSet: line.isSet }, parsed.data) : 'invalid';
  const error = touched && issue ? ISSUE_TEXT[issue] : null;

  return (
    <form
      className="bl-partial"
      onSubmit={(e) => {
        e.preventDefault();
        setTouched(true);
        if (issue || !parsed.success) return;
        void onSave(parsed.data);
      }}
    >
      <label className={`field${error ? ' has-error' : ''}`} htmlFor={id}>
        <span>ทำจริงกี่{line.unit ?? 'ชิ้น'} (จาก {qtyText(line.qty)} ที่อนุมัติ)</span>
        <input
          id={id}
          inputMode="decimal"
          autoFocus
          value={text}
          disabled={busy}
          aria-invalid={error ? true : undefined}
          onChange={(e) => setText(e.target.value)}
        />
        {error && <span className="ci-field-error">{error}</span>}
      </label>
      <button type="submit" className="btn small" disabled={busy}>บันทึก</button>
    </form>
  );
}
