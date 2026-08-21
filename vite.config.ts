import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  base: "/theatre-background-tool/",
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["favicon.svg", "pwa-192.png", "pwa-512.png", "stage-overlay.png"],
      manifest: {
        name: "劇場投影背景模擬器",
        short_name: "劇場背景模擬",
        description: "離線預覽、調整與比較多張劇場投影背景。",
        lang: "zh-Hant",
        start_url: "./",
        scope: "./",
        display: "standalone",
        background_color: "#f2efe9",
        theme_color: "#1c1a17",
        icons: [
          { src: "pwa-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "pwa-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{html,js,css,png,svg,webp}"],
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        skipWaiting: true,
        navigateFallback: "index.html",
      },
      devOptions: {
        enabled: true,
        type: "module",
      },
    }),
  ],
  server: {
    host: "127.0.0.1",
  },
});
