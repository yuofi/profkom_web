import type { QueryClient } from "@tanstack/react-query";
import Cookies from "js-cookie";
import { authApi } from "./api/auth.api";
import { sessionApi } from "./api/session.api";
import { normalizeApiError } from "./api/request";
import { beginAuthTransition } from "./api";

const notSession = (q: { queryKey: readonly unknown[] }) => q.queryKey[0] !== "session";

async function discardPrivateData(client: QueryClient) {
  await client.cancelQueries();
  client.setQueryData(["session"], null);
  client.removeQueries({ predicate: (q) => q.queryKey[0] !== "session" });
  client.getMutationCache().clear();
}

/** The provider loads a profile only after this session is confirmed active. */
export async function completeAuthentication(client: QueryClient, accessToken: string) {
  beginAuthTransition();
  clearAuthNotice();
  await discardPrivateData(client);
  Cookies.set("access_token", accessToken, { expires: 1 / 8 });
  return client.fetchQuery({ queryKey: ["session"], queryFn: sessionApi.get, staleTime: 0 });
}

/** The server ended this session (archive, logout everywhere, an expired refresh): nothing
 *  private stays cached (A-FE-4). Called from the refused session read, which keeps running:
 *  its error routes to the login, and the emptied session stops the profile read. */
export async function handleRevokedSession(client: QueryClient) {
  beginAuthTransition();
  Cookies.remove("access_token");
  await client.cancelQueries({ predicate: notSession });
  client.setQueryData(["session"], null);
  client.removeQueries({ predicate: notSession });
  client.getMutationCache().clear();
}

export async function endSession(client: QueryClient) {
  try {
    await authApi.logout();
  } catch (error) {
    // A rejected/expired session is already signed out; a network failure is not.
    if (normalizeApiError(error).status !== 401) throw error;
  }
  beginAuthTransition();
  Cookies.remove("access_token");
  await discardPrivateData(client);
}

/** A note for the login page after a sign-out on purpose (PE-21): the revoked session
 *  redirects to /auth on its own, so the note waits in the tab's storage, not in the route. */
export interface AuthNotice { notice: string; email: string | null }
const AUTH_NOTICE = "profkom-auth-notice";
/** The note greets this return to the login, not a visit much later in the same tab. */
const AUTH_NOTICE_TTL_MS = 15 * 60 * 1000;
export function leaveAuthNotice(notice: AuthNotice) {
  try { sessionStorage.setItem(AUTH_NOTICE, JSON.stringify({ ...notice, at: Date.now() })); } catch { /* no storage: no note */ }
}
export function peekAuthNotice(): AuthNotice | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(AUTH_NOTICE) ?? "null") as { notice?: unknown; email?: unknown; at?: unknown } | null;
    if (typeof value?.at === "number" && Date.now() - value.at > AUTH_NOTICE_TTL_MS) { clearAuthNotice(); return null; }
    return typeof value?.notice === "string" ? { notice: value.notice, email: typeof value.email === "string" ? value.email : null } : null;
  } catch { return null; }
}
export function clearAuthNotice() {
  try { sessionStorage.removeItem(AUTH_NOTICE); } catch { /* no storage */ }
}
