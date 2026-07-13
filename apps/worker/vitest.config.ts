import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // worker.test.ts drives a real Postgres via testcontainers: the first container
    // pull is slow, and the integration tests run turns end-to-end.
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
