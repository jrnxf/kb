// Builds the page that `kb serve` shows into web/dist, which is committed: the plugin has no install step.
// `bun run dev` serves the page with hot reload and sends /api to a `kb serve` on the default port.

import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { sourceHash } from "./source-hash.ts";

/** Marks the build with the hash of its sources. test/page.test.ts fails when they drift apart. */
const stamp = (): Plugin => ({
  name: "kb-source-hash",
  apply: "build",
  generateBundle() {
    this.emitFile({ type: "asset", fileName: ".source-hash", source: `${sourceHash()}\n` });
  },
});

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react(), tailwindcss(), stamp()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  build: { outDir: "dist", emptyOutDir: true },
  server: { proxy: { "/api": { target: "http://127.0.0.1:4810", changeOrigin: true } } },
});
