import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import QRCode from 'qrcode';
import type { AuthUser, Role } from '../hooks/useAuth';
import { BoltIcon } from './ui/BoltIcon';
import { Icon } from './ui/Icon';
import { Modal } from './ui/Modal';

interface AppShellProps {
  user: AuthUser;
  role: Role | null;
  online: boolean;
  onLogout: () => void;
  children: ReactNode;
}

// WO-004/T6: only /jobs, /checkin and /print/blank-checkin are wired to a
// mounted API today (apps/api/src/app.ts). Every other screen this sidebar
// used to link to (delivered/models/master-parts/price-book/stuck-jobs/
// finance/calendar/settings/users) still calls an unmounted MySQL-era
// endpoint, so its nav entry is removed rather than left to click through to
// components/ui/NotYetAvailable.tsx — a link that always says "not available"
// is worse than no link. The routes themselves still exist (App.tsx) for a
// direct URL / bookmark, and the pages are kept on disk, unported, for a
// later phase.
const NAV_ITEMS: { to: string; label: string; icon: Parameters<typeof Icon>[0]['name'] }[] = [
  { to: '/jobs', label: 'งานวันนี้', icon: 'list' },
  { to: '/checkin', label: 'รับรถ', icon: 'plus' },
];

const ROLE_LABEL_TH: Record<Role, string> = {
  owner: 'เจ้าของ',
  manager: 'ผู้จัดการ',
  assistant_manager: 'รองผู้จัดการ',
  advisor: 'หน้าร้าน',
  technician: 'ช่าง',
  accountant: 'บัญชี',
  viewer: 'ผู้ดูอย่างเดียว',
};

/** QR code for the public "find my car" page — generated client-side so it always
 * points at wherever this deploy is actually running (no hardcoded domain). */
function LookupQrButton() {
  const [open, setOpen] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState('');
  const lookupUrl = `${window.location.origin}/lookup`;

  useEffect(() => {
    if (!open) return;
    QRCode.toDataURL(lookupUrl, { width: 260, margin: 1 }).then(setQrDataUrl);
  }, [open, lookupUrl]);

  return (
    <>
      <button type="button" className="app-bar-qr-btn btn secondary small" onClick={() => setOpen(true)}>
        QR ค้นหารถ
      </button>
      {open && (
        <Modal title="QR ให้ลูกค้าสแกนค้นหารถ" onClose={() => setOpen(false)}>
          <div className="lookup-qr-modal">
            {qrDataUrl && <img src={qrDataUrl} alt="QR code" width={220} height={220} />}
            <p className="page-sub">{lookupUrl}</p>
          </div>
        </Modal>
      )}
    </>
  );
}

export function AppShell({ user, role, online, onLogout, children }: AppShellProps) {
  const navigate = useNavigate();
  const displayName = user.name || user.loginId;
  const initial = (displayName || '?').charAt(0).toUpperCase();

  return (
    <div className="shell-v2">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <div className="sidebar-brand-name">
            <BoltIcon size={17} />
            <span className="word-full">POWER</span> <span className="accent word-full">GROUP</span>
          </div>
          <div className="sidebar-brand-sub">Service OS</div>
        </div>
        <nav className="sidebar-nav" aria-label="เมนูหลัก">
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) => `sidebar-link${isActive ? ' active' : ''}`}
            >
              <Icon name={item.icon} size={17} />
              <span className="label">{item.label}</span>
            </NavLink>
          ))}
          <a
            className="sidebar-link"
            href="/board"
            target="_blank"
            rel="noreferrer"
            title="เปิดกระดานสถานะลูกค้าในแท็บใหม่"
          >
            <Icon name="monitor" size={17} />
            <span className="label">จอลูกค้า ↗</span>
          </a>
        </nav>
        <div className="sidebar-footer">
          v4.0 Redesign
          <br />
          {displayName}
        </div>
      </aside>

      <div className="shell-main">
        <header className="topbar">
          <div className="topbar-search">
            <Icon name="search" size={16} />
            <input placeholder="ค้นหาทะเบียน / ลูกค้า / เลขงาน" aria-label="ค้นหา" disabled />
          </div>
          <button type="button" className="btn topbar-cta" onClick={() => navigate('/checkin')}>
            <Icon name="plus" size={15} /> รับรถ
          </button>
          <div className="topbar-actions">
            {!online && <span className="offline-badge">ออฟไลน์ — จะซิงก์ให้อัตโนมัติ</span>}
            <LookupQrButton />
            <div className="topbar-profile">
              <div className="profile-chip" aria-hidden="true">{initial}</div>
              <div className="topbar-profile-meta">
                <span>{displayName}</span>
                <span className="role">{role ? ROLE_LABEL_TH[role] : '-'}</span>
              </div>
            </div>
            <button type="button" className="btn small secondary" onClick={onLogout}>
              ออกจากระบบ
            </button>
          </div>
        </header>
        <main className="app-main">{children}</main>
      </div>
    </div>
  );
}
