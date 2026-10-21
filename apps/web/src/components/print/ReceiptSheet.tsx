import { PAYMENT_METHOD_LABEL } from '@champpower/domain';
import type { Receipt, ReceiptLine } from '@gsms/contracts/index.js';
import { baht } from '../../lib/money';
import { qtyText, thaiDate, thaiDateTime } from '../../lib/printFormat';
import { PartyBlock, warrantyText } from './sheetParts';

/**
 * ใบเสร็จรับเงิน on A4 (AC-G8). Every figure is the receipt's own snapshot as
 * the server sent it — nothing is added up here (§4 rule 4). Lines approved
 * but not done stay on the paper, marked and charged 0 (A-6). This sheet never
 * carries the words for a tax document: it is not one (AC-E10).
 */
export function ReceiptSheet({ receipt }: { receipt: Receipt }) {
  const top = receipt.lines.filter((l) => l.parentLineId === null).sort((a, b) => a.sortOrder - b.sortOrder);
  const childrenOf = (id: string) => receipt.lines.filter((l) => l.parentLineId === id).sort((a, b) => a.sortOrder - b.sortOrder);
  const p = receipt.party;
  const livePayments = receipt.payments;

  return (
    <div className="pr-body">
      <PartyBlock
        rows={[
          ['ลูกค้า', p.customerName ?? '-'],
          ['โทร', p.customerPhone ?? '-'],
          ['ทะเบียน', [p.plate, p.province].filter(Boolean).join(' ') || '-'],
          ['รถ', [p.brand, p.model].filter(Boolean).join(' ') || '-'],
          ['เลขไมล์', p.mileageInKm !== null ? `${p.mileageInKm.toLocaleString('en-US')} กม.` : '-'],
          ['เลขงาน', p.jobNumber],
          ['วันที่', thaiDate(receipt.issuedAt)],
          ['อ้างอิงใบเสนอราคา', receipt.quotationNumber ?? '-'],
        ]}
      />

      <table className="pr-items">
        <thead>
          <tr>
            <th className="pr-c-no">#</th>
            <th>รายการ</th>
            <th className="pr-c-qty">จำนวน</th>
            <th className="pr-c-num">ราคา/หน่วย</th>
            <th className="pr-c-num">จำนวนเงิน</th>
          </tr>
        </thead>
        <tbody>
          {top.map((line, i) => (
            <ReceiptRows key={line.id} no={i + 1} line={line} kids={childrenOf(line.id)} />
          ))}
        </tbody>
      </table>

      <div className="pr-totals-wrap">
        <table className="pr-pay">
          <thead>
            <tr><th>รับชำระ</th><th className="pr-c-num">รับมา</th><th className="pr-c-num">ทอน</th></tr>
          </thead>
          <tbody>
            {livePayments.map((pay) => (
              <tr key={pay.id}>
                <td>{pay.channelName ?? PAYMENT_METHOD_LABEL[pay.method]}{pay.surcharge !== '0.00' ? ` (รวมค่าธรรมเนียม ${baht(pay.surcharge)})` : ''}{pay.reversed ? ' (คืนเงินแล้ว)' : ''}</td>
                <td className="pr-c-num">{baht(pay.amount)}</td>
                <td className="pr-c-num">{pay.method === 'cash' ? baht(pay.changeGiven) : '-'}</td>
              </tr>
            ))}
            {livePayments.length === 0 && <tr><td colSpan={3}>-</td></tr>}
          </tbody>
        </table>

        <dl className="pr-totals">
          <dt>รวมรายการที่ทำ</dt><dd>{baht(receipt.totals.subtotal)}</dd>
          {receipt.totals.lineDiscountTotal !== '0.00' && (<><dt>ส่วนลดรายบรรทัด</dt><dd>{baht(receipt.totals.lineDiscountTotal)}</dd></>)}
          <dt>ส่วนลดท้ายบิล</dt><dd>{baht(receipt.totals.discount)}</dd>
          <dt className="pr-grand">ยอดบิล</dt><dd className="pr-grand">{baht(receipt.totals.billTotal)}</dd>
          {receipt.totals.surchargeTotal !== '0.00' && (
            <><dt>ค่าธรรมเนียมช่องทางชำระ</dt><dd>{baht(receipt.totals.surchargeTotal)}</dd><dt>รับชำระรวม</dt><dd>{baht(receipt.totals.totalPaid)}</dd></>
          )}
          <dt>เงินทอน</dt><dd>{baht(receipt.changeTotal)}</dd>
          <dt>ยอดสุทธิที่รับ</dt><dd>{baht(receipt.paidNet)}</dd>
        </dl>
      </div>

      {receipt.status === 'void' && (
        <p className="pr-note">
          ยกเลิกเมื่อ {thaiDateTime(receipt.voidedAt)} โดย {receipt.voidedByName ?? '-'} — เหตุผล: {receipt.voidReason ?? '-'}
        </p>
      )}

      <div className="pr-sigs">
        <div><span className="pr-sig-line" />ผู้รับเงิน{receipt.issuedByName ? ` (${receipt.issuedByName})` : ''}</div>
        <div><span className="pr-sig-line" />ลูกค้า</div>
      </div>
    </div>
  );
}

function ReceiptRows({ no, line, kids }: { no: number; line: ReceiptLine; kids: ReceiptLine[] }) {
  const notDone = line.state === 'not_done';
  const partial = line.state === 'partial';
  const w = warrantyText(line.warranty);
  return (
    <>
      <tr className={notDone ? 'pr-row-off' : undefined}>
        <td className="pr-c-no">{no}</td>
        <td>
          <div className="pr-name">{line.name}{line.brand ? ` (${line.brand})` : ''}</div>
          {w && <div className="pr-sub">ประกัน: {w}</div>}
          {notDone && <div className="pr-sub pr-strong">อนุมัติแต่ไม่ได้ทำ — ไม่คิดเงิน</div>}
          {line.discount !== '0.00' && (
            <div className="pr-sub">ส่วนลดรายการ −{baht(line.discount)}{line.discountReason ? ` (${line.discountReason})` : ''}</div>
          )}
          {partial && <div className="pr-sub">ทำจริง {qtyText(line.fulfilledQty)} จาก {qtyText(line.qty)} ที่อนุมัติ</div>}
        </td>
        <td className="pr-c-qty">{qtyText(partial || notDone ? line.fulfilledQty : line.qty)}{line.unit ? ` ${line.unit}` : ''}</td>
        <td className="pr-c-num">{line.isSet ? '-' : baht(line.unitPrice)}</td>
        <td className="pr-c-num">{line.charged !== null ? baht(line.charged) : '-'}</td>
      </tr>
      {kids.map((k) => (
        <tr key={k.id} className={`pr-row-child${notDone ? ' pr-row-off' : ''}`}>
          <td />
          <td>– {k.name}{k.brand ? ` (${k.brand})` : ''}</td>
          <td className="pr-c-qty">{qtyText(k.qty)}{k.unit ? ` ${k.unit}` : ''}</td>
          <td />
          <td />
        </tr>
      ))}
    </>
  );
}
