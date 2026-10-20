import { Fragment, useId, useState } from 'react';
import { PAYMENT_METHODS, settlePayments, toSatang, type PaymentEntry, type PaymentSettlement } from '@champpower/domain';
import type { CloseReceiptInput, CloseReceiptResult, PaymentMethod, Receipt } from '@gsms/contracts/index.js';
import { Modal } from '../../components/ui/Modal';
import { api } from '../../lib/api/client';
import { baht, typedSatang } from '../../lib/money';
import type { BillFailure } from './billErrors';
import { BLOCKER_TEXT, PAYMENT_METHOD_LABEL } from './billLabels';
import { receiptPath, type ReceiptState } from './useReceipt';

interface PaymentPanelProps {
  jobId: string;
  receipt: Receipt;
  busy: string | null;
  guard: ReceiptState['guard'];
  show: ReceiptState['show'];
  onClosed: (result: CloseReceiptResult) => void;
}

type Typed = Partial<Record<PaymentMethod, string>>;

function dueSatang(receipt: Receipt): number {
  try {
    return toSatang(receipt.totals.billTotal);
  } catch {
    return 0;
  }
}

/** The entries as typed, in method order. A selected method with nothing typed is left out. */
function entriesOf(typed: Typed): PaymentEntry[] {
  return PAYMENT_METHODS.filter((m) => typed[m] !== undefined && typed[m]!.trim() !== '')
    .map((m) => ({ method: m, amount: typed[m]!.trim() }));
}

function settlementText(s: PaymentSettlement): string | null {
  if (s.ok) return null;
  switch (s.code) {
    case 'payment_short': return `ขาดอีก ${baht(s.short)} — ปิดบิลไม่ได้จนกว่าจะรับครบ`;
    case 'payment_over_noncash': return `โอน/บัตร เกินยอดไป ${baht(s.over)} — ทอนได้เฉพาะเงินสด แก้ยอดให้พอดี`;
    case 'payment_cash_unneeded': return 'มีเงินทอนแต่เงินสดที่รับไม่พอจะทอน — ตรวจยอดแต่ละช่องทางอีกครั้ง';
    default: return s.field === 'amount' ? 'ยอดเงินไม่ถูกต้อง — ใส่ตัวเลขมากกว่า 0 ทศนิยมไม่เกิน 2 ตำแหน่ง' : 'เลือกช่องทางชำระ';
  }
}

/**
 * รับเงิน + ปิดบิล (§5.3, AC-D1..D8). No method is chosen for the person
 * (AC-D1). The preview — change, shortfall, over-paid transfer — comes from
 * the same domain function the API settles with; the API still decides, and
 * the client never sends a total or the change (AC-E6).
 */
export function PaymentPanel({ jobId, receipt, busy, guard, show, onClosed }: PaymentPanelProps) {
  const [typed, setTyped] = useState<Typed>({});
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [failure, setFailure] = useState<BillFailure | null>(null);
  const due = dueSatang(receipt);
  const entries = entriesOf(typed);
  const selected = PAYMENT_METHODS.filter((m) => typed[m] !== undefined);
  const settlement = settlePayments(due, entries);
  const next = receipt.next;
  const ceilingBlocked = receipt.discount.exceedsCeiling && !next.canApproveOverCeiling;
  const anyBusy = busy !== null;
  const canClose = next.canClose && settlement.ok && !ceilingBlocked && !anyBusy;

  function toggle(m: PaymentMethod) {
    setTyped((t) => {
      const copy = { ...t };
      if (copy[m] !== undefined) delete copy[m];
      else copy[m] = '';
      return copy;
    });
  }

  /** "ยอดพอดี": what is still owed after the OTHER methods, worked out by the domain settle function. */
  function fillRemaining(m: PaymentMethod) {
    const others = entriesOf({ ...typed, [m]: undefined });
    const s = settlePayments(due, others);
    const remaining = s.ok ? null : s.code === 'payment_short' ? s.short : null;
    if (remaining !== null) setTyped((t) => ({ ...t, [m]: remaining }));
  }

  async function close(discountReason: string | undefined): Promise<void> {
    setFailure(null);
    const body: CloseReceiptInput = { payments: entries };
    if (discountReason) body.discountReason = discountReason;
    const result = await guard('close', () => api.post<CloseReceiptResult>(`${receiptPath(jobId)}/close`, body));
    if (result.ok) {
      show(result.value.receipt);
      setConfirmOpen(false);
      setTyped({});
      onClosed(result.value);
    } else if (!result.failure.cancelled) {
      setFailure(result.failure);
    }
  }

  const previewText = entries.length === 0 ? null : settlementText(settlement);

  return (
    <section className="card bl-pay" aria-label="รับเงินและปิดบิล">
      <h3>รับเงิน</h3>
      <p className="bl-due">ยอดที่ต้องชำระ <strong className="mono">{baht(receipt.totals.billTotal)}</strong></p>

      <div className="bl-methods" role="group" aria-label="ช่องทางชำระ">
        {PAYMENT_METHODS.map((m) => (
          <button
            key={m}
            type="button"
            className={`chip bl-method${typed[m] !== undefined ? ' active' : ''}`}
            aria-pressed={typed[m] !== undefined}
            disabled={anyBusy}
            onClick={() => toggle(m)}
          >
            {typed[m] !== undefined && '✓ '}{PAYMENT_METHOD_LABEL[m]}
          </button>
        ))}
      </div>
      {selected.length === 0 && <p className="qt-line-sub">เลือกช่องทางที่ลูกค้าจ่าย (เลือกได้มากกว่าหนึ่ง ถ้าจ่ายหลายทาง)</p>}

      {selected.map((m) => (
        <AmountField
          key={m}
          method={m}
          value={typed[m] ?? ''}
          disabled={anyBusy}
          onChange={(v) => setTyped((t) => ({ ...t, [m]: v }))}
          onFill={() => fillRemaining(m)}
        />
      ))}

      {settlement.ok && entries.length > 0 && (
        <div className="bl-change" role="status">
          {settlement.change !== '0.00' ? (
            <>เงินทอน (เงินสด) <strong className="mono">{baht(settlement.change)}</strong></>
          ) : (
            <>รับครบพอดี ไม่มีเงินทอน</>
          )}
        </div>
      )}
      {previewText && <p className="ci-form-error" role="alert">{previewText}</p>}

      {next.blockers.length > 0 && receipt.status === 'draft' && (
        <ul className="bl-blockers" aria-label="สิ่งที่ยังต้องทำก่อนปิดบิล">
          {next.blockers.map((b) => <li key={b}>{BLOCKER_TEXT[b]}</li>)}
        </ul>
      )}
      {ceilingBlocked && <p className="qt-line-sub">ส่วนลดเกินเพดาน — ผู้จัดการ รองผู้จัดการ หรือเจ้าของต้องเข้าระบบด้วยชื่อตัวเองแล้วกดปิดบิล</p>}
      {failure && !confirmOpen && <p className="ci-form-error" role="alert">{failure.text}</p>}

      <button type="button" className="btn hazard block" disabled={!canClose} onClick={() => { setFailure(null); setConfirmOpen(true); }}>
        ปิดบิล
      </button>

      {confirmOpen && settlement.ok && (
        <CloseConfirmDialog
          receipt={receipt}
          settlement={settlement}
          busy={busy === 'close'}
          failure={failure}
          onCancel={() => setConfirmOpen(false)}
          onConfirm={(reason) => void close(reason)}
        />
      )}
    </section>
  );
}

function AmountField({ method, value, disabled, onChange, onFill }: {
  method: PaymentMethod; value: string; disabled: boolean; onChange: (v: string) => void; onFill: () => void;
}) {
  const id = useId();
  const bad = value.trim() !== '' && typedSatang(value.trim()) === null;
  return (
    <div className="bl-amount">
      <label className={`field${bad ? ' has-error' : ''}`} htmlFor={id}>
        <span>{PAYMENT_METHOD_LABEL[method]} — ยอดที่รับมา (บาท)</span>
        <input
          id={id}
          inputMode="decimal"
          value={value}
          disabled={disabled}
          aria-invalid={bad ? true : undefined}
          onChange={(e) => onChange(e.target.value)}
        />
        {bad && <span className="ci-field-error">ใส่ตัวเลข ทศนิยมไม่เกิน 2 ตำแหน่ง</span>}
      </label>
      <button type="button" className="btn secondary small" disabled={disabled} onClick={onFill}>ยอดพอดี</button>
    </div>
  );
}

function CloseConfirmDialog({ receipt, settlement, busy, failure, onCancel, onConfirm }: {
  receipt: Receipt;
  settlement: Extract<PaymentSettlement, { ok: true }>;
  busy: boolean;
  failure: BillFailure | null;
  onCancel: () => void;
  onConfirm: (discountReason: string | undefined) => void;
}) {
  const id = useId();
  const d = receipt.discount;
  // Above the ceiling the closer types the reason personally (B4); otherwise only when the draft has none yet.
  const askReason = d.exceedsCeiling || (d.reasonRequired && !d.reason);
  const [reason, setReason] = useState(d.exceedsCeiling ? '' : d.reason ?? '');
  const [touched, setTouched] = useState(false);
  const missing = askReason && reason.trim() === '';

  return (
    <Modal
      title="ยืนยันปิดบิล"
      onClose={() => { if (!busy) onCancel(); }}
      footer={(
        <div className="row-flex">
          <button
            type="button"
            className="btn hazard"
            disabled={busy}
            onClick={() => { setTouched(true); if (!missing) onConfirm(askReason ? reason.trim() : undefined); }}
          >
            {busy ? 'กำลังปิดบิล...' : 'ยืนยัน ปิดบิลและออกใบเสร็จ'}
          </button>
          <button type="button" className="btn secondary" disabled={busy} onClick={onCancel}>กลับไปแก้</button>
        </div>
      )}
    >
      <div className="bl-confirm">
        {failure && <p className="ci-form-error" role="alert">{failure.text}</p>}
        <dl className="bl-kv">
          <dt>ยอดบิล</dt><dd className="mono">{baht(receipt.totals.billTotal)}</dd>
          {settlement.rows.map((r) => (
            <Fragment key={r.method}>
              <dt>{PAYMENT_METHOD_LABEL[r.method]}</dt><dd className="mono">{baht(r.amount)}</dd>
            </Fragment>
          ))}
          <dt>เงินทอน</dt><dd className="mono bl-strong">{baht(settlement.change)}</dd>
        </dl>
        {askReason && (
          <label className={`field${touched && missing ? ' has-error' : ''}`} htmlFor={id}>
            <span>
              เหตุผลของส่วนลด {d.percent}%{d.exceedsCeiling ? ` (เกินเพดาน ${d.ceilingPercent}% — คุณเป็นผู้อนุมัติ)` : ''}
            </span>
            <textarea id={id} className="qt-textarea" rows={2} maxLength={500} value={reason} disabled={busy} onChange={(e) => setReason(e.target.value)} />
            {touched && missing && <span className="ci-field-error">จำเป็นต้องกรอก</span>}
            {failure?.fields.discountReason && <span className="ci-field-error">{failure.fields.discountReason}</span>}
          </label>
        )}
        <p className="qt-line-sub">ปิดบิลแล้วแก้ยอดหรือช่องทางไม่ได้ — ถ้าผิดต้องให้เจ้าของยกเลิกใบเสร็จ</p>
      </div>
    </Modal>
  );
}
