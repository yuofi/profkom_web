import {api} from "./index"
import type { LoginIn, MeOut, TokenPair, UserIn } from "./types"
import type { AxiosResponse } from "axios";

async function register(userData: UserIn): Promise<AxiosResponse<TokenPair>> {
    // const {data, error} = await tryCatch(api.post("/auth/register", userData));
    // if (error) {
    //     throw error;
    // }
    // return data;
    return api.post("/auth/register", userData);
}  

async function login(userData: LoginIn): Promise<AxiosResponse<TokenPair>> {
    // const {data, error} = await tryCatch(api.post("/auth/login", userData));
    // // logger.log("data: ", data?.data);
    // if (error) {
    //     throw error;
    // }
    // return data;
    return api.post("/auth/login", userData);
}

async function getMe(): Promise<AxiosResponse<MeOut>> {
    // const {data, error} = await tryCatch(api.get("/profile/me"));
    // if (error) {
    //     throw error;
    // }
    // return data; 
    return api.get("/profile/me");
}

async function vkLogin(data: { access_token: string, id_token?: string }): Promise<AxiosResponse<TokenPair>> {
    return api.post("/auth/vk", data);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function changePassword(data: { old_password: string, new_password: string }): Promise<AxiosResponse<any>> {
    return api.post("/auth/change-password", data);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function logout(): Promise<AxiosResponse<any>> {
    return api.post("/auth/logout");
}

export const authApi = {
    register,
    login,
    getMe,
    vkLogin,
    changePassword,
    logout
};