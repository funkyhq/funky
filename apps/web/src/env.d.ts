// Injected by Vite `define` (see vite.config.ts): true when ANTHROPIC_API_KEY is set in the
// root .env, so the model picker can offer real Claude models.
declare const __ANTHROPIC_ENABLED__: boolean

// Injected by Vite `define` from FUNKY_API_URL. The auth token remains server-side.
declare const __FUNKY_API_URL__: string
