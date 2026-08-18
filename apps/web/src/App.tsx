import { Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { useAuth } from './hooks/useAuth';
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
import { AppShell } from './components/AppShell';

// /board is public (the waiting-room display) and must never require login — it's
// matched before the authed catch-all below, so it never touches useAuth at all.
export function App() {
  return (
    <Routes>
      <Route path="/board" element={<BoardPage />} />
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
    <AppShell user={auth.user} role={auth.role} online={online}>
      <Routes>
        <Route path="/" element={<Navigate to="/jobs" replace />} />
        <Route path="/jobs" element={<JobListRoute />} />
        <Route path="/jobs/:jobId" element={<JobDetailPage />} />
        <Route path="/checkin" element={<CheckInRoute />} />
        <Route path="/finance" element={<FinancePage />} />
        <Route path="/models" element={<ModelsPage />} />
        <Route path="/models/:modelId" element={<ModelDetailPage />} />
        <Route path="/master-parts" element={<MasterPartsPage />} />
        <Route path="*" element={<Navigate to="/jobs" replace />} />
      </Routes>
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
