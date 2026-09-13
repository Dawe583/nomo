import { defineConfig } from "vite";
export default defineConfig({
  build: {
    outDir: "../../../dist/web",
    emptyOutDir: false,
    // Keep an open workspace usable after a deploy removes old lazy chunks.
    // No paid deployment-skew service required; one cached JS/CSS pair.
    cssCodeSplit: false,
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
  server: { proxy: { "/api": "http://127.0.0.1:8787" } },
});
