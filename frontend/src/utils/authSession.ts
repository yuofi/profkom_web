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
