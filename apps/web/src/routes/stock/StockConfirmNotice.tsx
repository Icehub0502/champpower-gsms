import { Link } from 'react-router-dom';
import type { StockConfirmSummary } from '@gsms/contracts/index.js';
import { qty, stockRoutes } from './stockLabels';

/**
 * What "ยืนยันผลลูกค้า" did to stock (POST .../quotation/confirm -> `stock`). News, never a
 * block: the confirm already happened. Four groups, each only when it has something:
 * จองแล้ว · ของไม่พอ (a purchase suggestion was opened, the work order says รออะไหล่) ·
 * ยังไม่ตั้งยอด (nothing reserved, nothing blocked) · ยังไม่ผูกสต๊อก (cannot reserve).
 */
export function StockConfirmNotice({ summary: s, jobId, mayIssue, mayFix, onClose }: {
  summary: StockConfirmSummary; jobId: string; mayIssue: boolean; mayFix: boolean; onClose: () => void;
}) {
  const empty = s.reserved.length + s.shortfalls.length + s.notCounted.length + s.unbound.length === 0;
  if (empty) return null;
  return (
    <section className="card st-notice" role="status" aria-label="ผลต่อสต๊อก">
      <div className="dp-job-head">
        <h3>สต๊อกหลังยืนยันผลลูกค้า</h3>
        <button type="button" className="btn secondary small" onClick={onClose}>ปิด</button>
      </div>
      {s.reserved.length > 0 && (
        <>
          <h4>จองของให้งานนี้แล้ว {s.reserved.length} รายการ</h4>
          <ul>{s.reserved.map((r) => <li key={r.lineId}>{r.name} · <span className="mono">{r.skuCode}</span> × {qty(r.qty)}</li>)}</ul>
        </>
      )}
      {s.shortfalls.length > 0 && (
        <>
          <h4 className="st-neg">ของไม่พอ — สร้างรายการต้องสั่งซื้อแล้ว</h4>
          <ul>
            {s.shortfalls.map((r) => (
              <li key={r.lineId}>
                {r.name} · <span className="mono">{r.skuCode}</span> — ต้องใช้ {qty(r.needed)} จองได้ {qty(r.reserved)} <strong>ขาด {qty(r.short)}</strong>
              </li>
            ))}
          </ul>
          <p className="qt-line-sub">ใบสั่งงานของช่างจะขึ้น “รออะไหล่” ที่รายการเหล่านี้ · อนุมัติได้ตามปกติ ไม่ได้บล็อก</p>
        </>
      )}
      {s.notCounted.length > 0 && (
        <>
          <h4>ยังไม่ตั้งยอด — ไม่ได้จอง (ขายได้ตามปกติ)</h4>
          <ul>{s.notCounted.map((r) => <li key={r.lineId}>{r.name} · <span className="mono">{r.skuCode}</span></li>)}</ul>
          {mayFix && <p className="qt-line-sub"><Link to={stockRoutes.count}>ไปตั้งยอด</Link> แล้วค่อยเบิกได้</p>}
        </>
      )}
      {s.unbound.length > 0 && (
        <>
          <h4>ยังไม่ผูกสต๊อก — จองและตัดสต๊อกไม่ได้</h4>
          <ul>{s.unbound.map((r) => <li key={r.lineId}>{r.name}</li>)}</ul>
          {mayFix && <p className="qt-line-sub"><Link to={stockRoutes.links}>ผูกแคตตาล็อกกับสต๊อก</Link></p>}
        </>
      )}
      {mayIssue && (s.reserved.length > 0 || s.shortfalls.length > 0) && (
        <Link className="btn secondary small" to={stockRoutes.jobIssue(jobId)}>ไปหน้าเบิกของของงานนี้</Link>
      )}
    </section>
  );
}
