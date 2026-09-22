import { Navigate, Outlet, Route, Routes, useNavigate } from 'react-router-dom';
import { useAuth, type AuthUser, type Role } from './hooks/useAuth';
import { useOnlineStatus } from './hooks/useOnlineStatus';
import { LoginPage } from './routes/auth/LoginPage';
import { JobListPage } from './routes/jobs/JobListPage';
import { JobDetailPage } from './routes/jobs/JobDetailPage';
import { CheckInPage } from './routes/checkin/CheckInPage';
import { BlankFormPage } from './routes/print/BlankFormPage';
import { BoardPage } from './routes/board/BoardPage';
import { LookupPage } from './routes/lookup/LookupPage';
import { AppShell } from './components/AppShell';
import { HomeLauncherPage } from './routes/home/HomeLauncherPage';
import { NotYetAvailable } from './components/ui/NotYetAvailable';

// /board (waiting-room display) and /lookup (customer "find my car" page, reached via
// QR code) are both public and must never require login — matched before the authed
// catch-all below, so neither ever touches useAuth at all.
export function App() {
  return (
    <Routes>
      <Route path="/board" element={<BoardPage />} />
      <Route path="/lookup" element={<LookupPage />} />
      <Route path="/*" element={<AuthedApp />} />
    </Routes>
  );
}

function AuthedApp() {
  const auth = useAuth();
  const online = useOnlineStatus();

  // WO-004/T6 condition 7: an explicit "checking" state. `auth.loading` is
  // true only while the boot-time silent refresh (against the httpOnly
  // refresh cookie) is in flight — render neither the authed shell nor the
  // login form until it resolves, or a reload of an authenticated tab would
  // flash the login page for a moment every single time.
  if (auth.loading) {
    return <div className="page-loading">กำลังตรวจสอบสิทธิ์...</div>;
  }

  if (!auth.user || !auth.shop) {
    return <LoginPage />;
  }

  return (
    // Keyed on the active shop (WO-004/T6 condition 4): switching branch
    // changes `auth.shop.id`, which — because `key` forces React to tear
    // down and rebuild the subtree rather than diff it — unmounts every
    // route element below, including HomeLauncherPage and everything inside
    // ShellLayout's <Outlet>. That is what actually discards every
    // useCollection/useDocument instance's local rows: this codebase has no
    // separate query-cache object to clear by hand, so a stale row from shop
    // A sitting in a component that never unmounted is exactly the failure
    // mode a `key` on `<Route element=.../>` would NOT have caught — the
    // route matcher builds its own elements independently of any `key` prop
    // placed on a `<Route>` in JSX, so the key has to live here, on the
    // actual rendered component.
    <Routes key={auth.shop.id}>
      {/* Home Launcher is its own full-screen surface (post-login app picker),
          shown without the sidebar/top-bar shell — that shell is for the staff
          console itself, not for choosing which surface to enter. */}
      <Route path="/" element={<HomeLauncherPage />} />
      <Route
        element={(
          <ShellLayout user={auth.user} role={auth.role} online={online} onLogout={auth.logout} />
        )}
      >
        <Route path="/jobs" element={<JobListRoute />} />
        <Route path="/jobs/:jobId" element={<JobDetailPage />} />
        <Route path="/checkin" element={<CheckInRoute />} />
        <Route path="/print/blank-checkin" element={<BlankFormPage />} />

        {/* Not yet ported onto the new API (WO-004/T6) — see
            components/ui/NotYetAvailable.tsx. Each still calls an endpoint
            apps/api/src/app.ts does not mount (finance/catalog/settings/etc.
            are all MySQL-era routes), and each page file is kept on disk,
            unported, for a later phase to pick up against @gsms/contracts. */}
        <Route path="/finance" element={<NotYetAvailable title="รายได้" />} />
        <Route path="/models" element={<NotYetAvailable title="รุ่นรถ / อะไหล่" />} />
        <Route path="/models/:modelId" element={<NotYetAvailable title="รุ่นรถ / อะไหล่" />} />
        <Route path="/models/:modelId/promotions" element={<NotYetAvailable title="โปรโมชันรุ่นรถ" />} />
        <Route path="/master-parts" element={<NotYetAvailable title="สินค้า" />} />
        <Route path="/price-book" element={<NotYetAvailable title="ตำราคา" />} />
        <Route path="/price-book/print" element={<NotYetAvailable title="พิมพ์ตำราคา" />} />
        <Route path="/stuck-jobs" element={<NotYetAvailable title="งานค้าง" />} />
        <Route path="/delivered" element={<NotYetAvailable title="รถทั้งหมด" />} />
        <Route path="/rejected" element={<NotYetAvailable title="รายการที่ลูกค้าปฏิเสธ" />} />
        <Route path="/warranty" element={<NotYetAvailable title="งานประกัน" />} />
        <Route path="/calendar" element={<NotYetAvailable title="นัดหมาย" />} />
        <Route path="/ai" element={<NotYetAvailable title="ผู้ช่วย AI" />} />
        <Route path="/settings" element={<NotYetAvailable title="ตั้งค่า" />} />
        <Route path="/settings/users" element={<NotYetAvailable title="ผู้ใช้งาน" />} />
        <Route path="/settings/technicians" element={<NotYetAvailable title="ช่าง" />} />
        <Route path="/settings/trash" element={<NotYetAvailable title="ถังขยะ" />} />

        <Route path="*" element={<Navigate to="/jobs" replace />} />
      </Route>
    </Routes>
  );
}

function ShellLayout({
  user,
  role,
  online,
  onLogout,
}: {
  user: AuthUser;
  role: Role | null;
  online: boolean;
  onLogout: () => void;
}) {
  return (
    <AppShell user={user} role={role} online={online} onLogout={onLogout}>
      <Outlet />
    </AppShell>
  );
}

function JobListRoute() {
  const navigate = useNavigate();
  return <JobListPage onOpenJob={(jobId) => navigate(`/jobs/${jobId}`)} />;
}

function CheckInRoute() {
  const navigate = useNavigate();
  return <CheckInPage onCreated={(jobId) => navigate(`/jobs/${jobId}`)} />;
}
