import type { QueryClient } from "@tanstack/react-query";
import Cookies from "js-cookie";
import { authApi } from "./api/auth.api";
import { sessionApi } from "./api/session.api";
import { normalizeApiError } from "./api/request";

async function discardPrivateData(client: QueryClient) {
  await client.cancelQueries();
  client.setQueryData(["session"], null);
  client.removeQueries({ predicate: (q) => q.queryKey[0] !== "session" });
  client.getMutationCache().clear();
}

/** The provider loads a profile only after this session is confirmed active. */
export async function completeAuthentication(client: QueryClient, accessToken: string) {
  await discardPrivateData(client);
  Cookies.set("access_token", accessToken, { expires: 1 / 8 });
  return client.fetchQuery({ queryKey: ["session"], queryFn: sessionApi.get, staleTime: 0 });
}

export async function endSession(client: QueryClient) {
  try {
    await authApi.logout();
  } catch (error) {
    // A rejected/expired session is already signed out; a network failure is not.
    if (normalizeApiError(error).status !== 401) throw error;
  }
  Cookies.remove("access_token");
  await discardPrivateData(client);
}
