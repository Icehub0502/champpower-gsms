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

// Only the screens being built this week are linked (docs/UI-SPEC-FIGMA.md §6):
// งานวันนี้ (/today), รับรถ (/checkin) and the public board. Every older screen
// still calls an unmounted MySQL-era endpoint and renders
// components/ui/NotYetAvailable.tsx from a direct URL only — a live-looking
// link that always says "not available" is worse than no link, so none of
// them are listed here. /jobs keeps its route (job detail and check-in land
// on /jobs/:id) but is no longer a nav entry.
const NAV_ITEMS: { to: string; label: string; icon: Parameters<typeof Icon>[0]['name'] }[] = [
  { to: '/today', label: 'งานวันนี้', icon: 'list' },
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

/**
 * The staff console frame: sidebar, top bar, bottom dock, content.
 *
 * Every piece is rendered at every width and CSS alone decides what is visible
 * (globals.css "SHELL TIERS"). This is deliberate and load-bearing: an iPad
 * rotating 820 -> 1180 crosses a breakpoint, and if this component picked a
 * different subtree per width (a useMediaQuery branch, or a width-derived
 * `key`) React would unmount `children` — the half-filled check-in form, its
 * scroll position, an open drawer — every time staff turned the tablet.
 * `children` sits at one fixed position in this tree regardless of width, so
 * it is only ever diffed, never remounted. AppShell.test.tsx pins this.
 */
export function AppShell({ user, role, online, onLogout, children }: AppShellProps) {
  const navigate = useNavigate();
  const displayName = user.name || user.loginId;
  const initial = (displayName || '?').charAt(0).toUpperCase();

  return (
    <div className="shell-v2">
      {/* Visible ≥768 only: icon rail 72px (768–1279), full 232px (≥1280). */}
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
              // `title` gives mouse users a tooltip on the icon rail; the label
              // itself stays in the accessibility tree at every width (it is
              // clipped, not display:none, on the rail), so screen readers
              // always get a name.
              title={item.label}
              className={({ isActive }) => `sidebar-link${isActive ? ' active' : ''}`}
            >
              <Icon name={item.icon} size={17} />
              <span className="label">{item.label}</span>
            </NavLink>
          ))}
          {/* No "จอลูกค้า" link here on purpose: /board now needs a per-shop
              token (/board/:token) nobody in this app can look up yet — a link
              that only leads to "ask the owner for the URL" is a dead end for
              everyone except the one person who already has it. Bring this
              back once there is an owner-only endpoint to fetch/copy the
              token (filed alongside the public-socket token follow-up). */}
        </nav>
        <div className="sidebar-footer">
          v4.0 Redesign
          <br />
          {displayName}
        </div>
      </aside>

      <div className="shell-main">
        <header className="topbar">
          {/* Phone only: the sidebar (and its brand) is hidden below 768. */}
          <div className="topbar-brand" aria-hidden="true">
            <BoltIcon size={17} />
          </div>
          <div className="topbar-search">
            <Icon name="search" size={16} />
            <input placeholder="ค้นหาเลขงาน / ทะเบียน / ลูกค้า" aria-label="ค้นหา" disabled />
          </div>
          {/* Hidden on phones, where the same action sits in the dock within thumb reach. */}
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
            <button type="button" className="btn small secondary topbar-logout" onClick={onLogout}>
              ออกจากระบบ
            </button>
          </div>
        </header>

        <main className="app-main">{children}</main>
      </div>

      {/* Bottom command dock (Figma 80) — phones only (<768). Sits after the
          content in DOM order so keyboard/screen-reader users reach the page
          first; it is position:fixed, so source order does not move it. */}
      <nav className="dock" aria-label="เมนูลัด">
        <span className="dock-badge" aria-hidden="true">⌘</span>
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) => `dock-btn${isActive ? ' active' : ''}`}
          >
            {item.label}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
