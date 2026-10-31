import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import svgr from "vite-plugin-svgr";
import { visualizer } from "rollup-plugin-visualizer";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), svgr(), visualizer({ open: false })],
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
        // By path, so that react-dom/client and the router stay in the stable vendor chunk
        // instead of the app chunk that changes with every deploy (PF-11). Form, schema and
        // markdown libraries are loaded with the pages that use them.
        manualChunks(id) {
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler|react-router|react-router-dom)[\\/]/.test(id)) return 'react-core';
          if (/[\\/]node_modules[\\/](@tanstack[\\/][^\\/]+|axios)[\\/]/.test(id)) return 'vendor-query';
          if (/[\\/]node_modules[\\/]swiper[\\/]/.test(id)) return 'vendor-swiper';
          if (/[\\/]node_modules[\\/]@vkid[\\/]/.test(id)) return 'vendor-vk';
        },
        // A route over HTTP/1.1 waits for its files six at a time: chunks under 10 kB are
        // merged (PF-03). At 20 kB the task page loads 5 files fewer but every other page
        // takes ~80 kB of code it does not use.
        experimentalMinChunkSize: 10_000,
      }
  }
  },
  server: {
    allowedHosts: true,
  },
});
