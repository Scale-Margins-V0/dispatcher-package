import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: "admin",
  base: "/admin/",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./admin/src", import.meta.url)),
    },
  },
  build: {
    outDir: "../admin-dist",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      "/admin/api": "http://localhost:3100",
      // The Configuration page tests a key against the real external router.
      // That router serves no CORS headers by design, so the check has to be
      // same-origin — proxy it like the admin API.
      "/api/v1": "http://localhost:3100",
    },
  },
});
