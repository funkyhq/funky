import { fileURLToPath } from "node:url";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";
import { defineConfig, loadEnv } from "vite";

// The api has no CORS and is bearer-authed, so the browser never calls it
// directly: the dev server proxies same-origin /v1 to it and adds the
// Authorization header itself. The token is read from the MONOREPO ROOT
// .env — the same file `docker compose up` reads, so there is no second
// copy to keep in sync — and stays in this node process; it is never part
// of the client bundle.
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig(({ mode }) => {
  // "" as the prefix: these are the stack's own variables, not VITE_ ones.
  const env = loadEnv(mode, repoRoot, "");
  const token = env.FUNKY_AUTH_TOKEN;

  return {
    plugins: [react(), babel({ presets: [reactCompilerPreset()] })],
    server: {
      proxy: {
        "/v1": {
          target: env.FUNKY_API_URL || "http://localhost:3000",
          changeOrigin: true,
          configure: (proxy) => {
            proxy.on("proxyReq", (proxyReq) => {
              // No token configured is a real state (FUNKY_AUTH=disabled):
              // forward unauthenticated and let the api answer 401 if not.
              if (token) proxyReq.setHeader("authorization", `Bearer ${token}`);
            });
          },
        },
      },
    },
  };
});
