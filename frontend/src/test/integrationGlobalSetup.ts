/** Refuses to run the destructive integration suite against anything but the API started for it. */
export default async function verifyDisposableApi() {
  const origin = process.env.PROFKOM_TEST_API_ORIGIN;
  const nonce = process.env.PROFKOM_TEST_API_NONCE;
  if (!origin || !nonce) throw Error("PROFKOM_TEST_API_ORIGIN and PROFKOM_TEST_API_NONCE are required");
  let served: unknown;
  try {
    const response = await fetch(new URL("/_test/integration-nonce", origin));
    served = response.ok ? ((await response.json()) as { nonce?: unknown }).nonce : undefined;
  } catch (error) {
    throw Error(`Cannot reach the integration API at ${origin}: ${String(error)}`);
  }
  if (served !== nonce)
    throw Error(`${origin} is not the disposable API started with this nonce (tests/live_api.py --integration-suite)`);
}
