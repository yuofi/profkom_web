import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    setupFiles: ['./src/utils/api/tests/setupTests.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.integration.test.{ts,tsx}', 'e2e/**'],
    env: { VITE_BACKEND_URL: 'http://127.0.0.1:8000', VITE_ENVIRONMENT: 'development', VITE_APP_ID: 'test', VITE_REDIRECT_URL: 'http://localhost:5173/auth', VITE_DEMO_MODE: 'false' },
  },
});

