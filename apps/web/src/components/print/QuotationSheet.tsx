import type { JobDetail, Quotation, QuotationLine } from '@gsms/contracts/index.js';
import { baht } from '../../lib/money';
import { qtyText, thaiDate } from '../../lib/printFormat';
import { DECLINE_REASON_LABEL } from '../../routes/quote/quoteLabels';
import { PartyBlock, warrantyText } from './sheetParts';

/**
 * ใบเสนอราคา on A4 (AC-G7). The paper the customer signs is the control
 * (DECISION-2026-10-07 §2.3), so it shows BOTH totals once anything has been
 * decided, and every declined line stays on it with its own words (§5.1 #2-3).
 * All figures are the server's.
 */
export function QuotationSheet({ quotation, job }: { quotation: Quotation; job: JobDetail | null }) {
  const top = quotation.lines.filter((l) => l.parentLineId === null).sort((a, b) => a.sortOrder - b.sortOrder);
  const childrenOf = (id: string) => quotation.lines.filter((l) => l.parentLineId === id).sort((a, b) => a.sortOrder - b.sortOrder);
  const decided = quotation.status !== 'draft' && quotation.lines.some((l) => l.approvalStatus !== 'pending');
  const t = quotation.totals;

  return (
    <div className="pr-body">
      <PartyBlock
        rows={[
          ['ลูกค้า', job?.customerName ?? '-'],
          ['ทะเบียน', [job?.plate, job?.province].filter(Boolean).join(' ') || '-'],
          ['รถ', [job?.brand, job?.model, job?.color].filter(Boolean).join(' ') || '-'],
          ['เลขงาน', job?.jobNumber ?? '-'],
          ['วันที่ออก', quotation.issuedAt ? thaiDate(quotation.issuedAt) : 'ยังไม่ออกเลข'],
          ['ฉบับที่', String(quotation.revision)],
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
            {decided && <th className="pr-c-state">ลูกค้า</th>}
          </tr>
        </thead>
        <tbody>
          {top.map((line, i) => (
            <QuoteRows key={line.id} no={i + 1} line={line} kids={childrenOf(line.id)} decided={decided} />
          ))}
        </tbody>
      </table>

      <div className="pr-totals-wrap pr-totals-two">
        <dl className="pr-totals">
          <dt>ยอดเสนอ (ก่อนลด)</dt><dd>{baht(t.offeredSubtotal)}</dd>
          <dt>ส่วนลด</dt><dd>{baht(t.offeredDiscount)}</dd>
          <dt className="pr-grand">ยอดเสนอทั้งหมด</dt><dd className="pr-grand">{baht(t.offeredTotal)}</dd>
        </dl>
        {decided && (
          <dl className="pr-totals">
            <dt>รายการที่อนุมัติ (ก่อนลด)</dt><dd>{baht(t.approvedSubtotal)}</dd>
            <dt>ส่วนลดที่ตกลง</dt><dd>{baht(t.approvedDiscount)}</dd>
            <dt className="pr-grand">ยอดที่อนุมัติ</dt><dd className="pr-grand">{baht(t.approvedTotal)}</dd>
          </dl>
        )}
      </div>

      <div className="pr-sigs">
        <div><span className="pr-sig-line" />ผู้เสนอราคา</div>
        <div><span className="pr-sig-line" />ลูกค้าผู้อนุมัติ · วันที่ ........................</div>
      </div>
    </div>
  );
}

function stateText(line: QuotationLine): string {
  if (line.approvalStatus === 'approved') return 'อนุมัติ';
  if (line.approvalStatus === 'declined') return 'ไม่อนุมัติ';
  return 'รอตัดสิน';
}

function QuoteRows({ no, line, kids, decided }: { no: number; line: QuotationLine; kids: QuotationLine[]; decided: boolean }) {
  const declined = line.approvalStatus === 'declined';
  const w = warrantyText(line.warranty);
  return (
    <>
      <tr className={declined ? 'pr-row-off' : undefined}>
        <td className="pr-c-no">{no}</td>
        <td>
          <div className="pr-name">{line.name}{line.brand ? ` (${line.brand})` : ''}</div>
          {w && <div className="pr-sub">ประกัน: {w}</div>}
          {declined && (
            <div className="pr-sub pr-strong">
              เสนอรายการนี้ไปแล้ว ลูกค้าไม่อนุมัติ
              {line.declineReason ? ` (${DECLINE_REASON_LABEL[line.declineReason]}${line.declineNote ? `: ${line.declineNote}` : ''})` : ''}
            </div>
          )}
          {line.approvedAmount !== null && <div className="pr-sub">ราคาที่ตกลง {baht(line.approvedAmount)}</div>}
        </td>
        <td className="pr-c-qty">{qtyText(line.qty)}{line.unit ? ` ${line.unit}` : ''}</td>
        <td className="pr-c-num">{baht(line.unitPrice)}</td>
        <td className="pr-c-num">{baht(line.lineTotal)}</td>
        {decided && <td className="pr-c-state">{stateText(line)}</td>}
      </tr>
      {kids.map((k) => (
        <tr key={k.id} className={`pr-row-child${declined ? ' pr-row-off' : ''}`}>
          <td />
          <td>– {k.name}{k.brand ? ` (${k.brand})` : ''}{k.approvalStatus === 'declined' ? ' · ตัดออก' : ''}</td>
          <td className="pr-c-qty">{qtyText(k.qty)}{k.unit ? ` ${k.unit}` : ''}</td>
          <td />
          <td />
          {decided && <td />}
        </tr>
      ))}
    </>
  );
}
