import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import svgr from 'vite-plugin-svgr'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), svgr()],
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
