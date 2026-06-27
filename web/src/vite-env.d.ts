/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Absolute base URL for the API. Empty ⇒ same-origin (through the dev proxy). */
  readonly VITE_API_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
