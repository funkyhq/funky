import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    // Each scenario drives a REAL Postgres (testcontainers) + the subprocess sandbox and
    // crashes workers at precise points. The soak (H7) runs 50 sessions across 3 workers.
    // Give the slow paths room; the whole suite must still land under ~5 minutes in CI.
    testTimeout: 60_000,
    hookTimeout: 180_000,
    // One Postgres container per file (see harness.startPg). Files may run in parallel
    // across worker processes; within a file, tests share the container and are serial.
    fileParallelism: true,
  },
});
