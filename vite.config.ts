import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    outDir: "dist/client",
    emptyOutDir: true,
    rolldownOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (id.includes("@tanstack")) return "query-vendor";
          if (id.includes("@radix-ui")) return "radix-vendor";
          if (id.includes("/motion/") || id.includes("\\motion\\")) return "motion-vendor";
          if (
            id.includes("/react/")
            || id.includes("\\react\\")
            || id.includes("/react-dom/")
            || id.includes("\\react-dom\\")
            || id.includes("/react-router")
            || id.includes("\\react-router")
          ) return "react-vendor";
          return "vendor";
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: { "/api": "http://localhost:3000" },
  },
});
