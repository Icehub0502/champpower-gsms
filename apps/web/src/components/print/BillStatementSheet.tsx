import { baht } from '../../lib/money';
import type { PendingReceipt } from '../../lib/pendingContracts';
import { qtyText } from '../../lib/printFormat';
import { PartyBlock } from './sheetParts';

/**
 * ใบแจ้งยอด (B1) — what the customer is about to pay, BEFORE payment. It is
 * not a receipt and says so in large type on every page: no number, no
 * payment, no change. Figures are the draft's, as the server computed them.
 */
export function BillStatementSheet({ receipt }: { receipt: PendingReceipt }) {
  const top = receipt.lines.filter((l) => l.parentLineId === null).sort((a, b) => a.sortOrder - b.sortOrder);
  const p = receipt.party;
  const t = receipt.totals;
  return (
    <div className="pr-body">
      <p className="pr-banner">ยังไม่ใช่ใบเสร็จ — ใช้แจ้งยอดก่อนชำระเงินเท่านั้น</p>
      <PartyBlock
        rows={[
          ['ลูกค้า', p.customerName ?? '-'],
          ['ทะเบียน', [p.plate, p.province].filter(Boolean).join(' ') || '-'],
          ['รถ', [p.brand, p.model].filter(Boolean).join(' ') || '-'],
          ['เลขงาน', p.jobNumber],
          ['อ้างอิงใบเสนอราคา', receipt.quotationNumber ?? '-'],
        ]}
      />
      <table className="pr-items">
        <thead>
          <tr>
            <th className="pr-c-no">#</th>
            <th>รายการ</th>
            <th className="pr-c-qty">จำนวน</th>
            <th className="pr-c-num">จำนวนเงิน</th>
          </tr>
        </thead>
        <tbody>
          {top.map((l, i) => (
            <tr key={l.id} className={l.state === 'not_done' ? 'pr-row-off' : undefined}>
              <td className="pr-c-no">{i + 1}</td>
              <td>
                <div className="pr-name">{l.name}</div>
                {l.state === 'not_done' && <div className="pr-sub pr-strong">อนุมัติแต่ไม่ได้ทำ — ไม่คิดเงิน</div>}
                {l.discount && l.discount !== '0.00' && <div className="pr-sub">ส่วนลดรายการ −{baht(l.discount)}</div>}
              </td>
              <td className="pr-c-qty">{qtyText(l.state === 'partial' || l.state === 'not_done' ? l.fulfilledQty : l.qty)}</td>
              <td className="pr-c-num">{l.charged !== null ? baht(l.charged) : '-'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="pr-totals-wrap">
        <div />
        <dl className="pr-totals">
          <dt>รวมรายการที่ทำ</dt><dd>{baht(t.subtotal)}</dd>
          {t.lineDiscountTotal !== undefined && (<><dt>ส่วนลดรายบรรทัด</dt><dd>{baht(t.lineDiscountTotal)}</dd></>)}
          <dt>ส่วนลดท้ายบิล</dt><dd>{baht(receipt.discount.amount)}</dd>
          <dt className="pr-grand">ยอดที่ต้องชำระ</dt><dd className="pr-grand">{baht(t.billTotal)}</dd>
        </dl>
      </div>
      <p className="pr-note">ช่องทางที่มีค่าธรรมเนียม (เช่น รูดบัตร) จะบวกค่าธรรมเนียมเพิ่มจากยอดนี้ แยกให้เห็นในใบเสร็จ</p>
    </div>
  );
}
