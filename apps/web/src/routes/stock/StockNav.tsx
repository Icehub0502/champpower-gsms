import { NavLink } from 'react-router-dom';
import type { Role } from '@gsms/contracts/index.js';
import { canIssueStock, canReadStockReports, canWriteStock, stockRoutes } from './stockLabels';

interface Item { to: string; label: string; show: (role: Role | null) => boolean; end?: boolean }

const always = () => true;

/**
 * Every stock screen in one place. The main menu and the phone dock carry ONE "สต๊อก"
 * entry (the dock is already full for owner/manager); this strip is how a person moves
 * between the stock screens. Each item shows only to the roles its endpoint accepts.
 */
export const STOCK_NAV: Item[] = [
  { to: stockRoutes.hub, label: 'ภาพรวม', show: always, end: true },
  { to: stockRoutes.issue, label: 'เบิกของ', show: canIssueStock },
  { to: stockRoutes.skus, label: 'รายการอะไหล่', show: always },
  { to: stockRoutes.low, label: 'ของใกล้หมด', show: always },
  { to: stockRoutes.count, label: 'ตั้งยอด', show: canWriteStock },
  { to: stockRoutes.adjust, label: 'ปรับยอด', show: canWriteStock },
  { to: stockRoutes.links, label: 'ผูกแคตตาล็อก', show: canWriteStock },
  { to: stockRoutes.unbound, label: 'ยังไม่ผูกสต๊อก', show: canWriteStock },
  { to: stockRoutes.stale, label: 'ของจองค้าง', show: canWriteStock },
  { to: stockRoutes.adjustments, label: 'ปรับสต๊อกรายวัน', show: canReadStockReports },
  { to: stockRoutes.integrity, label: 'ตรวจยอด', show: canReadStockReports },
];

export function StockNav({ role }: { role: Role | null }) {
  return (
    <nav className="st-nav" aria-label="เมนูสต๊อก">
      {STOCK_NAV.filter((i) => i.show(role)).map((i) => (
        <NavLink key={i.to} to={i.to} end={i.end} className={({ isActive }) => `chip${isActive ? ' active' : ''}`}>
          {i.label}
        </NavLink>
      ))}
    </nav>
  );
}

/** Shown in place of a stock screen the role may not open (the API refuses it too). */
export function StockNoAccess({ role, what }: { role: Role | null; what: string }) {
  return (
    <div className="qt-page st-page">
      <StockNav role={role} />
      <div className="empty-state" role="alert">
        {what} เปิดได้เฉพาะพนักงานที่มีสิทธิ์ — ขอให้ผู้จัดการทำให้
      </div>
    </div>
  );
}
