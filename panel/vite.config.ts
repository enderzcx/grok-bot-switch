import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";
import { fileURLToPath, URL } from "node:url";

// Everything is inlined into dist/index.html; build.mjs embeds that file into
// dist/grok-switch.cjs, which serves it from the cloud machine's loopback.
export default defineConfig({
  plugins: [react(), viteSingleFile()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  build: { outDir: "dist", emptyOutDir: true, sourcemap: false, cssCodeSplit: false, assetsInlineLimit: 100000000 },
});
