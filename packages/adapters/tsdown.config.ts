import { defineConfig } from "tsdown";

// Only the migrate one-shot compiles — the package itself is consumed
// as TS source and bundled into the apps. The entry keeps its src/
// depth (dist/store/migrate.js) so the file's ../../migrations URL
// resolves to this package's migrations folder from dist exactly as it
// does from src. Its npm imports (drizzle-orm, pg) are external by
// default.
export default defineConfig({
  entry: { "store/migrate": "src/store/migrate.ts" },
  format: "esm",
  platform: "node",
  target: "node22",
  sourcemap: true,
});
