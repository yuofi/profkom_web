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

async function fetchRefresh(config: CustomAxiosRequestConfig): Promise<CustomAxiosRequestConfig> {
    const refreshToken = Cookies.get("refresh_token");
    if (!refreshToken) throw new Error("No refresh token found");
    const response: AxiosResponse<RefreshResponse> = await axios.post(`${env.VITE_BACKEND_URL}/api/auth/refresh`, {
        refresh_token: refreshToken
    });

    Cookies.set("access_token", response.data.access_token, {expires: 1/8});
    Cookies.set("refresh_token", response.data.refresh_token, {expires: 7});

    if (config.headers) {
        config.headers.Authorization = `Bearer ${response.data.access_token}`;
    }

    return config;
}

api.interceptors.response.use(
    (response) => response,
    async (error: AxiosError) => {
        const originalConfig = error.config as CustomAxiosRequestConfig;

        if (error.response?.status === 401 && !originalConfig._isRetry 
            && !originalConfig.url?.includes('/auth/login')) {
            originalConfig._isRetry = true;
            const { data, error } = await tryCatch(fetchRefresh(originalConfig));
            if (error) {
                Cookies.remove("access_token");
                Cookies.remove("refresh_token");
                //window.location.href = "/login";
                return Promise.reject(error);
            }
            
            return api(data);
        }
        return Promise.reject(error);
    }
);