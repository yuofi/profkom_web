import { BrowserRouter, Navigate, Routes, Route } from "react-router-dom";
import { HelmetProvider } from "react-helmet-async";
import { lazy, Suspense } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "./App.css";
import { WorkspaceLayout } from "./components/Workspace/WorkspaceLayout";
import { LeadershipPage } from "./pages/Workspace/SessionPages";
import { Loading } from "./components/Workspace/WorkspaceUI";
const EventsListPage = lazy(() =>
  import("./pages/Workspace/EventPages").then((m) => ({
    default: m.EventsListPage,
  })),
);
const EventPage = lazy(() =>
  import("./pages/Workspace/EventPages").then((m) => ({
    default: m.EventPage,
  })),
);
const SubeventPage = lazy(() =>
  import("./pages/Workspace/EventPages").then((m) => ({
    default: m.SubeventPage,
  })),
);
const TasksListPage = lazy(() =>
  import("./pages/Workspace/TaskPages").then((m) => ({
    default: m.TasksListPage,
  })),
);
const TaskPage = lazy(() =>
  import("./pages/Workspace/TaskPages").then((m) => ({ default: m.TaskPage })),
);
const UnresolvedPage = lazy(() =>
  import("./pages/Workspace/TaskPages").then((m) => ({
    default: m.UnresolvedPage,
  })),
);
const DirectoryPage = lazy(() =>
  import("./pages/Workspace/DirectoryPages").then((m) => ({
    default: m.DirectoryPage,
  })),
);
const FormerContactsPage = lazy(() =>
  import("./pages/Workspace/DirectoryPages").then((m) => ({
    default: m.FormerContactsPage,
  })),
);
const AccountArchivePage = lazy(() =>
  import("./pages/Workspace/DirectoryPages").then((m) => ({
    default: m.AccountArchivePage,
  })),
);
const MaterialsPage = lazy(() =>
  import("./pages/Workspace/MaterialPages").then((m) => ({
    default: m.MaterialsPage,
  })),
);
const MaterialPage = lazy(() =>
  import("./pages/Workspace/MaterialPages").then((m) => ({
    default: m.MaterialPage,
  })),
);
const BlocksPage = lazy(() =>
  import("./pages/Workspace/MembershipPages").then((m) => ({
    default: m.BlocksPage,
  })),
);
const BlockPage = lazy(() =>
  import("./pages/Workspace/MembershipPages").then((m) => ({
    default: m.BlockPage,
  })),
);
const BlockRequestsPage = lazy(() =>
  import("./pages/Workspace/MembershipPages").then((m) => ({
    default: m.BlockRequestsPage,
  })),
);
const RegistrationsPage = lazy(() =>
  import("./pages/Workspace/MembershipPages").then((m) => ({
    default: m.RegistrationsPage,
  })),
);
const DashboardPage = lazy(() =>
  import("./pages/Workspace/WorkspacePages").then((m) => ({
    default: m.DashboardPage,
  })),
);
const CalendarPage = lazy(() =>
  import("./pages/Workspace/WorkspacePages").then((m) => ({
    default: m.CalendarPage,
  })),
);
const NotificationsPage = lazy(() =>
  import("./pages/Workspace/WorkspacePages").then((m) => ({
    default: m.NotificationsPage,
  })),
);
const SeasonsPage = lazy(() =>
  import("./pages/Workspace/SeasonPages").then((m) => ({
    default: m.SeasonsPage,
  })),
);
const SeasonPage = lazy(() =>
  import("./pages/Workspace/SeasonPages").then((m) => ({
    default: m.SeasonPage,
  })),
);
const SummaryPage = lazy(() =>
  import("./pages/Workspace/SeasonPages").then((m) => ({
    default: m.SummaryPage,
  })),
);
const MeritsPage = lazy(() =>
  import("./pages/Workspace/MeritPages").then((m) => ({
    default: m.MeritsPage,
  })),
);
const MeritEntryPage = lazy(() => import("./pages/Workspace/MeritPages").then((m) => ({ default: m.MeritEntryPage })));
const SourcesPage = lazy(() =>
  import("./pages/Workspace/MeritPages").then((m) => ({
    default: m.SourcesPage,
  })),
);
const CorrectionsPage = lazy(() =>
  import("./pages/Workspace/MeritPages").then((m) => ({
    default: m.CorrectionsPage,
  })),
);
const ReportsPage = lazy(() =>
  import("./pages/Workspace/ReportPages").then((m) => ({
    default: m.ReportsPage,
  })),
);
const ReportPage = lazy(() =>
  import("./pages/Workspace/ReportPages").then((m) => ({
    default: m.ReportPage,
  })),
);
const ReportHistoryPage = lazy(() =>
  import("./pages/Workspace/ReportPages").then((m) => ({
    default: m.ReportHistoryPage,
  })),
);
const MeetingPage = lazy(() =>
  import("./pages/Workspace/ReportPages").then((m) => ({
    default: m.MeetingPage,
  })),
);
import { DocViewerPage } from "./pages/DocViewPage/DocViewerPage";
import { GreetingPage } from "./pages/Greeting/Greeting";
import { UserProvider } from "./utils/ctx";
import { retryTransient, workspaceQueryCache } from "./utils/api/invalidation";
import {
  ProtectedRoute,
  GuideEditRoute,
  ExtendedRoute,
} from "./pages/Wrappers/wrappers";
import { ProfilePage } from "./pages/ProfilePage/ProfilePage";
import { ProfileEditPage } from "./pages/ProfileEditPage/ProfileEditPage";
import { GuidesPage } from "./pages/Guides/GuidesPage";
import { PgasPage } from "./pages/Pgas/PgasPage";
const AdminPanel = lazy(() => import("./pages/Admin/AdminPage"));
const DocEditPage = lazy(() => import("./pages/DocEditPage/DocEditPage"));
const NotFoundPage = lazy(() => import("./pages/fallback/NotFoundPage"));
const queryClient = new QueryClient({
  queryCache: workspaceQueryCache(),
  defaultOptions: { queries: { refetchOnWindowFocus: false, retry: retryTransient } },
});
function App() {
  return (
    <HelmetProvider>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <Suspense fallback={<Loading />}>
            <UserProvider>
              <Routes>
                <Route path="/auth" element={<GreetingPage />} />
                <Route element={<ProtectedRoute />}>
                  <Route path="/" element={<WorkspaceLayout />}>
                    <Route index element={<DashboardPage />} />
                    <Route path="profile" element={<ProfilePage />} />
                    <Route path="profile/edit" element={<ProfileEditPage />} />
                    <Route path="contacts" element={<DirectoryPage />} />
                    <Route
                      path="contacts/former"
                      element={<FormerContactsPage />}
                    />
                    <Route
                      path="accounts/archive"
                      element={<AccountArchivePage />}
                    />
                    <Route
                      path="info"
                      element={<Navigate to="/contacts" replace />}
                    />
                    <Route path="guides" element={<GuidesPage />} />
                    <Route path="materials" element={<MaterialsPage />} />
                    <Route path="materials/:id" element={<MaterialPage />} />
                    <Route path="pgas" element={<PgasPage />} />
                    <Route path="docs/:id" element={<DocViewerPage />} />
                    <Route element={<GuideEditRoute />}>
                      <Route path="docs/:id/edit" element={<DocEditPage />} />
                    </Route>
                    <Route path="events" element={<EventsListPage />} />
                    <Route path="events/:id" element={<EventPage />} />
                    <Route path="subevents/:id" element={<SubeventPage />} />
                    <Route path="leadership" element={<LeadershipPage />} />
                    <Route path="tasks" element={<TasksListPage />} />
                    <Route
                      path="tasks/unresolved"
                      element={<UnresolvedPage />}
                    />
                    <Route path="tasks/:id" element={<TaskPage />} />
                    <Route path="reports" element={<ReportsPage />} />
                    <Route
                      path="reports/history"
                      element={<ReportHistoryPage />}
                    />
                    <Route path="reports/:id" element={<ReportPage />} />
                    <Route
                      path="meetings/:kind/:id"
                      element={<MeetingPage />}
                    />
                    <Route path="seasons" element={<SeasonsPage />} />
                    <Route path="seasons/:id" element={<SeasonPage />} />
                    <Route
                      path="seasons/:id/summary"
                      element={<SummaryPage />}
                    />
                    <Route path="seasons/:id/merits" element={<MeritsPage />} />
                    <Route path="merits" element={<MeritEntryPage />} />
                    <Route
                      path="seasons/:id/sources"
                      element={<SourcesPage />}
                    />
                    <Route
                      path="seasons/:id/corrections"
                      element={<CorrectionsPage />}
                    />
                    <Route path="calendar" element={<CalendarPage />} />
                    <Route
                      path="notifications"
                      element={<NotificationsPage />}
                    />
                    <Route path="blocks" element={<BlocksPage />} />
                    <Route
                      path="blocks/requests"
                      element={<BlockRequestsPage />}
                    />
                    <Route path="blocks/:id" element={<BlockPage />} />
                    <Route
                      path="registrations"
                      element={<RegistrationsPage />}
                    />
                    <Route element={<ExtendedRoute />}>
                      <Route path="admin/:tab" element={<AdminPanel />} />
                    </Route>
                  </Route>
                </Route>
                <Route path="*" element={<NotFoundPage />} />
              </Routes>
            </UserProvider>
          </Suspense>
        </BrowserRouter>
      </QueryClientProvider>
    </HelmetProvider>
  );
}
export default App;
