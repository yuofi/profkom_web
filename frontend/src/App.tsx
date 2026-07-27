import { BrowserRouter, Routes, Route } from "react-router-dom";
import { HelmetProvider } from "react-helmet-async";
import { lazy, Suspense } from 'react';
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "./App.css";
// import { HomePage } from "./pages/Home/HomePage";
import { Layout } from "./components/Layout/Layout";
import { UnderConstructionPage } from "./pages/fallback/UnderConstruction";
import { DocViewerPage } from "./pages/DocViewPage/DocViewerPage";
import { GreetingPage } from "./pages/Greeting/Greeting";
import { InfoPage } from "./pages/InfoPage/InfoPage";
import { getDocRoute, getDocEditRoute } from "./utils/routes";
import { UserProvider } from "./utils/ctx";
import { ExtendedRoute, ProtectedRoute } from "./pages/Wrappers/wrappers";
import { ProfilePage } from "./pages/ProfilePage/ProfilePage";
import { ProfileEditPage } from "./pages/ProfileEditPage/ProfileEditPage";
// import { AdminPanel } from "./pages/Admin/AdminPage";
const AdminPanel = lazy(() => import("./pages/Admin/AdminPage"))
const DocEditPage = lazy(() => import("./pages/DocEditPage/DocEditPage"))
const NotFoundPage = lazy(() => import("./pages/fallback/NotFoundPage"))


const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

function App() {
  return (
    <HelmetProvider>
      <QueryClientProvider client={queryClient}>
        <Suspense fallback={<div>Загрузка страницы...</div>}>
        <UserProvider>
          <BrowserRouter>
            <Routes>
              {/* <Route element={<AuthRoute />}> */}
              <Route path="/auth" element={<GreetingPage />} />
              {/* </Route> */}
              <Route element={<ProtectedRoute />}>
                <Route path="/" element={<Layout />}>
                  <Route index element={<UnderConstructionPage />} />
                  <Route path={getDocRoute()} element={<DocViewerPage />} />
                  <Route path="/info" element={<InfoPage />} />
                  <Route path="/profile" element={<ProfilePage />} />
                  <Route element={<ExtendedRoute allowedRoles={[]} />}>
                    <Route path={getDocEditRoute()} element={<DocEditPage />} />
                  </Route>
                  <Route path="/profile/edit" element={<ProfileEditPage />} />
                </Route>

                <Route element={<ExtendedRoute allowedRoles={["admin"]} />}>
                  <Route path="/admin" element={<AdminPanel />} />
                </Route>
              </Route>
              <Route path="*" element={<NotFoundPage />} />
            </Routes>
          </BrowserRouter>
        </UserProvider>
        </Suspense>
      </QueryClientProvider>
    </HelmetProvider>
  );
}

export default App;
