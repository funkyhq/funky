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
| `src/components/` | The shell's pieces (sidebar, icons)                                  |
| `src/pages/`      | One module per section                                               |

Routing is the URL hash (`#/agent`), so sections are linkable and the browser owns history —
`src/lib/useHashRoute.ts` is the whole router. Sections are placeholders for now; each gets
wired to its endpoints in turn.

## Brand

`public/` carries the favicon kit and `logo.svg`. `index.html` declares the `.ico`, **not**
`logo.svg` — browsers prefer a declared SVG favicon and would scale the mark down to 16px
themselves, averaging it into a smear. The accent tokens are the logo's palette: cobalt
`#1B45E8`, saffron `#FFC531`.

The React Compiler is enabled via `babel-plugin-react-compiler` (see `vite.config.ts`).
