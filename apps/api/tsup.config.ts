import { defineConfig } from "tsup";

// Workspace packages (@funky/*) are TS-source-only, so they bundle IN;
// npm dependencies stay external and are prod-installed in the runtime
// image. Bundling is also what erases the ESM-extension problem: the
// repo resolves imports bundler-style, which plain tsc output can't
// run under Node.
export default defineConfig({
  entry: ["src/main.ts"],
  format: "esm",
  platform: "node",
  target: "node22",
  sourcemap: true,
  clean: true,
  noExternal: [/^@funky\//],
  skipNodeModulesBundle: true,
});
