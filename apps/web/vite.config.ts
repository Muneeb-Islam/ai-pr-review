import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In dev the SPA proxies health probes to the API; the real API client arrives in Phase 10.
const api = process.env["API_URL"] ?? "http://127.0.0.1:3000";

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { "/healthz": api, "/readyz": api } },
});
