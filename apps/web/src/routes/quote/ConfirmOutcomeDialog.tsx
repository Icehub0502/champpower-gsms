import { useState } from 'react';
import {
  quoteTotals, setsNeedingAmount, toSatang, type QuoteLineDecisionState, type QuoteLineMoney,
} from '@champpower/domain';
import { ConfirmInput, type Quotation, type QuotationLine } from '@gsms/contracts/index.js';
import { Modal } from '../../components/ui/Modal';
import { baht, formatSatangText, typedSatang } from '../../lib/money';
import type { QuoteFailure } from './quoteErrors';
import { amountHint } from './quoteView';

interface ConfirmOutcomeDialogProps {
  quotation: Quotation;
  busy: boolean;
  /** Resolves with the refusal, or null when the server confirmed. */
  onSubmit: (input: ConfirmInput) => Promise<QuoteFailure | null>;
  onClose: () => void;
}

// The contract line, narrowed to the shapes the domain functions take. Spelled
// out field by field: apps/web compiles without strictNullChecks, so zod's
// inferred types have every field optional and do not match the domain's.
function decisionStateOf(l: QuotationLine): QuoteLineDecisionState {
  return { id: l.id, parentLineId: l.parentLineId, approvalStatus: l.approvalStatus, declineReason: l.declineReason, declineNote: l.declineNote };
}

function moneyStateOf(l: QuotationLine): QuoteLineMoney {
  return { id: l.id, parentLineId: l.parentLineId, qty: l.qty, unitPrice: l.unitPrice, approvalStatus: l.approvalStatus, approvedAmount: l.approvedAmount };
}

/**
 * "ยืนยันผลลูกค้า" — the ONE point where money is adjusted (v3 §6.2, D10/D11):
 * a new amount for every set the customer cut pieces from, and the discount,
 * each with its reason, in one dialog and one request. The system never
 * proposes a set amount: the box starts empty, beside the old set price and
 * the pieces that were cut (v3 §3.2).
 */
export function ConfirmOutcomeDialog({ quotation, busy, onSubmit, onClose }: ConfirmOutcomeDialogProps) {
  const lines = quotation.lines;
  const missing = new Set(quotation.next.setsNeedingAmountLineIds);
  const sets = setsNeedingAmount(lines.map(decisionStateOf))
    .map((id) => lines.find((l) => l.id === id))
    .filter((l): l is QuotationLine => l !== undefined);

  const [amounts, setAmounts] = useState<Record<string, string>>(() =>
    Object.fromEntries(sets.map((s) => [s.id, s.approvedAmount ?? ''])));
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [discount, setDiscount] = useState(quotation.totals.discount);
  const [discountReason, setDiscountReason] = useState('');
  const [touched, setTouched] = useState(false);
  const [failure, setFailure] = useState<QuoteFailure | null>(null);

  const setNeedsSending = (s: QuotationLine) => missing.has(s.id) || s.approvedAmount === null || (amounts[s.id] ?? '').trim() !== s.approvedAmount;
  const discountSatang = typedSatang(discount);
  const discountChanged = discountSatang === null || discountSatang !== toSatang(quotation.totals.discount);

  // A confirm 400 keys its fields by full path, the set by its line id:
  // "adjustments.setLines.<lineId>.approvedAmount" / ".reason",
  // "adjustments.discount.amount" / ".reason" (apps/api nestedFieldErrorsOf).
  const serverField = (...keys: string[]): string | null => {
    for (const k of keys) {
      const t = failure?.fields[k];
      if (t) return t;
    }
    return null;
  };
  const setKey = (lineId: string, f: string) => `adjustments.setLines.${lineId}.${f}`;

  // The screen's own required-field check first (it is what blocks sending);
  // otherwise what the server said about this exact box.
  function setError(s: QuotationLine): { amount: string | null; reason: string | null } {
    const typed = (amounts[s.id] ?? '').trim();
    let amount: string | null =
      serverField(setKey(s.id, 'approvedAmount')) ?? (failure?.lineIds.includes(s.id) ? failure.text : null);
    if (touched && typed === '' && setNeedsSending(s)) amount = 'กรอกยอดใหม่ของชุดนี้ก่อนยืนยัน';
    else if (touched && typed !== '' && typedSatang(typed) === null) amount = 'จำนวนเงินไม่ถูกต้อง — ใส่ตัวเลข ทศนิยมไม่เกิน 2 ตำแหน่ง';
    const reason = touched && setNeedsSending(s) && (reasons[s.id] ?? '').trim() === ''
      ? 'กรอกเหตุผลที่ยอดชุดเปลี่ยน'
      : serverField(setKey(s.id, 'reason'));
    return { amount, reason };
  }

  const discountError = touched && discountSatang === null
    ? 'จำนวนเงินไม่ถูกต้อง — ใส่ตัวเลข ทศนิยมไม่เกิน 2 ตำแหน่ง'
    : serverField('adjustments.discount.amount');
  const discountReasonError = touched && discountChanged && discountReason.trim() === ''
    ? 'เปลี่ยนส่วนลดต้องกรอกเหตุผล'
    : serverField('adjustments.discount.reason');

  // A preview of the approved total with what is typed, from the domain's one
  // totals function — so the counter can say the number to the customer. The
  // server recomputes it on confirm; this is never sent.
  const allTyped = sets.every((s) => typedSatang(amounts[s.id] ?? '') !== null) && discountSatang !== null;
  // A sum beyond numeric(12,2) makes the domain throw MoneyError — by design,
  // it refuses to compute a number the database could not hold. Here that is
  // a preview, so it must not take the dialog (and what was typed) down with it.
  let preview: number | null = null;
  let previewOverflow = false;
  if (allTyped) {
    try {
      preview = quoteTotals(lines.map((l) => {
        const typed = sets.some((s) => s.id === l.id) ? (amounts[l.id] ?? '').trim() : null;
        return { ...moneyStateOf(l), approvedAmount: typed ?? l.approvedAmount };
      }), discount.trim()).approvedTotal;
    } catch {
      previewOverflow = true;
    }
  }

  const approvedCount = lines.filter((l) => l.parentLineId === null && l.approvalStatus === 'approved').length;
  const declinedCount = lines.filter((l) => l.parentLineId === null && l.approvalStatus === 'declined').length;

  async function submit() {
    setTouched(true);
    // Required-field checks only. Whether an amount is acceptable (2x, free
    // set) is the API's call — the hint above is advance notice, not a gate.
    const invalid = sets.some((s) => {
      const typed = (amounts[s.id] ?? '').trim();
      return setNeedsSending(s) && (typed === '' || typedSatang(typed) === null || (reasons[s.id] ?? '').trim() === '');
    }) || discountSatang === null || (discountChanged && discountReason.trim() === '');
    if (invalid) return;

    const setLines = sets.filter(setNeedsSending).map((s) => ({
      lineId: s.id, approvedAmount: (amounts[s.id] ?? '').trim(), reason: (reasons[s.id] ?? '').trim(),
    }));
    const adjustments = {
      ...(setLines.length > 0 ? { setLines } : {}),
      ...(discountChanged ? { discount: { amount: discount.trim(), reason: discountReason.trim() } } : {}),
    };
    const parsed = ConfirmInput.safeParse(Object.keys(adjustments).length > 0 ? { adjustments } : {});
    if (!parsed.success) {
      setFailure({ text: 'ข้อมูลบางช่องไม่ถูกต้อง กรุณาตรวจอีกครั้ง', fields: {}, lineIds: [], body: null, stale: false, cancelled: false });
      return;
    }
    setFailure(null);
    const refused = await onSubmit(parsed.data);
    if (refused && !refused.cancelled) setFailure(refused);
  }

  const dialogText = failure && failure.lineIds.length === 0 ? failure.text : null;

  return (
    <Modal title="ยืนยันผลลูกค้า" onClose={() => { if (!busy) onClose(); }}>
      <form className="ci-dialog qt-confirm" onSubmit={(e) => { e.preventDefault(); void submit(); }} noValidate>
        <p>
          ลูกค้าอนุมัติ <strong>{approvedCount}</strong> รายการ · ไม่อนุมัติ <strong>{declinedCount}</strong> รายการ
          — ยืนยันแล้วใบนี้จะแก้ไม่ได้ (ถอยการยืนยันได้ภายในวันนี้เท่านั้น)
        </p>
        {dialogText && <p className="ci-form-error" role="alert">{dialogText}</p>}

        {sets.map((s) => {
          const cut = lines.filter((c) => c.parentLineId === s.id && c.approvalStatus === 'declined').map((c) => c.name);
          const err = setError(s);
          const hint = amountHint(toSatang(s.lineTotal), amounts[s.id] ?? '');
          return (
            <fieldset key={s.id} className="qt-confirm-set" data-set-id={s.id}>
              <legend>
                {s.name}
                {missing.has(s.id) && <span className="pill pill-warning">ต้องกรอกยอดใหม่ก่อนยืนยัน</span>}
              </legend>
              <p className="qt-line-sub">ราคาชุดเดิม <span className="mono">{baht(s.lineTotal)}</span> · ตัดออก: {cut.join(', ')}</p>
              <label className={`field ci-field${err.amount ? ' has-error' : ''}`}>
                <span className="ci-field-label">ยอดใหม่ของชุด (บาท)</span>
                <input
                  inputMode="decimal" value={amounts[s.id] ?? ''} disabled={busy}
                  aria-invalid={err.amount ? true : undefined}
                  onChange={(e) => setAmounts((a) => ({ ...a, [s.id]: e.target.value }))}
                />
                {hint && <span className={`qt-hint tone-${hint.tone}`} data-testid="amount-hint">{hint.text}</span>}
                {err.amount && <span className="ci-field-error">{err.amount}</span>}
              </label>
              <label className={`field ci-field${err.reason ? ' has-error' : ''}`}>
                <span className="ci-field-label">เหตุผล</span>
                <input
                  value={reasons[s.id] ?? ''} maxLength={500} disabled={busy}
                  aria-invalid={err.reason ? true : undefined}
                  onChange={(e) => setReasons((r) => ({ ...r, [s.id]: e.target.value }))}
                />
                {err.reason && <span className="ci-field-error">{err.reason}</span>}
              </label>
            </fieldset>
          );
        })}

        <fieldset className="qt-confirm-set">
          <legend>ส่วนลดท้ายบิล</legend>
          <label className={`field ci-field${discountError ? ' has-error' : ''}`}>
            <span className="ci-field-label">ส่วนลด (บาท)</span>
            <input inputMode="decimal" value={discount} disabled={busy} onChange={(e) => setDiscount(e.target.value)} />
            {discountError && <span className="ci-field-error">{discountError}</span>}
          </label>
          {discountChanged && (
            <label className={`field ci-field${discountReasonError ? ' has-error' : ''}`}>
              <span className="ci-field-label">เหตุผลที่เปลี่ยนส่วนลด</span>
              <input value={discountReason} maxLength={500} disabled={busy} onChange={(e) => setDiscountReason(e.target.value)} />
              {discountReasonError && <span className="ci-field-error">{discountReasonError}</span>}
            </label>
          )}
        </fieldset>

        <p className="qt-confirm-total">
          ยอดที่ลูกค้าอนุมัติหลังยืนยัน: <strong className="mono">{preview === null ? '—' : `฿${formatSatangText(preview)}`}</strong>
          {previewOverflow && <span className="ci-field-error"> ยอดเกินที่ระบบรองรับ</span>}
        </p>

        <div className="row-flex">
          <button type="submit" className="btn" disabled={busy}>{busy ? 'กำลังยืนยัน...' : 'ยืนยันผลลูกค้า'}</button>
          <button type="button" className="btn secondary" disabled={busy} onClick={onClose}>ยกเลิก</button>
        </div>
      </form>
    </Modal>
  );
}
