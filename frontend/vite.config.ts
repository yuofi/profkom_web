import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import svgr from "vite-plugin-svgr";
import { visualizer } from "rollup-plugin-visualizer";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), svgr(), visualizer({ open: true })],
  css: {
    transformer: "lightningcss",
    lightningcss: {
      cssModules: {
        pattern: "[name]_[local]_[hash]",
      },
    },
  },
  build: {
    cssMinify: "lightningcss",
    rollupOptions: {
      output: {
        manualChunks: {
          'react-core': ['react', 'react-dom', 'react-router-dom'],
          'vendor-swiper': ['swiper'],
          'vendor-utils': ['@tanstack/react-query', 'axios', 'formik', 'zod', 'formik-validator-zod'],
          'vendor-vk': ['@vkid/sdk']
        }
      }
  }
  },
  server: {
    allowedHosts: true,
  },
});
