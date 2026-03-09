import { BrowserRouter, Routes, Route } from "react-router-dom";
import { GreetingPage } from "./pages/Greeting/Greeting";
import "./App.css";
// import { HomePage } from "./pages/Home/HomePage";
import { Layout } from "./components/Layout/Layout";
import { UnderConstructionPage } from "./pages/fallback/UnderConstruction";
import { DocViewerPage } from "./pages/DocViewPage/DocViewerPage";
import { getDocRoute, pages } from "./utils/routes";

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Layout />}>
          <Route index element={<UnderConstructionPage />} />
          {pages.map((item) => (
            <Route
              key={item.name}
              path={getDocRoute(item.name)}
              element={<DocViewerPage filename={item.name} />}
            />
          ))}
        </Route>
      </Routes>
    </BrowserRouter>
  );
}

export default App;
