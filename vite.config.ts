import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

// BASE_PATH lets the same build be served from a sub-path, e.g. GitHub Pages at /<repo>/ (see .github/workflows/pages.yml).
const base = process.env.BASE_PATH ?? "/";

export default defineConfig({
  base,
  plugins: [
    VitePWA({
      // "prompt": the app shows a Reload toast when a new build is deployed instead of swapping under the user's feet
      registerType: "prompt",
      includeAssets: ["favicon.svg", "icons.svg", "chc-logo.png"],
      manifest: {
        name: "BIOBUZZ Digital Twin",
        short_name: "BIOBUZZ",
        description: "3D digital twin of the FTC 2026-27 BIOBUZZ field and robot: cameras, launcher analysis, match simulation and a virtual runtime for TeamCode.",
        theme_color: "#0e1116",
        background_color: "#0e1116",
        display: "standalone",
        orientation: "landscape",
        icons: [
          { src: "pwa-192.png", sizes: "192x192", type: "image/png" },
          { src: "pwa-512.png", sizes: "512x512", type: "image/png" },
          { src: "pwa-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        // the goBILDA CAD (two ~600 KB Draco GLBs) and the Draco decoder are precached so the twin works offline
        globPatterns: ["**/*.{js,css,html,svg,png,glb,wasm}"],
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
      },
      devOptions: { enabled: false },
    }),
  ],
});
