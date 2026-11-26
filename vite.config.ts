import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  root: "src/client",
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@shared": fileURLToPath(new URL("./src/shared", import.meta.url)) } },
  build: { outDir: "../../dist/client", emptyOutDir: true },
  server: {
    port: 5173,
    host: true,
    proxy: {
      "/api": "http://localhost:3000",
      "/mcp": "http://localhost:3000",
      "/photos": "http://localhost:3000",
      "/healthz": "http://localhost:3000",
      "/.well-known": "http://localhost:3000",
    },
  },
});
