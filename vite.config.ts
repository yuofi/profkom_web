import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { ALL } from 'dns'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  css: {
    transformer: 'lightningcss',
    lightningcss: {
      cssModules: {
        pattern: '[name]_[local]_[hash]'
      }
    }
  },
  build: {
    cssMinify: 'lightningcss'
  },
  server: {
    allowedHosts: true
  }
})
