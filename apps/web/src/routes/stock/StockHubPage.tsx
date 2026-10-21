import { Link } from 'react-router-dom';
import type { Role, SkuPage } from '@gsms/contracts/index.js';
import { Icon } from '../../components/ui/Icon';
import { useDocument } from '../../hooks/useDocument';
import { StockNav } from './StockNav';
import { STOCK_API, STOCK_CHANGED_EVENT, SKUS_PATH, canIssueStock, canReadStockReports, canWriteStock, stockRoutes } from './stockLabels';

interface Tile { to: string; title: string; text: string; icon: Parameters<typeof Icon>[0]['name']; show: boolean; hazard?: boolean }

/**
 * /stock — the one menu entry. Two live counts (ของใกล้หมด, ยังไม่ตั้งยอด) read the totals
 * of one-row pages, so they cost nothing; the tiles are the doors this role may open.
 */
export function StockHubPage({ role }: { role: Role | null }) {
  const low = useDocument<SkuPage>(`${STOCK_API}/low?limit=1&offset=0`, STOCK_CHANGED_EVENT);
  const notCounted = useDocument<SkuPage>(`${SKUS_PATH}?status=not_counted&limit=1&offset=0`, STOCK_CHANGED_EVENT);
  const write = canWriteStock(role);

  const tiles: Tile[] = [
    { to: stockRoutes.issue, title: 'เบิกของ', text: 'จัดอะไหล่ของงานมากองหน้าห้องสต๊อก แล้วกดเบิก', icon: 'wrench', show: canIssueStock(role), hazard: true },
    { to: stockRoutes.skus, title: 'รายการอะไหล่', text: 'ค้นหา ดูคงเหลือ จอง พร้อมใช้ และประวัติรายตัว', icon: 'box', show: true },
    { to: stockRoutes.low, title: 'ของใกล้หมด', text: 'พร้อมใช้ไม่ถึงจุดสั่งซื้อ (เฉพาะที่ตั้งยอดแล้ว)', icon: 'alert', show: true },
    { to: stockRoutes.count, title: 'ตั้งยอด', text: 'นับของจริงแล้วกรอก — ของที่เคยมีขึ้นก่อน', icon: 'list', show: write },
    { to: stockRoutes.adjust, title: 'ปรับยอด', text: 'ยอดไม่ตรงของจริง ปรับพร้อมเหตุผล', icon: 'edit', show: write },
    { to: stockRoutes.links, title: 'ผูกแคตตาล็อกกับสต๊อก', text: 'รายการที่ขายในใบเสนอราคา ↔ อะไหล่ในสต๊อก', icon: 'tag', show: write },
    { to: stockRoutes.unbound, title: 'บรรทัดที่ยังไม่ผูกสต๊อก', text: 'อะไหล่ในใบเสนอราคาที่ไม่ได้ตัดสต๊อก', icon: 'alert', show: write },
    { to: stockRoutes.stale, title: 'ของจองค้าง', text: 'งานจบแล้วแต่ของยังจองอยู่', icon: 'alert', show: write },
    { to: stockRoutes.adjustments, title: 'การปรับสต๊อกด้วยมือรายวัน', text: 'ทุกการตั้งยอดและปรับยอดของวัน', icon: 'calendar', show: canReadStockReports(role) },
    { to: stockRoutes.integrity, title: 'ตรวจความถูกต้องของยอด', text: 'ประวัติการเคลื่อนไหว เทียบยอดคงเหลือ', icon: 'checkCircle', show: canReadStockReports(role) },
  ];

  return (
    <div className="qt-page st-page">
      <header className="qt-header">
        <div className="qt-header-main">
          <h1>สต๊อก</h1>
          <p className="page-sub">ของจริงบนชั้น · ของที่จองให้งาน · ของที่พร้อมใช้</p>
        </div>
      </header>
      <StockNav role={role} />

      <section className="st-hub-counts" aria-label="ภาพรวมสต๊อก">
        <Link className="card st-hub-count" to={stockRoutes.low}>
          <span className="qt-line-sub">ของใกล้หมด</span>
          <strong className="mono">{low.data ? low.data.total : low.error ? '—' : '…'}</strong>
          <span className="qt-line-sub">รายการ (นับเฉพาะที่ตั้งยอดแล้ว)</span>
        </Link>
        <Link className="card st-hub-count" to={write ? stockRoutes.count : stockRoutes.skus}>
          <span className="qt-line-sub">ยังไม่ตั้งยอด</span>
          <strong className="mono">{notCounted.data ? notCounted.data.total : notCounted.error ? '—' : '…'}</strong>
          <span className="qt-line-sub">รายการ — ขายได้ตามปกติ แต่ระบบยังไม่รู้ว่ามีเท่าไหร่</span>
        </Link>
      </section>

      <ul className="st-hub-tiles">
        {tiles.filter((t) => t.show).map((t) => (
          <li key={t.to}>
            <Link className={`card st-hub-tile${t.hazard ? ' is-hazard' : ''}`} to={t.to}>
              <Icon name={t.icon} size={20} />
              <span className="st-hub-tile-main">
                <strong>{t.title}</strong>
                <span className="qt-line-sub">{t.text}</span>
              </span>
              <Icon name="forward" size={16} />
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
