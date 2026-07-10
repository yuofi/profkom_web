import { defineConfig } from 'vitest/config'


export default defineConfig({
  test: {
    setupFiles: ["./src/utils/api/tests/setupTests.ts"],
    //environment: "jsdom",
    env: {
      VITE_BACKEND_URL: "http://127.0.0.1:8000",
    }  
  },
});

