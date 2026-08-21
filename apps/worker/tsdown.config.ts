import { defineConfig } from "tsdown";

// Same shape as apps/api: @funky/* bundles in, npm deps stay external.
export default defineConfig({
  entry: ["src/main.ts"],
  format: "esm",
  platform: "node",
  target: "node22",
  sourcemap: true,
  deps: { alwaysBundle: ["@funky/core", "@funky/agent", "@funky/adapters"] },
});
