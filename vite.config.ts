import { resolve } from "node:path";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/** Connect UI: `src/ui` → `dist/ui`, served by the Miniapp SDK under `/a/connect/` (manifest `ui.launchPath` / `configurePath`). */
export default defineConfig({
  root: resolve(import.meta.dirname, "src/ui"),
  base: "/a/connect/",
  plugins: [react()],
  build: {
    outDir: resolve(import.meta.dirname, "dist/ui"),
    emptyOutDir: true,
    sourcemap: false,
  },
});
