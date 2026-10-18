import { BrowserRouter, Navigate, Routes, Route } from "react-router-dom";
import { HelmetProvider } from "react-helmet-async";
import { lazy, Suspense } from 'react';
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "./App.css";
import { WorkspaceLayout } from './components/Workspace/WorkspaceLayout';
import { WorkspaceStartPage, ComingPage, LeadershipPage } from './pages/Workspace/SessionPages';
import { Loading } from './components/Workspace/WorkspaceUI';
import { EventsListPage, EventPage, SubeventPage } from './pages/Workspace/EventPages';
import { TasksListPage, TaskPage, UnresolvedPage } from './pages/Workspace/TaskPages';
import { SeasonsPage, SeasonPage, SummaryPage } from './pages/Workspace/SeasonPages';
import { MeritsPage, SourcesPage, CorrectionsPage } from './pages/Workspace/MeritPages';
import { ReportsPage, ReportPage, ReportHistoryPage, MeetingPage } from './pages/Workspace/ReportPages';
import { DocViewerPage } from './pages/DocViewPage/DocViewerPage';
import { GreetingPage } from './pages/Greeting/Greeting';
import { InfoPage } from './pages/InfoPage/InfoPage';
import { UserProvider } from './utils/ctx';
import { ProtectedRoute, GuideEditRoute, ExtendedRoute } from './pages/Wrappers/wrappers';
import { ProfilePage } from './pages/ProfilePage/ProfilePage';
import { ProfileEditPage } from './pages/ProfileEditPage/ProfileEditPage';
import { GuidesPage } from './pages/Guides/GuidesPage';
import { PgasPage } from './pages/Pgas/PgasPage';
const AdminPanel = lazy(() => import('./pages/Admin/AdminPage'));
const DocEditPage = lazy(() => import('./pages/DocEditPage/DocEditPage'));
const NotFoundPage = lazy(() => import('./pages/fallback/NotFoundPage'));
const queryClient = new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1 } } });
function App() {
  return <HelmetProvider><QueryClientProvider client={queryClient}><BrowserRouter><Suspense fallback={<Loading />}><UserProvider><Routes>
    <Route path="/auth" element={<GreetingPage />} />
    <Route element={<ProtectedRoute />}><Route path="/" element={<WorkspaceLayout />}>
      <Route index element={<WorkspaceStartPage />} />
      <Route path="profile" element={<ProfilePage />} />
      <Route path="profile/edit" element={<ProfileEditPage />} />
      <Route path="contacts" element={<InfoPage />} />
      <Route path="info" element={<Navigate to="/contacts" replace />} />
      <Route path="guides" element={<GuidesPage />} />
      <Route path="materials" element={<GuidesPage />} />
      <Route path="pgas" element={<PgasPage />} />
      <Route path="docs/:id" element={<DocViewerPage />} />
      <Route element={<GuideEditRoute />}><Route path="docs/:id/edit" element={<DocEditPage />} /></Route>
      <Route path="events" element={<EventsListPage />} />
      <Route path="events/:id" element={<EventPage />} />
      <Route path="subevents/:id" element={<SubeventPage />} />
      <Route path="leadership" element={<LeadershipPage />} />
      <Route path="tasks" element={<TasksListPage />} />
      <Route path="tasks/unresolved" element={<UnresolvedPage />} />
      <Route path="tasks/:id" element={<TaskPage />} />
      <Route path="reports" element={<ReportsPage />} />
      <Route path="reports/history" element={<ReportHistoryPage />} />
      <Route path="reports/:id" element={<ReportPage />} />
      <Route path="meetings/:kind/:id" element={<MeetingPage />} />
      <Route path="seasons" element={<SeasonsPage />} />
      <Route path="seasons/:id" element={<SeasonPage />} />
      <Route path="seasons/:id/summary" element={<SummaryPage />} />
      <Route path="seasons/:id/merits" element={<MeritsPage />} />
      <Route path="seasons/:id/sources" element={<SourcesPage />} />
      <Route path="seasons/:id/corrections" element={<CorrectionsPage />} />
      {['blocks', 'calendar', 'notifications', 'registrations'].map(path => <Route key={path} path={`${path}/*`} element={<ComingPage title={{ blocks: 'Блоки', calendar: 'Календарь', notifications: 'Уведомления', seasons: 'Сезоны и ККР', registrations: 'Регистрации' }[path]!} />} />)}
      <Route element={<ExtendedRoute />}><Route path="admin/:tab" element={<AdminPanel />} /></Route>
    </Route></Route>
    <Route path="*" element={<NotFoundPage />} />
  </Routes></UserProvider></Suspense></BrowserRouter></QueryClientProvider></HelmetProvider>;
}
export default App;
