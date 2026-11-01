import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
  },
  {
    // crypto.randomUUID is missing on plain HTTP (not a secure context) and took the whole
    // app down there (GL-04): ids come from createClientId(), which falls back safely.
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/utils/clientId.ts', 'src/test/**', 'src/**/*.test.{ts,tsx}'],
    rules: {
      'no-restricted-properties': ['error', {
        property: 'randomUUID',
        message: 'Use createClientId() from src/utils/clientId: randomUUID is absent on plain HTTP.',
      }],
    },
  },
])
