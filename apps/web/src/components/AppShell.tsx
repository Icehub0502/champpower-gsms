import { useEffect, useState, type ReactNode } from 'react';
import type { User } from 'firebase/auth';
import { signOut } from 'firebase/auth';
import { NavLink, useNavigate } from 'react-router-dom';
import QRCode from 'qrcode';
import { auth } from '../lib/firebase/client';
import type { Role } from '../hooks/useAuth';
import { BoltIcon } from './ui/BoltIcon';
import { Icon } from './ui/Icon';
import { Modal } from './ui/Modal';

interface AppShellProps {
  user: User;
  role: Role | null;
  online: boolean;
  children: ReactNode;
}

const NAV_ITEMS: { to: string; label: string; icon: Parameters<typeof Icon>[0]['name'] }[] = [
  { to: '/jobs', label: 'งานวันนี้', icon: 'list' },
  { to: '/checkin', label: 'รับรถ', icon: 'plus' },
  { to: '/delivered', label: 'รถทั้งหมด', icon: 'car' },
  { to: '/models', label: 'รุ่นรถ / อะไหล่', icon: 'box' },
  { to: '/master-parts', label: 'สินค้า', icon: 'wrench' },
  { to: '/finance', label: 'รายได้', icon: 'money' },
  { to: '/calendar', label: 'นัดหมาย', icon: 'calendar' },
  { to: '/settings/users', label: 'ผู้ใช้งาน', icon: 'users' },
  { to: '/settings', label: 'ตั้งค่า', icon: 'settings' },
];

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

export function AppShell({ user, role, online, children }: AppShellProps) {
  const navigate = useNavigate();
  const initial = (user.email || '?').charAt(0).toUpperCase();

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
          {user.email}
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
                <span>{user.email}</span>
                <span className="role">{role === 'admin' ? 'ผู้ดูแลระบบ' : 'พนักงาน'}</span>
              </div>
            </div>
            <button type="button" className="btn small secondary" onClick={() => signOut(auth)}>
              ออกจากระบบ
            </button>
          </div>
        </header>
        <main className="app-main">{children}</main>
      </div>
    </div>
  );
}
