import { useDeferredValue, useId, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Role, SkuPage } from '@gsms/contracts/index.js';
import { Pager } from '../../components/ui/Pager';
import { StockCost, StockFigures, StockStatusBadge } from '../../components/ui/StockFigures';
import { useDocument } from '../../hooks/useDocument';
import { StockNav } from './StockNav';
import { STOCK_API, STOCK_CHANGED_EVENT, STOCK_PAGE_SIZE, canWriteStock, qty, stockRoutes } from './stockLabels';

/**
 * ของใกล้หมด: พร้อมใช้ (on_hand − reserved) at or below the reorder point. The server
 * already leaves out what nobody has counted (WO-006 §2 — "not counted" is not "out") and
 * what is bought per job (buy_to_order). The screen filters the same two out again, so
 * a server slip can never put a never-counted part on a "running out" list.
 */
export function LowStockPage({ role }: { role: Role | null }) {
  const [q, setQ] = useState('');
  const [offset, setOffset] = useState(0);
  const qId = useId();
  const dq = useDeferredValue(q.trim());
  const params = new URLSearchParams({ limit: String(STOCK_PAGE_SIZE), offset: String(offset) });
  if (dq) params.set('q', dq);
  const list = useDocument<SkuPage>(`${STOCK_API}/low?${params}`, STOCK_CHANGED_EVENT);
  const data = list.data;
  const rows = (data?.items ?? []).filter((s) => s.counted && s.stockingPolicy === 'stocked');
  const write = canWriteStock(role);

  return (
    <div className="qt-page st-page">
      <header className="qt-header">
        <div className="qt-header-main">
          <h1>ของใกล้หมด</h1>
          <p className="page-sub">พร้อมใช้ไม่เกินจุดสั่งซื้อ · นับเฉพาะที่ตั้งยอดแล้ว และไม่รวมของซื้อเฉพาะงาน</p>
        </div>
      </header>
      <StockNav role={role} />

      <section className="card st-filters" aria-label="ตัวกรอง">
        <label className="field ci-field" htmlFor={qId}>
          <span className="ci-field-label">ค้นหา (ชื่อ / รหัส)</span>
          <input id={qId} type="search" value={q} autoComplete="off" onChange={(e) => { setQ(e.target.value); setOffset(0); }} />
        </label>
      </section>

      {list.loading && !data && <div className="page-loading">กำลังโหลด...</div>}
      {list.error && !data && (
        <div className="empty-state" role="alert">
          โหลดรายการของใกล้หมดไม่สำเร็จ
          <div><button type="button" className="btn secondary" onClick={() => list.reload?.()}>ลองใหม่</button></div>
        </div>
      )}
      {list.error && data && <p className="ci-nomatch" role="status">โหลดล่าสุดไม่สำเร็จ แสดงข้อมูลเดิม</p>}

      {data && (
        <section className="card" aria-label="ของใกล้หมด">
          <p className="qt-line-sub st-count-line">{data.total} รายการ</p>
          {rows.length === 0 && <p className="qt-line-sub">ไม่มีของใกล้หมด (เฉพาะที่ตั้งยอดแล้ว)</p>}
          <ul className="st-rows">
            {rows.map((s) => (
              <li key={s.id} className="st-row">
                <div className="st-row-main">
                  <Link className="st-name" to={stockRoutes.card(s.id)}>{s.name}</Link>
                  <span className="qt-line-sub">
                    <span className="mono">{s.code}</span>
                    {s.category ? ` · ${s.category}` : ''}
                    {s.shelfLocation ? ` · ชั้น ${s.shelfLocation}` : ''}
                    {` · จุดสั่งซื้อ ${s.reorderPoint === null ? '-' : qty(s.reorderPoint)} ${s.unit}`}
                  </span>
                  <StockCost sku={s} />
                </div>
                <div className="st-row-figs">
                  <StockFigures sku={s} />
                  <StockStatusBadge status={s.status} />
                </div>
                <div className="st-row-actions">
                  <Link className="btn secondary small" to={stockRoutes.card(s.id)}>ประวัติ</Link>
                  {write && <Link className="btn secondary small" to={stockRoutes.countOne(s.id)}>ตั้งยอดใหม่</Link>}
                </div>
              </li>
            ))}
          </ul>
          <Pager offset={offset} limit={STOCK_PAGE_SIZE} total={data.total} onChange={setOffset} />
        </section>
      )}
    </div>
  );
}
