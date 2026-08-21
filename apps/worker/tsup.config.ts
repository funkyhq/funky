import { defineConfig } from "tsup";

// Same shape as apps/api: @funky/* bundles in, npm deps stay external.
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
