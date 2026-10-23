import { defineConfig } from "@playwright/test";
// Browser checks open a production build served by `vite preview`; build it first with
// VITE_BACKEND_URL of a disposable API (tests/live_api.py), never of a shared server.
// PROFKOM_BROWSER is an installed Chromium-based browser: no browser is downloaded.
const port = Number(process.env.PROFKOM_E2E_PORT ?? 49180);
if (port === 15173) throw Error("Port 15173 belongs to the developer stand; pick another free port");
export default defineConfig({
  testDir: "e2e",
  workers: 1,
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    launchOptions: { executablePath: process.env.PROFKOM_BROWSER || undefined },
  },
  projects: [
    { name: "desktop", use: { viewport: { width: 1280, height: 900 } } },
    { name: "mobile", use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
  ],
  webServer: {
    command: `npx vite preview --host 127.0.0.1 --port ${port} --strictPort`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
  },
});
