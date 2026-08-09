// Runs the sandbox TCK against the docker driver — the SAME suite subprocess and e2b run,
// so the container path is held to the identical idemKey contract.
//
// The TCK block is skipped unless a Docker daemon is reachable (guarded like the e2b block
// is on its API key), and uses a small, auto-pullable image by default so CI needs no
// prebuilt funky-sandbox image:
//
//   FUNKY_DOCKER_TEST_IMAGE=funky-sandbox:trixie pnpm -F @funky/sandbox test
//
// It needs only GNU coreutils + /bin/sh, which debian:trixie-slim (the base of the real
// sandbox image) provides.

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ComputeSdkDriver } from "./drivers/computesdk";
import { dockerProvider } from "./drivers/docker";
import { runSandboxTck } from "./tck";

const dockerAvailable = spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;
const TEST_IMAGE = process.env.FUNKY_DOCKER_TEST_IMAGE ?? "debian:trixie-slim";

if (dockerAvailable) {
  runSandboxTck(
    "docker",
    () =>
      new ComputeSdkDriver({
        providerName: "docker",
        provider: dockerProvider({ image: TEST_IMAGE }),
      }),
    { timeoutMs: 60_000 }, // provision pulls the image on first run; every poll forks `docker exec`
  );
} else {
  describe("sandbox TCK: docker", () => {
    it.skip("skipped: no reachable Docker daemon (`docker info` failed)", () => {});
  });
}

// Needs no daemon: provision rejects a limited policy before it ever touches Docker.
describe("docker network policies", () => {
  it("fails closed for limited network policies", async () => {
    const driver = new ComputeSdkDriver({
      providerName: "docker",
      provider: dockerProvider({ image: TEST_IMAGE }),
    });
    await expect(
      driver.provision(
        { network: { type: "limited", allowed_hosts: ["api.example.com"] } },
        randomUUID(),
      ),
    ).rejects.toThrow("docker does not support limited network policies");
  });
});
