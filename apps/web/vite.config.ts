import { fileURLToPath } from 'node:url'
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// The console is a browser app; the Funky API is bearer-authenticated and has no CORS
// headers (by design — we don't touch the API for the UI's sake). So instead of calling
// the API cross-origin from the browser, the dev server proxies same-origin `/v1/*` and
// `/healthz` to the API and injects the Authorization header here. The token stays in the
// Node process and never ships in the browser bundle.
//
// Config is read from the *monorepo root* `.env` (the same file `docker compose` uses), so
// `pnpm dev` works with zero extra setup once you've done the Quickstart:
//   FUNKY_API_URL     where the API listens (default http://localhost:3000)
//   FUNKY_AUTH_TOKEN  the bearer token (leave unset if the API runs FUNKY_AUTH=disabled)
// The `web` compose service runs this SAME dev server in a container; there the root .env is
// not present, so we also read straight from `process.env` (compose injects the vars, and
// points FUNKY_API_URL at the `api` service instead of localhost).
const repoRoot = fileURLToPath(new URL('../../', import.meta.url))

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // '' prefix → load every var (not just VITE_*); this is the Node side, not client code.
  const env = loadEnv(mode, repoRoot, '')
  const target = env.FUNKY_API_URL || process.env.FUNKY_API_URL || 'http://localhost:3000'
  const token = env.FUNKY_AUTH_TOKEN || process.env.FUNKY_AUTH_TOKEN
  // Real Claude models are only offered when the worker has a key. We expose a *boolean*
  // (never the key itself) so the model picker can gate on it. Reflects the root .env at
  // dev-server start — restart `pnpm dev` after changing it.
  const anthropicEnabled = Boolean((env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY || '').trim())

  const proxyHeaders = token ? { Authorization: `Bearer ${token}` } : undefined
  const proxy = {
    target,
    changeOrigin: true,
    // SSE: don't let the proxy buffer the event stream.
    headers: proxyHeaders,
  }

  return {
    plugins: [react()],
    define: {
      __ANTHROPIC_ENABLED__: JSON.stringify(anthropicEnabled),
    },
    server: {
      // Bind all interfaces + allow any Host so the container's mapped port works; harmless
      // for local `pnpm dev`, which is still reached over localhost.
      host: true,
      allowedHosts: true,
      proxy: {
        '/v1': proxy,
        '/healthz': proxy,
      },
    },
  }
})
