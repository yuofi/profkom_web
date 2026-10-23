import { afterEach, describe, expect, it, vi } from "vitest";
import verifyDisposableApi from "./integrationGlobalSetup";

const origin = "http://127.0.0.1:49999";
function serve(response: () => Promise<Response>) {
  const fetch = vi.fn<(url: URL) => Promise<Response>>(() => response());
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("integration suite gate", () => {
  it("refuses to start without both values printed by live_api", async () => {
    const fetch = serve(async () => Response.json({ nonce: "x" }));
    vi.stubEnv("PROFKOM_TEST_API_ORIGIN", origin);
    vi.stubEnv("PROFKOM_TEST_API_NONCE", "");
    await expect(verifyDisposableApi()).rejects.toThrow("are required");
    vi.stubEnv("PROFKOM_TEST_API_ORIGIN", "");
    vi.stubEnv("PROFKOM_TEST_API_NONCE", "x");
    await expect(verifyDisposableApi()).rejects.toThrow("are required");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses a server that is not reachable", async () => {
    serve(async () => { throw TypeError("fetch failed"); });
    vi.stubEnv("PROFKOM_TEST_API_ORIGIN", origin);
    vi.stubEnv("PROFKOM_TEST_API_NONCE", "expected");
    await expect(verifyDisposableApi()).rejects.toThrow(`Cannot reach the integration API at ${origin}`);
  });

  it.each([
    ["serves another nonce", () => Response.json({ nonce: "other" })],
    ["has no nonce route, like the developer stand", () => new Response("Not Found", { status: 404 })],
    ["answers with something else", () => Response.json({})],
  ])("refuses a server that %s", async (_name, reply) => {
    serve(async () => reply());
    vi.stubEnv("PROFKOM_TEST_API_ORIGIN", origin);
    vi.stubEnv("PROFKOM_TEST_API_NONCE", "expected");
    await expect(verifyDisposableApi()).rejects.toThrow("is not the disposable API started with this nonce");
  });

  it("accepts the API that serves the same nonce", async () => {
    const fetch = serve(async () => Response.json({ nonce: "expected" }));
    vi.stubEnv("PROFKOM_TEST_API_ORIGIN", origin);
    vi.stubEnv("PROFKOM_TEST_API_NONCE", "expected");
    await expect(verifyDisposableApi()).resolves.toBeUndefined();
    expect(String(fetch.mock.calls[0][0])).toBe(`${origin}/_test/integration-nonce`);
  });
});
