import { Navigate, Outlet, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { useAuth, type AuthUser, type Role } from './hooks/useAuth';
import { useOnlineStatus } from './hooks/useOnlineStatus';
import { LoginPage } from './routes/auth/LoginPage';
import { CheckInPage } from './routes/checkin/CheckInPage';
import { BlankFormPage } from './routes/print/BlankFormPage';
import { BoardPage } from './routes/board/BoardPage';
import { LookupPage } from './routes/lookup/LookupPage';
import { AppShell } from './components/AppShell';
import { HomeLauncherPage } from './routes/home/HomeLauncherPage';
import { NotYetAvailable } from './components/ui/NotYetAvailable';
import { TodayPage } from './routes/today/TodayPage';
import { QuoteRoute } from './routes/quote/QuotePage';
import { canReadQuote } from './routes/quote/quoteLabels';
import { BillRoute } from './routes/bill/BillPage';
import { canReadBill } from './routes/bill/billLabels';
import { DailyRoute } from './routes/daily/DailySummaryPage';
import { PaymentChannelsRoute } from './routes/settings/PaymentChannelsPage';
import { DepositsRoute } from './routes/deposits/DepositsPage';
import { NewDepositRoute } from './routes/deposits/NewDepositPage';
import { StockHubPage } from './routes/stock/StockHubPage';
import { SkuListPage } from './routes/stock/SkuListPage';
import { CountSheetRoute } from './routes/stock/CountSheetPage';
import { StockCardRoute } from './routes/stock/StockCardPage';
import { LowStockPage } from './routes/stock/LowStockPage';
import { AdjustRoute } from './routes/stock/AdjustPage';

// /board (waiting-room display) and /lookup (customer "find my car" page, reached via
// QR code) are both public and must never require login — matched before the authed
// catch-all below, so neither ever touches useAuth at all.
//
// The board is named by the shop's unguessable token (/board/:token, CLAUDE.md §8
// rule 7). Plain /board stays public too, and only says the TV needs the owner's
// link — it never lists shops and never guesses one.
export function App() {
  return (
    <Routes>
      <Route path="/board/:token" element={<BoardPage />} />
      <Route path="/board" element={<BoardPage />} />
      <Route path="/lookup" element={<LookupPage />} />
      <Route path="/*" element={<AuthedApp />} />
    </Routes>
  );
}

function AuthedApp() {
  const auth = useAuth();
  const location = useLocation();
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
    // The URL must not outlive the identity: without this, logging out on
    // /checkin and signing in as someone else lands that person on /checkin.
    // Signed-out always means "/", so the next login always starts at the
    // launcher and the person chooses where to go. (Replace, no return-to.)
    // Deliberate trade-off: a deep link the person was on is lost after a
    // re-login. Restoring it would hand one person's location to the next.
    if (location.pathname !== '/') return <Navigate to="/" replace />;
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
    // Keyed on user AND shop: a different person signing in to the same shop
    // must not inherit any mounted state either.
    <Routes key={`${auth.user.id}:${auth.shop.id}`}>
      {/* Home Launcher is its own full-screen surface (post-login app picker),
          shown without the sidebar/top-bar shell — that shell is for the staff
          console itself, not for choosing which surface to enter. */}
      <Route path="/" element={<HomeLauncherPage />} />
      <Route
        element={(
          <ShellLayout user={auth.user} role={auth.role} online={online} onLogout={auth.logout} />
        )}
      >
        <Route path="/today" element={<TodayPage canOpenQuote={canReadQuote(auth.role)} canOpenBill={canReadBill(auth.role)} />} />
        <Route path="/checkin" element={<CheckInRoute />} />
        {/* P3.1 — the quotation of one job. Matched before the closed
            /jobs/:jobId below. The role check inside is for what to SHOW;
            the API refuses a technician on every quotation door anyway. */}
        <Route path="/jobs/:jobId/quote" element={<QuoteRoute role={auth.role} />} />
        {/* P3.2 — tick what was done, take the money, close the bill, print; and the day's two figures. */}
        <Route path="/jobs/:jobId/bill" element={<BillRoute role={auth.role} />} />
        <Route path="/daily" element={<DailyRoute role={auth.role} />} />
        {/* P3.3 — deposits the shop holds (มัดจำค้างอยู่) and the online deposit with no car yet. */}
        <Route path="/deposits" element={<DepositsRoute role={auth.role} />} />
        <Route path="/deposits/new" element={<NewDepositRoute role={auth.role} />} />
        <Route path="/settings/payment-channels" element={<PaymentChannelsRoute role={auth.role} />} />
        {/* WO-006 — stock. One menu entry (/stock); every screen gates itself by the
            endpoint's roles, and the API checks the role again on every route. */}
        <Route path="/stock" element={<StockHubPage role={auth.role} />} />
        <Route path="/stock/skus" element={<SkuListPage role={auth.role} />} />
        <Route path="/stock/count" element={<CountSheetRoute role={auth.role} />} />
        <Route path="/stock/skus/:skuId" element={<StockCardRoute role={auth.role} />} />
        <Route path="/stock/low" element={<LowStockPage role={auth.role} />} />
        <Route path="/stock/adjust" element={<AdjustRoute role={auth.role} />} />
        <Route path="/print/blank-checkin" element={<BlankFormPage />} />

        {/* Not yet ported onto the new API (WO-004/T6) — see
            components/ui/NotYetAvailable.tsx. Each still calls an endpoint
            apps/api/src/app.ts does not mount (finance/catalog/settings/etc.
            are all MySQL-era routes), and each page file is kept on disk,
            unported, for a later phase to pick up against @gsms/contracts. */}
        {/* /jobs and /jobs/:jobId joined this list on 25 Sep 2026: both called
            GET /api/jobs (and friends) with nothing mounted at that path, so
            useCollection quietly reported an empty/missing job as "there is
            nothing" — an empty job list with cars in the workshop, or "ไม่พบ
            งานนี้" right after a successful check-in. /today is the only
            place jobs are read or moved now; JobListPage.tsx/JobDetailPage.tsx
            stay on disk, unported, same as every other row in this list. */}
        <Route path="/jobs" element={<NotYetAvailable title="รายการงาน (เดิม)" />} />
        <Route path="/jobs/:jobId" element={<NotYetAvailable title="รายละเอียดงาน (เดิม)" />} />
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

        <Route path="*" element={<Navigate to="/today" replace />} />
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

function CheckInRoute() {
  const navigate = useNavigate();
  // /jobs/:jobId is closed (see the route list above) and there is no
  // job-detail page to land on. Staff must see the car they just received —
  // "ไม่พบงานนี้" right after a successful save would tell them their work
  // was lost — so this goes to /today instead, carrying the new job's id so
  // the board can find and highlight its card (TodayPage's highlightJobId).
  return (
    <CheckInPage
      onCreated={(jobId) => navigate('/today', { state: { highlightJobId: jobId } })}
    />
  );
}
