import { defineConfig, mergeConfig } from 'vitest/config';
import base from './vitest.config';
export default mergeConfig(base, defineConfig({ test: { include: ['**/*.integration.test.ts'], exclude: ['**/node_modules/**', '**/dist/**'] } }));
