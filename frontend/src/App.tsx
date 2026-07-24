import { BrowserRouter, Routes, Route } from "react-router-dom";
import { GreetingPage } from "./pages/Greeting/Greeting";
import "./App.css";
// import { HomePage } from "./pages/Home/HomePage";
import { Layout } from "./components/Layout/Layout";
import { UnderConstructionPage } from "./pages/fallback/UnderConstruction";
import {NotFoundPage} from "./pages/fallback/NotFoundPage"
import { DocViewerPage } from "./pages/DocViewPage/DocViewerPage";
import { DocEditPage } from "./pages/DocEditPage/DocEditPage";
import { InfoPage } from "./pages/InfoPage/InfoPage";
import { getDocRoute, getDocEditRoute } from "./utils/routes";
import { UserProvider } from "./utils/ctx";
import { ExtendedRoute, ProtectedRoute } from "./pages/Wrappers/wrappers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ProfilePage } from "./pages/ProfilePage/ProfilePage";
import { AdminPanel } from "./pages/Admin/AdminPage";
import { ProfileEditPage } from "./pages/ProfileEditPage/ProfileEditPage";

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
                <Route path={getDocRoute()} element={<DocViewerPage />} />
                <Route path="/info" element={<InfoPage />} />
                <Route path="/profile" element={<ProfilePage />} />
                <Route element={<ExtendedRoute allowedRoles={[]}/>}>
                  <Route path={getDocEditRoute()} element={<DocEditPage />} />
                </Route>
                <Route path="/profile/edit" element={<ProfileEditPage />}/>
              </Route>

              <Route element={<ExtendedRoute allowedRoles={["admin"]}/>}>
                <Route path="/admin" element={<AdminPanel />} />
              </Route>
            </Route>
          <Route path="*" element={<NotFoundPage />} />
          </Routes>
        </BrowserRouter>
      </UserProvider>
    </QueryClientProvider>
  );
}

export default App;
