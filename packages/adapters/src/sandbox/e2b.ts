// The SandboxProvider port over E2B — every method a thin veneer on the
// SDK call it names. `connect` needs no translation at all: e2b's
// `Sandbox.connect` already has the port's contract — reattach, reviving
// a paused sandbox in place, with the TTL only extended. Two spots do
// translate:
//
// - The SDK's own `lifecycle.onTimeout` default is "kill", the port's is
//   "pause", so create always passes the action explicitly.
// - `commands.run` throws CommandExitError on a non-zero exit; the port
//   wants a result. The catch converts. A command-deadline TimeoutError
//   also settles as a result (see settledResult for the discrimination).
//   Every other throw counts as the sandbox being unreachable: one
//   transparent reconnect (which revives a TTL-paused sandbox) and
//   retry, then the error propagates.
//
// E2B enforces every NetworkPolicy variant (allowOut takes hostnames;
// allowInternetAccess: false is deny-all), so the port's reject-when-
// unenforceable clause never triggers here.

import { CommandExitError, Sandbox as E2bSandbox, TimeoutError } from "e2b";
import type { SandboxInfo as E2bSandboxInfo, SandboxOpts } from "e2b";
import type { NetworkPolicy } from "@funky/core";
import type {
  CommandResult,
  CreateSandboxOptions,
  RunOptions,
  Sandbox,
  SandboxInfo,
  SandboxProvider,
} from "@funky/agent";

export interface E2bProviderOptions {
  /** Defaults to the E2B_API_KEY environment variable. */
  apiKey?: string;
}

export function createE2bProvider(options?: E2bProviderOptions): SandboxProvider {
  const connection = { apiKey: options?.apiKey };

  return {
    async create(opts?: CreateSandboxOptions): Promise<Sandbox> {
      const sandbox = await E2bSandbox.create({
        ...connection,
        timeoutMs: opts?.timeoutMs,
        lifecycle: { onTimeout: opts?.lifecycle ?? "pause" },
        metadata: opts?.metadata,
        ...toNetworkOpts(opts?.network),
      });
      return wrap(sandbox, connection);
    },

    async connect(sandboxId: string): Promise<Sandbox> {
      return wrap(await E2bSandbox.connect(sandboxId, connection), connection);
    },

    async list(filter?: { metadata?: Record<string, string> }): Promise<SandboxInfo[]> {
      const paginator = E2bSandbox.list({
        ...connection,
        query: filter?.metadata ? { metadata: filter.metadata } : undefined,
      });
      const infos: SandboxInfo[] = [];
      while (paginator.hasNext) {
        for (const info of await paginator.nextItems()) infos.push(toInfo(info));
      }
      return infos;
    },
  };
}

function wrap(initial: E2bSandbox, connection: { apiKey?: string }): Sandbox {
  let sandbox = initial;
  const sandboxId = initial.sandboxId;

  return {
    sandboxId,

    async getInfo(): Promise<SandboxInfo> {
      return toInfo(await E2bSandbox.getInfo(sandboxId, connection));
    },

    async run(command: string, opts?: RunOptions): Promise<CommandResult> {
      try {
        return toResult(await exec(sandbox, command, opts));
      } catch (error) {
        const settled = settledResult(error);
        if (settled) return settled;
        sandbox = await E2bSandbox.connect(sandboxId, connection);
        try {
          return toResult(await exec(sandbox, command, opts));
        } catch (retryError) {
          const retried = settledResult(retryError);
          if (retried) return retried;
          throw retryError;
        }
      }
    },

    async readFile(path: string): Promise<Uint8Array> {
      return sandbox.files.read(path, { format: "bytes" });
    },

    async writeFile(path: string, data: string | Uint8Array): Promise<void> {
      // e2b's write takes string | ArrayBuffer | Blob | ReadableStream —
      // no Uint8Array — so bytes are copied into a fresh ArrayBuffer.
      await sandbox.files.write(path, typeof data === "string" ? data : toArrayBuffer(data));
    },

    async pause(): Promise<void> {
      await sandbox.pause();
    },

    async kill(): Promise<void> {
      await sandbox.kill();
    },
  };
}

function exec(sandbox: E2bSandbox, command: string, opts?: RunOptions) {
  return sandbox.commands.run(command, {
    cwd: opts?.cwd,
    timeoutMs: opts?.timeoutMs,
    onStdout: opts?.onStdout,
    onStderr: opts?.onStderr,
  });
}

function settledResult(error: unknown): CommandResult | undefined {
  if (error instanceof CommandExitError) {
    return { stdout: error.stdout, stderr: error.stderr, exitCode: error.exitCode };
  }
  // The SDK raises one TimeoutError class for four causes, told apart
  // only by message: the command exceeding its own `timeoutMs`
  // ("exceeding 'timeoutMs'"), a request exceeding `requestTimeoutMs`,
  // the sandbox hitting its TTL, and the sandbox dying mid-request.
  // Only the first is the command's own outcome (exit 124, the
  // timeout(1) convention — rerunning a command that ran too long would
  // double the damage). The other three mean the sandbox is unreachable
  // and must fall through to the reconnect, which is what revives a
  // TTL-paused sandbox. The live suite's timeout test fails loudly if
  // an SDK rewording ever breaks the match.
  if (error instanceof TimeoutError && error.message.includes("exceeding 'timeoutMs'")) {
    return { stdout: "", stderr: error.message, exitCode: 124 };
  }
  return undefined;
}

function toResult(result: { stdout: string; stderr: string; exitCode: number }): CommandResult {
  return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
}

function toInfo(info: E2bSandboxInfo): SandboxInfo {
  return { sandboxId: info.sandboxId, state: info.state, metadata: info.metadata };
}

function toNetworkOpts(policy?: NetworkPolicy): Partial<SandboxOpts> {
  if (policy === undefined || policy.type === "unrestricted") return {};
  if (policy.type === "none") return { allowInternetAccess: false };
  return { network: { allowOut: policy.domains } };
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}
