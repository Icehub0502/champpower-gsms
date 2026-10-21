import { DEPOSIT_CHANNEL_LABEL, DEPOSIT_REASON_LABEL, PAYMENT_METHOD_LABEL } from '@champpower/domain';
import type { DepositSlipContent } from '@gsms/contracts/index.js';
import { baht } from '../../lib/money';
import { dateKeyThai, thaiDateTime } from '../../lib/printFormat';
import { PartyBlock } from './sheetParts';

/**
 * ใบรับเงินมัดจำ on A4 (CLAUDE.md §5.4 item 4b). The content is the slip's own
 * frozen snapshot as the server sent it; nothing is joined live or added up here.
 *
 * The paper is proof the shop HOLDS the customer's money, not proof of a sale:
 * it must never carry the words for a receipt or a tax invoice. Its title comes
 * from the server (the contract pins it to the one allowed literal) and the
 * body below only ever says "มัดจำ".
 */
export function DepositSlipSheet({ content }: { content: DepositSlipContent }) {
  const c = content;
  return (
    <div className="pr-body">
      <PartyBlock
        rows={[
          ['ลูกค้า', c.customerName ?? '-'],
          ['โทร', c.customerPhone ?? '-'],
          ['วันที่รับเงิน', thaiDateTime(c.receivedAt)],
          ['วันที่นัดเอารถเข้า', dateKeyThai(c.expectedDate)],
          ['อ้างอิงใบเสนอราคา', c.quotationNumber ?? '-'],
          ['เลขงาน', c.jobNumber ?? '-'],
          ['ทะเบียน', c.plate ?? '-'],
          ['ติดต่อผ่าน', DEPOSIT_CHANNEL_LABEL[c.channel]],
        ]}
      />

      <table className="pr-items">
        <thead>
          <tr>
            <th>รายการ</th>
            <th className="pr-c-num">จำนวนเงิน</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <div className="pr-name">เงินมัดจำ — {DEPOSIT_REASON_LABEL[c.reason]}</div>
              <div className="pr-sub">
                รับทาง {c.paymentChannelName ?? PAYMENT_METHOD_LABEL[c.method]}
              </div>
            </td>
            <td className="pr-c-num pr-strong">{baht(c.amount)}</td>
          </tr>
        </tbody>
      </table>

      <dl className="pr-totals pr-deposit-total">
        <dt className="pr-grand">รับเงินมัดจำ</dt><dd className="pr-grand">{baht(c.amount)}</dd>
      </dl>

      <p className="pr-note">
        เงินมัดจำนี้จะนำไปหักจากยอดค่าซ่อมเมื่อปิดบิล โปรดเก็บใบนี้ไว้เป็นหลักฐาน
        {c.quotationNumber ? ` · อ้างอิงใบเสนอราคาเลขที่ ${c.quotationNumber}` : ''}
      </p>

      <div className="pr-sigs">
        <div><span className="pr-sig-line" />ผู้รับเงิน{c.receivedByName ? ` (${c.receivedByName})` : ''}</div>
        <div><span className="pr-sig-line" />ลูกค้า</div>
      </div>
    </div>
  );
}
