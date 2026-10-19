import { defineConfig, mergeConfig } from "vitest/config";
import base from "./vitest.config";
const origin = process.env.PROFKOM_TEST_API_ORIGIN ?? "http://127.0.0.1:18000";
if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(origin).hostname))
  throw Error("Integration tests require a disposable localhost API");
const config = mergeConfig(base, defineConfig({
  test: {
    include: ["**/*.integration.test.{ts,tsx}"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    env: { VITE_BACKEND_URL: origin, VITE_ENVIRONMENT: "development" },
    environmentOptions: { jsdom: { url: "http://localhost:15173" } },
    fileParallelism: false,
    testTimeout: 30000,
  },
}));
if (config.test) config.test.exclude = ["**/node_modules/**", "**/dist/**"];
export default config;
