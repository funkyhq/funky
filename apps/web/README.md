# Funky Console

A browser console for the Funky API — a developer surface for trying the API out without
curl. React + Vite, no runtime dependencies beyond React.

```bash
pnpm -F web dev      # vite dev server
pnpm -F web build    # tsc -b && vite build
pnpm -F web lint     # oxlint
```

## Layout

| Path              | What it is                                                           |
| ----------------- | -------------------------------------------------------------------- |
| `src/App.tsx`     | The shell: the sidebar beside one routed pane                        |
| `src/nav.ts`      | Every section, in one list — the sidebar and the router both read it |
| `src/lib/`        | What the console knows about the api it fronts                       |
| `src/components/` | The shell's pieces (sidebar, icons, modal)                           |
| `src/pages/`      | One module per section                                               |

Routing is the URL hash (`#/agent`), so sections are linkable and the browser owns history —
`src/lib/useHashRoute.ts` is the whole router. A section renders the page named in its
`nav.ts` entry, or the placeholder if it has none yet; each gets wired to its endpoints in
turn.

## Talking to the api

The api has no CORS and is bearer-authed, so the browser never calls it directly. The dev
server proxies same-origin `/v1` to the api and adds the `Authorization` header itself
(`vite.config.ts`), reading `FUNKY_AUTH_TOKEN` from the **monorepo root `.env`** — the same
file `docker compose up` reads, so there is no second copy to keep in sync, and the token
never enters the client bundle. Point it elsewhere with `FUNKY_API_URL` (default
`http://localhost:3000`).

`docker compose up` serves exactly this on `:5173`, with `vite preview` over a built bundle
in place of the dev server — `preview.proxy` falls back to `server.proxy`, so it is the same
proxy, reading the same variables out of the container's environment. Run `pnpm -F web dev`
against the stack when you want hot reload. With the api down, the proxy answers 502 and the
console says it can't reach it.

## Brand

`public/` carries the favicon kit and `logo.svg`. `index.html` declares the `.ico`, **not**
`logo.svg` — browsers prefer a declared SVG favicon and would scale the mark down to 16px
themselves, averaging it into a smear. The accent tokens are the logo's palette: cobalt
`#1B45E8`, saffron `#FFC531`.

The React Compiler is enabled via `babel-plugin-react-compiler` (see `vite.config.ts`).
