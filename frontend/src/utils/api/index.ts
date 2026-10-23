import axios, { AxiosError, type AxiosResponse, type InternalAxiosRequestConfig } from "axios";
import { env } from "../env"
import Cookies from "js-cookie"
import type { RefreshResponse } from "./types";
import { tryCatch } from "../tryCatch";

const isDevelopment = env.VITE_ENVIRONMENT === "development";
const prefix = isDevelopment ? `${env.VITE_BACKEND_URL}/api` : "/api";
let authGeneration = 0;
interface CustomAxiosRequestConfig extends InternalAxiosRequestConfig {
    _isRetry?: boolean;
    _authGeneration?: number;
}

export const api = axios.create({
    baseURL: prefix,
    timeout: 10000,
    withCredentials: true,
    headers: {
        'Content-Type': 'application/json'
    },
})

api.interceptors.request.use(
    (config) => {
        const tagged = config as CustomAxiosRequestConfig;
        tagged._authGeneration ??= authGeneration;
        if (tagged._authGeneration !== authGeneration)
            throw new axios.CanceledError("Сессия изменилась", config);
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

let refreshPromise: Promise<void> | null = null;
/** Prevent a prior account's in-flight refresh/response from reviving its session. */
export function beginAuthTransition() {
    authGeneration++;
    refreshPromise = null;
}

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
                return Promise.reject(refreshError);
            }
            
            const token = Cookies.get("access_token");
            if (token && originalConfig.headers) {
                originalConfig.headers.Authorization = `Bearer ${token}`;
            }
            
            return api(originalConfig);
        }
        return Promise.reject(error);
    }
);
