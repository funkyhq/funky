import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The Funky local client (client/local_python) is the one service Docker Compose
// publishes to the host, on :8000. The Starlette app ships no CORS, so rather than
// hit it cross-origin from the Vite dev server we proxy the API paths to it: the
// browser only ever talks same-origin, and `fetch('/v1/agents')` just works.
//
// Point it elsewhere (a client on another host/port) with VITE_API_TARGET.
const API_TARGET = process.env.VITE_API_TARGET || "http://127.0.0.1:8000";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/v1": { target: API_TARGET, changeOrigin: true },
      "/health": { target: API_TARGET, changeOrigin: true },
    },
  },
});
