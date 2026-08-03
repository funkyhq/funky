// packages/ports/sandbox/src/drivers/docker.ts — local containers via the Docker daemon.
//
// A "real" local sandbox: every session gets its OWN container (`docker run -d` from a
// curated base image), and commands run inside it via `docker exec` — real filesystem,
// process, and (host-)network isolation, unlike the subprocess driver that shares the
// worker's own container.
//
// This is deliberately NOT a from-scratch SandboxDriver. The whole idemKey shell protocol
// — the mkdir first-run lock, the detached runner that stamps `exit` from inside the
// sandbox, the poll envelope, base64 file i/o, the in-sandbox `timeout(1)` — already lives
// in ComputeSdkDriver, which is provider-generic. So the Docker driver is just a ComputeSDK
// *provider* whose runCommand shells out to `docker exec`. Plug it into ComputeSdkDriver and
// the container path inherits the identical, TCK-verified semantics as E2B, for free.
//
// Durability: because the container runs on the host daemon (a sibling of the worker, via a
// mounted docker socket) it OUTLIVES the worker process — any worker holding the handle
// re-execs by container id and re-attaches to the same `exit` files. This is real re-attach,
// but only WITHIN a single Docker host: a container is unreachable from another host's
// daemon. Cross-host worker fleets need host affinity or the remote (E2B) driver.
//
// Error mapping mirrors the E2B provider exactly, because ComputeSdkDriver depends on it:
// runCommand NEVER throws — a dead container / unreachable daemon comes back as exitCode 127
// with the message in stderr (the port's "no exit code ⇒ unavailable" rule), while a
// non-zero exit from a command that actually RAN is passed through untouched.

import { execFile } from "node:child_process";
import type { CommandResult, CreateSandboxOptions, SandboxInterface } from "computesdk";
import type { ComputeProvider } from "./computesdk";

export type DockerProviderOptions = {
  /** Base image every session container is started from (e.g. "funky-sandbox:trixie"). */
  image: string;
  /** Docker binary; override for a custom path or a `podman` shim. Defaults to "docker". */
  docker?: string;
};

// docker exec / start / run write these to stderr when the daemon is unreachable or the
// container is gone — i.e. the result is UNOBSERVABLE. Distinguishes a transport failure
// (→ exit 127, ComputeSdkDriver throws SandboxUnavailableError) from a command that ran and
// exited non-zero (passed through). Our wrapper scripts never emit these strings themselves.
const DAEMON_ERROR =
  /Error response from daemon|No such container|is not running|Cannot connect to the Docker daemon|dial unix|Is the docker daemon running/i;

/** A ComputeSDK provider whose "sandboxes" are containers on the local Docker daemon.
 *  Pass to ComputeSdkDriver: `new ComputeSdkDriver({ providerName: "docker", provider })`. */
export function dockerProvider(opts: DockerProviderOptions): ComputeProvider {
  const docker = opts.docker ?? "docker";
  const image = opts.image;

  function makeSandbox(id: string): SandboxInterface {
    // The only method ComputeSdkDriver calls. `docker exec … sh -c <script>` runs the
    // protocol scripts inside the container; a daemon/container failure becomes exit 127.
    const runCommand = async (command: string): Promise<CommandResult> => {
      const t0 = Date.now();
      const r = await run(docker, ["exec", id, "sh", "-c", command]);
      if (r.code !== 0 && DAEMON_ERROR.test(r.stderr)) {
        return { stdout: "", stderr: r.stderr.trim(), exitCode: 127, durationMs: Date.now() - t0 };
      }
      return { stdout: r.stdout, stderr: r.stderr, exitCode: r.code, durationMs: Date.now() - t0 };
    };
    const unused = (what: string) => async (): Promise<never> => {
      throw new Error(`${what} is not used by the Docker driver`);
    };
    return {
      sandboxId: id,
      provider: "docker",
      runCommand,
      getInfo: async () => ({ id, provider: "docker", status: "running" as const, createdAt: new Date(), timeout: 0 }),
      getUrl: unused("getUrl"),
      destroy: async () => {
        await run(docker, ["rm", "-f", id]);
      },
      // The driver does file i/o through runCommand + base64 (binary-safe), never this API.
      filesystem: {
        readFile: unused("filesystem.readFile"),
        writeFile: unused("filesystem.writeFile"),
        readdir: unused("filesystem.readdir"),
        mkdir: unused("filesystem.mkdir"),
        exists: unused("filesystem.exists"),
        remove: unused("filesystem.remove"),
      },
    };
  }

  return {
    name: "docker",
    sandbox: {
      // `sleep infinity` (overriding the image CMD) keeps the container alive so later
      // `docker exec`s have something to attach to. --init reaps the detached nohup runners
      // the protocol spawns. lifecycle/timeout options don't map to Docker — a container
      // just runs until teardown — so they're ignored; the label aids `docker ps` triage.
      create: async (options?: CreateSandboxOptions): Promise<SandboxInterface> => {
        const session = options?.metadata?.funky_session_id;
        const args = ["run", "-d", "--init"];
        if (session) args.push("--label", `funky.session=${session}`);
        args.push(image, "sleep", "infinity");
        const r = await run(docker, args);
        const id = r.stdout.trim();
        if (r.code !== 0 || !id) {
          throw new Error(`docker run failed: ${(r.stderr || r.stdout).trim() || `exit ${r.code}`}`);
        }
        return makeSandbox(id);
      },
      // `docker start` is idempotent on a running container AND resumes a stopped one with
      // its filesystem intact — so a container that was paused (or survived a daemon
      // restart) "auto-resumes" here. The driver's provider contract: null ONLY on positive
      // evidence the container no longer exists ("No such container" — the daemon answered),
      // and a THROW for everything else (daemon unreachable, docker binary absent), which
      // ComputeSdkDriver reads as unreachable-but-retryable.
      getById: async (id: string): Promise<SandboxInterface | null> => {
        const r = await run(docker, ["start", id]);
        if (r.code === 0) return makeSandbox(id);
        if (/No such container/i.test(r.stderr)) return null;
        throw new Error(`docker start ${id} failed: ${r.stderr.trim() || `exit ${r.code}`}`);
      },
      // rm -f removes a running or stopped container; run() never rejects and rm -f on a
      // missing container is a no-op error we swallow, so teardown stays idempotent.
      destroy: async (id: string): Promise<void> => {
        await run(docker, ["rm", "-f", id]);
      },
    },
  };
}

// Run a docker subcommand, always resolving with the captured streams + exit code — never
// rejecting. A spawn failure (docker binary absent) surfaces as code 127, so it flows
// through the same "unobservable ⇒ 127" path as a dead daemon. maxBuffer is generous: a
// single poll can carry up to ~200KB of base64-wrapped output.
function run(bin: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    execFile(bin, args, { maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      // On a non-zero exit, err.code is the numeric exit code. On a spawn failure (docker
      // binary absent) it's a string errno like "ENOENT" → map to 127 (unobservable).
      const code = err ? (typeof err.code === "number" ? err.code : 127) : 0;
      resolve({ stdout: stdout ?? "", stderr: (stderr || (err ? String(err) : "")) ?? "", code });
    });
  });
}
