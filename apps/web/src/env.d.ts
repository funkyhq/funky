// Injected by Vite `define` (see vite.config.ts): true when the corresponding provider key
// is set in the root .env, so the picker can offer its models without exposing credentials.
declare const __ANTHROPIC_ENABLED__: boolean
declare const __TOGETHER_ENABLED__: boolean

// Injected by Vite `define` from FUNKY_API_URL. The auth token remains server-side.
declare const __FUNKY_API_URL__: string
