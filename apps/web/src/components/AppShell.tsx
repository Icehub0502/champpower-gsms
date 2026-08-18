import type { ReactNode } from 'react';
import type { User } from 'firebase/auth';
import { signOut } from 'firebase/auth';
import { NavLink } from 'react-router-dom';
import { auth } from '../lib/firebase/client';
import type { Role } from '../hooks/useAuth';
import { BoltIcon } from './ui/BoltIcon';

interface AppShellProps {
  user: User;
  role: Role | null;
  online: boolean;
  children: ReactNode;
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
        </nav>
        {!online && <span className="offline-badge">ออฟไลน์ — จะซิงก์ให้อัตโนมัติ</span>}
        <div className="app-bar-user">
          <span>
            {user.email} {role === 'admin' ? '(admin)' : ''}
          </span>
          <button onClick={() => signOut(auth)}>ออกจากระบบ</button>
        </div>
      </header>
      <main className="app-main">{children}</main>
    </div>
  );
}
