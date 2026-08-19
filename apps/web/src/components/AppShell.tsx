import { useEffect, useState, type ReactNode } from 'react';
import type { User } from 'firebase/auth';
import { signOut } from 'firebase/auth';
import { NavLink } from 'react-router-dom';
import QRCode from 'qrcode';
import { auth } from '../lib/firebase/client';
import type { Role } from '../hooks/useAuth';
import { BoltIcon } from './ui/BoltIcon';
import { Modal } from './ui/Modal';

interface AppShellProps {
  user: User;
  role: Role | null;
  online: boolean;
  children: ReactNode;
}

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
      <button type="button" className="app-bar-qr-btn" onClick={() => setOpen(true)}>
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
  return (
    <div className="app-shell">
      <header className="app-bar">
        <span className="app-bar-title">
          <BoltIcon size={18} /> POWER GROUP
        </span>
        <nav className="app-bar-nav">
          <NavLink to="/jobs" className={({ isActive }) => (isActive ? 'active' : '')}>
            รายการงาน
          </NavLink>
          <NavLink to="/checkin" className={({ isActive }) => (isActive ? 'active' : '')}>
            + รับรถ
          </NavLink>
          <NavLink to="/finance" className={({ isActive }) => (isActive ? 'active' : '')}>
            สถิติรายได้
          </NavLink>
          <NavLink to="/models" className={({ isActive }) => (isActive ? 'active' : '')}>
            รุ่นรถ
          </NavLink>
          <NavLink to="/master-parts" className={({ isActive }) => (isActive ? 'active' : '')}>
            สินค้า
          </NavLink>
          <a href="/board" target="_blank" rel="noreferrer">
            จอลูกค้า ↗
          </a>
          <LookupQrButton />
        </nav>
        {!online && <span className="offline-badge">ออฟไลน์ — จะซิงก์ให้อัตโนมัติ</span>}
        <div className="app-bar-user">
          <span>
            {user.email} {role === 'admin' ? '(admin)' : ''}
          </span>
          <button className="btn small" onClick={() => signOut(auth)}>ออกจากระบบ</button>
        </div>
      </header>
      <main className="app-main">{children}</main>
    </div>
  );
}
