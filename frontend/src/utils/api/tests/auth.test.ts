//@vitest-enviroment node
import {describe, it, expect, beforeEach} from "vitest"
import {authApi} from "../auth.api"
import Cookies from "js-cookie";
import { logger } from "../../logger";

const generateTestUser = () => ({
    email: `test_${Date.now()}@example.com`,
    password: "password123",
    name: `${Date.now()}_Test_User`,
    surname: "Test",
    patronymic: "User",
    group_number: 107,
    tg: "@ya_daun"
});


describe("Auth API", () => {
    
    let currentUser: ReturnType<typeof generateTestUser>;

    beforeEach(() => {
        Cookies.remove("access_token");
        currentUser = generateTestUser();
    });


    it("should register a user", async () => {
        const response = await authApi.register(currentUser);
        logger.log("data: ", response.data);
        expect([409, 201]).toContain(response.status);
        
    });
    
    it("should get user profile", async () => {
        await authApi.register(currentUser);
        const loginRes = await authApi.login({ 
            email: currentUser.email, 
            password: currentUser.password 
        });
        
        // Устанавливаем токен, чтобы Request Interceptor смог его достать
        Cookies.set("access_token", loginRes.data.access_token);

        const response = await authApi.getMe();
        logger.log("profile data: ", response.data);        
        expect(response.status).toBe(200);
        expect(response.data.email).toBe(currentUser.email);
    });
    })