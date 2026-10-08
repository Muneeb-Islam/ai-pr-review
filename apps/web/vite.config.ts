import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In dev the SPA proxies the API (health probes, sign-in, REST and the SSE stream) so the browser sees one
// origin and the session cookie just works. Set API_URL to point the proxy elsewhere.
const api = process.env["API_URL"] ?? "http://127.0.0.1:3000";
const port = Number(process.env["WEB_PORT"] ?? 5173);

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port,
    proxy: { "/healthz": api, "/readyz": api, "/api": api, "/auth": api },
  },
});
