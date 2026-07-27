import {z} from "zod"

export const zEnv = z.object({
    VITE_BACKEND_URL: z.string().trim().min(1),
    VITE_ENVIRONMENT: z.enum(["development", "production", "test"]),
    VITE_APP_ID: z.string().trim(),
    VITE_REDIRECT_URL: z.string().trim()
});

export const env = zEnv.parse(import.meta.env);