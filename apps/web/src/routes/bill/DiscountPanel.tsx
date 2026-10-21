import { useId, useState } from 'react';
import {
  DISCOUNT_CEILING_PERCENT, discountExceedsCeiling, discountExceedsSubtotal, discountPercentText,
  receiptDiscountReasonRequired, sumSatang, toSatang,
} from '@champpower/domain';
import type { PatchReceiptInput, Receipt } from '@gsms/contracts/index.js';
import { api } from '../../lib/api/client';
import { baht, typedSatang } from '../../lib/money';
import type { BillFailure } from './billErrors';
import { receiptPath, type ReceiptState } from './useReceipt';

interface DiscountPanelProps {
  jobId: string;
  receipt: Receipt;
  busy: string | null;
  run: ReceiptState['run'];
}

function safeSatang(v: string): number {
  try {
    return toSatang(v);
  } catch {
    return 0;
  }
}

const CEILING_ROLES_TEXT = 'ผู้จัดการ รองผู้จัดการ หรือเจ้าของ';

/**
 * The receipt's own discount (AC-C1..C5). The server says which state it is in
 * (none / carried / needs_entry / entered); the 40% preview on what is being
 * typed uses the same domain functions the API uses, measured on the server's
 * base (the charged lines before discount). Nothing here decides — the close
 * door re-checks everything.
 */
export function DiscountPanel({ jobId, receipt, busy, run }: DiscountPanelProps) {
  const d = receipt.discount;
  const inputId = useId();
  const reasonId = useId();
  const [text, setText] = useState('');
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const [failure, setFailure] = useState<BillFailure | null>(null);
  const editable = receipt.next.canEditDiscount;
  const anyBusy = busy !== null;

  const baseSatang = safeSatang(d.base);
  const agreedSatang = safeSatang(d.agreed);
  const typed = text.trim() === '' ? null : typedSatang(text.trim());
  const typedInvalid = text.trim() !== '' && typed === null;
  // B4: the ceiling is on the FINAL discount = line discounts + this bill discount, on the pre-discount base.
  const lineDiscountSatang = safeSatang(receipt.totals.lineDiscountTotal ?? '0');
  const totalTyped = typed === null ? null : sumSatang([lineDiscountSatang, typed]);
  const overBase = totalTyped !== null && discountExceedsSubtotal(baseSatang, totalTyped);
  const overCeiling = totalTyped !== null && discountExceedsCeiling(baseSatang, totalTyped);
  const needsReason = typed !== null && receiptDiscountReasonRequired({
    discountSatang: typed, agreedDiscountSatang: agreedSatang, baseSatang,
  });
  const reasonMissing = needsReason && reason.trim() === '';

  async function save() {
    setTouched(true);
    if (typed === null || typedInvalid || overBase || reasonMissing) return;
    setFailure(null);
    const body: PatchReceiptInput = { discount: text.trim() };
    if (reason.trim() !== '') body.discountReason = reason.trim();
    const result = await run('discount', () => api.patch<Receipt>(receiptPath(jobId), body));
    if (result.ok) {
      setText('');
      setReason('');
      setTouched(false);
    } else if (!result.failure.cancelled) {
      setFailure(result.failure);
    }
  }

  const stateLine = (() => {
    switch (d.state) {
      case 'carried': return `ส่วนลดที่ตกลงไว้ในใบเสนอราคา ${baht(d.agreed)} — ใช้ต่อได้เพราะทำครบทุกรายการ`;
      case 'needs_entry':
        return `ส่วนลดที่ตกลงไว้ ${baht(d.agreed)} ใช้ไม่ได้แล้วเพราะมีรายการที่ไม่ได้ทำ (ฐานตอนนี้ ${baht(d.base)}) — กรอกส่วนลดใหม่ ใส่ 0 ได้`;
      case 'entered': return `กรอกเองที่หน้าเก็บเงิน · ส่วนลดที่ตกลงไว้ ${baht(d.agreed)}`;
      default: return 'ไม่มีส่วนลด';
    }
  })();

  return (
    <section className="card bl-discount" aria-label="ส่วนลดใบเสร็จ">
      <h3>ส่วนลดท้ายบิล</h3>
      <p className={d.state === 'needs_entry' ? 'ci-nomatch bl-attn' : 'qt-line-sub'}>{stateLine}</p>
      <dl className="bl-kv">
        <dt>ส่วนลดตอนนี้</dt>
        <dd className="mono">{d.state === 'needs_entry' ? 'ยังไม่ได้กรอก' : `${baht(d.amount)} (${d.percent}%)`}</dd>
        {receipt.totals.lineDiscountTotal !== undefined && (
          <><dt>ส่วนลดรายบรรทัดรวม</dt><dd className="mono">{baht(receipt.totals.lineDiscountTotal)}</dd></>
        )}
        <dt>ยอดก่อนลด (ฐานของเพดาน)</dt>
        <dd className="mono">{baht(d.base)}</dd>
        {d.reason && (<><dt>เหตุผล</dt><dd>{d.reason}</dd></>)}
        {d.approvedByName && (<><dt>อนุมัติโดย</dt><dd>{d.approvedByName}</dd></>)}
      </dl>
      {d.exceedsCeiling && (
        <p className="ci-form-error" role="alert">
          ส่วนลด {d.percent}% เกินเพดาน {d.ceilingPercent}% — {CEILING_ROLES_TEXT}ต้องเป็นคนปิดบิลนี้เอง และต้องกรอกเหตุผล
          {!receipt.next.canApproveOverCeiling && ' (คุณยังปิดบิลนี้ไม่ได้ ส่งให้ผู้จัดการ)'}
        </p>
      )}

      {editable && (
        <form className="bl-discount-form" onSubmit={(e) => { e.preventDefault(); void save(); }}>
          {failure && <p className="ci-form-error" role="alert">{failure.text}</p>}
          <label className={`field${(touched && (typedInvalid || overBase || typed === null)) || failure?.fields.discount ? ' has-error' : ''}`} htmlFor={inputId}>
            <span>ส่วนลดใหม่ (บาท)</span>
            <input
              id={inputId}
              inputMode="decimal"
              placeholder={d.state === 'needs_entry' ? 'กรอกส่วนลด (0 ได้)' : d.amount}
              value={text}
              disabled={anyBusy}
              onChange={(e) => setText(e.target.value)}
            />
            {totalTyped !== null && !overBase && (
              <span className={overCeiling ? 'ci-field-error' : 'qt-line-sub'}>
                ส่วนลดรวม{lineDiscountSatang > 0 ? ' (รวมส่วนลดรายบรรทัด)' : ''} = {discountPercentText(baseSatang, totalTyped)}% ของยอดก่อนลด
                {overCeiling
                  ? ` · เกิน ${DISCOUNT_CEILING_PERCENT}% ต้องให้${CEILING_ROLES_TEXT}ปิดบิล`
                  : ` · ไม่เกิน ${DISCOUNT_CEILING_PERCENT}%`}
              </span>
            )}
            {touched && typedInvalid && <span className="ci-field-error">ใส่ตัวเลข ทศนิยมไม่เกิน 2 ตำแหน่ง</span>}
            {touched && typed === null && !typedInvalid && <span className="ci-field-error">จำเป็นต้องกรอก</span>}
            {overBase && <span className="ci-field-error">ส่วนลดมากกว่ายอดที่คิดเงิน ({baht(d.base)}) ไม่ได้</span>}
            {failure?.fields.discount && <span className="ci-field-error">{failure.fields.discount}</span>}
          </label>
          {needsReason && (
            <label className={`field${touched && reasonMissing ? ' has-error' : ''}`} htmlFor={reasonId}>
              <span>เหตุผลของส่วนลดนี้{overCeiling ? ' (บังคับ — เกินเพดาน)' : ' (บังคับ — ต่างจากที่ตกลงไว้)'}</span>
              <textarea
                id={reasonId}
                className="qt-textarea"
                rows={2}
                maxLength={500}
                value={reason}
                disabled={anyBusy}
                onChange={(e) => setReason(e.target.value)}
              />
              {touched && reasonMissing && <span className="ci-field-error">จำเป็นต้องกรอก</span>}
            </label>
          )}
          <button type="submit" className="btn secondary" disabled={anyBusy || text.trim() === ''}>
            {busy === 'discount' ? 'กำลังบันทึก...' : 'บันทึกส่วนลด'}
          </button>
        </form>
      )}
    </section>
  );
}
