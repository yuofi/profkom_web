import {api} from "./index"
import type { LoginIn, TokenPair, UserIn, UserOut } from "./types"
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
    // // console.log("data: ", data?.data);
    // if (error) {
    //     throw error;
    // }
    // return data;
    return api.post("/auth/login", userData);
}

async function getMe(): Promise<AxiosResponse<UserOut>> {
    // const {data, error} = await tryCatch(api.get("/profile/me"));
    // if (error) {
    //     throw error;
    // }
    // return data; 
    return api.get("/profile/me");
}

export const authApi = {
    register,
    login,
    getMe
};