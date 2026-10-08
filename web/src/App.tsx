import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { I18nProvider } from './i18n';
import { SessionProvider, useSession } from './session';
import { Shell } from './components/shell';
import { Loading, ReauthGate, ToastProvider } from './components/ui';
import { Invite, SignIn, WorkspaceGate } from './pages/auth';
import { Dashboard } from './pages/dashboard';
import { CrewChangeDetail, CrewChangeList } from './pages/crewchanges';
import { RequestDetail, RequestList } from './pages/requests';
import { Communications, MessageView, PackageReview } from './pages/communications';
import { PersonnelDetail, PersonnelList, Readiness, Rotation } from './pages/people';
import { Calendar, Tasks } from './pages/work';
import { Admin, Settings } from './pages/admin';
import { Assistant, Suppliers, Templates } from './pages/config';

function Protected() {
  const { me, loading } = useSession();
  const loc = useLocation();
  if (loading) return <div className="content"><Loading rows={5} /></div>;
  if (!me) return <Navigate to={`/signin?returnTo=${encodeURIComponent(loc.pathname + loc.search)}`} replace />;
  if (!me.activeOrg || me.orgBlock) return <WorkspaceGate />;
  return (
    <Shell>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/crew-changes" element={<CrewChangeList />} />
        <Route path="/crew-changes/:id" element={<CrewChangeDetail />} />
        <Route path="/requests" element={<RequestList />} />
        <Route path="/requests/:id" element={<RequestDetail />} />
        <Route path="/communications" element={<Communications />} />
        <Route path="/communications/packages/:id" element={<PackageReview />} />
        <Route path="/communications/messages/:id" element={<MessageView />} />
        <Route path="/personnel" element={<PersonnelList />} />
        <Route path="/personnel/:id" element={<PersonnelDetail />} />
        <Route path="/readiness" element={<Readiness />} />
        <Route path="/rotation" element={<Rotation />} />
        <Route path="/calendar" element={<Calendar />} />
        <Route path="/tasks" element={<Tasks />} />
        <Route path="/assistant" element={<Assistant />} />
        <Route path="/suppliers" element={<Suppliers />} />
        <Route path="/templates" element={<Templates />} />
        <Route path="/admin" element={<Admin />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/settings/:section" element={<Settings />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Shell>
  );
}

export function App() {
  return (
    <I18nProvider>
      <ToastProvider>
        <BrowserRouter>
          <SessionProvider>
            <ReauthGate />
            <Routes>
              <Route path="/signin" element={<SignIn />} />
              <Route path="/invite/:token" element={<Invite />} />
              <Route path="/*" element={<Protected />} />
            </Routes>
          </SessionProvider>
        </BrowserRouter>
      </ToastProvider>
    </I18nProvider>
  );
}
