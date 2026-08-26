import { Navigate, Outlet, Route, Routes, useNavigate } from 'react-router-dom';
import type { User } from 'firebase/auth';
import { useAuth, type Role } from './hooks/useAuth';
import { useOnlineStatus } from './hooks/useOnlineStatus';
import { LoginPage } from './routes/auth/LoginPage';
import { FinancePage } from './routes/finance/FinancePage';
import { JobListPage } from './routes/jobs/JobListPage';
import { JobDetailPage } from './routes/jobs/JobDetailPage';
import { CheckInPage } from './routes/checkin/CheckInPage';
import { ModelsPage } from './routes/catalog/ModelsPage';
import { ModelDetailPage } from './routes/catalog/ModelDetailPage';
import { MasterPartsPage } from './routes/catalog/MasterPartsPage';
import { BoardPage } from './routes/board/BoardPage';
import { LookupPage } from './routes/lookup/LookupPage';
import { AppShell } from './components/AppShell';
import { HomeLauncherPage } from './routes/home/HomeLauncherPage';
import { CalendarPage } from './routes/calendar/CalendarPage';
import { SettingsPage } from './routes/settings/SettingsPage';
import { UsersPage } from './routes/settings/UsersPage';
import { TechniciansPage } from './routes/settings/TechniciansPage';
import { TrashPage } from './routes/settings/TrashPage';
import { DeliveredPage } from './routes/delivered/DeliveredPage';
import { RejectedPage } from './routes/rejected/RejectedPage';
import { WarrantyPage } from './routes/warranty/WarrantyPage';
import { AiAssistantPage } from './routes/ai/AiAssistantPage';

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

  if (auth.loading) {
    return <div className="page-loading">กำลังโหลด...</div>;
  }

  if (!auth.user) {
    return <LoginPage />;
  }

  return (
    <Routes>
      {/* Home Launcher is its own full-screen surface (post-login app picker),
          shown without the sidebar/top-bar shell — that shell is for the staff
          console itself, not for choosing which surface to enter. */}
      <Route path="/" element={<HomeLauncherPage />} />
      <Route element={<ShellLayout user={auth.user} role={auth.role} online={online} />}>
        <Route path="/jobs" element={<JobListRoute />} />
        <Route path="/jobs/:jobId" element={<JobDetailPage />} />
        <Route path="/checkin" element={<CheckInRoute />} />
        <Route path="/finance" element={<FinancePage />} />
        <Route path="/models" element={<ModelsPage />} />
        <Route path="/models/:modelId" element={<ModelDetailPage />} />
        <Route path="/master-parts" element={<MasterPartsPage />} />
        <Route path="/delivered" element={<DeliveredPage />} />
        <Route path="/rejected" element={<RejectedPage />} />
        <Route path="/warranty" element={<WarrantyPage />} />
        <Route path="/calendar" element={<CalendarPage />} />
        <Route path="/ai" element={<AiAssistantPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/settings/users" element={<UsersPage />} />
        <Route path="/settings/technicians" element={<TechniciansPage />} />
        <Route path="/settings/trash" element={<TrashPage />} />
        <Route path="*" element={<Navigate to="/jobs" replace />} />
      </Route>
    </Routes>
  );
}

function ShellLayout({ user, role, online }: { user: User; role: Role | null; online: boolean }) {
  return (
    <AppShell user={user} role={role} online={online}>
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
