import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  plugins: [
    react(),
    {
      name: "normalize-generated-blank-lines",
      generateBundle(_options, bundle) {
        for (const output of Object.values(bundle)) {
          if (output.type === "chunk")
            output.code = output.code.replace(/\n[\t ]+(?=\n)/g, "\n");
        }
      },
    },
  ],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  build: {
    outDir: "../grokctl/web",
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      output: {
        entryFileNames: "app.js",
        inlineDynamicImports: true,
        assetFileNames: (asset) =>
          asset.names?.some((name) => name.endsWith(".css"))
            ? "styles.css"
            : "[name][extname]",
      },
    },
  },
});
