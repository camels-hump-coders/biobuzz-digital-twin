import { defineConfig } from "vite";

// BASE_PATH lets the same build be served from a sub-path, e.g. GitHub Pages at /<repo>/ (see .github/workflows/pages.yml).
export default defineConfig({
  base: process.env.BASE_PATH ?? "/",
});
