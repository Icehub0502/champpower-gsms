import type { ReactNode } from 'react';
import type { WorkOrder } from '@gsms/contracts/index.js';
import { qtyText } from '../../lib/printFormat';
import { PartyBlock } from './sheetParts';

/**
 * ใบสั่งงาน on A4 (AC-A1, A4). Approved lines only — the API sends nothing
 * else — and no money anywhere: the WorkOrder contract has no price field.
 * A tick box per line for the technician, a signature at the bottom.
 */
export function WorkOrderSheet({ workOrder }: { workOrder: WorkOrder }) {
  const top = workOrder.lines.filter((l) => l.parentLineId === null).sort((a, b) => a.sortOrder - b.sortOrder);
  const childrenOf = (id: string) => workOrder.lines.filter((l) => l.parentLineId === id).sort((a, b) => a.sortOrder - b.sortOrder);
  const w = workOrder;

  return (
    <div className="pr-body">
      <PartyBlock
        rows={[
          ['เลขงาน', w.jobNumber],
          ['ทะเบียน', [w.plate, w.province].filter(Boolean).join(' ') || '-'],
          ['รถ', [w.brand, w.model, w.color].filter(Boolean).join(' ') || '-'],
          ['เลขไมล์', w.mileageInKm !== null ? `${w.mileageInKm.toLocaleString('en-US')} กม.` : '-'],
          ['ลูกค้า', w.customerName ?? '-'],
          ['จากใบเสนอราคา', w.quotationNumber ? `${w.quotationNumber}${w.quotationRevision ? ` ฉบับที่ ${w.quotationRevision}` : ''}` : '-'],
        ]}
      />

      {top.length === 0 ? (
        <p className="pr-note">ไม่มีรายการที่ต้องทำ</p>
      ) : (
        <table className="pr-items">
          <thead>
            <tr>
              <th className="pr-c-no">#</th>
              <th>รายการที่ต้องทำ</th>
              <th className="pr-c-qty">จำนวน</th>
              <th className="pr-c-tick">เสร็จ</th>
            </tr>
          </thead>
          <tbody>
            {top.map((line, i) => (
              <WorkRows key={line.id} no={i + 1} name={line.name} brand={line.brand} qty={line.qty} unit={line.unit} warranty={line.warrantyName} awaitingParts={line.awaitingParts}>
                {childrenOf(line.id).map((k) => (
                  <tr key={k.id} className="pr-row-child">
                    <td />
                    <td>– {k.name}{k.brand ? ` (${k.brand})` : ''}{k.awaitingParts && <AwaitingParts />}</td>
                    <td className="pr-c-qty">{qtyText(k.qty)}{k.unit ? ` ${k.unit}` : ''}</td>
                    <td className="pr-c-tick"><span className="pr-box" /></td>
                  </tr>
                ))}
              </WorkRows>
            ))}
          </tbody>
        </table>
      )}

      <div className="pr-sigs">
        <div><span className="pr-sig-line" />ช่างผู้รับงาน</div>
        <div><span className="pr-sig-line" />ผู้ตรวจงาน</div>
      </div>
    </div>
  );
}

/**
 * WO-006 / CLAUDE.md s6 item 6: approved, but the shelf could not cover it. Printed boxed
 * next to the line so the technician is not sent to an empty shelf.
 */
function AwaitingParts() {
  return <span className="pr-awaiting">รออะไหล่</span>;
}

function WorkRows({ no, name, brand, qty, unit, warranty, awaitingParts, children }: {
  no: number; name: string; brand: string | null; qty: string; unit: string | null; warranty: string | null; awaitingParts: boolean; children: ReactNode;
}) {
  return (
    <>
      <tr>
        <td className="pr-c-no">{no}</td>
        <td>
          <div className="pr-name">{name}{brand ? ` (${brand})` : ''}{awaitingParts && <AwaitingParts />}</div>
          {warranty && <div className="pr-sub">ประกัน: {warranty}</div>}
        </td>
        <td className="pr-c-qty">{qtyText(qty)}{unit ? ` ${unit}` : ''}</td>
        <td className="pr-c-tick"><span className="pr-box" /></td>
      </tr>
      {children}
    </>
  );
}
