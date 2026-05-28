import { BrowserRouter, Routes, Route } from "react-router-dom";
import { GreetingPage } from "./pages/Greeting/Greeting";
import "./App.css";
// import { HomePage } from "./pages/Home/HomePage";
import { Layout } from "./components/Layout/Layout";
import { UnderConstructionPage } from "./pages/fallback/UnderConstruction";
import { DocViewerPage } from "./pages/DocViewPage/DocViewerPage";
import { DocEditPage } from "./pages/DocEditPage/DocEditPage";
import { getDocRoute, getDocEditRoute, pages } from "./utils/routes";
import { UserProvider } from "./utils/ctx";
import {
  AdminRoute,
  AuthRoute,
  ProtectedRoute,
} from "./pages/Wrappers/wrappers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ProfilePage } from "./pages/ProfilePage/ProfilePage";
import { AdminPanel } from "./pages/Admin/AdminPage";

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
    <QueryClientProvider client={queryClient}>
      <UserProvider>
        <BrowserRouter>
          <Routes>
            {/* <Route element={<AuthRoute />}> */}
            <Route path="/auth" element={<GreetingPage />} />
            {/* </Route> */}
            <Route element={<ProtectedRoute />}>
              <Route path="/" element={<Layout />}>
                <Route index element={<UnderConstructionPage />} />
                <Route
                  path={getDocRoute()}
                  element={<DocViewerPage />}
                />
                <Route path="/profile" element={<ProfilePage />} />
                <Route element={<AdminRoute />}>
                  <Route path="/admin" element={<AdminPanel />} />
                <Route
                  path={getDocEditRoute()}
                  element={<DocEditPage />}
                />
                </Route>
              </Route>
            </Route>
          </Routes>
        </BrowserRouter>
      </UserProvider>
    </QueryClientProvider>
  );
}

export default App;
