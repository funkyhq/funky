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

// Which providers the stack has a key for. Mirrors the `envKey` of each
// entry in src/lib/providers.ts, keyed by the same id — that file owns the
// labels and models, this owns where the key is read from, and neither can
// offer a provider the other doesn't know. Kept as its own table rather than
// imported because tsconfig.node.json's program is just this file.
const PROVIDER_ENV_KEYS: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
};

export default defineConfig(({ mode }) => {
  // "" as the prefix: these are the stack's own variables, not VITE_ ones.
  const env = loadEnv(mode, repoRoot, "");
  const token = env.FUNKY_AUTH_TOKEN;

  // The ids only — a key's VALUE never leaves this process, and a key that
  // is present but empty (as .env.example ships it) is not a key. Read once,
  // here: adding a key to .env takes a dev-server restart to show up.
  const providers = Object.entries(PROVIDER_ENV_KEYS)
    .filter(([, key]) => (env[key] ?? "").trim() !== "")
    .map(([id]) => id);

  return {
    plugins: [react(), babel({ presets: [reactCompilerPreset()] })],
    define: { __FUNKY_PROVIDERS__: JSON.stringify(providers) },
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
