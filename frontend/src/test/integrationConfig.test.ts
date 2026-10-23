import { afterEach, expect, it, vi } from "vitest";

const load = () => import("../../vitest.integration.config");
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

it.each([
  ["no target at all", "", ""],
  ["a target without the nonce printed by live_api", "http://127.0.0.1:49999", ""],
  ["the nonce without a target, so the old 18000 default cannot return", "", "x"],
])("the destructive suite does not start with %s", async (_name, origin, nonce) => {
  vi.stubEnv("PROFKOM_TEST_API_ORIGIN", origin);
  vi.stubEnv("PROFKOM_TEST_API_NONCE", nonce);
  await expect(load()).rejects.toThrow("require PROFKOM_TEST_API_ORIGIN and PROFKOM_TEST_API_NONCE");
});

it("the destructive suite refuses a non-local target", async () => {
  vi.stubEnv("PROFKOM_TEST_API_ORIGIN", "https://profkom.example.com");
  vi.stubEnv("PROFKOM_TEST_API_NONCE", "x");
  await expect(load()).rejects.toThrow("disposable localhost API");
});

it("the suite checks the nonce before its first test", async () => {
  vi.stubEnv("PROFKOM_TEST_API_ORIGIN", "http://127.0.0.1:49999");
  vi.stubEnv("PROFKOM_TEST_API_NONCE", "x");
  const config = (await load()).default;
  expect(config.test?.globalSetup).toEqual(["./src/test/integrationGlobalSetup.ts"]);
  expect(config.test?.env?.VITE_BACKEND_URL).toBe("http://127.0.0.1:49999");
});
