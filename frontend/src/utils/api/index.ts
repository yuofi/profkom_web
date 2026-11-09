import axios, { AxiosError, type AxiosResponse, type InternalAxiosRequestConfig } from "axios";
import { env } from "../env"
import Cookies from "js-cookie"
import type { RefreshResponse } from "./types";
import { tryCatch } from "../tryCatch";
import { recordApiDiagnostic } from "../diagnostics";

const isDevelopment = env.VITE_ENVIRONMENT === "development";
const prefix = isDevelopment ? `${env.VITE_BACKEND_URL}/api` : "/api";
let authGeneration = 0;
interface CustomAxiosRequestConfig extends InternalAxiosRequestConfig {
    _isRetry?: boolean;
    _authGeneration?: number;
}

/** A read gives up after 20 s; a command waits 60 s, because a slow server may still commit
 *  it and the user must not repeat it blindly (GL-07). */
export const READ_TIMEOUT_MS = 20_000, WRITE_TIMEOUT_MS = 60_000;
export const api = axios.create({
    baseURL: prefix,
    timeout: READ_TIMEOUT_MS,
    withCredentials: true,
    headers: {
        'Content-Type': 'application/json'
    },
})

api.interceptors.response.use(response => {
    recordApiDiagnostic(response.config.method, response.config.url, response.status);
    return response;
}, (error: unknown) => {
    const failure = error as AxiosError;
    recordApiDiagnostic(failure.config?.method, failure.config?.url, failure.response?.status ?? null);
    return Promise.reject(error);
});

/** A file read (responseType "blob") gets its refusal as bytes too: the API's JSON detail is
 *  read back so the error has its code; any other body (a proxy's page) becomes its text. */
api.interceptors.response.use(undefined, async (error: unknown) => {
    const response = (error as AxiosError).response;
    if (response && typeof Blob !== "undefined" && response.data instanceof Blob) {
        try {
            const body = await response.data.text();
            try { response.data = JSON.parse(body); } catch { response.data = body; }
        } catch { /* unreadable: stays a blob */ }
    }
    return Promise.reject(error);
});

api.interceptors.request.use(
    (config) => {
        const tagged = config as CustomAxiosRequestConfig;
        tagged._authGeneration ??= authGeneration;
        if (tagged._authGeneration !== authGeneration)
            throw new axios.CanceledError("Сессия изменилась", config);
        if (!["get", "head", "options"].includes((config.method ?? "get").toLowerCase()))
            config.timeout = Math.max(config.timeout ?? 0, WRITE_TIMEOUT_MS);
        const token = Cookies.get("access_token");
        if (token) {
            config.headers.Authorization = `Bearer ${token}`;
        }
        return config;
    },
    (error) => {
        return Promise.reject(error);
    }
);

/** An address the API gave (/api/files/<id>/content) on the API's own origin: the
 * browser loads it with the session cookie, and the server checks it every time. */
export function apiUrl<T extends string | undefined>(url: T): T {
    return (url?.startsWith("/api/") ? `${api.defaults.baseURL}${url.slice("/api".length)}` : url) as T;
}

let refreshPromise: Promise<void> | null = null;
/** A non-secret hint that this browser signed in before. Without it, the login page does not
 *  try a refresh that cannot succeed (GL-26); everywhere else the refresh is always tried. */
const SIGNED_IN = "profkom-signed-in";
export function rememberSignedIn(signedIn: boolean) {
    try { if (signedIn) localStorage.setItem(SIGNED_IN, "1"); else localStorage.removeItem(SIGNED_IN); } catch { /* storage unavailable */ }
}
const signedInBefore = () => { try { return localStorage.getItem(SIGNED_IN) === "1"; } catch { return true; } };
const onLoginPage = () => typeof window !== "undefined" && /^\/auth(\/|$)/.test(window.location.pathname);
const isSessionRead = (config?: InternalAxiosRequestConfig) => config?.url === "/session";
/** The provider rereads the session when a request shows that access may have changed: a
 *  refused refresh (401, or 403 for a banned or archived account) or a refusal (403/404) of
 *  an ordinary request (GL-06). */
type AccessListener = () => void;
let accessListener: AccessListener | null = null;
export function onAccessChange(listener: AccessListener) {
    accessListener = listener;
    return () => { if (accessListener === listener) accessListener = null; };
}
/** Prevent a prior account's in-flight refresh/response from reviving its session. */
export function beginAuthTransition() {
    authGeneration++;
    refreshPromise = null;
    return authGeneration;
}
export const authSessionGeneration = () => authGeneration;

/** Tabs of one browser share the cookies, so they refresh one at a time (A-ROL-14). */
async function fetchRefresh(): Promise<void> {
    const generation = authGeneration;
    const before = Cookies.get("access_token");
    // Another tab refreshed meanwhile and set its pair: this tab uses it as is.
    const refreshedElsewhere = () => {
        if (generation !== authGeneration) throw new axios.CanceledError("Сессия изменилась");
        const token = Cookies.get("access_token");
        return !!token && token !== before;
    };
    const refresh = async () => {
        if (refreshedElsewhere()) return;
        try {
            const response: AxiosResponse<RefreshResponse> = await axios.post(
                `${prefix}/auth/refresh`,
                {}, // No body needed, refresh token is in httpOnly cookie
                { withCredentials: true }
            );
            if (generation !== authGeneration) throw new axios.CanceledError("Сессия изменилась");
            Cookies.set("access_token", response.data.access_token, {expires: 1/8});
        } catch (error) {
            // A browser without locks: the other tab rotated the token a moment earlier.
            if (!axios.isCancel(error) && refreshedElsewhere()) return;
            throw error;
        }
    };
    const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
    return locks ? locks.request("profkom-auth-refresh", refresh) : refresh();
}

api.interceptors.response.use(
    (response) => {
        if ((response.config as CustomAxiosRequestConfig)._authGeneration !== authGeneration)
            throw new axios.CanceledError("Сессия изменилась", response.config);
        return response;
    },
    async (error: AxiosError) => {
        const originalConfig = error.config as CustomAxiosRequestConfig;
        const generation = originalConfig?._authGeneration ?? authGeneration;
        if (generation !== authGeneration)
            return Promise.reject(new axios.CanceledError("Сессия изменилась", originalConfig));

        if (error.response?.status === 401 && originalConfig && !originalConfig._isRetry
            && !originalConfig.url?.includes('/auth/login')
            && !originalConfig.url?.includes('/auth/refresh')
            && !originalConfig.url?.includes('/auth/vk')
            && !originalConfig.url?.includes('/auth/register')
            && !(isSessionRead(originalConfig) && onLoginPage() && !signedInBefore())
        ) {
            originalConfig._isRetry = true;

            if (!refreshPromise) {
                const pending = fetchRefresh().finally(() => {
                    if (refreshPromise === pending) refreshPromise = null;
                });
                refreshPromise = pending;
            }

            const { error: refreshError } = await tryCatch(refreshPromise);
            
            if (refreshError) {
                if (generation === authGeneration) Cookies.remove("access_token");
                // The session itself is over: the session read reports it on its own.
                if (axios.isAxiosError(refreshError) && [401, 403].includes(refreshError.response?.status ?? 0) && !isSessionRead(originalConfig))
                    accessListener?.();
                return Promise.reject(refreshError);
            }
            
            const token = Cookies.get("access_token");
            if (token && originalConfig.headers) {
                originalConfig.headers.Authorization = `Bearer ${token}`;
            }
            
            return api(originalConfig);
        }
        const status = error.response?.status;
        if ((status === 403 || status === 404) && originalConfig && !isSessionRead(originalConfig) && !originalConfig.url?.startsWith('/auth/'))
            accessListener?.();
        return Promise.reject(error);
    }
);
