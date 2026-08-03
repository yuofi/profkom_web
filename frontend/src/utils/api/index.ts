import axios, { AxiosError, type AxiosResponse, type InternalAxiosRequestConfig } from "axios";
import { env } from "../env"
import Cookies from "js-cookie"
import type { RefreshResponse } from "./types";
import { tryCatch } from "../tryCatch";

const isDevelopment = env.VITE_ENVIRONMENT === "development";
const prefix = isDevelopment ? `${env.VITE_BACKEND_URL}/api` : "/api";

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

interface CustomAxiosRequestConfig extends InternalAxiosRequestConfig {
    _isRetry?: boolean;
}

let refreshPromise: Promise<void> | null = null;

async function fetchRefresh(): Promise<void> {
    const response: AxiosResponse<RefreshResponse> = await axios.post(
        `${prefix}/auth/refresh`,
        {},
        { withCredentials: true }
    );

    Cookies.set("access_token", response.data.access_token, {expires: 1/8});
}

api.interceptors.response.use(
    (response) => response,
    async (error: AxiosError) => {
        const originalConfig = error.config as CustomAxiosRequestConfig;

        if (error.response?.status === 401 && !originalConfig._isRetry 
            && !originalConfig.url?.includes('/auth/login')
            && !originalConfig.url?.includes('/auth/refresh')
            && !originalConfig.url?.includes('/auth/vk')
            && !originalConfig.url?.includes('/auth/register')
        ) {
            originalConfig._isRetry = true;

            if (!refreshPromise) {
                refreshPromise = fetchRefresh().finally(() => {
                    refreshPromise = null;
                });
            }

            const { error: refreshError } = await tryCatch(refreshPromise);
            
            if (refreshError) {
                Cookies.remove("access_token");
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