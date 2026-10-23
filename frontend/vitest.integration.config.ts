import { defineConfig, mergeConfig } from "vitest/config";
import base from "./vitest.config";
// The suite irreversibly changes data (it closes seasons), so it never picks a default target.
// Start `python tests/live_api.py --integration-suite --port <free port>` and pass both values it prints.
const origin = process.env.PROFKOM_TEST_API_ORIGIN;
if (!origin || !process.env.PROFKOM_TEST_API_NONCE)
  throw Error("Integration tests require PROFKOM_TEST_API_ORIGIN and PROFKOM_TEST_API_NONCE of a disposable API started with tests/live_api.py --integration-suite");
if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(origin).hostname))
  throw Error("Integration tests require a disposable localhost API");
const config = mergeConfig(base, defineConfig({
  test: {
    include: ["**/*.integration.test.{ts,tsx}"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    globalSetup: ["./src/test/integrationGlobalSetup.ts"],
    env: { VITE_BACKEND_URL: origin, VITE_ENVIRONMENT: "development" },
    environmentOptions: { jsdom: { url: "http://localhost:15173" } },
    fileParallelism: false,
    testTimeout: 30000,
  },
}));
if (config.test) config.test.exclude = ["**/node_modules/**", "**/dist/**"];
export default config;
