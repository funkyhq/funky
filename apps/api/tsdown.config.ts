import { defineConfig } from "tsdown";

// Workspace packages (@funky/*) are TS-source-only, so they bundle IN;
// npm dependencies are external by tsdown's default and come from the
// runtime image's prod install. Bundling is also what erases the ESM
// extension problem: the repo resolves imports bundler-style, which
// plain tsc output can't run under Node.
export default defineConfig({
  entry: ["src/main.ts"],
  format: "esm",
  platform: "node",
  target: "node22",
  sourcemap: true,
  deps: { alwaysBundle: ["@funky/core", "@funky/agent", "@funky/adapters"] },
});
