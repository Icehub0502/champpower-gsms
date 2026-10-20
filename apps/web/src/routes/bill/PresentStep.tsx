import { useState } from 'react';
import { PrintButton } from '../../components/print/PrintButton';
import { BillStatementSheet } from '../../components/print/BillStatementSheet';
import { api } from '../../lib/api/client';
import { baht } from '../../lib/money';
import type { PendingReceipt as Receipt } from '../../lib/pendingContracts';
import { qtyText, thaiDateTime } from '../../lib/printFormat';
import type { BillFailure } from './billErrors';
import { receiptPath, type ReceiptState } from './useReceipt';

/** Ready to show the customer: every line answered and nothing else but money in the way. */
export function readyToPresent(receipt: Receipt): boolean {
  return receipt.next.blockers.length === 0 && receipt.lines.some((l) => l.state === 'done' || l.state === 'partial');
}

/** True only when the bill was shown AND nothing changed since (B1). */
export function isPresented(receipt: Receipt): boolean {
  return receipt.presentation?.current === true;
}

/**
 * B1 — "ยอดที่ต้องชำระ": the customer sees the amount BEFORE any money is
 * taken. A big, plain summary of what was done and what it costs, the button
 * "แสดงยอดให้ลูกค้าแล้ว" (recorded on the server), and an optional A4
 * "ใบแจ้งยอด" that says it is not a receipt. A change to a line or a discount
 * after this makes the server mark the presentation stale, and payment locks
 * again until it is shown again.
 */
export function PresentStep({ jobId, receipt, canWrite, state }: { jobId: string; receipt: Receipt; canWrite: boolean; state: ReceiptState }) {
  const [failure, setFailure] = useState<BillFailure | null>(null);
  const done = receipt.lines.filter((l) => l.parentLineId === null && (l.state === 'done' || l.state === 'partial'))
    .sort((a, b) => a.sortOrder - b.sortOrder);
  const notDone = receipt.lines.filter((l) => l.parentLineId === null && l.state === 'not_done');
  const t = receipt.totals;
  const p = receipt.presentation ?? null;
  const ready = readyToPresent(receipt);
  const presented = isPresented(receipt);

  async function present() {
    setFailure(null);
    const result = await state.run('present', () => api.post<Receipt>(`${receiptPath(jobId)}/present`, {}));
    if (!result.ok && !result.failure.cancelled) setFailure(result.failure);
  }

  return (
    <section className={`card bl-present${presented ? ' is-done' : ''}`} aria-label="ยอดที่ต้องชำระ">
      <h3>ยอดที่ต้องชำระ — แสดงให้ลูกค้าดู</h3>
      {!ready && <p className="qt-line-sub">ติ๊กรายการและกรอกส่วนลดให้ครบก่อน แล้วยอดจะขึ้นที่นี่</p>}
      {ready && (
        <>
          <table className="bl-present-table">
            <tbody>
              {done.map((l) => (
                <tr key={l.id}>
                  <td>
                    {l.name}
                    {l.state === 'partial' && <span className="qt-line-sub"> · ทำ {qtyText(l.fulfilledQty)} จาก {qtyText(l.qty)}</span>}
                    {l.discount && l.discount !== '0.00' && <div className="qt-line-sub">ส่วนลดรายการ −{baht(l.discount)}</div>}
                  </td>
                  <td className="num mono">{l.charged !== null ? baht(l.charged) : '—'}</td>
                </tr>
              ))}
              {notDone.length > 0 && (
                <tr><td colSpan={2} className="qt-line-sub">ไม่ได้ทำ ไม่คิดเงิน: {notDone.map((l) => l.name).join(', ')}</td></tr>
              )}
            </tbody>
          </table>
          <dl className="bl-kv bl-present-kv">
            <dt>รวมรายการที่ทำ</dt><dd className="mono">{baht(t.subtotal)}</dd>
            {t.lineDiscountTotal !== undefined && (<><dt>ส่วนลดรายบรรทัด</dt><dd className="mono">−{baht(t.lineDiscountTotal)}</dd></>)}
            <dt>ส่วนลดท้ายบิล</dt><dd className="mono">−{baht(receipt.discount.amount)}</dd>
          </dl>
          <p className="bl-present-total">ยอดที่ต้องชำระ <span className="mono">{baht(t.billTotal)}</span></p>

          {p && !p.current && (
            <p className="ci-form-error" role="alert">ยอดเปลี่ยนหลังจากแสดงให้ลูกค้าเมื่อ {thaiDateTime(p.presentedAt)} — แสดงยอดใหม่ให้ลูกค้าก่อนรับเงิน</p>
          )}
          {presented && p && (
            <p className="ci-match" role="status">แสดงยอดให้ลูกค้าแล้ว {thaiDateTime(p.presentedAt)} โดย {p.presentedByName ?? '-'} — รับเงินได้</p>
          )}
          {failure && <p className="ci-form-error" role="alert">{failure.text}</p>}
          {canWrite && (
            <div className="row-flex">
              <button type="button" className="btn hazard" disabled={state.busy !== null || presented} onClick={() => void present()}>
                {state.busy === 'present' ? 'กำลังบันทึก...' : presented ? '✓ แสดงยอดแล้ว' : 'แสดงยอดให้ลูกค้าแล้ว'}
              </button>
              <PrintButton<Receipt>
                jobId={jobId}
                docType="bill_statement"
                label="พิมพ์ใบแจ้งยอด (ไม่บังคับ)"
                title="ใบแจ้งยอด"
                disabled={state.busy !== null}
                loadData={() => api.get<Receipt>(receiptPath(jobId))}
                documentNumber={() => null}
                render={(r) => <BillStatementSheet receipt={r} />}
              />
            </div>
          )}
        </>
      )}
    </section>
  );
}
